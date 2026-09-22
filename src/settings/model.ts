import { parseCcbEnvelope } from "../protocol/schema";
import type { DocumentStorage, DocumentStorageLocationKind, RegisteredWorkspace, WorkspaceMetadata } from "../sdk";

export interface BridgeConfig {
  automationEnabled: boolean;
  ttlDays: number | null;
}

/** Coordinator operations the settings owner may drive during a maintenance window. */
export interface SettingsCoordinator {
  /** Freezes new writes and flushes every dirty draft to the current root. */
  pauseForMaintenance(): Promise<void>;
  resumeFromMaintenance(): void;
  /** Drops the in-memory drafts/handoff belonging to the removed context files. */
  purgeDrafts(entries: string[]): void;
}

export interface SettingsDependencies {
  workspace: { getMetadata(): Promise<WorkspaceMetadata>; list(): Promise<RegisteredWorkspace[]> };
  /** Latest effective workspace state, including overrides, pending disable intent and disposal. */
  workspaceEnabled(workspaceId: string): boolean;
  documents: DocumentStorage;
  coordinator: SettingsCoordinator;
  loadConfig(): Promise<BridgeConfig>;
  saveConfig(config: BridgeConfig): Promise<void>;
  setAutomation(enabled: boolean): void | Promise<void>;
  download(name: string, content: string): void;
}

export interface SettingsSnapshot {
  config: BridgeConfig;
  location: DocumentStorageLocationKind;
  /** Resolved root of the active storage location; null while this workspace is disabled. */
  actualPath: string | null;
  currentJson: string | null;
  /** Workspace preview failure; global controls remain usable. */
  workspaceError?: string;
}

export interface ContextDocumentSummary {
  workspaceId: string;
  projectName: string;
}

export interface ContextDocument {
  workspaceId: string;
  projectName: string;
  content: string;
  /** Version of the primary `.ccb`; null means the primary was absent and a backup was shown. */
  version: string | null;
}

export interface SettingsModel {
  load(): Promise<SettingsSnapshot>;
  /** Explicit read of the current workspace document, allowed while automation is off. */
  viewCurrent(): Promise<string | null>;
  /** Enumerates stored context artifacts without reading their document contents. */
  listContexts(): Promise<ContextDocumentSummary[]>;
  readContext(workspaceId: string): Promise<ContextDocument | null>;
  saveContext(workspaceId: string, content: string, expectedVersion: string | null): Promise<void>;
  clearContext(workspaceId: string): Promise<void>;
  setAutomation(enabled: boolean): Promise<void>;
  setLocation(kind: DocumentStorageLocationKind): Promise<void>;
  setTtlDays(days: number | null): Promise<void>;
  exportCurrent(): Promise<void>;
  clearCurrent(): Promise<void>;
  clearAll(): Promise<void>;
}
/** `<workspace>.ccb`, its single backup, or a conflict artifact — nothing else matches. */
const CONTEXT_ARTIFACT = /^[^/\\]+\.ccb(?:\.bak|\.conflict-[^/\\]+)?$/;

/** Mirrors the host's DocumentStorageConflictError across the bundle boundary (code, not instanceof). */
function isConflict(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "DOCUMENT_STORAGE_CONFLICT";
}

