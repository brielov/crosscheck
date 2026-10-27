import { afterAll, describe, expect, test } from "bun:test";
import path from "node:path";
import { AgentError } from "../src/agents/backend.ts";
import { MAX_DISPUTE_ROUNDS, type Finding } from "../src/findings.ts";
import { MAX_CORRECTIONS, runReview, type RunState } from "../src/orchestrator.ts";
import { nextSteps, type NextStep } from "../src/report.ts";
import { RunStore } from "../src/store.ts";
import type { RunConfig } from "../src/types.ts";
import {
  author,
  config,
  fakeBackend,
  finding,
  response,
  review,
  tempRepo,
  verdict,
  type Step,
  removeTempRepos,
} from "./fake-backend.ts";

afterAll(removeTempRepos);

const REVISED = "# Plan\n\n## Auth\nCompare tokens with crypto.timingSafeEqual.\n";

async function run(
  script: { author: Step[]; reviewer: Step[] },
  over: Partial<RunConfig> = {},
  signal?: AbortSignal,
) {
  const { repo, planPath } = await tempRepo();
  const cfg = config(repo, planPath, over);
  const store = await RunStore.create(repo);
  const fake = fakeBackend(script);
  const state = await runReview({ config: cfg, store, signal, createBackend: () => fake.backend });
  const findings = (await Bun.file(store.path("findings.json")).json()) as Finding[];
  return { state, findings, store, fake, planPath };
}

const statusOf = (findings: Finding[], id: string) => findings.find((f) => f.id === id)?.status;

