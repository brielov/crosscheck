#!/usr/bin/env bun
import * as p from "@clack/prompts";
import { appendFileSync } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { createHarnessBackend, defaultCodexConfig } from "./agents/harness-backend.ts";
import { createRepoTools } from "./agents/repo-tools.ts";
import { Ledger, type Finding } from "./findings.ts";
import { runReview, type RunState } from "./orchestrator.ts";
import { bold, createProgress, cyan, dim, green, red, yellow } from "./progress.ts";
import { formatDuration, formatUsage } from "./report.ts";
import { RunStore } from "./store.ts";
import {
  EFFORT_LEVELS,
  FOCUS_AREAS,
  type AgentConfig,
  type Effort,
  type FocusArea,
  type Outcome,
  type RunConfig,
} from "./types.ts";

const VERSION = "0.1.0";
const DEFAULT_FOCUS: FocusArea[] = ["architecture", "security", "correctness"];
const DEFAULTS = { rounds: 3, timeoutMinutes: 60, author: "claude-code", reviewer: "codex" };

export const EXIT_CODES: Record<Outcome, number> = {
  review_complete: 0,
  error: 1,
  needs_input: 2,
  budget_exhausted: 3,
  stalled: 4,
  cancelled: 130,
};

const HELP = `crosscheck ${VERSION}: author/reviewer plan review with Claude Code and Codex

Usage:
  crosscheck                         Interactive mode
  crosscheck plan <PLAN.md> [options]
  crosscheck plan --brief "<text>" [options]

Input (one of):
  <PLAN.md>                    Existing Markdown plan (never modified)
  --brief <text>               Feature/project brief; the author drafts the plan
  --brief-file <path>          Brief read from a file

Options:
  --repo <dir>                 Repository to inspect (default: .)
  --focus <list>               Comma-separated: ${FOCUS_AREAS.join(", ")}
                               (default: ${DEFAULT_FOCUS.join(",")})
  --constraints <text>         Scale, deadlines, stack, compatibility, decisions already made
  --constraints-file <path>    Constraints read from a file
  --rounds <n>                 Maximum review rounds (default: ${DEFAULTS.rounds})
  --timeout <minutes>          Run time limit (default: ${DEFAULTS.timeoutMinutes})
  --author <provider[:model]>  claude-code | codex (default: ${DEFAULTS.author})
  --reviewer <provider[:model]> claude-code | codex (default: ${DEFAULTS.reviewer})
  --effort <level>             Reasoning effort for both agents: ${EFFORT_LEVELS.join(", ")};
                               or per role, e.g. author=high,reviewer=max
                               (default: each runtime's own default)
  --check <command>            Verification command agents may run (repeatable, exact match).
                               Without it, agents cannot execute anything.
  --verbose                    Stream agent text and tool calls to stderr
  -h, --help                   Show help
  --version                    Show version

A round = reviewer pass → author response/revision → reviewer verification.
Exit codes: 0 review_complete, 2 needs_input, 3 budget_exhausted, 4 stalled, 1 error, 130 cancelled, 64 usage error.
Results: <repo>/.crosscheck/runs/<run-id>/ (plan.md, report.md, findings.json, transcript.jsonl).`;

class UsageError extends Error {}

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
export function parseEffort(spec: string): Partial<Record<"author" | "reviewer", Effort>> {
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
  const result: Partial<Record<"author" | "reviewer", Effort>> = {};
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

function withEffort(
  agents: { author: AgentConfig; reviewer: AgentConfig },
  effort: Partial<Record<"author" | "reviewer", Effort>>,
) {
  return {
    author: effort.author ? { ...agents.author, effort: effort.author } : agents.author,
    reviewer: effort.reviewer ? { ...agents.reviewer, effort: effort.reviewer } : agents.reviewer,
  };
}

function positiveInt(value: string, flag: string, max = Number.MAX_SAFE_INTEGER): number {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 1 || n > max)
    throw new UsageError(
      `${flag}: expected a positive integer no greater than ${max}, got "${value}"`,
    );
  return n;
}

