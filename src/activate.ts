import { ClientContextCoordinator, type CoordinatorStatus } from "./coordinator/coordinator";
import type { Disposer, PluginContext } from "./sdk";
import { DISPLAY_NAME, createSettingsComponent, createStatusComponent } from "./settings/component";
import { browserDownload, createSettingsModel, type BridgeConfig } from "./settings/model";

const DEFAULT_CONFIG: BridgeConfig = { automationEnabled: false, ttlDays: 7 };
const CONFIG_KEY = "bridgeConfig";
const WORKSPACE_OVERRIDES_KEY = "workspaceOverrides";
const STATUS_TOPIC = "plugin:ccgui.client-context-bridge:status";

export default function activate(context: PluginContext): Disposer {
  const disposers: Disposer[] = [];
  let config = DEFAULT_CONFIG;
  /** Per-workspace opt-out. No entry means the workspace follows the global switch. */
  let overrides: Record<string, boolean> = {};
  const zh = context.host.locale.toLowerCase().startsWith("zh");
  let status: CoordinatorStatus = "off";
  let disposed = false;
  let settingsReady = false;
  let automationEnabled = false;
  const pendingWorkspaceDisables = new Map<string, number>();
  const workspaceEnabled = (workspaceId: string) => !disposed && automationEnabled && overrides[workspaceId] !== false && !pendingWorkspaceDisables.has(workspaceId);
  const coordinator = new ClientContextCoordinator(context, {
    ttlDays: () => config.ttlDays,
    workspaceEnabled,
    onStatus: (next) => { status = next; context.events.emit(STATUS_TOPIC, next); },
  });
  /**
   * Both persisted keys, loaded once. Everything that reads or writes them
   * waits here: a settings render or a menu selection that raced the initial
   * read would otherwise see the defaults and then persist them over a config
   * it never saw. The rejection is kept — callers surface the failure — while a
   * separate observer records the visible status and keeps it handled.
   */
  const ready = Promise.all([context.storage.get<BridgeConfig>(CONFIG_KEY), context.storage.get<unknown>(WORKSPACE_OVERRIDES_KEY)])
    .then(async ([storedConfig, storedOverrides]) => {
      if (disposed) return;
      config = normalizeConfig(storedConfig);
      overrides = normalizeOverrides(storedOverrides);
      if (config.automationEnabled) {
        try {
          await context.documentStorage.getLocation();
        } catch {
          status = "degraded";
        }
        if (disposed) return;
        automationEnabled = true;
        coordinator.enable();
      }
      settingsReady = true;
    });
  ready.catch(() => { if (disposed) return; status = "degraded"; context.events.emit(STATUS_TOPIC, status); });
  const saveConfig = async (next: BridgeConfig) => {
    if (disposed) throw new Error("Plugin has been disposed");
    await context.storage.set(CONFIG_KEY, next);
    if (!disposed) config = next;
  };
  const setAutomation = (enabled: boolean) => {
    if (disposed) return;
    automationEnabled = enabled;
    if (enabled) coordinator.enable();
    else coordinator.disable();
  };
  /** Persist workspace choices serially without making uncommitted enables
   * effective. Disable intent gates immediately, even behind another write. */
  let overrideWrites: Promise<void> = Promise.resolve();
  const setWorkspaceEnabled = (workspaceId: string, enabled: boolean): Promise<void> => {
    if (!settingsReady || disposed) return Promise.resolve();
    if (!enabled) pendingWorkspaceDisables.set(workspaceId, (pendingWorkspaceDisables.get(workspaceId) ?? 0) + 1);
    const deactivated = enabled ? undefined : coordinator.deactivateWorkspace(workspaceId);
    const next = Promise.all([overrideWrites, deactivated]).then(async () => {
      if (disposed) return;
      const nextOverrides = { ...overrides, [workspaceId]: enabled };
      await context.storage.set(WORKSPACE_OVERRIDES_KEY, nextOverrides);
      if (!disposed) overrides = nextOverrides;
    }).catch((error: unknown) => {
      if (!disposed) {
        status = "degraded";
        context.events.emit(STATUS_TOPIC, status);
      }
      throw error;
    }).finally(() => {
      if (!enabled) {
        const remaining = (pendingWorkspaceDisables.get(workspaceId) ?? 1) - 1;
        if (remaining === 0) pendingWorkspaceDisables.delete(workspaceId);
        else pendingWorkspaceDisables.set(workspaceId, remaining);
      }
    });
    overrideWrites = next.catch(() => {});
    return next;
  };
  const model = createSettingsModel({
    workspace: context.workspace,
    workspaceEnabled,
    documents: context.documentStorage,
    coordinator: {
      pauseForMaintenance: () => coordinator.pauseForMaintenance(),
      resumeFromMaintenance: () => coordinator.resumeFromMaintenance(),
      purgeDrafts: (entries) => coordinator.purgeDrafts(entries),
    },
    saveConfig,
    setAutomation,
    // The settings model calls this eagerly at construction and only awaits the
    // result when a section renders, so the rejection is marked observed here
    // while still propagating to whoever does await it.
    loadConfig: () => {
      const loaded = (async () => { await ready; return config; })();
      loaded.catch(() => {});
      return loaded;
    },
    download: browserDownload,
  });

  // The display name is the same in every locale: it is a product name, not
  // a translatable phrase. The host renders the trailing "(CCB)" one step
  // smaller wherever it shows a plugin name.
  disposers.push(context.i18n.addBundle("zh-CN", "client-context-bridge", {
    title: DISPLAY_NAME,
    status: { synced: "已同步", pending: "等待同步", degraded: "已降级", writeFailed: "写入失败", continued: "已从其他客户端接续", off: "已关闭" },
  }));
  disposers.push(context.i18n.addBundle("en-US", "client-context-bridge", {
    title: DISPLAY_NAME,
    status: { synced: "Synced", pending: "Pending sync", degraded: "Degraded", writeFailed: "Write failed", continued: "Continued from another client", off: "Off" },
  }));
  disposers.push(context.ui.registerSettingsSection({
    key: "settings",
    label: () => DISPLAY_NAME,
    component: createSettingsComponent({ react: context.react, model, locale: context.host.locale }),
  }));
  disposers.push(context.ui.registerStatusBarItem({
    key: "status",
    component: createStatusComponent(
      context.react,
      context.host.locale,
      () => status,
      (listener) => context.events.on(STATUS_TOPIC, (data) => listener(data as CoordinatorStatus)),
    ),
    order: 100,
  }));
  let renderedAction: { workspaceId: string; enabled: boolean } | undefined;
  disposers.push(context.ui.registerWorkspaceMenuItem({
    key: "workspace-toggle",
    visible: () => settingsReady && !disposed,
    // The host's context menu is a fixed narrow column and truncates labels,
    // so this stays short: the workspace is already the right-click target,
    // and only the global-off suffix carries extra state.
    label: ({ workspaceId }) => {
      const on = overrides[workspaceId] !== false;
      renderedAction = { workspaceId, enabled: !on };
      const action = zh ? (on ? "停用 CCB" : "启用 CCB") : on ? "Disable CCB" : "Enable CCB";
      // Selecting the entry only records the per-workspace choice. The global
      // switch lives in settings, so say plainly when nothing can run yet.
      return config.automationEnabled ? action : `${action}${zh ? "（全局关闭）" : " (globally off)"}`;
    },
    onSelect: ({ workspaceId }) => {
      // Use the action the user saw, even if an earlier write finished while
      // this menu stayed open. Direct invocations use the current setting.
      const enabled = renderedAction?.workspaceId === workspaceId
        ? renderedAction.enabled
        : overrides[workspaceId] === false;
      renderedAction = undefined;
      void setWorkspaceEnabled(workspaceId, enabled).catch(() => {});
    },
    order: 100,
  }));

  return () => {
    disposed = true;
    coordinator.disable();
    for (const dispose of disposers.splice(0).reverse()) dispose();
  };
}

function normalizeConfig(value: BridgeConfig | null): BridgeConfig {
  if (!value || typeof value !== "object") return DEFAULT_CONFIG;
  const ttlDays = value.ttlDays === null || (Number.isInteger(value.ttlDays) && value.ttlDays >= 1 && value.ttlDays <= 365) ? value.ttlDays : 7;
  return { automationEnabled: value.automationEnabled === true, ttlDays };
}

/** Dirty persisted overrides degrade to "follow the global switch": any entry
 *  that is not a real boolean is dropped rather than coerced. */
function normalizeOverrides(value: unknown): Record<string, boolean> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const normalized: Record<string, boolean> = {};
  for (const [workspaceId, enabled] of Object.entries(value)) {
    if (typeof enabled === "boolean") normalized[workspaceId] = enabled;
  }
  return normalized;
}
