import { describe, expect, it, vi } from "vitest";
import type { CoordinatorStatus } from "../src/coordinator/coordinator";
import { createEmptyEnvelope } from "../src/protocol/schema";
import type { ReactLike, RegisteredWorkspace } from "../src/sdk";
import { createSettingsComponent } from "../src/settings/component";
import { createSettingsModel, type SettingsDependencies } from "../src/settings/model";

interface Doc { content: string; version: string }

function envelope(workspaceId: string, revision: number, updatedAt: string): string {
  return JSON.stringify({ ...createEmptyEnvelope({ workspaceId, engine: "claude", turnStatus: "completed", now: updatedAt }), revision, updatedAt });
}

interface HarnessOptions {
  automation?: boolean;
  workspaceEnabled?: boolean;
  root?: "data" | "program" | "custom";
  files?: Array<[string, Doc]>;
  workspaces?: RegisteredWorkspace[];
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
  setWorkspaceEnabled(enabled: boolean): void;
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
  let automationEnabled = config.automationEnabled;
  let workspaceEnabled = options.workspaceEnabled;
  const dependencies: SettingsDependencies = {
    workspace: {
      getMetadata: async () => ({ id: "w", path: "C:/repo" }),
      list: async () => options.workspaces ?? [{ id: "w", name: "Current project", path: "C:/repo" }],
    },
    workspaceEnabled: (workspaceId: string) => workspaceId === "w" ? (workspaceEnabled ?? automationEnabled) : automationEnabled,
    documents,
    coordinator: {
      pauseForMaintenance: async () => { log.push("pause"); },
      resumeFromMaintenance: () => { log.push("resume"); },
      purgeDrafts: (entries) => { log.push(`purge:${entries.join(",")}`); purged.push(entries); },
    },
    loadConfig: async () => ({ ...config }),
    saveConfig: vi.fn(async (next: unknown) => { log.push("saveConfig"); Object.assign(config, next as object); }),
    setAutomation: vi.fn((enabled: boolean) => { automationEnabled = enabled; }),
    download: (name, content) => { downloads.push({ name, content }); },
  };
  return {
    dependencies, roots, log, config, removed, purged, downloads,
    failSelect: (kind, error) => { selectFailures.set(kind, error); },
    reportVersion: (path, version) => { versionOverrides.set(path, version); },
    setWorkspaceEnabled: (enabled) => { workspaceEnabled = enabled; },
  };
}

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

