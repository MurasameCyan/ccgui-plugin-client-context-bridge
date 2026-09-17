import type { Disposer, ReactLike } from "../sdk";
import type { CoordinatorStatus } from "../coordinator/coordinator";
import type { ContextDocumentSummary, SettingsModel, SettingsSnapshot } from "./model";

/** Plugin display name used by status surfaces and metadata. */
export const DISPLAY_NAME = "Client Context Bridge (CCB)";
/** Settings navigation title omits the parenthetical acronym. */
export const SETTINGS_DISPLAY_NAME = "Client Context Bridge";

const STATUS_LABELS: Record<CoordinatorStatus, { zh: string; en: string }> = {
  synced: { zh: "已同步", en: "Synced" },
  pending: { zh: "等待同步", en: "Pending sync" },
  degraded: { zh: "已降级", en: "Degraded" },
  "write-failed": { zh: "写入失败", en: "Write failed" },
  continued: { zh: "已从其他客户端接续", en: "Continued from another client" },
  off: { zh: "已关闭", en: "Off" },
};

/**
 * The host applies no styling to plugin subtrees and this plugin holds no
 * `theme` permission, so layout ships as inline styles bound to the host's
 * own theme variables: light/dark and the type scale follow the app, and
 * nothing depends on a host CSS class surviving its Tailwind build.
 *
 * Geometry mirrors the builtin settings pages (settings-rows.tsx): grouped
 * card at radius 16 on background/secondary with 12px left padding, rows at
 * min-height 52 separated by a 1px separator that stops short of the left
 * edge, label left / control right.
 */
const TEXT_PRIMARY = "var(--color-text-primary, #e5e5e5)";
const TEXT_SECONDARY = "var(--color-text-secondary, #a3a3a3)";
const CARD_BG = "var(--color-background-secondary-default, rgba(255,255,255,0.04))";
const FIELD_BG = "var(--color-background-tertiary-default, rgba(255,255,255,0.08))";
const FIELD_BORDER = "var(--color-border-button-default, rgba(255,255,255,0.12))";
const SEPARATOR = "var(--color-separator-border, rgba(255,255,255,0.08))";
const ERROR_TEXT = "var(--color-text-error-primary, #f87171)";
const ACCENT = "var(--color-accent-500, #3b82f6)";
const ACCENT_STRONG = "var(--color-accent-600, #2563eb)";
const THUMB = "var(--color-control-indicator-background, #fff)";
const THUMB_SUBTLE = "var(--color-control-indicator-background-subtle, #f5f5f5)";
const BODY = "var(--text-body-regular, 0.875rem)";
const BODY_LINE = "var(--text-body-regular--line-height, 1.25rem)";
const BODY_2 = "var(--text-body-2-regular, 0.8125rem)";
const BODY_2_LINE = "var(--text-body-2-regular--line-height, 1.125rem)";

const SECTION: Record<string, unknown> = {
  display: "flex",
  width: "100%",
  minWidth: 0,
  flexDirection: "column",
  gap: "24px",
};
const GROUP: Record<string, unknown> = {
  display: "flex",
  width: "100%",
  flexDirection: "column",
  gap: "8px",
};
const GROUP_LABEL: Record<string, unknown> = {
  margin: 0,
  padding: "0 12px",
  fontSize: BODY_2,
  lineHeight: BODY_2_LINE,
  fontWeight: 500,
  color: TEXT_SECONDARY,
};
const HINT: Record<string, unknown> = {
  margin: 0,
  padding: "0 12px",
  fontSize: BODY_2,
  lineHeight: BODY_2_LINE,
  color: TEXT_SECONDARY,
};
const CARD: Record<string, unknown> = {
  display: "flex",
  width: "100%",
  boxSizing: "border-box",
  minWidth: 0,
  flexDirection: "column",
  paddingLeft: "12px",
  borderRadius: "16px",
  background: CARD_BG,
};
const ROW_LABEL: Record<string, unknown> = {
  fontSize: BODY,
  lineHeight: BODY_LINE,
  color: TEXT_PRIMARY,
};
const ROW_DESCRIPTION: Record<string, unknown> = {
  fontSize: BODY_2,
  lineHeight: BODY_2_LINE,
  color: TEXT_SECONDARY,
};
const CONTROL: Record<string, unknown> = {
  boxSizing: "border-box",
  height: "32px",
  width: "202px",
  minWidth: 0,
  maxWidth: "100%",
  flexShrink: 0,
  padding: "0 8px",
  borderRadius: "10px",
  border: `1px solid ${FIELD_BORDER}`,
  background: FIELD_BG,
  color: TEXT_PRIMARY,
  fontSize: BODY,
  fontFamily: "inherit",
  cursor: "pointer",
};
const BUTTON: Record<string, unknown> = {
  boxSizing: "border-box",
  height: "32px",
  padding: "0 12px",
  borderRadius: "10px",
  border: `1px solid ${FIELD_BORDER}`,
  background: "transparent",
  color: TEXT_PRIMARY,
  fontSize: BODY,
  fontFamily: "inherit",
  cursor: "pointer",
};
const DANGER_BUTTON: Record<string, unknown> = { ...BUTTON, color: ERROR_TEXT };
/**
 * Pill switch, geometry 1:1 with the host's `sm` Switch (switch-sizes.ts):
 * 28×16 track, 12px thumb inset 2px, 12px travel. The native checkbox stays
 * as the accessible control, stretched transparently over the track.
 */
