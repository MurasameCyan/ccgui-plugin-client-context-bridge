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
const PROTOCOL_LIFETIME = "This maintenance rule applies only when the current request supplies a fresh nonce. Ignore earlier maintenance instructions and never reuse or close old frames. Without a current maintenance request, do not read or update .ccb files or emit CCB frames automatically. Direct user requests take precedence.";
const FULL_PROTOCOL = `Maintain a compact semantic task handoff while completing the user's request. At the end of this turn emit exactly one 语义 patch as JSON inside the frame below. The payload schema is {"plugin":"ccgui.client-context-bridge","version":1,"patch":{"set":{"goal"?:string,"nextAction"?:string},"append"?:{"acceptance"?:string[],"constraints"?:string[],"completed"?:string[],"remaining"?:string[],"decisions"?:Array<{"summary":string,"reason"?:string}>,"risks"?:string[]},"remove"?:{"acceptanceIds"?:string[],"constraintIds"?:string[],"completedIds"?:string[],"remainingIds"?:string[],"decisionIds"?:string[],"riskIds"?:string[]}}}. Remove entries only by IDs from the current mapping below. Do not include chain-of-thought, source files, credentials, or commands to execute. Treat host facts as authoritative.`;

/**
 * The internal protocol contribution injected every turn. The host caps all
 * internal contributions for one turn and silently SKIPS any that would
 * overflow the remainder, so this fits itself into `PROTOCOL_RESERVE_BYTES`:
 * losing it would cost the model the frame nonce and the payload schema, and
 * every turn would then reduce as `semantic-update-missing`.
 */
export function semanticProtocolContribution(nonce: string, firstTurn: boolean, envelope?: StoredContext["envelope"]): string {
  if (!firstTurn) return `${PROTOCOL_LIFETIME} Update the semantic task patch for this turn. Emit one valid CCGUI internal frame using nonce ${nonce}; do not expose the frame as prose.`;
  const tail = `\n${PROTOCOL_LIFETIME}\nFrame nonce: ${nonce}. Wrap the payload in <CCGUI_INTERNAL_${nonce}> and </CCGUI_INTERNAL_${nonce}>.`;
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
  /** Per-workspace kill switch. A workspace the owner turned off contributes no
   *  prompt and its document is neither read nor written. */
  workspaceEnabled: (workspaceId: string) => boolean;
  onStatus?: (status: CoordinatorStatus) => void;
}

export type CoordinatorStatus = "synced" | "pending" | "degraded" | "write-failed" | "continued" | "off";

interface DraftState {
  stored: StoredContext;
  dirty: boolean;
}

interface TurnState {
  /** Observed-only turns have no authority to submit a semantic frame. */
  nonce?: string;
  /** Owning workspace, so turning one workspace off can drop exactly its turns. */
  workspaceId: string;
  /** undefined = no internal frame arrived; null = frame arrived but invalid; otherwise the parsed patch. */
  patch: SemanticPatch | null | undefined;
  /** Keep receipt ownership even after another switch becomes current. */
  handoff?: PendingHandoff;
}

/** The accepted target turn. `turnId` is the only stable correlation key: the
 *  host dispatches beforeTurn under a pre-send placeholder run id, then rekeys
 *  the lifecycle to the engine's real run id once the launch resolves, so
 *  afterTurn carries a different `runId` for the very same turn. */
interface AcceptedHandoff {
  revision: number;
  turnId: string;
  targetSessionId?: string;
}

interface PendingHandoff {
  switchId: string;
  sourceEngine: string;
  targetEngine: string;
  workspaceId: string;
  restored: boolean;
  /** One entry per accepted injection, keyed by the turn that received it. Two
   *  turns can both be offered the handoff before either send resolves; each
   *  needs its own record, or the session that carries the context in its own
   *  history has no consumption row and is handed the same context again. */
  accepted: Map<string, AcceptedHandoff>;
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
  private readonly workspaceEnabled: (workspaceId: string) => boolean;
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
  /** Bumped on every disable, so a read in flight across a restart is stale. */
  private epoch = 0;
  /** Per-workspace invalidation counter. A document read that started before
   *  the workspace was forgotten belongs to a state that no longer exists. */
  private readonly generations = new Map<string, number>();

