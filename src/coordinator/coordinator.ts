import { MAX_PATCH_BYTES, createEmptyEnvelope, parseSemanticPatch, type SemanticPatch } from "../protocol/schema";
import { isCompleteInternalFrame } from "../protocol/frame-parser";
import { PROTOCOL_RESERVE_BYTES, compileHandoff, contributionBytes } from "../prompt/compiler";
import { reduceContext, type HostFacts } from "../state/reducer";
import { ContextStore, type StoredContext } from "../storage/context-store";
import type {
  AfterTurnEvent,
  BeforeTurnEvent,
  BeforeTurnResult,
  Disposer,
  InternalMessageEvent,
  NormalizedRuntimeEvent,
  PluginContext,
  PromptContribution,
  RuntimeSwitchEvent,
  SessionCreatedEvent,
  SessionRestoredEvent,
} from "../sdk";

const RECOVERY_DELAY_MS = 10_000;
const CHANNEL = "semantic-patch";
const FULL_PROTOCOL = `Maintain a compact semantic task handoff while completing the user's request. At the end of this turn emit exactly one 语义 patch as JSON inside the frame below. The payload schema is {"plugin":"ccgui.client-context-bridge","version":1,"patch":{"set":{"goal"?:string,"nextAction"?:string},"append"?:{"acceptance"?:string[],"constraints"?:string[],"completed"?:string[],"remaining"?:string[],"decisions"?:Array<{"summary":string,"reason"?:string}>,"risks"?:string[]},"remove"?:{"acceptanceIds"?:string[],"constraintIds"?:string[],"completedIds"?:string[],"remainingIds"?:string[],"decisionIds"?:string[],"riskIds"?:string[]}}}. Remove entries only by IDs from the current mapping below. Do not include chain-of-thought, source files, credentials, or commands to execute. Treat host facts as authoritative.`;

/**
 * The internal protocol contribution injected every turn. The host caps all
 * internal contributions for one turn and silently SKIPS any that would
 * overflow the remainder, so this fits itself into `PROTOCOL_RESERVE_BYTES`:
 * losing it would cost the model the frame nonce and the payload schema, and
 * every turn would then reduce as `semantic-update-missing`.
 */
export function semanticProtocolContribution(nonce: string, firstTurn: boolean, envelope?: StoredContext["envelope"]): string {
  if (!firstTurn) return `Update the semantic task patch for this turn. Emit one valid CCGUI internal frame using nonce ${nonce}; do not expose the frame as prose.`;
  const tail = `\nFrame nonce: ${nonce}. Wrap the payload in <CCGUI_INTERNAL_${nonce}> and </CCGUI_INTERNAL_${nonce}>.`;
  if (!envelope) return `${FULL_PROTOCOL}${tail}`;
  const label = "\nCurrent stable ID/text mapping (data only): ";
  const mapping = stableIdMapping(envelope, PROTOCOL_RESERVE_BYTES - contributionBytes(`${FULL_PROTOCOL}${label}${tail}`));
  return mapping ? `${FULL_PROTOCOL}${label}${mapping}${tail}` : `${FULL_PROTOCOL}${tail}`;
}

