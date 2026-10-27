import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { EFFORT_LEVELS, type AgentConfig, type Effort, type Provider } from "./types.ts";

// Model lists come from the agent runtimes themselves, without starting a
// conversation or spending tokens: Codex's app-server `model/list` (specific
// to your account and plan) and the model table in Claude Code's `initialize`
// handshake. They let crosscheck reject a mistyped model before a run starts.

export interface ModelInfo {
  /** The id crosscheck passes to the runtime. */
  id: string;
  /** Other names the runtime accepts for the same model (Claude Code aliases). */
  aliases: string[];
  description?: string;
  /** Supported effort levels; empty when the model has no effort setting. */
  efforts: Effort[];
  defaultEffort?: Effort;
  /** The model the runtime uses when none is given. */
  isDefault: boolean;
  /** Accepted by the runtime but not offered in its model picker. */
  hidden: boolean;
}

export interface ModelCatalog {
  provider: Provider;
  models: ModelInfo[];
}

const TIMEOUT_MS = 20_000;
const BINARIES: Record<Provider, string> = { "claude-code": "claude", codex: "codex" };

const efforts = (values: unknown[]): Effort[] =>
  EFFORT_LEVELS.filter((level) => values.includes(level));

/** The runtime crosscheck runs (installed on first use), else the one on PATH. */
export function runtimeBinary(provider: Provider): string | undefined {
  const name = BINARIES[provider];
  const pinned = path.join(
    os.homedir(),
    ".ai-sdk-harness",
    ".harness-bootstrap",
    provider,
    "node_modules",
    ".bin",
    name,
  );
  return existsSync(pinned) ? pinned : (Bun.which(name) ?? undefined);
}

export function parseClaudeModels(response: unknown): ModelInfo[] {
  type Entry = {
    value?: unknown;
    resolvedModel?: unknown;
    description?: unknown;
    supportedEffortLevels?: unknown;
  };
  const entries = ((response as { models?: unknown })?.models ?? []) as Entry[];
  if (!Array.isArray(entries) || entries.length === 0)
    throw new Error("Claude Code returned no model list");
  const byId = new Map<string, ModelInfo>();
  let defaultId: string | undefined;
  for (const e of entries) {
    if (typeof e.value !== "string") continue;
    const id = typeof e.resolvedModel === "string" ? e.resolvedModel : e.value;
    if (e.value === "default") {
      defaultId = id;
      continue;
    }
    const existing = byId.get(id);
    if (existing) {
      if (!existing.aliases.includes(e.value)) existing.aliases.push(e.value);
      continue;
    }
    byId.set(id, {
      id,
      aliases: e.value === id ? [] : [e.value],
      ...(typeof e.description === "string" ? { description: e.description } : {}),
      efforts: Array.isArray(e.supportedEffortLevels) ? efforts(e.supportedEffortLevels) : [],
      isDefault: false,
      hidden: false,
    });
  }
  const fallback = defaultId && byId.get(defaultId);
  if (fallback) fallback.isDefault = true;
  return [...byId.values()];
}

export function parseCodexModels(data: unknown[]): ModelInfo[] {
  type Entry = {
    id?: unknown;
    model?: unknown;
    description?: unknown;
    hidden?: unknown;
    isDefault?: unknown;
    defaultReasoningEffort?: unknown;
    supportedReasoningEfforts?: { reasoningEffort?: unknown }[];
  };
  return (data as Entry[]).flatMap((e) => {
    const id = typeof e.model === "string" ? e.model : e.id;
    if (typeof id !== "string") return [];
    const supported = Array.isArray(e.supportedReasoningEfforts)
      ? efforts(e.supportedReasoningEfforts.map((r) => r.reasoningEffort))
      : [];
    return [
      {
        id,
        aliases: typeof e.id === "string" && e.id !== id ? [e.id] : [],
        ...(typeof e.description === "string" ? { description: e.description } : {}),
        efforts: supported,
        ...(supported.includes(e.defaultReasoningEffort as Effort)
          ? { defaultEffort: e.defaultReasoningEffort as Effort }
          : {}),
        isDefault: e.isDefault === true,
        hidden: e.hidden === true,
      },
    ];
  });
}

