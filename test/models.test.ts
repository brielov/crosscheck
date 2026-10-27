import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  checkAgent,
  listModels,
  parseClaudeModels,
  parseCodexModels,
  suggestModels,
  type ModelCatalog,
} from "../src/models.ts";
import { parseCli, shellQuote, toCommandLine, UsageError } from "../src/options.ts";
import { detectChecks, findPlans, resolveAgents } from "../src/setup.ts";
import type { RunConfig } from "../src/types.ts";

const CLAUDE_INIT = {
  models: [
    { value: "default", resolvedModel: "claude-opus-5-5", supportedEffortLevels: ["low", "max"] },
    {
      value: "opus",
      resolvedModel: "claude-opus-5-5",
      description: "Opus 5.5",
      supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"],
    },
    {
      value: "sonnet",
      resolvedModel: "claude-sonnet-5-5",
      supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"],
    },
    { value: "haiku", resolvedModel: "claude-haiku-4-5-20251001", description: "Haiku 4.5" },
  ],
};

const CODEX_LIST = [
  {
    id: "gpt-6.1-sol",
    model: "gpt-6.1-sol",
    hidden: false,
    isDefault: true,
    defaultReasoningEffort: "low",
    supportedReasoningEfforts: ["low", "medium", "high", "xhigh", "max", "ultra"].map((e) => ({
      reasoningEffort: e,
    })),
  },
  {
    id: "gpt-6-luna",
    model: "gpt-6-luna",
    hidden: false,
    isDefault: false,
    defaultReasoningEffort: "medium",
    supportedReasoningEfforts: ["low", "medium", "high"].map((e) => ({ reasoningEffort: e })),
  },
  {
    id: "codex-auto-review",
    model: "codex-auto-review",
    hidden: true,
    isDefault: false,
    supportedReasoningEfforts: [],
  },
];

const claude: ModelCatalog = { provider: "claude-code", models: parseClaudeModels(CLAUDE_INIT) };
const codex: ModelCatalog = { provider: "codex", models: parseCodexModels(CODEX_LIST) };

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "crosscheck-models-test-"));
});
afterAll(() => rm(dir, { recursive: true, force: true }));

async function fakeRuntime(name: string, body: string): Promise<string> {
  const file = path.join(dir, name);
  await Bun.write(file, `#!${process.execPath}\n${body}`);
  await chmod(file, 0o755);
  return file;
}

describe("catalog parsing", () => {
  test("Claude Code aliases fold into full model ids and the default is marked", () => {
    expect(claude.models.map((m) => [m.id, m.aliases, m.isDefault, m.efforts.length])).toEqual([
      ["claude-opus-5-5", ["opus"], true, 5],
      ["claude-sonnet-5-5", ["sonnet"], false, 5],
      ["claude-haiku-4-5-20251001", ["haiku"], false, 0],
    ]);
  });

  test("Codex efforts are limited to the levels crosscheck supports", () => {
    expect(codex.models[0]).toMatchObject({
      id: "gpt-6.1-sol",
      isDefault: true,
      defaultEffort: "low",
      efforts: ["low", "medium", "high", "xhigh", "max"],
    });
    expect(codex.models[2]).toMatchObject({ id: "codex-auto-review", hidden: true });
    expect(() => parseClaudeModels({})).toThrow("no model list");
  });
});

describe("model checks", () => {
  test("a mistyped model is rejected with the intended one suggested", () => {
    const opus = checkAgent({ provider: "claude-code", model: "opus-5.5" }, claude);
    expect(opus.problem).toMatchObject({ kind: "model" });
    expect(opus.problem?.message).toContain("Did you mean claude-opus-5-5?");
    expect(suggestModels(codex, "gpt6-luna").map((m) => m.id)).toEqual(["gpt-6-luna"]);
    expect(checkAgent({ provider: "codex", model: "sonnet" }, codex).problem?.kind).toBe("model");
  });

  test("ids and aliases are accepted, unlisted full Claude ids only warn", () => {
    expect(checkAgent({ provider: "claude-code", model: "opus" }, claude).model?.id).toBe(
      "claude-opus-5-5",
    );
    expect(checkAgent({ provider: "claude-code" }, claude).model?.id).toBe("claude-opus-5-5");
    expect(checkAgent({ provider: "codex", model: "codex-auto-review" }, codex).problem).toBe(
      undefined,
    );
    const older = checkAgent({ provider: "claude-code", model: "claude-opus-4-6" }, claude);
    expect(older.problem).toBeUndefined();
    expect(older.warning).toContain("not in Claude Code's model list");
    // A near miss of a listed id is a typo, not an unlisted model.
    expect(
      checkAgent({ provider: "claude-code", model: "claude-sonet-5-5" }, claude).problem?.kind,
    ).toBe("model");
  });

  test("efforts the model does not support are rejected", () => {
    expect(
      checkAgent({ provider: "codex", model: "gpt-6-luna", effort: "max" }, codex).problem,
    ).toMatchObject({ kind: "effort", message: expect.stringContaining("low, medium, high") });
    expect(
      checkAgent({ provider: "claude-code", model: "haiku", effort: "high" }, claude).problem
        ?.message,
    ).toContain("has no effort setting");
    expect(
      checkAgent({ provider: "codex", model: "gpt-6-luna", effort: "high" }, codex).problem,
    ).toBeUndefined();
  });
});

