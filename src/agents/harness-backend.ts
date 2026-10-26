import type { HarnessV1NetworkSandboxSession } from "@ai-sdk/harness";
import { HarnessAgent } from "@ai-sdk/harness/agent";
import { createClaudeCode } from "@ai-sdk/harness-claude-code";
import { createCodex } from "@ai-sdk/harness-codex";
import { Output, type ModelMessage, type ToolSet } from "ai";
import os from "node:os";
import path from "node:path";
import type { Provider, Usage } from "../types.ts";
import {
  AgentError,
  type AgentBackend,
  type AgentSession,
  type SessionSpec,
  type ToolCallRecord,
  type TurnResult,
} from "./backend.ts";
import { createLocalNetworkSandboxSession, freePort } from "./local-sandbox.ts";

const STARTUP_TIMEOUT_MS = 10 * 60_000; // first run installs the agent runtime
const MAX_APPROVAL_DENIALS = 5;

const AUTH_HINTS: Record<Provider, string> = {
  "claude-code":
    "Authenticate Claude Code: run `claude` and use /login (subscription), or export ANTHROPIC_API_KEY.",
  codex: "Authenticate Codex: run `codex login` (ChatGPT plan), or export OPENAI_API_KEY.",
};

/** The Codex adapter hardcodes a default model; prefer the user's own Codex default when set. */
export async function defaultCodexModel(): Promise<string | undefined> {
  const home = process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex");
  try {
    const config = Bun.TOML.parse(await Bun.file(path.join(home, "config.toml")).text()) as {
      model?: unknown;
    };
    return typeof config.model === "string" ? config.model : undefined;
  } catch {
    return undefined;
  }
}

function summarize(value: unknown, max = 300): string {
  const s = typeof value === "string" ? value : JSON.stringify(value);
  return (s ?? "").length > max ? `${s.slice(0, max)}…` : (s ?? "");
}

function classify(provider: Provider, error: unknown): AgentError {
  if (error instanceof AgentError) return error;
  const message = error instanceof Error ? error.message : summarize(error, 2000);
  if (
    /\b(401|403)\b|unauthori[sz]ed|authenticat|not logged in|login|credential|api[ _-]?key/i.test(
      message,
    )
  ) {
    return new AgentError(`${provider}: ${message}`, AUTH_HINTS[provider]);
  }
  if (/model.*(not supported|not found|does not exist)|model_not_found/i.test(message)) {
    return new AgentError(
      `${provider}: ${message}`,
      `Choose a model your account supports, e.g. --${provider === "codex" ? "reviewer codex" : "author claude-code"}:<model>.`,
    );
  }
  return new AgentError(`${provider}: ${message}`);
}

export interface HarnessBackendOptions {
  repo: string;
  /** Host-executed tools; the agents' built-in tools are disabled. */
  tools: ToolSet;
}

