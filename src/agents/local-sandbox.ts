import type { HarnessV1NetworkSandboxSession } from "@ai-sdk/harness";
import { chmod, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnProcess } from "./process.ts";

// The Claude Code and Codex harness adapters run a WebSocket bridge "inside a
// sandbox" and the only published network sandbox is Vercel Sandbox (remote).
// This host-backed session lets the same adapters run on this machine against
// the local repository. It provides NO isolation of its own: crosscheck
// disables the agents' built-in shell/file tools and gives them read-only host
// tools instead (see repo-tools.ts).

const PNPM_VERSION = "10.34.9";

/**
 * The adapters bootstrap their bridge with `pnpm install`; provide pnpm via
 * bun if it is not installed. In a compiled crosscheck binary, execPath is the
 * binary itself, and BUN_BE_BUN=1 makes it act as the bun CLI.
 */
export async function shimDir(): Promise<string | undefined> {
  if (Bun.which("pnpm")) return undefined;
  const dir = path.join(os.homedir(), ".cache", "crosscheck", "shims");
  const shim = path.join(dir, "pnpm");
  const content = `#!/usr/bin/env bash\nBUN_BE_BUN=1 exec '${process.execPath.replaceAll("'", "'\\''")}' x pnpm@${PNPM_VERSION} "$@"\n`;
  // Rewrite when stale: execPath differs between `bun src/cli.ts` and a binary.
  const existing = Bun.file(shim);
  if (!(await existing.exists()) || (await existing.text()) !== content) {
    await mkdir(dir, { recursive: true });
    await Bun.write(shim, content);
    await chmod(shim, 0o755);
  }
  return dir;
}

export async function freePort(): Promise<number> {
  const server = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const { port } = server;
  server.stop(true);
  return port;
}

export async function createLocalNetworkSandboxSession(opts: {
  workDir: string;
  port: number;
  env?: Record<string, string>;
}): Promise<HarnessV1NetworkSandboxSession> {
  const extraPath = await shimDir();
  const procs = new Set<ReturnType<typeof spawnProcess>>();
  let stopped = false;
  const resolve = (p: string) => (path.isAbsolute(p) ? p : path.join(opts.workDir, p));
  const spawn: HarnessV1NetworkSandboxSession["spawn"] = async (o) => {
    if (stopped) throw new Error("Local session has stopped");
    const managed = spawnProcess(["bash", "-c", o.command], {
      cwd: o.workingDirectory ? resolve(o.workingDirectory) : opts.workDir,
      env: {
        ...process.env,
        ...(extraPath ? { PATH: `${extraPath}${path.delimiter}${process.env.PATH ?? ""}` } : {}),
        ...o.env,
        ...opts.env,
      },
      signal: o.abortSignal,
    });
    const p = managed.proc;
    procs.add(managed);
    void managed.exited.then(() => procs.delete(managed));
    return {
      pid: p.pid,
      stdout: p.stdout,
      stderr: p.stderr,
      wait: async () => ({ exitCode: await managed.exited }),
      kill: async () => managed.stop(),
    };
  };

  const write = async (p: string, content: Uint8Array) => {
    await mkdir(path.dirname(resolve(p)), { recursive: true });
    await Bun.write(resolve(p), content);
  };

  const session: HarnessV1NetworkSandboxSession = {
    id: `local-${process.pid}-${opts.port}`,
    description: `Local host process; working directory ${opts.workDir}`,
    defaultWorkingDirectory: opts.workDir,
    ports: [opts.port],
    getPortEndpoint: async ({ port, protocol }) => ({
      url: `${protocol === "ws" ? "ws" : "http"}://127.0.0.1:${port}`,
    }),
    getPortUrl: async ({ port, protocol }) =>
      `${protocol === "ws" ? "ws" : "http"}://127.0.0.1:${port}`,
    readFile: async ({ path: p }) => {
      const f = Bun.file(resolve(p));
      return (await f.exists()) ? f.stream() : null;
    },
    readBinaryFile: async ({ path: p }) => {
      const f = Bun.file(resolve(p));
      return (await f.exists()) ? new Uint8Array(await f.arrayBuffer()) : null;
    },
    readTextFile: async ({ path: p, startLine, endLine }) => {
      const f = Bun.file(resolve(p));
      if (!(await f.exists())) return null;
      const text = await f.text();
      if (startLine == null && endLine == null) return text;
      return text
        .split("\n")
        .slice((startLine ?? 1) - 1, endLine)
        .join("\n");
    },
    writeFile: async ({ path: p, content }) => write(p, await new Response(content).bytes()),
    writeBinaryFile: ({ path: p, content }) => write(p, content),
    writeTextFile: ({ path: p, content }) => write(p, new TextEncoder().encode(content)),
    spawn,
    run: async (o) => {
      const p = await spawn(o);
      const [stdout, stderr, { exitCode }] = await Promise.all([
        new Response(p.stdout).text(),
        new Response(p.stderr).text(),
        p.wait(),
      ]);
      return { exitCode, stdout, stderr };
    },
    stop: async () => {
      stopped = true;
      for (const p of procs) p.stop();
      await Promise.all([...procs].map((p) => p.exited));
      procs.clear();
    },
    destroy: () => session.stop(),
    restricted: () => session,
  };
  return session;
}
