import {
  CLOSED_STATUSES,
  MATERIAL_SEVERITIES,
  type Category,
  type EvidenceType,
  type FindingStatus,
  type Role,
  type Severity,
} from "./types.ts";

/** How the other agent answers a point: agree, disagree, or hand it to the user. */
export type ResponseAction = "accept" | "dispute" | "needs_user_decision";
/** How the agent that raised a point rules on the other agent's answer. */
export type Ruling =
  | "verified"
  | "not_resolved"
  | "withdrawn"
  | "maintain_dispute"
  | "needs_user_decision";

/** Maintained disputes after which a point goes to the user instead of another exchange. */
export const MAX_DISPUTE_ROUNDS = 3;

export const otherRole = (role: Role): Role => (role === "author" ? "reviewer" : "author");

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
  /** ID of an existing point, raised by the same agent, that this restates. */
  duplicateOf: string | null;
}

export interface Response {
  round: number;
  actor: Role;
  action: ResponseAction;
  response: string;
  evidence: string;
  planChange: string;
}

export interface Verification {
  round: number;
  actor: Role;
  verdict: Ruling;
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
  /** Which agent raised the point. Only that agent can close it. */
  raiser: Role;
  /** Label of the agent that raised it, for reports. */
  raisedBy: string;
  raisedInRound: number;
  status: FindingStatus;
  /** Whose move it is; null when the point is closed or waiting for the user. */
  awaiting: Role | null;
  /** Set when resolving this point needs the user's decision; holds the question. */
  needsUserDecision: string | null;
  /** How many times the raiser has maintained the point against a dispute. */
  disputeRounds: number;
  /** The other agent's latest answer. */
  response: Response | null;
  /** The raiser's latest ruling on that answer. */
  verification: Verification | null;
  history: HistoryEntry[];
}

export class LedgerError extends Error {}

/** Which statuses each ruling may be applied from. */
const RULING_FROM: Record<Ruling, ReadonlySet<FindingStatus>> = {
  verified: new Set(["addressed"]),
  not_resolved: new Set(["addressed", "disputed"]),
  withdrawn: new Set(["open", "addressed", "disputed"]),
  // The raiser can also hold its point against an "accept" that only partly agrees.
  maintain_dispute: new Set(["addressed", "disputed"]),
  needs_user_decision: new Set(["addressed", "disputed"]),
};

