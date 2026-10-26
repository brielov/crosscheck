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
  ) {
    super(message);
  }
}