async function readText(file: string, flag: string): Promise<string> {
  const info = await stat(file).catch(() => null);
  if (!info?.isFile())
    throw new UsageError(`${flag}: file not found or not a regular file: ${file}`);
  const f = Bun.file(file);
  if (!(await f.exists())) throw new UsageError(`${flag}: file not found: ${file}`);
  return f.text();
}

async function assertDir(dir: string): Promise<string> {
  const abs = path.resolve(dir);
  const s = await stat(abs).catch(() => null);
  if (!s?.isDirectory()) throw new UsageError(`--repo: not a directory: ${dir}`);
  return abs;
}

type Parsed = { config: RunConfig | null; verbose: boolean; interactive: boolean };

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
  const verbose = values.verbose ?? false;
  if (!planArg && brief === undefined) {
    if (positionals.length || Object.keys(values).some((key) => key !== "verbose"))
      throw new UsageError(
        "a plan file or --brief is required when using run options; run crosscheck without options for interactive mode",
      );
    return { config: null, verbose, interactive: true };
  }

  let input: RunConfig["input"];
  if (planArg) {
    const planPath = path.resolve(planArg);
    if (!(await readText(planPath, "plan")).trim()) throw new UsageError("plan file is empty");
    input = { kind: "plan", planPath };
  } else {
    if (!brief!.trim()) throw new UsageError("--brief is empty");
    input = { kind: "brief", brief: brief!.trim() };
  }
  const constraints =
    values.constraints ??
    (values["constraints-file"]
      ? await readText(values["constraints-file"], "--constraints-file")
      : "");
  return {
    verbose,
    interactive: false,
    config: {
      input,
      repo: await assertDir(values.repo ?? "."),
      focus: values.focus !== undefined ? parseFocus(values.focus) : DEFAULT_FOCUS,
      constraints: constraints.trim(),
      maxRounds:
        values.rounds !== undefined ? positiveInt(values.rounds, "--rounds") : DEFAULTS.rounds,
      timeoutMs:
        (values.timeout !== undefined
          ? positiveInt(values.timeout, "--timeout", Math.floor(2_147_483_647 / 60_000))
          : DEFAULTS.timeoutMinutes) * 60_000,
      ...withEffort(
        {
          author: parseAgent(values.author ?? DEFAULTS.author, "--author"),
          reviewer: parseAgent(values.reviewer ?? DEFAULTS.reviewer, "--reviewer"),
        },
        values.effort !== undefined ? parseEffort(values.effort) : {},
      ),
      checks: values.check ?? [],
    },
  };
}

function cancelled<T>(value: T): Exclude<T, symbol> {
  if (p.isCancel(value)) {
    p.cancel("Cancelled.");
    process.exit(130);
  }
  return value as Exclude<T, symbol>;
}

