import { stat } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import {
  EFFORT_LEVELS,
  FOCUS_AREAS,
  type AgentConfig,
  type Effort,
  type FocusArea,
  type InputSpec,
  type Role,
  type RunConfig,
} from "./types.ts";

export const DEFAULT_FOCUS: FocusArea[] = ["architecture", "security", "correctness"];
export const DEFAULTS = {
  rounds: 8,
  timeoutMinutes: 180,
  author: "claude-code",
  reviewer: "codex",
};
export const MAX_TIMEOUT_MINUTES = Math.floor(2_147_483_647 / 60_000);

/** Invalid command-line input; exits with code 64. */
export class UsageError extends Error {}

export function parseAgent(spec: string, flag: string): AgentConfig {
  const [rawProvider, ...rest] = spec.split(":");
  const model = rest.join(":") || undefined;
  const provider = rawProvider === "claude" ? "claude-code" : rawProvider;
  if (provider !== "claude-code" && provider !== "codex") {
    throw new UsageError(`${flag}: unknown provider "${rawProvider}" (use claude-code or codex)`);
  }
  return { provider, ...(model ? { model } : {}) };
}

export function parseFocus(list: string): FocusArea[] {
  const items = list
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  for (const item of items) {
    if (!(FOCUS_AREAS as readonly string[]).includes(item)) {
      throw new UsageError(
        `--focus: unknown area "${item}" (choose from ${FOCUS_AREAS.join(", ")})`,
      );
    }
  }
  if (items.length === 0) throw new UsageError("--focus: at least one area is required");
  return [...new Set(items)] as FocusArea[];
}

/** `--effort high` applies to both roles; `--effort author=low,reviewer=max` sets them separately. */
export function parseEffort(spec: string): Partial<Record<Role, Effort>> {
  const level = (value: string): Effort => {
    const v = value.trim().toLowerCase();
    if (!(EFFORT_LEVELS as readonly string[]).includes(v)) {
      throw new UsageError(
        `--effort: unknown level "${value}" (choose from ${EFFORT_LEVELS.join(", ")})`,
      );
    }
    return v as Effort;
  };
  if (!spec.includes("=")) {
    const e = level(spec);
    return { author: e, reviewer: e };
  }
  const result: Partial<Record<Role, Effort>> = {};
  for (const part of spec.split(",")) {
    const pieces = part.split("=").map((s) => s.trim());
    if (pieces.length !== 2) throw new UsageError("--effort: expected role=level");
    const [role, value = ""] = pieces;
    if (role !== "author" && role !== "reviewer") {
      throw new UsageError(
        `--effort: unknown role "${role}" (use author=<level> and/or reviewer=<level>)`,
      );
    }
    if (result[role]) throw new UsageError(`--effort: ${role} specified more than once`);
    result[role] = level(value);
  }
  return result;
}

export function positiveInt(value: string, flag: string, max = Number.MAX_SAFE_INTEGER): number {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 1 || n > max)
    throw new UsageError(
      `${flag}: expected a positive integer no greater than ${max}, got "${value}"`,
    );
  return n;
}

export async function readText(file: string, flag: string): Promise<string> {
  const info = await stat(file).catch(() => null);
  if (!info?.isFile())
    throw new UsageError(`${flag}: file not found or not a regular file: ${file}`);
  return Bun.file(file).text();
}

export async function assertDir(dir: string): Promise<string> {
  const abs = path.resolve(dir);
  const s = await stat(abs).catch(() => null);
  if (!s?.isDirectory()) throw new UsageError(`--repo: not a directory: ${dir}`);
  return abs;
}

/** What the flags settled. Interactive setup asks only for the rest. */
export interface Preset {
  input?: InputSpec;
  repo: string;
  focus?: FocusArea[];
  constraints?: string;
  maxRounds?: number;
  timeoutMs?: number;
  author?: AgentConfig;
  reviewer?: AgentConfig;
  effort: Partial<Record<Role, Effort>>;
  checks?: string[];
}

export type Parsed = {
  preset: Preset;
  /** The complete configuration, or null when interactive setup should run. */
  config: RunConfig | null;
  verbose: boolean;
  interactive: boolean;
};

const withEffort = (agent: AgentConfig, effort: Effort | undefined): AgentConfig =>
  effort ? { ...agent, effort } : agent;

/** Fills everything the flags left out with the defaults. */
export function completeConfig(preset: Preset & { input: InputSpec }): RunConfig {
  return {
    input: preset.input,
    repo: preset.repo,
    focus: preset.focus ?? DEFAULT_FOCUS,
    constraints: preset.constraints ?? "",
    maxRounds: preset.maxRounds ?? DEFAULTS.rounds,
    timeoutMs: preset.timeoutMs ?? DEFAULTS.timeoutMinutes * 60_000,
    author: withEffort(
      preset.author ?? parseAgent(DEFAULTS.author, "--author"),
      preset.effort.author,
    ),
    reviewer: withEffort(
      preset.reviewer ?? parseAgent(DEFAULTS.reviewer, "--reviewer"),
      preset.effort.reviewer,
    ),
    checks: preset.checks ?? [],
  };
}

