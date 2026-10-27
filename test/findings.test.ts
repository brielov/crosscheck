import { describe, expect, test } from "bun:test";
import { trailingJson } from "../src/agents/backend.ts";
import {
  Ledger,
  LedgerError,
  MAX_DISPUTE_ROUNDS,
  type NewFindingInput,
  type Response,
  type Ruling,
} from "../src/findings.ts";
import { evaluate } from "../src/orchestrator.ts";
import { checkAuthorOutput, checkReviewerOutput } from "../src/schemas.ts";
import type { Role } from "../src/types.ts";

const input = (over: Partial<NewFindingInput> = {}): NewFindingInput => ({
  category: "security",
  severity: "high",
  title: "Keys stored in plaintext",
  location: "plan §Storage",
  problem: "API keys are stored unhashed in the keys table",
  evidenceType: "hypothetical_risk",
  evidence: "plan §Storage",
  assumptions: "",
  suggestion: "Store a hash",
  duplicateOf: null,
  ...over,
});
const answer = (
  actor: Role,
  action: Response["action"] = "accept",
  round = 1,
  response = "fixed",
): Response => ({ round, actor, action, response, evidence: "", planChange: "hash keys" });
const rule = (actor: Role, verdict: Ruling, round = 1) => ({
  round,
  actor,
  verdict,
  reason: "r",
  evidence: "e",
});
const raise = (l: Ledger, over: Partial<NewFindingInput> = {}, raiser: Role = "reviewer") =>
  l.raise(1, raiser, raiser, input(over));
const clean = { cleanReview: true, failedChecks: [] };

