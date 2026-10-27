import { HarnessAgent } from "@ai-sdk/harness/agent";
import { createClaudeCode } from "@ai-sdk/harness-claude-code";
import { createCodex } from "@ai-sdk/harness-codex";
import os from "node:os";
import path from "node:path";
import pkg from "../package.json";
import { defaultCodexConfig } from "./agents/harness-backend.ts";
import { spawnProcess } from "./agents/process.ts";
import { checkLogin } from "./logins.ts";
import { checkAgent, defaultModel, loadCatalog } from "./models.ts";
import type { Provider } from "./types.ts";

// Preflight checks for a machine: everything crosscheck needs before it can
// start the agents, without starting them or spending tokens.

export type CheckStatus = "ok" | "warn" | "fail";
export interface DoctorCheck {
  name: string;
  status: CheckStatus;
  detail: string;
  hint?: string;
}

const MIN_NODE_MAJOR = 20;

async function output(command: string[]): Promise<{ code: number | null; text: string }> {
  if (!Bun.which(command[0]!)) return { code: null, text: "" };
  try {
    const { proc, exited } = spawnProcess(command, { cwd: os.tmpdir(), timeoutMs: 15_000 });
    const [text, , code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      exited,
    ]);
    return { code, text: text.trim() };
  } catch {
    return { code: null, text: "" };
  }
}

async function checkNode(): Promise<DoctorCheck> {
  const r = await output(["node", "--version"]);
  if (r.code !== 0)
    return {
      name: "node",
      status: "fail",
      detail: "not found on PATH",
      hint: `Install Node.js ${MIN_NODE_MAJOR}+; the agent bridges run with node.`,
    };
  const major = Number(/^v(\d+)/.exec(r.text)?.[1]);
  return major >= MIN_NODE_MAJOR
    ? { name: "node", status: "ok", detail: r.text }
    : {
        name: "node",
        status: "fail",
        detail: `${r.text} is too old`,
        hint: `Install Node.js ${MIN_NODE_MAJOR}+.`,
      };
}

async function checkTool(name: string, command: string[], hint: string): Promise<DoctorCheck> {
  const r = await output(command);
  return r.code === 0
    ? { name, status: "ok", detail: r.text.split("\n")[0] ?? "" }
    : { name, status: "fail", detail: "not found on PATH", hint };
}

async function checkBridgeFiles(): Promise<DoctorCheck> {
  try {
    for (const harness of [createClaudeCode(), createCodex()]) {
      await new HarnessAgent({ harness }).getSandboxTemplate();
    }
    return {
      name: "adapter bridge files",
      status: "ok",
      detail: "claude-code and codex bridges load",
    };
  } catch (e) {
    return {
      name: "adapter bridge files",
      status: "fail",
      detail: (e as Error).message,
      hint: "This build is broken; reinstall crosscheck or report a bug.",
    };
  }
}

/** The same login check a run makes before it starts; it spends no tokens. */
async function checkCredentials(provider: Provider): Promise<DoctorCheck> {
  const c = await checkLogin(provider);
  return {
    name: `${provider} credentials`,
    status: c.status,
    detail: c.detail,
    ...(c.hint ? { hint: c.hint } : {}),
  };
}

async function checkModels(provider: Provider): Promise<DoctorCheck> {
  const name = `${provider} models`;
  try {
    const catalog = await loadCatalog(provider);
    const visible = catalog.models.filter((m) => !m.hidden).length;
    const fallback = defaultModel(catalog);
    return {
      name,
      status: "ok",
      detail: `${visible} available${fallback ? `, default ${fallback.id}` : ""} (\`crosscheck models\` lists them)`,
    };
  } catch (e) {
    return {
      name,
      status: "warn",
      detail: `could not list models: ${(e as Error).message}`,
      hint: "Model names will be checked when the agent starts instead of before the run.",
    };
  }
}

async function checkCodexDefaults(): Promise<DoctorCheck> {
  const name = "codex defaults";
  const d = await defaultCodexConfig();
  const detail = d.model
    ? `model ${d.model}${d.effort ? `, effort ${d.effort}` : ""} (from config.toml)`
    : "no model in config.toml";
  const catalog = await loadCatalog("codex").catch(() => undefined);
  if (catalog) {
    const problem = d.model ? checkAgent({ provider: "codex", ...d }, catalog).problem : undefined;
    if (problem)
      return {
        name,
        status: "fail",
        detail: `${detail}: ${problem.message}`,
        hint: "Fix `model` / `model_reasoning_effort` in ~/.codex/config.toml, or pass --reviewer codex:<model> and --effort.",
      };
    const fallback = defaultModel(catalog);
    return {
      name,
      status: "ok",
      detail: d.model
        ? detail
        : `${detail}; crosscheck uses your account default (${fallback?.id})`,
    };
  }
  return d.model
    ? { name, status: "ok", detail }
    : {
        name,
        status: "warn",
        detail: `${detail}; the adapter default (gpt-5.5) is not available on every plan`,
        hint: "Set `model` in ~/.codex/config.toml or pass --reviewer codex:<model>.",
      };
}

async function checkRuntimes(): Promise<DoctorCheck> {
  const base = path.join(os.homedir(), ".ai-sdk-harness", ".harness-bootstrap");
  const installed: string[] = [];
  for (const id of ["claude-code", "codex"]) {
    if (await Bun.file(path.join(base, id, "bridge.mjs")).exists()) installed.push(id);
  }
  return installed.length === 2
    ? { name: "agent runtimes", status: "ok", detail: `installed in ${base}` }
    : {
        name: "agent runtimes",
        status: "warn",
        detail: `${installed.length ? `only ${installed.join(", ")} installed` : "not installed yet"}; the first run downloads them (about 1.6 GB, needs network)`,
      };
}

export async function runDoctorChecks(): Promise<DoctorCheck[]> {
  return Promise.all([
    checkNode(),
    checkTool("git", ["git", "--version"], "Install git."),
    checkTool("bash", ["bash", "--version"], "Install bash."),
    checkBridgeFiles(),
    checkCredentials("claude-code"),
    checkCredentials("codex"),
    checkCodexDefaults(),
    checkRuntimes(),
    checkModels("claude-code"),
    checkModels("codex"),
  ]);
}

export async function doctor(argv: string[]): Promise<number> {
  const json = argv.includes("--json");
  const unknown = argv.filter((a) => a !== "--json");
  if (unknown.length) {
    process.stderr.write(`crosscheck doctor: unknown argument ${unknown[0]}\n`);
    return 64;
  }
  const checks = await runDoctorChecks();
  const failed = checks.some((c) => c.status === "fail");
  if (json) {
    process.stdout.write(
      `${JSON.stringify({ version: pkg.version, platform: `${process.platform}-${process.arch}`, ok: !failed, checks }, null, 2)}\n`,
    );
  } else {
    const mark: Record<CheckStatus, string> = { ok: "✓", warn: "!", fail: "✗" };
    process.stdout.write(`crosscheck ${pkg.version} (${process.platform}-${process.arch})\n\n`);
    for (const c of checks) {
      process.stdout.write(`${mark[c.status]} ${c.name}: ${c.detail}\n`);
      if (c.hint && c.status !== "ok") process.stdout.write(`    ${c.hint}\n`);
    }
    process.stdout.write(`\n${failed ? "Some checks failed." : "Ready."}\n`);
  }
  return failed ? 1 : 0;
}
