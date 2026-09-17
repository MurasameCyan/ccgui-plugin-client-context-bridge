import { contentFingerprint, parseCcbEnvelope, type CcbEnvelopeV1, type CcbItem } from "../protocol/schema";

export type DocumentStorageLocationKind = "data" | "program" | "custom";
export interface ResolvedDocumentStorageLocation { kind: DocumentStorageLocationKind; path: string }
export interface DocumentReadResult { content: string; version: string }
export interface DocumentWriteResult { version: string }
export interface DocumentStorage {
  getLocation(): Promise<ResolvedDocumentStorageLocation>;
  selectLocation(kind: DocumentStorageLocationKind): Promise<ResolvedDocumentStorageLocation>;
  readText(relativePath: string): Promise<DocumentReadResult | null>;
  writeTextAtomic(relativePath: string, content: string, expectedVersion: string | null): Promise<DocumentWriteResult>;
  remove(relativePath: string, expectedVersion?: string | null): Promise<void>;
  list(prefix?: string): Promise<string[]>;
}

export interface StoredContext {
  envelope: CcbEnvelopeV1;
  version: string | null;
  baseEnvelope: CcbEnvelopeV1 | null;
}

export interface SaveResult extends StoredContext {
  status: "saved" | "conflict";
}

export class ContextStore {
  constructor(private readonly storage: DocumentStorage) {}

  async load(workspaceId: string, isCurrent: () => boolean): Promise<StoredContext | null> {
    if (!isCurrent()) return null;
    const path = contextPath(workspaceId);
    try {
      const main = await this.storage.readText(path);
      if (!isCurrent()) return null;
      if (main) {
        try {
          const envelope = parseCcbEnvelope(main.content);
          if (envelope.workspaceId !== workspaceId) throw new Error("workspace identity mismatch");
          return { envelope, version: main.version, baseEnvelope: structuredClone(envelope) };
        } catch {
          // Continue with the single backup while retaining main's CAS version.
        }
      }
      if (!isCurrent()) return null;
      const backup = await this.storage.readText(`${path}.bak`);
      if (!isCurrent()) return null;
      if (!backup) return null;
      try {
        const envelope = parseCcbEnvelope(backup.content);
        if (envelope.workspaceId !== workspaceId) throw new Error("workspace identity mismatch");
        addDegraded(envelope, "backup-recovered");
        return { envelope, version: main?.version ?? null, baseEnvelope: structuredClone(envelope) };
      } catch {
        return null;
      }
    } catch (error) {
      if (!isCurrent()) return null;
      throw error;
    }
  }

  async save(context: StoredContext, isCurrent: () => boolean): Promise<SaveResult | null> {
    if (!isCurrent()) return null;
    const path = contextPath(context.envelope.workspaceId);
    const serialized = serialize(context.envelope);
    try {
      try {
        if (!isCurrent()) return null;
        const written = await this.storage.writeTextAtomic(path, serialized, context.version);
        if (!isCurrent()) return null;
        return { envelope: context.envelope, version: written.version, baseEnvelope: structuredClone(context.envelope), status: "saved" };
      } catch (error) {
        if (!isCurrent()) return null;
        const latest = await this.load(context.envelope.workspaceId, isCurrent);
        if (!isCurrent()) return null;
        if (!latest) {
          // The document was removed under us (clear, another window, purge). A
          // stale in-memory version must not pin the workspace into write-failed.
          const written = await this.storage.writeTextAtomic(path, serialized, null);
          if (!isCurrent()) return null;
          return { envelope: context.envelope, version: written.version, baseEnvelope: structuredClone(context.envelope), status: "saved" };
        }
        if (latest.version === context.version) throw error;
        const merged = mergeConflict(context.baseEnvelope, context.envelope, latest.envelope);
        addDegraded(merged, "concurrent-write-conflict");
        const artifactPath = `${path}.conflict-${safeTimestamp()}`;
        if (!isCurrent()) return null;
        await this.storage.writeTextAtomic(artifactPath, serialize(context.envelope), null);
        if (!isCurrent()) return null;
        const written = await this.storage.writeTextAtomic(path, serialize(merged), latest.version);
        if (!isCurrent()) return null;
        return { envelope: merged, version: written.version, baseEnvelope: structuredClone(merged), status: "conflict" };
      }
    } catch (error) {
      if (!isCurrent()) return null;
      throw error;
    }
  }
}

function contextPath(workspaceId: string): string {
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(workspaceId) || workspaceId === "." || workspaceId === "..") throw new Error("workspaceId is unsafe for storage");
  return `${workspaceId}.ccb`;
}

function serialize(envelope: CcbEnvelopeV1): string {
  const content = JSON.stringify(envelope, null, 2);
  parseCcbEnvelope(content);
  return content;
}

function mergeConflict(base: CcbEnvelopeV1 | null, ours: CcbEnvelopeV1, theirs: CcbEnvelopeV1): CcbEnvelopeV1 {
  const merged = structuredClone(theirs);
  for (const key of ["acceptance", "constraints", "completed", "remaining", "risks"] as const) {
    merged.task[key] = mergeStableItems(base?.task[key] ?? [], ours.task[key], theirs.task[key]);
  }
  merged.task.decisions = mergeStableItems(base?.task.decisions ?? [], ours.task.decisions, theirs.task.decisions);
  merged.changes.files = mergeStableRecords(base?.changes.files ?? [], ours.changes.files, theirs.changes.files, (file) => file.path);
  merged.verification = mergeStableRecords(base?.verification ?? [], ours.verification, theirs.verification, (verification) => `${verification.command}\0${verification.observedAt}`);
  // Same key `upsertConsumption` dedupes on: one row per (engine, session).
  // Including the revision would accumulate a row per revision after every
  // conflict, and none of them would be the one-shot record.
  merged.consumption = mergeStableRecords(base?.consumption ?? [], ours.consumption, theirs.consumption, (entry) => `${entry.targetEngine}\0${entry.targetSessionId}`);
  const contentChanged = contentFingerprint(merged) !== contentFingerprint(theirs);
  merged.revision = contentChanged ? Math.max(ours.revision, theirs.revision) + 1 : theirs.revision;
  if (contentChanged) merged.updatedAt = later(ours.updatedAt, theirs.updatedAt);
  return merged;
}

function mergeStableItems<T extends CcbItem>(base: T[], ours: T[], theirs: T[]): T[] {
  const baseById = new Map(base.map((item) => [item.id, item]));
  const result = [...theirs];
  const resultIds = new Set(result.map((item) => item.id));
  for (const item of ours) {
    if (resultIds.has(item.id)) continue;
    const original = baseById.get(item.id);
    if (!original) {
      result.push(item);
      resultIds.add(item.id);
    }
  }
  return result;
}

function mergeStableRecords<T>(base: T[], ours: T[], theirs: T[], key: (value: T) => string): T[] {
  const baseKeys = new Set(base.map(key));
  const result = [...theirs];
  const resultKeys = new Set(result.map(key));
  for (const value of ours) {
    const id = key(value);
    if (!resultKeys.has(id) && !baseKeys.has(id)) {
      result.push(value);
      resultKeys.add(id);
    }
  }
  return result;
}

function addDegraded(envelope: CcbEnvelopeV1, reason: string): void {
  envelope.provenance.degraded = true;
  if (!envelope.provenance.degradedReasons.includes(reason)) envelope.provenance.degradedReasons.push(reason);
}

function later(left: string, right: string): string {
  return Date.parse(left) >= Date.parse(right) ? left : right;
}

function safeTimestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}