describe("Ledger", () => {
  test("assigns sequential IDs that never change", () => {
    const l = new Ledger();
    expect(raise(l).finding.id).toBe("F1");
    expect(
      raise(l, { title: "N+1 queries", problem: "Lookups per request", location: "§Limits" })
        .finding.id,
    ).toBe("F2");
    const reloaded = new Ledger(l.toJSON());
    expect(
      raise(reloaded, { title: "No tests", problem: "nothing", location: "§Tests" }).finding.id,
    ).toBe("F3");
  });

  test("an author answer never closes a reviewer's point", () => {
    const l = new Ledger();
    raise(l);
    expect(l.respond("F1", answer("author")).status).toBe("addressed");
    expect(l.get("F1")!.awaiting).toBe("reviewer");
    // Addressed points wait for the reviewer; the author cannot answer again or rule on them.
    expect(() => l.respond("F1", answer("author"))).toThrow(LedgerError);
    expect(() => l.verify("F1", rule("author", "verified"))).toThrow(LedgerError);
    expect(evaluate(l, clean)).toBeNull();
  });

  test("only the raiser rules, and only accepted points can be verified", () => {
    const l = new Ledger();
    raise(l);
    expect(() => l.verify("F1", rule("reviewer", "verified"))).toThrow(LedgerError);
    l.respond("F1", answer("author", "dispute"));
    expect(() => l.verify("F1", rule("reviewer", "verified"))).toThrow(LedgerError);
    expect(l.verify("F1", rule("reviewer", "withdrawn")).status).toBe("withdrawn");
    expect(evaluate(l, clean)?.outcome).toBe("review_complete");
  });

  test("not_resolved hands the point back; verified closes it", () => {
    const l = new Ledger();
    raise(l);
    l.respond("F1", answer("author"));
    expect(l.verify("F1", rule("reviewer", "not_resolved")).status).toBe("open");
    l.respond("F1", answer("author", "accept", 2));
    expect(l.verify("F1", rule("reviewer", "verified", 2)).status).toBe("verified");
    expect(l.get("F1")!.history.map((h) => `${h.actor}:${h.to}`)).toEqual([
      "reviewer:open",
      "author:addressed",
      "reviewer:open",
      "author:addressed",
      "reviewer:verified",
    ]);
  });

  test("the raiser can hold its point against an accept that only partly agrees", () => {
    const l = new Ledger();
    raise(l);
    l.respond("F1", answer("author", "accept", 1, "Accepted in part; the rest is overkill"));
    const f = l.verify("F1", rule("reviewer", "maintain_dispute"));
    expect(f).toMatchObject({ status: "disputed", awaiting: "author", disputeRounds: 1 });
  });

  test("a ruling that does not fit names the ones that do", () => {
    const l = new Ledger();
    raise(l);
    l.respond("F1", answer("author", "dispute"));
    expect(l.rulingProblem("F1", "reviewer", "verified")).toContain(
      "use one of: not_resolved, withdrawn, maintain_dispute, needs_user_decision",
    );
  });

  test("the author's own point closes when the reviewer accepts the change", () => {
    const l = new Ledger();
    const { finding } = raise(l, {}, "author");
    expect(finding).toMatchObject({ raiser: "author", awaiting: "reviewer" });
    expect(() => l.respond("F1", answer("author"))).toThrow(LedgerError);
    expect(l.respond("F1", answer("reviewer")).status).toBe("verified");
    expect(evaluate(l, clean)?.outcome).toBe("review_complete");
  });

  test("a disputed author point goes back to the author, who can withdraw it", () => {
    const l = new Ledger();
    raise(l, {}, "author");
    l.respond("F1", answer("reviewer", "dispute"));
    expect(l.get("F1")!.awaiting).toBe("author");
    expect(l.verify("F1", rule("author", "maintain_dispute")).awaiting).toBe("reviewer");
    l.respond("F1", answer("reviewer", "dispute", 2));
    expect(l.verify("F1", rule("author", "withdrawn", 2)).status).toBe("withdrawn");
  });

  test("paraphrased restatements merge; a closed point that returns is reopened", () => {
    const l = new Ledger();
    raise(l);
    const again = l.raise(2, "reviewer", "r", input({ title: "Keys are stored in plaintext" }));
    expect(again).toMatchObject({ created: false, reopened: false });
    expect(again.finding.id).toBe("F1");
    l.respond("F1", answer("author"));
    l.verify("F1", rule("reviewer", "verified"));
    const back = l.raise(
      3,
      "reviewer",
      "r",
      input({ duplicateOf: "F1", title: "Plaintext again" }),
    );
    expect(back).toMatchObject({ created: false, reopened: true });
    expect(l.get("F1")).toMatchObject({ status: "open", awaiting: "author" });
    expect(l.list()).toHaveLength(1);
  });

  test("an agent cannot restate the other agent's point as its own", () => {
    const l = new Ledger();
    raise(l);
    expect(() => l.raise(1, "author", "a", input({ duplicateOf: "F1" }))).toThrow(LedgerError);
    // The same wording from the other agent is a separate point, not a merge.
    expect(l.raise(1, "author", "a", input()).created).toBe(true);
  });

  test("similar points at different locations or with different limits keep separate IDs", () => {
    const l = new Ledger();
    raise(l, { location: "src/admin.ts:4" });
    expect(raise(l, { location: "src/users.ts:4" }).created).toBe(true);
    raise(l, { problem: "The API rejects requests exceeding 1 key per user per hour" });
    expect(
      raise(l, { problem: "The API rejects requests exceeding 2 keys per user per hour" }).created,
    ).toBe(true);
    expect(l.list()).toHaveLength(4);
  });

  test("a material restatement upgrades a low point", () => {
    const l = new Ledger();
    raise(l, { severity: "low" });
    raise(l, { severity: "high", evidence: "new evidence" });
    expect(l.get("F1")!.severity).toBe("high");
    expect(l.get("F1")!.evidence).toContain("new evidence");
  });

  test("reopening a closed point clears stale answers and dispute counters", () => {
    const l = new Ledger();
    raise(l);
    l.respond("F1", answer("author", "dispute"));
    l.verify("F1", rule("reviewer", "maintain_dispute"));
    l.verify("F1", rule("reviewer", "withdrawn"));
    l.raise(3, "reviewer", "r", input({ duplicateOf: "F1" }));
    expect(l.get("F1")).toMatchObject({
      status: "open",
      disputeRounds: 0,
      response: null,
      verification: null,
    });
  });

  test("low-severity points must be settled too", () => {
    const l = new Ledger();
    raise(l, { severity: "low" });
    expect(evaluate(l, clean)).toBeNull();
  });

  test("a point needing the user ends in needs_input only after a clean full review", () => {
    const l = new Ledger();
    raise(l);
    l.respond("F1", answer("author", "needs_user_decision", 1, "Per-org or per-user keys?"));
    expect(Ledger.needsUser(l.get("F1")!)).toBe(true);
    expect(l.pending()).toHaveLength(0);
    expect(evaluate(l, { cleanReview: false, failedChecks: [] })).toBeNull();
    expect(evaluate(l, clean)?.outcome).toBe("needs_input");
  });

  test(`a dispute maintained ${MAX_DISPUTE_ROUNDS} times goes to the user`, () => {
    const l = new Ledger();
    raise(l);
    for (let round = 1; round <= MAX_DISPUTE_ROUNDS; round++) {
      expect(l.get("F1")!.awaiting).toBe("author");
      l.respond("F1", answer("author", "dispute", round));
      l.verify("F1", rule("reviewer", "maintain_dispute", round));
    }
    expect(Ledger.needsUser(l.get("F1")!)).toBe(true);
    expect(evaluate(l, clean)?.outcome).toBe("needs_input");
  });

  test("completion needs a clean full review and passing checks", () => {
    const l = new Ledger();
    expect(evaluate(l, { cleanReview: false, failedChecks: [] })).toBeNull();
    expect(evaluate(l, { cleanReview: true, failedChecks: ["bun test"] })?.outcome).toBe(
      "needs_input",
    );
  });
});

