import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createLocalNetworkSandboxSession, freePort } from "../src/agents/local-sandbox.ts";
import { runCheckTool } from "../src/agents/repo-tools.ts";
import { readOutput, spawnProcess } from "../src/agents/process.ts";

const childCommand =
  "bash -c 'trap \"\" TERM; echo ready; sleep 0.4; echo survived > escaped' & wait";

test("cancelling a check stops descendants that ignore SIGTERM", async () => {
  const repo = await mkdtemp(path.join(os.tmpdir(), "crosscheck-cancel-"));
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 80);
    const checks: { exitCode: number | null }[] = [];
    try {
      await runCheckTool(
        { repo, checks: [childCommand], onCheck: (r) => checks.push(r) },
        childCommand,
        controller.signal,
      );
    } finally {
      clearTimeout(timer);
    }
    await Bun.sleep(500);
    expect(await Bun.file(path.join(repo, "escaped")).exists()).toBe(false);
    expect(checks[0]!.exitCode).not.toBe(0);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("sandbox shutdown cleans up process groups and refuses further spawns", async () => {
  const repo = await mkdtemp(path.join(os.tmpdir(), "crosscheck-sandbox-"));
  const session = await createLocalNetworkSandboxSession({ workDir: repo, port: await freePort() });
  try {
    const command = await session.spawn({ command: childCommand });
    const reader = command.stdout!.getReader();
    await reader.read();
    reader.releaseLock();
    await session.destroy();
    await Bun.sleep(500);
    expect(await Bun.file(path.join(repo, "escaped")).exists()).toBe(false);
    await expect(session.spawn({ command: "true" })).rejects.toThrow("stopped");
  } finally {
    await session.destroy();
    await rm(repo, { recursive: true, force: true });
  }
});

test("process timeout kills children and output collection stays bounded", async () => {
  const { proc, exited } = spawnProcess(["bash", "-c", "printf '1234567890'; sleep 10"], {
    cwd: os.tmpdir(),
    timeoutMs: 30,
  });
  const [output, code] = await Promise.all([readOutput(proc.stdout, 5), exited]);
  expect(output).toBe("12345\n… [output truncated]");
  expect(code).not.toBe(0);
});

test("an interrupted check that handles SIGTERM with exit zero is still a failed check", async () => {
  const controller = new AbortController();
  const command = "trap 'exit 0' TERM; sleep 10";
  const checks: { exitCode: number | null }[] = [];
  const timer = setTimeout(() => controller.abort(), 60);
  try {
    await runCheckTool(
      { repo: os.tmpdir(), checks: [command], onCheck: (r) => checks.push(r) },
      command,
      controller.signal,
    );
    expect(checks[0]!.exitCode).toBeNull();
  } finally {
    clearTimeout(timer);
  }
});