const switchTrack = (on: boolean, focused: boolean): Record<string, unknown> => ({
  position: "relative",
  display: "inline-flex",
  flexShrink: 0,
  boxSizing: "border-box",
  width: "28px",
  height: "16px",
  borderRadius: "9999px",
  background: on
    ? `linear-gradient(to bottom, ${ACCENT}, ${ACCENT_STRONG})`
    : FIELD_BG,
  boxShadow: on
    ? `inset 0 1px 0 0 rgb(255 255 255 / 0.25), inset 0 0 0 0.5px ${ACCENT}`
    : "none",
  outline: focused ? `2px solid var(--color-border-focus-ring, ${ACCENT})` : "none",
  outlineOffset: "3px",
  transition: "background 200ms ease",
});
const switchThumb = (on: boolean): Record<string, unknown> => ({
  position: "absolute",
  left: "2px",
  top: "2px",
  pointerEvents: "none",
  width: "12px",
  height: "12px",
  borderRadius: "9999px",
  background: `linear-gradient(to bottom, ${THUMB}, ${THUMB_SUBTLE})`,
  boxShadow: "0 3px 3px 0 rgb(0 0 0 / 0.03), 0 0.75px 0 0 rgb(0 0 0 / 0.05)",
  transform: on ? "translateX(12px)" : "none",
  transition: "transform 200ms ease",
});
const SWITCH_INPUT: Record<string, unknown> = {
  position: "absolute",
  inset: 0,
  width: "100%",
  height: "100%",
  margin: 0,
  opacity: 0,
  appearance: "none",
  cursor: "pointer",
};
const ACTIONS: Record<string, unknown> = {
  display: "flex",
  flexWrap: "wrap",
  gap: "8px",
  padding: "0 12px",
};
const PREVIEW: Record<string, unknown> = {
  margin: 0,
  maxHeight: "220px",
  overflow: "auto",
  padding: "10px 12px",
  borderRadius: "12px",
  background: FIELD_BG,
  color: TEXT_SECONDARY,
  fontSize: "12px",
  lineHeight: "18px",
  whiteSpace: "pre-wrap",
  wordBreak: "break-word",
};
/** Disclosure row: a button styled as a card row, so the caret state is ours
 *  to render (a flex `<summary>` loses its native marker entirely). */
