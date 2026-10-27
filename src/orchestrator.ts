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
import { Ledger, LedgerError, type Finding, type Ruling } from "./findings.ts";
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
  CLOSED_STATUSES,
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
  /** Whether the round began with a full review in fresh sessions. */
  full: boolean;
  /** The reviewer's full review, when the round had one. */
  reviewSummary: string | null;
  authorSummary: string | null;
  /** The reviewer's check of the author's turn. */
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

/**
 * Decide whether the loop stops after a round. Null means continue. A run
 * completes only when no point is still being discussed and the latest full
 * review by both agents raised nothing material.
 */
export function evaluate(
  ledger: Ledger,
  ctx: { cleanReview: boolean; failedChecks: string[] },
): { outcome: Outcome; reason: string } | null {
  if (ledger.pending().length > 0 || !ctx.cleanReview) return null;
  const forUser = ledger.list().filter(Ledger.needsUser);
  if (forUser.length > 0)
    return {
      outcome: "needs_input",
      reason: `the agents agree on everything else; ${forUser.length} point(s) need your decision: ${forUser.map((f) => f.id).join(", ")}`,
    };
  if (ctx.failedChecks.length > 0)
    return {
      outcome: "needs_input",
      reason: `verification checks failed: ${ctx.failedChecks.join(", ")}`,
    };
  return {
    outcome: "review_complete",
    reason:
      "both agents agree on every point, and their last full review found nothing material to change",
  };
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
        (log = {
          round,
          full: false,
          reviewSummary: null,
          authorSummary: null,
          reviewerSummary: null,
          raised: [],
          resolved: [],
        }),
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

  /** Ends a role's session so its next turn starts fresh, without memory of earlier rounds. */
  async function resetSession(role: Role) {
    const s = sessions[role];
    if (!s) return;
    delete sessions[role];
    await Promise.race([s.close().catch(() => {}), Bun.sleep(15_000)]);
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

  /** Applies one agent's answers, rulings and new points. Returns what changed. */
  function applyTurn(
    role: Role,
    out: Pick<ReviewerOutput, "responses" | "new_findings"> & {
      verdicts: { id: string; verdict: Ruling; reason: string; evidence: string }[];
    },
  ) {
    const round = state.round;
    const resolved: Finding[] = [];
    const closed = (f: Finding) => {
      if (CLOSED_STATUSES.has(f.status)) resolved.push(f);
    };
    for (const r of out.responses)
      closed(
        ledger.respond(r.id, {
          round,
          actor: role,
          action: r.action,
          response: r.response,
          evidence: r.evidence,
          planChange: r.plan_change,
        }),
      );
    for (const v of out.verdicts)
      closed(
        ledger.verify(v.id, {
          round,
          actor: role,
          verdict: v.verdict,
          reason: v.reason,
          evidence: v.evidence,
        }),
      );
    const raised: Finding[] = [];
    let newMaterial = 0;
    for (const nf of out.new_findings) {
      const { finding, created, reopened } = ledger.raise(
        round,
        role,
        labels[role],
        toNewFinding(nf),
      );
      if (created) raised.push(finding);
      // A closed material point that came back counts as a new material issue.
      if ((created || reopened) && MATERIAL_SEVERITIES.has(finding.severity)) newMaterial += 1;
    }
    const log = roundLog(round);
    log.raised.push(...raised.map((f) => f.id));
    log.resolved.push(...resolved.map((f) => f.id));
    emit({ type: "findings", round, raised, resolved, counts: ledger.counts() });
    return { newMaterial, raised };
  }

  /** The reviewer reads the whole plan in a fresh session. Returns new material points. */
  async function fullReview(): Promise<number> {
    phase("full review", "reviewer");
    const out: ReviewerOutput = await ask(
      "reviewer",
      prompts.fullReviewPrompt({
        round: state.round,
        version,
        plan,
        focus: config.focus,
        points: ledger.list(),
      }),
      reviewerOutputSchema,
      (o, toolCalls) =>
        checkReviewerOutput(o, {
          ledger,
          mustRespond: [],
          mustRule: [],
          toolCalls,
          requireInspection: true,
        }),
    );
    const { newMaterial } = applyTurn("reviewer", out);
    roundLog(state.round).reviewSummary = out.summary;
    recordAssumptions("reviewer", out.assumptions);
    await persist();
    return newMaterial;
  }

  /** The author answers the reviewer, rules on its own disputed points and critiques the plan. */
  async function authorPass(fresh: boolean): Promise<{
    newMaterial: number;
    fromVersion: number;
    summary: string;
  }> {
    const waiting = ledger.awaiting("author");
    const toAnswer = waiting.filter((f) => f.raiser === "reviewer");
    const toRule = waiting.filter((f) => f.raiser === "author");
    phase(
      waiting.length > 0
        ? `answering ${waiting.length} point(s) and critiquing the plan`
        : "critiquing the plan",
      "author",
    );
    const out: AuthorOutput = await ask(
      "author",
      prompts.authorTurnPrompt({
        round: state.round,
        fresh,
        toAnswer,
        toRule,
        settled: ledger.list().filter((f) => f.awaiting == null),
        version,
        plan,
      }),
      authorOutputSchema,
      (o) =>
        checkAuthorOutput(o, {
          ledger,
          mustRespond: toAnswer.map((f) => f.id),
          mustRule: toRule.map((f) => f.id),
          drafting: false,
        }),
    );
    const { newMaterial, raised } = applyTurn("author", out);
    const fromVersion = version;
    if (out.revised_plan != null && out.revised_plan.trim() !== plan.trim()) {
      await savePlan(out.revised_plan, labels.author, out.summary);
    }
    roundLog(state.round).authorSummary = out.summary;
    recordAssumptions("author", out.assumptions);
    const tally = (a: string) => out.responses.filter((r) => r.action === a).length;
    const kept = out.verdicts.filter((v) => v.verdict === "maintain_dispute").length;
    const dropped = out.verdicts.filter((v) => v.verdict === "withdrawn").length;
    emit({
      type: "note",
      message: `author accepted ${tally("accept")}, disputed ${tally("dispute")}, asked you to decide ${tally("needs_user_decision")}, raised ${raised.length} of its own${kept + dropped > 0 ? `, kept ${kept} and withdrew ${dropped} of its disputed points` : ""}; ${fromVersion === version ? "plan unchanged" : `plan v${fromVersion} → v${version}`}`,
    });
    await persist();
    return { newMaterial, fromVersion, summary: out.summary };
  }

  /** The reviewer rules on the author's answers and answers the author's own points. */
  async function verifyPass(turn: { fromVersion: number; summary: string }): Promise<number> {
    const waiting = ledger.awaiting("reviewer");
    const toRule = waiting.filter((f) => f.raiser === "reviewer");
    const toAnswer = waiting.filter((f) => f.raiser === "author");
    phase("checking the author's turn", "reviewer");
    const diff =
      turn.fromVersion === version
        ? null
        : createTwoFilesPatch(
            `plan/v${turn.fromVersion}.md`,
            `plan/v${version}.md`,
            planTexts[turn.fromVersion] ?? "",
            plan,
            "",
            "",
            { context: 3 },
          );
    const out: ReviewerOutput = await ask(
      "reviewer",
      prompts.verificationPrompt({
        round: state.round,
        toRule,
        toAnswer,
        context: ledger.list().filter(Ledger.needsUser),
        fromVersion: turn.fromVersion,
        toVersion: version,
        diff,
        plan,
        authorSummary: turn.summary,
      }),
      reviewerOutputSchema,
      (o, toolCalls) =>
        checkReviewerOutput(o, {
          ledger,
          mustRespond: toAnswer.map((f) => f.id),
          mustRule: toRule.map((f) => f.id),
          toolCalls,
          requireInspection: false,
        }),
    );
    const { newMaterial } = applyTurn("reviewer", out);
    roundLog(state.round).reviewerSummary = out.summary;
    recordAssumptions("reviewer", out.assumptions);
    await persist();
    return newMaterial;
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
        (o) => checkAuthorOutput(o, { ledger, mustRespond: [], mustRule: [], drafting: true }),
      );
      recordAssumptions("author", out.assumptions);
      await savePlan(out.revised_plan!, labels.author, out.summary);
    }
    await persist();

    // A round starts with a full review in fresh sessions whenever no point is
    // still being discussed; otherwise it continues the discussion. Either way
    // the author takes a turn and the reviewer checks it.
    let cleanReview = false;
    let unchangedRounds = 0;
    for (;;) {
      signal.throwIfAborted();
      state.round += 1;
      const full = ledger.pending().length === 0;
      roundLog(state.round).full = full;
      const fingerprint = `${Bun.hash(plan)}|${ledger.fingerprint()}`;
      let material = 0;
      if (full) {
        await resetSession("reviewer");
        await resetSession("author");
        material += await fullReview();
      }
      const turn = await authorPass(full);
      material += turn.newMaterial;
      if (ledger.awaiting("reviewer").length > 0 || turn.fromVersion !== version)
        material += await verifyPass(turn);
      if (full) cleanReview = material === 0;
      else if (material > 0) cleanReview = false;

      const decision = evaluate(ledger, { cleanReview, failedChecks: failedChecks() });
      if (decision) {
        finish(decision.outcome, decision.reason);
        break;
      }
      unchangedRounds =
        `${Bun.hash(plan)}|${ledger.fingerprint()}` === fingerprint ? unchangedRounds + 1 : 0;
      if (unchangedRounds >= STALL_ROUNDS) {
        finish(
          "stalled",
          `${unchangedRounds} consecutive rounds changed neither the plan nor any point's status`,
        );
        break;
      }
      if (state.round >= config.maxRounds) {
        const pending = ledger.pending().length;
        finish(
          "budget_exhausted",
          pending > 0
            ? `reached the limit of ${config.maxRounds} round(s) with ${pending} point(s) still under discussion`
            : `reached the limit of ${config.maxRounds} round(s) before a full review came back clean`,
        );
        break;
      }
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
