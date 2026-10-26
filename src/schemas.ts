import { z } from "zod";
import type { Finding, NewFindingInput } from "./findings.ts";
import { CATEGORIES, CLOSED_STATUSES } from "./types.ts";

// Every field is required (nullable where optional) so the schemas stay
// compatible with strict structured-output modes.

export const reviewerOutputSchema = z.object({
  summary: z.string().describe("One-paragraph assessment of the plan as it stands."),
  verdicts: z
    .array(
      z.object({
        id: z.string().describe("Existing finding ID, e.g. F3"),
        verdict: z.enum([
          "verified",
          "not_resolved",
          "withdrawn",
          "maintain_dispute",
          "needs_user_decision",
        ]),
        reason: z.string(),
        evidence: z
          .string()
          .describe("What you checked: plan sections, repository paths/lines, commands."),
      }),
    )
    .describe("One verdict per finding you were asked to verify. Empty on the initial review."),
  new_findings: z.array(
    z.object({
      duplicate_of: z
        .string()
        .nullable()
        .describe(
          "ID of an existing finding this restates (e.g. a closed one that came back); otherwise null.",
        ),
      category: z.enum(CATEGORIES),
      severity: z.enum(["high", "medium", "low"]),
      title: z.string(),
      location: z.string().describe("Plan section and/or repository path:line."),
      problem: z.string().describe("Concrete problem or failure scenario."),
      evidence_type: z.enum(["repository_evidence", "hypothetical_risk", "missing_requirement"]),
      evidence: z.string(),
      assumptions: z
        .string()
        .describe("Assumptions this finding depends on; empty string if none."),
      suggestion: z
        .string()
        .describe("Suggested correction, or the question that must be answered."),
    }),
  ),
  assumptions: z.array(z.string()).describe("Things you could not verify and assumed."),
});
export type ReviewerOutput = z.infer<typeof reviewerOutputSchema>;

export const authorOutputSchema = z.object({
  summary: z.string().describe("What you investigated and changed this turn."),
  responses: z.array(
    z.object({
      id: z.string(),
      action: z.enum(["accept", "dispute", "needs_user_decision"]),
      response: z
        .string()
        .describe("Your reasoning. For needs_user_decision, the precise question for the user."),
      evidence: z
        .string()
        .describe("Repository paths/lines or plan sections supporting your response."),
      plan_change: z
        .string()
        .describe("How the plan changed for this finding; empty string if it did not."),
    }),
  ),
  revised_plan: z
    .string()
    .nullable()
    .describe("The COMPLETE plan in Markdown when it changed this turn; null when unchanged."),
  assumptions: z.array(z.string()).describe("Things you could not verify and assumed."),
});
export type AuthorOutput = z.infer<typeof authorOutputSchema>;

export function toNewFinding(f: ReviewerOutput["new_findings"][number]): NewFindingInput {
  return {
    duplicateOf: f.duplicate_of,
    category: f.category,
    severity: f.severity,
    title: f.title,
    location: f.location,
    problem: f.problem,
    evidenceType: f.evidence_type,
    evidence: f.evidence,
    assumptions: f.assumptions,
    suggestion: f.suggestion,
  };
}

const ELISION =
  /^\s*(?:\.\.\.|…|\[(?:rest|remainder|unchanged|same)[^\]]*\]|\((?:unchanged|rest unchanged|same as before)\))\s*$/im;

/** Semantic checks beyond the schema. Returns human-readable problems; empty means valid. */
export function checkReviewerOutput(
  out: ReviewerOutput,
  ctx: { findings: Finding[]; mustVerify: string[]; toolCalls: number; initial: boolean },
): string[] {
  const errors: string[] = [];
  const byId = new Map(ctx.findings.map((f) => [f.id, f]));
  if (ctx.initial && ctx.toolCalls === 0) {
    errors.push(
      "You did not inspect the repository. Use the repository tools to check the plan against the actual code before reporting.",
    );
  }
  const seen = new Set<string>();
  for (const v of out.verdicts) {
    const f = byId.get(v.id);
    if (!f) errors.push(`verdicts: unknown finding ID ${v.id}`);
    else if (CLOSED_STATUSES.has(f.status)) errors.push(`verdicts: ${v.id} is already ${f.status}`);
    else if (v.verdict === "verified" && f.status !== "addressed")
      errors.push(
        `verdicts: ${v.id} cannot be "verified" because the author did not mark it addressed (status ${f.status}); use withdrawn, not_resolved, maintain_dispute or needs_user_decision`,
      );
    else if (v.verdict === "maintain_dispute" && f.status !== "disputed")
      errors.push(
        `verdicts: ${v.id} is not disputed; use not_resolved instead of maintain_dispute`,
      );
    if (seen.has(v.id)) errors.push(`verdicts: ${v.id} appears more than once`);
    seen.add(v.id);
  }
  for (const id of ctx.mustVerify) {
    if (!seen.has(id)) errors.push(`verdicts: missing a verdict for ${id}`);
  }
  for (const [i, f] of out.new_findings.entries()) {
    if (f.duplicate_of && !byId.has(f.duplicate_of))
      errors.push(`new_findings[${i}].duplicate_of: unknown ID ${f.duplicate_of}`);
    if (!f.problem.trim() || !f.location.trim() || !f.suggestion.trim())
      errors.push(`new_findings[${i}]: problem, location and suggestion must be non-empty`);
  }
  return errors;
}

export function checkAuthorOutput(
  out: AuthorOutput,
  ctx: { mustRespond: string[]; drafting: boolean },
): string[] {
  const errors: string[] = [];
  const expected = new Set(ctx.mustRespond);
  const seen = new Set<string>();
  for (const r of out.responses) {
    if (!expected.has(r.id))
      errors.push(`responses: ${r.id} was not one of the findings you were asked to respond to`);
    if (seen.has(r.id)) errors.push(`responses: ${r.id} appears more than once`);
    seen.add(r.id);
    if (!r.response.trim()) errors.push(`responses: ${r.id} has an empty response`);
  }
  for (const id of ctx.mustRespond)
    if (!seen.has(id)) errors.push(`responses: missing a response for ${id}`);
  if (ctx.drafting && !out.revised_plan?.trim())
    errors.push("revised_plan: the initial plan is required");
  if (out.revised_plan != null) {
    if (!out.revised_plan.trim())
      errors.push("revised_plan: use null for an unchanged plan, not an empty string");
    else if (ELISION.test(out.revised_plan))
      errors.push("revised_plan: contains an elision placeholder; return the complete plan text");
  }
  return errors;
}
