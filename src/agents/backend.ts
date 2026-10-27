import type { z } from "zod";
import type { AgentConfig, Role, Usage } from "../types.ts";

/**
 * Transport-independent agent interface used by the orchestrator. The harness
 * backend implements it today; an ACP or native-SDK backend can implement the
 * same contract.
 */
export interface AgentBackend {
  openSession(spec: SessionSpec): Promise<AgentSession>;
}

export interface SessionSpec {
  role: Role;
  /** Display label, e.g. "codex (reviewer)". */
  label: string;
  agent: AgentConfig;
  /** Fixed for the session's lifetime. */
  instructions: string;
  /** Structured output every turn of this session must produce. */
  schema: z.ZodType;
  /** Cancels runtime startup as well as turns. */
  signal: AbortSignal;
  onActivity?: (activity: AgentActivity) => void;
}

export interface AgentSession {
  /** Run one turn in this session's ongoing conversation. */
  send(prompt: string, signal: AbortSignal): Promise<TurnResult>;
  close(): Promise<void>;
}

export interface ToolCallRecord {
  name: string;
  input: unknown;
  ok: boolean;
  /** Truncated result or error text. */
  summary: string;
}

export interface TurnResult {
  text: string;
  /** Parsed structured output, or undefined when the runtime produced none. */
  output: unknown;
  /** Why structured output was missing or rejected by the runtime. */
  outputError?: string;
  usage: Usage;
  toolCalls: ToolCallRecord[];
}

export type AgentActivity =
  | { kind: "status"; message: string }
  | { kind: "text"; delta: string }
  | { kind: "tool-call"; name: string; input: unknown }
  | { kind: "tool-result"; name: string; ok: boolean; summary: string };

/** Failure that prevents the agent from completing a turn (auth, runtime, transport). */
export class AgentError extends Error {
  constructor(
    message: string,
    readonly hint?: string,
    /** The runtime rejected its login, which a fresh session may fix (e.g. an expired token). */
    readonly authFailure = false,
  ) {
    super(message);
  }
}

/**
 * The JSON object a response ends with, for runtimes that narrate before
 * their structured answer. Returns undefined when there is none. The caller
 * still validates the result against the turn's schema.
 */
export function trailingJson(text: string): unknown {
  const end = text.lastIndexOf("}");
  if (end < 0) return undefined;
  // The first opening brace that parses through the last closing brace is the
  // outermost object; braces in earlier prose fail to parse and are skipped.
  for (
    let start = text.indexOf("{");
    start >= 0 && start < end;
    start = text.indexOf("{", start + 1)
  ) {
    try {
      const value: unknown = JSON.parse(text.slice(start, end + 1));
      if (value && typeof value === "object" && !Array.isArray(value)) return value;
    } catch {}
  }
  return undefined;
}
