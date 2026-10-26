import {
  CLOSED_STATUSES,
  MATERIAL_SEVERITIES,
  type Category,
  type EvidenceType,
  type FindingStatus,
  type Role,
  type Severity,
} from "./types.ts";

export type AuthorAction = "accept" | "dispute" | "needs_user_decision";
export type ReviewerVerdict =
  | "verified"
  | "not_resolved"
  | "withdrawn"
  | "maintain_dispute"
  | "needs_user_decision";

export interface NewFindingInput {
  category: Category;
  severity: Severity;
  title: string;
  location: string;
  problem: string;
  evidenceType: EvidenceType;
  evidence: string;
  assumptions: string;
  suggestion: string;
  /** Reviewer-declared ID of an existing finding this restates. */
  duplicateOf: string | null;
}

export interface AuthorResponse {
  round: number;
  action: AuthorAction;
  response: string;
  evidence: string;
  planChange: string;
}

export interface Verification {
  round: number;
  verdict: ReviewerVerdict;
  reason: string;
  evidence: string;
}

export interface HistoryEntry {
  round: number;
  actor: Role;
  from: FindingStatus | null;
  to: FindingStatus;
  note: string;
}

export interface Finding extends Omit<NewFindingInput, "duplicateOf"> {
  id: string;
  raisedBy: string;
  raisedInRound: number;
  status: FindingStatus;
  /** Set when resolving this finding needs the user's decision; holds the question. */
  needsUserDecision: string | null;
  /** Number of verification passes in which the reviewer maintained the finding against an author dispute. */
  disputeRounds: number;
  authorResponse: AuthorResponse | null;
  verification: Verification | null;
  history: HistoryEntry[];
}

export class LedgerError extends Error {}

/** Which statuses each reviewer verdict may be applied from. */
const VERDICT_FROM: Record<ReviewerVerdict, ReadonlySet<FindingStatus>> = {
  verified: new Set(["addressed"]),
  not_resolved: new Set(["addressed", "disputed", "open"]),
  withdrawn: new Set(["open", "addressed", "disputed"]),
  maintain_dispute: new Set(["disputed"]),
  needs_user_decision: new Set(["open", "addressed", "disputed"]),
};

/**
 * The findings ledger. IDs are assigned here, never by agents, and status
 * changes are gated by actor: only the reviewer can close a finding.
 */
export class Ledger {
  readonly #findings = new Map<string, Finding>();

  constructor(findings: Finding[] = []) {
    for (const f of findings) this.#findings.set(f.id, structuredClone(f));
  }

