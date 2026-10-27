import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { repoIdentity, stripCredentials, workingTreeSnapshot } from "../src/repo.ts";

test("repository remote URLs do not persist passwords or query tokens", () => {
  expect(stripCredentials("https://user:password@example.com/repo.git?token=secret#secret")).toBe(
    "https://example.com/repo.git",
  );
  expect(stripCredentials("git@example.com:team/repo.git")).toBe("git@example.com:team/repo.git");
});

test("snapshots detect edits to existing untracked files and index changes without running diff helpers", async () => {
  const repo = await mkdtemp(path.join(os.tmpdir(), "crosscheck-snapshot-"));
  try {
    await Bun.$`git init -q`.cwd(repo).quiet();
    const empty = await workingTreeSnapshot(repo);
    await Bun.write(path.join(repo, "file.txt"), "first\n");
    const first = await workingTreeSnapshot(repo);
    expect(first).not.toBe(empty);
    await Bun.write(path.join(repo, "file.txt"), "second\n");
    expect(await workingTreeSnapshot(repo)).not.toBe(first);
    await Bun.$`git add . && git -c user.email=t@t -c user.name=t commit -qm fixture`
      .cwd(repo)
      .quiet();
    await Bun.write(path.join(repo, "file.txt"), "third\n");
    const unstaged = await workingTreeSnapshot(repo);
    await Bun.$`git add file.txt`.cwd(repo).quiet();
    expect(await workingTreeSnapshot(repo)).not.toBe(unstaged);
    await Bun.write(path.join(repo, "file.txt"), "fourth\n");
    await Bun.write(path.join(repo, ".gitattributes"), "*.txt diff=audit\n");
    await Bun.$`git config diff.audit.command "touch executed" && git config diff.audit.textconv "touch converted"`
      .cwd(repo)
      .quiet();
    await workingTreeSnapshot(repo);
    expect(await Bun.file(path.join(repo, "executed")).exists()).toBe(false);
    expect(await Bun.file(path.join(repo, "converted")).exists()).toBe(false);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("a repository with no commits yet still reports its branch", async () => {
  const repo = await mkdtemp(path.join(os.tmpdir(), "crosscheck-unborn-"));
  try {
    await Bun.$`git init -q -b trunk`.cwd(repo).quiet();
    const id = await repoIdentity(repo);
    expect(id.branch).toBe("trunk");
    expect(id.head).toBeNull();
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});
