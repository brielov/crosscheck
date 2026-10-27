import path from "node:path";
import { Ledger, otherRole, type Finding } from "./findings.ts";
import { relativePath, shellQuote, toCommandLine } from "./options.ts";
import type { RunState } from "./orchestrator.ts";
import { CLOSED_STATUSES, type Usage } from "./types.ts";

const OUTCOME_TEXT: Record<RunState["status"], string> = {
  running: "Run in progress (or interrupted before it could finish)",
  review_complete: "Review complete",
  needs_input: "Needs your input",
  budget_exhausted: "Budget exhausted",
  stalled: "Stalled",
  error: "Error",
  cancelled: "Cancelled",
};

export function formatDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  const m = Math.floor(s / 60);
  return m > 0 ? `${m}m ${String(s % 60).padStart(2, "0")}s` : `${s}s`;
}

export function formatUsage(u: Usage & { turns: number }): string {
  const n = (v: number | undefined) => (v == null ? "n/a" : v.toLocaleString("en-US"));
  const cost = u.costUsd == null ? "n/a" : `$${u.costUsd.toFixed(2)}`;
  return `${u.turns} turn(s), input ${n(u.inputTokens)} (cached ${n(u.cachedInputTokens)}), output ${n(u.outputTokens)}, cost ${cost}`;
}

function one(s: string, max = 400): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

function findingLine(f: Finding, extra?: string): string {
  return `- **${f.id}** [${f.severity} · ${f.category} · ${f.evidenceType.replace(/_/g, " ")} · raised by the ${f.raiser}] ${one(f.title, 160)} — _${f.status}_${extra ? `\n  ${extra}` : ""}`;
}

/** How a closed point was settled: the last status change says who agreed, and why. */
function settledBy(f: Finding): string {
  const last = f.history.at(-1);
  if (!last) return "";
  const how =
    f.status === "withdrawn"
      ? `Withdrawn by the ${last.actor}`
      : last.actor === f.raiser
        ? `Verified by the ${last.actor}`
        : `Accepted by the ${last.actor}`;
  return `${how}: ${one(last.note, 500)}`;
}

export interface NextStep {
  text: string;
  command?: string;
}

const isUnresolved = (f: Finding) => f.awaiting != null;

const cap = (s: string) => s[0]!.toUpperCase() + s.slice(1);

const ids = (fs: Finding[]) => fs.map((f) => f.id).join(", ");

/**
 * What the user should do after a run, for the terminal summary and report.md.
 * Commands are written to be run from `cwd`.
 */
export function nextSteps(
  state: RunState,
  findings: Finding[],
  dir: string,
  cwd = process.cwd(),
): NextStep[] {
  const q = (p: string) => shellQuote(relativePath(p, cwd));
  const plan = path.join(dir, "plan.md");
  const revised = (state.planVersions.at(-1)?.version ?? 0) > 0;
  const original = state.config.input.kind === "plan" ? state.config.input.planPath : null;
  // Later runs start from the newest plan so finished work is not redone.
  const rerun = (constraints = state.config.constraints) =>
    toCommandLine(
      {
        ...state.config,
        constraints,
        ...(revised || original
          ? { input: { kind: "plan", planPath: revised ? plan : original! } }
          : {}),
      },
      cwd,
    );
  // A run with a plan continues where it stopped, keeping its points.
  const canResume = state.planVersions.length > 0;
  const resume = (extra = "") => `crosscheck resume ${q(dir)}${extra}`;
  const steps: NextStep[] = [];
  const needsUser = findings.filter(Ledger.needsUser);
  const unresolved = findings.filter(isUnresolved);

  switch (state.status) {
    case "error":
      steps.push({
        text: `Fix the problem${state.error?.hint ? " described under Fix" : " in the outcome above"}, then ${canResume ? "resume the run where it stopped" : "run again"}:`,
        command: canResume ? resume() : rerun(),
      });
      break;
    case "cancelled":
    case "running":
      steps.push({
        text: "Resume the run where it stopped:",
        command: canResume ? resume() : rerun(),
      });
      break;
    default:
      if (needsUser.length > 0) {
        const decisions = needsUser.map((f) => `${f.id}: <your decision>`).join("; ");
        steps.push(
          {
            text: `Decide ${ids(needsUser)}: the agents could not settle ${needsUser.length === 1 ? "it" : "them"} without you (see "Decisions needed from you" in report.md).`,
          },
          {
            text: "Run again from the latest plan with your decisions as constraints:",
            command: rerun([state.config.constraints, decisions].filter(Boolean).join(" ")),
          },
        );
      } else if (unresolved.length > 0) {
        steps.push({
          text: `${ids(unresolved)} ${unresolved.length === 1 ? "is" : "are"} still under discussion (see "Points still under discussion" in report.md). Fix ${unresolved.length === 1 ? "it" : "them"} in the plan yourself, or let the agents continue${state.status === "budget_exhausted" ? " (--rounds and --timeout set the new limits)" : ""}:`,
          command: resume(),
        });
      } else if (state.status === "budget_exhausted" || state.status === "stalled") {
        steps.push({
          text: "Every point is settled, but no full review has come back clean since the last material change. Let the agents finish:",
          command: resume(),
        });
      }
      if (state.status !== "review_complete") break;
      if (revised && original) {
        steps.push(
          { text: "Review what changed:", command: `diff -u ${q(original)} ${q(plan)}` },
          {
            text: "If you agree, adopt the revised plan (crosscheck never edits your file):",
            command: `cp ${q(plan)} ${q(original)}`,
          },
        );
      } else if (revised) {
        steps.push({
          text: "Read the drafted plan and save it where you keep plans, for example:",
          command: `cp ${q(plan)} PLAN.md`,
        });
      } else {
        steps.push({ text: "Your plan passed review unchanged; there is nothing to copy." });
      }
  }

  if (state.status !== "error" && state.status !== "cancelled" && state.status !== "running") {
    if (state.assumptions.length > 0)
      steps.push({
        text: `The agents relied on ${state.assumptions.length} untested assumption(s), listed under "Verification and evidence" in report.md. Turn the risky ones into spikes or tests before building on them.${state.config.checks.length === 0 ? " Next time, --check '<command>' lets agents run your tests." : ""}`,
      });
  }
  return steps;
}