const DISCLOSURE_ROW: Record<string, unknown> = {
  display: "flex",
  width: "100%",
  minHeight: "52px",
  alignItems: "center",
  gap: "8px",
  margin: 0,
  padding: "10px 10px 10px 0",
  border: "none",
  background: "transparent",
  color: TEXT_PRIMARY,
  font: "inherit",
  fontSize: BODY,
  lineHeight: BODY_LINE,
  textAlign: "left",
  cursor: "pointer",
};
const caret = (open: boolean): Record<string, unknown> => ({
  width: 0,
  height: 0,
  flexShrink: 0,
  borderTop: "4px solid transparent",
  borderBottom: "4px solid transparent",
  borderLeft: `5px solid ${TEXT_SECONDARY}`,
  transform: open ? "rotate(90deg)" : "none",
  transition: "transform 150ms ease",
});
const DISCLOSURE_BODY: Record<string, unknown> = {
  display: "flex",
  flexDirection: "column",
  gap: "8px",
  padding: "0 10px 12px 0",
  borderTop: `1px solid ${SEPARATOR}`,
  paddingTop: "12px",
};
const STATUS_LINE: Record<string, unknown> = {
  margin: 0,
  padding: "0 12px",
  fontSize: BODY_2,
  lineHeight: BODY_2_LINE,
  color: TEXT_PRIMARY,
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

  /** Label block of a row: primary label plus an optional secondary line. */
  const labelBlock = (label: string, description?: string) =>
    react.createElement("span", { style: { display: "flex", minWidth: 0, flex: "1 1 180px", flexDirection: "column" } },
      react.createElement("span", { style: ROW_LABEL }, label),
      description ? react.createElement("span", { style: ROW_DESCRIPTION }, description) : null,
    );

  /**
   * One card row. `interactive` renders a <label> so the whole row activates
   * its control; the last row drops the separator, exactly like the host card.
   */
  const row = (key: string, last: boolean, interactive: boolean, children: unknown[]) =>
    react.createElement(interactive ? "label" : "div", {
      key,
      style: {
        display: "flex",
        boxSizing: "border-box",
        flexWrap: "wrap",
        width: "100%",
        minHeight: "52px",
        alignItems: "center",
        justifyContent: "space-between",
        gap: "16px",
        padding: "10px 10px 10px 0",
        borderBottom: last ? "none" : `1px solid ${SEPARATOR}`,
        cursor: interactive ? "pointer" : "default",
      },
    }, ...children);

  return function ClientContextBridgeSettings() {
    const [snapshot, setSnapshot] = react.useState<SettingsSnapshot | null>(null);
    const [message, setMessage] = react.useState("");
    const [preview, setPreview] = react.useState<string | null>(null);
    const [previewOpen, setPreviewOpen] = react.useState(false);
    const [contexts, setContexts] = react.useState<ContextDocumentSummary[] | null>(null);
    const [switchFocused, setSwitchFocused] = react.useState(false);
    react.useEffect(() => {
      let active = true;
      void model.load().then((value) => { if (active) setSnapshot(value); }).catch((error: unknown) => { if (active) setMessage(String(error)); });
      return () => { active = false; };
    }, []);
    if (!snapshot) {
      return react.createElement("section", { className: "ccb-settings", "aria-busy": true, style: { ...SECTION, ...HINT } },
        message || text("正在加载…", "Loading…"));
    }
    const run = (operation: () => Promise<void>) => {
      setMessage("");
      setPreview(null);
      void operation().then(() => model.load()).then(setSnapshot).catch((error: unknown) => setMessage(String(error)));
    };
    const off = !snapshot.config.automationEnabled;
    const ttl = snapshot.config.ttlDays === null ? "never" : String(snapshot.config.ttlDays);
    const statusMessage = message || snapshot.workspaceError;
    const togglePreview = () => {
      const nextOpen = !previewOpen;
      setPreviewOpen(nextOpen);
      if (!nextOpen) return;
      setContexts(null);
      setMessage("");
      void model.listContexts().then(setContexts).catch((error: unknown) => setMessage(String(error)));
    };

    return react.createElement("section", { className: "ccb-settings", style: SECTION },
      // Group 1 — the global default and workspace overrides.
      react.createElement("div", { style: GROUP },
        react.createElement("div", { style: CARD },
          row("automation", true, true, [
            labelBlock(
              text("全局启用跨客户端上下文桥接", "Enable client context bridge globally"),
              off
                ? text("全局默认关闭，单独启用的项目仍会运行。", "Off by default; individually enabled projects still run.")
                : text("未单独设置的项目自动桥接，单独停用的项目保持关闭。", "Projects without an override bridge automatically; individually disabled projects stay off."),
            ),
            react.createElement("span", { style: switchTrack(!off, switchFocused) },
              react.createElement("span", { "aria-hidden": true, style: switchThumb(!off) }),
              react.createElement("input", {
                type: "checkbox",
                role: "switch",
                "aria-label": text("全局启用跨客户端上下文桥接", "Enable client context bridge globally"),
                style: SWITCH_INPUT,
                checked: snapshot.config.automationEnabled,
                onChange: (event: { currentTarget: { checked: boolean } }) => run(() => model.setAutomation(event.currentTarget.checked)),
                onFocus: (event: { currentTarget: { matches(selector: string): boolean } }) => setSwitchFocused(event.currentTarget.matches(":focus-visible")),
                onBlur: () => setSwitchFocused(false),
              }),
            ),
          ]),
        ),
        react.createElement("p", { style: HINT }, text("开启后会加入不可见的任务状态维护指令；不共享完整聊天记录，也不会联网。", "When enabled, invisible task-state instructions are added. Full chat history is not shared and no network is used.")),
        react.createElement("p", { style: HINT }, text("安装后默认关闭。项目右键菜单可单独开关，项目选择优先于全局设置。", "Initially off. Use a workspace folder's context menu to override the global default for that project.")),
      ),
      // Group 2 — where the context files live and how long they survive.
      react.createElement("div", { style: GROUP },
        react.createElement("p", { style: GROUP_LABEL }, text("上下文存储", "Context storage")),
        react.createElement("div", { style: CARD },
          row("location", false, true, [
            labelBlock(text("存储位置", "Storage location")),
            react.createElement("select", {
              style: CONTROL,
              value: snapshot.location,
              onChange: (event: { currentTarget: { value: "data" | "program" | "custom" } }) => run(() => model.setLocation(event.currentTarget.value)),
            },
            react.createElement("option", { value: "data" }, text("CCGUI 数据目录", "CCGUI data directory")),
            react.createElement("option", { value: "program" }, text("程序目录", "Program directory")),
            react.createElement("option", { value: "custom" }, text("自定义目录", "Custom directory"))),
          ]),
          row("ttl", true, true, [
            labelBlock(text("上下文有效期", "Context TTL")),
            react.createElement("select", {
              style: CONTROL,
              value: ttl,
              onChange: (event: { currentTarget: { value: string } }) => run(() => model.setTtlDays(event.currentTarget.value === "never" ? null : Number(event.currentTarget.value))),
            },
            react.createElement("option", { value: "1" }, text("1 天", "1 day")),
            react.createElement("option", { value: "7" }, text("7 天", "7 days")),
            react.createElement("option", { value: "30" }, text("30 天", "30 days")),
            react.createElement("option", { value: "never" }, text("永不过期", "No expiration"))),
          ]),
        ),
        react.createElement("p", { style: HINT }, text("切换存储位置会暂停写入，并由宿主原子迁移属于此插件的全部文档。迁移失败会保留原位置与原设置。", "Switching the storage location pauses writes and atomically migrates all documents belonging to this plugin through the host. A failed migration keeps the previous location and settings.")),
      ),
      // Group 3 — manual inspection and removal, available while off.
      react.createElement("div", { style: GROUP },
        react.createElement("p", { style: GROUP_LABEL }, text("当前上下文", "Current context")),
        react.createElement("div", { style: CARD },
          react.createElement("button", {
            type: "button",
            style: DISCLOSURE_ROW,
            "aria-expanded": previewOpen,
            "aria-controls": "ccb-current-preview",
            onClick: togglePreview,
          },
            react.createElement("span", { "aria-hidden": true, style: caret(previewOpen) }),
            text("查看当前上下文", "View current context"),
          ),
          previewOpen ? react.createElement("div", {
            id: "ccb-current-preview",
            role: "region",
            "aria-label": text("当前上下文", "Current context"),
            style: DISCLOSURE_BODY,
          },
            react.createElement("div", null,
              react.createElement("button", {
                type: "button",
                style: BUTTON,
                onClick: () => { setMessage(""); void model.viewCurrent().then(setPreview).catch((error: unknown) => setMessage(String(error))); },
              }, text("读取当前工作区", "Load current workspace")),
            ),
            react.createElement("div", null,
              react.createElement("p", { style: ROW_LABEL }, text("已存储项目", "Stored projects")),
              contexts === null
                ? react.createElement("p", { style: HINT, "aria-live": "polite" }, text("正在加载…", "Loading…"))
                : contexts.length === 0
                  ? react.createElement("p", { style: HINT }, text("暂无已存储项目", "No stored projects"))
                  : react.createElement("ul", { "aria-label": text("已存储项目", "Stored projects"), style: { margin: 0, paddingLeft: "20px", color: TEXT_PRIMARY } },
                    ...contexts.map((context) => react.createElement("li", { key: context.workspaceId, style: ROW_LABEL }, context.projectName)),
                  ),
            ),
            react.createElement("pre", { style: PREVIEW }, preview ?? snapshot.currentJson ?? text("暂无上下文", "No context")),
          ) : null,
        ),
        react.createElement("div", { style: ACTIONS },
          react.createElement("button", { type: "button", style: BUTTON, onClick: () => run(() => model.exportCurrent()) }, text("导出 .ccb", "Export .ccb")),
          react.createElement("button", { type: "button", style: BUTTON, onClick: () => run(() => model.clearCurrent()) }, text("清除当前工作区上下文", "Clear current workspace")),
          react.createElement("button", { type: "button", style: DANGER_BUTTON, onClick: () => run(() => model.clearAll()) }, text("清除全部上下文", "Clear all contexts")),
        ),
        statusMessage ? react.createElement("p", { role: "status", style: STATUS_LINE }, statusMessage) : null,
      ),
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
    return react.createElement("span", { title: DISPLAY_NAME, "data-status": status }, STATUS_LABELS[status][zh ? "zh" : "en"]);
  };
}
