import { describe, expect, it, vi } from "vitest";
import { createEmptyEnvelope } from "../src/protocol/schema";
import type { CoordinatorStatus } from "../src/coordinator/coordinator";
import type { ReactLike } from "../src/sdk";
import { createSettingsComponent, createStatusComponent } from "../src/settings/component";
import { createSettingsModel, type SettingsDependencies } from "../src/settings/model";

interface Doc { content: string; version: string }

function envelope(workspaceId: string, revision: number, updatedAt: string): string {
  return JSON.stringify({ ...createEmptyEnvelope({ workspaceId, engine: "claude", turnStatus: "completed", now: updatedAt }), revision, updatedAt });
}

interface HarnessOptions {
  automation?: boolean;
  root?: "data" | "program" | "custom";
  files?: Array<[string, Doc]>;
}

interface Harness {
  dependencies: SettingsDependencies;
  roots: Map<string, Map<string, Doc>>;
  log: string[];
  config: { automationEnabled: boolean; ttlDays: number | null };
  removed: Array<{ path: string; expected: string | null }>;
  purged: string[][];
  downloads: Array<{ name: string; content: string }>;
  failSelect(kind: string, error: Error): void;
  reportVersion(path: string, version: string): void;
}

function settingsHarness(options: HarnessOptions = {}): Harness {
  const state = { active: options.root ?? "data" };
  const roots = new Map<string, Map<string, Doc>>([
    ["data", new Map<string, Doc>()],
    ["program", new Map<string, Doc>()],
    ["custom", new Map<string, Doc>()],
  ]);
  for (const [path, doc] of options.files ?? []) roots.get(state.active)!.set(path, doc);
  const log: string[] = [];
  const removed: Array<{ path: string; expected: string | null }> = [];
  const purged: string[][] = [];
  const downloads: Array<{ name: string; content: string }> = [];
  const selectFailures = new Map<string, Error>();
  const versionOverrides = new Map<string, string>();
  const activeRoot = () => roots.get(state.active)!;
  const documents = {
    getLocation: async () => { log.push("getLocation"); return { kind: state.active as "data", path: `C:/${state.active}/plugin-data/ccb` }; },
    selectLocation: async (kind: "data" | "program" | "custom") => {
      log.push(`select:${kind}`);
      const failure = selectFailures.get(kind);
      if (failure) throw failure;
      state.active = kind;
      return { kind, path: `C:/${kind}/plugin-data/ccb` };
    },
    readText: async (path: string) => {
      log.push(`read:${path}`);
      const doc = activeRoot().get(path);
      if (!doc) return null;
      const version = versionOverrides.get(path);
      return version === undefined ? { ...doc } : { content: doc.content, version };
    },
    writeTextAtomic: async (path: string, content: string, expectedVersion: string | null) => {
      log.push(`write:${path}`);
      const existing = activeRoot().get(path) ?? null;
      if (expectedVersion !== (existing?.version ?? null)) throw new Error("version conflict");
      const version = String(Number(existing?.version ?? 0) + 1);
      activeRoot().set(path, { content, version });
      return { version };
    },
    remove: async (path: string, expectedVersion?: string | null) => {
      log.push(`remove:${path}`);
      removed.push({ path, expected: expectedVersion ?? null });
      const existing = activeRoot().get(path) ?? null;
      if (!existing) return;
      if ((expectedVersion ?? null) !== existing.version) {
        throw Object.assign(new Error("version conflict"), { name: "DocumentStorageConflictError", code: "DOCUMENT_STORAGE_CONFLICT" });
      }
      activeRoot().delete(path);
    },
    list: async () => { log.push("list"); return [...activeRoot().keys()]; },
  };
  const config = { automationEnabled: options.automation ?? false, ttlDays: 7 };
  const dependencies: SettingsDependencies = {
    workspace: { getMetadata: async () => ({ id: "w", path: "C:/repo" }) },
    documents,
    coordinator: {
      pauseForMaintenance: async () => { log.push("pause"); },
      resumeFromMaintenance: () => { log.push("resume"); },
      purgeDrafts: (entries) => { log.push(`purge:${entries.join(",")}`); purged.push(entries); },
    },
    loadConfig: async () => ({ ...config }),
    saveConfig: vi.fn(async (next: unknown) => { log.push("saveConfig"); Object.assign(config, next as object); }),
    setAutomation: vi.fn((enabled: boolean) => { config.automationEnabled = enabled; }),
    download: (name, content) => { downloads.push({ name, content }); },
  };
  return {
    dependencies, roots, log, config, removed, purged, downloads,
    failSelect: (kind, error) => { selectFailures.set(kind, error); },
    reportVersion: (path, version) => { versionOverrides.set(path, version); },
  };
}