export function createHarnessBackend(opts: HarnessBackendOptions): AgentBackend {
  return {
    async openSession(spec: SessionSpec): Promise<AgentSession> {
      const { provider } = spec.agent;
      const model =
        spec.agent.model ?? (provider === "codex" ? await defaultCodexModel() : undefined);
      const agent = new HarnessAgent({
        harness:
          provider === "claude-code"
            ? createClaudeCode({ startupTimeoutMs: STARTUP_TIMEOUT_MS, effort: spec.agent.effort })
            : createCodex({
                startupTimeoutMs: STARTUP_TIMEOUT_MS,
                reasoningEffort: spec.agent.effort,
              }),
        ...(model ? { model } : {}),
        instructions: spec.instructions,
        output: Output.object({ schema: spec.schema }),
        tools: opts.tools,
        // Allowlist of host tools only: disables every built-in tool (shell,
        // file edits, web). For Codex this also disables its execution
        // environments; Claude additionally gets approval-gated permissions so
        // anything that slips through is denied below.
        activeTools: Object.keys(opts.tools),
        permissionMode: provider === "codex" ? "allow-all" : "allow-reads",
        sandboxConfig: { workDir: "." },
      });

      let sandbox: HarnessV1NetworkSandboxSession | undefined;
      let session: Awaited<ReturnType<typeof agent.createSession>> | undefined;
      spec.onActivity?.({ kind: "status", message: `starting ${provider} runtime` });
      try {
        sandbox = await createLocalNetworkSandboxSession({
          workDir: opts.repo,
          port: await freePort(),
        });
        session = await agent.createSession({ sandboxSession: sandbox });
      } catch (e) {
        await sandbox?.destroy();
        throw classify(provider, e);
      }
      const live = session;
      const liveSandbox = sandbox;

      return {
        async send(prompt: string, signal: AbortSignal): Promise<TurnResult> {
          const toolCalls: ToolCallRecord[] = [];
          const usage: Usage = {};
          let text = "";
          let request: { prompt: string } | { messages: ModelMessage[] } = { prompt };
          try {
            for (let attempt = 0; ; attempt++) {
              const result = await agent.stream({ session: live, abortSignal: signal, ...request });
              const approvals: {
                approvalId: string;
                toolCall: { toolCallId: string; toolName: string; input: unknown };
              }[] = [];
              const pending = new Map<string, { name: string; input: unknown }>();
              let streamError: unknown;
              for await (const part of result.fullStream) {
                switch (part.type) {
                  case "text-delta":
                    text += part.text;
                    spec.onActivity?.({ kind: "text", delta: part.text });
                    break;
                  case "tool-call":
                    pending.set(part.toolCallId, { name: part.toolName, input: part.input });
                    spec.onActivity?.({
                      kind: "tool-call",
                      name: part.toolName,
                      input: part.input,
                    });
                    break;
                  case "tool-result":
                  case "tool-error": {
                    const call = pending.get(part.toolCallId);
                    const raw = part.type === "tool-result" ? part.output : part.error;
                    const ok =
                      part.type === "tool-result" &&
                      !(typeof raw === "string" && raw.startsWith("ERROR:"));
                    const record = {
                      name: part.toolName,
                      input: call?.input ?? part.input,
                      ok,
                      summary: summarize(raw),
                    };
                    toolCalls.push(record);
                    spec.onActivity?.({
                      kind: "tool-result",
                      name: record.name,
                      ok,
                      summary: record.summary,
                    });
                    break;
                  }
                  case "tool-approval-request":
                    approvals.push(part);
                    break;
                  case "finish": {
                    const meta = (
                      part as { providerMetadata?: Record<string, Record<string, unknown>> }
                    ).providerMetadata;
                    const cost = meta?.["claude-code"]?.costUsd;
                    if (typeof cost === "number") usage.costUsd = (usage.costUsd ?? 0) + cost;
                    break;
                  }
                  case "error":
                    streamError = part.error;
                    break;
                }
              }
              if (streamError !== undefined) throw streamError;
              const total = await result.totalUsage;
              usage.inputTokens = (usage.inputTokens ?? 0) + (total.inputTokens ?? 0);
              usage.outputTokens = (usage.outputTokens ?? 0) + (total.outputTokens ?? 0);
              usage.cachedInputTokens =
                (usage.cachedInputTokens ?? 0) + (total.inputTokenDetails?.cacheReadTokens ?? 0);

              if (approvals.length > 0) {
                // Built-in tools are disabled, so an approval request means a
                // tool outside the read-only policy. Deny and continue.
                if (attempt >= MAX_APPROVAL_DENIALS)
                  throw new AgentError("agent kept requesting denied tools");
                for (const a of approvals) {
                  toolCalls.push({
                    name: a.toolCall.toolName,
                    input: a.toolCall.input,
                    ok: false,
                    summary: "denied by crosscheck policy",
                  });
                  spec.onActivity?.({
                    kind: "tool-result",
                    name: a.toolCall.toolName,
                    ok: false,
                    summary: "denied by crosscheck policy",
                  });
                }
                request = {
                  messages: [
                    {
                      role: "assistant",
                      content: approvals.flatMap((a) => [
                        {
                          type: "tool-call" as const,
                          toolCallId: a.toolCall.toolCallId,
                          toolName: a.toolCall.toolName,
                          input: a.toolCall.input,
                          providerExecuted: true,
                        },
                        {
                          type: "tool-approval-request" as const,
                          approvalId: a.approvalId,
                          toolCallId: a.toolCall.toolCallId,
                        },
                      ]),
                    },
                    {
                      role: "tool",
                      content: approvals.map((a) => ({
                        type: "tool-approval-response" as const,
                        approvalId: a.approvalId,
                        approved: false,
                        reason:
                          "crosscheck policy: repository access is read-only; use the provided repository tools.",
                      })),
                    },
                  ],
                };
                continue;
              }

              try {
                return { text, output: await result.output, usage, toolCalls };
              } catch (e) {
                return {
                  text,
                  output: undefined,
                  outputError: (e as Error).message,
                  usage,
                  toolCalls,
                };
              }
            }
          } catch (e) {
            if (signal.aborted) throw signal.reason ?? e;
            throw classify(provider, e);
          }
        },
        async close() {
          try {
            await live.destroy();
          } finally {
            await liveSandbox.destroy();
          }
        },
      };
    },
  };
}
