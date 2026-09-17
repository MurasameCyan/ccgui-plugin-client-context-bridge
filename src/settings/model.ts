import type { DocumentStorage, DocumentStorageLocationKind, WorkspaceMetadata } from "../sdk";

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
  workspace: { getMetadata(): Promise<WorkspaceMetadata> };
  /** Latest effective automation state, including global/workspace disable intent and disposal. */
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
  /** Resolved root of the active storage location; null while automation is off. */
  actualPath: string | null;
  currentJson: string | null;
}

export interface SettingsModel {
  load(): Promise<SettingsSnapshot>;
  /** Explicit read of the current workspace document, allowed while automation is off. */
  viewCurrent(): Promise<string | null>;
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
  const currentPath = async () => `${(await dependencies.workspace.getMetadata()).id}.ccb`;

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
      const [initialConfig, location] = await Promise.all([configPromise, dependencies.documents.getLocation()]);
      if (!initialConfig.automationEnabled) return { config: initialConfig, location: location.kind, actualPath: null, currentJson: null };
      const { id } = await dependencies.workspace.getMetadata();
      let config = await configPromise;
      if (!config.automationEnabled || !dependencies.workspaceEnabled(id)) return { config, location: location.kind, actualPath: null, currentJson: null };
      const current = await dependencies.documents.readText(`${id}.ccb`);
      config = await configPromise;
      const enabled = config.automationEnabled && dependencies.workspaceEnabled(id);
      return { config, location: location.kind, actualPath: enabled ? location.path : null, currentJson: enabled ? current?.content ?? null : null };
    },
    async viewCurrent() {
      const current = await dependencies.documents.readText(await currentPath());
      return current?.content ?? null;
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
      const path = await currentPath();
      const entries = (await dependencies.documents.list()).filter((entry) => CONTEXT_ARTIFACT.test(entry) && (entry === path || entry.startsWith(`${path}.`)));
      await removeContextArtifacts(entries);
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