describe("settings model", () => {
  it("leaves unspecified workspaces unread when the global default is off", async () => {
    const harness = settingsHarness({ automation: false, root: "program" });
    const model = createSettingsModel(harness.dependencies);
    const snapshot = await model.load();
    expect(snapshot.config.automationEnabled).toBe(false);
    expect(snapshot.location).toBe("program");
    expect(snapshot.actualPath).toBeNull();
    expect(snapshot.currentJson).toBeNull();
    expect(harness.log).toEqual(["getLocation"]);
  });

  it("keeps global settings editable when current workspace metadata is unavailable", async () => {
    const harness = settingsHarness();
    harness.dependencies.workspace.getMetadata = async () => { throw new Error("no active workspace"); };
    const model = createSettingsModel(harness.dependencies);
    await expect(model.load()).resolves.toEqual(expect.objectContaining({
      config: { automationEnabled: false, ttlDays: 7 },
      currentJson: null,
      actualPath: null,
      workspaceError: "Error: no active workspace",
    }));
    await model.setAutomation(true);
    expect((await model.load()).config.automationEnabled).toBe(true);
    expect(harness.log).not.toContain("read:w.ccb");
  });

  it("reads an explicitly enabled workspace while the global default stays off", async () => {
    const content = envelope("w", 2, "2026-09-13T10:00:00.000Z");
    const harness = settingsHarness({ automation: false, workspaceEnabled: true, files: [["w.ccb", { content, version: "4" }]] });
    const snapshot = await createSettingsModel(harness.dependencies).load();
    expect(snapshot.config.automationEnabled).toBe(false);
    expect(snapshot.actualPath).toBe("C:/data/plugin-data/ccb");
    expect(snapshot.currentJson).toBe(content);
  });

  it("reaches document storage only from an explicit view action while off", async () => {
    const harness = settingsHarness({ automation: false, files: [["w.ccb", { content: envelope("w", 2, "2026-09-13T10:00:00.000Z"), version: "4" }]] });
    const model = createSettingsModel(harness.dependencies);
    await model.load();
    expect(harness.log).not.toContain("read:w.ccb");
    await expect(model.viewCurrent()).resolves.toContain('"revision":2');
    expect(harness.log).toContain("read:w.ccb");
  });
  it("lists stored context documents by registered project name without reading their contents", async () => {
    const harness = settingsHarness({
      workspaces: [
        { id: "w", name: "Current project", path: "C:/repo" },
        { id: "other", name: "Other project", path: "C:/other" },
      ],
      files: [
        ["w.ccb", { content: envelope("w", 1, "2026-09-13T10:00:00.000Z"), version: "1" }],
        ["other.ccb.bak", { content: envelope("other", 1, "2026-09-13T09:00:00.000Z"), version: "1" }],
        ["orphan.ccb.conflict-2026-09-13", { content: envelope("orphan", 1, "2026-09-13T08:00:00.000Z"), version: "1" }],
        ["notes.ccb.txt", { content: "keep", version: "1" }],
      ],
    });
    const model = createSettingsModel(harness.dependencies);
    await expect(model.listContexts()).resolves.toEqual([
      { workspaceId: "w", projectName: "Current project" },
      { workspaceId: "other", projectName: "Other project" },
      { workspaceId: "orphan", projectName: "orphan" },
    ]);
    expect(harness.log).toContain("list");
    expect(harness.log.filter((entry) => entry.startsWith("read:"))).toEqual([]);
  });

  it("reads and edits one project's context with its storage version", async () => {
    const original = envelope("w", 2, "2026-09-13T10:00:00.000Z");
    const harness = settingsHarness({
      files: [["w.ccb", { content: original, version: "4" }]],
    });
    const model = createSettingsModel(harness.dependencies);
    await expect(model.readContext("w")).resolves.toEqual({
      workspaceId: "w",
      projectName: "Current project",
      content: original,
      version: "4",
    });
    const edited = envelope("w", 3, "2026-09-13T11:00:00.000Z");
    await model.saveContext("w", edited, "4");
    expect(harness.roots.get("data")!.get("w.ccb")).toEqual({ content: edited, version: "5" });
  });

  it("validates edited JSON and keeps a stale project edit from overwriting newer content", async () => {
    const original = envelope("w", 2, "2026-09-13T10:00:00.000Z");
    const harness = settingsHarness({ files: [["w.ccb", { content: original, version: "4" }]] });
    const model = createSettingsModel(harness.dependencies);
    await expect(model.saveContext("w", "{not json", "4")).rejects.toThrow("not valid JSON");
    await expect(model.saveContext("w", envelope("other", 3, "2026-09-13T11:00:00.000Z"), "4")).rejects.toThrow("workspaceId");
    harness.roots.get("data")!.set("w.ccb", { content: envelope("w", 4, "2026-09-13T12:00:00.000Z"), version: "5" });
    await expect(model.saveContext("w", envelope("w", 3, "2026-09-13T11:00:00.000Z"), "4")).rejects.toThrow("version conflict");
    expect(harness.roots.get("data")!.get("w.ccb")?.version).toBe("5");
  });

  it("deletes only one project's context artifacts", async () => {
    const harness = settingsHarness({
      files: [
        ["w.ccb", { content: envelope("w", 1, "2026-09-13T10:00:00.000Z"), version: "1" }],
        ["w.ccb.bak", { content: envelope("w", 1, "2026-09-13T09:00:00.000Z"), version: "2" }],
        ["other.ccb", { content: envelope("other", 1, "2026-09-13T09:00:00.000Z"), version: "3" }],
      ],
    });
    await createSettingsModel(harness.dependencies).clearContext("w");
    expect(harness.removed.map((entry) => entry.path)).toEqual(["w.ccb", "w.ccb.bak"]);
    expect(harness.roots.get("data")!.has("other.ccb")).toBe(true);
  });


  it("reads current JSON before exporting it as a real browser download", async () => {
    const harness = settingsHarness({ automation: true, files: [["w.ccb", { content: envelope("w", 1, "2026-09-13T10:00:00.000Z"), version: "1" }]] });
    await createSettingsModel(harness.dependencies).exportCurrent();
    expect(harness.downloads).toEqual([{ name: "w.ccb", content: expect.stringContaining('"workspaceId":"w"') }]);
  });

  it("keeps opted-out workspaces unread until an explicit view, export or clear", async () => {
    const content = envelope("w", 2, "2026-09-13T10:00:00.000Z");
    const harness = settingsHarness({ automation: true, workspaceEnabled: false, files: [["w.ccb", { content, version: "4" }]] });
    const model = createSettingsModel(harness.dependencies);
    const snapshot = await model.load();
    expect(snapshot.config.automationEnabled).toBe(true);
    expect(snapshot.currentJson).toBeNull();
    expect(snapshot.actualPath).toBeNull();
    expect(harness.log).not.toContain("read:w.ccb");
    await expect(model.viewCurrent()).resolves.toBe(content);
    await model.exportCurrent();
    expect(harness.downloads).toEqual([{ name: "w.ccb", content }]);
    await model.clearCurrent();
    expect(harness.roots.get("data")!.has("w.ccb")).toBe(false);
  });

  it.each(["global", "workspace", "disposal"])("rechecks %s disable after metadata has started", async (scope) => {
    const entered = deferred();
    const release = deferred();
    const harness = settingsHarness({ automation: scope === "global", workspaceEnabled: scope === "global" ? undefined : true });
    harness.dependencies.workspace.getMetadata = async () => {
      entered.resolve();
      await release.promise;
      return { id: "w", path: "C:/repo" };
    };
    const model = createSettingsModel(harness.dependencies);
    const loading = model.load();
    await entered.promise;
    if (scope === "global") await model.setAutomation(false);
    else if (scope === "workspace") harness.setWorkspaceEnabled(false);
    else harness.dependencies.workspaceEnabled = () => false;
    release.resolve();
    const snapshot = await loading;
    expect(snapshot.currentJson).toBeNull();
    expect(snapshot.actualPath).toBeNull();
    expect(harness.log).not.toContain("read:w.ccb");
    expect(snapshot.config.automationEnabled).toBe(false);
  });

  it.each(["global", "workspace", "disposal"])("discards a pending document read after %s disable", async (scope) => {
    const entered = deferred();
    const release = deferred();
    const content = envelope("w", 2, "2026-09-13T10:00:00.000Z");
    const harness = settingsHarness({
      automation: scope === "global",
      workspaceEnabled: scope === "global" ? undefined : true,
      files: [["w.ccb", { content, version: "4" }]],
    });
    const read = harness.dependencies.documents.readText;
    harness.dependencies.documents.readText = async (path) => {
      const current = await read(path);
      entered.resolve();
      await release.promise;
      return current;
    };
    const model = createSettingsModel(harness.dependencies);
    const loading = model.load();
    await entered.promise;
    if (scope === "global") await model.setAutomation(false);
    else if (scope === "workspace") harness.setWorkspaceEnabled(false);
    else harness.dependencies.workspaceEnabled = () => false;
    release.resolve();
    const snapshot = await loading;
    expect(snapshot.currentJson).toBeNull();
    expect(snapshot.actualPath).toBeNull();
    expect(snapshot.config.automationEnabled).toBe(false);
    expect(harness.log.filter((entry) => entry.startsWith("read:"))).toEqual(["read:w.ccb"]);
  });

  it("does not commit a failed enable into later TTL saves or automatic reads", async () => {
    const entered = deferred();
    const release = deferred();
    const harness = settingsHarness();
    const save = harness.dependencies.saveConfig;
    harness.dependencies.saveConfig = async (next) => {
      if (next.automationEnabled) { entered.resolve(); await release.promise; }
      await save(next);
    };
    const model = createSettingsModel(harness.dependencies);
    const enabling = model.setAutomation(true);
    const rejected = expect(enabling).rejects.toThrow("disk full");
    await entered.promise;
    expect((await model.load()).config.automationEnabled).toBe(false);
    expect(harness.log).not.toContain("read:w.ccb");
    release.reject(new Error("disk full"));
    await rejected;
    await model.setTtlDays(30);
    expect(harness.config).toEqual({ automationEnabled: false, ttlDays: 30 });
    expect((await model.load()).config).toEqual(harness.config);
    expect(harness.log).not.toContain("read:w.ccb");
  });

  it("stops reads during a disable write and restores committed state if that write fails", async () => {
    const entered = deferred();
    const release = deferred();
    const harness = settingsHarness({ automation: true });
    harness.dependencies.saveConfig = async () => { entered.resolve(); await release.promise; };
    const model = createSettingsModel(harness.dependencies);
    const disabling = model.setAutomation(false);
    const rejected = expect(disabling).rejects.toThrow("disk full");
    await entered.promise;
    expect((await model.load()).currentJson).toBeNull();
    expect(harness.log).not.toContain("read:w.ccb");
    release.reject(new Error("disk full"));
    await rejected;
    expect((await model.load()).config.automationEnabled).toBe(true);
    expect(harness.log).toContain("read:w.ccb");
    expect(harness.config.automationEnabled).toBe(true);
  });

  it("serializes automation and TTL writes without losing a committed field", async () => {
    const entered = deferred();
    const release = deferred();
    const harness = settingsHarness();
    const save = harness.dependencies.saveConfig;
    harness.dependencies.saveConfig = async (next) => {
      if (!next.automationEnabled) { entered.resolve(); await release.promise; }
      await save(next);
    };
    const model = createSettingsModel(harness.dependencies);
    const ttl = model.setTtlDays(30);
    await entered.promise;
    const enabling = model.setAutomation(true);
    expect(harness.config).toEqual({ automationEnabled: false, ttlDays: 7 });
    release.resolve();
    await Promise.all([ttl, enabling]);
    expect(harness.config).toEqual({ automationEnabled: true, ttlDays: 30 });
    expect((await model.load()).config).toEqual(harness.config);
  });

  it("does not let an older enable completion override a newer disable intent", async () => {
    const enableEntered = deferred();
    const disableEntered = deferred();
    const releaseEnable = deferred();
    const releaseDisable = deferred();
    const harness = settingsHarness();
    const save = harness.dependencies.saveConfig;
    harness.dependencies.saveConfig = async (next) => {
      if (next.automationEnabled) { enableEntered.resolve(); await releaseEnable.promise; }
      else { disableEntered.resolve(); await releaseDisable.promise; }
      await save(next);
    };
    const model = createSettingsModel(harness.dependencies);
    const enabling = model.setAutomation(true);
    await enableEntered.promise;
    const disabling = model.setAutomation(false);
    releaseEnable.resolve();
    await disableEntered.promise;
    await enabling;
    await model.load();
    expect(harness.log).not.toContain("read:w.ccb");
    releaseDisable.resolve();
    await disabling;
    expect(harness.config.automationEnabled).toBe(false);
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

/** Stands in for the activation owner's status holder. */
function fakeStatus(initial: CoordinatorStatus = "off") {
  let current = initial;
  const listeners = new Set<(status: CoordinatorStatus) => void>();
  return {
    source: {
      current: () => current,
      subscribe: (listener: (status: CoordinatorStatus) => void) => {
        listeners.add(listener);
        return () => { listeners.delete(listener); };
      },
    },
    listenerCount: () => listeners.size,
    publish(next: CoordinatorStatus) {
      current = next;
      for (const listener of [...listeners]) listener(next);
    },
  };
}

describe("settings component", () => {
  it("shows active workspace context without checking the global-default switch", async () => {
    type Element = { type: unknown; props: Record<string, unknown> & { children: unknown[] } };
    const findElement = (node: unknown, matches: (element: Element) => boolean): Element | undefined => {
      if (!node || typeof node !== "object" || !("props" in node)) return undefined;
      const element = node as Element;
      if (matches(element)) return element;
      for (const child of element.props.children) {
        const found = findElement(child, matches);
        if (found) return found;
      }
    };
    const content = envelope("w", 2, "2026-09-13T10:00:00.000Z");
    const harness = settingsHarness({ automation: false, workspaceEnabled: true, files: [["w.ccb", { content, version: "4" }]] });
    const fake = fakeReact();
    const current = fake.mount(createSettingsComponent({ react: fake.react, model: createSettingsModel(harness.dependencies), locale: "en-US", status: fakeStatus().source }));
    await vi.waitFor(() => expect(findElement(current(), (element) => element.props.role === "switch")).toBeDefined());
    expect(findElement(current(), (element) => element.props.role === "switch")!.props.checked).toBe(false);
    expect(findElement(current(), (element) => element.type === "output")).toBeUndefined();
    const disclosure = findElement(current(), (element) => element.type === "button" && element.props["aria-expanded"] === false)!;
    (disclosure.props.onClick as () => void)();
    await vi.waitFor(() => expect(findElement(current(), (element) => element.props["data-context-row"] === true)).toBeDefined());
    expect(findElement(current(), (element) => element.type === "pre")!.props.children).toEqual([content]);
  });
});

  it("renders one colored row per stored project with view, edit, and delete actions", async () => {
    type Element = { type: unknown; props: Record<string, unknown> & { children: unknown[] } };
    const findAll = (node: unknown, matches: (element: Element) => boolean, result: Element[] = []): Element[] => {
      if (Array.isArray(node)) {
        for (const child of node) findAll(child, matches, result);
        return result;
      }
      if (!node || typeof node !== "object" || !("props" in node)) return result;
      const element = node as Element;
      if (matches(element)) result.push(element);
      for (const child of element.props.children) findAll(child, matches, result);
      return result;
    };
    const harness = settingsHarness({
      files: [
        ["w.ccb", { content: envelope("w", 1, "2026-09-13T10:00:00.000Z"), version: "1" }],
        ["other.ccb", { content: envelope("other", 1, "2026-09-13T09:00:00.000Z"), version: "2" }],
      ],
      workspaces: [
        { id: "w", name: "Current project", path: "C:/repo" },
        { id: "other", name: "Other project", path: "C:/other" },
      ],
    });
    const fake = fakeReact();
    const current = fake.mount(createSettingsComponent({ react: fake.react, model: createSettingsModel(harness.dependencies), locale: "en-US", status: fakeStatus().source }));
    await vi.waitFor(() => expect(findAll(current(), (element) => element.props.role === "switch")).toHaveLength(1));
    expect(findAll(current(), (element) => element.props["data-context-row"] === true)).toHaveLength(0);
    const disclosure = findAll(current(), (element) => element.type === "button" && element.props["aria-expanded"] === false)[0];
    (disclosure.props.onClick as () => void)();
    await vi.waitFor(() => expect(findAll(current(), (element) => element.props["data-context-row"] === true)).toHaveLength(2));
    const rows = findAll(current(), (element) => element.props["data-context-row"] === true);
    expect(rows.every((row) => String((row.props.style as Record<string, unknown>).borderLeft).includes("solid"))).toBe(true);
    expect(findAll(rows[0], (element) => element.props["data-context-action"] === "view")).toHaveLength(1);
    expect(findAll(rows[0], (element) => element.props["data-context-action"] === "edit")).toHaveLength(1);
    expect(findAll(rows[0], (element) => element.props["data-context-action"] === "delete")).toHaveLength(1);
  });

it("shows the current bridge status and follows later coordinator updates", async () => {
  type Element = { type: unknown; props: Record<string, unknown> & { children: unknown[] } };
  const findElement = (node: unknown, matches: (element: Element) => boolean): Element | undefined => {
    if (Array.isArray(node)) {
      for (const child of node) {
        const found = findElement(child, matches);
        if (found) return found;
      }
      return undefined;
    }
    if (!node || typeof node !== "object" || !("props" in node)) return undefined;
    const element = node as Element;
    if (matches(element)) return element;
    for (const child of element.props.children) {
      const found = findElement(child, matches);
      if (found) return found;
    }
  };
  const chip = (tree: unknown) => findElement(tree, (element) => element.props["data-ccb-status"] !== undefined);
  const harness = settingsHarness({ automation: true, workspaceEnabled: true });
  const status = fakeStatus("pending");
  const fake = fakeReact();
  const current = fake.mount(createSettingsComponent({
    react: fake.react,
    model: createSettingsModel(harness.dependencies),
    locale: "en-US",
    status: status.source,
  }));
  await vi.waitFor(() => expect(chip(current())).toBeDefined());
  expect(chip(current())!.props["data-ccb-status"]).toBe("pending");
  expect(chip(current())!.props.children).toContain("Pending sync");

  status.publish("continued");
  expect(chip(current())!.props["data-ccb-status"]).toBe("continued");
  expect(chip(current())!.props.children).toContain("Continued from another client");

  status.publish("write-failed");
  expect(chip(current())!.props.children).toContain("Write failed");
});


