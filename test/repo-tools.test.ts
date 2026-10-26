import { beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, symlink } from "node:fs/promises";
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
import { parseAgent, parseCli, parseEffort, parseFocus } from "../src/cli.ts";
import { agentLabel } from "../src/orchestrator.ts";

let repo: string;
let outside: string;

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
  ])("denies %s", async (p, reason) => {
    await expect(resolveRepoPath(repo, p)).rejects.toThrow(reason);
  });

  test("allows .env.example", async () => {
    expect(await readFileTool(repo, ".env.example")).toContain("SECRET=");
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
  ])("denies git %p", (args) => {
    expect(() => checkGitArgs(args)).toThrow(ToolDenied);
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
