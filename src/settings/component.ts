import type { CoordinatorStatus } from "../coordinator/coordinator";
import type { ReactLike } from "../sdk";
import type { ContextDocument, ContextDocumentSummary, SettingsModel, SettingsSnapshot } from "./model";

/** Plugin display name used by status surfaces and metadata. */
export const DISPLAY_NAME = "Client Context Bridge (CCB)";
/** Settings navigation title omits the parenthetical acronym. */
export const SETTINGS_DISPLAY_NAME = "Client Context Bridge";


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
const WARNING_TEXT = "var(--color-text-warning-primary, #fdba74)";
const SUCCESS_TEXT = "var(--color-notification-success-foreground, #a3e635)";
const TEXT_TERTIARY = "var(--color-text-tertiary, #737373)";
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
const SMALL_BUTTON: Record<string, unknown> = { ...BUTTON, height: "28px", padding: "0 9px", fontSize: BODY_2 };
const SMALL_DANGER_BUTTON: Record<string, unknown> = { ...SMALL_BUTTON, color: ERROR_TEXT };
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

/**
 * The six coordinator states from the design's "轻量状态指示", each with the
 * tone it reads as: a write failure is an error, a degraded envelope is a
 * warning, and an accepted handoff is the one state worth accenting.
 */
const STATUS_LABELS: Record<CoordinatorStatus, { zh: string; en: string; color: string }> = {
  synced: { zh: "已同步", en: "Synced", color: SUCCESS_TEXT },
  pending: { zh: "等待同步", en: "Pending sync", color: TEXT_SECONDARY },
  degraded: { zh: "已降级", en: "Degraded", color: WARNING_TEXT },
  "write-failed": { zh: "写入失败", en: "Write failed", color: ERROR_TEXT },
  continued: { zh: "已从其他客户端接续", en: "Continued from another client", color: ACCENT },
  off: { zh: "已关闭", en: "Off", color: TEXT_TERTIARY },
};
const STATUS_CHIP = (color: string): Record<string, unknown> => ({
  display: "inline-flex",
  boxSizing: "border-box",
  height: "24px",
  flexShrink: 0,
  alignItems: "center",
  gap: "6px",
  padding: "0 10px",
  borderRadius: "999px",
  border: `1px solid ${FIELD_BORDER}`,
  background: FIELD_BG,
  color,
  fontSize: BODY_2,
  lineHeight: BODY_2_LINE,
  whiteSpace: "nowrap",
});
const STATUS_DOT = (color: string): Record<string, unknown> => ({
  width: "6px",
  height: "6px",
  borderRadius: "999px",
  background: color,
});

const SELECT_WRAPPER: Record<string, unknown> = {
  position: "relative",
  width: "202px",
  maxWidth: "100%",
  flexShrink: 0,
};
const SELECT_TRIGGER = (open: boolean): Record<string, unknown> => ({
  display: "flex",
  boxSizing: "border-box",
  width: "100%",
  height: "32px",
  alignItems: "center",
  justifyContent: "space-between",
  gap: "6px",
  padding: "0 10px",
  border: `1px solid ${FIELD_BORDER}`,
  borderRadius: "10px",
  background: open ? FIELD_BG : "var(--color-background-primary-default, rgba(255,255,255,0.03))",
  boxShadow: "0 1px 2px rgb(0 0 0 / 0.12)",
  color: TEXT_PRIMARY,
  font: "inherit",
  fontSize: BODY,
  textAlign: "left",
  cursor: "pointer",
  outline: "none",
});
const SELECT_MENU: Record<string, unknown> = {
  position: "absolute",
  zIndex: 20,
  top: "36px",
  right: 0,
  display: "flex",
  width: "266px",
  maxWidth: "calc(100vw - 32px)",
  maxHeight: "240px",
  boxSizing: "border-box",
  flexDirection: "column",
  gap: "4px",
  overflowY: "auto",
  padding: "8px",
  border: `1px solid ${FIELD_BORDER}`,
  borderRadius: "16px",
  background: "var(--color-background-primary-default, #171717)",
  boxShadow: "0 12px 32px rgb(0 0 0 / 0.28)",
};
const SELECT_OPTION = (selected: boolean): Record<string, unknown> => ({
  display: "flex",
  width: "100%",
  boxSizing: "border-box",
  minHeight: "32px",
  alignItems: "center",
  padding: "7px 8px",
  border: "none",
  borderRadius: "10px",
  background: selected ? "var(--color-dropdown-item-hover-background, rgba(255,255,255,0.10))" : "transparent",
  color: TEXT_PRIMARY,
  font: "inherit",
  fontSize: BODY,
  textAlign: "left",
  cursor: "pointer",
});
const SELECT_CARET = (open: boolean): Record<string, unknown> => ({
  width: 0,
  height: 0,
  flexShrink: 0,
  borderTop: "4px solid transparent",
  borderBottom: "4px solid transparent",
  borderLeft: `5px solid ${TEXT_SECONDARY}`,
  transform: open ? "rotate(-90deg)" : "rotate(90deg)",
  transition: "transform 150ms ease",
});

