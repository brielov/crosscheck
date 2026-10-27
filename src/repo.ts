import { lstat, readlink, realpath } from "node:fs/promises";
import path from "node:path";
import { spawnProcess } from "./agents/process.ts";

export interface RepoIdentity {
  root: string;
  isGit: boolean;
  head: string | null;
  branch: string | null;
  /** Remote URL with any embedded credentials removed. */
  remote: string | null;
  /** Number of modified/untracked paths at run start (excluding .crosscheck). */
  dirtyPaths: number;
}

async function git(cwd: string, args: string[], trim = true): Promise<string | null> {
  const { proc, exited } = spawnProcess(
    ["git", "--no-pager", "-c", "core.fsmonitor=false", ...args],
    {
      cwd,
      timeoutMs: 60_000,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" },
    },
  );
  const [out, , code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    exited,
  ]);
  return code === 0 ? (trim ? out.trim() : out) : null;
}

export function stripCredentials(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.username = "";
    parsed.password = "";
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return url.replace(/^([a-z][\w+.-]*:\/\/)[^@/]+@/i, "$1");
  }
}

export async function repoIdentity(repo: string): Promise<RepoIdentity> {
  const root = await realpath(repo);
  const top = await git(root, ["rev-parse", "--show-toplevel"]);
  if (top == null)
    return { root, isGit: false, head: null, branch: null, remote: null, dirtyPaths: 0 };
  const [head, branch, remote, status] = await Promise.all([
    git(root, ["rev-parse", "HEAD"]),
    // symbolic-ref also names the branch of a repository with no commits yet.
    git(root, ["symbolic-ref", "--short", "HEAD"]),
    git(root, ["remote", "get-url", "origin"]),
    git(root, [
      "status",
      "--porcelain=v1",
      "--untracked-files=all",
      "--",
      ".",
      ":(exclude).crosscheck",
    ]),
  ]);
  return {
    root,
    isGit: true,
    head,
    branch,
    remote: remote ? stripCredentials(remote) : null,
    dirtyPaths: status ? status.split("\n").filter(Boolean).length : 0,
  };
}

/**
 * Fingerprint of the working tree (status plus a hash of tracked changes),
 * excluding crosscheck's own run directory; null outside git. Used to detect
 * repository modifications during a run.
 */
export async function workingTreeSnapshot(repo: string): Promise<string | null> {
  const scope = ["--", ".", ":(exclude).crosscheck"];
  const diffFlags = ["--no-ext-diff", "--no-textconv", "--no-renames", "--binary"];
  const [top, status, diff, staged] = await Promise.all([
    git(repo, ["rev-parse", "--show-toplevel"]),
    git(
      repo,
      [
        "status",
        "--porcelain=v1",
        "-z",
        "--untracked-files=all",
        "--",
        ".",
        ":(exclude).crosscheck",
      ],
      false,
    ),
    git(repo, ["diff", ...diffFlags, ...scope]),
    git(repo, ["diff", "--cached", ...diffFlags, ...scope]),
  ]);
  if (status == null || top == null) return null;
  const hash = new Bun.CryptoHasher("sha256");
  hash
    .update(status)
    .update(diff ?? "")
    .update(staged ?? "");
  const entries = status.split("\0");
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]!;
    if (entry.startsWith("?? ")) {
      const file = path.join(top, entry.slice(3));
      const stat = await lstat(file);
      if (stat.isSymbolicLink()) hash.update(await readlink(file));
      else if (stat.isFile()) {
        for await (const chunk of Bun.file(file).stream()) hash.update(chunk);
      }
    } else if (/^[RC]|^.[RC]/.test(entry)) i++; // rename/copy source path
  }
  return hash.digest("hex");
}
