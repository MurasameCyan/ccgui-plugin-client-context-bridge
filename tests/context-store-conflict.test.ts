import { describe, expect, it } from "vitest";
import { createEmptyEnvelope } from "../src/protocol/schema";
import { ContextStore, type DocumentStorage } from "../src/storage/context-store";

const alwaysCurrent = () => true;

/**
 * A second host process holds the document. Its writes are invisible to our
 * in-memory CAS version, so `writeTextAtomic` rejects and `save` reloads to
 * decide what happened. `load()` also returns null when the document is
 * present but unreadable (corrupt main + corrupt backup, or an envelope
 * belonging to another workspace) — those must NOT be treated as "the
 * document was removed", because recreating with expectedVersion null
 * discards the other process's committed content.
 */
class ConflictStorage implements DocumentStorage {
  readonly files = new Map<string, { content: string; version: string }>();
  readonly writes: Array<{ path: string; expected: string | null }> = [];
  private counter = 0;
  getLocation = async () => ({ kind: "data" as const, path: "memory" });
  selectLocation = async () => ({ kind: "data" as const, path: "memory" });
  readText = async (path: string) => this.files.get(path) ?? null;
  writeTextAtomic = async (path: string, content: string, expectedVersion: string | null) => {
    this.writes.push({ path, expected: expectedVersion });
    const current = this.files.get(path);
    if ((current?.version ?? null) !== expectedVersion) {
      const error = new Error("version conflict") as Error & { code?: string };
      error.code = "DOCUMENT_STORAGE_CONFLICT";
      throw error;
    }
    const version = `v${++this.counter}`;
    if (current) this.files.set(`${path}.bak`, current);
    this.files.set(path, { content, version });
    return { version };
  };
  remove = async (path: string) => { this.files.delete(path); };
  list = async (prefix = "") => [...this.files.keys()].filter((key) => key.startsWith(prefix));
}

const envelope = () =>
  createEmptyEnvelope({ workspaceId: "w", engine: "claude", turnStatus: "completed", now: "2026-09-12T12:00:00.000Z" });

describe("cross-process save conflicts", () => {
  it("refuses to clobber an unreadable document that is still present", async () => {
    const storage = new ConflictStorage();
    // Another process committed content we cannot parse; both copies unreadable.
    storage.files.set("w.ccb", { content: "not json", version: "other-1" });
    storage.files.set("w.ccb.bak", { content: "also not json", version: "other-0" });

    await expect(
      new ContextStore(storage).save({ envelope: envelope(), version: "ours-stale", baseEnvelope: null }, alwaysCurrent),
    ).rejects.toThrow();

    // The other process's bytes survive: no blind expectedVersion-null rewrite.
    expect(storage.files.get("w.ccb")?.content).toBe("not json");
    expect(storage.writes.filter((write) => write.path === "w.ccb" && write.expected === null)).toEqual([]);
  });

  it("refuses to clobber a document owned by another workspace", async () => {
    const storage = new ConflictStorage();
    const foreign = createEmptyEnvelope({ workspaceId: "other", engine: "claude", turnStatus: "completed", now: "2026-09-12T12:00:00.000Z" });
    storage.files.set("w.ccb", { content: JSON.stringify(foreign), version: "other-1" });

    await expect(
      new ContextStore(storage).save({ envelope: envelope(), version: "ours-stale", baseEnvelope: null }, alwaysCurrent),
    ).rejects.toThrow();

    expect(JSON.parse(storage.files.get("w.ccb")!.content).workspaceId).toBe("other");
  });

  it("still recreates a document that is genuinely gone", async () => {
    const storage = new ConflictStorage();
    const result = await new ContextStore(storage).save(
      { envelope: envelope(), version: "stale-from-deleted-doc", baseEnvelope: null },
      alwaysCurrent,
    );

    expect(result?.status).toBe("saved");
    expect(storage.files.has("w.ccb")).toBe(true);
  });
});
