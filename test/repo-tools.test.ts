import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  checkGitArgs,
  gitTool,
  listFilesTool,
  readFileTool,
  resolveRepoPath,
  runCheckTool,
  searchTool,
  ToolDenied,
} from "../src/agents/repo-tools.ts";
import { parseAgent, parseCli, parseEffort, parseFocus } from "../src/options.ts";
import { agentLabel } from "../src/orchestrator.ts";

let repo: string;
let outside: string;

afterAll(async () => {
  await Promise.all([repo, outside].map((dir) => rm(dir, { recursive: true, force: true })));
});

beforeAll(async () => {
  repo = await mkdtemp(path.join(os.tmpdir(), "crosscheck-tools-"));
  outside = await mkdtemp(path.join(os.tmpdir(), "crosscheck-outside-"));
  await Bun.write(
    path.join(repo, "src/auth.ts"),
    "export function checkToken(a: string, b: string) {\n  return a === b;\n}\n",
  );
  await Bun.write(path.join(repo, ".env"), "SECRET=hunter2\n");
  await Bun.write(path.join(repo, ".env.example"), "SECRET=\n");
  await Bun.write(path.join(repo, ".crosscheck/runs/x/transcript.jsonl"), "{}\n");
  await Bun.write(path.join(outside, "private.txt"), "private\n");
  await symlink(path.join(outside, "private.txt"), path.join(repo, "escape.txt"));
  await Bun.$`git init -q && git add src .env.example && git -c user.email=t@t -c user.name=t commit -qm init`.cwd(
    repo,
  );
});

describe("path policy", () => {
  test("reads repository files with line numbers", async () => {
    expect(await readFileTool(repo, "src/auth.ts", 2, 2)).toBe("2\t  return a === b;");
  });

  test.each([
    ["../outside.txt", "outside the repository"],
    ["/etc/passwd", "outside the repository"],
    ["escape.txt", "outside the repository"],
    [".crosscheck/runs/x/transcript.jsonl", "not accessible"],
    [".git/config", "not accessible"],
    [".env", "secrets"],
    [".env.local~", "secrets"],
    [".envrc", "secrets"],
  ])("denies %s", async (p, reason) => {
    await expect(resolveRepoPath(repo, p)).rejects.toThrow(reason);
  });

  test("allows .env.example", async () => {
    expect(await readFileTool(repo, ".env.example")).toContain("SECRET=");
  });

  test("reads large files by range and rejects invalid ranges and special files", async () => {
    await Bun.write(path.join(repo, "large.txt"), "padding\n".repeat(40_000) + "target\n");
    await expect(readFileTool(repo, "large.txt")).rejects.toThrow("line range");
    expect(await readFileTool(repo, "large.txt", 40_001, 40_001)).toBe("40001\ttarget");
    await expect(readFileTool(repo, "large.txt", -1, 3)).rejects.toThrow("line range");
    await expect(readFileTool(repo, "large.txt", 3, 1)).rejects.toThrow("line range");
    await Bun.$`mkfifo pipe`.cwd(repo).quiet();
    await expect(readFileTool(repo, "pipe")).rejects.toThrow("regular file");
  });

  test("search handles colon filenames and never exposes nested protected files", async () => {
    await Bun.write(path.join(repo, "colon:name.ts"), "visible-marker\n");
    await Bun.write(path.join(repo, "nested:dir/.crosscheck/transcript.jsonl"), "hidden-marker\n");
    await Bun.write(path.join(repo, "nested:dir/.npmrc"), "hidden-marker\n");
    expect(await searchTool(repo, "visible-marker")).toContain("colon:name.ts:1:visible-marker");
    expect(await searchTool(repo, "hidden-marker")).toBe("(no matches)");
  });

  test("read-only tools honor an already aborted signal", async () => {
    const signal = AbortSignal.abort(new Error("cancel test"));
    await expect(readFileTool(repo, "src/auth.ts", undefined, undefined, signal)).rejects.toThrow(
      "cancel test",
    );
    await expect(searchTool(repo, "checkToken", ".", undefined, false, signal)).rejects.toThrow(
      "cancel test",
    );
    await expect(gitTool(repo, ["log"], signal)).rejects.toThrow("cancel test");
  });

  test("listing and search hide run data and secrets", async () => {
    const files = await listFilesTool(repo);
    expect(files).toContain("src/auth.ts");
    expect(files).not.toContain(".crosscheck");
    expect(files).not.toMatch(/^\.env$/m);
    expect(await searchTool(repo, "SECRET")).not.toContain("hunter2");
    expect(await searchTool(repo, "checkToken")).toContain("src/auth.ts:1:");
    expect(await searchTool(repo, "checkToken", ".", "*.md")).toBe("(no matches)");
  });
});

