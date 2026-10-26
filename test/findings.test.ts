import { describe, expect, test } from "bun:test";
import { Ledger, LedgerError, type NewFindingInput } from "../src/findings.ts";
import { evaluate } from "../src/orchestrator.ts";
import { checkAuthorOutput, checkReviewerOutput } from "../src/schemas.ts";

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
const accept = {
  round: 1,
  action: "accept" as const,
  response: "fixed",
  evidence: "",
  planChange: "hash keys",
};
const verdict = (v: Parameters<Ledger["verify"]>[1]["verdict"], round = 1) => ({
  round,
  verdict: v,
  reason: "r",
  evidence: "e",
});

describe("Ledger", () => {
  test("assigns sequential IDs that never change", () => {
    const l = new Ledger();
    expect(l.raise(1, "codex", input()).finding.id).toBe("F1");
    expect(
      l.raise(
        1,
        "codex",
        input({
          category: "performance",
          title: "N+1 queries",
          problem: "Usage lookups per request",
          location: "plan §Limits",
        }),
      ).finding.id,
    ).toBe("F2");
    const reloaded = new Ledger(l.toJSON());
    expect(
      reloaded.raise(
        2,
        "codex",
        input({
          category: "testing",
          title: "No tests",
          problem: "nothing covers limits",
          location: "plan §Tests",
        }),
      ).finding.id,
    ).toBe("F3");
  });

  test("an author response never closes a finding", () => {
    const l = new Ledger();
    l.raise(1, "codex", input());
    expect(l.respond("F1", accept).status).toBe("addressed");
    expect(l.unresolvedMaterial().map((f) => f.id)).toEqual(["F1"]);
    // Addressed findings await the reviewer; the author cannot respond again to close them.
    expect(() => l.respond("F1", accept)).toThrow(LedgerError);
    expect(evaluate(l, { newMaterial: 0, failedChecks: [] })).toBeNull();
  });

  test("only addressed findings can be verified", () => {
    const l = new Ledger();
    l.raise(1, "codex", input());
    expect(() => l.verify("F1", verdict("verified"))).toThrow(LedgerError);
    l.respond("F1", { ...accept, action: "dispute" });
    expect(() => l.verify("F1", verdict("verified"))).toThrow(LedgerError);
    expect(l.verify("F1", verdict("withdrawn")).status).toBe("withdrawn");
    expect(evaluate(l, { newMaterial: 0, failedChecks: [] })?.outcome).toBe("review_complete");
  });

  test("not_resolved reopens; verified closes", () => {
    const l = new Ledger();
    l.raise(1, "codex", input());
    l.respond("F1", accept);
    expect(l.verify("F1", verdict("not_resolved")).status).toBe("open");
    l.respond("F1", { ...accept, round: 2 });
    expect(l.verify("F1", verdict("verified", 2)).status).toBe("verified");
    expect(l.get("F1")!.history.map((h) => `${h.actor}:${h.to}`)).toEqual([
      "reviewer:open",
      "author:addressed",
      "reviewer:open",
      "author:addressed",
      "reviewer:verified",
    ]);
  });

  test("paraphrased restatements merge; a closed finding that returns is reopened", () => {
    const l = new Ledger();
    l.raise(1, "codex", input());
    const again = l.raise(2, "codex", input({ title: "Keys are stored in plaintext" }));
    expect(again).toMatchObject({ created: false, reopened: false });
    expect(again.finding.id).toBe("F1");
    l.respond("F1", accept);
    l.verify("F1", verdict("verified"));
    const back = l.raise(3, "codex", input({ duplicateOf: "F1", title: "Plaintext keys again" }));
    expect(back).toMatchObject({ created: false, reopened: true });
    expect(l.get("F1")!.status).toBe("open");
    expect(l.list()).toHaveLength(1);
  });

  test("distinct issues are not merged", () => {
    const l = new Ledger();
    l.raise(1, "codex", input());
    const other = l.raise(
      1,
      "codex",
      input({
        title: "Missing rate limit on key creation",
        problem: "Attackers can mint unlimited keys",
        location: "plan §API",
      }),
    );
    expect(other.created).toBe(true);
  });

  test("similar findings at different locations or with different limits retain separate IDs", () => {
    const l = new Ledger();
    l.raise(1, "reviewer", input({ location: "src/admin.ts:4" }));
    expect(l.raise(1, "reviewer", input({ location: "src/users.ts:4" })).created).toBe(true);
    l.raise(
      1,
      "reviewer",
      input({ problem: "The API rejects requests exceeding 1 key per user per hour" }),
    );
    expect(
      l.raise(
        1,
        "reviewer",
        input({ problem: "The API rejects requests exceeding 2 keys per user per hour" }),
      ).created,
    ).toBe(true);
    expect(l.list()).toHaveLength(4);
  });

  test("a material restatement upgrades a low finding instead of permitting success", () => {
    const l = new Ledger();
    l.raise(1, "reviewer", input({ severity: "low" }));
    l.raise(2, "reviewer", input({ severity: "high", evidence: "new evidence" }));
    expect(l.get("F1")!.severity).toBe("high");
    expect(l.get("F1")!.evidence).toContain("new evidence");
    expect(evaluate(l, { newMaterial: 0, failedChecks: [] })).toBeNull();
  });

  test("reopening a closed finding clears stale responses and dispute counters", () => {
    const l = new Ledger();
    l.raise(1, "reviewer", input());
    l.respond("F1", { ...accept, action: "dispute" });
    l.verify("F1", verdict("maintain_dispute"));
    l.verify("F1", verdict("withdrawn"));
    l.raise(3, "reviewer", input({ duplicateOf: "F1" }));
    expect(l.get("F1")).toMatchObject({
      status: "open",
      disputeRounds: 0,
      authorResponse: null,
      verification: null,
    });
  });

  test("disputes needing the user produce needs_input", () => {
    const l = new Ledger();
    l.raise(1, "codex", input());
    l.respond("F1", {
      ...accept,
      action: "needs_user_decision",
      response: "Per-org or per-user keys?",
    });
    expect(Ledger.needsUser(l.get("F1")!)).toBe(true);
    expect(evaluate(l, { newMaterial: 0, failedChecks: [] })?.outcome).toBe("needs_input");
  });

  test("a dispute maintained twice needs the user", () => {
    const l = new Ledger();
    l.raise(1, "codex", input());
    l.respond("F1", { ...accept, action: "dispute" });
    l.verify("F1", verdict("maintain_dispute"));
    expect(evaluate(l, { newMaterial: 0, failedChecks: [] })).toBeNull();
    l.respond("F1", { ...accept, round: 2, action: "dispute" });
    l.verify("F1", verdict("maintain_dispute", 2));
    expect(evaluate(l, { newMaterial: 0, failedChecks: [] })?.outcome).toBe("needs_input");
  });

  test("new material findings block completion even when everything else is closed", () => {
    const l = new Ledger();
    expect(evaluate(l, { newMaterial: 1, failedChecks: [] })).toBeNull();
    expect(evaluate(l, { newMaterial: 0, failedChecks: ["bun test"] })?.outcome).toBe(
      "needs_input",
    );
  });
});

