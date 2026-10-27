import { stat } from "node:fs/promises";
import path from "node:path";
import type { Finding } from "./findings.ts";
import { DEFAULTS, UsageError } from "./options.ts";
import type { ResumeFrom, RunState } from "./orchestrator.ts";
import type { RunConfig } from "./types.ts";

const NOT_RESUMABLE: Partial<Record<RunState["status"], string>> = {
  review_complete: "it already completed",
  needs_input:
    "it is waiting for your decisions. Run again from its plan with your decisions in --constraints (its report's next steps show how)",
};

/** A run directory, or a run id under ./.crosscheck/runs. */
async function findRun(arg: string, cwd: string): Promise<string> {
  for (const dir of [path.resolve(cwd, arg), path.join(cwd, ".crosscheck", "runs", arg)]) {
    if (await Bun.file(path.join(dir, "run.json")).exists()) return dir;
  }
  throw new UsageError(
    `resume: no run at ${arg} (give a run directory, or the id of a run in ./.crosscheck/runs)`,
  );
}

/**
 * Loads a stopped run and the configuration to continue it with. `rounds`
 * is how many more rounds to allow: by default the rounds the run had left,
 * or the default limit when it used them all. The time limit applies to the
 * resumed session, by default the run's original limit.
 */
export async function prepareResume(
  arg: string,
  limits: { rounds?: number; timeoutMinutes?: number },
  cwd = process.cwd(),
): Promise<{ dir: string; config: RunConfig; from: ResumeFrom }> {
  const dir = await findRun(arg, cwd);
  let state: RunState;
  let findings: Finding[];
  try {
    state = (await Bun.file(path.join(dir, "run.json")).json()) as RunState;
    const ledger = Bun.file(path.join(dir, "findings.json"));
    findings = (await ledger.exists()) ? ((await ledger.json()) as Finding[]) : [];
  } catch (e) {
    throw new UsageError(`resume: cannot read the run's saved state: ${(e as Error).message}`);
  }
  const why = NOT_RESUMABLE[state.status];
  if (why) throw new UsageError(`resume: run ${state.id} ended ${state.status}; ${why}`);
  if (findings.some((f) => !("raiser" in f)) || state.rounds.some((r) => !("full" in r)))
    throw new UsageError(
      `resume: run ${state.id} was saved by crosscheck 0.2 or earlier, which used a different review loop. Start a new run from its plan instead.`,
    );
  if (state.planVersions.length === 0)
    throw new UsageError(`resume: run ${state.id} stopped before it had a plan; start a new run`);
  if (!(await stat(state.config.repo).catch(() => null))?.isDirectory())
    throw new UsageError(`resume: the run's repository is gone: ${state.config.repo}`);

  const left = state.config.maxRounds - state.round;
  const more = limits.rounds ?? (left > 0 ? left : DEFAULTS.rounds);
  const config: RunConfig = {
    ...state.config,
    maxRounds: state.round + more,
    timeoutMs:
      limits.timeoutMinutes != null ? limits.timeoutMinutes * 60_000 : state.config.timeoutMs,
  };
  return { dir, config, from: { state, findings } };
}
