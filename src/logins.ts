import os from "node:os";
import path from "node:path";
import { spawnProcess } from "./agents/process.ts";
import { codexAccount, runtimeBinary } from "./models.ts";
import type { Provider } from "./types.ts";

// Login checks that run before any conversation, so a rejected login fails
// the run in seconds instead of after another agent has spent a long turn.
// Each check uses a request that costs no tokens, and secrets stay in memory:
// they are never printed, logged or written to run files.

export interface LoginCheck {
  provider: Provider;
  status: "ok" | "warn" | "fail";
  detail: string;
  hint?: string;
  /** When the login token expires (epoch ms), if known. */
  expiresAt?: number;
}

export interface LoginOptions {
  env?: Record<string, string | undefined>;
  home?: string;
  platform?: NodeJS.Platform;
  fetch?: typeof fetch;
  /** Codex runtime binary; defaults to the pinned runtime or the one on PATH. */
  codexBinary?: string;
  timeoutMs?: number;
}

const HINTS: Record<Provider, string> = {
  "claude-code": "Run `claude` and use /login, or export ANTHROPIC_API_KEY.",
  codex: "Run `codex login`, or export OPENAI_API_KEY.",
};

/** The adapters refresh a token this close to expiry when a session starts. */
const REFRESH_WINDOW_MS = 5 * 60_000;

type Probe = { name: string; url: string; headers: Record<string, string> };

/** Sends one free request per credential. Rejections fail; anything else unclear only warns. */
async function probe(
  probes: Probe[],
  o: LoginOptions,
): Promise<{ status: LoginCheck["status"]; problems: string[] }> {
  const doFetch = o.fetch ?? fetch;
  const problems: string[] = [];
  let status: LoginCheck["status"] = "ok";
  for (const p of probes) {
    try {
      const r = await doFetch(p.url, {
        headers: p.headers,
        signal: AbortSignal.timeout(o.timeoutMs ?? 15_000),
      });
      if (r.status === 401 || r.status === 403) {
        const body = (await r.text().catch(() => "")) as string;
        const message = /"message"\s*:\s*"([^"]{1,200})"/.exec(body)?.[1];
        problems.push(`${p.name} was rejected (HTTP ${r.status}${message ? `: ${message}` : ""})`);
        status = "fail";
      } else if (!r.ok) {
        problems.push(`${p.name} could not be verified (HTTP ${r.status})`);
        if (status === "ok") status = "warn";
      }
    } catch (e) {
      problems.push(`${p.name} could not be verified (${(e as Error).message})`);
      if (status === "ok") status = "warn";
    }
  }
  return { status, problems };
}

async function readSecret(command: string[]): Promise<string | undefined> {
  if (!Bun.which(command[0]!)) return undefined;
  const { proc, exited } = spawnProcess(command, { cwd: os.tmpdir(), timeoutMs: 15_000 });
  const [text, code] = await Promise.all([new Response(proc.stdout).text(), exited]);
  return code === 0 ? text.trim() : undefined;
}

/** The Claude subscription login, from the credentials file or the macOS Keychain. */
async function claudeOAuth(
  env: Record<string, string | undefined>,
  home: string,
  platform: NodeJS.Platform,
): Promise<{ accessToken: string; expiresAt?: number; where: string } | undefined> {
  const configDir = env.CLAUDE_CONFIG_DIR ?? path.join(home, ".claude");
  const parse = (text: string | undefined) => {
    try {
      const oauth = (JSON.parse(text ?? "") as { claudeAiOauth?: Record<string, unknown> })
        .claudeAiOauth;
      return typeof oauth?.accessToken === "string"
        ? {
            accessToken: oauth.accessToken,
            ...(typeof oauth.expiresAt === "number" ? { expiresAt: oauth.expiresAt } : {}),
          }
        : undefined;
    } catch {
      return undefined;
    }
  };
  const file = path.join(configDir, ".credentials.json");
  const fromFile = parse(
    await Bun.file(file)
      .text()
      .catch(() => undefined),
  );
  if (fromFile) return { ...fromFile, where: file };
  if (platform === "darwin" && !env.CLAUDE_CONFIG_DIR) {
    const text = await readSecret([
      "security",
      "find-generic-password",
      "-s",
      "Claude Code-credentials",
      "-a",
      env.USER ?? "",
      "-w",
    ]);
    const fromKeychain = parse(text);
    if (fromKeychain) return { ...fromKeychain, where: "macOS Keychain" };
  }
  return undefined;
}