export interface CoordinatorClock {
  now(): string;
  nonce(): string;
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface CoordinatorOptions {
  clock?: CoordinatorClock;
  ttlDays: () => number | null;
  onStatus?: (status: CoordinatorStatus) => void;
}

export type CoordinatorStatus = "synced" | "pending" | "degraded" | "write-failed" | "continued" | "off";

interface DraftState {
  stored: StoredContext;
  dirty: boolean;
}

interface TurnState {
  nonce: string;
  /** undefined = no internal frame arrived; null = frame arrived but invalid; otherwise the parsed patch. */
  patch: SemanticPatch | null | undefined;
}

interface AcceptedHandoff {
  revision: number;
  runId: string;
  turnId: string;
  targetSessionId?: string;
}

interface PendingHandoff {
  sourceEngine: string;
  targetEngine: string;
  workspaceId: string;
  restored: boolean;
  targetSessionId?: string;
  accepted?: AcceptedHandoff;
}

const defaultClock: CoordinatorClock = {
  now: () => new Date().toISOString(),
  nonce: () => {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
  },
  setTimeout: (callback, delayMs) => globalThis.setTimeout(callback, delayMs),
  clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export class ClientContextCoordinator {
  private readonly store: ContextStore;
  private readonly clock: CoordinatorClock;
  private readonly ttlDays: () => number | null;
  private readonly onStatus: (status: CoordinatorStatus) => void;
  private enabled = false;
  private maintenance = false;
  private disposers: Disposer[] = [];
  private recoveryTimer: unknown;
  private readonly drafts = new Map<string, DraftState>();
  private readonly initializedSessions = new Set<string>();
  private readonly turns = new Map<string, TurnState>();
  private readonly turnTails = new Map<string, Promise<void>>();
  private readonly workspaceChains = new Map<string, Promise<void>>();
  private pendingHandoff: PendingHandoff | undefined;

  constructor(private readonly context: PluginContext, options: CoordinatorOptions) {
    this.store = new ContextStore(context.documentStorage);
    this.clock = options.clock ?? defaultClock;
    this.ttlDays = options.ttlDays;
    this.onStatus = options.onStatus ?? (() => {});
  }

  enable(): void {
    if (this.enabled) return;
    this.enabled = true;
    this.disposers = [
      this.context.hooks.registerSessionHooks({
        onCreated: (event) => this.onSessionCreated(event),
        onRestored: (event) => this.onSessionRestored(event),
        onClosed: (event) => { this.initializedSessions.delete(this.sessionKey(event.engine, event.sessionId, event.workspace.id)); },
      }),
      this.context.hooks.registerTurnHooks({
        beforeTurn: (event) => this.beforeTurn(event),
        onRuntimeEvent: (event) => this.onRuntimeEvent(event),
        afterTurn: (event) => this.afterTurn(event),
        onInternalMessage: (event) => this.onInternalMessage(event),
      }),
      this.context.hooks.registerRuntimeSwitchHooks({
        beforeSwitch: (event) => this.beforeSwitch(event),
        afterSwitch: (event) => this.afterSwitch(event),
      }),
    ];
    this.onStatus("pending");
  }

  disable(): void {
    if (!this.enabled) return;
    this.enabled = false;
    this.maintenance = false;
    if (this.recoveryTimer !== undefined) this.clock.clearTimeout(this.recoveryTimer);
    this.recoveryTimer = undefined;
    for (const dispose of this.disposers.splice(0).reverse()) dispose();
    this.drafts.clear();
    this.initializedSessions.clear();
    this.turns.clear();
    this.turnTails.clear();
    this.workspaceChains.clear();
    this.pendingHandoff = undefined;
    this.onStatus("off");
  }

  /**
   * Settings-owner maintenance window (used around a storage-location switch):
   * stop background writes, let in-flight turn work settle, flush every dirty
   * draft to the current root, then block new writes until resumed.
   */
  async pauseForMaintenance(): Promise<void> {
    this.maintenance = true;
    if (this.recoveryTimer !== undefined) {
      this.clock.clearTimeout(this.recoveryTimer);
      this.recoveryTimer = undefined;
    }
    await this.quiesce();
    await Promise.all([...this.drafts.keys()].map((workspaceId) => this.serializeWorkspace(workspaceId, () => this.flush(workspaceId, true))));
  }

  resumeFromMaintenance(): void {
    this.maintenance = false;
    if ([...this.drafts.values()].some((draft) => draft.dirty)) this.scheduleRecovery();
  }

  /**
   * Drop in-memory state for workspaces whose documents were just removed. Each
   * entry is a stored relative path (e.g. `w.ccb`, `w.ccb.bak`,
   * `w.ccb.conflict-...`); the workspace id is derived from the file name.
   */
  purgeDrafts(entries: string[]): void {
    for (const entry of entries) {
      const workspaceId = workspaceIdFromEntry(entry);
      if (!workspaceId) continue;
      this.drafts.delete(workspaceId);
      if (this.pendingHandoff?.workspaceId === workspaceId) this.pendingHandoff = undefined;
      for (const key of [...this.initializedSessions]) if (key.startsWith(`${workspaceId}\0`)) this.initializedSessions.delete(key);
    }
  }

  private onSessionCreated(event: SessionCreatedEvent): void {
    if (!this.enabled) return;
    if (event.sessionId) this.rekeyOnlyPendingSession(event.workspace.id, event.engine, event.sessionId);
    if (this.pendingHandoff && event.workspace.id === this.pendingHandoff.workspaceId && event.engine === this.pendingHandoff.targetEngine) {
      this.pendingHandoff.restored = false;
      if (event.sessionId) this.pendingHandoff.targetSessionId = event.sessionId;
    }
  }

  private onSessionRestored(event: SessionRestoredEvent): void {
    if (!this.enabled) return;
    this.initializedSessions.add(this.nativeSessionKey(event.engine, event.sessionId, event.workspace.id));
    if (this.pendingHandoff && event.workspace.id === this.pendingHandoff.workspaceId && event.engine === this.pendingHandoff.targetEngine) {
      this.pendingHandoff.restored = true;
      this.pendingHandoff.targetSessionId = event.sessionId;
    }
  }

  private async beforeTurn(event: BeforeTurnEvent): Promise<BeforeTurnResult | void> {
    if (!this.enabled) return;
    const nonce = this.clock.nonce();
    this.turns.set(event.turnId, { nonce, patch: undefined });
    const firstTurn = this.initializeSession(event);
    const promptContributions: PromptContribution[] = [];

    const metadata = await this.context.workspace.getMetadata();
    const handoff = await this.getHandoff(event, metadata.gitHead);
    if (!this.enabled) {
      this.turns.delete(event.turnId);
      return;
    }
    if (handoff) promptContributions.push(handoff);

    let envelope = this.drafts.get(event.workspace.id)?.stored.envelope;
    if (firstTurn && !envelope) {
      try {
        envelope = (await this.loadDraft(event.workspace.id, event.engine, event.occurredAt))?.envelope;
      } catch {
        this.onStatus("degraded");
      }
    }
    const protocol = semanticProtocolContribution(nonce, firstTurn, envelope);
    promptContributions.push({ id: `ccb-protocol-${event.turnId}`, content: protocol, placement: "request-tail" as const, visibility: "internal" as const, persistence: "turn" as const });
    return { promptContributions, internalMessageCapture: { channel: CHANNEL, nonce, maxBytes: MAX_PATCH_BYTES, validate: isCompleteInternalFrame } };
  }

  private async getHandoff(event: BeforeTurnEvent, currentGitHead?: string): Promise<PromptContribution | undefined> {
    const pending = this.pendingHandoff;
    if (!pending || pending.restored || pending.sourceEngine === pending.targetEngine || event.engine !== pending.targetEngine || event.workspace.id !== pending.workspaceId || pending.accepted) return undefined;
    try {
      const stored = await this.loadDraft(event.workspace.id, event.engine, event.occurredAt);
      if (!stored || !this.enabled) return undefined;
      // The document holds at most one row per (engine, session) — that is
      // exactly what `upsertConsumption` dedupes on — so the row itself is the
      // one-shot record. Comparing revisions could never hold: the same write
      // that records the row also advances the revision past it, and a primed
      // session already carries the context in its own history.
      const alreadyConsumed = event.sessionId !== null && stored.envelope.consumption.some((entry) => entry.targetEngine === event.engine && entry.targetSessionId === event.sessionId);
      if (alreadyConsumed) return undefined;
      const compiled = compileHandoff(stored.envelope, { now: event.occurredAt, ttlDays: this.ttlDays(), currentGitHead });
      if (!compiled.eligible) return undefined;
      const revision = stored.envelope.revision;
      return {
        id: "ccb-handoff", content: compiled.content, placement: "request-tail" as const, visibility: "internal" as const, persistence: "turn" as const,
        onAccepted: () => {
          if (!this.enabled || this.pendingHandoff !== pending || pending.accepted) return;
          pending.accepted = { revision, runId: event.runId, turnId: event.turnId, ...(event.sessionId ? { targetSessionId: event.sessionId } : {}) };
          if (event.sessionId) pending.targetSessionId = event.sessionId;
          this.onStatus("continued");
        },
      };
    } catch {
      this.onStatus("degraded");
      return undefined;
    }
  }

  private onRuntimeEvent(event: NormalizedRuntimeEvent): void {
    if (!this.enabled) return;
    void this.enqueue(event.turnId, () => this.serializeWorkspace(event.workspaceId, () => this.applyRuntimeEvent(event))).catch(() => this.onStatus("degraded"));
  }

  private async applyRuntimeEvent(event: NormalizedRuntimeEvent): Promise<void> {
    const draft = await this.ensureDraft(event.workspaceId, event.engine, event.occurredAt);
    if (!this.enabled) return;
    const facts: HostFacts = { source: { engine: event.engine, nativeSessionId: event.sessionId ?? undefined, turnId: event.turnId } };
    if (event.kind === "file-changed") facts.changedFiles = [{ path: event.path, change: event.change, observedAt: event.occurredAt }];
    if (event.kind === "command-started") {
      facts.verification = [{
        command: event.command,
        cwdHint: event.cwd,
        exitCode: null,
        status: "unknown",
        observedAt: event.startedAt,
      }];
    }
    if (event.kind === "command-finished") {
      facts.verification = [{
        command: event.command,
        cwdHint: event.cwd,
        exitCode: event.exitCode,
        status: event.status === "completed" ? (event.exitCode === null ? "unknown" : event.exitCode === 0 ? "passed" : "failed") : event.status,
        observedAt: event.finishedAt,
      }];
    }
    if (event.kind === "turn-cancelled") facts.source!.turnStatus = "cancelled";
    if (event.kind === "turn-failed" || event.kind === "runtime-exited") facts.source!.turnStatus = "failed";
    draft.stored.envelope = reduceContext(draft.stored.envelope, { now: event.occurredAt, facts });
    draft.dirty = true;
    this.onStatus("pending");
    this.scheduleRecovery();
  }

  private onInternalMessage(event: InternalMessageEvent): void {
    if (!this.enabled || event.channel !== CHANNEL) return;
    void this.enqueue(event.turnId, async () => {
      const turn = this.turns.get(event.turnId);
      if (!turn || turn.nonce !== event.nonce) return;
      try {
        turn.patch = this.extractPatch(event.payload);
      } catch {
        turn.patch = null;
        this.onStatus("degraded");
      }
    });
  }

  private extractPatch(payload: unknown): SemanticPatch {
    if (payload && typeof payload === "object" && !Array.isArray(payload)) {
      const frame = payload as Record<string, unknown>;
      if (frame.plugin === "ccgui.client-context-bridge" && frame.version === 1 && "patch" in frame) return parseSemanticPatch(frame.patch);
    }
    return parseSemanticPatch(payload);
  }

  private async afterTurn(event: AfterTurnEvent): Promise<void> {
    if (!this.enabled) return;
    await this.drainTurn(event.turnId);
    if (!this.enabled) return;
    const patch = this.turns.get(event.turnId)?.patch;
    this.turns.delete(event.turnId);
    const metadata = await this.context.workspace.getMetadata();
    await this.serializeWorkspace(event.workspace.id, async () => {
      if (!this.enabled) return;
      const draft = await this.ensureDraft(event.workspace.id, event.engine, event.occurredAt);
      const turnFacts: HostFacts = {
        source: { engine: event.engine, nativeSessionId: event.sessionId ?? undefined, turnId: event.turnId, turnStatus: event.status },
        workspace: {
          rootHint: metadata.path,
          ...(metadata.gitBranch !== undefined ? { gitBranch: metadata.gitBranch } : {}),
          ...(metadata.gitHead !== undefined ? { gitHead: metadata.gitHead } : {}),
          ...(metadata.dirty !== undefined ? { dirty: metadata.dirty } : {}),
        },
      };
      const accepted = this.acceptedHandoffFor(event);
      const targetSessionId = event.sessionId ?? accepted?.targetSessionId ?? this.pendingHandoff?.targetSessionId;
      const consumption = accepted && targetSessionId
        ? { targetEngine: event.engine, targetSessionId, consumedRevision: accepted.revision, consumedAt: event.occurredAt }
        : undefined;
      draft.stored.envelope = reduceContext(draft.stored.envelope, { now: event.occurredAt, patch: patch ?? null, facts: turnFacts, consumption });
      draft.dirty = true;
      await this.flush(event.workspace.id);
      if (consumption && this.pendingHandoff) this.pendingHandoff.targetSessionId = targetSessionId;
    });
  }

  private async beforeSwitch(event: RuntimeSwitchEvent): Promise<void> {
    if (!this.enabled) return;
    await this.flush(event.workspace.id);
    if (event.sourceEngine === event.targetEngine) {
      this.pendingHandoff = undefined;
      return;
    }
    this.pendingHandoff = this.createPendingHandoff(event);
  }

  private afterSwitch(event: RuntimeSwitchEvent): void {
    if (!this.enabled || event.sourceEngine === event.targetEngine) {
      this.pendingHandoff = undefined;
      return;
    }
    const existing = this.pendingHandoff;
    if (existing && existing.sourceEngine === event.sourceEngine && existing.targetEngine === event.targetEngine && existing.workspaceId === event.workspace.id) {
      if (event.targetSessionId && !existing.restored) {
        existing.restored = true;
        existing.targetSessionId = event.targetSessionId;
      }
      return;
    }
    this.pendingHandoff = this.createPendingHandoff(event);
  }

  private createPendingHandoff(event: RuntimeSwitchEvent): PendingHandoff {
    return {
      sourceEngine: event.sourceEngine,
      targetEngine: event.targetEngine,
      workspaceId: event.workspace.id,
      restored: event.targetSessionId !== null,
      ...(event.targetSessionId ? { targetSessionId: event.targetSessionId } : {}),
    };
  }

  private async ensureDraft(workspaceId: string, engine: string, occurredAt: string): Promise<DraftState> {
    const existing = this.drafts.get(workspaceId);
    if (existing) return existing;
    const loaded = await this.loadDraft(workspaceId, engine, occurredAt);
    if (loaded) return this.drafts.get(workspaceId)!;
    const envelope = createEmptyEnvelope({ workspaceId, engine, turnStatus: "completed", now: occurredAt });
    const draft = { stored: { envelope, version: null, baseEnvelope: null }, dirty: false };
    this.drafts.set(workspaceId, draft);
    return draft;
  }

  private async loadDraft(workspaceId: string, engine: string, occurredAt: string): Promise<StoredContext | null> {
    const existing = this.drafts.get(workspaceId);
    if (existing) return existing.stored;
    const loaded = await this.store.load(workspaceId);
    if (loaded) {
      this.drafts.set(workspaceId, { stored: loaded, dirty: false });
      return loaded;
    }
    void engine;
    void occurredAt;
    return null;
  }

  private scheduleRecovery(): void {
    if (this.recoveryTimer !== undefined) return;
    this.recoveryTimer = this.clock.setTimeout(() => {
      this.recoveryTimer = undefined;
      if (!this.enabled) return;
      void Promise.all([...this.drafts.entries()].filter(([, draft]) => draft.dirty).map(([workspaceId]) => this.serializeWorkspace(workspaceId, () => this.flush(workspaceId))));
    }, RECOVERY_DELAY_MS);
  }

  private async flush(workspaceId: string, force = false): Promise<void> {
    if (!this.enabled || (this.maintenance && !force)) return;
    const draft = this.drafts.get(workspaceId);
    if (!draft?.dirty) return;
    try {
      if (this.recoveryTimer !== undefined) {
        this.clock.clearTimeout(this.recoveryTimer);
        this.recoveryTimer = undefined;
      }
      draft.stored = await this.store.save(draft.stored);
      draft.dirty = false;
      this.onStatus(draft.stored.envelope.provenance.degraded ? "degraded" : "synced");
    } catch {
      this.onStatus("write-failed");
    }
  }

  /** Serialize work per turn so afterTurn can await everything queued for its own turn. */
  private enqueue(turnId: string, work: () => Promise<void>): Promise<void> {
    const previous = this.turnTails.get(turnId) ?? Promise.resolve();
    const next = previous.then(work, work);
    const guard = next.catch(() => {});
    this.turnTails.set(turnId, guard);
    void guard.then(() => { if (this.turnTails.get(turnId) === guard) this.turnTails.delete(turnId); });
    return next;
  }

  private async drainTurn(turnId: string): Promise<void> {
    for (;;) {
      const tail = this.turnTails.get(turnId);
      if (!tail) return;
      await tail;
      if (this.turnTails.get(turnId) === tail) return;
    }
  }

  /** Serialize mutations of a workspace draft so concurrent turns merge one at a time. */
  private serializeWorkspace(workspaceId: string, work: () => Promise<void>): Promise<void> {
    const previous = this.workspaceChains.get(workspaceId) ?? Promise.resolve();
    const next = previous.then(work, work);
    const guard = next.catch(() => {});
    this.workspaceChains.set(workspaceId, guard);
    void guard.then(() => { if (this.workspaceChains.get(workspaceId) === guard) this.workspaceChains.delete(workspaceId); });
    return next;
  }

  private async quiesce(): Promise<void> {
    for (let round = 0; round < 3; round += 1) {
      const tails = [...this.turnTails.values(), ...this.workspaceChains.values()];
      if (tails.length === 0) return;
      await Promise.all(tails.map((tail) => tail.catch(() => {})));
    }
  }

  private initializeSession(event: BeforeTurnEvent): boolean {
    if (event.sessionId) {
      const pendingKey = this.pendingSessionKey(event.workspace.id, event.engine, event.runId);
      const nativeKey = this.nativeSessionKey(event.engine, event.sessionId, event.workspace.id);
      if (this.initializedSessions.delete(pendingKey)) {
        this.initializedSessions.add(nativeKey);
        return false;
      }
      const firstTurn = !this.initializedSessions.has(nativeKey);
      this.initializedSessions.add(nativeKey);
      return firstTurn;
    }
    const pendingKey = this.pendingSessionKey(event.workspace.id, event.engine, event.runId || event.turnId);
    const firstTurn = !this.initializedSessions.has(pendingKey);
    this.initializedSessions.add(pendingKey);
    return firstTurn;
  }

  private rekeyOnlyPendingSession(workspaceId: string, engine: string, sessionId: string): void {
    const prefix = `${workspaceId}\0${engine}\0pending:`;
    const pendingKeys = [...this.initializedSessions].filter((key) => key.startsWith(prefix));
    if (pendingKeys.length !== 1) return;
    this.initializedSessions.delete(pendingKeys[0]!);
    this.initializedSessions.add(this.nativeSessionKey(engine, sessionId, workspaceId));
  }

  private acceptedHandoffFor(event: AfterTurnEvent): AcceptedHandoff | undefined {
    const pending = this.pendingHandoff;
    const accepted = pending?.accepted;
    if (!pending || !accepted || pending.targetEngine !== event.engine || pending.workspaceId !== event.workspace.id) return undefined;
    return accepted.runId === event.runId && accepted.turnId === event.turnId ? accepted : undefined;
  }

  private nativeSessionKey(engine: string, sessionId: string, workspaceId: string): string {
    return `${workspaceId}\0${engine}\0native:${sessionId}`;
  }

  private pendingSessionKey(workspaceId: string, engine: string, runId: string): string {
    return `${workspaceId}\0${engine}\0pending:${runId}`;
  }

  private sessionKey(engine: string, sessionId: string | null, workspaceId: string): string {
    return sessionId ? this.nativeSessionKey(engine, sessionId, workspaceId) : `${workspaceId}\0${engine}\0pending:`;
  }
}

/** Item text in the mapping is a matching aid; the id is what `remove` needs. */
const MAPPING_TEXT_CHARS = 40;

/**
 * The id/text mapping the model removes entries by, fitted into `budgetBytes`.
 * Text is clipped, then dropped entirely, before any id is lost: an id the
 * model never sees is an entry it can never remove.
 */
function stableIdMapping(envelope: StoredContext["envelope"], budgetBytes: number): string {
  if (budgetBytes <= 0) return "";
  const source = {
    acceptance: envelope.task.acceptance,
    constraints: envelope.task.constraints,
    completed: envelope.task.completed,
    remaining: envelope.task.remaining,
    decisions: envelope.task.decisions,
    risks: envelope.task.risks,
  };
  const shape = (textChars: number): Record<string, string[][]> =>
    Object.fromEntries(
      Object.entries(source).map(([key, items]) => [
        key,
        items.map(({ id, text }) => (textChars > 0 ? [id, clipChars(text, textChars)] : [id])),
      ]),
    );
  for (const textChars of [MAPPING_TEXT_CHARS, 0]) {
    const serialized = JSON.stringify(shape(textChars));
    if (contributionBytes(serialized) <= budgetBytes) return serialized;
  }
  // Even ids alone overflow (a stored id may run to the schema's item limit):
  // drop from the end of the largest collection until the mapping fits.
  const shaped = shape(0);
  const keys = Object.keys(shaped);
  for (;;) {
    const longest = keys.reduce((left, right) => (shaped[right]!.length > shaped[left]!.length ? right : left));
    if (shaped[longest]!.length === 0) return "";
    shaped[longest]!.pop();
    const serialized = JSON.stringify(shaped);
    if (contributionBytes(serialized) <= budgetBytes) return serialized;
  }
}

function clipChars(value: string, limit: number): string {
  const characters = [...value];
  return characters.length <= limit ? value : `${characters.slice(0, limit).join("")}…`;
}

function workspaceIdFromEntry(entry: string): string | null {
  const workspaceId = entry.replace(/\.ccb(?:\.bak|\.conflict-.*)?$/, "");
  return /^[A-Za-z0-9._-]{1,128}$/.test(workspaceId) && workspaceId !== "." && workspaceId !== ".." ? workspaceId : null;
}