describe("git policy", () => {
  test("allows read-only history commands", async () => {
    expect(await gitTool(repo, ["log", "--oneline"])).toContain("init");
  });

  test.each([
    [["commit", "-m", "x"]],
    [["push"]],
    [["checkout", "."]],
    [["diff", "--output=/tmp/x"]],
    [["diff", "--no-index", "/etc/passwd", "x"]],
    [["log", "--ext-diff"]],
    [["branch", "evil"]],
    [["branch", "-D", "main"]],
    [["tag", "v1"]],
    [["branch", "--unset-upstream"]],
    [["blame", "--contents", "/etc/passwd", "--", "src/auth.ts"]],
    [["cat-file", "--filters", "HEAD:src/auth.ts"]],
    [["show", "HEAD:.env"]],
    [["log", "-L1,10:.env"]],
  ])("denies git %p", (args) => {
    expect(() => checkGitArgs(args)).toThrow(ToolDenied);
  });

  test("history and diffs cannot expose protected files or execute configured helpers", async () => {
    const fixture = await mkdtemp(path.join(os.tmpdir(), "crosscheck-git-policy-"));
    try {
      await Bun.write(path.join(fixture, ".env"), "FIXTURE_SECRET=private\n");
      await Bun.write(path.join(fixture, "safe.txt"), "before\n");
      await Bun.$`git init -q && git add . && git -c user.email=t@t -c user.name=t commit -qm fixture`
        .cwd(fixture)
        .quiet();
      const blob = (await Bun.$`git rev-parse HEAD:.env`.cwd(fixture).text()).trim();
      await expect(gitTool(fixture, ["show", blob])).rejects.toThrow();
      expect(await gitTool(fixture, ["show", "HEAD"])).not.toContain("FIXTURE_SECRET");
      await Bun.write(path.join(fixture, ".env"), "FIXTURE_SECRET=changed\n");
      expect(await gitTool(fixture, ["diff"])).not.toContain("FIXTURE_SECRET");
      await Bun.write(path.join(fixture, "safe.txt"), "after\n");
      await Bun.write(path.join(fixture, ".gitattributes"), "*.txt diff=audit\n");
      await Bun.$`git config diff.audit.command "touch executed" && git config diff.audit.textconv "touch converted"`
        .cwd(fixture)
        .quiet();
      expect(await gitTool(fixture, ["diff"])).toContain("after");
      expect(await Bun.file(path.join(fixture, "executed")).exists()).toBe(false);
      expect(await Bun.file(path.join(fixture, "converted")).exists()).toBe(false);
    } finally {
      await rm(fixture, { recursive: true, force: true });
    }
  });

  test("git commands remain scoped when --repo is a subdirectory", async () => {
    await expect(gitTool(path.join(repo, "src"), ["show", "HEAD:.env.example"])).rejects.toThrow();
    expect(await gitTool(path.join(repo, "src"), ["show", "HEAD"])).not.toContain("SECRET=");
    expect(await searchTool(path.join(repo, "src"), "checkToken")).toContain("auth.ts:1:");
  });
});

describe("verification commands", () => {
  test("only exact allowlisted commands run", async () => {
    const opts = { repo, checks: ["echo ok"] };
    await expect(runCheckTool(opts, "echo ok; rm -rf /")).rejects.toThrow("Not permitted");
    await expect(runCheckTool({ repo, checks: [] }, "echo ok")).rejects.toThrow(
      "No verification commands",
    );
    const results: { exitCode: number | null }[] = [];
    expect(await runCheckTool({ ...opts, onCheck: (r) => results.push(r) }, "echo ok")).toContain(
      "exit code 0",
    );
    expect(results).toEqual([expect.objectContaining({ command: "echo ok", exitCode: 0 })]);
  });
});

