import { ClientContextCoordinator, type CoordinatorStatus } from "./coordinator/coordinator";
import type { Disposer, PluginContext } from "./sdk";
import { createSettingsComponent, createStatusComponent } from "./settings/component";
import { browserDownload, createSettingsModel, type BridgeConfig } from "./settings/model";

const DEFAULT_CONFIG: BridgeConfig = { automationEnabled: false, ttlDays: 7 };
const CONFIG_KEY = "bridgeConfig";
const STATUS_TOPIC = "plugin:ccgui.client-context-bridge:status";

export default function activate(context: PluginContext): Disposer {
  const disposers: Disposer[] = [];
  let config = DEFAULT_CONFIG;
  let status: CoordinatorStatus = "off";
  let disposed = false;
  const coordinator = new ClientContextCoordinator(context, {
    ttlDays: () => config.ttlDays,
    onStatus: (next) => { status = next; context.events.emit(STATUS_TOPIC, next); },
  });
  const saveConfig = async (next: BridgeConfig) => {
    config = next;
    await context.storage.set(CONFIG_KEY, next);
  };
  const setAutomation = (enabled: boolean) => {
    config = { ...config, automationEnabled: enabled };
    if (enabled) coordinator.enable();
    else coordinator.disable();
  };
  const model = createSettingsModel({
    workspace: context.workspace,
    documents: context.documentStorage,
    coordinator: {
      pauseForMaintenance: () => coordinator.pauseForMaintenance(),
      resumeFromMaintenance: () => coordinator.resumeFromMaintenance(),
      purgeDrafts: (entries) => coordinator.purgeDrafts(entries),
    },
    loadConfig: async () => config,
    saveConfig,
    setAutomation,
    download: browserDownload,
  });

  disposers.push(context.i18n.addBundle("zh-CN", "client-context-bridge", {
    title: "跨客户端上下文桥接",
    status: { synced: "已同步", pending: "等待同步", degraded: "已降级", writeFailed: "写入失败", continued: "已从其他客户端接续", off: "已关闭" },
  }));
  disposers.push(context.i18n.addBundle("en-US", "client-context-bridge", {
    title: "Client Context Bridge",
    status: { synced: "Synced", pending: "Pending sync", degraded: "Degraded", writeFailed: "Write failed", continued: "Continued from another client", off: "Off" },
  }));
  disposers.push(context.ui.registerSettingsSection({
    key: "settings",
    label: () => context.host.locale.toLowerCase().startsWith("zh") ? "跨客户端上下文桥接" : "Client Context Bridge",
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

  void context.storage.get<BridgeConfig>(CONFIG_KEY).then(async (stored) => {
    if (disposed) return;
    config = normalizeConfig(stored);
    if (config.automationEnabled) {
      try {
        await context.documentStorage.getLocation();
      } catch {
        status = "degraded";
      }
    }
    if (!disposed && config.automationEnabled) coordinator.enable();
  }).catch(() => { status = "degraded"; });

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
