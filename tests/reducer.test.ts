import { describe, expect, it } from "vitest";
import { MAX_DOCUMENT_BYTES, MAX_ITEM_CHARS, createEmptyEnvelope, parseCcbEnvelope } from "../src/protocol/schema";
import { reduceContext } from "../src/state/reducer";

describe("context reducer", () => {
  it("gives observed facts precedence and constrains semantic data", () => {
    const base = createEmptyEnvelope({ workspaceId: "w", engine: "claude", turnStatus: "completed", now: "2026-09-12T12:00:00.000Z" });
    base.task.remaining.push({ id: "r1", text: "Host truth", source: "host-observed", updatedAt: base.updatedAt });

    const next = reduceContext(base, {
      now: "2026-09-12T12:01:00.000Z",
      patch: {
        append: { remaining: ["Host truth", ...Array.from({ length: 20 }, (_, i) => `Item ${i}`)] },
        remove: { remainingIds: ["r1"] },
      },
      facts: {
        verification: [{ command: "npm test", exitCode: 1, status: "failed", observedAt: "2026-09-12T12:00:30.000Z" }],
      },
    });

    expect(next.task.remaining).toHaveLength(12);
    expect(next.task.remaining[0]).toMatchObject({ id: "r1", source: "host-observed" });
    expect(next.verification[0]).toMatchObject({ command: "npm test", exitCode: 1, status: "failed" });
    expect(next.revision).toBe(1);
  });

  it("marks missing or invalid semantic updates degraded while retaining facts", () => {
    const base = createEmptyEnvelope({ workspaceId: "w", engine: "omp", turnStatus: "completed", now: "2026-09-12T12:00:00.000Z" });
    const next = reduceContext(base, {
      now: "2026-09-12T12:01:00.000Z",
      patch: null,
      facts: { changedFiles: [{ path: "src/a.ts", change: "modified", observedAt: "2026-09-12T12:00:30.000Z" }] },
    });
    expect(next.changes.files).toEqual([{ path: "src/a.ts", change: "modified", observedAt: "2026-09-12T12:00:30.000Z" }]);
    expect(next.provenance).toMatchObject({ degraded: true, degradedReasons: ["semantic-update-missing"] });
  });

  it("keeps a touched observation without letting it overwrite a stronger known change", () => {
    const base = createEmptyEnvelope({ workspaceId: "w", engine: "omp", turnStatus: "completed", now: "2026-09-13T12:00:00.000Z" });
    base.changes.files.push({ path: "src/a.ts", change: "modified", observedAt: "2026-09-13T11:59:00.000Z" });
    const next = reduceContext(base, {
      now: "2026-09-13T12:01:00.000Z",
      facts: {
        changedFiles: [
          { path: "src/a.ts", change: "touched", observedAt: "2026-09-13T12:00:30.000Z" },
          { path: "src/b.ts", change: "touched", observedAt: "2026-09-13T12:00:30.000Z" },
          { path: "src/b.ts", change: "modified", observedAt: "2026-09-13T12:00:40.000Z" },
        ],
      },
    });
    expect(next.changes.files).toEqual([
      { path: "src/a.ts", change: "modified", observedAt: "2026-09-13T11:59:00.000Z" },
      { path: "src/b.ts", change: "modified", observedAt: "2026-09-13T12:00:40.000Z" },
    ]);
  });

  it("lets a known change replace an earlier touched observation for the same path", () => {
    const base = createEmptyEnvelope({ workspaceId: "w", engine: "omp", turnStatus: "completed", now: "2026-09-13T12:00:00.000Z" });
    base.changes.files.push({ path: "src/a.ts", change: "touched", observedAt: "2026-09-13T11:59:00.000Z" });
    const next = reduceContext(base, {
      now: "2026-09-13T12:01:00.000Z",
      facts: { changedFiles: [{ path: "src/a.ts", change: "deleted", observedAt: "2026-09-13T12:00:30.000Z" }] },
    });
    expect(next.changes.files).toEqual([{ path: "src/a.ts", change: "deleted", observedAt: "2026-09-13T12:00:30.000Z" }]);
  });

  it("keeps a host command with unknown status and no exit code instead of claiming success", () => {
    const observedAt = "2026-09-13T12:00:30.000Z";
    const base = createEmptyEnvelope({ workspaceId: "w", engine: "omp", turnStatus: "completed", now: "2026-09-13T12:00:00.000Z" });
    const next = reduceContext(base, {
      now: "2026-09-13T12:01:00.000Z",
      patch: null,
      facts: { verification: [{ command: "pnpm test", cwdHint: "w", exitCode: null, status: "unknown", observedAt }] },
    });
    expect(next.verification).toEqual([{ command: "pnpm test", cwdHint: "w", exitCode: null, status: "unknown", observedAt }]);
    expect(next.verification[0]!.status).not.toBe("passed");
  });

  it("upgrades an unknown verification to a stronger outcome for the same command and cwd", () => {
    const base = createEmptyEnvelope({ workspaceId: "w", engine: "omp", turnStatus: "completed", now: "2026-09-13T12:00:00.000Z" });
    const started = reduceContext(base, {
      now: "2026-09-13T12:00:30.000Z",
      facts: { verification: [{ command: "pnpm test", cwdHint: "w", exitCode: null, status: "unknown", observedAt: "2026-09-13T12:00:10.000Z" }] },
    });
    expect(started.verification).toEqual([{ command: "pnpm test", cwdHint: "w", exitCode: null, status: "unknown", observedAt: "2026-09-13T12:00:10.000Z" }]);

    const finished = reduceContext(started, {
      now: "2026-09-13T12:00:31.000Z",
      facts: { verification: [{ command: "pnpm test", cwdHint: "w", exitCode: 0, status: "passed", observedAt: "2026-09-13T12:00:30.000Z" }] },
    });
    expect(finished.verification).toEqual([{ command: "pnpm test", cwdHint: "w", exitCode: 0, status: "passed", observedAt: "2026-09-13T12:00:30.000Z" }]);
  });

  it("keeps a stronger verification when a later unknown record arrives for the same command and cwd", () => {
    const base = createEmptyEnvelope({ workspaceId: "w", engine: "omp", turnStatus: "completed", now: "2026-09-13T12:00:00.000Z" });
    base.verification.push({ command: "pnpm test", cwdHint: "w", exitCode: 0, status: "passed", observedAt: "2026-09-13T12:00:10.000Z" });
    const next = reduceContext(base, {
      now: "2026-09-13T12:00:31.000Z",
      facts: { verification: [{ command: "pnpm test", cwdHint: "w", exitCode: null, status: "unknown", observedAt: "2026-09-13T12:00:30.000Z" }] },
    });
    expect(next.verification).toEqual([{ command: "pnpm test", cwdHint: "w", exitCode: 0, status: "passed", observedAt: "2026-09-13T12:00:10.000Z" }]);
  });

  it("does not increment content revision for consumption-only changes", () => {
    const base = createEmptyEnvelope({ workspaceId: "w", engine: "omp", turnStatus: "completed", now: "2026-09-12T12:00:00.000Z" });
    const next = reduceContext(base, {
      now: "2026-09-12T12:01:00.000Z",
      patch: undefined,
      consumption: { targetEngine: "claude", targetSessionId: "s1", consumedRevision: 0, consumedAt: "2026-09-12T12:01:00.000Z" },
    });
    expect(next.revision).toBe(0);
    expect(next.consumption).toHaveLength(1);
    expect(next.provenance.degraded).toBe(false);
  });

  it("keeps revision stable when repeated facts do not change task content", () => {
    const base = createEmptyEnvelope({ workspaceId: "w", engine: "omp", turnStatus: "completed", now: "2026-09-12T12:00:00.000Z" });
    base.changes.files.push({ path: "src/a.ts", change: "modified", observedAt: "2026-09-12T12:00:30.000Z" });
    const next = reduceContext(base, {
      now: "2026-09-12T12:01:00.000Z",
      facts: { changedFiles: [{ path: "src/a.ts", change: "modified", observedAt: "2026-09-12T12:00:30.000Z" }] },
    });
    expect(next.revision).toBe(0);
  });

  it("keeps revision stable when only per-turn provenance changes", () => {
    const base = createEmptyEnvelope({ workspaceId: "w", engine: "omp", turnStatus: "completed", now: "2026-09-12T12:00:00.000Z" });
    base.task.goal = "Ship the bridge";
    // Every settled turn writes its own turnId/turnStatus. Those identify the
    // turn, not the task, so `revision` must not move: it is the identity the
    // one-shot consumption guard and the handoff compiler compare against.
    let next = base;
    for (const turnId of ["t1", "t2", "t3"]) {
      next = reduceContext(next, {
        now: "2026-09-12T12:01:00.000Z",
        facts: { source: { engine: "omp", turnId, turnStatus: "completed" } },
      });
    }

    expect(next.revision).toBe(0);
    expect(next.source.turnId).toBe("t3");
  });

  it("applies every semantic removal field but preserves authoritative next action", () => {
    const base = createEmptyEnvelope({ workspaceId: "w", engine: "omp", turnStatus: "completed", now: "2026-09-12T12:00:00.000Z" });
    for (const key of ["acceptance", "constraints", "completed", "remaining", "risks"] as const) {
      base.task[key].push({ id: key, text: key, source: "agent-reported", updatedAt: base.updatedAt });
    }
    base.task.nextAction = { id: "next", text: "Host direction", source: "host-observed", updatedAt: base.updatedAt };
    const next = reduceContext(base, {
      now: "2026-09-12T12:01:00.000Z",
      patch: {
        set: { nextAction: "Agent direction" },
        remove: {
          acceptanceIds: ["acceptance"], constraintIds: ["constraints"], completedIds: ["completed"],
          remainingIds: ["remaining"], riskIds: ["risks"],
        },
      },
    });
    for (const key of ["acceptance", "constraints", "completed", "remaining", "risks"] as const) expect(next.task[key]).toEqual([]);
    expect(next.task.nextAction).toMatchObject({ text: "Host direction" });
  });

  it("bounds the envelope by UTF-8 bytes, trims by priority, and records a degraded reason", () => {
    const base = createEmptyEnvelope({ workspaceId: "w", engine: "omp", turnStatus: "completed", now: "2026-09-12T12:00:00.000Z" });
    base.task.remaining.push({ id: "keep", text: "MUST KEEP REMAINING", source: "host-observed", updatedAt: base.updatedAt });
    base.verification = Array.from({ length: 10 }, (_, i) => ({ command: `c${i}-${"x".repeat(499)}`, exitCode: 0, status: "passed" as const, summary: "y".repeat(500), observedAt: base.updatedAt }));
    base.changes.files = Array.from({ length: 100 }, (_, i) => ({ path: `src/${i}/${"z".repeat(490)}.ts`, change: "modified" as const, observedAt: base.updatedAt }));
    base.task.decisions = Array.from({ length: 20 }, (_, i) => ({ id: `d${i}`, text: "d".repeat(500), reason: "r".repeat(500), source: "agent-reported" as const, updatedAt: base.updatedAt }));
    expect(new TextEncoder().encode(JSON.stringify(base)).byteLength).toBeGreaterThan(MAX_DOCUMENT_BYTES);

    const next = reduceContext(base, {
      now: "2026-09-12T12:01:00.000Z",
      facts: { changedFiles: [{ path: "src/a.ts", change: "modified", observedAt: "2026-09-12T12:00:30.000Z" }] },
    });
    const serialized = JSON.stringify(next);
    expect(() => parseCcbEnvelope(serialized)).not.toThrow();
    expect(new TextEncoder().encode(serialized).byteLength).toBeLessThanOrEqual(MAX_DOCUMENT_BYTES);
    expect(next.provenance.degradedReasons).toContain("document-size-trimmed");
    expect(next.task.remaining.map((item) => item.text)).toContain("MUST KEEP REMAINING");
  });

  it("bounds the pretty-printed form the writer validates so an oversized host-fact document still parses (P11 ASCII reproduction)", () => {
    const now = "2026-09-12T12:00:00.000Z";
    const base = createEmptyEnvelope({ workspaceId: "w", engine: "omp", turnStatus: "completed", now });
    const next = reduceContext(base, { now, facts: oversizedHostFacts((index, length) => `item-${index}-`.padEnd(12, "y") + "x".repeat(length - 12), now) });
    const pretty = JSON.stringify(next, null, 2);
    expect(new TextEncoder().encode(JSON.stringify(next)).byteLength).toBeLessThanOrEqual(MAX_DOCUMENT_BYTES);
    expect(new TextEncoder().encode(pretty).byteLength).toBeLessThanOrEqual(MAX_DOCUMENT_BYTES);
    expect(() => parseCcbEnvelope(pretty)).not.toThrow();
    expect(next.provenance.degradedReasons).toContain("document-size-trimmed");
  });

  it("bounds the pretty-printed form for multibyte host facts too (P11 CJK reproduction)", () => {
    const now = "2026-09-12T12:00:00.000Z";
    const base = createEmptyEnvelope({ workspaceId: "w", engine: "omp", turnStatus: "completed", now });
    const { items, decisions } = oversizedHostFacts((index, length) => `条${index}：`.padEnd(6, "项") + "中".repeat(length - 6), now);
    const next = reduceContext(base, { now, facts: { items, decisions } });
    const pretty = JSON.stringify(next, null, 2);
    expect(new TextEncoder().encode(pretty).byteLength).toBeLessThanOrEqual(MAX_DOCUMENT_BYTES);
    expect(() => parseCcbEnvelope(pretty)).not.toThrow();
    expect(next.provenance.degradedReasons).toContain("document-size-trimmed");
  });

  it("truncates over-long host facts to the schema limit so they cannot poison serialization", () => {
    const now = "2026-09-12T12:00:00.000Z";
    const base = createEmptyEnvelope({ workspaceId: "w", engine: "omp", turnStatus: "completed", now });
    const overlong = "x".repeat(600);
    const next = reduceContext(base, {
      now,
      facts: {
        items: { acceptance: [{ id: "a", text: overlong, source: "host-observed", updatedAt: now }] },
        decisions: [{ id: "d", text: overlong, reason: overlong, source: "host-observed", updatedAt: now }],
        changedFiles: [{ path: `${overlong}.ts`, change: "modified", observedAt: now }],
        verification: [{ command: overlong, cwdHint: overlong, exitCode: null, status: "unknown", summary: overlong, observedAt: now }],
      },
    });
    expect([...(next.task.acceptance[0]?.text ?? "")].length).toBeLessThanOrEqual(MAX_ITEM_CHARS);
    expect([...(next.task.decisions[0]?.text ?? "")].length).toBeLessThanOrEqual(MAX_ITEM_CHARS);
    expect([...(next.task.decisions[0]?.reason ?? "")].length).toBeLessThanOrEqual(MAX_ITEM_CHARS);
    expect([...(next.changes.files[0]?.path ?? "")].length).toBeLessThanOrEqual(MAX_ITEM_CHARS);
    expect([...(next.verification[0]?.command ?? "")].length).toBeLessThanOrEqual(MAX_ITEM_CHARS);
    expect([...(next.verification[0]?.cwdHint ?? "")].length).toBeLessThanOrEqual(MAX_ITEM_CHARS);
    expect([...(next.verification[0]?.summary ?? "")].length).toBeLessThanOrEqual(MAX_ITEM_CHARS);
    expect(() => parseCcbEnvelope(JSON.stringify(next, null, 2))).not.toThrow();
  });

  it("keeps distinct over-long fact identities after bounded persistence", () => {
    const now = "2026-09-13T12:00:00.000Z";
    const base = createEmptyEnvelope({ workspaceId: "w", engine: "omp", turnStatus: "completed", now });
    const shared = "x".repeat(MAX_ITEM_CHARS + 20);
    const next = reduceContext(base, {
      now,
      facts: {
        changedFiles: [
          { path: `${shared}-a.ts`, change: "touched", observedAt: now },
          { path: `${shared}-b.ts`, change: "touched", observedAt: now },
        ],
        verification: [
          { command: `${shared}-a`, cwdHint: "w", exitCode: null, status: "unknown", observedAt: now },
          { command: `${shared}-b`, cwdHint: "w", exitCode: null, status: "unknown", observedAt: now },
        ],
      },
    });
    expect(next.changes.files).toHaveLength(2);
    expect(new Set(next.changes.files.map((file) => file.path)).size).toBe(2);
    expect(next.verification).toHaveLength(2);
    expect(new Set(next.verification.map((verification) => verification.command)).size).toBe(2);
    expect(() => parseCcbEnvelope(JSON.stringify(next, null, 2))).not.toThrow();
  });
});

