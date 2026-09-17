import { describe, expect, it, vi } from "vitest";
import { createEmptyEnvelope } from "../src/protocol/schema";
import { ClientContextCoordinator, type CoordinatorClock } from "../src/coordinator/coordinator";
import type { BeforeTurnEvent, DocumentStorage, InternalMessageEvent, PluginContext, RuntimeSwitchHooks, TurnHooks } from "../src/sdk";

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
  const statuses: string[] = [];
  const getMetadata = vi.fn(async () => metadata);
  const context = {
    documentStorage: documents,
    workspace: { getMetadata },
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
  const offWorkspaces = new Set<string>();
  const coordinator = new ClientContextCoordinator(context, { clock, ttlDays: () => 7, workspaceEnabled: (workspaceId) => !offWorkspaces.has(workspaceId), onStatus: (status) => { statuses.push(status); } });
  return {
    coordinator,
    documents,
    registered,
    disposed,
    statuses,
    getMetadata,
    fireRecovery: () => timeout?.(),
    recoveryArmed: () => timeout !== undefined,
    turnOff: (workspaceId: string) => { offWorkspaces.add(workspaceId); },
    turnOn: (workspaceId: string) => { offWorkspaces.delete(workspaceId); },
  };
}

function deferred() {
  let settle!: () => void;
  const promise = new Promise<void>((resolve) => { settle = resolve; });
  return { promise, resolve: settle };
}

const workspace = { id: "workspace-1", path: "C:/repo" };
const turn: BeforeTurnEvent = { runId: "run-1", turnId: "turn-1", engine: "claude", sessionId: null, workspace, occurredAt: "2026-09-13T10:00:00.000Z" };
const NONCE = "4d6f62f86b3097d487489d19c8628599";
const switchEvent = { switchId: "switch-1", sourceEngine: "claude", targetEngine: "codex", sourceSessionId: "c1", targetSessionId: null, workspace, occurredAt: turn.occurredAt };
const internalFrame = (patch: unknown) => ({ plugin: "ccgui.client-context-bridge", version: 1, patch });

