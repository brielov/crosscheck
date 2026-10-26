// Integration spike: exercise a harness adapter against a local repository.
// Usage: bun spike/harness-spike.ts <claude|codex> <repo>
// Checks: repo inspection, permission denial, multi-turn memory, structured
// output, streaming, cancellation and cleanup.
import { HarnessAgent } from "@ai-sdk/harness/agent";
import { createClaudeCode } from "@ai-sdk/harness-claude-code";
import { createCodex } from "@ai-sdk/harness-codex";
import { Output, tool } from "ai";
import { z } from "zod";
import path from "node:path";
import { createLocalNetworkSandboxSession, freePort } from "../src/agents/local-sandbox.ts";

const which = process.argv[2] as "claude" | "codex";
const repo = path.resolve(process.argv[3]!);
const t0 = Date.now();
const log = (...a: unknown[]) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s]`, ...a);

// Host-executed, read-only repository tool (used to give Codex repo access with
// its built-in shell disabled).
const readFile = tool({
  description: "Read a UTF-8 file from the repository. Path is relative to the repository root.",
  inputSchema: z.object({ path: z.string() }),
  execute: async ({ path: p }) => {
    const abs = path.resolve(repo, p);
    if (!abs.startsWith(repo + path.sep)) return "error: path outside repository";
    log("HOST read_file", p);
    return await Bun.file(abs).text();
  },
});

const harness =
  which === "claude"
    ? createClaudeCode({ startupTimeoutMs: 600_000 })
    : createCodex({ startupTimeoutMs: 600_000, reasoningEffort: "low" });
const model =
  which === "claude" ? "claude-haiku-4-5" : (process.env.SPIKE_CODEX_MODEL ?? "gpt-6-luna");
const common = {
  harness,
  model,
  sandboxConfig: { workDir: "." },
  ...(which === "claude"
    ? { permissionMode: "allow-reads" as const }
    : {
        permissionMode: "allow-all" as const,
        tools: { read_file: readFile },
        activeTools: ["read_file"],
      }),
};

async function withSession<T>(agent: HarnessAgent<any, any, any>, fn: (s: any) => Promise<T>) {
  const sandboxSession = await createLocalNetworkSandboxSession({
    workDir: repo,
    port: await freePort(),
  });
  const session = await agent.createSession({ sandboxSession });
  try {
    return await fn(session);
  } finally {
    await session.destroy();
    await sandboxSession.destroy();
  }
}

async function drain(result: any) {
  const approvals: any[] = [];
  const tools: string[] = [];
  for await (const part of result.fullStream) {
    if (part.type === "text-delta") process.stdout.write(part.text);
    else if (part.type === "tool-call")
      tools.push(`${part.toolName}(${JSON.stringify(part.input).slice(0, 80)})`);
    else if (part.type === "tool-approval-request") approvals.push(part);
    else if (part.type === "error") log("ERROR part", part.error);
  }
  process.stdout.write("\n");
  return {
    approvals,
    tools,
    usage: await result.totalUsage,
    finish: await result.finishReason,
    messages: (await result.response).messages,
  };
}

const agent = new HarnessAgent(common as any);

// 1+2+3: inspect, permissions, multi-turn
await withSession(agent, async (session) => {
  log("== turn 1: inspect");
  const r1 = await drain(
    await agent.stream({
      session,
      prompt:
        "Read src/auth.ts and describe it in one sentence. Then create a file NOTES.md in the repository containing the word x (use your file-writing tool if you have one; if you have none, say so).",
    }),
  );
  log(
    "tools",
    r1.tools,
    "approvals",
    r1.approvals.length,
    "finish",
    r1.finish,
    "usage",
    JSON.stringify(r1.usage),
  );
  if (r1.approvals.length > 0) {
    log("== deny approval");
    const r1b = await drain(
      await agent.stream({
        session,
        messages: [
          {
            role: "assistant",
            content: r1.approvals.flatMap((a) => [
              {
                type: "tool-call",
                toolCallId: a.toolCall.toolCallId,
                toolName: a.toolCall.toolName,
                input: a.toolCall.input,
                providerExecuted: true,
              },
              {
                type: "tool-approval-request",
                approvalId: a.approvalId,
                toolCallId: a.toolCall.toolCallId,
              },
            ]),
          },
          {
            role: "tool",
            content: r1.approvals.map((a) => ({
              type: "tool-approval-response",
              approvalId: a.approvalId,
              approved: false,
              reason: "crosscheck policy: repository files are read-only",
            })),
          },
        ],
      }),
    );
    log("after deny finish", r1b.finish, "tools", r1b.tools);
  }
  log("NOTES.md exists?", await Bun.file(path.join(repo, "NOTES.md")).exists());
  log("== turn 2: memory");
  const r2 = await drain(
    await agent.stream({
      session,
      prompt: "Without using any tools: what was the exact name of the function you read earlier?",
    }),
  );
  log("turn 2 tools", r2.tools, "finish", r2.finish);
});

// 4: structured output
const structured = new HarnessAgent({
  ...(common as any),
  output: Output.object({
    schema: z.object({
      findings: z.array(
        z.object({
          title: z.string(),
          severity: z.enum(["high", "medium", "low"]),
          file: z.string(),
        }),
      ),
    }),
  }),
});
await withSession(structured, async (session) => {
  log("== structured output");
  const r = await structured.generate({
    session,
    prompt: "Review src/auth.ts for security issues. Report findings.",
  });
  log("output", JSON.stringify(r.output));
});

// 5: cancellation
await withSession(agent, async (session) => {
  log("== cancellation");
  const ac = new AbortController();
  setTimeout(() => ac.abort(new Error("user cancelled")), 4000);
  try {
    const r = await agent.stream({
      session,
      abortSignal: ac.signal,
      prompt: "Write a 2000-word essay about timing attacks. Do not use tools.",
    });
    const d = await drain(r);
    log("cancel: stream ended, finish =", d.finish);
  } catch (e) {
    log("cancel: threw", (e as Error).message);
  }
});
log("done");
