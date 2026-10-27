import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type {
  AgentBackend,
  AgentSession,
  ToolCallRecord,
  TurnResult,
} from "../src/agents/backend.ts";
import type { AuthorOutput, ReviewerOutput } from "../src/schemas.ts";
import type { Role, RunConfig } from "../src/types.ts";

/** One scripted turn: a result, a thrown error, or "hang" (waits for the abort signal). */
export type Step =
  | Partial<TurnResult>
  | Error
  | "hang"
  | ((prompt: string) => Partial<TurnResult> | Error | "hang");

const READ: ToolCallRecord = {
  name: "read_file",
  input: { path: "src/app.ts" },
  ok: true,
  summary: "…",
};

export function fakeBackend(script: Record<Role, Step[]>) {
  const prompts: Record<Role, string[]> = { author: [], reviewer: [] };
  const closed: Role[] = [];
  const opened: Role[] = [];
  const backend: AgentBackend = {
    async openSession(spec) {
      opened.push(spec.role);
      const steps = script[spec.role];
      const session: AgentSession = {
        async send(prompt, signal) {
          prompts[spec.role].push(prompt);
          let step = steps.shift();
          if (step === undefined) throw new Error(`fake ${spec.role}: script exhausted`);
          if (typeof step === "function") step = step(prompt);
          if (step === "hang") {
            await new Promise((_, reject) => {
              if (signal.aborted) reject(signal.reason);
              signal.addEventListener("abort", () => reject(signal.reason), { once: true });
            });
          }
          if (step instanceof Error) throw step;
          const s = step as Partial<TurnResult>;
          return {
            text: s.text ?? "",
            output: s.output,
            ...(s.outputError ? { outputError: s.outputError } : {}),
            usage: s.usage ?? { inputTokens: 10, outputTokens: 5 },
            toolCalls: s.toolCalls ?? [READ],
          };
        },
        async close() {
          closed.push(spec.role);
        },
      };
      return session;
    },
  };
  return { backend, prompts, closed, opened };
}

type NewFinding = ReviewerOutput["new_findings"][number];

export function finding(overrides: Partial<NewFinding> = {}): NewFinding {
  return {
    duplicate_of: null,
    category: "security",
    severity: "high",
    title: "Token comparison is not constant time",
    location: "plan §Auth; src/auth.ts:3",
    problem: "Tokens are compared with === which leaks timing information",
    evidence_type: "repository_evidence",
    evidence: "src/auth.ts:3 uses ===",
    assumptions: "",
    suggestion: "Use crypto.timingSafeEqual",
    ...overrides,
  };
}

export function review(o: Partial<ReviewerOutput> = {}): Partial<TurnResult> {
  return {
    output: {
      summary: "review",
      verdicts: [],
      responses: [],
      new_findings: [],
      assumptions: [],
      ...o,
    } satisfies ReviewerOutput,
  };
}

export function verdict<V extends ReviewerOutput["verdicts"][number]["verdict"]>(
  id: string,
  v: V,
  reason = "checked",
) {
  return { id, verdict: v, reason, evidence: "plan §Auth" };
}

export function author(o: Partial<AuthorOutput> = {}): Partial<TurnResult> {
  return {
    output: {
      summary: "responded",
      responses: [],
      verdicts: [],
      new_findings: [],
      revised_plan: null,
      assumptions: [],
      ...o,
    } satisfies AuthorOutput,
  };
}

export function response(
  id: string,
  action: AuthorOutput["responses"][number]["action"],
  text = "done",
): AuthorOutput["responses"][number] {
  return {
    id,
    action,
    response: text,
    evidence: "src/auth.ts:3",
    plan_change: action === "accept" ? "updated §Auth" : "",
  };
}

const tempRepos: string[] = [];

export async function tempRepo(): Promise<{ repo: string; planPath: string }> {
  const repo = await mkdtemp(path.join(os.tmpdir(), "crosscheck-test-"));
  tempRepos.push(repo);
  await Bun.write(path.join(repo, "src/app.ts"), "export const x = 1;\n");
  const planPath = path.join(repo, "PLAN.md");
  await Bun.write(planPath, "# Plan\n\n## Auth\nCompare tokens with ===.\n");
  return { repo, planPath };
}

/** Remove every repository created by tempRepo(); call from afterAll. */
export async function removeTempRepos(): Promise<void> {
  await Promise.all(tempRepos.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
}

export function config(repo: string, planPath: string, over: Partial<RunConfig> = {}): RunConfig {
  return {
    input: { kind: "plan", planPath },
    repo,
    focus: ["security", "correctness"],
    constraints: "",
    maxRounds: 3,
    timeoutMs: 60_000,
    author: { provider: "claude-code" },
    reviewer: { provider: "codex" },
    checks: [],
    ...over,
  };
}
