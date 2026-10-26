import type { RunEvent } from "./orchestrator.ts";
import { formatDuration } from "./report.ts";
import type { FindingStatus } from "./types.ts";

const color = process.stderr.isTTY && !process.env.NO_COLOR;
const paint = (code: number) => (s: string) => (color ? `\x1b[${code}m${s}\x1b[0m` : s);
export const dim = paint(2);
export const bold = paint(1);
export const red = paint(31);
export const green = paint(32);
export const yellow = paint(33);
export const cyan = paint(36);

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

function describeActivity(name: string, input: unknown): string {
  const i = (input ?? {}) as Record<string, unknown>;
  const detail =
    i.path ??
    i.pattern ??
    (Array.isArray(i.args) ? i.args.join(" ") : undefined) ??
    i.command ??
    "";
  return `${name} ${String(detail)}`.trim();
}

/**
 * Terminal progress: a single redrawn status line (agent, phase, round,
 * finding counts, elapsed) plus milestone lines. With verbose, agent text and
 * tool calls stream to stderr instead of the status line.
 */
export function createProgress(opts: { verbose: boolean; maxRounds: number }) {
  const out = process.stderr;
  const live = out.isTTY === true && !opts.verbose;
  const started = Date.now();
  let frame = 0;
  let round = 0;
  let agent = "";
  let phase = "starting";
  let last = "";
  let counts: Record<FindingStatus, number> | null = null;
  let midText = false;

  const statusLine = () => {
    const c = counts
      ? `findings ${counts.open} open · ${counts.addressed} addressed · ${counts.disputed} disputed · ${counts.verified + counts.withdrawn} resolved`
      : "no findings yet";
    const parts = [
      `${cyan(FRAMES[frame % FRAMES.length]!)} ${formatDuration(Date.now() - started)}`,
      round > 0 ? `round ${round}/${opts.maxRounds}` : "setup",
      agent ? bold(agent) : "",
      phase,
      c,
      last ? dim(last) : "",
    ].filter(Boolean);
    const line = parts.join(dim(" │ "));
    const width = out.columns ?? 120;
    // Strip ANSI for width accounting, then cut the visible text.
    const visible = Bun.stripANSI(line);
    return visible.length > width - 1 ? `${visible.slice(0, width - 2)}…` : line;
  };
  const clear = () => live && out.write("\r\x1b[2K");
  const draw = () => live && out.write(`\r\x1b[2K${statusLine()}`);
  const timer = live ? setInterval(() => (frame++, draw()), 120) : undefined;

  const log = (line: string) => {
    clear();
    if (midText) {
      out.write("\n");
      midText = false;
    }
    out.write(`${line}\n`);
    draw();
  };

  return {
    log,
    handle(e: RunEvent) {
      switch (e.type) {
        case "phase":
          round = e.round;
          agent = e.agent ?? "";
          phase = e.phase;
          last = "";
          if (e.agent)
            log(`${cyan("▸")} ${round > 0 ? `Round ${round} · ` : ""}${bold(e.agent)}: ${e.phase}`);
          break;
        case "findings":
          counts = e.counts;
          for (const f of e.raised)
            log(`  ${yellow("+")} ${f.id} [${f.severity}/${f.category}] ${f.title}`);
          for (const f of e.resolved) log(`  ${green("✓")} ${f.id} ${f.status}`);
          if (e.raised.length === 0 && e.resolved.length === 0)
            log(dim("  no new findings, none resolved"));
          break;
        case "plan":
          log(`  ${green("✎")} plan v${e.version} saved ${dim(e.path)}`);
          break;
        case "note":
          log(`  ${yellow("!")} ${e.message}`);
          break;
        case "activity": {
          const a = e.activity;
          if (a.kind === "status") last = a.message;
          if (a.kind === "tool-call") last = describeActivity(a.name, a.input);
          if (!opts.verbose) break;
          if (a.kind === "text") {
            out.write(dim(a.delta));
            midText = !a.delta.endsWith("\n");
          } else if (a.kind === "tool-call") {
            log(dim(`  · ${e.agent} → ${describeActivity(a.name, a.input)}`));
          } else if (a.kind === "tool-result" && !a.ok) {
            log(dim(`  · ${a.name} ✗ ${a.summary}`));
          } else if (a.kind === "status") {
            log(dim(`  · ${a.message}`));
          }
          break;
        }
      }
    },
    stop() {
      if (timer) clearInterval(timer);
      clear();
    },
  };
}
