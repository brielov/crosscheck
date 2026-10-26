import { tool, type ToolSet } from "ai";
import { realpath } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

// Read-only repository access executed by crosscheck itself. Agents get these
// tools instead of their built-in shell/file tools, so every permission check
// below is enforced in code regardless of what the prompt says.

const MAX_FILE_BYTES = 200_000;
const MAX_OUTPUT_CHARS = 30_000;
const MAX_LIST_ENTRIES = 1_000;
const CHECK_TIMEOUT_MS = 10 * 60_000;

/** Run artifacts (other agent's transcript, ledger) stay invisible to agents. */
const HIDDEN_DIRS = [".crosscheck", ".git"];
const SECRET_FILE =
  /^(?:\.env(?:\.(?!example$|sample$|template$)[\w.-]+)?|.*\.(?:pem|key|p12|pfx)|id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?|\.npmrc|\.netrc|\.pypirc)$/i;

const GIT_SUBCOMMANDS = new Set([
  "log",
  "show",
  "diff",
  "blame",
  "ls-files",
  "ls-tree",
  "status",
  "rev-parse",
  "shortlog",
  "describe",
  "cat-file",
  "branch",
  "tag",
]);
const GIT_FORBIDDEN_ARG =
  /^(?:--output|-o$|--ext-diff|--textconv|--no-index|--exec|--upload-pack|--receive-pack|--config-env|-c$|--git-dir|--work-tree|-d$|-D$|--delete|-m$|-M$|--move|-f$|--force|--set-upstream|--edit-description)/;
/** branch/tag only in listing form. */
const LISTING_ONLY = new Set(["branch", "tag"]);

export class ToolDenied extends Error {}

export interface RepoToolOptions {
  repo: string;
  /** Exact commands the agent may run via run_check. */
  checks: string[];
  onCheck?: (result: { command: string; exitCode: number | null; output: string }) => void;
}

/** Resolve a repository-relative path, rejecting escapes, hidden run data and secret files. */
export async function resolveRepoPath(repo: string, p: string): Promise<string> {
  const root = await realpath(repo);
  const abs = path.resolve(root, p);
  let real: string;
  try {
    real = await realpath(abs);
  } catch {
    real = abs; // non-existent: still validate the lexical path
  }
  for (const candidate of [abs, real]) {
    const rel = path.relative(root, candidate);
    if (rel.startsWith("..") || path.isAbsolute(rel))
      throw new ToolDenied(`${p}: outside the repository`);
    const parts = rel.split(path.sep);
    if (parts.some((part) => HIDDEN_DIRS.includes(part)))
      throw new ToolDenied(`${p}: not accessible to agents`);
    if (SECRET_FILE.test(path.basename(candidate)))
      throw new ToolDenied(`${p}: possible secrets file; not accessible`);
  }
  return real;
}

function isVisible(rel: string): boolean {
  const parts = rel.split("/");
  return !parts.some((part) => HIDDEN_DIRS.includes(part)) && !SECRET_FILE.test(parts.at(-1) ?? "");
}