async function checkClaude(o: LoginOptions): Promise<LoginCheck> {
  const env = o.env ?? process.env;
  const provider = "claude-code";
  if (env.AI_GATEWAY_API_KEY || env.VERCEL_OIDC_TOKEN)
    return { provider, status: "warn", detail: "AI Gateway credentials (not verified)" };
  const base = (env.ANTHROPIC_BASE_URL ?? "https://api.anthropic.com").replace(/\/+$/, "");
  const url = `${base}/v1/models?limit=1`;
  const version = { "anthropic-version": "2023-06-01" };
  const probes: Probe[] = [];
  if (env.ANTHROPIC_API_KEY)
    probes.push({
      name: "$ANTHROPIC_API_KEY",
      url,
      headers: { ...version, "x-api-key": env.ANTHROPIC_API_KEY },
    });
  for (const name of ["ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN"])
    if (env[name])
      probes.push({
        name: `$${name}`,
        url,
        headers: { ...version, authorization: `Bearer ${env[name]}` },
      });
  let expiresAt: number | undefined;
  let detail = probes.map((p) => p.name).join(", ");
  if (probes.length === 0) {
    const oauth = await claudeOAuth(env, o.home ?? os.homedir(), o.platform ?? process.platform);
    if (!oauth)
      return {
        provider,
        status: "fail",
        detail: "no login or API key found",
        hint: HINTS[provider],
      };
    expiresAt = oauth.expiresAt;
    detail = `subscription login (${oauth.where})`;
    // An expired or nearly expired token is refreshed when the agent starts,
    // so checking it now would report a problem that does not exist.
    if (expiresAt != null && expiresAt <= Date.now() + REFRESH_WINDOW_MS)
      return { provider, status: "ok", detail: `${detail}; refreshed when the agent starts` };
    probes.push({
      name: "the subscription login",
      url,
      headers: { ...version, authorization: `Bearer ${oauth.accessToken}` },
    });
  }
  const { status, problems } = await probe(probes, o);
  return {
    provider,
    status,
    detail: problems.length
      ? detail.startsWith("$")
        ? problems.join("; ")
        : `${detail}: ${problems.join("; ")}`
      : `${detail}, verified`,
    ...(status === "fail" ? { hint: HINTS[provider] } : {}),
    ...(expiresAt != null ? { expiresAt } : {}),
  };
}

/** Expiry of the ChatGPT access token in CODEX_HOME/auth.json, if it is stored there. */
async function codexExpiry(env: Record<string, string | undefined>, home: string) {
  const file = path.join(env.CODEX_HOME ?? path.join(home, ".codex"), "auth.json");
  try {
    const token = ((await Bun.file(file).json()) as { tokens?: { access_token?: unknown } }).tokens
      ?.access_token;
    if (typeof token !== "string") return undefined;
    const payload = JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString()) as {
      exp?: unknown;
    };
    return typeof payload.exp === "number" ? payload.exp * 1000 : undefined;
  } catch {
    return undefined;
  }
}

/** Whether Codex has a saved login, in CODEX_HOME/auth.json or the OS keyring. */
async function codexLoginStored(env: Record<string, string | undefined>, home: string) {
  const dir = env.CODEX_HOME ?? path.join(home, ".codex");
  try {
    const auth = (await Bun.file(path.join(dir, "auth.json")).json()) as {
      OPENAI_API_KEY?: unknown;
      tokens?: { access_token?: unknown };
    };
    if (typeof auth.tokens?.access_token === "string" || auth.OPENAI_API_KEY) return true;
  } catch {}
  try {
    const store = (
      Bun.TOML.parse(await Bun.file(path.join(dir, "config.toml")).text()) as {
        cli_auth_credentials_store?: unknown;
      }
    ).cli_auth_credentials_store;
    return store === "keyring" || store === "auto";
  } catch {
    return false;
  }
}