describe("settings model", () => {
  it("saves automation and TTL while the host owns location selection", async () => {
    const harness = settingsHarness();
    const model = createSettingsModel(harness.dependencies);
    await model.setAutomation(true);
    await model.setLocation("custom");
    await model.setTtlDays(null);
    expect(harness.dependencies.setAutomation).toHaveBeenCalledWith(true);
    expect(harness.log).toContain("select:custom");
    expect(await harness.dependencies.documents.getLocation()).toEqual(expect.objectContaining({ kind: "custom" }));
    expect(harness.dependencies.saveConfig).toHaveBeenLastCalledWith({ automationEnabled: true, ttlDays: null });
    expect(harness.dependencies.saveConfig).not.toHaveBeenCalledWith(expect.objectContaining({ location: expect.anything() }));
  });

  it("derives location without reading documents while automation is off", async () => {
    const harness = settingsHarness({ automation: false, root: "program" });
    const model = createSettingsModel(harness.dependencies);
    const snapshot = await model.load();
    expect(snapshot.config.automationEnabled).toBe(false);
    expect(snapshot.location).toBe("program");
    expect(snapshot.actualPath).toBeNull();
    expect(snapshot.currentJson).toBeNull();
    expect(harness.log).toEqual(["getLocation"]);
  });

  it("reaches document storage only from an explicit view action while off", async () => {
    const harness = settingsHarness({ automation: false, files: [["w.ccb", { content: envelope("w", 2, "2026-09-13T10:00:00.000Z"), version: "4" }]] });
    const model = createSettingsModel(harness.dependencies);
    await model.load();
    expect(harness.log).not.toContain("read:w.ccb");
    await expect(model.viewCurrent()).resolves.toContain('"revision":2');
    expect(harness.log).toContain("read:w.ccb");
  });

  it("reads current JSON before exporting it as a real browser download", async () => {
    const harness = settingsHarness({ automation: true, files: [["w.ccb", { content: envelope("w", 1, "2026-09-13T10:00:00.000Z"), version: "1" }]] });
    await createSettingsModel(harness.dependencies).exportCurrent();
    expect(harness.downloads).toEqual([{ name: "w.ccb", content: expect.stringContaining('"workspaceId":"w"') }]);
  });
});

describe("clear operations", () => {
  it("deletes only context artifacts with a version check and purges drafts", async () => {
    const harness = settingsHarness({
      files: [
        ["w.ccb", { content: envelope("w", 1, "2026-09-13T10:00:00.000Z"), version: "3" }],
        ["w.ccb.bak", { content: envelope("w", 1, "2026-09-13T09:00:00.000Z"), version: "2" }],
        ["w.ccb.conflict-2026-09-13T09-30-00-000Z", { content: envelope("w", 1, "2026-09-13T09:30:00.000Z"), version: "2" }],
        ["notes.ccb.txt", { content: "keep", version: "1" }],
        ["unrelated.txt", { content: "keep", version: "1" }],
      ],
    });
    await createSettingsModel(harness.dependencies).clearCurrent();
    expect(harness.removed).toEqual([
      { path: "w.ccb", expected: "3" },
      { path: "w.ccb.bak", expected: "2" },
      { path: "w.ccb.conflict-2026-09-13T09-30-00-000Z", expected: "2" },
    ]);
    expect(harness.purged).toEqual([["w.ccb", "w.ccb.bak", "w.ccb.conflict-2026-09-13T09-30-00-000Z"]]);
    expect(harness.roots.get("data")!.has("notes.ccb.txt")).toBe(true);
    expect(harness.roots.get("data")!.has("unrelated.txt")).toBe(true);
  });

  it("clears every workspace's context artifacts across the root", async () => {
    const harness = settingsHarness({
      files: [
        ["w.ccb", { content: envelope("w", 1, "2026-09-13T10:00:00.000Z"), version: "1" }],
        ["other.ccb", { content: envelope("other", 1, "2026-09-13T10:00:00.000Z"), version: "2" }],
        ["other.ccb.bak", { content: envelope("other", 1, "2026-09-13T09:00:00.000Z"), version: "1" }],
        ["important.md", { content: "keep", version: "1" }],
      ],
    });
    await createSettingsModel(harness.dependencies).clearAll();
    expect(harness.removed.map((entry) => entry.path).sort()).toEqual(["other.ccb", "other.ccb.bak", "w.ccb"]);
    expect(harness.purged.flat().sort()).toEqual(["other.ccb", "other.ccb.bak", "w.ccb"]);
    expect(harness.roots.get("data")!.has("important.md")).toBe(true);
  });

  it("keeps a file whose version no longer matches and does not purge it", async () => {
    const harness = settingsHarness({ files: [["w.ccb", { content: envelope("w", 1, "2026-09-13T10:00:00.000Z"), version: "1" }]] });
    harness.reportVersion("w.ccb", "1");
    harness.roots.get("data")!.set("w.ccb", { content: envelope("w", 2, "2026-09-13T10:05:00.000Z"), version: "2" });
    await createSettingsModel(harness.dependencies).clearCurrent();
    expect(harness.roots.get("data")!.get("w.ccb")?.version).toBe("2");
    expect(harness.purged).toEqual([]);
  });
});

