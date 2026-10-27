import { createTwoFilesPatch, diffLines } from "diff";
import type { z } from "zod";
import {
  AgentError,
  type AgentActivity,
  type AgentBackend,
  type AgentSession,
  type ToolCallRecord,
  type TurnResult,
} from "./agents/backend.ts";
import { Ledger, LedgerError, type Finding } from "./findings.ts";
import * as prompts from "./prompts.ts";
import { renderReport } from "./report.ts";
import { repoIdentity, workingTreeSnapshot, type RepoIdentity } from "./repo.ts";
import {
  authorOutputSchema,
  checkAuthorOutput,
  checkReviewerOutput,
  reviewerOutputSchema,
  toNewFinding,
  type AuthorOutput,
  type ReviewerOutput,
} from "./schemas.ts";
import type { RunStore } from "./store.ts";
import {
  MATERIAL_SEVERITIES,
  type CheckResult,
  type FindingStatus,
  type Outcome,
  type Role,
  type RunConfig,
  type Usage,
} from "./types.ts";

/** Correction attempts allowed after an agent's output fails validation. */
export const MAX_CORRECTIONS = 1;
/** Consecutive rounds without any change in the plan or finding statuses before a run counts as stalled. */
export const STALL_ROUNDS = 2;
/** Streamed agent text is written to the transcript in chunks of this size or age. */
const TEXT_FLUSH_CHARS = 2_000;
const TEXT_FLUSH_MS = 1_000;

export type RunEvent =
  | { type: "phase"; round: number; phase: string; agent: string | null }
  | { type: "activity"; agent: string; activity: AgentActivity }
  | {
      type: "findings";
      round: number;
      raised: Finding[];
      resolved: Finding[];
      counts: Record<FindingStatus, number>;
    }
  | { type: "plan"; version: number; path: string }
  | { type: "note"; message: string };

export interface PlanVersion {
  version: number;
  round: number;
  createdBy: string;
  path: string;
  summary: string;
  /** Line changes relative to the previous version. */
  linesAdded: number;
  linesRemoved: number;
}

export interface RoundLog {
  round: number;
  authorSummary: string | null;
  reviewerSummary: string | null;
  raised: string[];
  resolved: string[];
}

export interface RunState {
  id: string;
  status: "running" | Outcome;
  reason: string;
  startedAt: string;
  endedAt: string | null;
  elapsedMs: number;
  round: number;
  config: RunConfig;
  repo: RepoIdentity | null;
  agents: Record<Role, string>;
  planVersions: PlanVersion[];
  rounds: RoundLog[];
  usage: Record<Role, Usage & { turns: number }>;
  checks: CheckResult[];
  assumptions: { agent: string; round: number; text: string }[];
  examined: Record<Role, string[]>;
  error: { message: string; hint?: string } | null;
  /** Whether the repository working tree changed during the run (null outside git). */
  repoModified: boolean | null;
}

export interface RunDeps {
  config: RunConfig;
  store: RunStore;
  /** Builds the agent backend; onCheck records verification commands the tools ran. */
  createBackend: (hooks: {
    onCheck: (r: { command: string; exitCode: number | null; output: string }) => void;
  }) => AgentBackend;
  /** User cancellation (Ctrl-C). */
  signal?: AbortSignal;
  onEvent?: (event: RunEvent) => void;
}

class ValidationError extends Error {}

export function agentLabel(role: Role, config: RunConfig): string {
  const a = config[role];
  return `${a.provider}${a.model ? `:${a.model}` : ""}${a.effort ? ` [${a.effort}]` : ""} (${role})`;
}

/** Decide whether the loop must stop after a reviewer pass. Null means continue. */
export function evaluate(
  ledger: Ledger,
  ctx: { newMaterial: number; failedChecks: string[] },
): { outcome: Outcome; reason: string } | null {
  const unresolved = ledger.unresolvedMaterial();
  if (unresolved.length === 0 && ctx.newMaterial === 0) {
    if (ctx.failedChecks.length > 0) {
      return {
        outcome: "needs_input",
        reason: `verification checks failed: ${ctx.failedChecks.join(", ")}`,
      };
    }
    return {
      outcome: "review_complete",
      reason:
        "no unresolved high/medium findings and the last review raised no new material issues",
    };
  }
  if (unresolved.length > 0 && unresolved.every(Ledger.needsUser)) {
    return {
      outcome: "needs_input",
      reason: `${unresolved.length} material finding(s) need your decision: ${unresolved.map((f) => f.id).join(", ")}`,
    };
  }
  return null;
}