async function interactive(): Promise<RunConfig> {
  p.intro(bold("crosscheck"));
  const kind = cancelled(
    await p.select({
      message: "What should be reviewed?",
      options: [
        { value: "plan", label: "An existing Markdown plan" },
        {
          value: "brief",
          label: "A new feature/project brief",
          hint: "the author agent drafts the plan first",
        },
      ],
    }),
  );
  let input: RunConfig["input"];
  if (kind === "plan") {
    const guess = (await Bun.file("PLAN.md").exists()) ? "PLAN.md" : undefined;
    const planPath = cancelled(
      await p.text({
        message: "Plan file",
        placeholder: guess ?? "./PLAN.md",
        defaultValue: guess,
        validate: (v) => (!v && !guess ? "Enter a path" : undefined),
      }),
    );
    const abs = path.resolve(planPath || guess!);
    if (!(await Bun.file(abs).exists())) throw new UsageError(`plan file not found: ${abs}`);
    input = { kind: "plan", planPath: abs };
  } else {
    const brief = cancelled(
      await p.multiline({
        message: "Feature/project brief (Enter twice to finish)",
        placeholder: "Add organization-level API keys and usage limits",
        validate: (v) => (!v?.trim() ? "A brief is required" : undefined),
      }),
    );
    input = { kind: "brief", brief: brief.trim() };
  }
  const repo = cancelled(
    await p.text({ message: "Repository", placeholder: ".", defaultValue: "." }),
  );
  const focus = cancelled(
    await p.multiselect({
      message: "Review focus",
      options: FOCUS_AREAS.map((f) => ({ value: f, label: f[0]!.toUpperCase() + f.slice(1) })),
      initialValues: DEFAULT_FOCUS,
      required: true,
    }),
  );
  const constraints = cancelled(
    await p.multiline({
      message: "Constraints (optional; Enter twice to finish)",
      placeholder: "e.g. ~2k orgs, ship in 2 weeks, Postgres + Hono, keep v1 API, no new infra",
      defaultValue: "",
    }),
  );
  const rounds = cancelled(
    await p.text({
      message: "Maximum review rounds",
      placeholder: String(DEFAULTS.rounds),
      defaultValue: String(DEFAULTS.rounds),
      validate: (v) => (v && !/^[1-9]\d*$/.test(v) ? "Enter a positive integer" : undefined),
    }),
  );
  const config: RunConfig = {
    input,
    repo: await assertDir(repo || "."),
    focus,
    constraints: (constraints ?? "").trim(),
    maxRounds: positiveInt(rounds || String(DEFAULTS.rounds), "--rounds"),
    timeoutMs: DEFAULTS.timeoutMinutes * 60_000,
    author: parseAgent(DEFAULTS.author, "--author"),
    reviewer: parseAgent(DEFAULTS.reviewer, "--reviewer"),
    checks: [],
  };
  if (input.kind === "plan" && !(await readText(input.planPath, "plan")).trim())
    throw new UsageError("plan file is empty");
  p.note(
    `Author: ${config.author.provider} · Reviewer: ${config.reviewer.provider} · time limit ${DEFAULTS.timeoutMinutes} min\nAgents get read-only repository tools; no commands are executed.\n(Use flags for models, --effort, --check commands and --timeout; see --help.)`,
    "Run settings",
  );
  return config;
}

function printSummary(state: RunState, findings: Finding[], dir: string) {
  const tone = state.status === "review_complete" ? green : state.status === "error" ? red : yellow;
  const lines: string[] = [];
  lines.push("", `${bold("Outcome:")} ${tone(state.status)}: ${state.reason}`);
  if (state.error?.hint) lines.push(`${bold("Fix:")} ${state.error.hint}`);
  for (const f of findings.filter(Ledger.needsUser)) {
    lines.push(
      `  ${yellow("?")} ${f.id} ${f.title}: ${f.needsUserDecision ?? "author and reviewer disagree"}`,
    );
  }
  const c = { open: 0, addressed: 0, verified: 0, withdrawn: 0, disputed: 0 };
  for (const f of findings) c[f.status] += 1;
  const lows = findings.filter(
    (f) => f.severity === "low" && f.status !== "verified" && f.status !== "withdrawn",
  ).length;
  lines.push(
    `${bold("Findings:")} ${findings.length} raised · ${c.verified} verified · ${c.withdrawn} withdrawn · ${c.disputed} disputed · ${c.open + c.addressed} unresolved (${lows} low-severity suggestion(s) remain)`,
  );
  const last = state.planVersions.at(-1);
  if (last)
    lines.push(
      `${bold("Plan:")} ${last.version === 0 ? "v0 (unchanged)" : `v0 → v${last.version}`}`,
    );
  lines.push(`${bold("Usage:")} ${state.agents.author}: ${formatUsage(state.usage.author)}`);
  lines.push(`       ${state.agents.reviewer}: ${formatUsage(state.usage.reviewer)}`);
  lines.push(`${bold("Elapsed:")} ${formatDuration(state.elapsedMs)}`);
  if (state.repoModified)
    lines.push(
      red("Warning: the repository working tree changed during the run; check git status."),
    );
  lines.push("");
  process.stderr.write(`${lines.join("\n")}\n`);
  // Paths go to stdout so they are easy to capture.
  process.stdout.write(
    [
      ...(last ? [`Plan:       ${path.join(dir, "plan.md")}`] : []),
      `Report:     ${path.join(dir, "report.md")}`,
      `Transcript: ${path.join(dir, "transcript.jsonl")}`,
      "",
    ].join("\n"),
  );
}