describe("resolveAgents", () => {
  const base: RunConfig = {
    input: { kind: "brief", brief: "x" },
    repo: "/tmp",
    focus: ["architecture"],
    constraints: "",
    maxRounds: 1,
    timeoutMs: 60_000,
    author: { provider: "claude-code" },
    reviewer: { provider: "codex" },
    checks: [],
  };
  const load = async (provider: string) => (provider === "codex" ? codex : claude);
  const codexHome = process.env.CODEX_HOME;
  afterAll(() => {
    if (codexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = codexHome;
  });

  test("noninteractive: a bad model is a usage error listing the alternatives", async () => {
    process.env.CODEX_HOME = path.join(dir, "no-codex-home");
    const run = resolveAgents(
      { ...base, author: { provider: "claude-code", model: "opus-5.5" } },
      { interactive: false, warn: () => {}, loadCatalog: load },
    );
    await expect(run).rejects.toBeInstanceOf(UsageError);
    await expect(run).rejects.toThrow(
      /--author: unknown claude-code model "opus-5.5"[\s\S]*crosscheck models/,
    );
  });

  test("Codex without a configured model gets the account default, not the adapter's", async () => {
    process.env.CODEX_HOME = path.join(dir, "no-codex-home");
    const config = await resolveAgents(base, {
      interactive: false,
      warn: () => {},
      loadCatalog: load,
    });
    expect(config.reviewer).toEqual({ provider: "codex", model: "gpt-6.1-sol" });
    expect(config.author).toEqual({ provider: "claude-code" });
  });

  test("an invalid Codex default from config.toml names its source", async () => {
    const home = path.join(dir, "codex-home");
    await Bun.write(
      path.join(home, "config.toml"),
      'model = "gpt-6-luna"\nmodel_reasoning_effort = "max"\n',
    );
    process.env.CODEX_HOME = home;
    await expect(
      resolveAgents(base, { interactive: false, warn: () => {}, loadCatalog: load }),
    ).rejects.toThrow(
      '--reviewer (from ~/.codex/config.toml): gpt-6-luna does not support effort "max"',
    );
    const explicit = await resolveAgents(
      { ...base, reviewer: { provider: "codex", effort: "high" } },
      { interactive: false, warn: () => {}, loadCatalog: load },
    );
    expect(explicit.reviewer).toEqual({ provider: "codex", model: "gpt-6-luna", effort: "high" });
  });

  test("an unavailable model list warns and keeps the configuration", async () => {
    process.env.CODEX_HOME = path.join(dir, "no-codex-home");
    const warnings: string[] = [];
    const config = await resolveAgents(
      { ...base, author: { provider: "claude-code", model: "whatever" } },
      {
        interactive: false,
        warn: (m) => warnings.push(m),
        loadCatalog: async () => {
          throw new Error("the claude-code runtime is not installed yet");
        },
      },
    );
    expect(config.author.model).toBe("whatever");
    expect(warnings[0]).toContain("could not list claude-code models");
  });
});

describe("runtime catalogs", () => {
  test("reads Claude Code's initialize response", async () => {
    const streaming = await fakeRuntime(
      "claude-streaming",
      `for await (const chunk of Bun.stdin.stream()) {
         const req = JSON.parse(new TextDecoder().decode(chunk).split("\\n")[0]);
         console.log(JSON.stringify({ type: "control_response", response: { subtype: "success", request_id: req.request_id, response: ${JSON.stringify(CLAUDE_INIT)} } }));
       }`,
    );
    // Answers without waiting for stdin to close, like the real runtime.
    const ok = await listModels("claude-code", { binary: streaming, timeoutMs: 5_000 });
    expect(ok.models.map((m) => m.id)).toEqual([
      "claude-opus-5-5",
      "claude-sonnet-5-5",
      "claude-haiku-4-5-20251001",
    ]);
  });

  test("pages through Codex's model/list", async () => {
    const binary = await fakeRuntime(
      "codex",
      `const pages = [${JSON.stringify(CODEX_LIST.slice(0, 2))}, ${JSON.stringify(CODEX_LIST.slice(2))}];
       let buffer = "";
       for await (const chunk of Bun.stdin.stream()) {
         buffer += new TextDecoder().decode(chunk);
         let i;
         while ((i = buffer.indexOf("\\n")) >= 0) {
           const msg = JSON.parse(buffer.slice(0, i)); buffer = buffer.slice(i + 1);
           if (msg.method === "initialize") console.log(JSON.stringify({ id: msg.id, result: {} }));
           if (msg.method === "model/list") {
             const page = msg.params.cursor ? 1 : 0;
             console.log(JSON.stringify({ method: "account/updated", params: {} }));
             console.log(JSON.stringify({ id: msg.id, result: { data: pages[page], nextCursor: page ? null : "p2" } }));
           }
         }
       }`,
    );
    const catalog = await listModels("codex", { binary, timeoutMs: 5_000 });
    expect(catalog.models.map((m) => m.id)).toEqual([
      "gpt-6.1-sol",
      "gpt-6-luna",
      "codex-auto-review",
    ]);
  });

  test("a runtime that exits early is reported, not mistaken for an empty list", async () => {
    const binary = await fakeRuntime("broken", `console.error("not logged in"); process.exit(3);`);
    await expect(listModels("codex", { binary, timeoutMs: 5_000 })).rejects.toThrow(
      "exited with code 3 before answering: not logged in",
    );
  });
});

describe("interactive setup helpers", () => {
  test("finds likely plan files, newest first, skipping project docs", async () => {
    const repo = path.join(dir, "plans-repo");
    await Bun.write(path.join(repo, "README.md"), "# readme\n");
    await Bun.write(path.join(repo, "PLAN.md"), "# plan\n");
    await Bun.write(path.join(repo, "docs/plans/rate-limits.md"), "# rate limits\n");
    await Bun.write(path.join(repo, "node_modules/pkg/PLAN.md"), "# not this\n");
    await Bun.write(path.join(repo, "EMPTY.md"), "");
    const later = new Date(Date.now() + 60_000);
    const { utimes } = await import("node:fs/promises");
    await utimes(path.join(repo, "docs/plans/rate-limits.md"), later, later);
    expect(await findPlans(repo)).toEqual(["docs/plans/rate-limits.md", "PLAN.md"]);
  });

  test("detects verification commands from the repository", async () => {
    const repo = path.join(dir, "checks-repo");
    await Bun.write(
      path.join(repo, "package.json"),
      JSON.stringify({ scripts: { test: "bun test", lint: "oxlint", build: "x" } }),
    );
    await Bun.write(path.join(repo, "bun.lock"), "");
    await Bun.write(path.join(repo, "Makefile"), "build:\n\ttrue\ntest:\n\ttrue\n");
    expect(await detectChecks(repo)).toEqual(["bun run test", "bun run lint", "make test"]);
    await rm(path.join(repo, "bun.lock"));
    expect((await detectChecks(repo))[0]).toBe("npm test");
  });
});

describe("equivalent command line", () => {
  test("reproduces a configuration with only the non-default flags", async () => {
    const plan = path.join(dir, "PLAN.md");
    await Bun.write(plan, "# Plan\n");
    const config: RunConfig = {
      input: { kind: "plan", planPath: plan },
      repo: dir,
      focus: ["architecture", "security", "correctness"],
      constraints: "Single instance; don't add Redis",
      maxRounds: 3,
      timeoutMs: 60 * 60_000,
      author: { provider: "claude-code", model: "claude-opus-5-5", effort: "high" },
      reviewer: { provider: "codex", model: "gpt-6-astra", effort: "xhigh" },
      checks: ["bun test"],
    };
    const line = toCommandLine(config, dir);
    expect(line).toBe(
      `crosscheck plan PLAN.md --author claude-code:claude-opus-5-5 --reviewer codex:gpt-6-astra --effort author=high,reviewer=xhigh --constraints 'Single instance; don'\\''t add Redis' --check 'bun test'`,
    );
    expect(shellQuote("a b")).toBe("'a b'");
    // Round trip: a shell parses the printed flags back into the same configuration.
    const full = toCommandLine(config, path.join(dir, "elsewhere"));
    const shell = Bun.spawnSync([
      "bash",
      "-c",
      `printf '%s\\0' ${full.slice("crosscheck ".length)}`,
    ]);
    const words = shell.stdout.toString().split("\0").filter(Boolean);
    expect(words).toContain(plan);
    const parsed = await parseCli(words);
    if (parsed === "help" || parsed === "version") throw new Error("unexpected");
    expect(parsed.config).toEqual(config);
  });
});