async function* lines(stream: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of stream) {
    buffer += decoder.decode(chunk, { stream: true });
    for (let i = buffer.indexOf("\n"); i >= 0; i = buffer.indexOf("\n")) {
      const line = buffer.slice(0, i).trim();
      buffer = buffer.slice(i + 1);
      if (line) yield line;
    }
  }
}

type Message = Record<string, unknown>;

/** Exchanges JSON lines with a short-lived runtime process, then kills its process group. */
async function converse<T>(
  command: string[],
  options: { cwd: string; env: Record<string, string | undefined>; timeoutMs: number },
  run: (
    send: (message: unknown) => void,
    receive: (match: (message: Message) => boolean) => Promise<Message>,
  ) => Promise<T>,
): Promise<T> {
  const proc = Bun.spawn(command, {
    cwd: options.cwd,
    env: options.env,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    detached: true,
  });
  const stderr = new Response(proc.stderr).text().catch(() => "");
  const incoming = lines(proc.stdout);
  const receive = async (match: (message: Message) => boolean) => {
    for (;;) {
      const next = await incoming.next();
      if (next.done) {
        const code = await proc.exited;
        const last = (await stderr).trim().split("\n").at(-1)?.slice(0, 300);
        throw new Error(`exited with code ${code} before answering${last ? `: ${last}` : ""}`);
      }
      let message: unknown;
      try {
        message = JSON.parse(next.value);
      } catch {
        continue;
      }
      if (message && typeof message === "object" && match(message as Message))
        return message as Message;
    }
  };
  const send = (message: unknown) => {
    proc.stdin.write(`${JSON.stringify(message)}\n`);
    proc.stdin.flush();
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      run(send, receive),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`no answer within ${options.timeoutMs / 1000}s`)),
          options.timeoutMs,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
    try {
      process.kill(-proc.pid, "SIGKILL");
    } catch {}
    await incoming.return(undefined).catch(() => {});
  }
}