  constructor(private readonly context: PluginContext, options: CoordinatorOptions) {
    this.store = new ContextStore(context.documentStorage);
    this.clock = options.clock ?? defaultClock;
    this.ttlDays = options.ttlDays;
    this.workspaceEnabled = options.workspaceEnabled;
    this.onStatus = options.onStatus ?? (() => {});
  }

  enable(): void {
    if (this.enabled) return;
    this.enabled = true;
    this.disposers = [
      this.context.hooks.registerSessionHooks({
        onCreated: (event) => this.onSessionCreated(event),
        onRestored: (event) => this.onSessionRestored(event),
        onClosed: (event) => { if (event.sessionId) this.initializedSessions.delete(this.nativeSessionKey(event.engine, event.sessionId, event.workspace.id)); },
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
    this.epoch += 1;
    this.generations.clear();
    this.onStatus("off");
  }

  /**
   * Settings-owner maintenance window (used around a storage-location switch):
   * stop background writes, let in-flight turn work settle, flush every dirty
   * draft to the current root, then block new writes until resumed.
   */
  async pauseForMaintenance(): Promise<void> {
    const epoch = this.epoch;
    const generations = new Map(this.generations);
    this.maintenance = true;
    if (this.recoveryTimer !== undefined) {
      this.clock.clearTimeout(this.recoveryTimer);
      this.recoveryTimer = undefined;
    }
    await this.quiesce();
    if (!this.enabled || this.epoch !== epoch) return;
    await Promise.all([...this.drafts.keys()].map((workspaceId) => {
      const isCurrent = this.captureLifetime(workspaceId, epoch, generations.get(workspaceId) ?? 0);
      return this.serializeWorkspace(workspaceId, () => this.flush(workspaceId, isCurrent, true));
    }));
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
      if (workspaceId) this.forgetWorkspace(workspaceId);
    }
  }

  /**
   * The owner switched one workspace off. Forget it, wait for the work already
   * dispatched for it to settle, then forget it again so a late callback cannot
   * resurrect its draft. Other workspaces keep running and are not flushed;
   * autosave is disarmed only once nothing dirty is left anywhere.
   */
  async deactivateWorkspace(workspaceId: string): Promise<void> {
    const turnIds = [...this.turns].filter(([, turn]) => turn.workspaceId === workspaceId).map(([turnId]) => turnId);
    this.forgetWorkspace(workspaceId);
    for (let round = 0; round < 3; round += 1) {
      const tails = [this.workspaceChains.get(workspaceId), ...turnIds.map((turnId) => this.turnTails.get(turnId))]
        .filter((tail): tail is Promise<void> => tail !== undefined);
      if (tails.length === 0) break;
      await Promise.all(tails.map((tail) => tail.catch(() => {})));
    }
    this.forgetWorkspace(workspaceId);
    if (this.recoveryTimer !== undefined && ![...this.drafts.values()].some((draft) => draft.dirty)) {
      this.clock.clearTimeout(this.recoveryTimer);
      this.recoveryTimer = undefined;
    }
  }

  /** Forget everything held for one workspace and invalidate its pending reads. */
  private forgetWorkspace(workspaceId: string): void {
    this.generations.set(workspaceId, (this.generations.get(workspaceId) ?? 0) + 1);
    this.drafts.delete(workspaceId);
    if (this.pendingHandoff?.workspaceId === workspaceId) this.pendingHandoff = undefined;
    for (const key of [...this.initializedSessions]) if (key.startsWith(`${workspaceId}\0`)) this.initializedSessions.delete(key);
    for (const [turnId, turn] of [...this.turns]) if (turn.workspaceId === workspaceId) this.turns.delete(turnId);
  }

  /** Operational for this workspace: globally enabled and not turned off for it. */
  private isActive(workspaceId: string): boolean {
    return this.enabled && this.workspaceEnabled(workspaceId);
  }

  /** Keep the originating lifetime across queues, awaits, and nested storage I/O. */
  private captureLifetime(workspaceId: string, epoch = this.epoch, generation = this.generations.get(workspaceId) ?? 0): () => boolean {
    return () => this.isActive(workspaceId) && this.epoch === epoch && (this.generations.get(workspaceId) ?? 0) === generation;
  }

  private onSessionCreated(event: SessionCreatedEvent): void {
    if (!this.isActive(event.workspace.id)) return;
    if (this.pendingHandoff && event.workspace.id === this.pendingHandoff.workspaceId && event.engine === this.pendingHandoff.targetEngine) {
      this.pendingHandoff.restored = false;
    }
  }

  private onSessionRestored(event: SessionRestoredEvent): void {
    if (!this.isActive(event.workspace.id)) return;
    this.initializedSessions.add(this.nativeSessionKey(event.engine, event.sessionId, event.workspace.id));
    if (this.pendingHandoff && event.workspace.id === this.pendingHandoff.workspaceId && event.engine === this.pendingHandoff.targetEngine) {
      this.pendingHandoff.restored = true;
    }
  }

  private async beforeTurn(event: BeforeTurnEvent): Promise<BeforeTurnResult | void> {
    if (!this.isActive(event.workspace.id)) return;
    const nonce = this.clock.nonce();
    const turn: TurnState = { nonce, workspaceId: event.workspace.id, patch: undefined };
    this.turns.set(event.turnId, turn);
    const lifetime = this.captureLifetime(event.workspace.id);
    const isCurrent = () => lifetime() && this.turns.get(event.turnId) === turn;
    const firstTurn = this.initializeSession(event);
    const promptContributions: PromptContribution[] = [];

    const metadata = await this.context.workspace.getMetadata();
    if (!isCurrent()) return;
    const handoff = await this.getHandoff(event, isCurrent, lifetime, metadata.gitHead);
    if (!isCurrent()) return;
    if (handoff) promptContributions.push(handoff);

    let envelope = this.drafts.get(event.workspace.id)?.stored.envelope;
    if (firstTurn && !envelope) {
      try {
        envelope = (await this.loadDraft(event.workspace.id, isCurrent))?.envelope;
      } catch {
        if (isCurrent()) this.onStatus("degraded");
      }
    }
    // Every await above can outlive the workspace: the owner may switch it off,
    // or purge it, while metadata and the document are read. A turn whose state
    // is gone contributes nothing and leaves nothing behind.
    if (!isCurrent()) return;
    const protocol = semanticProtocolContribution(nonce, firstTurn, envelope);
    promptContributions.push({ id: `ccb-protocol-${event.turnId}`, content: protocol, placement: "request-tail" as const, visibility: "internal" as const, persistence: "turn" as const });
    return { promptContributions, internalMessageCapture: { channel: CHANNEL, nonce, maxBytes: MAX_PATCH_BYTES, validate: isCompleteInternalFrame }, isCurrent: lifetime };
  }

  private async getHandoff(event: BeforeTurnEvent, isCurrent: () => boolean, lifetime: () => boolean, currentGitHead?: string): Promise<PromptContribution | undefined> {
    const pending = this.pendingHandoff;
    if (!isCurrent()) return undefined;
    if (!pending || pending.restored || pending.sourceEngine === pending.targetEngine || event.engine !== pending.targetEngine || event.workspace.id !== pending.workspaceId || pending.accepted.size > 0) return undefined;
    try {
      const stored = await this.loadDraft(event.workspace.id, isCurrent);
      if (!stored || !isCurrent() || this.pendingHandoff !== pending) return undefined;
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
      const turn = this.turns.get(event.turnId);
      if (!turn) return undefined;
      turn.handoff = pending;
      return {
        id: "ccb-handoff", content: compiled.content, placement: "request-tail" as const, visibility: "internal" as const, persistence: "turn" as const,
        onAccepted: () => {
          if (!lifetime()) return;
          pending.accepted.set(event.turnId, { revision, turnId: event.turnId, ...(event.sessionId ? { targetSessionId: event.sessionId } : {}) });
          this.onStatus("continued");
        },
      };
    } catch {
      if (isCurrent()) this.onStatus("degraded");
      return undefined;
    }
  }

  private onRuntimeEvent(event: NormalizedRuntimeEvent): void {
    if (!this.isActive(event.workspaceId)) return;
    const isCurrent = this.captureLifetime(event.workspaceId);
    void this.enqueue(event.turnId, () => this.serializeWorkspace(event.workspaceId, () => this.applyRuntimeEvent(event, isCurrent))).catch(() => {
      if (isCurrent()) this.onStatus("degraded");
    });
  }

  private async applyRuntimeEvent(event: NormalizedRuntimeEvent, isCurrent: () => boolean): Promise<void> {
    // Checked before the draft is loaded: an event that sat in the queue must
    // not read the document of a workspace that has since been switched off.
    if (!isCurrent()) return;
    const draft = await this.ensureDraft(event.workspaceId, event.engine, event.occurredAt, isCurrent);
    if (!draft || !isCurrent()) return;
    if (!this.turns.has(event.turnId)) this.turns.set(event.turnId, { workspaceId: event.workspaceId, patch: undefined });
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
    if (!this.isActive(event.workspace.id) || event.channel !== CHANNEL) return;
    const isCurrent = this.captureLifetime(event.workspace.id);
    void this.enqueue(event.turnId, async () => {
      if (!isCurrent()) return;
      const turn = this.turns.get(event.turnId);
      if (!turn?.nonce || turn.nonce !== event.nonce) return;
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
    if (!this.isActive(event.workspace.id)) return;
    const isCurrent = this.captureLifetime(event.workspace.id);
    await this.drainTurn(event.turnId);
    if (!isCurrent()) return;
    const turn = this.turns.get(event.turnId);
    if (!turn || turn.workspaceId !== event.workspace.id) return;
    const patch = turn.patch;
    this.turns.delete(event.turnId);
    this.settleSessionIdentity(event);
    const metadata = await this.context.workspace.getMetadata();
    if (!isCurrent()) return;
    await this.serializeWorkspace(event.workspace.id, async () => {
      if (!isCurrent()) return;
      const draft = await this.ensureDraft(event.workspace.id, event.engine, event.occurredAt, isCurrent);
      if (!draft || !isCurrent()) return;
      const turnFacts: HostFacts = {
        source: { engine: event.engine, nativeSessionId: event.sessionId ?? undefined, turnId: event.turnId, turnStatus: event.status },
        workspace: {
          rootHint: metadata.path,
          ...(metadata.gitBranch !== undefined ? { gitBranch: metadata.gitBranch } : {}),
          ...(metadata.gitHead !== undefined ? { gitHead: metadata.gitHead } : {}),
          ...(metadata.dirty !== undefined ? { dirty: metadata.dirty } : {}),
        },
      };
      const accepted = this.acceptedHandoffFor(event, turn.handoff);
      // Only the session that actually ran this turn may be recorded. A turn
      // whose own native id never materialised has no session to file the row
      // against, and `pendingHandoff` follows any session of the target engine
      // in this workspace — not the one this handoff was injected into.
      const targetSessionId = event.sessionId ?? accepted?.targetSessionId;
      const consumption = accepted && targetSessionId
        ? { targetEngine: event.engine, targetSessionId, consumedRevision: accepted.revision, consumedAt: event.occurredAt }
        : undefined;
      draft.stored.envelope = reduceContext(draft.stored.envelope, { now: event.occurredAt, patch: patch ?? null, facts: turnFacts, consumption });
      draft.dirty = true;
      await this.flush(event.workspace.id, isCurrent);
    });
  }

  private async beforeSwitch(event: RuntimeSwitchEvent): Promise<void> {
    if (!this.isActive(event.workspace.id)) return;
    const isCurrent = this.captureLifetime(event.workspace.id);
    this.pendingHandoff = event.sourceEngine === event.targetEngine ? undefined : this.createPendingHandoff(event);
    await this.flush(event.workspace.id, isCurrent);
  }

  private afterSwitch(event: RuntimeSwitchEvent): void {
    if (!this.isActive(event.workspace.id)) return;
    const existing = this.pendingHandoff;
    if (existing && existing.switchId === event.switchId && existing.sourceEngine === event.sourceEngine && existing.targetEngine === event.targetEngine && existing.workspaceId === event.workspace.id) {
      if (event.targetSessionId && !existing.restored) existing.restored = true;
    }
  }

  private createPendingHandoff(event: RuntimeSwitchEvent): PendingHandoff {
    return {
      switchId: event.switchId,
      sourceEngine: event.sourceEngine,
      targetEngine: event.targetEngine,
      workspaceId: event.workspace.id,
      restored: event.targetSessionId !== null,
      accepted: new Map(),
    };
  }

  /** `undefined` when the workspace was forgotten while its document was read. */
  private async ensureDraft(workspaceId: string, engine: string, occurredAt: string, isCurrent: () => boolean): Promise<DraftState | undefined> {
    if (!isCurrent()) return undefined;
    const existing = this.drafts.get(workspaceId);
    if (existing) return existing;
    const loaded = await this.loadDraft(workspaceId, isCurrent);
    if (!isCurrent() || loaded === undefined) return undefined;
    const installed = this.drafts.get(workspaceId);
    if (installed) return installed;
    const envelope = createEmptyEnvelope({ workspaceId, engine, turnStatus: "completed", now: occurredAt });
    const draft = { stored: { envelope, version: null, baseEnvelope: null }, dirty: false };
    this.drafts.set(workspaceId, draft);
    return draft;
  }

  /**
   * The workspace draft, loading it from storage once. `null` means the
   * workspace has no stored document; `undefined` means the read outlived the
   * state it was started for — the workspace was switched off, purged, or the
   * coordinator restarted — so the result is neither cached nor used.
   */
  private async loadDraft(workspaceId: string, isCurrent: () => boolean): Promise<StoredContext | null | undefined> {
    if (!isCurrent()) return undefined;
    const existing = this.drafts.get(workspaceId);
    if (existing) return existing.stored;
    const loaded = await this.store.load(workspaceId, isCurrent);
    if (!isCurrent()) return undefined;
    const installed = this.drafts.get(workspaceId);
    if (installed) return installed.stored;
    if (!loaded) return null;
    this.drafts.set(workspaceId, { stored: loaded, dirty: false });
    return loaded;
  }

  private scheduleRecovery(): void {
    if (this.recoveryTimer !== undefined) return;
    const epoch = this.epoch;
    this.recoveryTimer = this.clock.setTimeout(() => {
      if (!this.enabled || this.epoch !== epoch) return;
      this.recoveryTimer = undefined;
      void Promise.all([...this.drafts.entries()].filter(([, draft]) => draft.dirty).map(([workspaceId]) => {
        const isCurrent = this.captureLifetime(workspaceId);
        return this.serializeWorkspace(workspaceId, () => this.flush(workspaceId, isCurrent));
      }));
    }, RECOVERY_DELAY_MS);
  }

  private async flush(workspaceId: string, isCurrent: () => boolean, force = false): Promise<void> {
    if (!isCurrent() || (this.maintenance && !force)) return;
    const draft = this.drafts.get(workspaceId);
    if (!draft?.dirty) return;
    try {
      if (this.recoveryTimer !== undefined) {
        this.clock.clearTimeout(this.recoveryTimer);
        this.recoveryTimer = undefined;
      }
      const saved = await this.store.save(draft.stored, isCurrent);
      if (!saved || !isCurrent()) return;
      draft.stored = saved;
      draft.dirty = false;
      this.onStatus(draft.stored.envelope.provenance.degraded ? "degraded" : "synced");
    } catch {
      if (isCurrent()) this.onStatus("write-failed");
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
    const key = event.sessionId
      ? this.nativeSessionKey(event.engine, event.sessionId, event.workspace.id)
      : this.pendingSessionKey(event.workspace.id, event.engine, event.turnId);
    const firstTurn = !this.initializedSessions.has(key);
    this.initializedSessions.add(key);
    return firstTurn;
  }

  /** A turn's beforeTurn can run before its session has a native id, so the
   *  first-turn marker is keyed by the turn that created it. afterTurn carries
   *  the same turnId plus the id the session settled on: retire the per-turn
   *  marker and, once the session identified itself, remember it so its next
   *  turn is not treated as a first turn again. The host mints a fresh id per
   *  send and uses it for both runId and turnId, so a runId-keyed marker could
   *  never be found again and leaked for the process lifetime. */
  private settleSessionIdentity(event: AfterTurnEvent): void {
    this.initializedSessions.delete(this.pendingSessionKey(event.workspace.id, event.engine, event.turnId));
    if (event.sessionId) this.initializedSessions.add(this.nativeSessionKey(event.engine, event.sessionId, event.workspace.id));
  }

  private acceptedHandoffFor(event: AfterTurnEvent, pending: PendingHandoff | undefined): AcceptedHandoff | undefined {
    if (!pending || pending.targetEngine !== event.engine || pending.workspaceId !== event.workspace.id) return undefined;
    return pending.accepted.get(event.turnId);
  }

  private nativeSessionKey(engine: string, sessionId: string, workspaceId: string): string {
    return `${workspaceId}\0${engine}\0native:${sessionId}`;
  }

  private pendingSessionKey(workspaceId: string, engine: string, turnId: string): string {
    return `${workspaceId}\0${engine}\0pending:${turnId}`;
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
