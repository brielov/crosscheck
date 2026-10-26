import { tool, type ToolSet } from "ai";
import { createReadStream } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
import { z } from "zod";
import { readOutput, spawnProcess } from "./process.ts";

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
  /^(?:\.env(?!\.(?:example|sample|template)$).*|.*\.(?:pem|key|p12|pfx)|id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?|\.npmrc|\.netrc|\.pypirc)$/i;

// Only exact, known options are accepted. Git's read commands can otherwise
// write configuration, read arbitrary files, or launch external programs.
const DIFF_FLAGS = [
  "-p",
  "-u",
  "--patch",
  "--stat",
  "--numstat",
  "--shortstat",
  "--name-only",
  "--name-status",
  "--no-patch",
  "--no-color",
  "--no-ext-diff",
  "--no-textconv",
  "--no-renames",
  "-w",
  "-b",
  "--ignore-space-at-eol",
];
const GIT_FLAGS: Record<string, readonly string[]> = {
  log: [
    ...DIFF_FLAGS,
    "--oneline",
    "--all",
    "--first-parent",
    "--reverse",
    "--no-merges",
    "--merges",
    "--graph",
    "--decorate",
  ],
  show: [...DIFF_FLAGS, "--oneline"],
  diff: [...DIFF_FLAGS, "--cached", "--staged"],
  blame: ["--line-porcelain", "--porcelain", "--no-progress", "-w", "-s", "-e"],
  "ls-files": ["--cached", "--others", "--exclude-standard", "--modified", "--deleted"],
  status: [
    "--short",
    "-s",
    "--branch",
    "-b",
    "--porcelain",
    "--porcelain=v1",
    "--untracked-files=all",
    "--untracked-files=normal",
    "--untracked-files=no",
  ],
  "rev-parse": ["--short", "--abbrev-ref", "--show-toplevel", "--is-inside-work-tree"],
  branch: ["--list", "--all", "-a", "--remotes", "-r", "--show-current", "-v", "-vv", "--no-color"],
  tag: ["--list", "-l"],
};
const GIT_SUBCOMMANDS = new Set(Object.keys(GIT_FLAGS));
const PATH_COMMANDS = new Set(["log", "show", "diff", "blame", "ls-files", "status"]);
const REVISION_COMMANDS = new Set(["log", "show", "diff", "blame", "rev-parse"]);
const REVISION = /^[A-Za-z0-9_][A-Za-z0-9_./-]*(?:[~^][0-9]*)*$/;
// Exclude protected paths even from historical patches and directory queries.
// History conservatively excludes environment templates as well.
const GIT_EXCLUDES = [
  ...HIDDEN_DIRS.flatMap((dir) => [`**/${dir}`, `**/${dir}/**`]),
  ...[
    ".env*",
    "*.pem",
    "*.key",
    "*.p12",
    "*.pfx",
    "id_rsa*",
    "id_dsa*",
    "id_ecdsa*",
    "id_ed25519*",
    ".npmrc",
    ".netrc",
    ".pypirc",
  ].map((name) => `**/${name}`),
].map((glob) => `:(exclude,glob,icase)${glob}`);
const SAFE_GIT = [
  "git",
  "--no-pager",
  "-c",
  "core.fsmonitor=false",
  "-c",
  "log.showSignature=false",
  "-c",
  "format.pretty=medium",
  "-c",
  "color.ui=false",
];

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
    if (rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel))
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
  const managed = spawnProcess(cmd, {
    cwd,
    timeoutMs,
    signal,
    env: {
      ...process.env,
      GIT_PAGER: "cat",
      PAGER: "cat",
      GIT_TERMINAL_PROMPT: "0",
      GIT_OPTIONAL_LOCKS: "0",
    },
  });
  const { proc, exited } = managed;
  const [stdout, stderr, exitCode] = await Promise.all([
    readOutput(proc.stdout),
    readOutput(proc.stderr),
    exited,
  ]);
  return { stdout, stderr, exitCode: managed.interrupted ? null : exitCode };
}

function clip(s: string, max = MAX_OUTPUT_CHARS): string {
  return s.length <= max ? s : `${s.slice(0, max)}\n… [truncated ${s.length - max} chars]`;
}

export async function isGitRepo(repo: string, signal?: AbortSignal): Promise<boolean> {
  const r = await exec(
    [...SAFE_GIT, "rev-parse", "--is-inside-work-tree"],
    repo,
    60_000,
    signal,
  ).catch(() => null);
  signal?.throwIfAborted();
  return r?.exitCode === 0 && r.stdout.trim() === "true";
}