export async function parseCli(argv: string[]): Promise<Parsed | "help" | "version"> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      brief: { type: "string" },
      "brief-file": { type: "string" },
      repo: { type: "string" },
      focus: { type: "string" },
      constraints: { type: "string" },
      "constraints-file": { type: "string" },
      rounds: { type: "string" },
      timeout: { type: "string" },
      author: { type: "string" },
      reviewer: { type: "string" },
      effort: { type: "string" },
      check: { type: "string", multiple: true },
      interactive: { type: "boolean", short: "i" },
      verbose: { type: "boolean" },
      help: { type: "boolean", short: "h" },
      version: { type: "boolean" },
    },
  });
  if (values.help) return "help";
  if (values.version) return "version";
  const args = positionals[0] === "plan" ? positionals.slice(1) : positionals;
  if (
    positionals.length > 0 &&
    positionals[0] !== "plan" &&
    !positionals[0]!.toLowerCase().endsWith(".md")
  ) {
    throw new UsageError(`unknown command "${positionals[0]}" (try --help)`);
  }
  if (args.length > 1) throw new UsageError("expected at most one plan file");

  if (values.brief !== undefined && values["brief-file"] !== undefined)
    throw new UsageError("give either --brief or --brief-file, not both");
  if (values.constraints !== undefined && values["constraints-file"] !== undefined)
    throw new UsageError("give either --constraints or --constraints-file, not both");

  const brief =
    values.brief ??
    (values["brief-file"] ? await readText(values["brief-file"], "--brief-file") : undefined);
  const planArg = args[0];
  if (planArg && brief !== undefined)
    throw new UsageError("give either a plan file or --brief, not both");
  if (brief !== undefined && !brief.trim()) throw new UsageError("--brief is empty");

  let input: InputSpec | undefined;
  if (planArg) {
    const planPath = path.resolve(planArg);
    if (!(await readText(planPath, "plan")).trim()) throw new UsageError("plan file is empty");
    input = { kind: "plan", planPath };
  } else if (brief !== undefined) {
    input = { kind: "brief", brief: brief.trim() };
  }
  const constraints =
    values.constraints ??
    (values["constraints-file"]
      ? await readText(values["constraints-file"], "--constraints-file")
      : undefined);

  const preset: Preset = {
    ...(input ? { input } : {}),
    repo: await assertDir(values.repo ?? "."),
    ...(values.focus !== undefined ? { focus: parseFocus(values.focus) } : {}),
    ...(constraints !== undefined ? { constraints: constraints.trim() } : {}),
    ...(values.rounds !== undefined ? { maxRounds: positiveInt(values.rounds, "--rounds") } : {}),
    ...(values.timeout !== undefined
      ? { timeoutMs: positiveInt(values.timeout, "--timeout", MAX_TIMEOUT_MINUTES) * 60_000 }
      : {}),
    ...(values.author !== undefined ? { author: parseAgent(values.author, "--author") } : {}),
    ...(values.reviewer !== undefined
      ? { reviewer: parseAgent(values.reviewer, "--reviewer") }
      : {}),
    effort: values.effort !== undefined ? parseEffort(values.effort) : {},
    ...(values.check !== undefined ? { checks: values.check } : {}),
  };
  const interactive = values.interactive === true || !input;
  return {
    preset,
    config: interactive ? null : completeConfig({ ...preset, input: input! }),
    verbose: values.verbose ?? false,
    interactive,
  };
}

/** POSIX-shell quoting that fish and zsh also accept. */
export function shellQuote(value: string): string {
  return /^[\w@%+=:,./-]+$/.test(value) ? value : `'${value.replaceAll("'", `'\\''`)}'`;
}

/** A path relative to `cwd` when it lies inside it, else the absolute path. */
export function relativePath(p: string, cwd = process.cwd()): string {
  const r = path.relative(cwd, p);
  return r && !r.startsWith("..") && !path.isAbsolute(r) ? r : p;
}

/** The flags that reproduce a configuration, for rerunning without the prompts. */
export function toCommandLine(config: RunConfig, cwd = process.cwd()): string {
  const rel = (p: string) => relativePath(p, cwd);
  const agent = (a: AgentConfig) => (a.model ? `${a.provider}:${a.model}` : a.provider);
  const args = ["crosscheck", "plan"];
  if (config.input.kind === "plan") args.push(rel(config.input.planPath));
  else args.push("--brief", config.input.brief);
  if (config.repo !== cwd) args.push("--repo", rel(config.repo) || ".");
  args.push("--author", agent(config.author), "--reviewer", agent(config.reviewer));
  const { author: a, reviewer: r } = {
    author: config.author.effort,
    reviewer: config.reviewer.effort,
  };
  if (a && a === r) args.push("--effort", a);
  else if (a || r)
    args.push("--effort", [a && `author=${a}`, r && `reviewer=${r}`].filter(Boolean).join(","));
  if (config.focus.join(",") !== DEFAULT_FOCUS.join(","))
    args.push("--focus", config.focus.join(","));
  if (config.constraints) args.push("--constraints", config.constraints);
  if (config.maxRounds !== DEFAULTS.rounds) args.push("--rounds", String(config.maxRounds));
  if (config.timeoutMs !== DEFAULTS.timeoutMinutes * 60_000)
    args.push("--timeout", String(config.timeoutMs / 60_000));
  for (const check of config.checks) args.push("--check", check);
  return args.map(shellQuote).join(" ");
}