describe("review loop", () => {
  test("complete path: raise → accept/revise → verify, then a clean full review", async () => {
    const { state, findings, store, planPath, fake } = await run({
      reviewer: [
        review({ new_findings: [finding()] }),
        review({ verdicts: [verdict("F1", "verified")] }),
        review(),
      ],
      author: [author({ responses: [response("F1", "accept")], revised_plan: REVISED }), author()],
    });
    expect(state.status).toBe("review_complete");
    expect(state.round).toBe(2);
    expect(state.rounds.map((r) => r.full)).toEqual([true, true]);
    expect(statusOf(findings, "F1")).toBe("verified");
    expect(state.planVersions.map((v) => v.version)).toEqual([0, 1]);
    expect(await Bun.file(store.path("plan.md")).text()).toBe(REVISED);
    expect(await Bun.file(store.path("plan/v0.md")).text()).toContain("===");
    // The user's input plan is never modified.
    expect(await Bun.file(planPath).text()).toContain("Compare tokens with ===");
    expect(await Bun.file(store.path("report.md")).text()).toContain("Review complete");
    expect((await Bun.file(store.path("run.json")).json()).status).toBe("review_complete");
    // The second full review ran in fresh sessions for both agents.
    expect(fake.opened).toEqual(["reviewer", "author", "reviewer", "author"]);
    expect(fake.prompts.reviewer[2]).toContain("fresh eyes");
    expect(fake.prompts.author[1]).toContain("new session");
  });

  test("the author revises the plan with edits instead of rewriting it", async () => {
    const { state, store, fake } = await run({
      reviewer: [
        review({ new_findings: [finding()] }),
        review({ verdicts: [verdict("F1", "verified")] }),
        review(),
      ],
      author: [
        author({
          responses: [response("F1", "accept")],
          plan_edits: [
            {
              find: "Compare tokens with ===.",
              replace: "Compare tokens with crypto.timingSafeEqual.",
            },
          ],
        }),
        author(),
      ],
    });
    expect(state.status).toBe("review_complete");
    expect(await Bun.file(store.path("plan.md")).text()).toBe(REVISED);
    expect(state.planVersions.map((v) => v.version)).toEqual([0, 1]);
    // The reviewer checks the edit as a diff of the full plan.
    expect(fake.prompts.reviewer[1]).toContain("+Compare tokens with crypto.timingSafeEqual.");
    expect(fake.prompts.author[0]).toContain("plan_edits");
  });

  test("an edit that does not match the plan gets a correction turn", async () => {
    const { state, store, fake } = await run({
      reviewer: [
        review({ new_findings: [finding()] }),
        review({ verdicts: [verdict("F1", "verified")] }),
        review(),
      ],
      author: [
        author({
          responses: [response("F1", "accept")],
          plan_edits: [{ find: "Compare tokens with == ", replace: "x" }],
        }),
        author({
          responses: [response("F1", "accept")],
          plan_edits: [
            {
              find: "Compare tokens with ===.",
              replace: "Compare tokens with crypto.timingSafeEqual.",
            },
          ],
        }),
        author(),
      ],
    });
    expect(state.status).toBe("review_complete");
    expect(fake.prompts.author[1]).toContain("is not in the plan");
    expect(await Bun.file(store.path("plan.md")).text()).toBe(REVISED);
  });

  test("a clean first review still needs the author's sign-off", async () => {
    const { state, fake } = await run({ reviewer: [review()], author: [author()] });
    expect(state.status).toBe("review_complete");
    expect(fake.prompts.author).toHaveLength(1);
    expect(fake.prompts.author[0]).toContain("Your own critique");
    // Nothing changed, so the reviewer has nothing to check.
    expect(fake.prompts.reviewer).toHaveLength(1);
  });

  test("the author's own objection must be agreed by the reviewer", async () => {
    const own = finding({
      category: "architecture",
      severity: "medium",
      title: "The cache is not needed",
      location: "plan §Cache",
      problem: "One instance with 50 keys does not need Redis",
      suggestion: "Drop the cache",
    });
    const { state, findings, fake } = await run({
      reviewer: [review(), review({ responses: [response("F1", "accept", "agreed")] }), review()],
      author: [author({ new_findings: [own], revised_plan: REVISED }), author()],
    });
    expect(state.status).toBe("review_complete");
    expect(findings[0]).toMatchObject({ raiser: "author", status: "verified" });
    expect(fake.prompts.reviewer[1]).toContain("The author's own points");
    // A material point in round 1 means another full review was needed.
    expect(state.round).toBe(2);
  });

  test("the reviewer can dispute the author's point and the author withdraws it", async () => {
    const own = finding({ category: "architecture", title: "Drop auth", location: "§Auth" });
    const { state, findings } = await run({
      reviewer: [
        review(),
        review({ responses: [response("F1", "dispute", "Auth is a stated requirement")] }),
        review(),
        review(),
      ],
      author: [
        author({ new_findings: [own], revised_plan: REVISED }),
        author({
          verdicts: [verdict("F1", "withdrawn", "The reviewer is right")],
          revised_plan: `${REVISED}\nrestored\n`,
        }),
        author(),
      ],
    });
    expect(state.status).toBe("review_complete");
    expect(findings[0]).toMatchObject({ raiser: "author", status: "withdrawn" });
  });

  test("low-severity points are discussed until settled", async () => {
    const { state, findings } = await run({
      reviewer: [
        review({ new_findings: [finding({ severity: "low", title: "Name the helper clearly" })] }),
        review({ verdicts: [verdict("F1", "verified")] }),
      ],
      author: [author({ responses: [response("F1", "accept")], revised_plan: REVISED })],
    });
    // A full review that raised only low points completes once they are settled.
    expect(state.status).toBe("review_complete");
    expect(state.round).toBe(1);
    expect(statusOf(findings, "F1")).toBe("verified");
  });

  test("an author marking a point addressed does not close it", async () => {
    const accept = () =>
      author({
        responses: [response("F1", "accept")],
        revised_plan: `${REVISED}\n<!-- ${Math.random()} -->\n`,
      });
    const { state, findings, fake } = await run(
      {
        reviewer: [
          review({ new_findings: [finding()] }),
          review({ verdicts: [verdict("F1", "not_resolved")] }),
          review({ verdicts: [verdict("F1", "not_resolved")] }),
        ],
        author: [accept(), accept()],
      },
      { maxRounds: 2 },
    );
    expect(state.status).toBe("budget_exhausted");
    expect(state.reason).toContain("still under discussion");
    expect(statusOf(findings, "F1")).toBe("open");
    // Round 2 continued the discussion instead of starting a new full review.
    expect(state.rounds.map((r) => r.full)).toEqual([true, false]);
    expect(fake.prompts.reviewer).toHaveLength(3);
    expect(fake.prompts.author).toHaveLength(2);
  });

  test("the reviewer cannot verify a point the author disputed", async () => {
    const { state, findings } = await run({
      reviewer: [
        review({ new_findings: [finding()] }),
        review({ verdicts: [verdict("F1", "verified")] }),
        review({ verdicts: [verdict("F1", "verified")] }),
        review({ verdicts: [verdict("F1", "verified")] }),
      ],
      author: [author({ responses: [response("F1", "dispute", "Tokens are hashed first")] })],
    });
    expect(state.status).toBe("error");
    expect(state.reason).toContain("output validation failed");
    expect(statusOf(findings, "F1")).toBe("disputed");
  });

  test(`a dispute maintained ${MAX_DISPUTE_ROUNDS} times ends in needs_input, not success`, async () => {
    const maintain = () =>
      review({ verdicts: [verdict("F1", "maintain_dispute", "Still compared with ===")] });
    const dispute = () => author({ responses: [response("F1", "dispute")] });
    const { state, findings } = await run(
      {
        reviewer: [
          review({ new_findings: [finding()] }),
          maintain(),
          maintain(),
          maintain(),
          review(),
        ],
        author: [dispute(), dispute(), dispute(), author()],
      },
      { maxRounds: 5 },
    );
    expect(state.status).toBe("needs_input");
    expect(statusOf(findings, "F1")).toBe("disputed");
    expect(state.round).toBe(4);
  });

  test("a product decision is preserved for the user", async () => {
    const { state, findings, store } = await run({
      reviewer: [
        review({ new_findings: [finding({ evidence_type: "missing_requirement" })] }),
        review(),
      ],
      author: [
        author({
          responses: [response("F1", "needs_user_decision", "Should keys be per-org or per-user?")],
        }),
        author(),
      ],
    });
    expect(state.status).toBe("needs_input");
    expect(findings[0]!.needsUserDecision).toBe("Should keys be per-org or per-user?");
    expect(await Bun.file(store.path("report.md")).text()).toContain("Decisions needed from you");
  });

  test(`malformed output gets ${MAX_CORRECTIONS} correction attempts, then fails the run`, async () => {
    const bad = { output: { summary: "x", findings: "none" } };
    const { state, findings, store } = await run({ reviewer: [bad, bad, bad], author: [] });
    expect(state.status).toBe("error");
    expect(findings).toHaveLength(0);
    const transcript = (await Bun.file(store.path("transcript.jsonl")).text())
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
      .filter((entry) => entry.type === "turn-complete");
    expect(transcript).toHaveLength(MAX_CORRECTIONS + 1);
    expect(transcript[1]!.prompt).toContain("could not be accepted");
  });

  test("a corrected response is accepted", async () => {
    const { state, findings } = await run({
      reviewer: [
        { output: undefined, outputError: "No object generated" },
        review({ new_findings: [finding()] }),
        review({ verdicts: [verdict("F1", "verified")] }),
        review(),
      ],
      author: [author({ responses: [response("F1", "accept")], revised_plan: REVISED }), author()],
    });
    expect(state.status).toBe("review_complete");
    expect(findings).toHaveLength(1);
  });

  test("a full review without repository inspection is not accepted as 'no findings'", async () => {
    const lazy = { ...review(), toolCalls: [] };
    const { state } = await run({ reviewer: [lazy, lazy, lazy], author: [] });
    expect(state.status).toBe("error");
    expect(state.reason).toContain("did not inspect the repository");
  });

  test("points keep stable IDs and restatements are merged across rounds", async () => {
    const second = finding({
      category: "correctness",
      severity: "medium",
      title: "Missing migration",
      location: "plan §DB",
      problem: "No migration for the keys table",
      suggestion: "Add a migration",
    });
    const third = finding({
      category: "performance",
      severity: "medium",
      title: "Uncached lookups",
      location: "plan §Perf",
      problem: "Every request hits the DB",
      suggestion: "Cache",
    });
    const { findings, state } = await run({
      reviewer: [
        review({ new_findings: [finding(), second] }),
        // Round 1 check: both still unresolved, the reviewer paraphrases F1
        // and declares a duplicate of F2, and raises one genuinely new issue.
        review({
          verdicts: [verdict("F1", "not_resolved"), verdict("F2", "not_resolved")],
          new_findings: [
            finding({ title: "Token comparison not constant time" }),
            { ...second, duplicate_of: "F2" },
            third,
          ],
        }),
        review({
          verdicts: [
            verdict("F1", "verified"),
            verdict("F2", "verified"),
            verdict("F3", "verified"),
          ],
        }),
        review(),
      ],
      author: [
        author({
          responses: [response("F1", "accept"), response("F2", "accept")],
          revised_plan: REVISED,
        }),
        author({
          responses: [response("F1", "accept"), response("F2", "accept"), response("F3", "accept")],
          revised_plan: `${REVISED}\nmore\n`,
        }),
        author(),
      ],
    });
    expect(state.status).toBe("review_complete");
    expect(findings.map((f) => f.id)).toEqual(["F1", "F2", "F3"]);
    expect(findings[0]!.title).toBe("Token comparison is not constant time");
    expect(findings[0]!.history.some((h) => h.note.startsWith("Restated"))).toBe(true);
    expect(findings[1]!.history.some((h) => h.note.startsWith("Restated"))).toBe(true);
    // The check belongs to round 1; only F3 was new in it.
    expect(state.rounds[0]!.raised).toEqual(["F1", "F2", "F3"]);
    expect(findings[2]!.raisedInRound).toBe(1);
  });

  test("repeated rounds without change end as stalled", async () => {
    const { state } = await run(
      {
        reviewer: [
          review({ new_findings: [finding()] }),
          review({ verdicts: [verdict("F1", "not_resolved")] }),
          review({ verdicts: [verdict("F1", "not_resolved")] }),
          review({ verdicts: [verdict("F1", "not_resolved")] }),
        ],
        author: [
          author({ responses: [response("F1", "accept")] }),
          author({ responses: [response("F1", "accept")] }),
          author({ responses: [response("F1", "accept")] }),
        ],
      },
      { maxRounds: 5 },
    );
    expect(state.status).toBe("stalled");
    expect(state.round).toBe(3);
  });

  test("failed verification checks prevent review_complete", async () => {
    const { repo, planPath } = await tempRepo();
    const store = await RunStore.create(repo);
    let onCheck:
      | ((r: { command: string; exitCode: number | null; output: string }) => void)
      | undefined;
    const fake = fakeBackend({
      reviewer: [
        () => {
          onCheck?.({ command: "bun test", exitCode: 1, output: "1 fail" });
          return review();
        },
      ],
      author: [author()],
    });
    const state = await runReview({
      config: config(repo, planPath, { checks: ["bun test"] }),
      store,
      createBackend: (hooks) => ((onCheck = hooks.onCheck), fake.backend),
    });
    expect(state.status).toBe("needs_input");
    expect(state.reason).toContain("bun test");
  });
});