export async function readFileTool(
  repo: string,
  p: string,
  startLine?: number,
  endLine?: number,
  signal?: AbortSignal,
): Promise<string> {
  signal?.throwIfAborted();
  if (
    (startLine != null && (!Number.isInteger(startLine) || startLine < 1)) ||
    (endLine != null && (!Number.isInteger(endLine) || endLine < (startLine ?? 1)))
  )
    throw new ToolDenied("line range must use positive integers with end_line >= start_line");
  const abs = await resolveRepoPath(repo, p);
  const info = await stat(abs).catch(() => null);
  if (!info?.isFile()) throw new ToolDenied(`${p}: no such regular file`);
  if (info.size > MAX_FILE_BYTES && startLine == null) {
    throw new ToolDenied(`${p}: ${info.size} bytes; read a line range with start_line/end_line`);
  }
  const stream = createReadStream(abs, { encoding: "utf8", signal });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  let lineNumber = 0;
  let output = "";
  try {
    for await (const line of lines) {
      signal?.throwIfAborted();
      lineNumber++;
      if (lineNumber < (startLine ?? 1)) continue;
      output += `${output ? "\n" : ""}${lineNumber}\t${line}`;
      if (output.length > MAX_OUTPUT_CHARS) return clip(output);
      if (endLine != null && lineNumber >= endLine) break;
    }
    return output;
  } finally {
    lines.close();
    stream.destroy();
  }
}