  list(): Finding[] {
    return [...this.#findings.values()];
  }

  get(id: string): Finding | undefined {
    return this.#findings.get(id);
  }

  has(id: string): boolean {
    return this.#findings.has(id);
  }

  /**
   * Record a reviewer finding. A restatement of an existing finding (declared
   * via duplicateOf or matching problem/location) does not create a new ID;
   * if the existing finding was closed, it is reopened.
   */
  raise(
    round: number,
    raisedBy: string,
    input: NewFindingInput,
  ): { finding: Finding; created: boolean; reopened: boolean } {
    const existing =
      (input.duplicateOf ? this.#findings.get(input.duplicateOf) : undefined) ??
      this.#findSame(input);
    if (existing) {
      const rank = { low: 0, medium: 1, high: 2 };
      if (rank[input.severity] > rank[existing.severity]) existing.severity = input.severity;
      existing.problem = input.problem;
      existing.location = input.location;
      existing.evidence = input.evidence;
      existing.evidenceType = input.evidenceType;
      existing.assumptions = input.assumptions;
      existing.suggestion = input.suggestion;
      if (CLOSED_STATUSES.has(existing.status)) {
        this.#transition(existing, round, "reviewer", "open", `Re-raised: ${input.problem}`);
        existing.needsUserDecision = null;
        existing.disputeRounds = 0;
        existing.authorResponse = null;
        existing.verification = null;
        return { finding: existing, created: false, reopened: true };
      } else {
        existing.history.push({
          round,
          actor: "reviewer",
          from: existing.status,
          to: existing.status,
          note: `Restated (merged, not counted as new): ${input.title}`,
        });
      }
      return { finding: existing, created: false, reopened: false };
    }
    const { duplicateOf: _, ...fields } = input;
    const finding: Finding = {
      ...fields,
      id: `F${this.#findings.size + 1}`,
      raisedBy,
      raisedInRound: round,
      status: "open",
      needsUserDecision: null,
      disputeRounds: 0,
      authorResponse: null,
      verification: null,
      history: [{ round, actor: "reviewer", from: null, to: "open", note: "Raised" }],
    };
    this.#findings.set(finding.id, finding);
    return { finding, created: true, reopened: false };
  }

  /** Apply an author response. The author can never close a finding. */
  respond(id: string, response: AuthorResponse): Finding {
    const f = this.#require(id);
    if (f.status !== "open" && f.status !== "disputed") {
      throw new LedgerError(
        `${id} is ${f.status}; the author can only respond to open or disputed findings`,
      );
    }
    f.authorResponse = response;
    if (response.action === "accept") {
      f.needsUserDecision = null;
      f.disputeRounds = 0;
      this.#transition(f, response.round, "author", "addressed", response.response);
    } else {
      if (response.action === "needs_user_decision") f.needsUserDecision = response.response;
      this.#transition(f, response.round, "author", "disputed", response.response);
    }
    return f;
  }

  /** Apply a reviewer verdict. Only the reviewer can verify or withdraw. */
  verify(id: string, v: Verification): Finding {
    const f = this.#require(id);
    if (!VERDICT_FROM[v.verdict].has(f.status)) {
      throw new LedgerError(
        `${id} is ${f.status}; verdict "${v.verdict}" is not valid for that status`,
      );
    }
    f.verification = v;
    switch (v.verdict) {
      case "verified":
        f.needsUserDecision = null;
        this.#transition(f, v.round, "reviewer", "verified", v.reason);
        break;
      case "withdrawn":
        f.needsUserDecision = null;
        this.#transition(f, v.round, "reviewer", "withdrawn", v.reason);
        break;
      case "not_resolved":
        f.needsUserDecision = null;
        this.#transition(f, v.round, "reviewer", "open", v.reason);
        break;
      case "maintain_dispute":
        f.disputeRounds += 1;
        this.#transition(f, v.round, "reviewer", "disputed", v.reason);
        break;
      case "needs_user_decision":
        f.needsUserDecision = f.needsUserDecision ?? v.reason;
        this.#transition(f, v.round, "reviewer", "disputed", v.reason);
        break;
    }
    return f;
  }

  /** Material (high/medium) findings that are not closed. */
  unresolvedMaterial(): Finding[] {
    return this.list().filter(
      (f) => MATERIAL_SEVERITIES.has(f.severity) && !CLOSED_STATUSES.has(f.status),
    );
  }

  /**
   * A dispute the agents cannot settle themselves: one side asked for the
   * user's decision, or the reviewer has maintained it against the author twice.
   */
  static needsUser(f: Finding): boolean {
    return f.status === "disputed" && (f.needsUserDecision != null || f.disputeRounds >= 2);
  }

  counts(): Record<FindingStatus, number> {
    const c: Record<FindingStatus, number> = {
      open: 0,
      addressed: 0,
      verified: 0,
      withdrawn: 0,
      disputed: 0,
    };
    for (const f of this.#findings.values()) c[f.status] += 1;
    return c;
  }

  /** Stable summary of statuses, used for stall detection. */
  fingerprint(): string {
    return this.list()
      .map((f) => `${f.id}:${f.status}:${f.needsUserDecision ? "u" : ""}`)
      .join("|");
  }

  toJSON(): Finding[] {
    return this.list();
  }

  #require(id: string): Finding {
    const f = this.#findings.get(id);
    if (!f) throw new LedgerError(`Unknown finding ID ${id}`);
    return f;
  }

  #transition(f: Finding, round: number, actor: Role, to: FindingStatus, note: string) {
    f.history.push({ round, actor, from: f.status, to, note });
    f.status = to;
  }

  #findSame(input: NewFindingInput): Finding | undefined {
    // Similar wording is not enough: different paths, limits or negations can
    // describe independent bugs. Semantic paraphrases require duplicateOf.
    const normalize = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();
    return this.list().find(
      (f) =>
        f.category === input.category &&
        normalize(f.location) === normalize(input.location) &&
        normalize(f.problem) === normalize(input.problem),
    );
  }
}