/**
 * The harness echoes bridge/runtime stderr ("[harness:…]" lines) and a
 * credential-forwarding warning straight to the console. Route them to
 * <run>/harness.log so the terminal stays readable; --verbose still shows them.
 */
function captureHarnessLogs(file: string, show: ((line: string) => void) | undefined) {
  const write = process.stderr.write.bind(process.stderr);
  const sink = (text: string) => {
    try {
      appendFileSync(file, text.endsWith("\n") ? text : `${text}\n`);
    } catch {}
    show?.(text.trimEnd());
  };
  process.stderr.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
    const text = typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
    if (text.startsWith("[harness:")) return (sink(text), true);
    return (write as (...a: unknown[]) => boolean)(chunk, ...rest);
  }) as typeof process.stderr.write;
  const warn = console.warn.bind(console);
  console.warn = (...args: unknown[]) => {
    if (typeof args[0] === "string" && args[0].includes("credential brokering"))
      return sink(`[warn] ${args[0]}`);
    warn(...args);
  };
}

async function main(argv: string[]): Promise<number> {
  let parsed: Awaited<ReturnType<typeof parseCli>>;
  try {
    parsed = await parseCli(argv);
  } catch (e) {
    process.stderr.write(`crosscheck: ${(e as Error).message}\n`);
    return 64;
  }
  if (parsed === "help") return (process.stdout.write(`${HELP}\n`), 0);
  if (parsed === "version") return (process.stdout.write(`${VERSION}\n`), 0);

  let config = parsed.config;
  if (!config) {
    if (!process.stdin.isTTY) {
      process.stderr.write(
        "crosscheck: no plan or brief given and stdin is not a terminal (try --help)\n",
      );
      return 64;
    }
    try {
      config = await interactive();
    } catch (e) {
      p.cancel((e as Error).message);
      return 64;
    }
  }

  const codexDefaults = await defaultCodexConfig();
  for (const role of ["author", "reviewer"] as const) {
    if (config[role].provider === "codex") config[role] = { ...codexDefaults, ...config[role] };
  }
  let store: RunStore;
  try {
    store = await RunStore.create(config.repo);
  } catch (e) {
    process.stderr.write(`crosscheck: cannot create run directory: ${(e as Error).message}\n`);
    return 1;
  }
  const progress = createProgress({ verbose: parsed.verbose, maxRounds: config.maxRounds });
  captureHarnessLogs(
    store.path("harness.log"),
    parsed.verbose ? (line) => progress.log(dim(`  ${line}`)) : undefined,
  );
  progress.log(`${cyan("crosscheck")} run ${store.id} ${dim(store.dir)}`);
  progress.log(dim(`transcript: tail -f ${path.join(store.dir, "transcript.jsonl")}`));

  const controller = new AbortController();
  let interrupts = 0;
  const onSigint = () => {
    interrupts += 1;
    if (interrupts > 1) {
      process.stderr.write("\nForce quit; partial results are in the run directory.\n");
      process.exit(130);
    }
    progress.log(
      yellow(
        "Cancelling… cleaning up agents and saving partial results (Ctrl-C again to force quit)",
      ),
    );
    controller.abort(new Error("cancelled by user"));
  };
  process.on("SIGINT", onSigint);
  process.on("SIGTERM", onSigint);

  const state = await runReview({
    config,
    store,
    signal: controller.signal,
    onEvent: (e) => progress.handle(e),
    createBackend: ({ onCheck }) =>
      createHarnessBackend({
        tools: createRepoTools({ repo: config.repo, checks: config.checks, onCheck }),
      }),
  });
  progress.stop();
  const findings = (await Bun.file(store.path("findings.json"))
    .json()
    .catch(() => [])) as Finding[];
  process.off("SIGINT", onSigint);
  process.off("SIGTERM", onSigint);
  printSummary(state, findings, store.dir);
  return EXIT_CODES[state.status === "running" ? "error" : state.status];
}

if (import.meta.main) {
  const code = await main(process.argv.slice(2));
  process.exit(code);
}
