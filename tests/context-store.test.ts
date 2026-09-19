import { describe, expect, it, vi } from "vitest";
import { createEmptyEnvelope } from "../src/protocol/schema";
import { reduceContext } from "../src/state/reducer";
import { ContextStore, type DocumentReadResult, type DocumentStorage } from "../src/storage/context-store";

const alwaysCurrent = () => true;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

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

    const loaded = await new ContextStore(storage).load("w", alwaysCurrent);
    expect(loaded?.envelope).toEqual(expect.objectContaining({ workspaceId: "w" }));
    expect(loaded?.envelope.provenance).toMatchObject({ degraded: true, degradedReasons: ["backup-recovered"] });
    expect(loaded?.version).toBe("v2");
  });

  it("uses opaque CAS and safely merges stable IDs on conflict without overwriting scalar changes", async () => {
    const storage = new MemoryStorage();
    const store = new ContextStore(storage);
    const original = createEmptyEnvelope({ workspaceId: "w", engine: "claude", turnStatus: "completed", now: "2026-09-12T12:00:00.000Z" });
    const first = (await store.save({ envelope: original, version: null, baseEnvelope: null }, alwaysCurrent))!;

    const ours = structuredClone(first.envelope);
    ours.task.goal = "ours";
    ours.task.remaining.push({ id: "ours-id", text: "Our item", source: "agent-reported", updatedAt: ours.updatedAt });
    const theirs = structuredClone(first.envelope);
    theirs.task.goal = "theirs";
    theirs.task.remaining.push({ id: "theirs-id", text: "Their item", source: "host-observed", updatedAt: theirs.updatedAt });
    await store.save({ envelope: theirs, version: first.version, baseEnvelope: first.envelope }, alwaysCurrent);

    const result = (await store.save({ envelope: ours, version: first.version, baseEnvelope: first.envelope }, alwaysCurrent))!;
    expect(result.status).toBe("conflict");
    expect(result.envelope.task.goal).toBe("theirs");
    expect(result.envelope.task.remaining.map((item) => item.id)).toEqual(["theirs-id", "ours-id"]);
    expect(result.envelope.provenance.degradedReasons).toContain("concurrent-write-conflict");
    expect([...storage.files.keys()].some((path) => path.includes(".conflict-"))).toBe(true);
  });

  it("returns no context when main and backup are both corrupt", async () => {
    const storage = new MemoryStorage();
    storage.files.set("w.ccb", { content: "bad-main", version: "v2" });
    storage.files.set("w.ccb.bak", { content: "bad-backup", version: "v1" });
    await expect(new ContextStore(storage).load("w", alwaysCurrent)).resolves.toBeNull();
  });

  it("does not auto-merge conflicting edits of an existing stable ID", async () => {
    const storage = new MemoryStorage();
    const store = new ContextStore(storage);
    const original = createEmptyEnvelope({ workspaceId: "w", engine: "claude", turnStatus: "completed", now: "2026-09-12T12:00:00.000Z" });
    original.task.remaining.push({ id: "shared", text: "base", source: "agent-reported", updatedAt: original.updatedAt });
    const first = (await store.save({ envelope: original, version: null, baseEnvelope: null }, alwaysCurrent))!;
    const ours = structuredClone(first.envelope);
    ours.task.remaining[0]!.text = "ours";
    const theirs = structuredClone(first.envelope);
    theirs.task.remaining[0]!.text = "theirs";
    await store.save({ envelope: theirs, version: first.version, baseEnvelope: first.envelope }, alwaysCurrent);
    const result = (await store.save({ envelope: ours, version: first.version, baseEnvelope: first.envelope }, alwaysCurrent))!;
    expect(result.envelope.task.remaining).toEqual([expect.objectContaining({ id: "shared", text: "theirs" })]);
  });

  it("rejects an envelope belonging to another workspace", async () => {
    const storage = new MemoryStorage();
    const other = createEmptyEnvelope({ workspaceId: "other", engine: "claude", turnStatus: "completed", now: "2026-09-12T12:00:00.000Z" });
    storage.files.set("w.ccb", { content: JSON.stringify(other), version: "v1" });
    await expect(new ContextStore(storage).load("w", alwaysCurrent)).resolves.toBeNull();
  });

  it("merges concurrent consumption rows from both writers on conflict", async () => {
    const storage = new MemoryStorage();
    const store = new ContextStore(storage);
    const original = createEmptyEnvelope({ workspaceId: "w", engine: "claude", turnStatus: "completed", now: "2026-09-12T12:00:00.000Z" });
    const first = (await store.save({ envelope: original, version: null, baseEnvelope: null }, alwaysCurrent))!;
    const consumed = (targetEngine: string, targetSessionId: string, consumedAt: string) =>
      reduceContext(first.envelope, {
        now: consumedAt,
        consumption: { targetEngine, targetSessionId, consumedRevision: first.envelope.revision, consumedAt },
      });

    await store.save({ envelope: consumed("codex", "s1", "2026-09-12T12:01:00.000Z"), version: first.version, baseEnvelope: first.envelope }, alwaysCurrent);
    const conflicted = (await store.save({ envelope: consumed("omp", "s2", "2026-09-12T12:02:00.000Z"), version: first.version, baseEnvelope: first.envelope }, alwaysCurrent))!;

    expect(conflicted.status).toBe("conflict");
    expect(conflicted.envelope.revision).toBe(0);
    expect(conflicted.envelope.updatedAt).toBe(first.envelope.updatedAt);
    expect(conflicted.envelope.consumption.map((entry) => entry.targetSessionId).sort()).toEqual(["s1", "s2"]);
  });

  it("keeps a concurrent stable-ID deletion when the other side is unchanged", async () => {
    const storage = new MemoryStorage();
    const store = new ContextStore(storage);
    const original = createEmptyEnvelope({ workspaceId: "w", engine: "claude", turnStatus: "completed", now: "2026-09-12T12:00:00.000Z" });
    original.task.remaining.push({ id: "shared", text: "base", source: "agent-reported", updatedAt: original.updatedAt });
    const first = (await store.save({ envelope: original, version: null, baseEnvelope: null }, alwaysCurrent))!;
    const deleted = structuredClone(first.envelope);
    deleted.task.remaining = [];
    await store.save({ envelope: deleted, version: first.version, baseEnvelope: first.envelope }, alwaysCurrent);
    const result = (await store.save({ envelope: structuredClone(first.envelope), version: first.version, baseEnvelope: first.envelope }, alwaysCurrent))!;
    expect(result.envelope.task.remaining).toEqual([]);
  });

  it("recreates the document with expectedVersion null when a CAS conflict finds it gone", async () => {
    const storage = new MemoryStorage();
    const store = new ContextStore(storage);
    const envelope = createEmptyEnvelope({ workspaceId: "w", engine: "claude", turnStatus: "completed", now: "2026-09-12T12:00:00.000Z" });
    const first = (await store.save({ envelope, version: null, baseEnvelope: null }, alwaysCurrent))!;
    storage.files.delete("w.ccb");

    const result = (await store.save({ envelope: structuredClone(first.envelope), version: first.version, baseEnvelope: first.baseEnvelope }, alwaysCurrent))!;
    expect(result.status).toBe("saved");
    expect(result.version).not.toBe(first.version);
    const reloaded = await new ContextStore(storage).load("w", alwaysCurrent);
    expect(reloaded?.envelope).toMatchObject({ workspaceId: "w" });
    expect(reloaded?.version).toBe(result.version);
  });

  it("does not start I/O for an already stale load or save", async () => {
    const storage = new MemoryStorage();
    const read = vi.spyOn(storage, "readText");
    const write = vi.spyOn(storage, "writeTextAtomic");
    const store = new ContextStore(storage);
    const envelope = createEmptyEnvelope({ workspaceId: "w", engine: "claude", turnStatus: "completed", now: "2026-09-12T12:00:00.000Z" });

    await expect(store.load("w", () => false)).resolves.toBeNull();
    await expect(store.save({ envelope, version: null, baseEnvelope: null }, () => false)).resolves.toBeNull();
    expect(read).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
  });

  it("does not read the backup after cancellation during the main read", async () => {
    const storage = new MemoryStorage();
    const started = deferred<void>();
    const pending = deferred<DocumentReadResult | null>();
    const read = vi.spyOn(storage, "readText").mockImplementationOnce(() => {
      started.resolve();
      return pending.promise;
    });
    let current = true;
    const loading = new ContextStore(storage).load("w", () => current);
    await started.promise;
    expect(read.mock.calls).toEqual([["w.ccb"]]);

    current = false;
    pending.resolve({ content: "broken", version: "v1" });
    await expect(loading).resolves.toBeNull();
    expect(read.mock.calls).toEqual([["w.ccb"]]);
  });

  it.each(["main", "backup"] as const)("discards a %s read that settles after cancellation", async (document) => {
    const storage = new MemoryStorage();
    const envelope = createEmptyEnvelope({ workspaceId: "w", engine: "claude", turnStatus: "completed", now: "2026-09-12T12:00:00.000Z" });
    storage.files.set("w.ccb", { content: "broken", version: "v2" });
    const started = deferred<void>();
    const pending = deferred<DocumentReadResult | null>();
    const readText = storage.readText;
    const read = vi.spyOn(storage, "readText").mockImplementation((path) => {
      if (path === (document === "main" ? "w.ccb" : "w.ccb.bak")) {
        started.resolve();
        return pending.promise;
      }
      return readText(path);
    });
    let current = true;
    const loading = new ContextStore(storage).load("w", () => current);
    await started.promise;
    const expectedReads = document === "main" ? [["w.ccb"]] : [["w.ccb"], ["w.ccb.bak"]];
    expect(read.mock.calls).toEqual(expectedReads);

    current = false;
    pending.resolve({ content: JSON.stringify(envelope), version: "v1" });
    await expect(loading).resolves.toBeNull();
    expect(read.mock.calls).toEqual(expectedReads);
  });

  it.each(["main", "backup"] as const)("cancels a rejected %s read without starting more I/O", async (document) => {
    const storage = new MemoryStorage();
    const started = deferred<void>();
    const pending = deferred<DocumentReadResult | null>();
    const readText = storage.readText;
    const read = vi.spyOn(storage, "readText").mockImplementation((path) => {
      if (path === (document === "main" ? "w.ccb" : "w.ccb.bak")) {
        started.resolve();
        return pending.promise;
      }
      return readText(path);
    });
    let current = true;
    const loading = new ContextStore(storage).load("w", () => current);
    await started.promise;
    const expectedReads = document === "main" ? [["w.ccb"]] : [["w.ccb"], ["w.ccb.bak"]];
    expect(read.mock.calls).toEqual(expectedReads);

    current = false;
    pending.reject(new Error("read failed"));
    await expect(loading).resolves.toBeNull();
    expect(read.mock.calls).toEqual(expectedReads);
  });

  it.each([
    { stage: "initial successful write", existing: "missing", version: null, blocked: "write:w.ccb:1", calls: ["write:w.ccb:1"] },
    { stage: "initial rejected write", existing: "valid", version: "stale", blocked: "write:w.ccb:1", calls: ["write:w.ccb:1"] },
    { stage: "conflict reload", existing: "valid", version: "stale", blocked: "read:w.ccb", calls: ["write:w.ccb:1", "read:w.ccb"] },
    { stage: "backup conflict reload", existing: "corrupt", version: "stale", blocked: "read:w.ccb.bak", calls: ["write:w.ccb:1", "read:w.ccb", "read:w.ccb.bak"] },
    { stage: "missing-document reload", existing: "missing", version: "stale", blocked: "read:w.ccb.bak", calls: ["write:w.ccb:1", "read:w.ccb", "read:w.ccb.bak"] },
    // The recreate path now probes presence first (a null `load` can also mean
    // "present but unreadable"), so its read of the main document repeats.
    { stage: "recreated document write", existing: "missing", version: "stale", blocked: "write:w.ccb:2", calls: ["write:w.ccb:1", "read:w.ccb", "read:w.ccb.bak", "read:w.ccb", "write:w.ccb:2"] },
    { stage: "conflict artifact write", existing: "valid", version: "stale", blocked: "write:artifact", calls: ["write:w.ccb:1", "read:w.ccb", "write:artifact"] },
    { stage: "merged document write", existing: "valid", version: "stale", blocked: "write:w.ccb:2", calls: ["write:w.ccb:1", "read:w.ccb", "write:artifact", "write:w.ccb:2"] },
  ])("cancels a save during $stage without follow-up I/O or saved status", async ({ existing, version, blocked, calls: expectedCalls }) => {
    const storage = new MemoryStorage();
    const envelope = createEmptyEnvelope({ workspaceId: "w", engine: "claude", turnStatus: "completed", now: "2026-09-12T12:00:00.000Z" });
    if (existing !== "missing") {
      storage.files.set("w.ccb", { content: existing === "corrupt" ? "broken" : JSON.stringify(envelope), version: "v2" });
      storage.files.set("w.ccb.bak", { content: JSON.stringify(envelope), version: "v1" });
    }
    const started = deferred<void>();
    const release = deferred<void>();
    const calls: string[] = [];
    const pauseAt = async (call: string) => {
      calls.push(call);
      if (call === blocked) {
        started.resolve();
        await release.promise;
      }
    };
    const readText = storage.readText;
    vi.spyOn(storage, "readText").mockImplementation(async (path) => {
      await pauseAt(`read:${path}`);
      return readText(path);
    });
    const writeTextAtomic = storage.writeTextAtomic;
    let mainWrites = 0;
    vi.spyOn(storage, "writeTextAtomic").mockImplementation(async (path, content, expectedVersion) => {
      await pauseAt(path === "w.ccb" ? `write:w.ccb:${++mainWrites}` : "write:artifact");
      return writeTextAtomic(path, content, expectedVersion);
    });
    let current = true;
    const saving = new ContextStore(storage).save({ envelope, version, baseEnvelope: null }, () => current);
    await started.promise;
    expect(calls).toEqual(expectedCalls);

    current = false;
    release.resolve();
    await expect(saving).resolves.toBeNull();
    expect(calls).toEqual(expectedCalls);
  });

  it("preserves read and unchanged-version write errors while current", async () => {
    const storage = new MemoryStorage();
    const store = new ContextStore(storage);
    const readError = new Error("read denied");
    vi.spyOn(storage, "readText").mockRejectedValueOnce(readError);
    await expect(store.load("w", alwaysCurrent)).rejects.toBe(readError);

    const envelope = createEmptyEnvelope({ workspaceId: "w", engine: "claude", turnStatus: "completed", now: "2026-09-12T12:00:00.000Z" });
    storage.files.set("w.ccb", { content: JSON.stringify(envelope), version: "v1" });
    const writeError = new Error("write denied");
    const write = vi.spyOn(storage, "writeTextAtomic").mockRejectedValueOnce(writeError);
    await expect(store.save({ envelope, version: "v1", baseEnvelope: envelope }, alwaysCurrent)).rejects.toBe(writeError);
    expect(write).toHaveBeenCalledTimes(1);
  });
});