interface SelectChoice { value: string; label: string }

function createCcbSelect(react: ReactLike) {
  return function CcbSelect({ label, value, options, onChange }: {
    label: string;
    value: string;
    options: readonly SelectChoice[];
    onChange: (value: string) => void;
  }) {
    const [open, setOpen] = react.useState(false);
    react.useEffect(() => {
      if (!open || typeof document === "undefined") return;
      const closeOutside = (event: Event) => {
        const target = event.target;
        if (!(target instanceof Element) || !target.closest("[data-ccb-select]")) setOpen(false);
      };
      document.addEventListener("pointerdown", closeOutside);
      return () => document.removeEventListener("pointerdown", closeOutside);
    }, [open]);
    const selected = options.find((option) => option.value === value) ?? options[0];
    const choose = (next: string) => {
      onChange(next);
      setOpen(false);
    };
    return react.createElement("div", { "data-ccb-select": true, style: SELECT_WRAPPER },
      react.createElement("button", {
        type: "button",
        role: "combobox",
        "aria-label": label,
        "aria-expanded": open,
        "aria-haspopup": "listbox",
        style: SELECT_TRIGGER(open),
        onClick: () => setOpen(!open),
        onKeyDown: (event: { key: string; preventDefault: () => void }) => {
          if (event.key === "Escape") setOpen(false);
          if (event.key === "ArrowDown" || event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            setOpen(true);
          }
        },
      },
        react.createElement("span", { style: { minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, selected?.label ?? value),
        react.createElement("span", { "aria-hidden": true, style: SELECT_CARET(open) }),
      ),
      open ? react.createElement("div", { role: "listbox", "aria-label": label, style: SELECT_MENU },
        ...options.map((option) => react.createElement("button", {
          key: option.value,
          type: "button",
          role: "option",
          "aria-selected": option.value === value,
          style: SELECT_OPTION(option.value === value),
          onClick: () => choose(option.value),
        }, option.label)),
      ) : null,
    );
  };
}

const PROJECT_TONES = [
  { line: "#60a5fa", background: "color-mix(in srgb, #2563eb 12%, transparent)" },
  { line: "#a78bfa", background: "color-mix(in srgb, #7c3aed 12%, transparent)" },
  { line: "#34d399", background: "color-mix(in srgb, #059669 12%, transparent)" },
  { line: "#fbbf24", background: "color-mix(in srgb, #d97706 12%, transparent)" },
  { line: "#f472b6", background: "color-mix(in srgb, #db2777 12%, transparent)" },
  { line: "#fb7185", background: "color-mix(in srgb, #e11d48 12%, transparent)" },
] as const;

function projectTone(workspaceId: string) {
  let hash = 0;
  for (const character of workspaceId) hash = (hash * 31 + character.codePointAt(0)!) | 0;
  return PROJECT_TONES[Math.abs(hash) % PROJECT_TONES.length];
}

const CONTEXT_ROW = (workspaceId: string): Record<string, unknown> => {
  const tone = projectTone(workspaceId);
  return {
    display: "flex",
    boxSizing: "border-box",
    width: "100%",
    minWidth: 0,
    alignItems: "center",
    gap: "10px",
    padding: "8px 10px 8px 12px",
    borderLeft: `4px solid ${tone.line}`,
    borderRadius: "10px",
    background: tone.background,
  };
};

const DIALOG_BACKDROP: Record<string, unknown> = {
  position: "fixed",
  zIndex: 50,
  inset: 0,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  padding: "24px",
  background: "rgb(0 0 0 / 0.55)",
};
const DIALOG: Record<string, unknown> = {
  display: "flex",
  width: "min(720px, 100%)",
  maxHeight: "min(760px, 100%)",
  boxSizing: "border-box",
  flexDirection: "column",
  gap: "12px",
  padding: "16px",
  border: `1px solid ${FIELD_BORDER}`,
  borderRadius: "16px",
  background: "var(--color-background-primary-default, #171717)",
  color: TEXT_PRIMARY,
  boxShadow: "0 20px 60px rgb(0 0 0 / 0.35)",
};
const DIALOG_TEXTAREA: Record<string, unknown> = {
  width: "100%",
  minHeight: "360px",
  boxSizing: "border-box",
  resize: "vertical",
  padding: "10px",
  border: `1px solid ${FIELD_BORDER}`,
  borderRadius: "10px",
  background: FIELD_BG,
  color: TEXT_PRIMARY,
  fontFamily: "ui-monospace, SFMono-Regular, Consolas, monospace",
  fontSize: "12px",
  lineHeight: "18px",
};
export interface SettingsComponentOptions {
  react: ReactLike;
  model: SettingsModel;
  locale: string;
  /**
   * Live coordinator status. The owner holds the authoritative value (it is
   * updated outside React, on every flush and handoff), so the section reads
   * it once on mount and then follows the subscription.
   */
  status: {
    current(): CoordinatorStatus;
    subscribe(listener: (status: CoordinatorStatus) => void): () => void;
  };
}

export function createSettingsComponent(options: SettingsComponentOptions) {
  const { react, model } = options;
  const zh = options.locale.toLowerCase().startsWith("zh");
  const text = (chinese: string, english: string) => zh ? chinese : english;
  const Select = createCcbSelect(react);

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
    const [contextDialog, setContextDialog] = react.useState<"view" | "edit" | null>(null);
    const [contextDocument, setContextDocument] = react.useState<ContextDocument | null>(null);
    const [editorValue, setEditorValue] = react.useState("");
    const [contextError, setContextError] = react.useState("");
    const [contextBusy, setContextBusy] = react.useState(false);
    const [deleteTarget, setDeleteTarget] = react.useState<ContextDocumentSummary | null>(null);
    const [switchFocused, setSwitchFocused] = react.useState(false);
    const [status, setStatus] = react.useState<CoordinatorStatus>(() => options.status.current());
    react.useEffect(() => options.status.subscribe(setStatus), []);
    react.useEffect(() => {
      let active = true;
      void model.load().then((value) => { if (active) setSnapshot(value); }).catch((error: unknown) => { if (active) setMessage(String(error)); });
      return () => { active = false; };
    }, []);
    if (!snapshot) {
      return react.createElement("section", { className: "ccb-settings", "aria-busy": true, style: { ...SECTION, ...HINT } },
        message || text("正在加载…", "Loading…"));
    }
    const refreshContexts = () => {
      setContexts(null);
      return model.listContexts().then(setContexts).catch((error: unknown) => {
        setContexts([]);
        setMessage(String(error));
      });
    };
    const reloadSnapshot = () => model.load().then(setSnapshot);
    const run = (operation: () => Promise<void>) => {
      setMessage("");
      setPreview(null);
      void operation().then(reloadSnapshot).then(() => previewOpen ? refreshContexts() : undefined).catch((error: unknown) => setMessage(String(error)));
    };
    const openContext = (mode: "view" | "edit", summary: ContextDocumentSummary) => {
      setContextDialog(mode);
      setContextDocument(null);
      setEditorValue("");
      setContextError("");
      setContextBusy(true);
      void model.readContext(summary.workspaceId).then((document) => {
        if (!document) throw new Error(text("该项目没有可读取的上下文。", "No readable context exists for this project."));
        setContextDocument(document);
        setEditorValue(document.content);
      }).catch((error: unknown) => setContextError(String(error))).finally(() => setContextBusy(false));
    };
    const saveContext = () => {
      if (!contextDocument) return;
      setContextBusy(true);
      setContextError("");
      void model.saveContext(contextDocument.workspaceId, editorValue, contextDocument.version).then(async () => {
        setSnapshot(await model.load());
        if (previewOpen) setContexts(await model.listContexts());
        setContextDialog(null);
      }).catch((error: unknown) => setContextError(String(error))).finally(() => setContextBusy(false));
    };
    const confirmDelete = () => {
      if (!deleteTarget) return;
      setContextBusy(true);
      setContextError("");
      void model.clearContext(deleteTarget.workspaceId).then(async () => {
        setDeleteTarget(null);
        if (previewOpen) setContexts(await model.listContexts());
      }).catch((error: unknown) => setContextError(String(error))).finally(() => setContextBusy(false));
    };
    const off = !snapshot.config.automationEnabled;
    const ttl = snapshot.config.ttlDays === null ? "never" : String(snapshot.config.ttlDays);
    const statusMessage = message || snapshot.workspaceError;
    const togglePreview = () => {
      const nextOpen = !previewOpen;
      setPreviewOpen(nextOpen);
      if (!nextOpen) return;
      setPreview(null);
      setMessage("");
      void refreshContexts();
    };
    return react.createElement("section", { className: "ccb-settings", style: SECTION },
      // Group 1 — the global default and workspace overrides.
      react.createElement("div", { style: GROUP },
        react.createElement("div", { style: CARD },
          row("automation", false, true, [
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
          row("status", true, false, [
            labelBlock(
              text("桥接状态", "Bridge status"),
              text("最近一次上下文同步的结果。", "Result of the most recent context sync."),
            ),
            react.createElement("span", {
              role: "status",
              "aria-live": "polite",
              "data-ccb-status": status,
              style: STATUS_CHIP(STATUS_LABELS[status].color),
            },
              react.createElement("span", { "aria-hidden": true, style: STATUS_DOT(STATUS_LABELS[status].color) }),
              zh ? STATUS_LABELS[status].zh : STATUS_LABELS[status].en,
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
          row("location", false, false, [
            labelBlock(text("存储位置", "Storage location")),
            react.createElement(Select, {
              label: text("存储位置", "Storage location"),
              value: snapshot.location,
              options: [
                { value: "data", label: text("CCGUI 数据目录", "CCGUI data directory") },
                { value: "program", label: text("程序目录", "Program directory") },
                { value: "custom", label: text("自定义目录", "Custom directory") },
              ],
              onChange: (value: string) => run(() => model.setLocation(value as "data" | "program" | "custom")),
            }),
          ]),
          row("ttl", true, false, [
            labelBlock(text("上下文有效期", "Context TTL")),
            react.createElement(Select, {
              label: text("上下文有效期", "Context TTL"),
              value: ttl,
              options: [
                { value: "1", label: text("1 天", "1 day") },
                { value: "7", label: text("7 天", "7 days") },
                { value: "30", label: text("30 天", "30 days") },
                { value: "never", label: text("永不过期", "No expiration") },
              ],
              onChange: (value: string) => run(() => model.setTtlDays(value === "never" ? null : Number(value))),
            }),
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
                  : react.createElement("div", {
                    role: "list",
                    "aria-label": text("已存储项目", "Stored projects"),
                    style: { display: "flex", flexDirection: "column", gap: "6px" },
                  },
                    ...contexts.map((context) => react.createElement("div", {
                      key: context.workspaceId,
                      role: "listitem",
                      "data-context-row": true,
                      style: CONTEXT_ROW(context.workspaceId),
                    },
                      react.createElement("span", { style: { minWidth: 0, flex: "1 1 auto", overflow: "hidden", color: TEXT_PRIMARY, textOverflow: "ellipsis", whiteSpace: "nowrap" }, title: context.projectName }, context.projectName),
                      react.createElement("div", { style: { display: "flex", flexShrink: 0, gap: "6px" } },
                        react.createElement("button", {
                          type: "button",
                          "data-context-action": "view",
                          "aria-label": text(`查看 ${context.projectName}`, `View ${context.projectName}`),
                          style: SMALL_BUTTON,
                          onClick: () => openContext("view", context),
                        }, text("查看", "View")),
                        react.createElement("button", {
                          type: "button",
                          "data-context-action": "edit",
                          "aria-label": text(`编辑 ${context.projectName}`, `Edit ${context.projectName}`),
                          style: SMALL_BUTTON,
                          onClick: () => openContext("edit", context),
                        }, text("编辑", "Edit")),
                        react.createElement("button", {
                          type: "button",
                          "data-context-action": "delete",
                          "aria-label": text(`删除 ${context.projectName}`, `Delete ${context.projectName}`),
                          style: SMALL_DANGER_BUTTON,
                          onClick: () => { setDeleteTarget(context); setContextError(""); },
                        }, text("删除", "Delete")),
                      ),
                    )),
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
      contextDialog ? react.createElement("div", { style: DIALOG_BACKDROP },
        react.createElement("div", {
          role: "dialog",
          "aria-modal": true,
          "aria-label": contextDialog === "edit" ? text("编辑上下文", "Edit context") : text("查看上下文", "View context"),
          style: DIALOG,
        },
          react.createElement("div", { style: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: "12px" } },
            react.createElement("strong", { style: ROW_LABEL }, contextDocument?.projectName ?? text("上下文", "Context")),
            react.createElement("span", { style: ROW_DESCRIPTION }, contextDialog === "edit" ? text("编辑 JSON", "Edit JSON") : text("只读", "Read only")),
          ),
          contextBusy && !contextDocument ? react.createElement("p", { style: HINT, "aria-live": "polite" }, text("正在读取…", "Loading…")) : null,
          contextError ? react.createElement("p", { role: "alert", style: { ...STATUS_LINE, color: ERROR_TEXT } }, contextError) : null,
          contextDocument && contextDialog === "view"
            ? react.createElement("pre", { style: { ...PREVIEW, maxHeight: "520px", minHeight: "240px", overflow: "auto" } }, contextDocument.content)
            : null,
          contextDocument && contextDialog === "edit"
            ? react.createElement("textarea", {
              "aria-label": text("上下文 JSON", "Context JSON"),
              value: editorValue,
              style: DIALOG_TEXTAREA,
              spellCheck: false,
              disabled: contextBusy,
              onChange: (event: { currentTarget: { value: string } }) => setEditorValue(event.currentTarget.value),
            })
            : null,
          react.createElement("div", { style: { ...ACTIONS, padding: 0, justifyContent: "flex-end" } },
            react.createElement("button", { type: "button", style: BUTTON, disabled: contextBusy, onClick: () => { setContextDialog(null); setContextError(""); } }, text("关闭", "Close")),
            contextDialog === "edit" && contextDocument
              ? react.createElement("button", { type: "button", style: BUTTON, disabled: contextBusy, onClick: saveContext }, text("保存", "Save"))
              : null,
          ),
        ),
      ) : null,
      deleteTarget ? react.createElement("div", { style: DIALOG_BACKDROP },
        react.createElement("div", {
          role: "dialog",
          "aria-modal": true,
          "aria-label": text("删除上下文", "Delete context"),
          style: DIALOG,
        },
          react.createElement("strong", { style: ROW_LABEL }, text(`删除「${deleteTarget.projectName}」的上下文？`, `Delete context for “${deleteTarget.projectName}”?`)),
          react.createElement("p", { style: HINT }, text("将删除该项目的主文件、备份和冲突文件，其他项目不受影响。", "This removes the project's primary, backup, and conflict files. Other projects are unchanged.")),
          contextError ? react.createElement("p", { role: "alert", style: { ...STATUS_LINE, color: ERROR_TEXT } }, contextError) : null,
          react.createElement("div", { style: { ...ACTIONS, padding: 0, justifyContent: "flex-end" } },
            react.createElement("button", { type: "button", style: BUTTON, disabled: contextBusy, onClick: () => { setDeleteTarget(null); setContextError(""); } }, text("取消", "Cancel")),
            react.createElement("button", { type: "button", style: DANGER_BUTTON, disabled: contextBusy, onClick: confirmDelete }, text("删除", "Delete")),
          ),
        ),
      ) : null,
    );
  };
}

