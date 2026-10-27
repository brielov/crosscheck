import * as p from "@clack/prompts";
import { existsSync, statSync } from "node:fs";
import { stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import pkg from "../package.json";
import { defaultCodexConfig } from "./agents/harness-backend.ts";
import {
  checkAgent,
  defaultModel,
  findModel,
  loadCatalog,
  type ModelCatalog,
  type ModelInfo,
} from "./models.ts";
import {
  DEFAULT_FOCUS,
  DEFAULTS,
  parseAgent,
  readText,
  toCommandLine,
  UsageError,
  type Preset,
} from "./options.ts";
import { bold, dim } from "./progress.ts";
import {
  EFFORT_LEVELS,
  FOCUS_AREAS,
  type AgentConfig,
  type Effort,
  type InputSpec,
  type Provider,
  type Role,
  type RunConfig,
} from "./types.ts";

const PROVIDERS: Provider[] = ["claude-code", "codex"];
const NAMES: Record<Provider, string> = { "claude-code": "Claude Code", codex: "Codex" };
const CODEX_CONFIG = "~/.codex/config.toml";
const OTHER = "\0other";

export function cancelled<T>(value: T): Exclude<T, symbol> {
  if (p.isCancel(value)) {
    p.cancel("Cancelled.");
    process.exit(130);
  }
  return value as Exclude<T, symbol>;
}

const catalogOrError = (provider: Provider, load = loadCatalog) =>
  load(provider).catch((e: unknown) => (e instanceof Error ? e : new Error(String(e))));

const modelOption = (m: ModelInfo, hint?: string) => ({
  value: m.id,
  label: m.aliases.length ? `${m.id} (${m.aliases.join(", ")})` : m.id,
  hint: hint ?? m.description ?? "",
});

/**
 * Applies the Codex defaults, then checks both agents' models and efforts
 * against the runtimes' catalogs. Interactive: offers the valid choices.
 * Otherwise a problem is a UsageError naming the alternatives.
 */
export async function resolveAgents(
  config: RunConfig,
  options: {
    interactive: boolean;
    warn: (message: string) => void;
    loadCatalog?: (provider: Provider) => Promise<ModelCatalog>;
  },
): Promise<RunConfig> {
  const codexDefaults = await defaultCodexConfig();
  const resolved = { ...config };
  for (const role of ["author", "reviewer"] as const) {
    const flag = `--${role}`;
    let agent: AgentConfig = { ...config[role] };
    const fromConfig = {
      model: agent.provider === "codex" && !agent.model && !!codexDefaults.model,
      effort: agent.provider === "codex" && !agent.effort && !!codexDefaults.effort,
    };
    // The Codex adapter's built-in default model is not available on every
    // plan: use the user's own Codex default, else the account's default.
    if (agent.provider === "codex") agent = { ...codexDefaults, ...agent };
    const catalog = await catalogOrError(agent.provider, options.loadCatalog);
    if (catalog instanceof Error) {
      options.warn(
        `${flag}: could not list ${agent.provider} models (${catalog.message}); ${agent.model ?? "the default model"} will be checked when the agent starts`,
      );
      resolved[role] = agent;
      continue;
    }
    if (agent.provider === "codex" && !agent.model) {
      const fallback = defaultModel(catalog);
      if (fallback) agent.model = fallback.id;
    }
    for (;;) {
      const check = checkAgent(agent, catalog);
      if (check.warning) options.warn(`${flag}: ${check.warning}`);
      const problem = check.problem;
      if (!problem) break;
      const origin =
        (problem.kind === "model" && fromConfig.model) ||
        (problem.kind === "effort" && fromConfig.effort)
          ? ` (from ${CODEX_CONFIG})`
          : "";
      const message = `${flag}${origin}: ${problem.message}`;
      if (!options.interactive) {
        const known = catalog.models
          .filter((m) => !m.hidden)
          .map((m) => (m.aliases.length ? `${m.id} (${m.aliases.join(", ")})` : m.id));
        throw new UsageError(
          problem.kind === "model"
            ? `${message}\n  Available ${agent.provider} models: ${known.join(", ")}\n  Run \`crosscheck models\` for details.`
            : message,
        );
      }
      if (problem.kind === "model") {
        const suggested = new Set(problem.suggestions.map((m) => m.id));
        agent.model = cancelled(
          await p.select({
            message: `${message} Choose a model:`,
            options: [
              ...problem.suggestions.map((m) => modelOption(m, "closest match")),
              ...catalog.models
                .filter((m) => !m.hidden && !suggested.has(m.id))
                .map((m) => modelOption(m)),
            ],
            maxItems: 10,
          }),
        );
        fromConfig.model = false;
      } else {
        const effort = cancelled(
          await p.select<Effort | "">({
            message: `${message}. Choose an effort level:`,
            options: [
              { value: "", label: "model default", hint: problem.model.defaultEffort ?? "" },
              ...problem.model.efforts.map((e) => ({ value: e, label: e })),
            ],
          }),
        );
        if (effort) agent.effort = effort;
        else delete agent.effort;
        fromConfig.effort = false;
      }
    }
    resolved[role] = agent;
  }
  return resolved;
}

const IGNORED_DOCS = new Set([
  "README",
  "CHANGELOG",
  "LICENSE",
  "CONTRIBUTING",
  "SECURITY",
  "CODE_OF_CONDUCT",
  "CLAUDE",
  "AGENTS",
  "GEMINI",
  "COPYING",
]);

/** Markdown files that could be plans, most recently modified first. */
export async function findPlans(dir: string, limit = 8): Promise<string[]> {
  const found = new Map<string, number>();
  const dirs = "{docs,plans,plan,specs,notes,design}";
  for (const pattern of ["*.md", `${dirs}/*.md`, `${dirs}/*/*.md`]) {
    for await (const file of new Bun.Glob(pattern).scan({ cwd: dir, onlyFiles: true })) {
      if (IGNORED_DOCS.has(path.basename(file, path.extname(file)).toUpperCase())) continue;
      const info = await stat(path.join(dir, file)).catch(() => null);
      if (info?.isFile() && info.size > 0) found.set(file, info.mtimeMs);
    }
  }
  return [...found.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([file]) => file);
}

/** Verification commands this repository probably uses. */
export async function detectChecks(repo: string): Promise<string[]> {
  const has = (file: string) => existsSync(path.join(repo, file));
  const checks: string[] = [];
  const manifest = (await Bun.file(path.join(repo, "package.json"))
    .json()
    .catch(() => null)) as { scripts?: Record<string, unknown> } | null;
  if (manifest?.scripts) {
    const pm =
      has("bun.lock") || has("bun.lockb")
        ? "bun"
        : has("pnpm-lock.yaml")
          ? "pnpm"
          : has("yarn.lock")
            ? "yarn"
            : "npm";
    for (const name of ["test", "check", "typecheck", "lint"]) {
      if (typeof manifest.scripts[name] !== "string") continue;
      checks.push(name === "test" && pm !== "bun" ? `${pm} test` : `${pm} run ${name}`);
    }
  }
  if (has("Makefile") && /^test:/m.test(await Bun.file(path.join(repo, "Makefile")).text()))
    checks.push("make test");
  if (has("Cargo.toml")) checks.push("cargo test");
  if (has("go.mod")) checks.push("go test ./...");
  return checks;
}

/** A path as the user would type it: relative below the current directory, else ~-abbreviated. */
const display = (p: string) => {
  const rel = path.relative(process.cwd(), p);
  if (!rel) return ".";
  if (!rel.startsWith("..") && !path.isAbsolute(rel)) return rel;
  const h = os.homedir();
  return p === h || p.startsWith(`${h}/`) ? `~${p.slice(h.length)}` : p;
};

async function askInput(): Promise<InputSpec> {
  const kind = cancelled(
    await p.select({
      message: "What should be reviewed?",
      options: [
        { value: "plan", label: "An existing Markdown plan", hint: "never modified" },
        { value: "brief", label: "A feature brief", hint: "the author drafts the plan first" },
      ],
    }),
  );
  if (kind === "brief") {
    const brief = cancelled(
      await p.multiline({
        message: "Describe the feature or project (Enter twice to finish)",
        placeholder: "Add organization-level API keys and usage limits",
        validate: (v) => (!v?.trim() ? "A brief is required" : undefined),
      }),
    );
    return { kind: "brief", brief: brief.trim() };
  }
  const candidates = await findPlans(process.cwd());
  let file: string = OTHER;
  if (candidates.length) {
    file = cancelled(
      await p.select({
        message: "Plan file",
        options: [
          ...candidates.map((c) => ({ value: c, label: c })),
          { value: OTHER, label: "Another file…" },
        ],
      }),
    );
  }
  if (file === OTHER) {
    file = cancelled(
      await p.path({
        message: "Plan file",
        validate: (v) => {
          if (!v) return "Enter a path";
          const info = existsSync(v) ? statSync(v) : null;
          if (!info?.isFile()) return "Not a file";
          if (info.size === 0) return "The file is empty";
          return undefined;
        },
      }),
    );
  }
  const planPath = path.resolve(file);
  if (!(await readText(planPath, "plan")).trim()) throw new UsageError("plan file is empty");
  return { kind: "plan", planPath };
}

/** The model an agent without an explicit model runs, for labels and effort choices. */
function effectiveModel(
  agent: AgentConfig,
  catalog: ModelCatalog | Error,
  codexModel: string | undefined,
): ModelInfo | undefined {
  if (catalog instanceof Error) return undefined;
  const id = agent.model ?? (agent.provider === "codex" ? codexModel : undefined);
  return id ? findModel(catalog, id) : defaultModel(catalog);
}

async function askAgent(
  role: Role,
  preset: Preset,
  catalogs: Record<Provider, Promise<ModelCatalog | Error>>,
  otherProvider?: Provider,
): Promise<AgentConfig> {
  const codex = await defaultCodexConfig();
  let agent = preset[role];
  if (!agent) {
    const loading = PROVIDERS.map((provider) => catalogs[provider]);
    const settled = await Promise.race([
      Promise.all(loading).then(() => true),
      Bun.sleep(150).then(() => false),
    ]);
    if (!settled) {
      const s = p.spinner();
      s.start("Loading the available models");
      await Promise.all(loading);
      s.stop("Loaded the available models");
    }
    const first: Provider =
      role === "author" ? "claude-code" : otherProvider === "codex" ? "claude-code" : "codex";
    const options: { value: string; label: string; hint?: string }[] = [];
    for (const provider of [first, ...PROVIDERS.filter((x) => x !== first)]) {
      const catalog = await catalogs[provider];
      const name = NAMES[provider];
      if (catalog instanceof Error) {
        options.push(
          {
            value: `${provider}:`,
            label: `${name} · default model`,
            hint: "model list unavailable",
          },
          { value: `${provider}:${OTHER}`, label: `${name} · enter a model id…` },
        );
        continue;
      }
      const fallback = defaultModel(catalog);
      const hint =
        provider === "codex" && codex.model
          ? `${codex.model}, from ${CODEX_CONFIG}`
          : fallback
            ? `currently ${fallback.id}`
            : "";
      options.push({ value: `${provider}:`, label: `${name} · default model`, hint });
      for (const m of catalog.models.filter((m) => !m.hidden)) {
        const o = modelOption(m);
        options.push({ ...o, value: `${provider}:${o.value}`, label: `${name} · ${o.label}` });
      }
    }
    const choice = cancelled(
      await p.autocomplete({
        message:
          role === "author"
            ? "Author: writes and revises the plan"
            : "Reviewer: checks the plan against your code",
        options,
        initialValue: `${first}:`,
        placeholder: "type to filter",
        maxItems: 10,
      }),
    );
    agent = parseAgent(choice, `--${role}`);
    if (agent.model === OTHER) {
      const model = cancelled(
        await p.text({
          message: `${NAMES[agent.provider]} model id`,
          validate: (v) => (!v?.trim() ? "Enter a model id" : undefined),
        }),
      );
      agent = { provider: agent.provider, model: model.trim() };
    }
  }
  const effort = preset.effort[role];
  if (effort) return { ...agent, effort };
  const catalog = await catalogs[agent.provider];
  const model = effectiveModel(agent, catalog, codex.model);
  const levels = catalog instanceof Error ? [...EFFORT_LEVELS] : (model?.efforts ?? []);
  if (levels.length === 0) return agent;
  const defaultHint =
    agent.provider === "codex" && codex.effort
      ? `${codex.effort}, from ${CODEX_CONFIG}`
      : (model?.defaultEffort ?? "the runtime's default");
  const chosen = cancelled(
    await p.select<Effort | "">({
      message: `${role === "author" ? "Author" : "Reviewer"} reasoning effort${model ? ` (${model.id})` : ""}`,
      options: [
        { value: "", label: "default", hint: defaultHint },
        ...levels.map((e) => ({ value: e, label: e })),
      ],
    }),
  );
  return chosen ? { ...agent, effort: chosen } : agent;
}

async function askChecks(repo: string): Promise<string[]> {
  const candidates = await detectChecks(repo);
  let custom = candidates.length === 0;
  let checks: string[] = [];
  if (candidates.length) {
    const chosen = cancelled(
      await p.multiselect({
        message: "Commands the agents may run to verify claims (optional; space toggles)",
        options: [
          ...candidates.map((c) => ({ value: c, label: c })),
          { value: OTHER, label: "Another command…" },
        ],
        required: false,
      }),
    );
    checks = chosen.filter((c) => c !== OTHER);
    custom = chosen.includes(OTHER);
  }
  if (custom) {
    const text = cancelled(
      await p.multiline({
        message: candidates.length
          ? "Other commands, one per line (Enter twice to finish)"
          : "Commands the agents may run to verify claims, one per line (optional; Enter twice to finish)",
        placeholder: "bun test",
        defaultValue: "",
      }),
    );
    checks.push(
      ...(text ?? "")
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean),
    );
  }
  return [...new Set(checks)];
}