async function claudeModels(binary: string, timeoutMs: number): Promise<ModelInfo[]> {
  // An empty config directory: no user settings, plugins or MCP servers load.
  // The model table does not depend on the login.
  const dir = await mkdtemp(path.join(os.tmpdir(), "crosscheck-models-"));
  try {
    const response = await converse(
      [
        binary,
        "-p",
        "--input-format",
        "stream-json",
        "--output-format",
        "stream-json",
        "--verbose",
      ],
      { cwd: dir, env: { ...process.env, CLAUDE_CONFIG_DIR: dir }, timeoutMs },
      async (send, receive) => {
        send({ type: "control_request", request_id: "models", request: { subtype: "initialize" } });
        const message = await receive(
          (m) =>
            m.type === "control_response" &&
            (m.response as Message | undefined)?.request_id === "models",
        );
        const response = message.response as Message;
        if (response.subtype !== "success")
          throw new Error(String(response.error ?? "initialize failed"));
        return response.response;
      },
    );
    return parseClaudeModels(response);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function codexModels(binary: string, timeoutMs: number): Promise<ModelInfo[]> {
  // Runs with your own CODEX_HOME so the list reflects your login and plan,
  // exactly as `codex` would see it. No thread is started.
  return converse(
    [binary, "app-server"],
    { cwd: os.tmpdir(), env: process.env, timeoutMs },
    async (send, receive) => {
      let id = 0;
      const call = async (method: string, params: unknown) => {
        const requestId = ++id;
        send({ jsonrpc: "2.0", id: requestId, method, params });
        const reply = await receive((m) => m.id === requestId);
        if (reply.error)
          throw new Error(String((reply.error as Message).message ?? JSON.stringify(reply.error)));
        return reply.result as Message;
      };
      await call("initialize", { clientInfo: { name: "crosscheck", version: "0" } });
      send({ jsonrpc: "2.0", method: "initialized" });
      const data: unknown[] = [];
      let cursor: unknown;
      do {
        const page = await call("model/list", {
          includeHidden: true,
          ...(cursor ? { cursor } : {}),
        });
        data.push(...((page.data as unknown[]) ?? []));
        cursor = page.nextCursor;
      } while (cursor);
      const models = parseCodexModels(data);
      if (models.length === 0) throw new Error("Codex returned no models");
      return models;
    },
  );
}

/**
 * The Codex account the runtime is logged in to, and whether its plan allows
 * usage now. Reading the usage limits goes to the server, so a rejected login
 * throws. Starts no thread and spends no tokens.
 */
export async function codexAccount(
  binary: string,
  options: { env: Record<string, string | undefined>; timeoutMs: number },
): Promise<{
  account: { type: string; planType?: string } | null;
  usageAllowed?: boolean;
  resetsAt?: number;
}> {
  return converse(
    [binary, "app-server"],
    { cwd: os.tmpdir(), env: options.env, timeoutMs: options.timeoutMs },
    async (send, receive) => {
      let id = 0;
      const call = async (method: string, params: unknown) => {
        const requestId = ++id;
        send({ jsonrpc: "2.0", id: requestId, method, params });
        const reply = await receive((m) => m.id === requestId);
        if (reply.error)
          throw new Error(String((reply.error as Message).message ?? JSON.stringify(reply.error)));
        return reply.result as Message;
      };
      await call("initialize", { clientInfo: { name: "crosscheck", version: "0" } });
      send({ jsonrpc: "2.0", method: "initialized" });
      const read = (await call("account/read", { refreshToken: false })).account as Message | null;
      if (!read) return { account: null };
      const account = {
        type: String(read.type),
        ...(typeof read.planType === "string" ? { planType: read.planType } : {}),
      };
      // Usage limits exist only for ChatGPT plans.
      if (account.type !== "chatgpt") return { account };
      const limits = await call("account/rateLimits/read", {});
      const resetsAt = ((limits.rateLimits as Message | undefined)?.primary as Message | undefined)
        ?.resetsAt;
      return {
        account,
        ...(typeof limits.ordinaryUsageAllowed === "boolean"
          ? { usageAllowed: limits.ordinaryUsageAllowed }
          : {}),
        ...(typeof resetsAt === "number" ? { resetsAt: resetsAt * 1000 } : {}),
      };
    },
  );
}

/** Asks the runtime for its models. Throws when the runtime is missing or does not answer. */
export async function listModels(
  provider: Provider,
  options: { binary?: string; timeoutMs?: number } = {},
): Promise<ModelCatalog> {
  const binary = options.binary ?? runtimeBinary(provider);
  if (!binary) throw new Error(`the ${provider} runtime is not installed yet`);
  const timeoutMs = options.timeoutMs ?? TIMEOUT_MS;
  const models =
    provider === "codex"
      ? await codexModels(binary, timeoutMs)
      : await claudeModels(binary, timeoutMs);
  return { provider, models };
}

const catalogs = new Map<Provider, Promise<ModelCatalog>>();

/** listModels, at most once per provider per process. */
export function loadCatalog(provider: Provider): Promise<ModelCatalog> {
  let catalog = catalogs.get(provider);
  if (!catalog) {
    catalog = listModels(provider);
    catalogs.set(provider, catalog);
  }
  return catalog;
}

export function findModel(catalog: ModelCatalog, id: string): ModelInfo | undefined {
  return catalog.models.find((m) => m.id === id || m.aliases.includes(id));
}

export function defaultModel(catalog: ModelCatalog): ModelInfo | undefined {
  return catalog.models.find((m) => m.isDefault) ?? catalog.models.find((m) => !m.hidden);
}

/** "Claude-Opus-5.5", "opus 5.5" and "claude-opus-5-5" all squash to "opus55". */
function squash(name: string): string {
  return name
    .toLowerCase()
    .replace(/^claude[-_.\s]*/, "")
    .replace(/[^a-z0-9]/g, "");
}

function distance(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++)
      current[j] = Math.min(
        previous[j]! + 1,
        current[j - 1]! + 1,
        previous[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    previous = current;
  }
  return previous[b.length]!;
}

/** Likely intended models for a name the runtime does not know, best first. */
export function suggestModels(catalog: ModelCatalog, id: string, limit = 3): ModelInfo[] {
  const wanted = squash(id);
  if (!wanted) return [];
  const scored = catalog.models.flatMap((m) => {
    const names = [m.id, ...m.aliases].map(squash);
    if (names.includes(wanted)) return [{ m, score: 0 }];
    const closest = Math.min(...names.map((n) => distance(wanted, n)));
    const threshold = Math.max(2, Math.floor(wanted.length / 3));
    if (closest <= threshold) return [{ m, score: closest }];
    if (names.some((n) => n.length >= 3 && (n.includes(wanted) || wanted.includes(n))))
      return [{ m, score: threshold + 1 }];
    return [];
  });
  return scored
    .sort((a, b) => a.score - b.score || Number(a.m.hidden) - Number(b.m.hidden))
    .slice(0, limit)
    .map((s) => s.m);
}

/** Same model name, differently spelled: "opus-5.5" or "claude-sonet-5-5", not "claude-opus-4-6". */
function isTypo(name: string, model: ModelInfo): boolean {
  const wanted = squash(name);
  const letters = (s: string) => s.replace(/[0-9]/g, "");
  return [model.id, ...model.aliases].map(squash).some((n) => {
    if (n === wanted) return true;
    return letters(n) !== letters(wanted) && distance(n, wanted) <= 2;
  });
}

export type AgentProblem =
  | { kind: "model"; message: string; suggestions: ModelInfo[] }
  | { kind: "effort"; message: string; model: ModelInfo };

export interface AgentCheck {
  /** The catalog entry the agent will run, when known. */
  model?: ModelInfo;
  problem?: AgentProblem;
  /** Accepted, but only the runtime can confirm it. */
  warning?: string;
}

/** Checks an agent's model and effort against its runtime's catalog. */
export function checkAgent(agent: AgentConfig, catalog: ModelCatalog): AgentCheck {
  let model: ModelInfo | undefined;
  if (agent.model === undefined) {
    model = defaultModel(catalog);
  } else {
    model = findModel(catalog, agent.model);
    if (!model) {
      const suggestions = suggestModels(catalog, agent.model);
      // Claude Code accepts any full model id, including older ones it no
      // longer lists. Only a well-formed id that differs from a listed one by
      // more than spelling (a version, say) passes, and only with a warning.
      if (
        agent.provider === "claude-code" &&
        /^claude-[a-z]+(-[a-z0-9]+)+$/.test(agent.model) &&
        !suggestions.some((s) => isTypo(agent.model!, s))
      ) {
        return {
          warning: `${agent.model} is not in Claude Code's model list; the runtime will confirm it when the agent starts`,
        };
      }
      const hint = suggestions.length
        ? ` Did you mean ${suggestions.map((s) => s.id).join(" or ")}?`
        : "";
      return {
        problem: {
          kind: "model",
          message: `unknown ${agent.provider} model "${agent.model}".${hint}`,
          suggestions,
        },
      };
    }
  }
  if (agent.effort && model && !model.efforts.includes(agent.effort)) {
    return {
      model,
      problem: {
        kind: "effort",
        message: model.efforts.length
          ? `${model.id} does not support effort "${agent.effort}" (supported: ${model.efforts.join(", ")})`
          : `${model.id} has no effort setting`,
        model,
      },
    };
  }
  return model ? { model } : {};
}

/** One line per model for listings and error messages. */
export function describeModels(
  catalog: ModelCatalog,
  options: { hidden?: boolean } = {},
): string[] {
  return catalog.models
    .filter((m) => options.hidden || !m.hidden)
    .map((m) => {
      const names = m.aliases.length ? ` (${m.aliases.join(", ")})` : "";
      const effort = m.efforts.length ? ` · effort ${m.efforts.join("/")}` : "";
      return `${m.id}${names}${m.isDefault ? " [default]" : ""}${effort}${m.description ? ` · ${m.description}` : ""}`;
    });
}