describe("budgets, cancellation and failures", () => {
  test("an already cancelled run never starts an agent", async () => {
    const { state, fake } = await run({ reviewer: [], author: [] }, {}, AbortSignal.abort());
    expect(state.status).toBe("cancelled");
    expect(fake.opened).toEqual([]);
  });

  test("runtime startup receives the deadline signal", async () => {
    const { repo, planPath } = await tempRepo();
    const state = await runReview({
      config: config(repo, planPath, { timeoutMs: 30 }),
      store: await RunStore.create(repo),
      createBackend: () => ({
        openSession: (spec) =>
          new Promise((_, reject) => {
            expect(spec.signal).toBeInstanceOf(AbortSignal);
            spec.signal.addEventListener("abort", () => reject(spec.signal.reason), { once: true });
          }),
      }),
    });
    expect(state.status).toBe("budget_exhausted");
  });

  test("a turn that returns after cancellation cannot report success", async () => {
    const controller = new AbortController();
    const { state } = await run(
      {
        author: [],
        reviewer: [
          () => {
            controller.abort();
            return review();
          },
        ],
      },
      {},
      controller.signal,
    );
    expect(state.status).toBe("cancelled");
  });

  test("a check alone does not qualify as repository inspection", async () => {
    const lazy = {
      ...review(),
      toolCalls: [
        { name: "run_check", input: { command: "true" }, ok: true, summary: "exit code 0" },
      ],
    };
    const { state } = await run({ author: [], reviewer: [lazy, lazy, lazy] });
    expect(state.status).toBe("error");
  });

  test("artifact write failures cannot return success", async () => {
    const { repo, planPath } = await tempRepo();
    const store = await RunStore.create(repo);
    const writeText = store.writeText.bind(store);
    store.writeText = async (name, text) => {
      if (name === "report.md") throw new Error("fixture: disk full");
      return writeText(name, text);
    };
    const fake = fakeBackend({ author: [author()], reviewer: [review()] });
    const state = await runReview({
      config: config(repo, planPath),
      store,
      createBackend: () => fake.backend,
    });
    expect(state.status).toBe("error");
    expect(state.reason).toContain("could not save run artifacts");
    expect((await Bun.file(store.path("run.json")).json()).status).toBe("error");
  });

  test("backend construction failures still produce a report", async () => {
    const { repo, planPath } = await tempRepo();
    const store = await RunStore.create(repo);
    const state = await runReview({
      config: config(repo, planPath),
      store,
      createBackend: () => {
        throw new Error("backend setup failed");
      },
    });
    expect(state.status).toBe("error");
    expect(await Bun.file(store.path("report.md")).text()).toContain("backend setup failed");
  });

  test("partial text and failed turn prompts survive cancellation", async () => {
    const { repo, planPath } = await tempRepo();
    const store = await RunStore.create(repo);
    const controller = new AbortController();
    const state = await runReview({
      config: config(repo, planPath),
      store,
      signal: controller.signal,
      createBackend: () => ({
        openSession: async (spec) => ({
          send: async () => {
            spec.onActivity?.({ kind: "text", delta: "partial investigation" });
            controller.abort();
            throw controller.signal.reason;
          },
          close: async () => {},
        }),
      }),
    });
    expect(state.status).toBe("cancelled");
    const transcript = await Bun.file(store.path("transcript.jsonl")).text();
    expect(transcript).toContain("partial investigation");
    expect(transcript).toContain("turn-start");
    expect(transcript).toContain("turn-error");
  });

  test("streamed text is batched in the transcript, ordered with tool events", async () => {
    const { repo, planPath } = await tempRepo();
    const store = await RunStore.create(repo);
    const state = await runReview({
      config: config(repo, planPath),
      store,
      createBackend: () => ({
        openSession: async (spec) => ({
          send: async () => {
            if (spec.role === "author")
              return { text: "", output: author().output, usage: {}, toolCalls: [] };
            for (const word of ["Reading ", "the ", "plan."])
              spec.onActivity?.({ kind: "text", delta: word });
            spec.onActivity?.({
              kind: "tool-call",
              name: "read_file",
              input: { path: "src/app.ts" },
            });
            spec.onActivity?.({ kind: "text", delta: "Looks fine." });
            return {
              text: "",
              output: review().output,
              usage: {},
              toolCalls: [{ name: "read_file", input: {}, ok: true, summary: "" }],
            };
          },
          close: async () => {},
        }),
      }),
    });
    expect(state.status).toBe("review_complete");
    const records = (await Bun.file(store.path("transcript.jsonl")).text())
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    const activities = records.filter((r) => r.type === "activity").map((r) => r.activity);
    expect(activities).toEqual([
      { kind: "text", delta: "Reading the plan." },
      { kind: "tool-call", name: "read_file", input: { path: "src/app.ts" } },
      { kind: "text", delta: "Looks fine." },
    ]);
    // The trailing text is flushed before the turn is recorded as complete.
    expect(records.findIndex((r) => r.activity?.delta === "Looks fine.")).toBeLessThan(
      records.findIndex((r) => r.type === "turn-complete"),
    );
  });

  test("the run timeout ends the run as budget_exhausted and closes sessions", async () => {
    const { state, fake } = await run({ reviewer: ["hang"], author: [] }, { timeoutMs: 150 });
    expect(state.status).toBe("budget_exhausted");
    expect(state.reason).toContain("time limit");
    expect(fake.closed).toEqual(["reviewer"]);
  });

  test("cancellation stops the run, persists partial results and closes sessions", async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(new Error("ctrl-c")), 50);
    const { state, findings, store, fake } = await run(
      {
        reviewer: [review({ new_findings: [finding()] })],
        author: ["hang"],
      },
      {},
      controller.signal,
    );
    expect(state.status).toBe("cancelled");
    expect(findings.map((f) => f.id)).toEqual(["F1"]);
    expect(fake.closed.sort()).toEqual(["author", "reviewer"]);
    const saved = (await Bun.file(store.path("run.json")).json()) as RunState;
    expect(saved.status).toBe("cancelled");
    expect(await Bun.file(store.path("plan/v0.md")).exists()).toBe(true);
    expect(await Bun.file(store.path("report.md")).text()).toContain("Cancelled");
  });

  test("a login rejected mid-turn is retried once in a fresh session", async () => {
    const expired = () =>
      new AgentError("claude-code: HTTP 401: authentication_failed", "log in", true);
    const { state, fake, store } = await run({
      reviewer: [
        review({ new_findings: [finding()] }),
        review({ verdicts: [verdict("F1", "verified")] }),
        review(),
      ],
      author: [
        expired(),
        author({ responses: [response("F1", "accept")], revised_plan: REVISED }),
        author(),
      ],
    });
    expect(state.status).toBe("review_complete");
    // The failed session was closed and the same prompt went to a new one.
    expect(fake.opened.slice(0, 3)).toEqual(["reviewer", "author", "author"]);
    expect(fake.closed).toContain("author");
    expect(fake.prompts.author[1]).toBe(fake.prompts.author[0]!);
    expect(await Bun.file(store.path("events.jsonl")).text()).toContain('"type":"auth-retry"');
  });

  test("a login that fails again after the retry ends the run with the fix", async () => {
    const expired = () =>
      new AgentError("claude-code: HTTP 401: authentication_failed", "log in", true);
    const { state, fake } = await run({
      reviewer: [review({ new_findings: [finding()] })],
      author: [expired(), expired()],
    });
    expect(state.status).toBe("error");
    expect(state.error?.hint).toBe("log in");
    expect(fake.prompts.author).toHaveLength(2);
  });

  test("a rejected login during a correction retries from the original prompt", async () => {
    const expired = () => new AgentError("claude-code: HTTP 401", "log in", true);
    const bad = { output: { summary: "x" } };
    const { state, fake } = await run({
      reviewer: [
        review({ new_findings: [finding()] }),
        review({ verdicts: [verdict("F1", "verified")] }),
        review(),
      ],
      author: [
        bad,
        expired(),
        author({ responses: [response("F1", "accept")], revised_plan: REVISED }),
        author(),
      ],
    });
    expect(state.status).toBe("review_complete");
    expect(fake.prompts.author[1]).toContain("could not be accepted");
    expect(fake.prompts.author[2]).toBe(fake.prompts.author[0]!);
  });

  test("an agent failure keeps completed work and reports the fix", async () => {
    const { state, findings, store } = await run({
      reviewer: [review({ new_findings: [finding()] })],
      author: [
        new AgentError(
          "claude-code: Invalid API key",
          "Authenticate Claude Code: run `claude` and use /login",
        ),
      ],
    });
    expect(state.status).toBe("error");
    expect(state.error?.hint).toContain("/login");
    expect(findings).toHaveLength(1);
    const report = await Bun.file(store.path("report.md")).text();
    expect(report).toContain("**Fix:**");
    const transcript = await Bun.file(store.path("transcript.jsonl")).text();
    expect(transcript).toContain('"role":"reviewer"');
  });

  test("brief mode drafts the plan with the author before review", async () => {
    const { repo } = await tempRepo();
    const store = await RunStore.create(repo);
    const fake = fakeBackend({
      author: [author({ summary: "drafted", revised_plan: "# Drafted plan\n" }), author()],
      reviewer: [review()],
    });
    const state = await runReview({
      config: { ...config(repo, ""), input: { kind: "brief", brief: "Add API keys" } },
      store,
      createBackend: () => fake.backend,
    });
    expect(state.status).toBe("review_complete");
    expect(await Bun.file(path.join(store.dir, "plan/v0.md")).text()).toBe("# Drafted plan\n");
    expect(await Bun.file(store.path("input/brief.md")).text()).toContain("Add API keys");
    expect(fake.prompts.reviewer[0]).toContain("# Drafted plan");
    // The author critiques its own draft in a fresh session.
    expect(fake.opened).toEqual(["author", "reviewer", "author"]);
  });
});