async function checkCodex(o: LoginOptions): Promise<LoginCheck> {
  const env = o.env ?? process.env;
  const provider = "codex";
  if (env.AI_GATEWAY_API_KEY || env.VERCEL_OIDC_TOKEN)
    return { provider, status: "warn", detail: "AI Gateway credentials (not verified)" };
  const key = env.OPENAI_API_KEY ?? env.CODEX_API_KEY;
  if (key) {
    const name = env.OPENAI_API_KEY ? "$OPENAI_API_KEY" : "$CODEX_API_KEY";
    const base = (env.OPENAI_BASE_URL ?? "https://api.openai.com/v1").replace(/\/+$/, "");
    const { status, problems } = await probe(
      [{ name, url: `${base}/models`, headers: { authorization: `Bearer ${key}` } }],
      o,
    );
    return {
      provider,
      status,
      detail: problems.length ? problems.join("; ") : `${name}, verified`,
      ...(status === "fail" ? { hint: HINTS[provider] } : {}),
    };
  }
  const home = o.home ?? os.homedir();
  if (!(await codexLoginStored(env, home)))
    return { provider, status: "fail", detail: "not logged in", hint: HINTS[provider] };
  const binary = o.codexBinary ?? runtimeBinary("codex");
  if (!binary)
    return {
      provider,
      status: "warn",
      detail: "the Codex runtime is not installed yet, so the login was not verified",
    };
  // Codex's own runtime reads its login (file or keyring) and asks the server
  // for the account's usage limits, which fails without a valid login.
  const account = await codexAccount(binary, {
    env,
    timeoutMs: o.timeoutMs ?? 20_000,
  }).catch((e: unknown) => ({ error: (e as Error).message }) as const);
  if ("error" in account) {
    const unverified = /no answer|exited/.test(account.error);
    return {
      provider,
      status: unverified ? "warn" : "fail",
      detail: unverified
        ? `the login could not be verified (${account.error})`
        : `the login was rejected (${account.error})`,
      ...(unverified ? {} : { hint: HINTS[provider] }),
    };
  }
  if (!account.account)
    return { provider, status: "fail", detail: "not logged in", hint: HINTS[provider] };
  const expiresAt = await codexExpiry(env, home);
  if (account.account.type !== "chatgpt")
    return { provider, status: "ok", detail: `${account.account.type} login (not verified)` };
  const detail = `ChatGPT login${account.account.planType ? ` (${account.account.planType} plan)` : ""}, verified`;
  if (account.usageAllowed === false)
    return {
      provider,
      status: "warn",
      detail: `${detail}, but the plan's usage limit is reached${account.resetsAt ? `; it resets ${new Date(account.resetsAt).toLocaleString()}` : ""}`,
      ...(expiresAt != null ? { expiresAt } : {}),
    };
  return { provider, status: "ok", detail, ...(expiresAt != null ? { expiresAt } : {}) };
}

export function checkLogin(provider: Provider, options: LoginOptions = {}): Promise<LoginCheck> {
  return provider === "codex" ? checkCodex(options) : checkClaude(options);
}

/** A warning when a login token expires before the run's time limit, or null. */
export function expiryWarning(check: LoginCheck, timeoutMs: number, now = Date.now()) {
  if (check.expiresAt == null || check.expiresAt > now + timeoutMs) return null;
  const minutes = Math.max(0, Math.round((check.expiresAt - now) / 60_000));
  const avoid =
    check.provider === "claude-code"
      ? " `claude setup-token` creates a long-lived token; export it as CLAUDE_CODE_OAUTH_TOKEN."
      : "";
  return `the ${check.provider} login token expires in ${minutes} min, before this run's time limit. A turn still running then is retried in a fresh session and starts over.${avoid}`;
}
