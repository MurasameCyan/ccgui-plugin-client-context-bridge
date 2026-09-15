import { describe, expect, it, vi } from "vitest";
import { createEmptyEnvelope } from "../src/protocol/schema";
import { ClientContextCoordinator, type CoordinatorClock } from "../src/coordinator/coordinator";
import type { BeforeTurnEvent, DocumentStorage, InternalMessageEvent, PluginContext } from "../src/sdk";

class MemoryDocuments implements DocumentStorage {
  readonly files = new Map<string, { content: string; version: string }>();
  reads = 0;
  writes = 0;
  blockFirstRead: (() => Promise<void>) | undefined;
  private serial = 0;
  async getLocation() { return { kind: "data" as const, path: "memory" }; }
  async selectLocation(kind: "data" | "program" | "custom") { return { kind, path: "memory" }; }
  async readText(path: string) {
    this.reads += 1;
    if (this.blockFirstRead) {
      const gate = this.blockFirstRead;
      this.blockFirstRead = undefined;
      await gate();
    }
    return this.files.get(path) ?? null;
  }
  async writeTextAtomic(path: string, content: string, expectedVersion: string | null) {
    const current = this.files.get(path);
    if ((current?.version ?? null) !== expectedVersion) throw new Error("version conflict");
    const version = String(++this.serial);
    if (current) this.files.set(`${path}.bak`, current);
    this.files.set(path, { content, version });
    this.writes += 1;
    return { version };
  }
  async remove(path: string) { this.files.delete(path); }
  async list(prefix = "") { return [...this.files.keys()].filter((path) => path.startsWith(prefix)); }
}

interface TestWorkspaceMetadata {
  id: string;
  path: string;
  gitBranch?: string;
  gitHead?: string;
  dirty?: boolean;
}

interface TestContribution {
  id: string;
  content: string;
  onAccepted?: () => void;
}

function harness(metadata: TestWorkspaceMetadata = workspace) {
  const documents = new MemoryDocuments();
  const registered: { session?: unknown; turn?: unknown; runtimeSwitch?: unknown } = {};
  const disposed: string[] = [];
  const context = {
    documentStorage: documents,
    workspace: { getMetadata: async () => metadata },
    hooks: {
      registerSessionHooks(hooks: unknown) { registered.session = hooks; return () => { disposed.push("session"); }; },
      registerTurnHooks(hooks: unknown) { registered.turn = hooks; return () => { disposed.push("turn"); }; },
      registerRuntimeSwitchHooks(hooks: unknown) { registered.runtimeSwitch = hooks; return () => { disposed.push("switch"); }; },
    },
  } as unknown as PluginContext;
  let timeout: (() => void) | undefined;
  const clock: CoordinatorClock = {
    now: () => "2026-09-13T10:00:00.000Z",
    nonce: () => "4d6f62f86b3097d487489d19c8628599",
    setTimeout: (callback) => { timeout = callback; return 1; },
    clearTimeout: () => { timeout = undefined; },
  };
  const coordinator = new ClientContextCoordinator(context, { clock, ttlDays: () => 7 });
  return { coordinator, documents, registered, disposed, fireRecovery: () => timeout?.(), recoveryArmed: () => timeout !== undefined };
}

function deferred() {
  let settle!: () => void;
  const promise = new Promise<void>((resolve) => { settle = resolve; });
  return { promise, resolve: settle };
}

const workspace = { id: "workspace-1", path: "C:/repo" };
const turn: BeforeTurnEvent = { runId: "run-1", turnId: "turn-1", engine: "claude", sessionId: null, workspace, occurredAt: "2026-09-13T10:00:00.000Z" };
const NONCE = "4d6f62f86b3097d487489d19c8628599";
const switchEvent = { sourceEngine: "claude", targetEngine: "codex", sourceSessionId: "c1", targetSessionId: null, workspace, occurredAt: turn.occurredAt };
const internalFrame = (patch: unknown) => ({ plugin: "ccgui.client-context-bridge", version: 1, patch });