describe("client context coordinator", () => {
  it("keeps receipt ownership when a newer client switch replaces the pending handoff", async () => {
    const h = harness();
    const envelope = createEmptyEnvelope({ workspaceId: workspace.id, engine: "claude", turnStatus: "completed", now: turn.occurredAt });
    envelope.task.goal = "Continue both accepted targets";
    h.documents.files.set(`${workspace.id}.ccb`, { content: JSON.stringify(envelope), version: "1" });
    h.coordinator.enable();
    const switches = h.registered.runtimeSwitch as RuntimeSwitchHooks;
    const hooks = h.registered.turn as TurnHooks;
    await switches.beforeSwitch!(switchEvent);
    const first = { ...turn, engine: "codex", turnId: "first-turn" };
    const firstResult = await hooks.beforeTurn!(first);
    await switches.beforeSwitch!({ ...switchEvent, switchId: "second-switch", sourceEngine: "codex", targetEngine: "omp" });
    const second = { ...turn, engine: "omp", turnId: "second-turn" };
    const secondResult = await hooks.beforeTurn!(second);
    firstResult?.promptContributions?.find((entry) => entry.id === "ccb-handoff")?.onAccepted?.();
    secondResult?.promptContributions?.find((entry) => entry.id === "ccb-handoff")?.onAccepted?.();
    await hooks.afterTurn!({ ...first, sessionId: "first-target", status: "completed" });
    await hooks.afterTurn!({ ...second, sessionId: "second-target", status: "completed" });
    const saved = JSON.parse(h.documents.files.get(`${workspace.id}.ccb`)!.content);
    expect(saved.consumption.map((entry: { targetSessionId: string }) => entry.targetSessionId).sort()).toEqual(["first-target", "second-target"]);
  });

  it("persists a launch receipt accepted while normal turn settlement awaits metadata", async () => {
    const h = harness();
    const envelope = createEmptyEnvelope({ workspaceId: workspace.id, engine: "claude", turnStatus: "completed", now: turn.occurredAt });
    envelope.revision = 4;
    envelope.task.goal = "Continue the accepted task";
    h.documents.files.set(`${workspace.id}.ccb`, { content: JSON.stringify(envelope), version: "1" });
    h.coordinator.enable();
    const switches = h.registered.runtimeSwitch as RuntimeSwitchHooks;
    const hooks = h.registered.turn as TurnHooks;
    await switches.beforeSwitch!(switchEvent);
    const target = { ...turn, engine: "codex" };
    const collected = await hooks.beforeTurn!(target);
    const handoff = collected?.promptContributions?.find((entry) => entry.id === "ccb-handoff");
    expect(handoff).toBeDefined();
    const started = deferred();
    const gate = deferred();
    h.getMetadata.mockImplementationOnce(async () => { started.resolve(); await gate.promise; return workspace; });
    const settlement = hooks.afterTurn!({ ...target, sessionId: "receipt-target", status: "completed" });
    await started.promise;
    handoff!.onAccepted!();
    gate.resolve();
    await settlement;
    const saved = JSON.parse(h.documents.files.get(`${workspace.id}.ccb`)!.content);
    expect(saved.consumption).toEqual([expect.objectContaining({ targetEngine: "codex", targetSessionId: "receipt-target", consumedRevision: 4 })]);
    expect(h.documents.writes).toBe(1);
    const next = await hooks.beforeTurn!({ ...target, runId: "next-run", turnId: "next-turn", sessionId: "receipt-target" });
    expect(next?.promptContributions?.some((entry) => entry.id === "ccb-handoff")).toBe(false);
  });

  it("does not recreate a retired switch after its workspace is re-enabled", async () => {
    const h = harness();
    const envelope = createEmptyEnvelope({ workspaceId: workspace.id, engine: "claude", turnStatus: "completed", now: turn.occurredAt });
    envelope.task.goal = "Continue the accepted task";
    h.documents.files.set(`${workspace.id}.ccb`, { content: JSON.stringify(envelope), version: "1" });
    h.coordinator.enable();
    const switches = h.registered.runtimeSwitch as RuntimeSwitchHooks;
    const hooks = h.registered.turn as TurnHooks;
    await switches.beforeSwitch!(switchEvent);
    const collected = await hooks.beforeTurn!({ ...turn, engine: "codex" });
    expect(collected?.promptContributions?.some((entry) => entry.id === "ccb-handoff")).toBe(true);
    h.turnOff(workspace.id);
    await h.coordinator.deactivateWorkspace(workspace.id);
    h.turnOn(workspace.id);
    collected?.promptContributions?.find((entry) => entry.id === "ccb-handoff")?.onAccepted?.();
    switches.afterSwitch!(switchEvent);
    const next = await hooks.beforeTurn!({ ...turn, runId: "next-run", turnId: "next-turn", engine: "codex", sessionId: "old-target" });
    expect(next?.promptContributions?.some((entry) => entry.id === "ccb-handoff")).toBe(false);
  });

  it("keeps a new switch eligible when an older restored-target switch completes", async () => {
    const h = harness();
    const envelope = createEmptyEnvelope({ workspaceId: workspace.id, engine: "claude", turnStatus: "completed", now: turn.occurredAt });
    envelope.task.goal = "Continue the new target";
    h.documents.files.set(`${workspace.id}.ccb`, { content: JSON.stringify(envelope), version: "1" });
    h.coordinator.enable();
    const switches = h.registered.runtimeSwitch as RuntimeSwitchHooks;
    const hooks = h.registered.turn as TurnHooks;
    const oldSwitch = { ...switchEvent, switchId: "old-switch", targetSessionId: "restored-target" };
    await switches.beforeSwitch!(oldSwitch);
    h.turnOff(workspace.id);
    await h.coordinator.deactivateWorkspace(workspace.id);
    h.turnOn(workspace.id);
    await switches.beforeSwitch!({ ...switchEvent, switchId: "new-switch" });
    switches.afterSwitch!(oldSwitch);
    const fresh = await hooks.beforeTurn!({ ...turn, engine: "codex" });
    expect(fresh?.promptContributions?.some((entry) => entry.id === "ccb-handoff")).toBe(true);
  });

  it("does not settle a retired turn that finishes after workspace re-enable", async () => {
    const h = harness();
    h.coordinator.enable();
    const hooks = h.registered.turn as TurnHooks;
    await hooks.beforeTurn!(turn);
    h.turnOff(workspace.id);
    await h.coordinator.deactivateWorkspace(workspace.id);
    const latest = createEmptyEnvelope({ workspaceId: workspace.id, engine: "codex", turnStatus: "completed", now: turn.occurredAt });
    latest.task.goal = "Keep the current task";
    const document = { content: JSON.stringify(latest), version: "external" };
    h.documents.files.set(`${workspace.id}.ccb`, document);
    h.turnOn(workspace.id);
    const reads = h.documents.reads;
    await hooks.afterTurn!({ ...turn, sessionId: "old-session", status: "completed" });
    expect(h.documents.files.get(`${workspace.id}.ccb`)).toBe(document);
    expect(h.documents.reads).toBe(reads);
    expect(h.documents.writes).toBe(0);
  });

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
    await vi.waitFor(() => expect(h.documents.reads).toBe(1));
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

  it("skips a workspace the owner turned off while the other workspace keeps bridging", async () => {
    const other = { id: "workspace-2", path: "C:/other" };
    const h = harness();
    for (const id of [workspace.id, other.id]) {
      const envelope = createEmptyEnvelope({ workspaceId: id, engine: "claude", turnStatus: "completed", now: turn.occurredAt });
      envelope.task.acceptance.push({ id: "acceptance-a1", text: `Stored goal of ${id}`, source: "agent-reported", updatedAt: turn.occurredAt });
      h.documents.files.set(`${id}.ccb`, { content: JSON.stringify(envelope), version: "1" });
    }
    h.coordinator.enable();
    h.turnOff(workspace.id);
    const hooks = h.registered.turn as {
      beforeTurn(event: typeof turn): Promise<{ promptContributions?: TestContribution[] } | void>;
      onRuntimeEvent(event: unknown): void;
      afterTurn(event: unknown): Promise<void>;
    };

    const offResult = await hooks.beforeTurn(turn);
    expect(offResult).toBeUndefined();
    hooks.onRuntimeEvent({ ...turn, eventId: "e1", workspaceId: workspace.id, workspacePath: workspace.path, kind: "file-changed", path: "src/off.ts", change: "modified" });
    await hooks.afterTurn({ ...turn, status: "completed" });
    expect(h.documents.writes).toBe(0);
    expect(h.documents.files.get(`${workspace.id}.ccb`)!.version).toBe("1");

    const onTurn = { ...turn, turnId: "turn-2", workspace: other };
    const onResult = await hooks.beforeTurn(onTurn);
    expect(onResult?.promptContributions?.some((entry) => entry.content.includes("语义 patch"))).toBe(true);
    hooks.onRuntimeEvent({ ...onTurn, eventId: "e2", workspaceId: other.id, workspacePath: other.path, kind: "file-changed", path: "src/on.ts", change: "modified" });
    await hooks.afterTurn({ ...onTurn, status: "completed" });
    expect(h.documents.writes).toBe(1);
    const saved = JSON.parse(h.documents.files.get(`${other.id}.ccb`)!.content) as { changes: { files: Array<{ path: string }> } };
    expect(saved.changes.files.map((file) => file.path)).toEqual(["src/on.ts"]);
  });

  it("offers no handoff and observes no switch for a workspace that is turned off", async () => {
    const h = harness();
    const envelope = createEmptyEnvelope({ workspaceId: workspace.id, engine: "claude", turnStatus: "completed", now: turn.occurredAt });
    envelope.revision = 4;
    envelope.task.goal = "Continue the migration";
    h.documents.files.set(`${workspace.id}.ccb`, { content: JSON.stringify(envelope), version: "1" });
    h.coordinator.enable();
    h.turnOff(workspace.id);
    const switchHooks = h.registered.runtimeSwitch as { beforeSwitch(event: unknown): Promise<void>; afterSwitch(event: unknown): void };
    const turnHooks = h.registered.turn as { beforeTurn(event: typeof turn): Promise<{ promptContributions?: TestContribution[] } | void> };
    await switchHooks.beforeSwitch(switchEvent);
    switchHooks.afterSwitch(switchEvent);
    const result = await turnHooks.beforeTurn({ ...turn, turnId: "turn-2", engine: "codex", sessionId: null });
    expect(result).toBeUndefined();
    expect(h.documents.writes).toBe(0);
  });

  it("drops the draft and the in-flight turn of a workspace that is switched off", async () => {
    const h = harness();
    h.coordinator.enable();
    const hooks = h.registered.turn as {
      beforeTurn(event: typeof turn): Promise<unknown>;
      onInternalMessage(event: InternalMessageEvent): void;
      onRuntimeEvent(event: unknown): void;
      afterTurn(event: unknown): Promise<void>;
    };
    await hooks.beforeTurn(turn);
    hooks.onInternalMessage({ ...turn, channel: "semantic-patch", nonce: NONCE, payload: internalFrame({ set: { goal: "Recorded before the switch off" } }) });
    hooks.onRuntimeEvent({ ...turn, eventId: "e1", workspaceId: workspace.id, workspacePath: workspace.path, kind: "file-changed", path: "src/dropped.ts", change: "modified" });
    await vi.waitFor(() => expect(h.recoveryArmed()).toBe(true));

    // What the owner's menu entry does: stop this workspace, then purge it.
    h.turnOff(workspace.id);
    h.coordinator.purgeDrafts([`${workspace.id}.ccb`]);
    h.fireRecovery();
    await hooks.afterTurn({ ...turn, status: "completed" });
    expect(h.documents.writes).toBe(0);
    expect(h.documents.files.has(`${workspace.id}.ccb`)).toBe(false);
  });

  it("permanently revokes an already returned result when its workspace is deactivated", async () => {
    const h = harness();
    h.coordinator.enable();
    const hooks = h.registered.turn as TurnHooks;
    const first = await hooks.beforeTurn!(turn);
    expect(first?.isCurrent?.()).toBe(true);
    h.turnOff(workspace.id);
    await h.coordinator.deactivateWorkspace(workspace.id);
    h.turnOn(workspace.id);
    const next = await hooks.beforeTurn!({ ...turn, runId: "new-run", turnId: "new-turn" });
    expect(first?.isCurrent?.()).toBe(false);
    expect(next?.isCurrent?.()).toBe(true);
    h.coordinator.disable();
    expect(next?.isCurrent?.()).toBe(false);
  });

  it("contributes nothing when the workspace goes off while beforeTurn is reading its document", async () => {
    const h = harness();
    const envelope = createEmptyEnvelope({ workspaceId: workspace.id, engine: "claude", turnStatus: "completed", now: turn.occurredAt });
    envelope.task.acceptance.push({ id: "acceptance-a1", text: "Stored acceptance", source: "agent-reported", updatedAt: turn.occurredAt });
    h.documents.files.set(`${workspace.id}.ccb`, { content: JSON.stringify(envelope), version: "1" });
    h.coordinator.enable();
    const hooks = h.registered.turn as { beforeTurn(event: typeof turn): Promise<{ promptContributions?: TestContribution[] } | void>; afterTurn(event: unknown): Promise<void> };
    const gate = deferred();
    h.documents.blockFirstRead = () => gate.promise;

    const pending = hooks.beforeTurn(turn);
    await vi.waitFor(() => expect(h.documents.reads).toBe(1));
    // The owner switches this workspace off mid-read.
    h.turnOff(workspace.id);
    await h.coordinator.deactivateWorkspace(workspace.id);
    gate.resolve();
    expect(await pending).toBeUndefined();

    // The late read must not have installed a draft that a settle could write.
    await hooks.afterTurn({ ...turn, status: "completed" });
    expect(h.documents.writes).toBe(0);
    expect(h.documents.files.get(`${workspace.id}.ccb`)!.version).toBe("1");
  });

  it("reads no document for a queued runtime event whose workspace went off before it ran", async () => {
    const h = harness();
    h.documents.files.set(`${workspace.id}.ccb`, { content: JSON.stringify(createEmptyEnvelope({ workspaceId: workspace.id, engine: "claude", turnStatus: "completed", now: turn.occurredAt })), version: "1" });
    h.coordinator.enable();
    const hooks = h.registered.turn as { onRuntimeEvent(event: unknown): void; afterTurn(event: unknown): Promise<void> };
    const gate = deferred();
    h.documents.blockFirstRead = () => gate.promise;

    // Two events queue behind one blocked read; the workspace goes off while
    // the first is still in flight, so the second must never read at all.
    hooks.onRuntimeEvent({ ...turn, eventId: "e1", workspaceId: workspace.id, workspacePath: workspace.path, kind: "file-changed", path: "src/first.ts", change: "modified" });
    hooks.onRuntimeEvent({ ...turn, eventId: "e2", workspaceId: workspace.id, workspacePath: workspace.path, kind: "file-changed", path: "src/second.ts", change: "modified" });
    await vi.waitFor(() => expect(h.documents.reads).toBe(1));
    h.turnOff(workspace.id);
    gate.resolve();
    await h.coordinator.deactivateWorkspace(workspace.id);
    expect(h.documents.reads).toBe(1);

    await hooks.afterTurn({ ...turn, status: "completed" });
    expect(h.documents.reads).toBe(1);
    expect(h.documents.writes).toBe(0);
    expect(h.recoveryArmed()).toBe(false);
  });

  it.each(["workspace", "global"] as const)("starts no document read when %s disable interrupts beforeTurn metadata", async (scope) => {
    const h = harness();
    h.coordinator.enable();
    const hooks = h.registered.turn as { beforeTurn(event: typeof turn): Promise<unknown> };
    const started = deferred();
    const gate = deferred();
    h.getMetadata.mockImplementationOnce(async () => { started.resolve(); await gate.promise; return workspace; });

    const pending = hooks.beforeTurn(turn);
    await started.promise;
    if (scope === "global") h.coordinator.disable();
    else {
      h.turnOff(workspace.id);
      await h.coordinator.deactivateWorkspace(workspace.id);
    }
    gate.resolve();

    expect(await pending).toBeUndefined();
    expect(h.documents.reads).toBe(0);
    expect(h.documents.writes).toBe(0);
  });

  it.each(["workspace", "global"] as const)("discards an old semantic patch across %s disable and re-enable during afterTurn metadata", async (scope) => {
    const h = harness();
    h.coordinator.enable();
    const hooks = h.registered.turn as {
      beforeTurn(event: typeof turn): Promise<unknown>;
      onInternalMessage(event: InternalMessageEvent): void;
      afterTurn(event: unknown): Promise<void>;
    };
    await hooks.beforeTurn(turn);
    hooks.onInternalMessage({ ...turn, channel: "semantic-patch", nonce: NONCE, payload: internalFrame({ set: { goal: "Discard this old patch" } }) });
    const started = deferred();
    const gate = deferred();
    h.getMetadata.mockImplementationOnce(async () => { started.resolve(); await gate.promise; return workspace; });
    const pending = hooks.afterTurn({ ...turn, status: "completed" });
    await started.promise;

    if (scope === "global") h.coordinator.disable();
    else {
      h.turnOff(workspace.id);
      await h.coordinator.deactivateWorkspace(workspace.id);
    }
    const external = createEmptyEnvelope({ workspaceId: workspace.id, engine: "codex", turnStatus: "completed", now: turn.occurredAt });
    external.task.goal = "Keep the other client's goal";
    const document = { content: JSON.stringify(external), version: "external" };
    h.documents.files.set(`${workspace.id}.ccb`, document);
    const readsBeforeResume = h.documents.reads;
    if (scope === "global") h.coordinator.enable();
    else h.turnOn(workspace.id);
    gate.resolve();
    await pending;

    expect(h.documents.reads).toBe(readsBeforeResume);
    expect(h.documents.writes).toBe(0);
    expect(h.documents.files.get(`${workspace.id}.ccb`)).toEqual(document);
    const resumed = h.registered.turn as typeof hooks;
    await resumed.beforeTurn({ ...turn, turnId: "fresh-turn" });
    await resumed.afterTurn({ ...turn, turnId: "fresh-turn", status: "completed" });
    expect(JSON.parse(h.documents.files.get(`${workspace.id}.ccb`)!.content).task.goal).toBe(external.task.goal);
  });

  it("does not restore a discarded switch handoff when its pending write finishes after workspace disable", async () => {
    const h = harness();
    const envelope = createEmptyEnvelope({ workspaceId: workspace.id, engine: "claude", turnStatus: "completed", now: turn.occurredAt });
    envelope.revision = 4;
    envelope.task.goal = "Discard this switch handoff";
    h.documents.files.set(`${workspace.id}.ccb`, { content: JSON.stringify(envelope), version: "original" });
    h.coordinator.enable();
    const hooks = h.registered.turn as { beforeTurn(event: typeof turn): Promise<{ promptContributions?: TestContribution[] } | void>; onRuntimeEvent(event: unknown): void };
    hooks.onRuntimeEvent({ ...turn, eventId: "e1", workspaceId: workspace.id, workspacePath: workspace.path, kind: "file-changed", path: "src/pending.ts", change: "modified" });
    await vi.waitFor(() => expect(h.recoveryArmed()).toBe(true));
    const started = deferred();
    const gate = deferred();
    const write = h.documents.writeTextAtomic.bind(h.documents);
    vi.spyOn(h.documents, "writeTextAtomic").mockImplementationOnce(async (...args) => { started.resolve(); await gate.promise; return write(...args); });
    const switches = h.registered.runtimeSwitch as { beforeSwitch(event: unknown): Promise<void>; afterSwitch(event: unknown): void };
    const pending = switches.beforeSwitch(switchEvent);
    await started.promise;

    h.turnOff(workspace.id);
    await h.coordinator.deactivateWorkspace(workspace.id);
    const statusesBeforeRelease = [...h.statuses];
    gate.resolve();
    await pending;
    expect(h.statuses).toEqual(statusesBeforeRelease);
    switches.afterSwitch(switchEvent);
    h.turnOn(workspace.id);

    const result = await hooks.beforeTurn({ ...turn, turnId: "target-turn", engine: "codex" });
    expect(result?.promptContributions?.some((entry) => entry.id === "ccb-handoff")).toBe(false);
  });

  it("starts no conflict reload or follow-up write after a pending settle write is disabled", async () => {
    const h = harness();
    h.coordinator.enable();
    const hooks = h.registered.turn as { beforeTurn(event: typeof turn): Promise<unknown>; onInternalMessage(event: InternalMessageEvent): void; afterTurn(event: unknown): Promise<void> };
    await hooks.beforeTurn(turn);
    hooks.onInternalMessage({ ...turn, channel: "semantic-patch", nonce: NONCE, payload: internalFrame({ set: { goal: "Stale local goal" } }) });
    const started = deferred();
    const gate = deferred();
    const write = h.documents.writeTextAtomic.bind(h.documents);
    const writes = vi.spyOn(h.documents, "writeTextAtomic").mockImplementationOnce(async (...args) => { started.resolve(); await gate.promise; return write(...args); });
    const pending = hooks.afterTurn({ ...turn, status: "completed" });
    await started.promise;
    const readsBeforeDisable = h.documents.reads;
    h.turnOff(workspace.id);
    const disabled = h.coordinator.deactivateWorkspace(workspace.id);
    const external = createEmptyEnvelope({ workspaceId: workspace.id, engine: "codex", turnStatus: "completed", now: turn.occurredAt });
    external.task.goal = "Other client's latest goal";
    const document = { content: JSON.stringify(external), version: "external" };
    h.documents.files.set(`${workspace.id}.ccb`, document);
    const statusesBeforeRelease = [...h.statuses];
    gate.resolve();
    await Promise.all([pending, disabled]);
    expect(h.statuses).toEqual(statusesBeforeRelease);

    expect(h.documents.reads).toBe(readsBeforeDisable);
    expect(writes).toHaveBeenCalledTimes(1);
    expect(h.documents.writes).toBe(0);
    expect(h.documents.files.get(`${workspace.id}.ccb`)).toEqual(document);
    expect([...h.documents.files.keys()]).toEqual([`${workspace.id}.ccb`]);
  });

  it("does not let a maintenance force flush survive global disable and re-enable", async () => {
    const h = harness();
    h.coordinator.enable();
    const hooks = h.registered.turn as { onRuntimeEvent(event: unknown): void };
    hooks.onRuntimeEvent({ ...turn, eventId: "e1", workspaceId: workspace.id, workspacePath: workspace.path, kind: "file-changed", path: "src/stale.ts", change: "modified" });
    await vi.waitFor(() => expect(h.recoveryArmed()).toBe(true));
    const started = deferred();
    const gate = deferred();
    const write = h.documents.writeTextAtomic.bind(h.documents);
    const writes = vi.spyOn(h.documents, "writeTextAtomic").mockImplementationOnce(async (...args) => { started.resolve(); await gate.promise; return write(...args); });
    const pending = h.coordinator.pauseForMaintenance();
    await started.promise;
    const readsBeforeDisable = h.documents.reads;
    h.coordinator.disable();
    const external = createEmptyEnvelope({ workspaceId: workspace.id, engine: "codex", turnStatus: "completed", now: turn.occurredAt });
    external.task.goal = "External maintenance update";
    const document = { content: JSON.stringify(external), version: "external" };
    h.documents.files.set(`${workspace.id}.ccb`, document);
    h.coordinator.enable();
    const statusesBeforeRelease = [...h.statuses];
    gate.resolve();
    await pending;
    expect(h.statuses).toEqual(statusesBeforeRelease);

    expect(h.documents.reads).toBe(readsBeforeDisable);
    expect(writes).toHaveBeenCalledTimes(1);
    expect(h.documents.writes).toBe(0);
    expect(h.documents.files.get(`${workspace.id}.ccb`)).toEqual(document);
  });

  it("reloads the document instead of a stale draft when a workspace is turned back on", async () => {
    const h = harness();
    h.coordinator.enable();
    const hooks = h.registered.turn as {
      beforeTurn(event: typeof turn): Promise<{ promptContributions?: TestContribution[] } | void>;
      onInternalMessage(event: InternalMessageEvent): void;
      afterTurn(event: unknown): Promise<void>;
    };
    await hooks.beforeTurn(turn);
    hooks.onInternalMessage({ ...turn, channel: "semantic-patch", nonce: NONCE, payload: internalFrame({ append: { acceptance: ["Never persisted"] } }) });
    h.turnOff(workspace.id);
    await h.coordinator.deactivateWorkspace(workspace.id);

    // A document written by another client while this workspace was off.
    const external = createEmptyEnvelope({ workspaceId: workspace.id, engine: "codex", turnStatus: "completed", now: turn.occurredAt });
    external.task.acceptance.push({ id: "acceptance-ext", text: "Written elsewhere", source: "agent-reported", updatedAt: turn.occurredAt });
    h.documents.files.set(`${workspace.id}.ccb`, { content: JSON.stringify(external), version: "1" });

    h.turnOn(workspace.id);
    const resumed = await hooks.beforeTurn({ ...turn, turnId: "turn-2" });
    const protocol = resumed?.promptContributions?.find((entry) => entry.id === "ccb-protocol-turn-2")?.content ?? "";
    expect(protocol).toContain("acceptance-ext");
    expect(protocol).not.toContain("Never persisted");

    await hooks.afterTurn({ ...turn, turnId: "turn-2", status: "completed" });
    const saved = JSON.parse(h.documents.files.get(`${workspace.id}.ccb`)!.content) as { task: { acceptance: Array<{ text: string }> } };
    expect(saved.task.acceptance.map((item) => item.text)).toEqual(["Written elsewhere"]);
  });
});