describe("next steps", () => {
  const texts = (steps: NextStep[]) => steps.map((s) => `${s.text} ${s.command ?? ""}`).join("\n");

  test("a complete review shows how to compare and adopt the revised plan", async () => {
    const { state, findings, store, planPath } = await run({
      reviewer: [
        review({ new_findings: [finding()] }),
        review({ verdicts: [verdict("F1", "verified")] }),
        review(),
      ],
      author: [author({ responses: [response("F1", "accept")], revised_plan: REVISED }), author()],
    });
    expect(state.status).toBe("review_complete");
    const steps = nextSteps(state, findings, store.dir, state.config.repo);
    const plan = path.relative(state.config.repo, store.path("plan.md"));
    const original = path.relative(state.config.repo, planPath);
    expect(steps[0]!.command).toBe(`diff -u ${original} ${plan}`);
    expect(steps[1]!.command).toBe(`cp ${plan} ${original}`);
    const report = await Bun.file(store.path("report.md")).text();
    expect(report).toContain("## Next steps");
    expect(report).toContain(`cp ${plan} ${original}`);
  });

  test("an unchanged plan has nothing to adopt", async () => {
    const { state, findings, store } = await run({ reviewer: [review()], author: [author()] });
    expect(state.status).toBe("review_complete");
    const steps = texts(nextSteps(state, findings, store.dir, state.config.repo));
    expect(steps).toContain("nothing to copy");
    expect(steps).not.toContain("cp ");
  });

  test("open decisions become a rerun with constraints to fill in", async () => {
    const { state, findings, store } = await run({
      reviewer: [
        review({ new_findings: [finding({ evidence_type: "missing_requirement" })] }),
        review(),
      ],
      author: [
        author({ responses: [response("F1", "needs_user_decision", "Per-org keys?")] }),
        author(),
      ],
    });
    expect(state.status).toBe("needs_input");
    const steps = nextSteps(state, findings, store.dir, state.config.repo);
    expect(steps[0]!.text).toContain("Decide F1");
    expect(steps[1]!.command).toContain("--constraints 'F1: <your decision>'");
    expect(texts(steps)).not.toContain("cp ");
  });

  test("a failed run is resumed where it stopped", async () => {
    const { state, findings, store } = await run({
      reviewer: [review({ new_findings: [finding()] })],
      author: [new AgentError("claude-code: Invalid API key", "run /login")],
    });
    const steps = nextSteps(state, findings, store.dir, state.config.repo);
    expect(steps).toHaveLength(1);
    expect(steps[0]!.text).toContain("described under Fix");
    expect(steps[0]!.command).toBe(
      `crosscheck resume ${path.relative(state.config.repo, store.dir)}`,
    );
  });
});
