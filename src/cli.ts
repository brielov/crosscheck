#!/usr/bin/env bun
import { appendFileSync } from "node:fs";
import path from "node:path";
import { createHarnessBackend } from "./agents/harness-backend.ts";
import { createRepoTools } from "./agents/repo-tools.ts";
import { doctor } from "./doctor.ts";
import pkg from "../package.json";
import { Ledger, type Finding } from "./findings.ts";
import { describeModels, listModels } from "./models.ts";
import { DEFAULT_FOCUS, DEFAULTS, parseCli, UsageError } from "./options.ts";
import { runReview, type RunState } from "./orchestrator.ts";
import { bold, createProgress, cyan, dim, green, red, yellow } from "./progress.ts";
import { formatDuration, formatUsage, nextSteps } from "./report.ts";
import { resolveAgents, wizard } from "./setup.ts";
import { RunStore } from "./store.ts";
import {
  EFFORT_LEVELS,
  FOCUS_AREAS,
  type Outcome,
  type Provider,
  type RunConfig,
} from "./types.ts";

const VERSION = pkg.version;

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
  crosscheck [options]               Guided setup: prompts for anything the flags leave out
  crosscheck plan <PLAN.md> [options]
  crosscheck plan --brief "<text>" [options]
  crosscheck models [--json]         List the models each agent runtime offers you
  crosscheck doctor [--json]         Check this machine's setup (no agents started)

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
  --author <provider[:model]>  claude-code | codex (default: ${DEFAULTS.author});
                               models are checked before the run (see \`crosscheck models\`)
  --reviewer <provider[:model]> claude-code | codex (default: ${DEFAULTS.reviewer})
  --effort <level>             Reasoning effort for both agents: ${EFFORT_LEVELS.join(", ")};
                               or per role, e.g. author=high,reviewer=max
                               (default: each runtime's own default)
  --check <command>            Verification command agents may run (repeatable, exact match).
                               Without it, agents cannot execute anything.
  -i, --interactive            Prompt for the remaining settings even when a plan or brief is given
  --verbose                    Stream agent text and tool calls to stderr
  -h, --help                   Show help
  --version                    Show version

The agents discuss until they agree on every point. A round starts with a full review in
fresh sessions when nothing is under discussion, then the author answers and critiques the
plan, then the reviewer checks the author's turn. The run completes when a full review by
both agents finds nothing material left to change.
Exit codes: 0 review_complete, 2 needs_input, 3 budget_exhausted, 4 stalled, 1 error, 130 cancelled, 64 usage error.
Results: <repo>/.crosscheck/runs/<run-id>/ (plan.md, report.md, findings.json, transcript.jsonl).`;

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
  const count = (p: (f: Finding) => boolean) => findings.filter(p).length;
  lines.push(
    `${bold("Points:")} ${findings.length} raised (${count((f) => f.raiser === "reviewer")} by the reviewer, ${count((f) => f.raiser === "author")} by the author) · ${count((f) => f.status === "verified")} agreed · ${count((f) => f.status === "withdrawn")} withdrawn · ${count(Ledger.needsUser)} for you · ${count((f) => f.awaiting != null)} still under discussion`,
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
  const steps = nextSteps(state, findings, dir);
  if (steps.length > 0) {
    lines.push("", bold("Next steps:"));
    steps.forEach((step, i) => {
      lines.push(`  ${i + 1}. ${step.text}`);
      if (step.command) lines.push(`       ${cyan(step.command)}`);
    });
  }
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

async function models(argv: string[]): Promise<number> {
  const json = argv.includes("--json");
  const unknown = argv.filter((a) => a !== "--json");
  if (unknown.length) {
    process.stderr.write(`crosscheck models: unknown argument ${unknown[0]}\n`);
    return 64;
  }
  const providers: Provider[] = ["claude-code", "codex"];
  const results = await Promise.all(
    providers.map((provider) =>
      listModels(provider).catch((e: unknown) => new Error((e as Error).message ?? String(e))),
    ),
  );
  if (json) {
    const out = Object.fromEntries(
      results.map((r, i) => [providers[i], r instanceof Error ? { error: r.message } : r.models]),
    );
    process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
  } else {
    results.forEach((r, i) => {
      process.stdout.write(`${bold(providers[i]!)}\n`);
      const lines = r instanceof Error ? [red(`unavailable: ${r.message}`)] : describeModels(r);
      process.stdout.write(`${lines.map((l) => `  ${l}`).join("\n")}\n\n`);
    });
    process.stdout.write(
      dim("Use one with --author or --reviewer, e.g. --author claude-code:opus\n"),
    );
  }
  return results.some((r) => r instanceof Error) ? 1 : 0;
}

async function main(argv: string[]): Promise<number> {
  if (argv[0] === "doctor") return doctor(argv.slice(1));
  if (argv[0] === "models") return models(argv.slice(1));
  const terminal = process.stdin.isTTY === true && process.stdout.isTTY === true;
  let config: RunConfig | null;
  let verbose: boolean;
  try {
    const parsed = await parseCli(argv);
    if (parsed === "help") return (process.stdout.write(`${HELP}\n`), 0);
    if (parsed === "version") return (process.stdout.write(`${VERSION}\n`), 0);
    verbose = parsed.verbose;
    if (parsed.interactive) {
      if (!terminal)
        throw new UsageError(
          parsed.preset.input
            ? "--interactive needs a terminal"
            : "no plan or brief given and this is not a terminal (try --help)",
        );
      config = await wizard(parsed.preset);
      if (!config) return 130;
    } else {
      config = await resolveAgents(parsed.config!, {
        interactive: terminal,
        warn: (message) => process.stderr.write(`${yellow("warning:")} ${message}\n`),
      });
    }
  } catch (e) {
    if (!(e instanceof UsageError)) throw e;
    process.stderr.write(`crosscheck: ${e.message}\n`);
    return 64;
  }

  let store: RunStore;
  try {
    store = await RunStore.create(config.repo);
  } catch (e) {
    process.stderr.write(`crosscheck: cannot create run directory: ${(e as Error).message}\n`);
    return 1;
  }
  const progress = createProgress({ verbose, maxRounds: config.maxRounds });
  captureHarnessLogs(
    store.path("harness.log"),
    verbose ? (line) => progress.log(dim(`  ${line}`)) : undefined,
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
