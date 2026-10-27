import { z } from "zod";
import type { Ledger, NewFindingInput, Ruling } from "./findings.ts";
import { CATEGORIES, type Role } from "./types.ts";

// Every field is required (nullable where optional) so the schemas stay
// compatible with strict structured-output modes.

const responsesSchema = z
  .array(
    z.object({
      id: z.string().describe("ID of a point the OTHER agent raised, e.g. F3"),
      action: z.enum(["accept", "dispute", "needs_user_decision"]),
      response: z
        .string()
        .describe("Your reasoning. For needs_user_decision, the precise question for the user."),
      evidence: z
        .string()
        .describe("Repository paths/lines or plan sections supporting your answer."),
      plan_change: z
        .string()
        .describe("How the plan changed for this point; empty string if it did not."),
    }),
  )
  .describe("One answer for each of the other agent's points you were asked to answer.");

const verdict = <const T extends readonly [Ruling, ...Ruling[]]>(verdicts: T) =>
  z.object({
    id: z.string().describe("ID of a point YOU raised, e.g. F3"),
    verdict: z.enum(verdicts),
    reason: z.string(),
    evidence: z
      .string()
      .describe("What you checked: plan sections, repository paths/lines, commands."),
  });

const newFindingsSchema = z
  .array(
    z.object({
      duplicate_of: z
        .string()
        .nullable()
        .describe(
          "ID of a point YOU raised earlier that this restates (e.g. a closed one that came back); otherwise null.",
        ),
      category: z.enum(CATEGORIES),
      severity: z.enum(["high", "medium", "low"]),
      title: z.string(),
      location: z.string().describe("Plan section and/or repository path:line."),
      problem: z.string().describe("Concrete problem or failure scenario."),
      evidence_type: z.enum(["repository_evidence", "hypothetical_risk", "missing_requirement"]),
      evidence: z.string(),
      assumptions: z.string().describe("Assumptions this point depends on; empty string if none."),
      suggestion: z.string().describe("The correction, or the question that must be answered."),
    }),
  )
  .describe("New points you raise. Never restate an existing point as new.");

const assumptionsSchema = z.array(z.string()).describe("Things you could not verify and assumed.");

export const reviewerOutputSchema = z.object({
  summary: z.string().describe("One-paragraph assessment of the plan as it stands."),
  verdicts: z
    .array(
      verdict(["verified", "not_resolved", "withdrawn", "maintain_dispute", "needs_user_decision"]),
    )
    .describe("One ruling for each of your own points you were asked to rule on."),
  responses: responsesSchema,
  new_findings: newFindingsSchema,
  assumptions: assumptionsSchema,
});
export type ReviewerOutput = z.infer<typeof reviewerOutputSchema>;

export const authorOutputSchema = z.object({
  summary: z.string().describe("What you investigated and changed this turn."),
  responses: responsesSchema,
  verdicts: z
    .array(verdict(["withdrawn", "maintain_dispute", "needs_user_decision"]))
    .describe("One ruling for each of your own points the reviewer disputed."),
  new_findings: newFindingsSchema,
  revised_plan: z
    .string()
    .nullable()
    .describe("The COMPLETE plan in Markdown when it changed this turn; null when unchanged."),
  assumptions: assumptionsSchema,
});
export type AuthorOutput = z.infer<typeof authorOutputSchema>;

type Exchange = Pick<ReviewerOutput, "responses" | "new_findings"> & {
  verdicts: { id: string; verdict: Ruling; reason: string; evidence: string }[];
};

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

/** Checks shared by both agents: every requested answer and ruling, each valid for the point's state. */
function checkExchange(
  out: Exchange,
  ctx: { ledger: Ledger; actor: Role; mustRespond: string[]; mustRule: string[] },
): string[] {
  const errors: string[] = [];
  const seen = new Set<string>();
  const once = (field: string, id: string) => {
    if (seen.has(id)) errors.push(`${field}: ${id} appears more than once`);
    seen.add(id);
  };
  for (const r of out.responses) {
    const problem = ctx.ledger.responseProblem(r.id, ctx.actor);
    if (problem) errors.push(`responses: ${problem}`);
    once("responses", r.id);
    if (!r.response.trim()) errors.push(`responses: ${r.id} has an empty response`);
  }
  for (const v of out.verdicts) {
    const problem = ctx.ledger.rulingProblem(v.id, ctx.actor, v.verdict);
    if (problem) errors.push(`verdicts: ${problem}`);
    once("verdicts", v.id);
    if (!v.reason.trim() || !v.evidence.trim())
      errors.push(`verdicts: ${v.id} requires a reason and evidence`);
  }
  for (const id of ctx.mustRespond)
    if (!out.responses.some((r) => r.id === id))
      errors.push(`responses: missing an answer for ${id}`);
  for (const id of ctx.mustRule)
    if (!out.verdicts.some((v) => v.id === id)) errors.push(`verdicts: missing a ruling for ${id}`);
  for (const [i, f] of out.new_findings.entries()) {
    if (f.duplicate_of) {
      const prior = ctx.ledger.get(f.duplicate_of);
      if (!prior) errors.push(`new_findings[${i}].duplicate_of: unknown ID ${f.duplicate_of}`);
      else if (prior.raiser !== ctx.actor)
        errors.push(
          `new_findings[${i}].duplicate_of: ${f.duplicate_of} was raised by the ${prior.raiser}, not you; answer it or raise a separate point`,
        );
    }
    if (
      !f.title.trim() ||
      !f.problem.trim() ||
      !f.location.trim() ||
      !f.suggestion.trim() ||
      !f.evidence.trim()
    )
      errors.push(
        `new_findings[${i}]: title, problem, location, evidence and suggestion must be non-empty`,
      );
  }
  return errors;
}

/** Semantic checks beyond the schema. Returns human-readable problems; empty means valid. */
export function checkReviewerOutput(
  out: ReviewerOutput,
  ctx: {
    ledger: Ledger;
    mustRespond: string[];
    mustRule: string[];
    toolCalls: number;
    /** A full review must investigate the repository before reporting. */
    requireInspection: boolean;
  },
): string[] {
  const errors: string[] = [];
  if (ctx.requireInspection && ctx.toolCalls === 0) {
    errors.push(
      "You did not inspect the repository. Use the repository tools to check the plan against the actual code before reporting.",
    );
  }
  return [...errors, ...checkExchange(out, { ...ctx, actor: "reviewer" })];
}

export function checkAuthorOutput(
  out: AuthorOutput,
  ctx: { ledger: Ledger; mustRespond: string[]; mustRule: string[]; drafting: boolean },
): string[] {
  const errors = checkExchange(out, { ...ctx, actor: "author" });
  if (ctx.drafting && !out.revised_plan?.trim())
    errors.push("revised_plan: the initial plan is required");
  if (out.revised_plan != null) {
    if (!out.revised_plan.trim())
      errors.push("revised_plan: use null for an unchanged plan, not an empty string");
    else if (ELISION.test(out.revised_plan))
      errors.push("revised_plan: contains an elision placeholder; return the complete plan text");
  }
  if (ctx.drafting && out.new_findings.length > 0)
    errors.push("new_findings: leave empty while drafting; the plan itself is your proposal");
  if (!ctx.drafting && out.new_findings.length > 0 && out.revised_plan == null)
    errors.push(
      "new_findings: apply the changes your own points propose and return the revised plan",
    );
  return errors;
}
