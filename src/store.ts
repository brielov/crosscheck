import { appendFile, mkdir, rename } from "node:fs/promises";
import path from "node:path";

/**
 * Per-run directory under <repo>/.crosscheck/runs/<id>/. Every write is
 * incremental (JSONL appends, atomic JSON rewrites) so an interrupted run keeps
 * everything completed so far.
 */
export class RunStore {
  private constructor(
    readonly id: string,
    readonly dir: string,
  ) {}

  static async create(repo: string, id = newRunId()): Promise<RunStore> {
    const base = path.join(repo, ".crosscheck");
    const dir = path.join(base, "runs", id);
    await mkdir(path.join(dir, "plan"), { recursive: true });
    await mkdir(path.join(dir, "input"), { recursive: true });
    // Keep run artifacts out of the user's git status without touching their .gitignore.
    const ignore = path.join(base, ".gitignore");
    if (!(await Bun.file(ignore).exists())) await Bun.write(ignore, "*\n");
    return new RunStore(id, dir);
  }

  path(...parts: string[]): string {
    return path.join(this.dir, ...parts);
  }

  async writeText(rel: string, text: string): Promise<string> {
    const target = this.path(rel);
    await mkdir(path.dirname(target), { recursive: true });
    const tmp = `${target}.tmp-${process.pid}`;
    await Bun.write(tmp, text);
    await rename(tmp, target);
    return target;
  }

  writeJson(rel: string, data: unknown): Promise<string> {
    return this.writeText(rel, `${JSON.stringify(data, null, 2)}\n`);
  }

  async append(
    rel: "events.jsonl" | "transcript.jsonl",
    record: Record<string, unknown>,
  ): Promise<void> {
    await appendFile(
      this.path(rel),
      `${JSON.stringify({ at: new Date().toISOString(), ...record })}\n`,
    );
  }

  /** Save plan version N; also refreshes plan.md (the latest version). */
  async savePlan(version: number, text: string): Promise<string> {
    const versioned = await this.writeText(path.join("plan", `v${version}.md`), text);
    await this.writeText("plan.md", text);
    return versioned;
  }
}

export function newRunId(now = new Date()): string {
  const stamp = now.toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
  return `${stamp}-${crypto.randomUUID().slice(0, 4)}`;
}