/**
 * The ledger of points raised by either agent. IDs are assigned here, never by
 * agents. A point closes only with both agents' agreement: the raiser verifies
 * the other agent's fix or withdraws the point. When the author raises a point
 * it has already changed the plan, so the reviewer accepting it closes it.
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

  /** Points waiting for `role` to move. */
  awaiting(role: Role): Finding[] {
    return this.list().filter((f) => f.awaiting === role);
  }

  /** Points still being discussed: not closed and not handed to the user. */
  pending(): Finding[] {
    return this.list().filter((f) => f.awaiting != null);
  }

  /**
   * Record a new point. A restatement of an existing point by the same agent
   * (declared via duplicateOf or matching problem/location) keeps its ID; if
   * that point was closed, it is reopened.
   */
  raise(
    round: number,
    raiser: Role,
    raisedBy: string,
    input: NewFindingInput,
  ): { finding: Finding; created: boolean; reopened: boolean } {
    const declared = input.duplicateOf ? this.#findings.get(input.duplicateOf) : undefined;
    if (input.duplicateOf && declared?.raiser !== raiser)
      throw new LedgerError(
        `${input.duplicateOf} was not raised by the ${raiser}; raise a new point instead of duplicate_of`,
      );
    const existing = declared ?? this.#findSame(raiser, input);
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
        this.#transition(existing, round, raiser, "open", `Re-raised: ${input.problem}`);
        existing.awaiting = otherRole(raiser);
        existing.needsUserDecision = null;
        existing.disputeRounds = 0;
        existing.response = null;
        existing.verification = null;
        return { finding: existing, created: false, reopened: true };
      }
      existing.history.push({
        round,
        actor: raiser,
        from: existing.status,
        to: existing.status,
        note: `Restated (merged, not counted as new): ${input.title}`,
      });
      return { finding: existing, created: false, reopened: false };
    }
    const { duplicateOf: _, ...fields } = input;
    const finding: Finding = {
      ...fields,
      id: `F${this.#findings.size + 1}`,
      raiser,
      raisedBy,
      raisedInRound: round,
      status: "open",
      awaiting: otherRole(raiser),
      needsUserDecision: null,
      disputeRounds: 0,
      response: null,
      verification: null,
      history: [{ round, actor: raiser, from: null, to: "open", note: "Raised" }],
    };
    this.#findings.set(finding.id, finding);
    return { finding, created: true, reopened: false };
  }

  /** Why `actor` may not answer this point, or null when it may. */
  responseProblem(id: string, actor: Role): string | null {
    const f = this.#findings.get(id);
    if (!f) return `unknown point ${id}`;
    if (f.raiser === actor) return `${id} is your own point; rule on it under verdicts instead`;
    if (f.awaiting !== actor)
      return `${id} is ${f.status} and not waiting for your answer${f.awaiting ? ` (it is waiting for the ${f.awaiting})` : ""}`;
    return null;
  }

  /** Why `actor` may not give this ruling, or null when it may. */
  rulingProblem(id: string, actor: Role, verdict: Ruling): string | null {
    const f = this.#findings.get(id);
    if (!f) return `unknown point ${id}`;
    if (f.raiser !== actor)
      return `${id} was raised by the ${f.raiser}; answer it under responses instead`;
    if (CLOSED_STATUSES.has(f.status)) return `${id} is already ${f.status}`;
    // The raiser can drop its own point at any time.
    if (verdict === "withdrawn") return null;
    if (f.awaiting !== actor)
      return `${id} is waiting for the ${f.awaiting ?? "user"}, not for your ruling`;
    if (!RULING_FROM[verdict].has(f.status)) {
      const valid = (Object.keys(RULING_FROM) as Ruling[])
        .filter((r) => RULING_FROM[r].has(f.status))
        .join(", ");
      return verdict === "verified"
        ? `${id} cannot be "verified" because the other agent did not accept it (status ${f.status}); use one of: ${valid}`
        : `${id} is ${f.status}; "${verdict}" does not apply (use one of: ${valid})`;
    }
    return null;
  }

  /** Apply the other agent's answer. Answering never closes a point, except agreeing with the author's own change. */
  respond(id: string, response: Response): Finding {
    const problem = this.responseProblem(id, response.actor);
    if (problem) throw new LedgerError(problem);
    const f = this.#findings.get(id)!;
    f.response = response;
    switch (response.action) {
      case "accept":
        f.needsUserDecision = null;
        f.disputeRounds = 0;
        if (f.raiser === "author") {
          // The author applied its change when raising the point; the reviewer agreeing settles it.
          this.#transition(f, response.round, response.actor, "verified", response.response);
          f.awaiting = null;
        } else {
          this.#transition(f, response.round, response.actor, "addressed", response.response);
          f.awaiting = f.raiser;
        }
        break;
      case "dispute":
        this.#transition(f, response.round, response.actor, "disputed", response.response);
        f.awaiting = f.raiser;
        break;
      case "needs_user_decision":
        f.needsUserDecision = response.response;
        this.#transition(f, response.round, response.actor, "disputed", response.response);
        f.awaiting = null;
        break;
    }
    return f;
  }

  /** Apply the raiser's ruling. Only the raiser can close its point. */
  verify(id: string, v: Verification): Finding {
    const problem = this.rulingProblem(id, v.actor, v.verdict);
    if (problem) throw new LedgerError(problem);
    const f = this.#findings.get(id)!;
    f.verification = v;
    switch (v.verdict) {
      case "verified":
      case "withdrawn":
        f.needsUserDecision = null;
        this.#transition(f, v.round, v.actor, v.verdict, v.reason);
        f.awaiting = null;
        break;
      case "not_resolved":
        f.needsUserDecision = null;
        this.#transition(f, v.round, v.actor, "open", v.reason);
        f.awaiting = otherRole(f.raiser);
        break;
      case "maintain_dispute":
        f.disputeRounds += 1;
        this.#transition(f, v.round, v.actor, "disputed", v.reason);
        if (f.disputeRounds >= MAX_DISPUTE_ROUNDS) {
          f.needsUserDecision ??= `The agents could not agree after ${f.disputeRounds} exchanges.`;
          f.awaiting = null;
        } else f.awaiting = otherRole(f.raiser);
        break;
      case "needs_user_decision":
        f.needsUserDecision ??= v.reason;
        this.#transition(f, v.round, v.actor, "disputed", v.reason);
        f.awaiting = null;
        break;
    }
    return f;
  }

  /** Material (high/medium) points that are not closed. */
  unresolvedMaterial(): Finding[] {
    return this.list().filter(
      (f) => MATERIAL_SEVERITIES.has(f.severity) && !CLOSED_STATUSES.has(f.status),
    );
  }

  /** A point the agents handed to the user: one of them asked, or they could not agree. */
  static needsUser(f: Finding): boolean {
    return !CLOSED_STATUSES.has(f.status) && f.awaiting == null;
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
      .map((f) => `${f.id}:${f.status}:${f.awaiting ?? "-"}:${f.disputeRounds}`)
      .join("|");
  }

  toJSON(): Finding[] {
    return this.list();
  }

  #transition(f: Finding, round: number, actor: Role, to: FindingStatus, note: string) {
    f.history.push({ round, actor, from: f.status, to, note });
    f.status = to;
  }

  #findSame(raiser: Role, input: NewFindingInput): Finding | undefined {
    // Similar wording is not enough: different paths, limits or negations can
    // describe independent bugs. Semantic paraphrases require duplicateOf.
    const normalize = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();
    return this.list().find(
      (f) =>
        f.raiser === raiser &&
        f.category === input.category &&
        normalize(f.location) === normalize(input.location) &&
        normalize(f.problem) === normalize(input.problem),
    );
  }
}
