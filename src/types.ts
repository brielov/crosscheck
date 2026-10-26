export const FOCUS_AREAS = [
  "architecture",
  "security",
  "performance",
  "correctness",
  "testing",
  "maintainability",
] as const;
export type FocusArea = (typeof FOCUS_AREAS)[number];

export const CATEGORIES = [...FOCUS_AREAS, "requirements"] as const;
export type Category = (typeof CATEGORIES)[number];

export type Severity = "high" | "medium" | "low";
export const MATERIAL_SEVERITIES: ReadonlySet<Severity> = new Set(["high", "medium"]);

/** How a finding is supported: by repository evidence, by reasoning alone, or by a gap in the stated requirements. */
export type EvidenceType = "repository_evidence" | "hypothetical_risk" | "missing_requirement";

export type FindingStatus = "open" | "addressed" | "verified" | "withdrawn" | "disputed";
export const CLOSED_STATUSES: ReadonlySet<FindingStatus> = new Set(["verified", "withdrawn"]);

export type Role = "author" | "reviewer";
export type Provider = "claude-code" | "codex";

export const EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;
export type Effort = (typeof EFFORT_LEVELS)[number];

export interface AgentConfig {
  provider: Provider;
  /** Harness-specific model id. Undefined means the provider's default. */
  model?: string;
  /** Reasoning effort. Undefined means the runtime's default (for Codex, your config.toml). */
  effort?: Effort;
}

export type InputSpec = { kind: "plan"; planPath: string } | { kind: "brief"; brief: string };

export interface RunConfig {
  input: InputSpec;
  repo: string;
  focus: FocusArea[];
  constraints: string;
  maxRounds: number;
  timeoutMs: number;
  author: AgentConfig;
  reviewer: AgentConfig;
  /** Exact shell commands agents may run as verification checks. Empty: no command execution. */
  checks: string[];
}

export type Outcome =
  | "review_complete"
  | "needs_input"
  | "budget_exhausted"
  | "stalled"
  | "error"
  | "cancelled";

export interface Usage {
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
  costUsd?: number;
}

export interface CheckResult {
  command: string;
  exitCode: number | null;
  passed: boolean;
  round: number;
  agent: string;
  output: string;
}
