import { afterAll, describe, expect, test } from "bun:test";
import { AgentError } from "../src/agents/backend.ts";
import type { Finding } from "../src/findings.ts";
import { UsageError } from "../src/options.ts";
import { runReview, type RunState } from "../src/orchestrator.ts";
import { prepareResume } from "../src/resume.ts";
import { RunStore } from "../src/store.ts";
import type { RunConfig } from "../src/types.ts";
import {
  author,
  config,
  fakeBackend,
  finding,
  removeTempRepos,
  response,
  review,
  tempRepo,
  verdict,
  type Step,
} from "./fake-backend.ts";

afterAll(removeTempRepos);

const REVISED = "# Plan\n\n## Auth\nCompare tokens with crypto.timingSafeEqual.\n";

/** Runs until the scripted failure, then resumes the same run with a second script. */
async function stopThenResume(
  first: { author: Step[]; reviewer: Step[] },
  second: { author: Step[]; reviewer: Step[] },
  over: Partial<RunConfig> = {},
) {
  const { repo, planPath } = await tempRepo();
  const store = await RunStore.create(repo);
  const stopped = await runReview({
    config: config(repo, planPath, over),
    store,
    createBackend: () => fakeBackend(first).backend,
  });
  const prepared = await prepareResume(store.dir, {});
  const fake = fakeBackend(second);
  const resumed = await runReview({
    config: prepared.config,
    store: await RunStore.open(prepared.dir),
    resume: prepared.from,
    createBackend: () => fake.backend,
  });
  const findings = (await Bun.file(store.path("findings.json")).json()) as Finding[];
  return { stopped, resumed, findings, fake, store };
}

describe("resume", () => {
  test("a run that failed during the reviewer's check finishes that check first", async () => {
    const { stopped, resumed, findings, fake, store } = await stopThenResume(
      {
        reviewer: [review({ new_findings: [finding()] }), new AgentError("codex: connection lost")],
        author: [author({ responses: [response("F1", "accept")], revised_plan: REVISED })],
      },
      {
        reviewer: [review({ verdicts: [verdict("F1", "verified")] }), review()],
        author: [author()],
      },
    );
    expect(stopped.status).toBe("error");
    expect(resumed.status).toBe("review_complete");
    // The pending check ran in round 1 with the author's diff, then round 2 was a full review.
    expect(fake.prompts.reviewer[0]).toContain("check the author's turn (round 1)");
    expect(fake.prompts.reviewer[0]).toContain("```diff");
    expect(fake.prompts.reviewer[1]).toContain("full review (round 2)");
    expect(findings.map((f) => `${f.id}:${f.status}`)).toEqual(["F1:verified"]);
    expect(resumed.planVersions.map((v) => v.version)).toEqual([0, 1]);
    expect(resumed.resumes).toEqual([
      expect.objectContaining({
        status: "error",
        reason: expect.stringContaining("connection lost"),
      }),
    ]);
    expect(resumed.elapsedMs).toBeGreaterThanOrEqual(stopped.elapsedMs);
    const saved = (await Bun.file(store.path("run.json")).json()) as RunState;
    expect(saved.status).toBe("review_complete");
    expect(await Bun.file(store.path("report.md")).text()).toContain("Resumed 1 time(s)");
  });

  test("a cancelled author turn resumes with a fresh author reading the whole plan", async () => {
    const controller = new AbortController();
    const { repo, planPath } = await tempRepo();
    const store = await RunStore.create(repo);
    setTimeout(() => controller.abort(), 50);
    const stopped = await runReview({
      config: config(repo, planPath),
      store,
      signal: controller.signal,
      createBackend: () =>
        fakeBackend({ reviewer: [review({ new_findings: [finding()] })], author: ["hang"] })
          .backend,
    });
    expect(stopped.status).toBe("cancelled");
    const prepared = await prepareResume(store.dir, {});
    const fake = fakeBackend({
      reviewer: [review({ verdicts: [verdict("F1", "verified")] }), review()],
      author: [author({ responses: [response("F1", "accept")], revised_plan: REVISED }), author()],
    });
    const resumed = await runReview({
      config: prepared.config,
      store: await RunStore.open(prepared.dir),
      resume: prepared.from,
      createBackend: () => fake.backend,
    });
    expect(resumed.status).toBe("review_complete");
    expect(fake.prompts.author[0]).toContain("new session");
    expect(fake.prompts.author[0]).toContain("F1");
    expect(resumed.rounds.map((r) => [r.round, r.full])).toEqual([
      [1, true],
      [2, false],
      [3, true],
    ]);
  });

  test("an exhausted budget resumes with more rounds and keeps the discussion", async () => {
    const accept = () =>
      author({
        responses: [response("F1", "accept")],
        revised_plan: `${REVISED}\n<!-- ${Math.random()} -->\n`,
      });
    const { stopped, resumed, findings } = await stopThenResume(
      {
        reviewer: [
          review({ new_findings: [finding()] }),
          review({ verdicts: [verdict("F1", "not_resolved")] }),
        ],
        author: [accept()],
      },
      {
        reviewer: [review({ verdicts: [verdict("F1", "verified")] }), review()],
        author: [accept(), author()],
      },
      { maxRounds: 1 },
    );
    expect(stopped.status).toBe("budget_exhausted");
    expect(resumed.status).toBe("review_complete");
    expect(resumed.round).toBe(3);
    expect(resumed.config.maxRounds).toBeGreaterThanOrEqual(3);
    expect(findings).toHaveLength(1);
  });
});

describe("prepareResume", () => {
  async function saved(patch: (state: RunState) => void, findings: unknown[] = []) {
    const { repo, planPath } = await tempRepo();
    const store = await RunStore.create(repo);
    const state = await runReview({
      config: config(repo, planPath, { maxRounds: 5 }),
      store,
      createBackend: () =>
        fakeBackend({ reviewer: [new AgentError("codex: down")], author: [] }).backend,
    });
    patch(state);
    await Bun.write(store.path("run.json"), JSON.stringify(state));
    if (findings.length) await Bun.write(store.path("findings.json"), JSON.stringify(findings));
    return { repo, store, state };
  }

  test("finds a run by id and gives it the rounds it had left", async () => {
    const { repo, store } = await saved((s) => (s.round = 2));
    const { config } = await prepareResume(store.id, {}, repo);
    expect(config.maxRounds).toBe(5);
    expect(
      (await prepareResume(store.dir, { rounds: 4, timeoutMinutes: 10 }, repo)).config,
    ).toMatchObject({
      maxRounds: 6,
      timeoutMs: 600_000,
    });
  });

  test("a run with no rounds left gets the default number more", async () => {
    const { store } = await saved((s) => (s.round = 5));
    expect((await prepareResume(store.dir, {})).config.maxRounds).toBe(13);
  });

  test("finished runs, runs waiting for decisions and older formats are refused", async () => {
    for (const status of ["review_complete", "needs_input"] as const) {
      const { store } = await saved((s) => (s.status = status));
      await expect(prepareResume(store.dir, {})).rejects.toThrow(UsageError);
    }
    const { store } = await saved(() => {}, [{ id: "F1", status: "open" }]);
    await expect(prepareResume(store.dir, {})).rejects.toThrow("0.2 or earlier");
    await expect(prepareResume("no-such-run", {})).rejects.toThrow("no run at no-such-run");
  });
});
