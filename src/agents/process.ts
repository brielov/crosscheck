/** Local commands own a process group so cancellation also stops their children. */
export function spawnProcess(
  command: string[],
  options: { cwd: string; env?: NodeJS.ProcessEnv; signal?: AbortSignal; timeoutMs?: number },
) {
  options.signal?.throwIfAborted();
  const proc = Bun.spawn(command, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
    detached: true,
  });
  let escalation: ReturnType<typeof setTimeout> | undefined;
  let interrupted = false;
  const killGroup = (signal: NodeJS.Signals) => {
    try {
      process.kill(-proc.pid, signal);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ESRCH") throw e;
    }
  };
  const stop = () => {
    interrupted = true;
    killGroup("SIGTERM");
    escalation ??= setTimeout(() => killGroup("SIGKILL"), 250);
  };
  const timeout = options.timeoutMs == null ? undefined : setTimeout(stop, options.timeoutMs);
  options.signal?.addEventListener("abort", stop, { once: true });
  const exited = proc.exited.finally(() => {
    // A shell may exit before descendants that ignored SIGTERM. Do not leave
    // those descendants running (or holding stdout/stderr open).
    killGroup("SIGKILL");
    clearTimeout(timeout);
    clearTimeout(escalation);
    options.signal?.removeEventListener("abort", stop);
  });
  return {
    proc,
    exited,
    stop,
    get interrupted() {
      return interrupted;
    },
  };
}

/** Drain the pipe without retaining unlimited test output in memory. */
export async function readOutput(
  stream: ReadableStream<Uint8Array>,
  limit = 1_000_000,
): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let truncated = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const part = decoder.decode(value, { stream: true });
      const remaining = limit - text.length;
      text += part.slice(0, remaining);
      if (part.length > remaining) truncated = true;
    }
    text += decoder.decode().slice(0, limit - text.length);
  } finally {
    reader.releaseLock();
  }
  return text + (truncated ? "\n… [output truncated]" : "");
}