async function exec(cmd: string[], cwd: string, timeoutMs = 60_000, signal?: AbortSignal) {
  const proc = Bun.spawn(cmd, {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
    timeout: timeoutMs,
    signal,
    env: {
      ...process.env,
      GIT_PAGER: "cat",
      PAGER: "cat",
      GIT_TERMINAL_PROMPT: "0",
      GIT_OPTIONAL_LOCKS: "0",
    },
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, exitCode };
}

function clip(s: string, max = MAX_OUTPUT_CHARS): string {
  return s.length <= max ? s : `${s.slice(0, max)}\n… [truncated ${s.length - max} chars]`;
}

export async function isGitRepo(repo: string): Promise<boolean> {
  const r = await exec(["git", "rev-parse", "--is-inside-work-tree"], repo).catch(() => null);
  return r?.exitCode === 0 && r.stdout.trim() === "true";
}

export async function readFileTool(
  repo: string,
  p: string,
  startLine?: number,
  endLine?: number,
): Promise<string> {
  const abs = await resolveRepoPath(repo, p);
  const file = Bun.file(abs);
  if (!(await file.exists())) throw new ToolDenied(`${p}: no such file`);
  if (file.size > MAX_FILE_BYTES && startLine == null) {
    throw new ToolDenied(`${p}: ${file.size} bytes; read a line range with start_line/end_line`);
  }
  const lines = (await file.text()).split("\n");
  const from = Math.max(1, startLine ?? 1);
  const to = Math.min(lines.length, endLine ?? lines.length);
  return clip(
    lines
      .slice(from - 1, to)
      .map((l, i) => `${from + i}\t${l}`)
      .join("\n"),
  );
}

export async function listFilesTool(repo: string, dir = ".", pattern?: string): Promise<string> {
  const base = await resolveRepoPath(repo, dir);
  const root = await realpath(repo);
  let files: string[];
  if (await isGitRepo(root)) {
    const r = await exec(
      [
        "git",
        "ls-files",
        "--cached",
        "--others",
        "--exclude-standard",
        "-z",
        "--",
        path.relative(root, base) || ".",
      ],
      root,
    );
    files = r.stdout.split("\0").filter(Boolean);
  } else {
    files = [];
    for await (const f of new Bun.Glob("**/*").scan({ cwd: base, dot: true, onlyFiles: true })) {
      if (f.includes("node_modules/")) continue;
      files.push(path.relative(root, path.join(base, f)));
    }
  }
  const glob = pattern ? new Bun.Glob(pattern) : undefined;
  const visible = files
    .filter((f) => isVisible(f) && (!glob || glob.match(f) || glob.match(path.basename(f))))
    .sort();
  const shown = visible.slice(0, MAX_LIST_ENTRIES);
  return (
    shown.join("\n") +
      (visible.length > shown.length
        ? `\n… ${visible.length - shown.length} more; narrow the path or pattern`
        : "") || "(no files)"
  );
}

export async function searchTool(
  repo: string,
  pattern: string,
  dir = ".",
  glob?: string,
  ignoreCase = false,
): Promise<string> {
  const base = await resolveRepoPath(repo, dir);
  const root = await realpath(repo);
  const git = await isGitRepo(root);
  const rel = path.relative(root, base);
  const include = glob ? `:(glob)${rel ? `${rel}/` : ""}**/${glob}` : rel || ".";
  const pathspec = [
    include,
    ":(exclude).crosscheck",
    ":(exclude,glob)**/.env*",
    ":(exclude,glob)**/*.pem",
    ":(exclude,glob)**/*.key",
  ];
  const args = [
    "git",
    "grep",
    "-n",
    "-I",
    "-E",
    "--full-name",
    ...(ignoreCase ? ["-i"] : []),
    ...(git ? ["--untracked"] : ["--no-index", "--exclude-standard"]),
    "-e",
    pattern,
    "--",
    ...pathspec,
  ];
  const r = await exec(args, root);
  if (r.exitCode === 1) return "(no matches)";
  if (r.exitCode !== 0) throw new ToolDenied(`search failed: ${r.stderr.trim()}`);
  const lines = r.stdout.split("\n").filter((l) => l && isVisible(l.split(":")[0] ?? ""));
  return clip(
    lines.slice(0, 400).join("\n") +
      (lines.length > 400 ? `\n… ${lines.length - 400} more matches` : ""),
  );
}

export function checkGitArgs(args: string[]): void {
  const [sub, ...rest] = args;
  if (!sub || !GIT_SUBCOMMANDS.has(sub)) {
    throw new ToolDenied(
      `git ${sub ?? ""}: only read-only subcommands are allowed (${[...GIT_SUBCOMMANDS].join(", ")})`,
    );
  }
  for (const a of rest) {
    if (GIT_FORBIDDEN_ARG.test(a)) throw new ToolDenied(`git ${sub}: argument ${a} is not allowed`);
  }
  if (LISTING_ONLY.has(sub) && rest.some((a) => !a.startsWith("-"))) {
    throw new ToolDenied(`git ${sub}: only listing is allowed (no names)`);
  }
}

export async function gitTool(repo: string, args: string[]): Promise<string> {
  checkGitArgs(args);
  const r = await exec(["git", "--no-pager", ...args], await realpath(repo));
  if (r.exitCode !== 0)
    throw new ToolDenied(`git exited ${r.exitCode}: ${clip(r.stderr.trim(), 2000)}`);
  return clip(r.stdout) || "(no output)";
}

export async function runCheckTool(
  opts: RepoToolOptions,
  command: string,
  signal?: AbortSignal,
): Promise<string> {
  if (!opts.checks.includes(command)) {
    throw new ToolDenied(
      opts.checks.length === 0
        ? "No verification commands are permitted for this run."
        : `Not permitted. Allowed commands (exact match): ${opts.checks.join(" | ")}`,
    );
  }
  const r = await exec(
    ["bash", "-c", command],
    await realpath(opts.repo),
    CHECK_TIMEOUT_MS,
    signal,
  );
  const output = clip(`${r.stdout}${r.stderr ? `\n[stderr]\n${r.stderr}` : ""}`, 20_000);
  opts.onCheck?.({ command, exitCode: r.exitCode, output });
  return `exit code ${r.exitCode}\n${output}`;
}

/** Wrap an executor so denials become tool errors the agent can read, not crashes. */
function safe<A>(fn: (args: A, signal?: AbortSignal) => Promise<string>) {
  return async (args: A, options?: { abortSignal?: AbortSignal }) => {
    try {
      return await fn(args, options?.abortSignal);
    } catch (e) {
      return `ERROR: ${(e as Error).message}`;
    }
  };
}

export function createRepoTools(opts: RepoToolOptions): ToolSet {
  const tools: ToolSet = {
    read_file: tool({
      description:
        "Read a text file from the repository with line numbers. Paths are relative to the repository root. For large files pass start_line/end_line.",
      inputSchema: z.object({
        path: z.string(),
        start_line: z.number().int().optional(),
        end_line: z.number().int().optional(),
      }),
      execute: safe(({ path: p, start_line, end_line }) =>
        readFileTool(opts.repo, p, start_line, end_line),
      ),
    }),
    list_files: tool({
      description:
        "List repository files (respects .gitignore). Optional directory and glob pattern such as '*.ts' or 'src/**/*.sql'.",
      inputSchema: z.object({ path: z.string().optional(), pattern: z.string().optional() }),
      execute: safe(({ path: p, pattern }) => listFilesTool(opts.repo, p ?? ".", pattern)),
    }),
    search: tool({
      description:
        "Search file contents with an extended regular expression (git grep). Returns path:line:text. Optional directory, filename glob and case-insensitivity.",
      inputSchema: z.object({
        pattern: z.string(),
        path: z.string().optional(),
        glob: z.string().optional(),
        ignore_case: z.boolean().optional(),
      }),
      execute: safe(({ pattern, path: p, glob, ignore_case }) =>
        searchTool(opts.repo, pattern, p ?? ".", glob, ignore_case ?? false),
      ),
    }),
    git: tool({
      description: `Run a read-only git command in the repository, e.g. ["log","--oneline","-20","--","src/db"]. Allowed subcommands: ${[...GIT_SUBCOMMANDS].join(", ")}.`,
      inputSchema: z.object({ args: z.array(z.string()) }),
      execute: safe(({ args }) => gitTool(opts.repo, args)),
    }),
  };
  if (opts.checks.length > 0) {
    tools.run_check = tool({
      description: `Run one of the user-approved verification commands in the repository and get its exit code and output. Allowed (exact match): ${opts.checks.map((c) => JSON.stringify(c)).join(", ")}`,
      inputSchema: z.object({ command: z.string() }),
      execute: safe(({ command }, signal) => runCheckTool(opts, command, signal)),
    });
  }
  return tools;
}
