import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { RunStore } from "../src/store.ts";

test("streamed records remain ordered and complete before flush returns", async () => {
  const repo = await mkdtemp(path.join(os.tmpdir(), "crosscheck-store-"));
  try {
    const store = await RunStore.create(repo);
    for (let i = 0; i < 100; i++)
      void store.append("transcript.jsonl", { i, text: "chunk\n".repeat(100) });
    await store.flush();
    const records = (await Bun.file(store.path("transcript.jsonl")).text())
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(records.map((record) => record.i)).toEqual(Array.from({ length: 100 }, (_, i) => i));
    expect(records.every((record) => record.text === "chunk\n".repeat(100))).toBe(true);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("event write failures surface at flush even when callbacks cannot await them", async () => {
  const repo = await mkdtemp(path.join(os.tmpdir(), "crosscheck-store-"));
  try {
    const store = await RunStore.create(repo);
    await rm(store.path("events.jsonl"));
    await mkdir(store.path("events.jsonl"));
    void store.append("events.jsonl", { type: "phase" });
    await expect(store.flush()).rejects.toThrow();
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});