function describeTool(call: ToolCallRecord): string {
  const input = (call.input ?? {}) as Record<string, unknown>;
  switch (call.name) {
    case "read_file":
      return String(input.path);
    case "list_files":
      return `list ${input.path ?? "."}${input.pattern ? ` ${input.pattern}` : ""}`;
    case "search":
      return `search /${input.pattern}/${input.path ? ` in ${input.path}` : ""}`;
    case "git":
      return `git ${(input.args as string[] | undefined)?.join(" ") ?? ""}`;
    case "run_check":
      return `run ${input.command}`;
    default:
      return `${call.name} (denied)`;
  }
}

export async function runReview(deps: RunDeps): Promise<RunState> {
  const { config, store } = deps;
  const started = Date.now();
  const timeout = AbortSignal.timeout(config.timeoutMs);
  const signal = AbortSignal.any(deps.signal ? [deps.signal, timeout] : [timeout]);
  const ledger = new Ledger();
  const emit = (e: RunEvent) => deps.onEvent?.(e);
  const labels: Record<Role, string> = {
    author: agentLabel("author", config),
    reviewer: agentLabel("reviewer", config),
  };

  const state: RunState = {
    id: store.id,
    status: "running",
    reason: "",
    startedAt: new Date(started).toISOString(),
    endedAt: null,
    elapsedMs: 0,
    round: 0,
    config,
    repo: null,
    agents: labels,
    planVersions: [],
    rounds: [],
    usage: { author: { turns: 0 }, reviewer: { turns: 0 } },
    checks: [],
    assumptions: [],
    examined: { author: [], reviewer: [] },
    error: null,
    repoModified: null,
  };

  let activeRole: Role | null = null;
  const persist = async () => {
    state.elapsedMs = Date.now() - started;
    await store.writeJson("run.json", state);
    await store.writeJson("findings.json", ledger.toJSON());
  };
  const backendHooks = {
    onCheck: (r: { command: string; exitCode: number | null; output: string }) => {
      const check: CheckResult = {
        ...r,
        passed: r.exitCode === 0,
        round: state.round,
        agent: activeRole ? labels[activeRole] : "unknown",
      };
      state.checks.push(check);
      void store.append("events.jsonl", { type: "check", ...check });
    },
  };
  let backend: AgentBackend;
  const sessions: Partial<Record<Role, AgentSession>> = {};
  const roundLog = (round: number): RoundLog => {
    let log = state.rounds.find((r) => r.round === round);
    if (!log)
      state.rounds.push(
        (log = { round, authorSummary: null, reviewerSummary: null, raised: [], resolved: [] }),
      );
    return log;
  };
  const phase = (phaseName: string, role: Role | null) => {
    emit({
      type: "phase",
      round: state.round,
      phase: phaseName,
      agent: role ? labels[role] : null,
    });
    void store.append("events.jsonl", {
      type: "phase",
      round: state.round,
      phase: phaseName,
      agent: role ? labels[role] : null,
    });
  };

  // Streamed text is batched so the transcript holds readable chunks rather
  // than one line per token; partial text still survives an interruption.
  const pendingText: Record<Role, string> = { author: "", reviewer: "" };
  const textTimers: Partial<Record<Role, ReturnType<typeof setTimeout>>> = {};
  const flushText = (role: Role) => {
    clearTimeout(textTimers[role]);
    textTimers[role] = undefined;
    if (!pendingText[role]) return;
    const delta = pendingText[role];
    pendingText[role] = "";
    void store.append("transcript.jsonl", {
      type: "activity",
      role,
      agent: labels[role],
      round: state.round,
      activity: { kind: "text", delta },
    });
  };

  async function session(role: Role): Promise<AgentSession> {
    signal.throwIfAborted();
    const existing = sessions[role];
    if (existing) return existing;
    const created = await backend.openSession({
      role,
      label: labels[role],
      agent: config[role],
      instructions:
        role === "author"
          ? prompts.authorInstructions(config)
          : prompts.reviewerInstructions(config),
      schema: role === "author" ? authorOutputSchema : reviewerOutputSchema,
      signal,
      onActivity: (activity) => {
        if (activity.kind === "text") {
          pendingText[role] += activity.delta;
          if (pendingText[role].length >= TEXT_FLUSH_CHARS) flushText(role);
          else textTimers[role] ??= setTimeout(() => flushText(role), TEXT_FLUSH_MS);
        } else {
          flushText(role);
          void store.append("transcript.jsonl", {
            type: "activity",
            role,
            agent: labels[role],
            round: state.round,
            activity,
          });
        }
        emit({ type: "activity", agent: labels[role], activity });
        if (activity.kind === "tool-call")
          void store.append("events.jsonl", {
            type: "tool-call",
            agent: labels[role],
            round: state.round,
            tool: activity.name,
            input: activity.input,
          });
        if (activity.kind === "tool-result")
          void store.append("events.jsonl", {
            type: "tool-result",
            agent: labels[role],
            round: state.round,
            tool: activity.name,
            ok: activity.ok,
            summary: activity.summary,
          });
      },
    });
    sessions[role] = created;
    return created;
  }

  /** Run a turn and validate it; allow MAX_CORRECTIONS correction turns before failing. */
  async function ask<T>(
    role: Role,
    prompt: string,
    schema: z.ZodType<T>,
    check: (out: T, toolCalls: number) => string[],
  ): Promise<T> {
    activeRole = role;
    const s = await session(role);
    let toolCalls = 0;
    let errors: string[] = [];
    for (let attempt = 0; attempt <= MAX_CORRECTIONS; attempt++) {
      signal.throwIfAborted();
      const turnPrompt = attempt === 0 ? prompt : prompts.correctionPrompt(errors);
      await store.append("transcript.jsonl", {
        type: "turn-start",
        role,
        agent: labels[role],
        round: state.round,
        attempt,
        prompt: turnPrompt,
      });
      let turn: TurnResult;
      try {
        turn = await s.send(turnPrompt, signal);
        signal.throwIfAborted();
      } catch (e) {
        flushText(role);
        await store.append("transcript.jsonl", {
          type: "turn-error",
          role,
          agent: labels[role],
          round: state.round,
          attempt,
          error: e instanceof Error ? e.message : String(e),
        });
        throw e;
      }
      const usage = state.usage[role];
      usage.turns += 1;
      for (const key of ["inputTokens", "outputTokens", "cachedInputTokens", "costUsd"] as const) {
        if (turn.usage[key] != null) usage[key] = (usage[key] ?? 0) + turn.usage[key];
      }
      toolCalls += turn.toolCalls.filter(
        (c) => c.ok && ["read_file", "list_files", "search", "git"].includes(c.name),
      ).length;
      for (const c of turn.toolCalls) {
        if (!c.ok) continue;
        const d = describeTool(c);
        if (!state.examined[role].includes(d)) state.examined[role].push(d);
      }
      let value: T | undefined;
      if (turn.output === undefined) {
        errors = [`no valid structured output was produced (${turn.outputError ?? "missing"})`];
      } else {
        const parsed = schema.safeParse(turn.output);
        if (parsed.success) {
          value = parsed.data;
          errors = check(parsed.data, toolCalls);
        } else {
          errors = parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`);
        }
      }
      flushText(role);
      await store.append("transcript.jsonl", {
        type: "turn-complete",
        role,
        agent: labels[role],
        round: state.round,
        attempt,
        prompt: turnPrompt,
        text: turn.text,
        output: turn.output ?? null,
        outputError: turn.outputError ?? null,
        validationErrors: errors,
        toolCalls: turn.toolCalls,
        usage: turn.usage,
      });
      if (errors.length === 0 && value !== undefined) return value;
      emit({
        type: "note",
        message: `${labels[role]} output rejected (${errors.length} problem(s)); ${attempt < MAX_CORRECTIONS ? "asking for a correction" : "giving up"}`,
      });
    }
    throw new ValidationError(
      `${labels[role]} produced invalid output after ${MAX_CORRECTIONS} correction attempt(s): ${errors.join("; ")}`,
    );
  }

  let plan = "";
  let version = 0;
  const planTexts: string[] = [];
  async function savePlan(text: string, createdBy: string, summary: string) {
    const v = state.planVersions.length === 0 ? 0 : version + 1;
    const p = await store.savePlan(v, text);
    let linesAdded = 0;
    let linesRemoved = 0;
    if (v > 0) {
      for (const c of diffLines(plan, text)) {
        if (c.added) linesAdded += c.count;
        if (c.removed) linesRemoved += c.count;
      }
    }
    version = v;
    plan = text;
    planTexts[v] = text;
    state.planVersions.push({
      version: v,
      round: state.round,
      createdBy,
      path: p,
      summary,
      linesAdded,
      linesRemoved,
    });
    emit({ type: "plan", version: v, path: p });
  }

  function recordAssumptions(role: Role, items: string[]) {
    for (const text of items)
      if (text.trim()) state.assumptions.push({ agent: labels[role], round: state.round, text });
  }

  async function reviewerPass(
    kind: "initial" | "verify",
    prompt: string,
    mustVerify: string[],
  ): Promise<number> {
    phase(kind === "initial" ? "independent review" : "verifying revision", "reviewer");
    const out: ReviewerOutput = await ask(
      "reviewer",
      prompt,
      reviewerOutputSchema,
      (o, toolCalls) =>
        checkReviewerOutput(o, {
          findings: ledger.list(),
          mustVerify,
          toolCalls,
          initial: kind === "initial",
        }),
    );
    const log = roundLog(state.round);
    const resolved: Finding[] = [];
    for (const v of out.verdicts) {
      const f = ledger.verify(v.id, {
        round: state.round,
        verdict: v.verdict,
        reason: v.reason,
        evidence: v.evidence,
      });
      if (f.status === "verified" || f.status === "withdrawn") resolved.push(f);
    }
    const raised: Finding[] = [];
    let newMaterial = 0;
    for (const nf of out.new_findings) {
      const { finding, created, reopened } = ledger.raise(
        state.round,
        labels.reviewer,
        toNewFinding(nf),
      );
      if (created) raised.push(finding);
      // A closed material finding that came back counts as a new material issue.
      if ((created || reopened) && MATERIAL_SEVERITIES.has(finding.severity)) newMaterial += 1;
    }
    log.reviewerSummary = out.summary;
    log.raised.push(...raised.map((f) => f.id));
    log.resolved.push(...resolved.map((f) => f.id));
    recordAssumptions("reviewer", out.assumptions);
    emit({ type: "findings", round: state.round, raised, resolved, counts: ledger.counts() });
    await persist();
    return newMaterial;
  }

  async function authorPass(): Promise<{
    responded: Finding[];
    fromVersion: number;
    summary: string;
  }> {
    const targets = ledger
      .list()
      .filter((f) => f.status === "open" || (f.status === "disputed" && !Ledger.needsUser(f)));
    phase(`responding to ${targets.length} finding(s)`, "author");
    const out: AuthorOutput = await ask(
      "author",
      prompts.authorResponsePrompt(state.round, targets, version, plan),
      authorOutputSchema,
      (o) => checkAuthorOutput(o, { mustRespond: targets.map((f) => f.id), drafting: false }),
    );
    for (const r of out.responses) {
      ledger.respond(r.id, {
        round: state.round,
        action: r.action,
        response: r.response,
        evidence: r.evidence,
        planChange: r.plan_change,
      });
    }
    const fromVersion = version;
    if (out.revised_plan != null && out.revised_plan.trim() !== plan.trim()) {
      await savePlan(out.revised_plan, labels.author, out.summary);
    }
    roundLog(state.round).authorSummary = out.summary;
    recordAssumptions("author", out.assumptions);
    const tally = (a: string) => out.responses.filter((r) => r.action === a).length;
    emit({
      type: "note",
      message: `author accepted ${tally("accept")}, disputed ${tally("dispute")}, asked you to decide ${tally("needs_user_decision")}; ${fromVersion === version ? "plan unchanged" : `plan v${fromVersion} → v${version}`}`,
    });
    await persist();
    return { responded: targets.map((f) => ledger.get(f.id)!), fromVersion, summary: out.summary };
  }

  const failedChecks = () => {
    const latest = new Map<string, CheckResult>();
    for (const c of state.checks) latest.set(c.command, c);
    return [...latest.values()].filter((c) => !c.passed).map((c) => c.command);
  };
  const finish = (outcome: Outcome, reason: string) => {
    state.status = outcome;
    state.reason = reason;
  };

  let before: string | null = null;
  try {
    backend = deps.createBackend(backendHooks);
    state.repo = await repoIdentity(config.repo);
    before = await workingTreeSnapshot(config.repo);
    await store.writeJson("input/config.json", config);
    if (config.input.kind === "brief")
      await store.writeText("input/brief.md", `${config.input.brief}\n`);
    if (config.constraints.trim())
      await store.writeText("input/constraints.md", `${config.constraints}\n`);
    await persist();

    if (config.input.kind === "plan") {
      const original = await Bun.file(config.input.planPath).text();
      if (!original.trim()) throw new Error("plan file is empty");
      await store.writeText("input/plan.original.md", original);
      await savePlan(original, "user", "original plan supplied by the user");
    } else {
      phase("drafting the initial plan", "author");
      const out: AuthorOutput = await ask(
        "author",
        prompts.draftPrompt(),
        authorOutputSchema,
        (o) => checkAuthorOutput(o, { mustRespond: [], drafting: true }),
      );
      recordAssumptions("author", out.assumptions);
      await savePlan(out.revised_plan!, labels.author, out.summary);
    }
    await persist();

    state.round = 1;
    let newMaterial = await reviewerPass("initial", prompts.initialReviewPrompt(version, plan), []);
    let cycleDone = false;
    let unchangedRounds = 0;
    for (;;) {
      signal.throwIfAborted();
      const decision = evaluate(ledger, { newMaterial, failedChecks: failedChecks() });
      if (decision) {
        finish(decision.outcome, decision.reason);
        break;
      }
      if (cycleDone) {
        if (unchangedRounds >= STALL_ROUNDS) {
          finish(
            "stalled",
            `${unchangedRounds} consecutive rounds changed neither the plan nor any finding status`,
          );
          break;
        }
        if (state.round >= config.maxRounds) {
          finish(
            "budget_exhausted",
            `reached the limit of ${config.maxRounds} round(s) with material findings unresolved`,
          );
          break;
        }
        state.round += 1;
      }
      const fingerprint = `${Bun.hash(plan)}|${ledger.fingerprint()}`;
      const { responded, fromVersion, summary } = await authorPass();
      const diff =
        fromVersion === version
          ? null
          : createTwoFilesPatch(
              `plan/v${fromVersion}.md`,
              `plan/v${version}.md`,
              planTexts[fromVersion] ?? "",
              plan,
              "",
              "",
              { context: 3 },
            );
      const respondedIds = new Set(responded.map((f) => f.id));
      const context = ledger.unresolvedMaterial().filter((f) => !respondedIds.has(f.id));
      newMaterial = await reviewerPass(
        "verify",
        prompts.verificationPrompt({
          round: state.round,
          responded,
          context,
          fromVersion,
          toVersion: version,
          diff,
          plan,
          authorSummary: summary,
        }),
        responded.map((f) => f.id),
      );
      unchangedRounds =
        `${Bun.hash(plan)}|${ledger.fingerprint()}` === fingerprint ? unchangedRounds + 1 : 0;
      cycleDone = true;
    }
  } catch (e) {
    if (deps.signal?.aborted) {
      finish("cancelled", "interrupted by the user");
    } else if (timeout.aborted) {
      finish(
        "budget_exhausted",
        `reached the time limit of ${Math.round(config.timeoutMs / 60_000)} minute(s)`,
      );
    } else {
      const err = e as Error;
      const kind =
        e instanceof ValidationError
          ? "output validation failed"
          : e instanceof LedgerError
            ? "inconsistent agent output"
            : e instanceof AgentError
              ? "agent failure"
              : "unexpected failure";
      finish("error", `${kind}: ${err.message}`);
      state.error = {
        message: err.message,
        ...(e instanceof AgentError && e.hint ? { hint: e.hint } : {}),
      };
    }
  } finally {
    phase("finishing", null);
    await Promise.all(
      Object.values(sessions).map((s) =>
        Promise.race([s.close().catch(() => {}), Bun.sleep(15_000)]),
      ),
    );
    if (before != null) {
      const after = await workingTreeSnapshot(config.repo).catch(() => null);
      state.repoModified = after != null && after !== before;
    }
    state.endedAt = new Date().toISOString();
    try {
      flushText("author");
      flushText("reviewer");
      await store.flush();
      await persist();
      await store.writeText("report.md", renderReport(state, ledger.list(), store.dir));
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      finish("error", `could not save run artifacts: ${message}`);
      state.error = { message };
      await persist().catch(() => {});
      await store
        .writeText("report.md", renderReport(state, ledger.list(), store.dir))
        .catch(() => {});
    }
  }
  return state;
}