export async function listFilesTool(
  repo: string,
  dir = ".",
  pattern?: string,
  signal?: AbortSignal,
): Promise<string> {
  const base = await resolveRepoPath(repo, dir);
  const root = await realpath(repo);
  let files: string[];
  if (await isGitRepo(root, signal)) {
    const r = await exec(
      [
        ...SAFE_GIT,
        "ls-files",
        "--cached",
        "--others",
        "--exclude-standard",
        "-z",
        "--",
        `:(literal)${path.relative(root, base) || "."}`,
      ],
      root,
      60_000,
      signal,
    );
    if (r.exitCode !== 0) throw new ToolDenied(`listing failed: ${r.stderr.trim()}`);
    files = r.stdout.split("\0").filter(Boolean);
  } else {
    files = [];
    for await (const f of new Bun.Glob("**/*").scan({ cwd: base, dot: true, onlyFiles: true })) {
      signal?.throwIfAborted();
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
  signal?: AbortSignal,
): Promise<string> {
  const base = await resolveRepoPath(repo, dir);
  const root = await realpath(repo);
  const git = await isGitRepo(root, signal);
  const rel = path.relative(root, base);
  const include = glob ? `:(glob)${rel ? `${rel}/` : ""}**/${glob}` : `:(literal)${rel || "."}`;
  const pathspec = [include, ...GIT_EXCLUDES];
  const args = [
    ...SAFE_GIT,
    "grep",
    "-n",
    "-z",
    "-I",
    "-E",
    "--no-textconv",
    ...(ignoreCase ? ["-i"] : []),
    ...(git ? ["--untracked"] : ["--no-index", "--exclude-standard"]),
    "-e",
    pattern,
    "--",
    ...pathspec,
  ];
  const r = await exec(args, root, 60_000, signal);
  if (r.exitCode === 1) return "(no matches)";
  if (r.exitCode !== 0) throw new ToolDenied(`search failed: ${r.stderr.trim()}`);
  const lines: string[] = [];
  for (const match of r.stdout.matchAll(/([^\0]+)\0(\d+)\0([^\n]*)\n/g)) {
    if (isVisible(match[1]!)) lines.push(`${match[1]}:${match[2]}:${match[3]}`);
  }
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
  let paths = false;
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (a === "--" && PATH_COMMANDS.has(sub) && !paths) {
      paths = true;
      continue;
    }
    if (paths) {
      if (!a || a.startsWith(":") || path.isAbsolute(a) || a.split("/").includes(".."))
        throw new ToolDenied(`git ${sub}: invalid repository path ${a}`);
      continue;
    }
    if (GIT_FLAGS[sub]!.includes(a)) continue;
    if (
      (sub === "log" || sub === "show") &&
      /^(?:-[0-9]+|--max-count=[0-9]+|--(?:format|pretty)=(?:oneline|short|medium|full|fuller|reference)|--date=(?:short|iso|iso-strict|relative|default))$/.test(
        a,
      )
    )
      continue;
    if (["log", "show", "diff"].includes(sub) && /^(?:-U[0-9]+|--unified=[0-9]+)$/.test(a))
      continue;
    if (
      sub === "log" &&
      (a === "-n" || a === "--max-count") &&
      /^[0-9]+$/.test(rest[i + 1] ?? "")
    ) {
      i++;
      continue;
    }
    if (sub === "blame" && a === "-L" && /^[0-9]+,[0-9]+$/.test(rest[i + 1] ?? "")) {
      i++;
      continue;
    }
    if (REVISION_COMMANDS.has(sub) && a.split(/\.{2,3}/).every((r) => REVISION.test(r))) continue;
    throw new ToolDenied(
      `git ${sub}: argument ${a} is not allowed; put literal repository paths after --`,
    );
  }
}

export async function gitTool(repo: string, args: string[], signal?: AbortSignal): Promise<string> {
  checkGitArgs(args);
  const root = await realpath(repo);
  const sub = args[0]!;
  const separator = args.indexOf("--");
  const options = args.slice(1, separator < 0 ? undefined : separator);
  const paths = separator < 0 ? [] : args.slice(separator + 1);
  for (const p of paths) await resolveRepoPath(root, p);
  // A blob SHA passed to `show` bypasses pathspec filtering. Resolve every
  // revision to a commit before letting Git render any content.
  if (REVISION_COMMANDS.has(sub)) {
    for (let i = 0; i < options.length; i++) {
      const a = options[i]!;
      if (["-n", "--max-count", "-L"].includes(a)) {
        i++;
        continue;
      }
      if (a.startsWith("-")) continue;
      for (const rev of a.split(/\.{2,3}/)) {
        const resolved = await exec(
          [...SAFE_GIT, "rev-parse", "--verify", "--end-of-options", `${rev}^{commit}`],
          root,
          60_000,
          signal,
        );
        if (resolved.exitCode !== 0) throw new ToolDenied(`git ${sub}: ${rev} is not a commit`);
      }
    }
  }
  if (sub === "blame" && paths.length !== 1)
    throw new ToolDenied("git blame: supply one repository file after --");
  const safeOptions = ["log", "show", "diff"].includes(sub)
    ? ["--no-ext-diff", "--no-textconv", "--no-renames", "--no-color"]
    : sub === "blame"
      ? ["--no-textconv"]
      : [];
  const scope = PATH_COMMANDS.has(sub)
    ? [
        "--",
        ...(paths.length ? paths : ["."]).map((p) => (sub === "blame" ? p : `:(literal)${p}`)),
        ...(sub === "blame" ? [] : GIT_EXCLUDES),
      ]
    : [];
  const r = await exec(
    [...SAFE_GIT, sub, ...options, ...safeOptions, ...scope],
    root,
    60_000,
    signal,
  );
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
  const output = clip(
    `${r.exitCode == null ? "Command interrupted by cancellation or timeout.\n" : ""}${r.stdout}${r.stderr ? `\n[stderr]\n${r.stderr}` : ""}`,
    20_000,
  );
  opts.onCheck?.({ command, exitCode: r.exitCode, output });
  return `exit code ${r.exitCode}\n${output}`;
}

/** Wrap an executor so denials become tool errors the agent can read, not crashes. */
function safe<A>(fn: (args: A, signal?: AbortSignal) => Promise<string>) {
  return async (args: A, options?: { abortSignal?: AbortSignal }) => {
    try {
      options?.abortSignal?.throwIfAborted();
      return await fn(args, options?.abortSignal);
    } catch (e) {
      options?.abortSignal?.throwIfAborted();
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
        start_line: z.number().int().positive().optional(),
        end_line: z.number().int().positive().optional(),
      }),
      execute: safe(({ path: p, start_line, end_line }, signal) =>
        readFileTool(opts.repo, p, start_line, end_line, signal),
      ),
    }),
    list_files: tool({
      description:
        "List repository files (respects .gitignore). Optional directory and glob pattern such as '*.ts' or 'src/**/*.sql'.",
      inputSchema: z.object({ path: z.string().optional(), pattern: z.string().optional() }),
      execute: safe(({ path: p, pattern }, signal) =>
        listFilesTool(opts.repo, p ?? ".", pattern, signal),
      ),
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
      execute: safe(({ pattern, path: p, glob, ignore_case }, signal) =>
        searchTool(opts.repo, pattern, p ?? ".", glob, ignore_case ?? false, signal),
      ),
    }),
    git: tool({
      description: `Run a read-only git command in the repository, e.g. ["log","--oneline","-20","--","src/db"]. Allowed subcommands: ${[...GIT_SUBCOMMANDS].join(", ")}. Only common listing/history options are supported. Put literal paths after --. Revisions must name commits; use ["show","HEAD","--","file"] instead of HEAD:file.`,
      inputSchema: z.object({ args: z.array(z.string()) }),
      execute: safe(({ args }, signal) => gitTool(opts.repo, args, signal)),
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