describe("location switching", () => {
  it("delegates one atomic migration to the host without document I/O or config persistence", async () => {
    const harness = settingsHarness({
      automation: true,
      files: [
        ["w.ccb", { content: envelope("w", 4, "2026-09-13T10:00:00.000Z"), version: "7" }],
        ["other.ccb", { content: envelope("other", 2, "2026-09-13T09:00:00.000Z"), version: "3" }],
      ],
    });
    await createSettingsModel(harness.dependencies).setLocation("custom");
    expect(harness.log).toEqual(["getLocation", "pause", "select:custom", "resume"]);
    expect(harness.log.filter((entry) => entry.startsWith("select:"))).toEqual(["select:custom"]);
    expect(harness.log.some((entry) => /^(read|write|remove|list):?/.test(entry))).toBe(false);
    expect(harness.dependencies.saveConfig).not.toHaveBeenCalled();
  });

  it("resumes once and leaves settings unchanged when host selection fails", async () => {
    const harness = settingsHarness({ automation: true });
    harness.failSelect("program", new Error("not writable"));
    await expect(createSettingsModel(harness.dependencies).setLocation("program")).rejects.toThrow("not writable");
    expect(harness.log).toEqual(["getLocation", "pause", "select:program", "resume"]);
    expect(harness.dependencies.saveConfig).not.toHaveBeenCalled();
    expect(await harness.dependencies.documents.getLocation()).toEqual(expect.objectContaining({ kind: "data" }));
  });

  it("uses the same host-only switching path while automation is off", async () => {
    const harness = settingsHarness({ automation: false });
    await createSettingsModel(harness.dependencies).setLocation("custom");
    expect(harness.log).toEqual(["getLocation", "pause", "select:custom", "resume"]);
    expect(harness.dependencies.saveConfig).not.toHaveBeenCalled();
  });

  it("does not enter maintenance when the requested location is already active", async () => {
    const harness = settingsHarness({ root: "custom" });
    await createSettingsModel(harness.dependencies).setLocation("custom");
    expect(harness.log).toEqual(["getLocation"]);
    expect(harness.dependencies.saveConfig).not.toHaveBeenCalled();
  });
});

function fakeReact() {
  const states = new Map<number, unknown>();
  const ranEffects = new Set<number>();
  let cursor = 0;
  let render: (() => void) | undefined;
  const react = {
    createElement: (type: unknown, props: Record<string, unknown> | null, ...children: unknown[]) => ({ type, props: { ...(props ?? {}), children } }),
    Fragment: Symbol("Fragment"),
    useEffect: (effect: () => void | (() => void), _dependencies: readonly unknown[]) => {
      const index = cursor++;
      if (ranEffects.has(index)) return;
      ranEffects.add(index);
      effect();
    },
    useState: (initial: unknown) => {
      const index = cursor++;
      if (!states.has(index)) states.set(index, typeof initial === "function" ? (initial as () => unknown)() : initial);
      const set = (value: unknown) => {
        states.set(index, typeof value === "function" ? (value as (current: unknown) => unknown)(states.get(index)) : value);
        render?.();
      };
      return [states.get(index), set] as const;
    },
  };
  return {
    react: react as unknown as ReactLike,
    mount: (component: () => unknown) => {
      let latest: unknown;
      render = () => { cursor = 0; latest = component(); };
      cursor = 0;
      latest = component();
      return () => latest as { props: Record<string, unknown> };
    },
  };
}

describe("status component", () => {
  it("re-renders with the label of the latest coordinator status", () => {
    const listeners = new Set<(status: CoordinatorStatus) => void>();
    let status: CoordinatorStatus = "off";
    const subscribe = (listener: (status: CoordinatorStatus) => void) => {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    };
    const fake = fakeReact();
    const Component = createStatusComponent(fake.react, "en-US", () => status, subscribe);
    const current = fake.mount(Component);
    expect(current().props["data-status"]).toBe("off");
    expect(current().props.children).toEqual(["Off"]);
    status = "synced";
    for (const listener of [...listeners]) listener(status);
    expect(current().props["data-status"]).toBe("synced");
    expect(current().props.children).toEqual(["Synced"]);
  });
});

describe("settings component", () => {
  it("states that every plugin document is migrated atomically and failures retain prior settings", async () => {
    const render = async (locale: string) => {
      const fake = fakeReact();
      const model = createSettingsModel(settingsHarness({ automation: false }).dependencies);
      const Component = createSettingsComponent({ react: fake.react, model, locale });
      const current = fake.mount(Component);
      for (let round = 0; round < 8; round += 1) await Promise.resolve();
      return JSON.stringify(current());
    };

    const chinese = await render("zh-CN");
    expect(chinese).toContain("原子迁移属于此插件的全部文档");
    expect(chinese).toContain("迁移失败会保留原位置与原设置");
    const english = await render("en-US");
    expect(english).toContain("atomically migrates all documents belonging to this plugin");
    expect(english).toContain("A failed migration keeps the previous location and settings");
  });
});