describe("structured output recovery", () => {
  test("takes the JSON object a response ends with, skipping braces in the prose", () => {
    const text =
      'I checked `{ a: 1 }` and the config.\n```json\n{"summary": "ok", "items": [{"x": 1}]}\n```\n';
    expect(trailingJson(text)).toEqual({ summary: "ok", items: [{ x: 1 }] });
  });

  test("returns nothing when no complete object is present", () => {
    expect(trailingJson("No JSON here.")).toBeUndefined();
    expect(trailingJson('{"summary": "cut off')).toBeUndefined();
    expect(trailingJson("[1, 2, 3]")).toBeUndefined();
  });
});

describe("output validation", () => {
  const empty = { summary: "", verdicts: [], responses: [], new_findings: [], assumptions: [] };

  test("the reviewer must rule on every point it was asked about", () => {
    const l = new Ledger();
    raise(l);
    l.respond("F1", answer("author"));
    const errors = checkReviewerOutput(empty, {
      ledger: l,
      mustRespond: [],
      mustRule: ["F1"],
      toolCalls: 3,
      requireInspection: false,
    });
    expect(errors).toEqual(["verdicts: missing a ruling for F1"]);
  });

  test("the reviewer must answer the author's points and cannot rule on them", () => {
    const l = new Ledger();
    raise(l, {}, "author");
    const errors = checkReviewerOutput(
      { ...empty, verdicts: [{ id: "F1", verdict: "verified", reason: "ok", evidence: "e" }] },
      { ledger: l, mustRespond: ["F1"], mustRule: [], toolCalls: 1, requireInspection: false },
    );
    expect(errors).toContain(
      "verdicts: F1 was raised by the author; answer it under responses instead",
    );
    expect(errors).toContain("responses: missing an answer for F1");
  });

  test("unknown IDs are rejected", () => {
    const errors = checkReviewerOutput(
      { ...empty, verdicts: [{ id: "F9", verdict: "withdrawn", reason: "", evidence: "" }] },
      {
        ledger: new Ledger(),
        mustRespond: [],
        mustRule: [],
        toolCalls: 1,
        requireInspection: false,
      },
    );
    expect(errors[0]).toContain("unknown point F9");
  });

  test("the author must answer every point and return a complete plan", () => {
    const l = new Ledger();
    raise(l);
    const author = { ...empty, revised_plan: null as string | null };
    const ctx = { ledger: l, mustRespond: ["F1"], mustRule: [], drafting: false };
    expect(checkAuthorOutput(author, ctx)).toEqual(["responses: missing an answer for F1"]);
    expect(
      checkAuthorOutput(
        { ...author, revised_plan: "# Plan\n\n## Storage\n...\n" },
        { ...ctx, mustRespond: [] },
      )[0],
    ).toContain("elision");
    expect(checkAuthorOutput(author, { ...ctx, mustRespond: [], drafting: true })).toEqual([
      "revised_plan: the initial plan is required",
    ]);
  });

  test("the author's own points must come with the plan change", () => {
    const point = {
      duplicate_of: null,
      category: "architecture" as const,
      severity: "medium" as const,
      title: "Drop the cache",
      location: "§Cache",
      problem: "Not needed at this scale",
      evidence_type: "missing_requirement" as const,
      evidence: "constraints",
      assumptions: "",
      suggestion: "Remove it",
    };
    expect(
      checkAuthorOutput(
        { ...empty, new_findings: [point], revised_plan: null },
        { ledger: new Ledger(), mustRespond: [], mustRule: [], drafting: false },
      ),
    ).toEqual([
      "new_findings: apply the changes your own points propose and return the revised plan",
    ]);
  });

  test("closing a point needs a reason and evidence", () => {
    const l = new Ledger();
    raise(l);
    l.respond("F1", answer("author"));
    const errors = checkReviewerOutput(
      { ...empty, verdicts: [{ id: "F1", verdict: "verified", reason: "", evidence: "" }] },
      { ledger: l, mustRespond: [], mustRule: ["F1"], toolCalls: 1, requireInspection: false },
    );
    expect(errors).toContain("verdicts: F1 requires a reason and evidence");
  });
});