function oversizedHostFacts(text: (index: number, length: number) => string, now: string) {
  const item = (category: string, index: number) => ({ id: `${category}-${index}`, text: text(index, 500), source: "agent-reported" as const, updatedAt: now });
  return {
    items: {
      acceptance: Array.from({ length: 30 }, (_, index) => item("acceptance", index)),
      constraints: Array.from({ length: 30 }, (_, index) => item("constraints", index)),
      completed: Array.from({ length: 30 }, (_, index) => item("completed", index)),
      remaining: Array.from({ length: 30 }, (_, index) => item("remaining", index)),
      risks: Array.from({ length: 30 }, (_, index) => item("risks", index)),
    },
    decisions: Array.from({ length: 30 }, (_, index) => ({ id: `dec-${index}`, text: text(index + 100, 500), reason: text(index + 200, 500), source: "agent-reported" as const, updatedAt: now })),
    verification: Array.from({ length: 30 }, (_, index) => ({ command: text(index + 300, 500), cwdHint: text(index + 400, 500), exitCode: 0, status: "passed" as const, summary: text(index + 500, 500), observedAt: now })),
    changedFiles: Array.from({ length: 300 }, (_, index) => ({ path: `f/${text(index + 600, 490)}`, change: "modified" as const, observedAt: now })),
  };
}