export function renderReport(state: RunState, findings: Finding[], dir: string): string {
  const out: string[] = [];
  const latest = state.planVersions.at(-1);
  out.push(`# crosscheck report: ${OUTCOME_TEXT[state.status]}`, "");
  out.push(`**Outcome:** \`${state.status}\`: ${state.reason || "(no reason recorded)"}`, "");
  if (state.error?.hint) out.push(`**Fix:** ${state.error.hint}`, "");
  out.push(
    `- Run: \`${state.id}\` · started ${state.startedAt} · elapsed ${formatDuration(state.elapsedMs)}`,
    `- Rounds: ${state.round} of max ${state.config.maxRounds} (${state.rounds.filter((r) => r.full).length} began with a full review; a round = full review when nothing is under discussion → author's turn → reviewer's check)`,
    `- Repository: \`${state.repo?.root ?? state.config.repo}\`${state.repo?.isGit ? ` · ${state.repo.branch ?? "detached HEAD"} ${state.repo.head ? `@ ${state.repo.head.slice(0, 12)}` : "(no commits yet)"}${state.repo.dirtyPaths ? ` · ${state.repo.dirtyPaths} uncommitted path(s) at start` : ""}` : " · not a git repository"}`,
    ...(state.resumes?.length
      ? [
          `- Resumed ${state.resumes.length} time(s): ${state.resumes.map((r) => `after \`${r.status}\` at ${r.at}`).join("; ")}`,
        ]
      : []),
    `- Author: ${state.agents.author} · Reviewer: ${state.agents.reviewer}`,
    `- Focus: ${state.config.focus.join(", ")}`,
    "",
  );

  const steps = nextSteps(state, findings, dir, state.config.repo);
  if (steps.length > 0) {
    out.push("## Next steps", "", "Commands run from the repository root.", "");
    steps.forEach((step, i) => {
      out.push(`${i + 1}. ${step.text}`);
      if (step.command) out.push("", "   ```sh", `   ${step.command}`, "   ```");
    });
    out.push("");
  }

  out.push("## Files", "");
  if (latest)
    out.push(`- Latest plan (v${latest.version}): \`plan.md\` (all versions in \`plan/\`)`);
  if (state.config.input.kind === "plan")
    out.push(
      `- Original input (unchanged): \`${state.config.input.planPath}\` (copy: \`input/plan.original.md\`)`,
    );
  out.push(
    "- Points ledger: `findings.json` · run state: `run.json`",
    "- Agent transcript: `transcript.jsonl` · tool/phase events: `events.jsonl`",
    "",
  );

  if (state.repoModified) {
    out.push(
      "> **Warning:** the repository working tree changed during this run. crosscheck agents have no write tools, so this was likely an external edit or a permitted verification command; check `git status`.",
      "",
    );
  }

  const needsUser = findings.filter(Ledger.needsUser);
  if (needsUser.length > 0) {
    out.push("## Decisions needed from you", "");
    for (const f of needsUser) {
      out.push(
        findingLine(
          f,
          one(
            f.needsUserDecision ??
              `The agents still disagree. ${cap(f.response?.actor ?? otherRole(f.raiser))}: ${f.response?.response ?? "-"} / ${cap(f.raiser)}: ${f.verification?.reason ?? "-"}`,
            800,
          ),
        ),
      );
    }
    out.push("");
  }

  const unresolved = findings.filter(isUnresolved);
  if (unresolved.length > 0) {
    out.push("## Points still under discussion", "");
    for (const f of unresolved)
      out.push(
        findingLine(
          f,
          `${one(f.problem)} — waiting for the ${f.awaiting}${f.verification ? `; ${f.raiser}: ${one(f.verification.reason, 300)}` : ""}`,
        ),
      );
    out.push("");
  }

  out.push("## What changed", "");
  for (const v of state.planVersions) {
    const stats = v.version === 0 ? "" : ` (+${v.linesAdded} / −${v.linesRemoved} lines)`;
    out.push(
      `- **v${v.version}** by ${v.createdBy}${v.version > 0 ? ` in round ${v.round}` : ""}${stats}: ${one(v.summary, 600)}`,
    );
  }
  if (state.planVersions.length <= 1) out.push("- The plan was not revised.");
  out.push("");
  for (const r of state.rounds) {
    out.push(`### Round ${r.round}${r.full ? " (full review)" : ""}`, "");
    if (r.reviewSummary) out.push(`- Full review: ${one(r.reviewSummary, 800)}`);
    if (r.authorSummary) out.push(`- Author: ${one(r.authorSummary, 800)}`);
    if (r.reviewerSummary) out.push(`- Reviewer's check: ${one(r.reviewerSummary, 800)}`);
    out.push(
      `- Raised: ${r.raised.join(", ") || "none"} · Resolved: ${r.resolved.join(", ") || "none"}`,
      "",
    );
  }

  const resolved = findings.filter((f) => CLOSED_STATUSES.has(f.status));
  if (resolved.length > 0) {
    out.push("## Settled points", "");
    for (const f of resolved) out.push(findingLine(f, settledBy(f)));
    out.push("");
  }

  out.push("## Verification and evidence", "");
  if (state.config.checks.length === 0) {
    out.push(
      "- No verification commands were permitted for this run. Runtime behavior was reasoned about, not tested.",
    );
  } else {
    for (const c of state.checks)
      out.push(
        `- \`${c.command}\` → ${c.passed ? "passed" : `FAILED (exit ${c.exitCode})`} (round ${c.round}, ${c.agent})`,
      );
    const ran = new Set(state.checks.map((c) => c.command));
    const skipped = state.config.checks.filter((c) => !ran.has(c));
    if (skipped.length > 0)
      out.push(`- Permitted but not run (skipped): ${skipped.map((c) => `\`${c}\``).join(", ")}`);
  }
  const byType = (t: Finding["evidenceType"]) =>
    findings.filter((f) => f.evidenceType === t).length;
  out.push(
    `- Points by evidence: ${byType("repository_evidence")} backed by repository evidence, ${byType("hypothetical_risk")} hypothetical risk(s), ${byType("missing_requirement")} missing requirement(s).`,
  );
  if (state.assumptions.length > 0) {
    out.push("", "**Unverified assumptions stated by the agents:**", "");
    for (const a of state.assumptions.slice(0, 40))
      out.push(`- (${a.agent}, round ${a.round}) ${one(a.text, 300)}`);
  }
  for (const role of ["reviewer", "author"] as const) {
    const ex = state.examined[role];
    if (ex.length === 0) continue;
    out.push("", `**Examined by ${state.agents[role]}** (${ex.length}):`, "");
    out.push(
      ex
        .slice(0, 60)
        .map((e) => `\`${e}\``)
        .join(", ") + (ex.length > 60 ? `, … ${ex.length - 60} more` : ""),
    );
  }
  out.push("");

  out.push("## Usage", "");
  out.push(`- ${state.agents.author}: ${formatUsage(state.usage.author)}`);
  out.push(`- ${state.agents.reviewer}: ${formatUsage(state.usage.reviewer)}`);
  out.push(
    "- Token counts are as reported by each harness. Cost is shown only when the runtime reports it (Claude Code reports an API-equivalent estimate; Codex reports none).",
    "",
  );
  return out.join("\n");
}
