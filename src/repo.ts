import { realpath } from "node:fs/promises";

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

async function git(cwd: string, args: string[]): Promise<string | null> {
  const p = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "ignore", stdin: "ignore" });
  const [out, code] = await Promise.all([new Response(p.stdout).text(), p.exited]);
  return code === 0 ? out.trim() : null;
}

export function stripCredentials(url: string): string {
  return url.replace(/^([a-z][\w+.-]*:\/\/)[^@/]+@/i, "$1");
}

export async function repoIdentity(repo: string): Promise<RepoIdentity> {
  const root = await realpath(repo);
  const top = await git(root, ["rev-parse", "--show-toplevel"]);
  if (top == null)
    return { root, isGit: false, head: null, branch: null, remote: null, dirtyPaths: 0 };
  const [head, branch, remote, status] = await Promise.all([
    git(root, ["rev-parse", "HEAD"]),
    git(root, ["rev-parse", "--abbrev-ref", "HEAD"]),
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
  const [status, diff] = await Promise.all([
    git(repo, [
      "status",
      "--porcelain=v1",
      "--untracked-files=all",
      "--",
      ".",
      ":(exclude).crosscheck",
    ]),
    git(repo, ["diff", "HEAD", "--binary", "--", ".", ":(exclude).crosscheck"]),
  ]);
  if (status == null) return null;
  return `${status}\n#${Bun.hash(diff ?? "").toString(16)}`;
}
