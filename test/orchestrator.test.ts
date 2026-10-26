import { describe, expect, test } from "bun:test";
import path from "node:path";
import { AgentError } from "../src/agents/backend.ts";
import type { Finding } from "../src/findings.ts";
import { runReview, type RunState } from "../src/orchestrator.ts";
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
} from "./fake-backend.ts";

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
  test("complete path: raise → accept/revise → verify, with persisted artifacts", async () => {
    const { state, findings, store, planPath } = await run({
      reviewer: [
        review({ new_findings: [finding()] }),
        review({ verdicts: [verdict("F1", "verified")] }),
      ],
      author: [author({ responses: [response("F1", "accept")], revised_plan: REVISED })],
    });
    expect(state.status).toBe("review_complete");
    expect(statusOf(findings, "F1")).toBe("verified");
    expect(state.planVersions.map((v) => v.version)).toEqual([0, 1]);
    expect(await Bun.file(store.path("plan.md")).text()).toBe(REVISED);
    expect(await Bun.file(store.path("plan/v0.md")).text()).toContain("===");
    // The user's input plan is never modified.
    expect(await Bun.file(planPath).text()).toContain("Compare tokens with ===");
    expect(await Bun.file(store.path("report.md")).text()).toContain("Review complete");
    expect((await Bun.file(store.path("run.json")).json()).status).toBe("review_complete");
  });

  test("a clean initial review completes without an author turn", async () => {
    const { state, fake } = await run({ reviewer: [review()], author: [] });
    expect(state.status).toBe("review_complete");
    expect(fake.prompts.author).toHaveLength(0);
  });

  test("low-severity findings do not block completion and are reported", async () => {
    const { state, store } = await run({
      reviewer: [
        review({ new_findings: [finding({ severity: "low", title: "Name the helper clearly" })] }),
      ],
      author: [],
    });
    expect(state.status).toBe("review_complete");
    expect(await Bun.file(store.path("report.md")).text()).toContain(
      "Remaining low-severity suggestions",
    );
  });

  test("an author marking a finding addressed does not close it", async () => {
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
    expect(statusOf(findings, "F1")).toBe("open");
    expect(fake.prompts.reviewer).toHaveLength(3); // initial + one verification per round
    expect(fake.prompts.author).toHaveLength(2);
  });

  test("the reviewer cannot verify a finding the author disputed", async () => {
    const { state, findings } = await run({
      reviewer: [
        review({ new_findings: [finding()] }),
        review({ verdicts: [verdict("F1", "verified")] }),
        review({ verdicts: [verdict("F1", "verified")] }),
      ],
      author: [author({ responses: [response("F1", "dispute", "Tokens are hashed first")] })],
    });
    expect(state.status).toBe("error");
    expect(state.reason).toContain("output validation failed");
    expect(statusOf(findings, "F1")).toBe("disputed");
  });

  test("a maintained dispute ends in needs_input, not success", async () => {
    const { state, findings } = await run({
      reviewer: [
        review({ new_findings: [finding()] }),
        review({ verdicts: [verdict("F1", "maintain_dispute", "Still compared with ===")] }),
        review({ verdicts: [verdict("F1", "maintain_dispute", "Still compared with ===")] }),
      ],
      author: [
        author({ responses: [response("F1", "dispute")] }),
        author({ responses: [response("F1", "dispute")] }),
      ],
    });
    expect(state.status).toBe("needs_input");
    expect(statusOf(findings, "F1")).toBe("disputed");
  });

  test("a product decision is preserved for the user", async () => {
    const { state, findings, store } = await run({
      reviewer: [
        review({ new_findings: [finding({ evidence_type: "missing_requirement" })] }),
        review({ verdicts: [verdict("F1", "needs_user_decision")] }),
      ],
      author: [
        author({
          responses: [response("F1", "needs_user_decision", "Should keys be per-org or per-user?")],
        }),
      ],
    });
    expect(state.status).toBe("needs_input");
    expect(findings[0]!.needsUserDecision).toBe("Should keys be per-org or per-user?");
    expect(await Bun.file(store.path("report.md")).text()).toContain("Decisions needed from you");
  });

  test("malformed output gets one correction attempt, then fails the run", async () => {
    const bad = { output: { summary: "x", findings: "none" } };
    const { state, findings, store } = await run({ reviewer: [bad, bad], author: [] });
    expect(state.status).toBe("error");
    expect(findings).toHaveLength(0);
    const transcript = (await Bun.file(store.path("transcript.jsonl")).text()).trim().split("\n");
    expect(transcript).toHaveLength(2);
    expect(JSON.parse(transcript[1]!).prompt).toContain("could not be accepted");
  });

  test("a corrected response is accepted", async () => {
    const { state, findings } = await run({
      reviewer: [
        { output: undefined, outputError: "No object generated" },
        review({ new_findings: [finding()] }),
        review({ verdicts: [verdict("F1", "verified")] }),
      ],
      author: [author({ responses: [response("F1", "accept")], revised_plan: REVISED })],
    });
    expect(state.status).toBe("review_complete");
    expect(findings).toHaveLength(1);
  });

  test("an initial review without repository inspection is not accepted as 'no findings'", async () => {
    const lazy = { ...review(), toolCalls: [] };
    const { state } = await run({ reviewer: [lazy, lazy], author: [] });
    expect(state.status).toBe("error");
    expect(state.reason).toContain("did not inspect the repository");
  });

  test("findings keep stable IDs and restatements are merged across rounds", async () => {
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
        // Round 1 verification: both still unresolved, the reviewer paraphrases F1
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
      ],
    });
    expect(state.status).toBe("review_complete");
    expect(findings.map((f) => f.id)).toEqual(["F1", "F2", "F3"]);
    expect(findings[0]!.title).toBe("Token comparison is not constant time");
    expect(findings[0]!.history.some((h) => h.note.startsWith("Restated"))).toBe(true);
    expect(findings[1]!.history.some((h) => h.note.startsWith("Restated"))).toBe(true);
    // The verification pass belongs to round 1; only F3 was new in it.
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
        ],
        author: [
          author({ responses: [response("F1", "accept")] }),
          author({ responses: [response("F1", "accept")] }),
        ],
      },
      { maxRounds: 5 },
    );
    expect(state.status).toBe("stalled");
    expect(state.round).toBe(2);
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
      author: [],
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
      author: [author({ summary: "drafted", revised_plan: "# Drafted plan\n" })],
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
  });
});
