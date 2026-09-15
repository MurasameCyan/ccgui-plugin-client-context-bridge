import type { Disposer, ReactLike } from "../sdk";
import type { CoordinatorStatus } from "../coordinator/coordinator";
import type { SettingsModel, SettingsSnapshot } from "./model";

const STATUS_LABELS: Record<CoordinatorStatus, { zh: string; en: string }> = {
  synced: { zh: "已同步", en: "Synced" },
  pending: { zh: "等待同步", en: "Pending sync" },
  degraded: { zh: "已降级", en: "Degraded" },
  "write-failed": { zh: "写入失败", en: "Write failed" },
  continued: { zh: "已从其他客户端接续", en: "Continued from another client" },
  off: { zh: "已关闭", en: "Off" },
};

export interface SettingsComponentOptions {
  react: ReactLike;
  model: SettingsModel;
  locale: string;
}

export function createSettingsComponent(options: SettingsComponentOptions) {
  const { react, model } = options;
  const zh = options.locale.toLowerCase().startsWith("zh");
  const text = (chinese: string, english: string) => zh ? chinese : english;
  return function ClientContextBridgeSettings() {
    const [snapshot, setSnapshot] = react.useState<SettingsSnapshot | null>(null);
    const [message, setMessage] = react.useState("");
    const [preview, setPreview] = react.useState<string | null>(null);
    react.useEffect(() => {
      let active = true;
      void model.load().then((value) => { if (active) setSnapshot(value); }).catch((error: unknown) => { if (active) setMessage(String(error)); });
      return () => { active = false; };
    }, []);
    if (!snapshot) return react.createElement("section", { "aria-busy": true }, message || text("正在加载…", "Loading…"));
    const run = (operation: () => Promise<void>) => {
      setPreview(null);
      void operation().then(() => model.load()).then(setSnapshot).catch((error: unknown) => setMessage(String(error)));
    };
    const off = !snapshot.config.automationEnabled;
    return react.createElement("section", { className: "ccb-settings" },
      react.createElement("p", null, text("开启后会加入不可见的任务状态维护指令；不共享完整聊天记录，也不会联网。", "When enabled, invisible task-state instructions are added. Full chat history is not shared and no network is used.")),
      react.createElement("label", null,
        react.createElement("input", {
          type: "checkbox",
          checked: snapshot.config.automationEnabled,
          onChange: (event: { currentTarget: { checked: boolean } }) => run(() => model.setAutomation(event.currentTarget.checked)),
        }),
        text("自动跨客户端接续", "Automatic cross-client continuation"),
      ),
      off ? react.createElement("p", { role: "note" }, text("自动接续已关闭：不会读取或写入 .ccb，查看、导出和清除仍由你手动触发。", "Automatic continuation is off: no .ccb is read or written; view, export and clear stay manual.")) : null,
      react.createElement("label", null, text("存储位置", "Storage location"),
        react.createElement("select", {
          value: snapshot.location,
          onChange: (event: { currentTarget: { value: "data" | "program" | "custom" } }) => run(() => model.setLocation(event.currentTarget.value)),
        },
        react.createElement("option", { value: "data" }, text("CCGUI 数据目录", "CCGUI data directory")),
        react.createElement("option", { value: "program" }, text("程序目录", "Program directory")),
        react.createElement("option", { value: "custom" }, text("自定义目录", "Custom directory"))),
      ),
      react.createElement("p", null, text("切换存储位置会暂停写入，并由宿主原子迁移属于此插件的全部文档。迁移失败会保留原位置与原设置。", "Switching the storage location pauses writes and atomically migrates all documents belonging to this plugin through the host. A failed migration keeps the previous location and settings.")),
      react.createElement("label", null, text("实际路径", "Resolved path"), react.createElement("output", null, snapshot.actualPath ?? text("开启后显示", "Shown when enabled"))),
      react.createElement("label", null, text("上下文有效期", "Context TTL"),
        react.createElement("select", {
          value: snapshot.config.ttlDays === null ? "never" : String(snapshot.config.ttlDays),
          onChange: (event: { currentTarget: { value: string } }) => run(() => model.setTtlDays(event.currentTarget.value === "never" ? null : Number(event.currentTarget.value))),
        },
        react.createElement("option", { value: "1" }, text("1 天", "1 day")),
        react.createElement("option", { value: "7" }, text("7 天", "7 days")),
        react.createElement("option", { value: "30" }, text("30 天", "30 days")),
        react.createElement("option", { value: "never" }, text("永不过期", "No expiration"))),
      ),
      react.createElement("details", null, react.createElement("summary", null, text("查看当前上下文", "View current context")),
        react.createElement("button", { type: "button", onClick: () => { void model.viewCurrent().then(setPreview).catch((error: unknown) => setMessage(String(error))); } }, text("读取", "Load")),
        react.createElement("pre", null, preview ?? snapshot.currentJson ?? text("暂无上下文", "No context"))),
      react.createElement("div", null,
        react.createElement("button", { type: "button", onClick: () => run(() => model.exportCurrent()) }, text("导出 .ccb", "Export .ccb")),
        react.createElement("button", { type: "button", onClick: () => run(() => model.clearCurrent()) }, text("清除当前工作区上下文", "Clear current workspace")),
        react.createElement("button", { type: "button", onClick: () => run(() => model.clearAll()) }, text("清除全部上下文", "Clear all contexts")),
      ),
      message ? react.createElement("p", { role: "status" }, message) : null,
    );
  };
}

export function createStatusComponent(
  react: ReactLike,
  locale: string,
  getStatus: () => CoordinatorStatus,
  subscribe: (listener: (status: CoordinatorStatus) => void) => Disposer,
) {
  const zh = locale.toLowerCase().startsWith("zh");
  return function ClientContextBridgeStatus() {
    const [status, setStatus] = react.useState<CoordinatorStatus>(getStatus);
    react.useEffect(() => subscribe(setStatus), []);
    return react.createElement("span", { title: zh ? "跨客户端上下文桥接" : "Client Context Bridge", "data-status": status }, STATUS_LABELS[status][zh ? "zh" : "en"]);
  };
}