describe("client context coordinator", () => {
  it("does absolutely no operational registration or document I/O before enable", () => {
    const h = harness();
    expect(h.registered).toEqual({});
    expect(h.documents.reads).toBe(0);
    expect(h.documents.writes).toBe(0);
  });

  it("registers all lifecycle hooks on enable and disposes without flushing on disable", async () => {
    const h = harness();
    h.coordinator.enable();
    expect(Object.keys(h.registered).sort()).toEqual(["runtimeSwitch", "session", "turn"]);
    const hooks = h.registered.turn as { onRuntimeEvent(event: unknown): void };
    hooks.onRuntimeEvent({ ...turn, eventId: "e1", workspaceId: workspace.id, workspacePath: workspace.path, kind: "file-changed", path: "src/a.ts", change: "modified" });
    h.coordinator.disable();
    await Promise.resolve();
    expect(h.disposed.sort()).toEqual(["session", "switch", "turn"]);
    expect(h.documents.writes).toBe(0);
    h.fireRecovery();
    await Promise.resolve();
    expect(h.documents.writes).toBe(0);
  });

  it("uses full protocol first, short reminders later, and exposes every removable stable id", async () => {
    const h = harness();
    const envelope = createEmptyEnvelope({ workspaceId: workspace.id, engine: "claude", turnStatus: "completed", now: turn.occurredAt });
    envelope.task.acceptance.push({ id: "acceptance-a1", text: "Ship accepted behavior", source: "agent-reported", updatedAt: turn.occurredAt });
    h.documents.files.set(`${workspace.id}.ccb`, { content: JSON.stringify(envelope), version: "1" });
    h.coordinator.enable();
    const turnHooks = h.registered.turn as { beforeTurn(event: typeof turn): Promise<{ promptContributions?: TestContribution[]; internalMessageCapture?: { nonce?: string; maxBytes: number; validate?: (payload: unknown) => boolean } }>; afterTurn(event: unknown): Promise<void> };
    const sessionHooks = h.registered.session as { onCreated(event: unknown): void };
    const first = await turnHooks.beforeTurn(turn);
    sessionHooks.onCreated({ engine: "claude", sessionId: "native-1", workspace, occurredAt: turn.occurredAt });
    // The host settles every turn before the next send, and afterTurn is what
    // converts the pending first-turn marker into the native session identity.
    await turnHooks.afterTurn({ ...turn, sessionId: "native-1", status: "completed" });
    const second = await turnHooks.beforeTurn({ ...turn, turnId: "turn-2", sessionId: "native-1" });
    const firstProtocol = first.promptContributions?.find((entry) => entry.id === `ccb-protocol-${turn.turnId}`)?.content ?? "";
    const secondProtocol = second.promptContributions?.find((entry) => entry.id === "ccb-protocol-turn-2")?.content ?? "";
    expect(firstProtocol).toContain("语义 patch");
    expect(firstProtocol).toContain(NONCE);
    for (const field of ["acceptanceIds", "constraintIds", "completedIds", "remainingIds", "decisionIds", "riskIds"]) expect(firstProtocol).toContain(field);
    expect(firstProtocol).toContain("acceptance-a1");
    expect(firstProtocol).toContain("Ship accepted behavior");
    expect(secondProtocol.length).toBeLessThan(firstProtocol.length);
    expect(first.internalMessageCapture).toMatchObject({ channel: "semantic-patch", nonce: NONCE, maxBytes: 16 * 1024 });
    const validate = first.internalMessageCapture!.validate!;
    expect(validate(internalFrame({ set: { goal: "ok" } }))).toBe(true);
    expect(validate({ plugin: "ccgui.client-context-bridge", version: 1, patch: { set: { unknown: 1 } } })).toBe(false);
    expect(validate({ plugin: "other", version: 1, patch: {} })).toBe(false);
    expect(validate("not a frame")).toBe(false);
  });

  it("keeps runtime facts in memory, writes once after a settled turn, and recovers dirty state after 10 seconds", async () => {
    const h = harness();
    h.coordinator.enable();
    const hooks = h.registered.turn as { onRuntimeEvent(event: unknown): void; afterTurn(event: unknown): Promise<void> };
    hooks.onRuntimeEvent({ ...turn, eventId: "e1", workspaceId: workspace.id, workspacePath: workspace.path, kind: "file-changed", path: "src/a.ts", change: "modified" });
    hooks.onRuntimeEvent({ ...turn, eventId: "e2", workspaceId: workspace.id, workspacePath: workspace.path, kind: "command-finished", command: "pnpm test", cwd: workspace.path, exitCode: 0, finishedAt: turn.occurredAt, status: "completed" });
    expect(h.documents.writes).toBe(0);
    await hooks.afterTurn({ ...turn, status: "completed" });
    expect(h.documents.writes).toBe(1);

    hooks.onRuntimeEvent({ ...turn, turnId: "turn-2", eventId: "e3", workspaceId: workspace.id, workspacePath: workspace.path, kind: "file-changed", path: "src/b.ts", change: "created" });
    await vi.waitFor(() => expect(h.recoveryArmed()).toBe(true));
    h.fireRecovery();
    await vi.waitFor(() => expect(h.documents.writes).toBe(2));
  });

  it("records a command-started event as an unknown verification entry", async () => {
    const h = harness();
    h.coordinator.enable();
    const hooks = h.registered.turn as { onRuntimeEvent(event: unknown): void; afterTurn(event: unknown): Promise<void> };
    hooks.onRuntimeEvent({ ...turn, eventId: "e1", workspaceId: workspace.id, workspacePath: workspace.path, kind: "command-started", command: "pnpm test", cwd: workspace.path, startedAt: "2026-09-13T10:00:05.000Z" });
    await hooks.afterTurn({ ...turn, status: "completed" });
    const saved = JSON.parse(h.documents.files.get(`${workspace.id}.ccb`)!.content) as { verification: unknown[] };
    expect(saved.verification).toEqual([{ command: "pnpm test", cwdHint: workspace.path, exitCode: null, status: "unknown", observedAt: "2026-09-13T10:00:05.000Z" }]);
  });

  it("merges a started and finished command into a single upgraded verification entry", async () => {
    const h = harness();
    h.coordinator.enable();
    const hooks = h.registered.turn as { onRuntimeEvent(event: unknown): void; afterTurn(event: unknown): Promise<void> };
    hooks.onRuntimeEvent({ ...turn, eventId: "e1", workspaceId: workspace.id, workspacePath: workspace.path, kind: "command-started", command: "pnpm test", cwd: workspace.path, startedAt: "2026-09-13T10:00:05.000Z" });
    hooks.onRuntimeEvent({ ...turn, eventId: "e2", workspaceId: workspace.id, workspacePath: workspace.path, kind: "command-finished", command: "pnpm test", cwd: workspace.path, exitCode: 0, finishedAt: "2026-09-13T10:00:06.000Z", status: "completed" });
    await hooks.afterTurn({ ...turn, status: "completed" });
    const saved = JSON.parse(h.documents.files.get(`${workspace.id}.ccb`)!.content) as { verification: unknown[] };
    expect(saved.verification).toEqual([{ command: "pnpm test", cwdHint: workspace.path, exitCode: 0, status: "passed", observedAt: "2026-09-13T10:00:06.000Z" }]);
  });

  it("keeps a completed command with no exit code unknown", async () => {
    const h = harness();
    h.coordinator.enable();
    const hooks = h.registered.turn as { onRuntimeEvent(event: unknown): void; afterTurn(event: unknown): Promise<void> };
    hooks.onRuntimeEvent({ ...turn, eventId: "e1", workspaceId: workspace.id, workspacePath: workspace.path, kind: "command-finished", command: "pnpm test", cwd: workspace.path, exitCode: null, finishedAt: "2026-09-13T10:00:06.000Z", status: "completed" });
    await hooks.afterTurn({ ...turn, status: "completed" });
    const saved = JSON.parse(h.documents.files.get(`${workspace.id}.ccb`)!.content) as { verification: unknown[] };
    expect(saved.verification).toEqual([{ command: "pnpm test", cwdHint: workspace.path, exitCode: null, status: "unknown", observedAt: "2026-09-13T10:00:06.000Z" }]);
  });

  it("awaits queued runtime facts before the single settle flush (P4)", async () => {
    const h = harness();
    const gate = deferred();
    h.documents.blockFirstRead = () => gate.promise;
    h.coordinator.enable();
    const hooks = h.registered.turn as { onRuntimeEvent(event: unknown): void; afterTurn(event: unknown): Promise<void> };
    hooks.onRuntimeEvent({ ...turn, eventId: "e1", workspaceId: workspace.id, workspacePath: workspace.path, kind: "file-changed", path: "src/awaited.ts", change: "modified" });
    const settled = hooks.afterTurn({ ...turn, status: "completed" });
    await Promise.resolve();
    expect(h.documents.writes).toBe(0);
    gate.resolve();
    await settled;
    const saved = JSON.parse(h.documents.files.get(`${workspace.id}.ccb`)!.content) as { changes: { files: Array<{ path: string }> } };
    expect(saved.changes.files.map((file) => file.path)).toContain("src/awaited.ts");
    expect(h.documents.writes).toBe(1);
  });

  it("isolates semantic patches per turn and merges them serially into the workspace draft (P5)", async () => {
    const h = harness();
    h.coordinator.enable();
    const hooks = h.registered.turn as {
      beforeTurn(event: typeof turn): Promise<unknown>;
      onInternalMessage(event: InternalMessageEvent): void;
      afterTurn(event: unknown): Promise<void>;
    };
    await hooks.beforeTurn({ ...turn, turnId: "t1" });
    await hooks.beforeTurn({ ...turn, turnId: "t2" });
    hooks.onInternalMessage({ ...turn, turnId: "t1", channel: "semantic-patch", nonce: NONCE, payload: internalFrame({ append: { acceptance: ["A"] } }) });
    hooks.onInternalMessage({ ...turn, turnId: "t2", channel: "semantic-patch", nonce: NONCE, payload: internalFrame({ append: { acceptance: ["B"] } }) });
    await hooks.afterTurn({ ...turn, turnId: "t1", status: "completed" });
    await hooks.afterTurn({ ...turn, turnId: "t2", status: "completed" });
    const saved = JSON.parse(h.documents.files.get(`${workspace.id}.ccb`)!.content) as { task: { acceptance: Array<{ text: string }> } };
    expect(saved.task.acceptance.map((item) => item.text).sort()).toEqual(["A", "B"]);
  });

  it("retries a skipped handoff and consumes only the accepted target turn in one write", async () => {
    const h = harness();
    const envelope = createEmptyEnvelope({ workspaceId: workspace.id, engine: "claude", turnStatus: "completed", now: turn.occurredAt });
    envelope.revision = 4;
    envelope.task.goal = "Finish bridge";
    h.documents.files.set(`${workspace.id}.ccb`, { content: JSON.stringify(envelope), version: "1" });
    h.coordinator.enable();
    const switchHooks = h.registered.runtimeSwitch as { beforeSwitch(event: unknown): Promise<void> };
    const turnHooks = h.registered.turn as { beforeTurn(event: typeof turn): Promise<{ promptContributions?: TestContribution[] }>; afterTurn(event: unknown): Promise<void> };
    await switchHooks.beforeSwitch(switchEvent);

    const skipped = await turnHooks.beforeTurn({ ...turn, engine: "codex", sessionId: null });
    expect(skipped.promptContributions?.some((entry) => entry.id === "ccb-handoff" && entry.content.includes("Finish bridge"))).toBe(true);
    const retried = await turnHooks.beforeTurn({ ...turn, runId: "run-2", turnId: "turn-2", engine: "codex", sessionId: null });
    const accepted = retried.promptContributions?.find((entry) => entry.id === "ccb-handoff");
    expect(accepted?.content).toContain("Finish bridge");
    accepted?.onAccepted?.();

    const afterAcceptance = await turnHooks.beforeTurn({ ...turn, runId: "run-3", turnId: "turn-3", engine: "codex", sessionId: null });
    expect(afterAcceptance.promptContributions?.some((entry) => entry.id === "ccb-handoff")).toBe(false);
    await turnHooks.afterTurn({ ...turn, runId: "run-2", turnId: "turn-2", engine: "codex", sessionId: "native-target", status: "completed" });

    expect(h.documents.writes).toBe(1);
    const saved = JSON.parse(h.documents.files.get(`${workspace.id}.ccb`)!.content) as { consumption: Array<{ targetSessionId: string; consumedRevision: number }>; revision: number };
    expect(saved.revision).toBe(5);
    expect(saved.consumption).toEqual([expect.objectContaining({ targetSessionId: "native-target", consumedRevision: 4 })]);
  });

  it("records consumption when the host rekeys the run id between beforeTurn and afterTurn", async () => {
    const h = harness();
    const envelope = createEmptyEnvelope({ workspaceId: workspace.id, engine: "claude", turnStatus: "completed", now: turn.occurredAt });
    envelope.revision = 4;
    envelope.task.goal = "Finish bridge";
    h.documents.files.set(`${workspace.id}.ccb`, { content: JSON.stringify(envelope), version: "1" });
    h.coordinator.enable();
    const switchHooks = h.registered.runtimeSwitch as { beforeSwitch(event: unknown): Promise<void> };
    const turnHooks = h.registered.turn as { beforeTurn(event: typeof turn): Promise<{ promptContributions?: TestContribution[] }>; afterTurn(event: unknown): Promise<void> };
    await switchHooks.beforeSwitch(switchEvent);

    // The host collects beforeTurn under a placeholder run id and rekeys the
    // lifecycle to the engine's real run id once the launch resolves; only
    // turnId survives that rekey, so consumption must pair on turnId.
    const collected = await turnHooks.beforeTurn({ ...turn, runId: "placeholder-1", turnId: "turn-9", engine: "codex", sessionId: null });
    collected.promptContributions?.find((entry) => entry.id === "ccb-handoff")?.onAccepted?.();
    await turnHooks.afterTurn({ ...turn, runId: "engine-run-9", turnId: "turn-9", engine: "codex", sessionId: "native-target", status: "completed" });

    const saved = JSON.parse(h.documents.files.get(`${workspace.id}.ccb`)!.content) as { consumption: Array<{ targetSessionId: string; consumedRevision: number }> };
    expect(saved.consumption).toEqual([expect.objectContaining({ targetSessionId: "native-target", consumedRevision: 4 })]);
  });

  it("files no consumption row when the accepted turn's own session never materialised", async () => {
    const h = harness();
    const envelope = createEmptyEnvelope({ workspaceId: workspace.id, engine: "claude", turnStatus: "completed", now: turn.occurredAt });
    envelope.revision = 4;
    envelope.task.goal = "Finish bridge";
    h.documents.files.set(`${workspace.id}.ccb`, { content: JSON.stringify(envelope), version: "1" });
    h.coordinator.enable();
    const switchHooks = h.registered.runtimeSwitch as { beforeSwitch(event: unknown): Promise<void> };
    const sessionHooks = h.registered.session as { onCreated(event: unknown): void };
    const turnHooks = h.registered.turn as { beforeTurn(event: typeof turn): Promise<{ promptContributions?: TestContribution[] }>; afterTurn(event: unknown): Promise<void> };
    await switchHooks.beforeSwitch(switchEvent);

    // The handoff lands in a brand-new codex session that has no native id yet.
    const injected = await turnHooks.beforeTurn({ ...turn, engine: "codex", turnId: "turn-b", sessionId: null });
    expect(injected.promptContributions?.some((entry) => entry.id === "ccb-handoff")).toBe(true);
    injected.promptContributions?.find((entry) => entry.id === "ccb-handoff")?.onAccepted?.();
    // A *different* codex tab in the same workspace announces its own session.
    sessionHooks.onCreated({ engine: "codex", sessionId: "SESS-A", workspace, occurredAt: turn.occurredAt });
    // The injected turn dies before its own session event, so afterTurn carries
    // no session id. SESS-A never saw the handoff and must not be barred.
    await turnHooks.afterTurn({ ...turn, engine: "codex", turnId: "turn-b", sessionId: null, status: "failed" });

    const saved = JSON.parse(h.documents.files.get(`${workspace.id}.ccb`)!.content) as { consumption: unknown[] };
    expect(saved.consumption).toEqual([]);
  });

  it("records one consumption row per accepted injection when two turns are offered the handoff", async () => {
    const h = harness();
    const envelope = createEmptyEnvelope({ workspaceId: workspace.id, engine: "claude", turnStatus: "completed", now: turn.occurredAt });
    envelope.revision = 4;
    envelope.task.goal = "Finish bridge";
    h.documents.files.set(`${workspace.id}.ccb`, { content: JSON.stringify(envelope), version: "1" });
    h.coordinator.enable();
    const switchHooks = h.registered.runtimeSwitch as { beforeSwitch(event: unknown): Promise<void> };
    const turnHooks = h.registered.turn as { beforeTurn(event: typeof turn): Promise<{ promptContributions?: TestContribution[] }>; afterTurn(event: unknown): Promise<void> };
    await switchHooks.beforeSwitch(switchEvent);

    // Two new-chat tabs of the target engine send before either launch resolves,
    // so both collections see an unaccepted handoff and both are confirmed.
    const left = await turnHooks.beforeTurn({ ...turn, engine: "codex", turnId: "turn-l", sessionId: null });
    const right = await turnHooks.beforeTurn({ ...turn, engine: "codex", turnId: "turn-r", sessionId: null });
    left.promptContributions?.find((entry) => entry.id === "ccb-handoff")?.onAccepted?.();
    right.promptContributions?.find((entry) => entry.id === "ccb-handoff")?.onAccepted?.();
    await turnHooks.afterTurn({ ...turn, engine: "codex", turnId: "turn-l", sessionId: "SESS-L", status: "completed" });
    await turnHooks.afterTurn({ ...turn, engine: "codex", turnId: "turn-r", sessionId: "SESS-R", status: "completed" });

    // Both sessions carry the context in their own history, so both need a row:
    // a session with none is handed the same context again after a restart.
    const saved = JSON.parse(h.documents.files.get(`${workspace.id}.ccb`)!.content) as { consumption: Array<{ targetSessionId: string }> };
    expect(saved.consumption.map((entry) => entry.targetSessionId).sort()).toEqual(["SESS-L", "SESS-R"]);
  });

  it("keeps afterSwitch idempotent and flushes before a switch (H2b)", async () => {
    const h = harness();
    const envelope = createEmptyEnvelope({ workspaceId: workspace.id, engine: "claude", turnStatus: "completed", now: turn.occurredAt });
    envelope.revision = 4;
    envelope.task.goal = "Finish bridge";
    h.documents.files.set(`${workspace.id}.ccb`, { content: JSON.stringify(envelope), version: "1" });
    h.coordinator.enable();
    const switchHooks = h.registered.runtimeSwitch as { beforeSwitch(event: unknown): Promise<void>; afterSwitch(event: unknown): void };
    const sessionHooks = h.registered.session as { onCreated(event: unknown): void };
    const turnHooks = h.registered.turn as { beforeTurn(event: typeof turn): Promise<{ promptContributions?: TestContribution[] }> };
    await switchHooks.beforeSwitch(switchEvent);
    sessionHooks.onCreated({ engine: "codex", sessionId: null, workspace, occurredAt: turn.occurredAt });
    const first = await turnHooks.beforeTurn({ ...turn, engine: "codex", sessionId: null });
    first.promptContributions?.find((entry) => entry.id === "ccb-handoff")?.onAccepted?.();
    switchHooks.afterSwitch(switchEvent);
    switchHooks.afterSwitch(switchEvent);
    const second = await turnHooks.beforeTurn({ ...turn, engine: "codex", turnId: "turn-2", sessionId: null });
    expect(first.promptContributions?.some((entry) => entry.id === "ccb-handoff" && entry.content.includes("Finish bridge"))).toBe(true);
    expect(second.promptContributions?.some((entry) => entry.id === "ccb-handoff")).toBe(false);
  });

  it("never injects restored sessions and persists idempotent consumption when a target id appears", async () => {
    const h = harness();
    const envelope = createEmptyEnvelope({ workspaceId: workspace.id, engine: "claude", turnStatus: "completed", now: turn.occurredAt });
    envelope.revision = 2;
    envelope.task.goal = "Do not duplicate";
    h.documents.files.set(`${workspace.id}.ccb`, { content: JSON.stringify(envelope), version: "1" });
    h.coordinator.enable();
    const switchHooks = h.registered.runtimeSwitch as { beforeSwitch(event: unknown): Promise<void>; afterSwitch(event: unknown): void };
    const sessionHooks = h.registered.session as { onRestored(event: unknown): void };
    const turnHooks = h.registered.turn as { beforeTurn(event: typeof turn): Promise<{ promptContributions?: TestContribution[] }>; afterTurn(event: unknown): Promise<void> };

    await switchHooks.beforeSwitch(switchEvent);
    sessionHooks.onRestored({ engine: "codex", sessionId: "restored", workspace, occurredAt: turn.occurredAt });
    const restored = await turnHooks.beforeTurn({ ...turn, engine: "codex", sessionId: "restored" });
    expect(restored.promptContributions?.some((entry) => entry.id === "ccb-handoff")).toBe(false);

    await switchHooks.beforeSwitch(switchEvent);
    switchHooks.afterSwitch(switchEvent);
    const created = await turnHooks.beforeTurn({ ...turn, engine: "codex", sessionId: null });
    created.promptContributions?.find((entry) => entry.id === "ccb-handoff")?.onAccepted?.();
    await turnHooks.afterTurn({ ...turn, engine: "codex", sessionId: "new-session", status: "completed" });
    const saved = JSON.parse(h.documents.files.get(`${workspace.id}.ccb`)!.content) as { consumption: unknown[]; revision: number };
    expect(saved.revision).toBe(3);
    expect(saved.consumption).toEqual([expect.objectContaining({ targetSessionId: "new-session", consumedRevision: 2 })]);
  });

  it("does not re-inject a handoff into a session that already consumed it after a restart", async () => {
    const first = harness();
    const envelope = createEmptyEnvelope({ workspaceId: workspace.id, engine: "claude", turnStatus: "completed", now: turn.occurredAt });
    envelope.revision = 4;
    envelope.task.goal = "Finish bridge";
    first.documents.files.set(`${workspace.id}.ccb`, { content: JSON.stringify(envelope), version: "1" });
    first.coordinator.enable();
    const switchHooks = first.registered.runtimeSwitch as { beforeSwitch(event: unknown): Promise<void> };
    const turnHooks = first.registered.turn as { beforeTurn(event: typeof turn): Promise<{ promptContributions?: TestContribution[] }>; afterTurn(event: unknown): Promise<void> };

    await switchHooks.beforeSwitch(switchEvent);
    const injected = await turnHooks.beforeTurn({ ...turn, engine: "codex", sessionId: "SESS-A" });
    const handoff = injected.promptContributions?.find((entry) => entry.id === "ccb-handoff");
    expect(handoff?.content).toContain("Finish bridge");
    handoff?.onAccepted?.();
    await turnHooks.afterTurn({ ...turn, engine: "codex", sessionId: "SESS-A", status: "completed" });
    const persisted = first.documents.files.get(`${workspace.id}.ccb`)!;

    // Restart: the in-memory `accepted` flag dies with the process, so the
    // persisted consumption row is the only thing left that can keep this
    // session from being handed the same context twice.
    const restarted = harness();
    restarted.documents.files.set(`${workspace.id}.ccb`, { content: persisted.content, version: "1" });
    restarted.coordinator.enable();
    const restartedSwitch = restarted.registered.runtimeSwitch as { beforeSwitch(event: unknown): Promise<void> };
    const restartedTurns = restarted.registered.turn as { beforeTurn(event: typeof turn): Promise<{ promptContributions?: TestContribution[] }> };
    await restartedSwitch.beforeSwitch(switchEvent);
    const again = await restartedTurns.beforeTurn({ ...turn, engine: "codex", sessionId: "SESS-A" });

    expect(again.promptContributions?.some((entry) => entry.id === "ccb-handoff")).toBe(false);
  });

  it("rekeys a pending first turn to its native session without repeating the full protocol", async () => {
    const h = harness();
    h.coordinator.enable();
    const sessionHooks = h.registered.session as { onCreated(event: unknown): void };
    const turnHooks = h.registered.turn as { beforeTurn(event: typeof turn): Promise<{ promptContributions?: TestContribution[] }>; afterTurn(event: unknown): Promise<void> };
    const first = await turnHooks.beforeTurn({ ...turn, runId: "pending-run", turnId: "pending-turn", sessionId: null });
    sessionHooks.onCreated({ engine: "claude", sessionId: "native-session", workspace, occurredAt: turn.occurredAt });
    // afterTurn deliberately carries a different runId than beforeTurn: the host
    // rekeys the lifecycle onto the engine's real run id once the launch
    // resolves, so turnId is the only key that survives the same turn.
    await turnHooks.afterTurn({ ...turn, runId: "real-run", turnId: "pending-turn", sessionId: "native-session", status: "completed" });
    const identified = await turnHooks.beforeTurn({ ...turn, runId: "real-run-2", turnId: "native-turn", sessionId: "native-session" });
    expect(first.promptContributions?.find((entry) => entry.id === "ccb-protocol-pending-turn")?.content).toContain("语义 patch");
    expect(identified.promptContributions?.find((entry) => entry.id === "ccb-protocol-native-turn")?.content).not.toContain("语义 patch");
  });

  it("isolates concurrent pending sessions until each receives a native identity", async () => {
    const h = harness();
    h.coordinator.enable();
    const turnHooks = h.registered.turn as { beforeTurn(event: typeof turn): Promise<{ promptContributions?: TestContribution[] }>; afterTurn(event: unknown): Promise<void> };
    const [left, right] = await Promise.all([
      turnHooks.beforeTurn({ ...turn, runId: "left-run", turnId: "left-turn", sessionId: null }),
      turnHooks.beforeTurn({ ...turn, runId: "right-run", turnId: "right-turn", sessionId: null }),
    ]);
    expect(left.promptContributions?.find((entry) => entry.id === "ccb-protocol-left-turn")?.content).toContain("语义 patch");
    expect(right.promptContributions?.find((entry) => entry.id === "ccb-protocol-right-turn")?.content).toContain("语义 patch");

    await turnHooks.afterTurn({ ...turn, runId: "left-real", turnId: "left-turn", sessionId: "left-session", status: "completed" });
    await turnHooks.afterTurn({ ...turn, runId: "right-real", turnId: "right-turn", sessionId: "right-session", status: "completed" });

    const leftNative = await turnHooks.beforeTurn({ ...turn, runId: "left-run-2", turnId: "left-native", sessionId: "left-session" });
    const rightNative = await turnHooks.beforeTurn({ ...turn, runId: "right-run-2", turnId: "right-native", sessionId: "right-session" });
    expect(leftNative.promptContributions?.find((entry) => entry.id === "ccb-protocol-left-native")?.content).not.toContain("语义 patch");
    expect(rightNative.promptContributions?.find((entry) => entry.id === "ccb-protocol-right-native")?.content).not.toContain("语义 patch");
  });

  it("persists host git facts and warns when the live Git HEAD differs from the handoff", async () => {
    const h = harness({ ...workspace, gitBranch: "feature/current", gitHead: "new-head", dirty: true });
    const envelope = createEmptyEnvelope({ workspaceId: workspace.id, engine: "claude", turnStatus: "completed", now: turn.occurredAt });
    envelope.revision = 7;
    envelope.workspace.gitHead = "old-head";
    envelope.task.goal = "Verify changed head";
    h.documents.files.set(`${workspace.id}.ccb`, { content: JSON.stringify(envelope), version: "1" });
    h.coordinator.enable();
    const switchHooks = h.registered.runtimeSwitch as { beforeSwitch(event: unknown): Promise<void> };
    const turnHooks = h.registered.turn as { beforeTurn(event: typeof turn): Promise<{ promptContributions?: TestContribution[] }>; afterTurn(event: unknown): Promise<void> };
    await switchHooks.beforeSwitch(switchEvent);
    const before = await turnHooks.beforeTurn({ ...turn, engine: "codex", sessionId: null });
    expect(before.promptContributions?.find((entry) => entry.id === "ccb-handoff")?.content).toContain("Git HEAD 已变化");
    await turnHooks.afterTurn({ ...turn, engine: "codex", status: "completed" });
    const saved = JSON.parse(h.documents.files.get(`${workspace.id}.ccb`)!.content) as { workspace: TestWorkspaceMetadata };
    expect(saved.workspace).toMatchObject({ rootHint: workspace.path, gitBranch: "feature/current", gitHead: "new-head", dirty: true });
  });

  it("pauses writes, flushes dirty drafts, resumes, and purges drafts (maintenance API)", async () => {
    const h = harness();
    h.coordinator.enable();
    const hooks = h.registered.turn as { onRuntimeEvent(event: unknown): void; afterTurn(event: unknown): Promise<void> };
    hooks.onRuntimeEvent({ ...turn, eventId: "e1", workspaceId: workspace.id, workspacePath: workspace.path, kind: "file-changed", path: "src/first.ts", change: "modified" });
    await h.coordinator.pauseForMaintenance();
    expect(h.documents.writes).toBe(1);

    hooks.onRuntimeEvent({ ...turn, turnId: "turn-2", eventId: "e2", workspaceId: workspace.id, workspacePath: workspace.path, kind: "file-changed", path: "src/second.ts", change: "modified" });
    await hooks.afterTurn({ ...turn, turnId: "turn-2", status: "completed" });
    expect(h.documents.writes).toBe(1);

    h.coordinator.resumeFromMaintenance();
    h.fireRecovery();
    await vi.waitFor(() => expect(h.documents.writes).toBe(2));
  });

  it("drops a pending handoff when its document is purged (maintenance API)", async () => {
    const h = harness();
    const envelope = createEmptyEnvelope({ workspaceId: workspace.id, engine: "claude", turnStatus: "completed", now: turn.occurredAt });
    envelope.revision = 1;
    envelope.task.goal = "Purged goal";
    h.documents.files.set(`${workspace.id}.ccb`, { content: JSON.stringify(envelope), version: "1" });
    h.coordinator.enable();
    const switchHooks = h.registered.runtimeSwitch as { beforeSwitch(event: unknown): Promise<void> };
    const turnHooks = h.registered.turn as { beforeTurn(event: typeof turn): Promise<{ promptContributions?: Array<{ id: string }> }> };
    await switchHooks.beforeSwitch(switchEvent);
    h.coordinator.purgeDrafts([`${workspace.id}.ccb`, `${workspace.id}.ccb.bak`]);
    const first = await turnHooks.beforeTurn({ ...turn, engine: "codex", sessionId: null });
    expect(first.promptContributions?.some((entry) => entry.id === "ccb-handoff")).toBe(false);
  });

  it("takes the degraded path and keeps host facts when no internal frame arrived (P11 / design §10.4)", async () => {
    const h = harness();
    h.coordinator.enable();
    const hooks = h.registered.turn as { onRuntimeEvent(event: unknown): void; afterTurn(event: unknown): Promise<void> };
    hooks.onRuntimeEvent({ ...turn, eventId: "e1", workspaceId: workspace.id, workspacePath: workspace.path, kind: "file-changed", path: "src/no-frame.ts", change: "modified" });
    await hooks.afterTurn({ ...turn, status: "completed" });
    const saved = JSON.parse(h.documents.files.get(`${workspace.id}.ccb`)!.content) as { changes: { files: Array<{ path: string }> }; provenance: { degraded: boolean; degradedReasons: string[] } };
    expect(saved.changes.files.map((file) => file.path)).toContain("src/no-frame.ts");
    expect(saved.provenance.degraded).toBe(true);
    expect(saved.provenance.degradedReasons).toContain("semantic-update-missing");
  });

  it("keeps an invalid internal frame degraded without discarding host facts (design §20)", async () => {
    const h = harness();
    h.coordinator.enable();
    const hooks = h.registered.turn as {
      beforeTurn(event: typeof turn): Promise<unknown>;
      onRuntimeEvent(event: unknown): void;
      onInternalMessage(event: InternalMessageEvent): void;
      afterTurn(event: unknown): Promise<void>;
    };
    await hooks.beforeTurn(turn);
    hooks.onRuntimeEvent({ ...turn, eventId: "e1", workspaceId: workspace.id, workspacePath: workspace.path, kind: "file-changed", path: "src/invalid-frame.ts", change: "modified" });
    hooks.onInternalMessage({ ...turn, channel: "semantic-patch", nonce: NONCE, payload: internalFrame({ set: { unknown: true } }) });
    await hooks.afterTurn({ ...turn, status: "completed" });
    const saved = JSON.parse(h.documents.files.get(`${workspace.id}.ccb`)!.content) as { changes: { files: Array<{ path: string }> }; provenance: { degradedReasons: string[] } };
    expect(saved.changes.files.map((file) => file.path)).toContain("src/invalid-frame.ts");
    expect(saved.provenance.degradedReasons).toContain("semantic-update-missing");
  });
});