describe("output validation", () => {
  test("reviewer must give a verdict for every finding it was asked to verify", () => {
    const l = new Ledger();
    l.raise(1, "codex", input());
    l.respond("F1", accept);
    const errors = checkReviewerOutput(
      { summary: "", verdicts: [], new_findings: [], assumptions: [] },
      { findings: l.list(), mustVerify: ["F1"], toolCalls: 3, initial: false },
    );
    expect(errors).toEqual(["verdicts: missing a verdict for F1"]);
  });

  test("reviewer cannot reference unknown IDs", () => {
    const errors = checkReviewerOutput(
      {
        summary: "",
        verdicts: [{ id: "F9", verdict: "withdrawn", reason: "", evidence: "" }],
        new_findings: [],
        assumptions: [],
      },
      { findings: [], mustVerify: [], toolCalls: 1, initial: false },
    );
    expect(errors[0]).toContain("unknown finding ID F9");
  });

  test("author must respond to every finding and return a complete plan", () => {
    expect(
      checkAuthorOutput(
        { summary: "", responses: [], revised_plan: null, assumptions: [] },
        { mustRespond: ["F1"], drafting: false },
      ),
    ).toEqual(["responses: missing a response for F1"]);
    expect(
      checkAuthorOutput(
        {
          summary: "",
          responses: [],
          revised_plan: "# Plan\n\n## Storage\n...\n",
          assumptions: [],
        },
        { mustRespond: [], drafting: false },
      )[0],
    ).toContain("elision");
    expect(
      checkAuthorOutput(
        { summary: "", responses: [], revised_plan: null, assumptions: [] },
        { mustRespond: [], drafting: true },
      ),
    ).toEqual(["revised_plan: the initial plan is required"]);
  });

  test("a reviewer cannot close findings without a reason and evidence", () => {
    const l = new Ledger();
    l.raise(1, "reviewer", input());
    l.respond("F1", accept);
    const errors = checkReviewerOutput(
      {
        summary: "",
        verdicts: [{ id: "F1", verdict: "verified", reason: "", evidence: "" }],
        new_findings: [],
        assumptions: [],
      },
      { findings: l.list(), mustVerify: ["F1"], toolCalls: 1, initial: false },
    );
    expect(errors).toContain("verdicts: F1 requires a reason and evidence");
  });
});
