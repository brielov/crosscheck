import { Ledger, type Finding } from "./findings.ts";
import type { RunState } from "./orchestrator.ts";
import { CLOSED_STATUSES, MATERIAL_SEVERITIES, type Usage } from "./types.ts";

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
  return `- **${f.id}** [${f.severity} · ${f.category} · ${f.evidenceType.replace(/_/g, " ")}] ${one(f.title, 160)} — _${f.status}_${extra ? `\n  ${extra}` : ""}`;
}

export function renderReport(state: RunState, findings: Finding[]): string {
  const out: string[] = [];
  const latest = state.planVersions.at(-1);
  out.push(`# crosscheck report: ${OUTCOME_TEXT[state.status]}`, "");
  out.push(`**Outcome:** \`${state.status}\`: ${state.reason || "(no reason recorded)"}`, "");
  if (state.error?.hint) out.push(`**Fix:** ${state.error.hint}`, "");
  out.push(
    `- Run: \`${state.id}\` · started ${state.startedAt} · elapsed ${formatDuration(state.elapsedMs)}`,
    `- Rounds: ${state.round} of max ${state.config.maxRounds} (a round = reviewer pass → author response/revision → reviewer verification)`,
    `- Repository: \`${state.repo?.root ?? state.config.repo}\`${state.repo?.isGit ? ` · ${state.repo.branch ?? "?"} @ ${state.repo.head?.slice(0, 12) ?? "no commits"}${state.repo.dirtyPaths ? ` · ${state.repo.dirtyPaths} uncommitted path(s) at start` : ""}` : " · not a git repository"}`,
    `- Author: ${state.agents.author} · Reviewer: ${state.agents.reviewer}`,
    `- Focus: ${state.config.focus.join(", ")}`,
    "",
  );

  out.push("## Files", "");
  if (latest)
    out.push(`- Latest plan (v${latest.version}): \`plan.md\` (all versions in \`plan/\`)`);
  if (state.config.input.kind === "plan")
    out.push(
      `- Original input (unchanged): \`${state.config.input.planPath}\` (copy: \`input/plan.original.md\`)`,
    );
  out.push(
    "- Findings ledger: `findings.json` · run state: `run.json`",
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
              `Author and reviewer still disagree. Author: ${f.authorResponse?.response ?? "-"} / Reviewer: ${f.verification?.reason ?? "-"}`,
            800,
          ),
        ),
      );
    }
    out.push("");
  }

  const unresolved = findings.filter(
    (f) =>
      MATERIAL_SEVERITIES.has(f.severity) && !CLOSED_STATUSES.has(f.status) && !Ledger.needsUser(f),
  );
  if (unresolved.length > 0) {
    out.push("## Unresolved material findings", "");
    for (const f of unresolved)
      out.push(
        findingLine(
          f,
          `${one(f.problem)}${f.verification ? ` — reviewer: ${one(f.verification.reason, 300)}` : ""}`,
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
    out.push(`### Round ${r.round}`, "");
    if (r.reviewerSummary) out.push(`- Reviewer: ${one(r.reviewerSummary, 800)}`);
    if (r.authorSummary) out.push(`- Author: ${one(r.authorSummary, 800)}`);
    out.push(
      `- Raised: ${r.raised.join(", ") || "none"} · Resolved: ${r.resolved.join(", ") || "none"}`,
      "",
    );
  }

  const resolved = findings.filter((f) => CLOSED_STATUSES.has(f.status));
  if (resolved.length > 0) {
    out.push("## Resolved findings", "");
    for (const f of resolved) {
      out.push(
        findingLine(
          f,
          `${f.status === "withdrawn" ? "Withdrawn by reviewer" : "Verified by reviewer"}: ${one(f.verification?.reason ?? "", 500)}`,
        ),
      );
    }
    out.push("");
  }

  const lows = findings.filter((f) => f.severity === "low" && !CLOSED_STATUSES.has(f.status));
  if (lows.length > 0) {
    out.push("## Remaining low-severity suggestions", "");
    for (const f of lows) out.push(findingLine(f, one(f.suggestion, 400)));
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
    `- Findings by evidence: ${byType("repository_evidence")} backed by repository evidence, ${byType("hypothetical_risk")} hypothetical risk(s), ${byType("missing_requirement")} missing requirement(s).`,
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