export function createSettingsModel(dependencies: SettingsDependencies): SettingsModel {
  let configPromise = dependencies.loadConfig();
  let configWrites: Promise<void> = Promise.resolve();
  let automationRequest = 0;
  const update = (change: Partial<BridgeConfig>, request?: number, stopped?: void | Promise<void>) => {
    const next = Promise.all([configWrites, stopped]).then(async () => {
      const previous = await configPromise;
      const config = { ...previous, ...change };
      try {
        await dependencies.saveConfig(config);
      } catch (error) {
        if (request === automationRequest) await dependencies.setAutomation(previous.automationEnabled);
        throw error;
      }
      configPromise = Promise.resolve(config);
      if (request === automationRequest) await dependencies.setAutomation(config.automationEnabled);
    });
    configWrites = next.catch(() => {});
    return next;
  };
  const currentWorkspaceId = async () => (await dependencies.workspace.getMetadata()).id;
  const currentPath = async () => `${await currentWorkspaceId()}.ccb`;
  const projectName = async (workspaceId: string) => {
    const registered = await dependencies.workspace.list();
    return registered.find((workspace) => workspace.id === workspaceId)?.name ?? workspaceId;
  };
  const belongsToWorkspace = (entry: string, workspaceId: string) => {
    const path = `${workspaceId}.ccb`;
    return entry === path || entry.startsWith(`${path}.`);
  };
  const validateContext = (workspaceId: string, content: string) => {
    const envelope = parseCcbEnvelope(content);
    if (envelope.workspaceId !== workspaceId) throw new Error("workspaceId does not match the selected project");
  };

  /**
   * Reads each entry's version and removes it with CAS. A conflicting write keeps
   * the newer file in place; any other failure propagates after the survivors are purged.
   */
  const removeContextArtifacts = async (entries: string[]) => {
    if (entries.length === 0) return;
    const removed: string[] = [];
    try {
      for (const entry of entries) {
        const current = await dependencies.documents.readText(entry);
        if (!current) continue;
        try {
          await dependencies.documents.remove(entry, current.version);
          removed.push(entry);
        } catch (error) {
          if (!isConflict(error)) throw error;
        }
      }
    } finally {
      if (removed.length > 0) dependencies.coordinator.purgeDrafts(removed);
    }
  };
  return {
    async load() {
      const [location] = await Promise.all([dependencies.documents.getLocation(), configPromise]);
      let workspace: WorkspaceMetadata;
      try {
        workspace = await dependencies.workspace.getMetadata();
      } catch (error) {
        return { config: await configPromise, location: location.kind, actualPath: null, currentJson: null, workspaceError: String(error) };
      }
      const { id } = workspace;
      let config = await configPromise;
      if (!dependencies.workspaceEnabled(id)) return { config, location: location.kind, actualPath: null, currentJson: null };
      const current = await dependencies.documents.readText(`${id}.ccb`);
      config = await configPromise;
      const enabled = dependencies.workspaceEnabled(id);
      return { config, location: location.kind, actualPath: enabled ? location.path : null, currentJson: enabled ? current?.content ?? null : null };
    },
    async viewCurrent() {
      const current = await dependencies.documents.readText(await currentPath());
      return current?.content ?? null;
    },
    async listContexts() {
      const entries = await dependencies.documents.list();
      const workspaceIds = new Set<string>();
      for (const entry of entries) {
        if (!CONTEXT_ARTIFACT.test(entry)) continue;
        workspaceIds.add(entry.slice(0, entry.lastIndexOf(".ccb")));
      }
      if (workspaceIds.size === 0) return [];
      const registered = new Map((await dependencies.workspace.list()).map((workspace) => [workspace.id, workspace.name]));
      return [...workspaceIds]
        .map((workspaceId) => ({ workspaceId, projectName: registered.get(workspaceId) ?? workspaceId }))
        .sort((left, right) => left.projectName < right.projectName ? -1 : left.projectName > right.projectName ? 1 : left.workspaceId < right.workspaceId ? -1 : left.workspaceId > right.workspaceId ? 1 : 0);
    },
    async readContext(workspaceId) {
      const path = `${workspaceId}.ccb`;
      const current = await dependencies.documents.readText(path);
      if (current) return { workspaceId, projectName: await projectName(workspaceId), content: current.content, version: current.version };
      const backup = await dependencies.documents.readText(`${path}.bak`);
      if (!backup) return null;
      return { workspaceId, projectName: await projectName(workspaceId), content: backup.content, version: null };
    },
    async saveContext(workspaceId, content, expectedVersion) {
      validateContext(workspaceId, content);
      await dependencies.documents.writeTextAtomic(`${workspaceId}.ccb`, content, expectedVersion);
    },
    async clearContext(workspaceId) {
      const entries = (await dependencies.documents.list()).filter((entry) => CONTEXT_ARTIFACT.test(entry) && belongsToWorkspace(entry, workspaceId));
      await removeContextArtifacts(entries);
    },
    async setAutomation(enabled) {
      const request = ++automationRequest;
      // Disable intent takes effect before entering the persistence queue. An
      // older enable may commit meanwhile, but may no longer reactivate hooks.
      const stopped = enabled ? undefined : dependencies.setAutomation(false);
      await update({ automationEnabled: enabled }, request, stopped);
    },
    async setLocation(kind) {
      if ((await dependencies.documents.getLocation()).kind === kind) return;
      await dependencies.coordinator.pauseForMaintenance();
      try {
        await dependencies.documents.selectLocation(kind);
      } finally {
        dependencies.coordinator.resumeFromMaintenance();
      }
    },
    async setTtlDays(days) {
      if (days !== null && (!Number.isInteger(days) || days < 1 || days > 365)) throw new Error("TTL must be 1-365 days or unlimited");
      await update({ ttlDays: days });
    },
    async exportCurrent() {
      const path = await currentPath();
      const current = await dependencies.documents.readText(path);
      if (!current) throw new Error("No context is available for this workspace");
      dependencies.download(path, current.content);
    },
    async clearCurrent() {
      await this.clearContext(await currentWorkspaceId());
    },
    async clearAll() {
      const entries = (await dependencies.documents.list()).filter((entry) => CONTEXT_ARTIFACT.test(entry));
      await removeContextArtifacts(entries);
    },
  };
}

export function browserDownload(name: string, content: string): void {
  const url = URL.createObjectURL(new Blob([content], { type: "application/json;charset=utf-8" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  URL.revokeObjectURL(url);
}
