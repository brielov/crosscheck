import { afterAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const home = await mkdtemp(path.join(os.tmpdir(), "crosscheck-doctor-"));
afterAll(() => rm(home, { recursive: true, force: true }));

test("doctor reports bridge files and missing credentials without starting agents", async () => {
  const proc = Bun.spawn(
    [process.execPath, path.join(import.meta.dir, "../src/cli.ts"), "doctor", "--json"],
    {
      env: { HOME: home, PATH: "/usr/bin:/bin" },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [stdout, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  const report = JSON.parse(stdout) as { ok: boolean; checks: { name: string; status: string }[] };
  const status = Object.fromEntries(report.checks.map((c) => [c.name, c.status]));
  expect(status["adapter bridge files"]).toBe("ok");
  expect(status["claude-code credentials"]).toBe("fail");
  expect(status["codex credentials"]).toBe("fail");
  expect(status["agent runtimes"]).toBe("warn");
  expect(report.ok).toBe(false);
  expect(code).toBe(1);
});
