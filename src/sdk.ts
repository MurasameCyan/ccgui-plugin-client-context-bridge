/**
 * Minimal local mirror of the host SDK contract used by this standalone
 * plugin. Keep signatures in sync with packages/plugin-sdk/src/context.ts.
 */
export type Disposer = () => void;
export type DocumentStorageLocationKind = "data" | "program" | "custom";

export interface WorkspaceMetadata {
  id: string;
  path: string;
  gitBranch?: string;
  gitHead?: string;
  dirty?: boolean;
}
export interface PromptContribution {
  id: string;
  content: string;
  placement: "system-tail" | "request-tail";
  visibility: "internal";
  persistence: "turn" | "session";
  onAccepted?: () => void;
}
export interface InternalMessageCapture { channel: string; nonce?: string; maxBytes: number; validate?: (payload: unknown) => boolean }
export interface BeforeTurnResult {
  promptContributions?: PromptContribution[];
  internalMessageCapture?: InternalMessageCapture;
}
interface SessionEventBase { engine: string; sessionId: string | null; workspace: WorkspaceMetadata; occurredAt: string }
export interface SessionCreatedEvent extends SessionEventBase {}
export interface SessionRestoredEvent extends SessionEventBase { sessionId: string }
export interface SessionClosedEvent extends SessionEventBase {}
interface TurnEventBase {
  runId: string;
  turnId: string;
  engine: string;
  sessionId: string | null;
  workspace: WorkspaceMetadata;
  occurredAt: string;
}
export interface BeforeTurnEvent extends TurnEventBase {}
export interface AfterTurnEvent extends TurnEventBase { status: "completed" | "cancelled" | "failed"; error?: string }
export interface InternalMessageEvent extends TurnEventBase { channel: string; nonce?: string; payload: unknown }
export interface RuntimeSwitchEvent {
  sourceEngine: string;
  targetEngine: string;
  sourceSessionId: string | null;
  targetSessionId: string | null;
  workspace: WorkspaceMetadata;
  occurredAt: string;
}
interface NormalizedRuntimeEventBase {
  eventId: string;
  runId: string;
  turnId: string;
  engine: string;
  sessionId: string | null;
  workspaceId: string;
  workspacePath: string;
  occurredAt: string;
}
export interface FileChangedEvent extends NormalizedRuntimeEventBase { kind: "file-changed"; path: string; change: "created" | "modified" | "deleted" | "touched" }
export interface CommandStartedEvent extends NormalizedRuntimeEventBase { kind: "command-started"; command: string; cwd: string; startedAt: string }
export interface CommandFinishedEvent extends NormalizedRuntimeEventBase {
  kind: "command-finished";
  command: string;
  cwd: string;
  exitCode: number | null;
  startedAt?: string;
  finishedAt: string;
  status: "completed" | "failed" | "cancelled" | "unknown";
}
export interface ToolFinishedEvent extends NormalizedRuntimeEventBase { kind: "tool-finished"; toolName: string; status: "completed" | "failed" | "cancelled" | "unknown" }
export interface AssistantCompletedEvent extends NormalizedRuntimeEventBase { kind: "assistant-completed" }
export interface TurnCancelledEvent extends NormalizedRuntimeEventBase { kind: "turn-cancelled" }
export interface TurnFailedEvent extends NormalizedRuntimeEventBase { kind: "turn-failed"; error?: string }
export interface RuntimeExitedEvent extends NormalizedRuntimeEventBase { kind: "runtime-exited"; exitCode: number | null }
export type NormalizedRuntimeEvent = FileChangedEvent | CommandStartedEvent | CommandFinishedEvent | ToolFinishedEvent | AssistantCompletedEvent | TurnCancelledEvent | TurnFailedEvent | RuntimeExitedEvent;
export interface SessionHooks {
  onCreated?(event: SessionCreatedEvent): void | Promise<void>;
  onRestored?(event: SessionRestoredEvent): void | Promise<void>;
  onClosed?(event: SessionClosedEvent): void | Promise<void>;
}
export interface TurnHooks {
  beforeTurn?(event: BeforeTurnEvent): BeforeTurnResult | void | Promise<BeforeTurnResult | void>;
  onRuntimeEvent?(event: NormalizedRuntimeEvent): void;
  afterTurn?(event: AfterTurnEvent): void | Promise<void>;
  onInternalMessage?(event: InternalMessageEvent): void | Promise<void>;
}
export interface RuntimeSwitchHooks {
  beforeSwitch?(event: RuntimeSwitchEvent): void | Promise<void>;
  afterSwitch?(event: RuntimeSwitchEvent): void | Promise<void>;
}
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

export interface ReactLike {
  createElement(type: unknown, props?: Record<string, unknown> | null, ...children: unknown[]): unknown;
  Fragment: unknown;
  useEffect(effect: () => void | (() => void), dependencies: readonly unknown[]): void;
  useState<T>(initial: T | (() => T)): [T, (value: T | ((current: T) => T)) => void];
}
export type ComponentLike<P = Record<string, never>> = (props: P) => unknown;

export interface PluginContext {
  pluginId: string;
  version: string;
  react: ReactLike;
  hooks: {
    registerSessionHooks(hooks: SessionHooks): Disposer;
    registerTurnHooks(hooks: TurnHooks): Disposer;
    registerRuntimeSwitchHooks(hooks: RuntimeSwitchHooks): Disposer;
  };
  workspace: { getMetadata(): Promise<WorkspaceMetadata> };
  documentStorage: DocumentStorage;
  ui: {
    registerSettingsSection(definition: { key?: string; label: () => string; icon?: ComponentLike<{ className?: string }>; component: ComponentLike }): Disposer;
    registerStatusBarItem(definition: { key?: string; component: ComponentLike; order?: number }): Disposer;
  };
  i18n: { addBundle(lang: string, namespace: string, resources: Record<string, unknown>): Disposer };
  storage: {
    get<T>(key: string): Promise<T | null>;
    set(key: string, value: unknown): Promise<void>;
    delete(key: string): Promise<void>;
  };
  events: { on(topic: string, callback: (data: unknown) => void): Disposer; emit(topic: string, data: unknown): void };
  host: { appVersion: string; sdkVersion: string; locale: string; isWeb: boolean };
}
