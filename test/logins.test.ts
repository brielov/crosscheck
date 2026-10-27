import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { checkLogin, expiryWarning, type LoginCheck } from "../src/logins.ts";

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "crosscheck-logins-"));
});
afterAll(() => rm(dir, { recursive: true, force: true }));

/** A fetch that records requests and answers with the given status. */
function fakeFetch(status: number, body = "{}") {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  const f = (async (url: string, init?: RequestInit) => {
    calls.push({ url, headers: init?.headers as Record<string, string> });
    return new Response(body, { status });
  }) as unknown as typeof fetch;
  return { fetch: f, calls };
}

async function home(name: string, files: Record<string, unknown> = {}) {
  const h = path.join(dir, name);
  await mkdir(h, { recursive: true });
  for (const [file, value] of Object.entries(files))
    await Bun.write(path.join(h, file), JSON.stringify(value));
  return h;
}

/** A Codex runtime whose app-server answers account requests from a script. */
async function fakeCodex(name: string, answers: Record<string, unknown>) {
  const file = path.join(dir, `${name}-runtime`);
  await Bun.write(
    file,
    `#!${process.execPath}
const answers = ${JSON.stringify(answers)};
let buffer = "";
for await (const chunk of Bun.stdin.stream()) {
  buffer += new TextDecoder().decode(chunk);
  let i;
  while ((i = buffer.indexOf("\\n")) >= 0) {
    const m = JSON.parse(buffer.slice(0, i));
    buffer = buffer.slice(i + 1);
    if (m.id == null) continue;
    const a = m.method === "initialize" ? { result: {} } : answers[m.method];
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, ...a }) + "\\n");
  }
}
`,
  );
  await chmod(file, 0o755);
  return file;
}

const HOUR = 3_600_000;

describe("claude-code login", () => {
  test("a rejected API key fails with the server's reason", async () => {
    const f = fakeFetch(
      401,
      '{"error":{"type":"authentication_error","message":"invalid x-api-key"}}',
    );
    const c = await checkLogin("claude-code", {
      env: { ANTHROPIC_API_KEY: "sk-bad" },
      fetch: f.fetch,
    });
    expect(c).toMatchObject({ status: "fail", hint: expect.stringContaining("/login") });
    expect(c.detail).toBe("$ANTHROPIC_API_KEY was rejected (HTTP 401: invalid x-api-key)");
    expect(f.calls[0]!.headers["x-api-key"]).toBe("sk-bad");
    // The secret never appears in what is reported.
    expect(JSON.stringify(c)).not.toContain("sk-bad");
  });

  test("a subscription login is verified and reports when it expires", async () => {
    const expiresAt = Date.now() + 2 * HOUR;
    const h = await home("claude-ok", {
      ".claude/.credentials.json": { claudeAiOauth: { accessToken: "tok", expiresAt } },
    });
    const f = fakeFetch(200);
    const c = await checkLogin("claude-code", {
      env: {},
      home: h,
      platform: "linux",
      fetch: f.fetch,
    });
    expect(c).toMatchObject({ status: "ok", expiresAt });
    expect(c.detail).toContain("verified");
    expect(f.calls[0]!.headers.authorization).toBe("Bearer tok");
  });

  test("a token about to expire is left for the agent to refresh", async () => {
    const h = await home("claude-expiring", {
      ".claude/.credentials.json": {
        claudeAiOauth: { accessToken: "old", expiresAt: Date.now() + 60_000 },
      },
    });
    const f = fakeFetch(401);
    const c = await checkLogin("claude-code", {
      env: {},
      home: h,
      platform: "linux",
      fetch: f.fetch,
    });
    expect(c.status).toBe("ok");
    expect(f.calls).toHaveLength(0);
  });

  test("no login fails; an unreachable server only warns", async () => {
    const empty = await home("claude-none");
    expect(
      (await checkLogin("claude-code", { env: {}, home: empty, platform: "linux" })).status,
    ).toBe("fail");
    const offline = (async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;
    const c = await checkLogin("claude-code", {
      env: { ANTHROPIC_API_KEY: "k" },
      fetch: offline,
    });
    expect(c.status).toBe("warn");
    expect(c.detail).toContain("network down");
  });
});

describe("codex login", () => {
  const stored = { ".codex/auth.json": { tokens: { access_token: "x.e30.y" } } };

  test("a ChatGPT login is verified through the runtime's usage limits", async () => {
    const h = await home("codex-ok", stored);
    const binary = await fakeCodex("codex-ok", {
      "account/read": { result: { account: { type: "chatgpt", planType: "plus" } } },
      "account/rateLimits/read": { result: { ordinaryUsageAllowed: true } },
    });
    const c = await checkLogin("codex", { env: {}, home: h, codexBinary: binary });
    expect(c).toMatchObject({ status: "ok", detail: "ChatGPT login (plus plan), verified" });
  });

  test("a login the server rejects fails, and a used-up plan warns", async () => {
    const h = await home("codex-bad", stored);
    const rejected = await fakeCodex("codex-rejected", {
      "account/read": { result: { account: { type: "chatgpt" } } },
      "account/rateLimits/read": { error: { code: -32600, message: "token expired" } },
    });
    const bad = await checkLogin("codex", { env: {}, home: h, codexBinary: rejected });
    expect(bad).toMatchObject({ status: "fail", detail: "the login was rejected (token expired)" });
    const limited = await fakeCodex("codex-limited", {
      "account/read": { result: { account: { type: "chatgpt" } } },
      "account/rateLimits/read": {
        result: { ordinaryUsageAllowed: false, rateLimits: { primary: { resetsAt: 1 } } },
      },
    });
    const c = await checkLogin("codex", { env: {}, home: h, codexBinary: limited });
    expect(c.status).toBe("warn");
    expect(c.detail).toContain("usage limit is reached");
  });

  test("no saved login fails without starting the runtime", async () => {
    const h = await home("codex-none");
    const c = await checkLogin("codex", { env: {}, home: h, codexBinary: "/nonexistent" });
    expect(c).toMatchObject({ status: "fail", detail: "not logged in" });
  });

  test("an API key is checked against the models endpoint", async () => {
    const f = fakeFetch(401);
    const c = await checkLogin("codex", { env: { OPENAI_API_KEY: "sk-x" }, fetch: f.fetch });
    expect(c.status).toBe("fail");
    expect(f.calls[0]!.url).toBe("https://api.openai.com/v1/models");
  });
});

test("a token expiring before the time limit is flagged", () => {
  const now = Date.now();
  const check: LoginCheck = {
    provider: "claude-code",
    status: "ok",
    detail: "",
    expiresAt: now + 30 * 60_000,
  };
  expect(expiryWarning(check, 3 * HOUR, now)).toContain("expires in 30 min");
  expect(expiryWarning(check, 3 * HOUR, now)).toContain("claude setup-token");
  expect(expiryWarning(check, 10 * 60_000, now)).toBeNull();
  expect(expiryWarning({ ...check, expiresAt: undefined }, 3 * HOUR, now)).toBeNull();
});
