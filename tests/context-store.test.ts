import { describe, expect, it } from "vitest";
import { createEmptyEnvelope } from "../src/protocol/schema";
import { ContextStore, type DocumentStorage } from "../src/storage/context-store";

class MemoryStorage implements DocumentStorage {
  readonly files = new Map<string, { content: string; version: string }>();
  private counter = 0;
  getLocation = async () => ({ kind: "data" as const, path: "memory" });
  selectLocation = async () => ({ kind: "data" as const, path: "memory" });
  readText = async (path: string) => this.files.get(path) ?? null;
  writeTextAtomic = async (path: string, content: string, expectedVersion: string | null) => {
    const current = this.files.get(path);
    if ((current?.version ?? null) !== expectedVersion) throw new Error("version conflict");
    const version = String(++this.counter);
    if (current) this.files.set(`${path}.bak`, current);
    this.files.set(path, { content, version });
    return { version };
  };
  remove = async (path: string) => { this.files.delete(path); };
  list = async (prefix = "") => [...this.files.keys()].filter((key) => key.startsWith(prefix));
}

describe("context store", () => {
  it("recovers from a corrupt main document using its backup", async () => {
    const storage = new MemoryStorage();
    const envelope = createEmptyEnvelope({ workspaceId: "w", engine: "claude", turnStatus: "completed", now: "2026-09-12T12:00:00.000Z" });
    storage.files.set("w.ccb", { content: "broken", version: "v2" });
    storage.files.set("w.ccb.bak", { content: JSON.stringify(envelope), version: "v1" });

    const loaded = await new ContextStore(storage).load("w");
    expect(loaded?.envelope).toEqual(expect.objectContaining({ workspaceId: "w" }));
    expect(loaded?.envelope.provenance).toMatchObject({ degraded: true, degradedReasons: ["backup-recovered"] });
    expect(loaded?.version).toBe("v2");
  });

  it("uses opaque CAS and safely merges stable IDs on conflict without overwriting scalar changes", async () => {
    const storage = new MemoryStorage();
    const store = new ContextStore(storage);
    const original = createEmptyEnvelope({ workspaceId: "w", engine: "claude", turnStatus: "completed", now: "2026-09-12T12:00:00.000Z" });
    const first = await store.save({ envelope: original, version: null, baseEnvelope: null });

    const ours = structuredClone(first.envelope);
    ours.task.goal = "ours";
    ours.task.remaining.push({ id: "ours-id", text: "Our item", source: "agent-reported", updatedAt: ours.updatedAt });
    const theirs = structuredClone(first.envelope);
    theirs.task.goal = "theirs";
    theirs.task.remaining.push({ id: "theirs-id", text: "Their item", source: "host-observed", updatedAt: theirs.updatedAt });
    await store.save({ envelope: theirs, version: first.version, baseEnvelope: first.envelope });

    const result = await store.save({ envelope: ours, version: first.version, baseEnvelope: first.envelope });
    expect(result.status).toBe("conflict");
    expect(result.envelope.task.goal).toBe("theirs");
    expect(result.envelope.task.remaining.map((item) => item.id)).toEqual(["theirs-id", "ours-id"]);
    expect(result.envelope.provenance.degradedReasons).toContain("concurrent-write-conflict");
    expect([...storage.files.keys()].some((path) => path.includes(".conflict-"))).toBe(true);
  });

  it("persists consumption without incrementing task content revision", async () => {
    const storage = new MemoryStorage();
    const store = new ContextStore(storage);
    const envelope = createEmptyEnvelope({ workspaceId: "w", engine: "claude", turnStatus: "completed", now: "2026-09-12T12:00:00.000Z" });
    const first = await store.save({ envelope, version: null, baseEnvelope: null });
    const consumed = await store.markConsumed(first, { targetEngine: "codex", targetSessionId: "s1", consumedAt: "2026-09-12T12:01:00.000Z" });
    expect(consumed.envelope.revision).toBe(0);
    expect(consumed.envelope.consumption[0].consumedRevision).toBe(0);
  });

  it("returns no context when main and backup are both corrupt", async () => {
    const storage = new MemoryStorage();
    storage.files.set("w.ccb", { content: "bad-main", version: "v2" });
    storage.files.set("w.ccb.bak", { content: "bad-backup", version: "v1" });
    await expect(new ContextStore(storage).load("w")).resolves.toBeNull();
  });

  it("does not auto-merge conflicting edits of an existing stable ID", async () => {
    const storage = new MemoryStorage();
    const store = new ContextStore(storage);
    const original = createEmptyEnvelope({ workspaceId: "w", engine: "claude", turnStatus: "completed", now: "2026-09-12T12:00:00.000Z" });
    original.task.remaining.push({ id: "shared", text: "base", source: "agent-reported", updatedAt: original.updatedAt });
    const first = await store.save({ envelope: original, version: null, baseEnvelope: null });
    const ours = structuredClone(first.envelope);
    ours.task.remaining[0]!.text = "ours";
    const theirs = structuredClone(first.envelope);
    theirs.task.remaining[0]!.text = "theirs";
    await store.save({ envelope: theirs, version: first.version, baseEnvelope: first.envelope });
    const result = await store.save({ envelope: ours, version: first.version, baseEnvelope: first.envelope });
    expect(result.envelope.task.remaining).toEqual([expect.objectContaining({ id: "shared", text: "theirs" })]);
  });

  it("rejects an envelope belonging to another workspace", async () => {
    const storage = new MemoryStorage();
    const other = createEmptyEnvelope({ workspaceId: "other", engine: "claude", turnStatus: "completed", now: "2026-09-12T12:00:00.000Z" });
    storage.files.set("w.ccb", { content: JSON.stringify(other), version: "v1" });
    await expect(new ContextStore(storage).load("w")).resolves.toBeNull();
  });

  it("consumption does not refresh content age", async () => {
    const storage = new MemoryStorage();
    const store = new ContextStore(storage);
    const envelope = createEmptyEnvelope({ workspaceId: "w", engine: "claude", turnStatus: "completed", now: "2026-09-01T12:00:00.000Z" });
    const first = await store.save({ envelope, version: null, baseEnvelope: null });
    const consumed = await store.markConsumed(first, { targetEngine: "codex", targetSessionId: "s1", consumedAt: "2026-09-12T12:01:00.000Z" });
    expect(consumed.envelope.updatedAt).toBe("2026-09-01T12:00:00.000Z");
  });

  it("preserves revision when concurrent writes only change consumption", async () => {
    const storage = new MemoryStorage();
    const store = new ContextStore(storage);
    const original = createEmptyEnvelope({ workspaceId: "w", engine: "claude", turnStatus: "completed", now: "2026-09-12T12:00:00.000Z" });
    const first = await store.save({ envelope: original, version: null, baseEnvelope: null });
    await store.markConsumed(first, { targetEngine: "codex", targetSessionId: "s1", consumedAt: "2026-09-12T12:01:00.000Z" });
    const conflicted = await store.markConsumed(first, { targetEngine: "omp", targetSessionId: "s2", consumedAt: "2026-09-12T12:02:00.000Z" });
    expect(conflicted.envelope.revision).toBe(0);
    expect(conflicted.envelope.consumption).toHaveLength(2);
  });

  it("keeps a concurrent stable-ID deletion when the other side is unchanged", async () => {
    const storage = new MemoryStorage();
    const store = new ContextStore(storage);
    const original = createEmptyEnvelope({ workspaceId: "w", engine: "claude", turnStatus: "completed", now: "2026-09-12T12:00:00.000Z" });
    original.task.remaining.push({ id: "shared", text: "base", source: "agent-reported", updatedAt: original.updatedAt });
    const first = await store.save({ envelope: original, version: null, baseEnvelope: null });
    const deleted = structuredClone(first.envelope);
    deleted.task.remaining = [];
    await store.save({ envelope: deleted, version: first.version, baseEnvelope: first.envelope });
    const result = await store.save({ envelope: structuredClone(first.envelope), version: first.version, baseEnvelope: first.envelope });
    expect(result.envelope.task.remaining).toEqual([]);
  });

  it("recreates the document with expectedVersion null when a CAS conflict finds it gone", async () => {
    const storage = new MemoryStorage();
    const store = new ContextStore(storage);
    const envelope = createEmptyEnvelope({ workspaceId: "w", engine: "claude", turnStatus: "completed", now: "2026-09-12T12:00:00.000Z" });
    const first = await store.save({ envelope, version: null, baseEnvelope: null });
    storage.files.delete("w.ccb");

    const result = await store.save({ envelope: structuredClone(first.envelope), version: first.version, baseEnvelope: first.baseEnvelope });
    expect(result.status).toBe("saved");
    expect(result.version).not.toBe(first.version);
    const reloaded = await new ContextStore(storage).load("w");
    expect(reloaded?.envelope).toMatchObject({ workspaceId: "w" });
    expect(reloaded?.version).toBe(result.version);
  });
});
