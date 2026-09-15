import { describe, expect, it } from "vitest";
import { createEmptyEnvelope, migrateCcbEnvelope, parseCcbEnvelope, parseSemanticPatch } from "../src/protocol/schema";

describe("CCB schema", () => {
  it("accepts a valid V1 envelope and rejects unknown or oversized content", () => {
    const envelope = createEmptyEnvelope({
      workspaceId: "workspace-1",
      engine: "claude",
      turnStatus: "completed",
      now: "2026-09-12T12:00:00.000Z",
    });

    expect(parseCcbEnvelope(JSON.stringify(envelope))).toEqual(envelope);
    expect(() => parseCcbEnvelope(JSON.stringify({ ...envelope, schemaVersion: 2 }))).toThrow(/schemaVersion/);
    expect(() => parseCcbEnvelope(JSON.stringify({ ...envelope, extra: true }))).toThrow(/unknown field/);
    expect(() => parseCcbEnvelope("x".repeat(65 * 1024))).toThrow(/64 KB/);
  });

  it("provides an explicit migration entry and strictly validates semantic patches", () => {
    const envelope = createEmptyEnvelope({
      workspaceId: "workspace-1",
      engine: "codex",
      turnStatus: "failed",
      now: "2026-09-12T12:00:00.000Z",
    });
    expect(parseCcbEnvelope(JSON.stringify(envelope), { migrate: (value) => value })).toEqual(envelope);

    expect(parseSemanticPatch({ append: { remaining: ["Run targeted tests"] } })).toEqual({
      append: { remaining: ["Run targeted tests"] },
    });
    expect(() => parseSemanticPatch({ append: { remaining: ["x".repeat(501)] } })).toThrow(/500/);
    expect(() => parseSemanticPatch({ set: { goal: "ok", surprise: "no" } })).toThrow(/unknown field/);
  });


  it("accepts a touched file change through validation and the migration entry", () => {
    const envelope = createEmptyEnvelope({
      workspaceId: "workspace-1",
      engine: "omp",
      turnStatus: "completed",
      now: "2026-09-13T12:00:00.000Z",
    });
    envelope.changes.files.push({ path: "src/a.ts", change: "touched", observedAt: envelope.updatedAt });

    expect(parseCcbEnvelope(JSON.stringify(envelope)).changes.files).toEqual([
      { path: "src/a.ts", change: "touched", observedAt: envelope.updatedAt },
    ]);
    expect(migrateCcbEnvelope(envelope)).toEqual(envelope);

    const invalid = structuredClone(envelope) as unknown as { changes: { files: Array<Record<string, unknown>> } };
    invalid.changes.files[0]!.change = "mutated";
    expect(() => parseCcbEnvelope(JSON.stringify(invalid))).toThrow(/change/);
  });

  it("strictly validates nested records and routes versions through migration", () => {
    const envelope = createEmptyEnvelope({
      workspaceId: "workspace-1",
      engine: "codex",
      turnStatus: "completed",
      now: "2026-09-12T12:00:00.000Z",
    });
    envelope.verification.push({ command: "npm test", exitCode: 0, status: "passed", observedAt: envelope.updatedAt });
    const invalid = structuredClone(envelope) as unknown as { verification: Array<Record<string, unknown>> };
    invalid.verification[0]!.status = "claimed-success";
    expect(() => parseCcbEnvelope(JSON.stringify(invalid))).toThrow(/verification/);
    expect(migrateCcbEnvelope(envelope)).toEqual(envelope);
    expect(() => migrateCcbEnvelope({ ...envelope, schemaVersion: 2 })).toThrow(/schemaVersion/);
  });
});