function summarize(config: RunConfig): string {
  const agent = (a: AgentConfig) =>
    `${a.provider}${a.model ? `:${a.model}` : " (default model)"}${a.effort ? ` · effort ${a.effort}` : ""}`;
  const firstLine = (s: string, max = 70) => {
    const line = s.split("\n")[0]!;
    return line.length > max || s.includes("\n") ? `${line.slice(0, max)}…` : line;
  };
  const rows: [string, string][] = [
    [
      "Review",
      config.input.kind === "plan"
        ? display(config.input.planPath)
        : `brief: ${firstLine(config.input.brief)}`,
    ],
    ["Repository", display(config.repo)],
    ["Author", agent(config.author)],
    ["Reviewer", agent(config.reviewer)],
    ["Focus", config.focus.join(", ")],
    ["Constraints", config.constraints ? firstLine(config.constraints) : "none"],
    [
      "Checks",
      config.checks.length ? config.checks.join(", ") : "none (the agents run no commands)",
    ],
    ["Limits", `${config.maxRounds} round(s) · ${config.timeoutMs / 60_000} min`],
  ];
  const width = Math.max(...rows.map(([k]) => k.length));
  return rows.map(([k, v]) => `${dim(k.padEnd(width))}  ${v}`).join("\n");
}

/** Prompts for everything the flags left out, then confirms. Null: the user declined. */
export async function wizard(preset: Preset): Promise<RunConfig | null> {
  p.intro(bold(`crosscheck ${pkg.version}`));
  // Listing models takes about a second; start now so the lists are ready.
  const catalogs = Object.fromEntries(PROVIDERS.map((x) => [x, catalogOrError(x)])) as Record<
    Provider,
    Promise<ModelCatalog | Error>
  >;
  const input = preset.input ?? (await askInput());
  const author = await askAgent("author", preset, catalogs);
  const reviewer = await askAgent("reviewer", preset, catalogs, author.provider);
  const focus =
    preset.focus ??
    cancelled(
      await p.multiselect({
        message: "Review focus",
        options: FOCUS_AREAS.map((f) => ({ value: f, label: f })),
        initialValues: DEFAULT_FOCUS,
        required: true,
      }),
    );
  const constraints =
    preset.constraints ??
    cancelled(
      await p.multiline({
        message: "Constraints (optional; Enter twice to finish)",
        placeholder:
          "e.g. ~2k orgs, ship in 2 weeks, Postgres + Hono, keep the v1 API, no new infra",
        defaultValue: "",
      }),
    ).trim();
  const checks = preset.checks ?? (await askChecks(preset.repo));
  const maxRounds =
    preset.maxRounds ??
    cancelled(
      await p.select({
        message: "Maximum review rounds",
        options: [1, 2, 3, 4, 5].map((n) => ({
          value: n,
          label: String(n),
          hint: n === DEFAULTS.rounds ? "default" : "",
        })),
        initialValue: DEFAULTS.rounds,
      }),
    );
  const timeoutMs =
    preset.timeoutMs ??
    cancelled(
      await p.select({
        message: "Time limit",
        options: [15, 30, 60, 120, 240].map((m) => ({
          value: m * 60_000,
          label: m < 60 ? `${m} min` : `${m / 60} h`,
          hint: m === DEFAULTS.timeoutMinutes ? "default" : "",
        })),
        initialValue: DEFAULTS.timeoutMinutes * 60_000,
      }),
    );

  const config = await resolveAgents(
    {
      input,
      repo: preset.repo,
      focus,
      constraints,
      maxRounds,
      timeoutMs,
      author,
      reviewer,
      checks,
    },
    { interactive: true, warn: (m) => p.log.warn(m) },
  );
  p.note(summarize(config), "Review settings");
  p.log.message(`${dim("Same run without the prompts:")}\n${toCommandLine(config)}`);
  const start = cancelled(await p.confirm({ message: "Start the review?" }));
  if (!start) {
    p.cancel("Not started.");
    return null;
  }
  p.outro("Starting");
  return config;
}
