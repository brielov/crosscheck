import { HarnessAgent } from "@ai-sdk/harness/agent";
import { createClaudeCode } from "@ai-sdk/harness-claude-code";
import { createCodex } from "@ai-sdk/harness-codex";
import os from "node:os";
import path from "node:path";
import pkg from "../package.json";
import { defaultCodexConfig } from "./agents/harness-backend.ts";
import { spawnProcess } from "./agents/process.ts";

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

const has = (...names: string[]) => names.find((n) => process.env[n]);

async function checkClaudeAuth(): Promise<DoctorCheck> {
  const name = "claude-code credentials";
  const env = has(
    "CLAUDE_CODE_OAUTH_TOKEN",
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "AI_GATEWAY_API_KEY",
  );
  if (env) return { name, status: "ok", detail: `$${env}` };
  const configDir = process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), ".claude");
  const file = path.join(configDir, ".credentials.json");
  try {
    const creds = (await Bun.file(file).json()) as { claudeAiOauth?: { accessToken?: unknown } };
    if (typeof creds.claudeAiOauth?.accessToken === "string")
      return { name, status: "ok", detail: `subscription login (${file})` };
  } catch {}
  if (process.platform === "darwin" && !process.env.CLAUDE_CONFIG_DIR) {
    // Only checks that the item exists; never reads the secret.
    const r = await output([
      "security",
      "find-generic-password",
      "-s",
      "Claude Code-credentials",
      "-a",
      process.env.USER ?? "",
    ]);
    if (r.code === 0) return { name, status: "ok", detail: "subscription login (macOS Keychain)" };
  }
  return {
    name,
    status: "fail",
    detail: "no login or API key found",
    hint: "Run `claude` and use /login, or export ANTHROPIC_API_KEY.",
  };
}

async function checkCodexAuth(): Promise<DoctorCheck> {
  const name = "codex credentials";
  const env = has("CODEX_API_KEY", "OPENAI_API_KEY", "AI_GATEWAY_API_KEY");
  if (env) return { name, status: "ok", detail: `$${env}` };
  const home = process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex");
  const file = path.join(home, "auth.json");
  try {
    const auth = (await Bun.file(file).json()) as {
      OPENAI_API_KEY?: unknown;
      tokens?: { access_token?: unknown };
    };
    if (typeof auth.tokens?.access_token === "string")
      return { name, status: "ok", detail: `ChatGPT login (${file})` };
    if (typeof auth.OPENAI_API_KEY === "string" && auth.OPENAI_API_KEY)
      return { name, status: "ok", detail: `API key (${file})` };
  } catch {}
  try {
    const config = Bun.TOML.parse(await Bun.file(path.join(home, "config.toml")).text()) as {
      cli_auth_credentials_store?: unknown;
    };
    if (
      config.cli_auth_credentials_store === "keyring" ||
      config.cli_auth_credentials_store === "auto"
    )
      return { name, status: "warn", detail: "credentials are in the OS keyring (not verified)" };
  } catch {}
  return {
    name,
    status: "fail",
    detail: "no login or API key found",
    hint: "Run `codex login`, or export OPENAI_API_KEY.",
  };
}

async function checkCodexDefaults(): Promise<DoctorCheck> {
  const d = await defaultCodexConfig();
  return d.model
    ? {
        name: "codex defaults",
        status: "ok",
        detail: `model ${d.model}${d.effort ? `, effort ${d.effort}` : ""} (from config.toml)`,
      }
    : {
        name: "codex defaults",
        status: "warn",
        detail:
          "no model in config.toml; the adapter default (gpt-5.5) is not available on every plan",
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
    checkClaudeAuth(),
    checkCodexAuth(),
    checkCodexDefaults(),
    checkRuntimes(),
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