describe("cli parsing", () => {
  test("noninteractive plan mode", async () => {
    const plan = path.join(repo, "PLAN.md");
    await Bun.write(plan, "# Plan\n");
    for (const argv of [["plan", plan], [plan]]) {
      const r = await parseCli([
        ...argv,
        "--repo",
        repo,
        "--focus",
        "architecture,security",
        "--rounds",
        "3",
      ]);
      if (r === "help" || r === "version") throw new Error("unexpected");
      expect(r.config).toMatchObject({
        input: { kind: "plan", planPath: plan },
        repo,
        focus: ["architecture", "security"],
        maxRounds: 3,
        checks: [],
      });
    }
    await expect(parseCli(["plan", path.join(repo, "missing.md")])).rejects.toThrow("not found");
    await expect(parseCli(["plan", plan, "--brief", "x"])).rejects.toThrow("not both");
  });

  test("brief mode with options", async () => {
    const r = await parseCli([
      "plan",
      "--brief",
      "Add API keys",
      "--repo",
      repo,
      "--focus",
      "architecture,security",
      "--rounds",
      "2",
      "--reviewer",
      "codex:gpt-6-luna",
      "--check",
      "bun test",
    ]);
    if (r === "help" || r === "version") throw new Error("unexpected");
    expect(r.config).toMatchObject({
      input: { kind: "brief", brief: "Add API keys" },
      focus: ["architecture", "security"],
      maxRounds: 2,
      reviewer: { provider: "codex", model: "gpt-6-luna" },
      author: { provider: "claude-code" },
      checks: ["bun test"],
    });
  });

  test("--effort applies to both roles or per role", async () => {
    const both = await parseCli(["plan", "--brief", "x", "--repo", repo, "--effort", "high"]);
    if (both === "help" || both === "version") throw new Error("unexpected");
    expect(both.config?.author).toEqual({ provider: "claude-code", effort: "high" });
    expect(both.config?.reviewer).toEqual({ provider: "codex", effort: "high" });
    expect(agentLabel("reviewer", both.config!)).toBe("codex [high] (reviewer)");

    const split = await parseCli([
      "plan",
      "--brief",
      "x",
      "--repo",
      repo,
      "--reviewer",
      "codex:gpt-6-luna",
      "--effort",
      "reviewer=max",
    ]);
    if (split === "help" || split === "version") throw new Error("unexpected");
    expect(split.config?.author).toEqual({ provider: "claude-code" });
    expect(split.config?.reviewer).toEqual({
      provider: "codex",
      model: "gpt-6-luna",
      effort: "max",
    });

    expect(parseEffort("author=low, reviewer=XHIGH")).toEqual({ author: "low", reviewer: "xhigh" });
    expect(() => parseEffort("extreme")).toThrow("unknown level");
    expect(() => parseEffort("judge=high")).toThrow("unknown role");
    expect(() => parseEffort("author=")).toThrow("unknown level");
  });

  test("no input means interactive", async () => {
    expect(await parseCli([])).toMatchObject({ interactive: true, config: null });
    expect(await parseCli(["plan"])).toMatchObject({ interactive: true, config: null });
  });

  test("flags without a plan or brief preset the interactive setup", async () => {
    const r = await parseCli([
      "--repo",
      repo,
      "--effort",
      "author=high",
      "--reviewer",
      "codex:gpt-6-luna",
      "--rounds",
      "2",
    ]);
    if (r === "help" || r === "version") throw new Error("unexpected");
    expect(r.interactive).toBe(true);
    expect(r.config).toBeNull();
    expect(r.preset).toEqual({
      repo,
      reviewer: { provider: "codex", model: "gpt-6-luna" },
      effort: { author: "high" },
      maxRounds: 2,
    });
  });

  test("--interactive keeps the given input and asks for the rest", async () => {
    const r = await parseCli(["-i", "--brief", "Add API keys", "--repo", repo]);
    if (r === "help" || r === "version") throw new Error("unexpected");
    expect(r).toMatchObject({
      interactive: true,
      config: null,
      preset: { input: { kind: "brief", brief: "Add API keys" } },
    });
  });

  test("invalid or conflicting options never silently fall back to interactive defaults", async () => {
    for (const argv of [
      ["--brief", ""],
      ["--brief", "x", "--brief-file", "missing.md"],
      ["--brief", "x", "--constraints", "x", "--constraints-file", "missing.md"],
      ["--repo", repo, "--effort", "extreme"],
      ["--author", "gemini"],
      ["--rounds", "0"],
      ["--brief", "x", "--rounds", ""],
      ["--brief", "x", "--timeout", "9999999999"],
      ["--brief", "x", "--focus", ""],
      ["--brief", "x", "--effort", ""],
      ["--brief", "x", "--effort", "author=high=ignored"],
      ["--brief", "x", "--effort", "author=high,author=low"],
    ])
      await expect(parseCli(argv)).rejects.toThrow();
    const empty = path.join(repo, "EMPTY.md");
    await Bun.write(empty, " \n");
    await expect(parseCli(["plan", empty])).rejects.toThrow("empty");
    await expect(parseCli(["plan", repo])).rejects.toThrow("regular file");
  });

  test("validation errors", () => {
    expect(() => parseFocus("speed")).toThrow("unknown area");
    expect(() => parseAgent("gemini", "--author")).toThrow("unknown provider");
    expect(parseAgent("claude:claude-opus-5-5", "--author")).toEqual({
      provider: "claude-code",
      model: "claude-opus-5-5",
    });
  });
});
