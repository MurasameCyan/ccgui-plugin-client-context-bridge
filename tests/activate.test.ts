import { describe, expect, it, vi } from "vitest";
import activate from "../src/activate";
import type { PluginContext, ReactLike, TurnHooks } from "../src/sdk";

interface HarnessOptions {
  overrides?: unknown;
  /** Makes every storage write reject, as a full plugin-data disk would. */
  failWrites?: boolean;
  /** Makes the initial read of both persisted keys reject. */
  failReads?: boolean;
  /** Held open to keep the initial read of both persisted keys pending. */
  gate?: Promise<void>;
  readStarted?(key: string): void;
  beforeWrite?(key: string, value: unknown): Promise<void>;
  beforeRead?(path: string): Promise<void>;
}

function activationHarness(initialAutomation: boolean | null = null, initialLocation: "data" | "program" | "custom" = "data", options: HarnessOptions = {}) {
  const storage = new Map<string, unknown>();
  if (initialAutomation !== null) storage.set("bridgeConfig", { automationEnabled: initialAutomation, location: initialLocation, ttlDays: 7 });
  if (options.overrides !== undefined) storage.set("workspaceOverrides", options.overrides);
  const registered = { settings: 0, status: 0, workspaceMenu: 0, session: 0, turn: 0, runtimeSwitch: 0, i18n: 0 };
  const calls = { selectLocation: 0, getLocation: 0 };
  const documentReads: string[] = [];
  const writes: Array<{ key: string; value: unknown }> = [];
  const renderer = fakeReact();
  let turnHooks: TurnHooks | undefined;
  const emitted: unknown[] = [];
  const disposed: string[] = [];
  let settingsComponent: (() => unknown) | undefined;
  let statusComponent: (() => unknown) | undefined;
  let workspaceMenu: {
    label(context: { workspaceId: string; archived: boolean }): string;
    visible?(context: { workspaceId: string; archived: boolean }): boolean;
    onSelect(context: { workspaceId: string; archived: boolean }): void;
  } | undefined;
  const context = {
    pluginId: "ccgui.client-context-bridge",
    version: "1.0.0",
    react: renderer.react,
    hooks: {
      registerSessionHooks() { registered.session += 1; return () => disposed.push("session"); },
      registerTurnHooks(hooks: TurnHooks) { registered.turn += 1; turnHooks = hooks; return () => disposed.push("turn"); },
      registerRuntimeSwitchHooks() { registered.runtimeSwitch += 1; return () => disposed.push("switch"); },
    },
    workspace: { getMetadata: async () => ({ id: "w", path: "C:/repo" }) },
    documentStorage: {
      getLocation: async () => { calls.getLocation += 1; return { kind: "data" as const, path: "C:/data" }; },
      selectLocation: async (kind: "data" | "program" | "custom") => { calls.selectLocation += 1; return { kind, path: "C:/data" }; },
      readText: async (path: string) => { documentReads.push(path); await options.beforeRead?.(path); return null; },
      writeTextAtomic: async () => ({ version: "1" }),
      remove: async () => {},
      list: async () => [],
    },
    ui: {
      registerSettingsSection(definition: { component: () => unknown }) { registered.settings += 1; settingsComponent = definition.component; return () => disposed.push("settings"); },
      registerStatusBarItem(definition: { component: () => unknown }) { registered.status += 1; statusComponent = definition.component; return () => disposed.push("status"); },
      registerWorkspaceMenuItem(definition: typeof workspaceMenu & object) { registered.workspaceMenu += 1; workspaceMenu = definition; return () => disposed.push("workspace-menu"); },
    },
    i18n: { addBundle() { registered.i18n += 1; return () => disposed.push("i18n"); } },
    storage: {
      get: async <T>(key: string) => {
        options.readStarted?.(key);
        if (options.gate) await options.gate;
        if (options.failReads) throw new Error("plugin storage unavailable");
        return (storage.get(key) as T | undefined) ?? null;
      },
      set: async (key: string, value: unknown) => {
        await options.beforeWrite?.(key, value);
        if (options.failWrites) throw new Error("plugin storage unavailable");
        storage.set(key, value);
        writes.push({ key, value });
      },
      delete: async (key: string) => { storage.delete(key); },
    },
    events: { on: () => () => {}, emit: (_topic: string, data: unknown) => { emitted.push(data); } },
    host: { appVersion: "1.0.0", sdkVersion: "0.4.2", locale: "en-US", isWeb: false },
  } as unknown as PluginContext;
  const cleanup = activate(context);
  return {
    storage, registered, disposed, settingsComponent, statusComponent, cleanup, calls, emitted, documentReads, writes,
    menu: () => workspaceMenu!,
    mountSettings: () => renderer.mount(settingsComponent!),
    beforeTurn: (workspaceId: string, turnId = "turn") => turnHooks?.beforeTurn?.({
      workspace: { id: workspaceId, path: "C:/repo" }, runId: "run", turnId, engine: "claude",
      sessionId: null, occurredAt: "2026-09-17T10:00:00.000Z",
    }),
  };
}

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function fakeReact() {
  const states = new Map<number, unknown>();
  const effects = new Set<number>();
  let cursor = 0;
  let render: (() => void) | undefined;
  const react = {
    createElement: (type: unknown, props: Record<string, unknown> | null, ...children: unknown[]) => ({ type, props: { ...(props ?? {}), children } }),
    Fragment: Symbol("Fragment"),
    useEffect: (effect: () => void | (() => void), _dependencies: readonly unknown[]) => {
      const index = cursor++;
      if (effects.has(index)) return;
      effects.add(index);
      effect();
    },
    useState: (initial: unknown) => {
      const index = cursor++;
      if (!states.has(index)) states.set(index, typeof initial === "function" ? (initial as () => unknown)() : initial);
      return [states.get(index), (value: unknown) => {
        states.set(index, typeof value === "function" ? (value as (current: unknown) => unknown)(states.get(index)) : value);
        render?.();
      }];
    },
  };
  return {
    react: react as unknown as ReactLike,
    mount: (component: () => unknown) => {
      let latest: unknown;
      render = () => { cursor = 0; latest = component(); };
      render();
      return () => latest;
    },
  };
}

interface SwitchControl {
  checked: boolean;
  onChange(event: { currentTarget: { checked: boolean } }): void;
}

function findSwitch(tree: unknown): SwitchControl | undefined {
  if (!tree || typeof tree !== "object") return undefined;
  if (Array.isArray(tree)) return tree.map(findSwitch).find((value) => value !== undefined);
  const { props } = tree as { props: Record<string, unknown> };
  if (props.role === "switch") return props as unknown as SwitchControl;
  return findSwitch(props.children);
}

describe("plugin activation", () => {
  it("keeps a fresh install and its unspecified workspaces inactive", async () => {
    const harness = activationHarness();
    const current = harness.mountSettings();
    try {
      await vi.waitFor(() => expect(findSwitch(current())?.checked).toBe(false));
      expect(await harness.beforeTurn("w")).toBeUndefined();
      expect(harness.documentReads).toEqual([]);
      expect(harness.writes).toEqual([]);
    } finally {
      harness.cleanup();
    }
  });

  it("revokes active contributions and refuses further work after unloading", async () => {
    const harness = activationHarness(true);
    await vi.waitFor(() => expect(harness.menu().visible?.({ workspaceId: "w", archived: false })).toBe(true));
    const result = await harness.beforeTurn("w");
    expect(result?.promptContributions).toEqual([expect.objectContaining({ visibility: "internal" })]);
    expect(result?.isCurrent?.()).toBe(true);
    harness.cleanup();
    expect(result?.isCurrent?.()).toBe(false);
    harness.documentReads.length = 0;
    expect(await harness.beforeTurn("w", "after-unload")).toBeUndefined();
    expect(harness.documentReads).toEqual([]);
  });

  it("ignores a legacy persisted location without selecting it during activation (P1)", async () => {
    const harness = activationHarness(true, "program");
    await vi.waitFor(() => expect(harness.registered.session).toBe(1));
    expect(harness.calls.selectLocation).toBe(0);
    expect(harness.calls.getLocation).toBe(1);
    expect(harness.storage.get("bridgeConfig")).toEqual({ automationEnabled: true, location: "program", ttlDays: 7 });
  });

  it("performs zero document I/O while automation is off (P1/P2)", async () => {
    const harness = activationHarness(false, "custom");
    await Promise.resolve();
    expect(harness.calls.selectLocation).toBe(0);
    expect(harness.calls.getLocation).toBe(0);
  });

  it("offers a per-workspace switch that persists the choice and reads back on the next launch", async () => {
    const harness = activationHarness(true);
    await vi.waitFor(() => expect(harness.registered.session).toBe(1));
    const menu = harness.menu();
    menu.onSelect({ workspaceId: "w1", archived: false });
    await vi.waitFor(() => expect(harness.storage.get("workspaceOverrides")).toEqual({ w1: false }));
    await harness.beforeTurn("w1");
    expect(harness.documentReads).not.toContain("w1.ccb");
    await harness.beforeTurn("w2");
    expect(harness.documentReads).toContain("w2.ccb");

    const relaunched = activationHarness(true, "data", { overrides: { w1: false } });
    await vi.waitFor(() => expect(relaunched.registered.session).toBe(1));
    await relaunched.beforeTurn("w1");
    expect(relaunched.documentReads).not.toContain("w1.ccb");
    harness.cleanup();
    relaunched.cleanup();
  });

  it("enables only the selected workspace while the global default stays off", async () => {
    const harness = activationHarness(false);
    const target = { workspaceId: "w1", archived: false };
    try {
      await vi.waitFor(() => expect(harness.menu().visible?.(target)).toBe(true));
      const menu = harness.menu();
      menu.label(target);
      menu.onSelect(target);
      await vi.waitFor(() => expect(harness.storage.get("workspaceOverrides")).toEqual({ w1: true }));
      expect((await harness.beforeTurn("w1"))?.promptContributions).toEqual([expect.objectContaining({ visibility: "internal" })]);
      expect(await harness.beforeTurn("w2", "other-workspace")).toBeUndefined();
      expect(harness.documentReads).not.toContain("w2.ccb");
      expect(harness.storage.get("bridgeConfig")).toEqual(expect.objectContaining({ automationEnabled: false }));
      menu.label(target);
      menu.onSelect(target);
      await vi.waitFor(() => expect(harness.storage.get("workspaceOverrides")).toEqual({ w1: false }));
      harness.documentReads.length = 0;
      expect(await harness.beforeTurn("w1", "disabled-workspace")).toBeUndefined();
      expect(harness.documentReads).toEqual([]);
    } finally {
      harness.cleanup();
    }
  });

  it("restores an explicit workspace enable without enabling other workspaces", async () => {
    const harness = activationHarness(false, "data", { overrides: { w: true, excluded: false } });
    try {
      await vi.waitFor(() => expect(harness.menu().visible?.({ workspaceId: "w", archived: false })).toBe(true));
      expect((await harness.beforeTurn("w"))?.promptContributions).toEqual([expect.objectContaining({ visibility: "internal" })]);
      expect(await harness.beforeTurn("excluded", "excluded-turn")).toBeUndefined();
      expect(await harness.beforeTurn("unspecified", "unspecified-turn")).toBeUndefined();
      expect(harness.documentReads).not.toContain("excluded.ccb");
      expect(harness.documentReads).not.toContain("unspecified.ccb");
    } finally {
      harness.cleanup();
    }
  });

  it("changes inherited workspaces without retiring explicitly enabled turns", async () => {
    const harness = activationHarness(true, "data", { overrides: { pinned: true } });
    const current = harness.mountSettings();
    try {
      await vi.waitFor(() => expect(findSwitch(current())?.checked).toBe(true));
      const inherited = await harness.beforeTurn("inherited", "inherited-turn");
      const pinned = await harness.beforeTurn("pinned", "pinned-turn");
      expect(inherited?.isCurrent?.()).toBe(true);
      expect(pinned?.isCurrent?.()).toBe(true);
      findSwitch(current())!.onChange({ currentTarget: { checked: false } });
      await vi.waitFor(() => expect(findSwitch(current())?.checked).toBe(false));
      expect(inherited?.isCurrent?.()).toBe(false);
      expect(pinned?.isCurrent?.()).toBe(true);
      expect(await harness.beforeTurn("inherited", "disabled-turn")).toBeUndefined();
      findSwitch(current())!.onChange({ currentTarget: { checked: true } });
      await vi.waitFor(() => expect(findSwitch(current())?.checked).toBe(true));
      expect(inherited?.isCurrent?.()).toBe(false);
      expect(pinned?.isCurrent?.()).toBe(true);
      expect((await harness.beforeTurn("inherited", "fresh-turn"))?.isCurrent?.()).toBe(true);
    } finally {
      harness.cleanup();
    }
  });

  it("discards inherited reads across a global toggle but retains explicit workspace reads", async () => {
    const inheritedEntered = deferred();
    const pinnedEntered = deferred();
    const release = deferred();
    const harness = activationHarness(true, "data", {
      overrides: { pinned: true },
      beforeRead: async (path) => {
        if (path === "inherited.ccb") { inheritedEntered.resolve(); await release.promise; }
        if (path === "pinned.ccb") { pinnedEntered.resolve(); await release.promise; }
      },
    });
    const current = harness.mountSettings();
    try {
      await vi.waitFor(() => expect(findSwitch(current())?.checked).toBe(true));
      const inherited = harness.beforeTurn("inherited", "inherited-turn");
      const pinned = harness.beforeTurn("pinned", "pinned-turn");
      await Promise.all([inheritedEntered.promise, pinnedEntered.promise]);
      findSwitch(current())!.onChange({ currentTarget: { checked: false } });
      await vi.waitFor(() => expect(findSwitch(current())?.checked).toBe(false));
      findSwitch(current())!.onChange({ currentTarget: { checked: true } });
      await vi.waitFor(() => expect(findSwitch(current())?.checked).toBe(true));
      release.resolve();
      expect(await inherited).toBeUndefined();
      expect((await pinned)?.promptContributions).toEqual([expect.objectContaining({ visibility: "internal" })]);
      expect(harness.documentReads).not.toContain("inherited.ccb.bak");
    } finally {
      release.resolve();
      harness.cleanup();
    }
  });

  it("keeps the workspace choice out of memory when it could not be persisted", async () => {
    const harness = activationHarness(true, "data", { failWrites: true });
    await vi.waitFor(() => expect(harness.registered.session).toBe(1));
    const menu = harness.menu();
    menu.onSelect({ workspaceId: "w1", archived: false });
    await vi.waitFor(() => expect(harness.emitted).toContain("degraded"));
    expect(harness.storage.has("workspaceOverrides")).toBe(false);
    await harness.beforeTurn("w1");
    expect(harness.documentReads).toContain("w1.ccb");
    harness.cleanup();
  });

  it("falls back to following the global switch when persisted overrides are dirty", async () => {
    for (const dirty of [{ w1: "yes" }, null, ["w1"], "off", 7]) {
      const harness = activationHarness(true, "data", { overrides: dirty });
      await vi.waitFor(() => expect(harness.registered.session).toBe(1));
      await harness.beforeTurn("w1");
      expect(harness.documentReads).toContain("w1.ccb");
      harness.cleanup?.();
    }
  });

  it("gates a second workspace immediately while its disable waits behind another write", async () => {
    const entered = deferred();
    const release = deferred();
    const harness = activationHarness(true, "data", {
      beforeWrite: async () => { entered.resolve(); await release.promise; },
    });
    await vi.waitFor(() => expect(harness.registered.session).toBe(1));
    const menu = harness.menu();
    menu.onSelect({ workspaceId: "w1", archived: false });
    await entered.promise;
    menu.onSelect({ workspaceId: "w2", archived: false });
    await harness.beforeTurn("w2");
    expect(harness.documentReads).not.toContain("w2.ccb");
    expect(harness.storage.has("workspaceOverrides")).toBe(false);
    release.resolve();
    await vi.waitFor(() => expect(harness.storage.get("workspaceOverrides")).toEqual({ w1: false, w2: false }));
    await harness.beforeTurn("w1");
    await harness.beforeTurn("w2", "later-turn");
    expect(harness.documentReads).toEqual([]);
    harness.cleanup();
  });

  it("keeps a rendered disable action from enabling after an earlier write completes", async () => {
    const entered = deferred();
    const release = deferred();
    const harness = activationHarness(true, "data", {
      beforeWrite: async () => { entered.resolve(); await release.promise; },
    });
    try {
      await vi.waitFor(() => expect(harness.registered.session).toBe(1));
      const menu = harness.menu();
      const target = { workspaceId: "w", archived: false };
      menu.onSelect(target);
      await entered.promise;
      menu.label(target);
      release.resolve();
      await vi.waitFor(() => expect(harness.storage.get("workspaceOverrides")).toEqual({ w: false }));
      menu.onSelect(target);
      await vi.waitFor(() => expect(harness.writes).toHaveLength(2));
      await harness.beforeTurn("w");
      expect(harness.storage.get("workspaceOverrides")).toEqual({ w: false });
      expect(harness.documentReads).toEqual([]);
    } finally {
      release.resolve();
      harness.cleanup();
    }
  });

  it("exposes no workspace action before both stored settings are known", async () => {
    const configEntered = deferred();
    const overridesEntered = deferred();
    const gate = deferred();
    const harness = activationHarness(true, "data", {
      overrides: { w: false }, gate: gate.promise,
      readStarted: (key) => { (key === "bridgeConfig" ? configEntered : overridesEntered).resolve(); },
    });
    await Promise.all([configEntered.promise, overridesEntered.promise]);
    const menu = harness.menu();
    expect(menu.visible?.({ workspaceId: "w", archived: false })).toBe(false);
    menu.onSelect({ workspaceId: "w", archived: false });
    gate.resolve();
    await vi.waitFor(() => expect(menu.visible?.({ workspaceId: "w", archived: false })).toBe(true));
    expect(harness.storage.get("workspaceOverrides")).toEqual({ w: false });
    await harness.beforeTurn("w");
    expect(harness.documentReads).toEqual([]);
    menu.onSelect({ workspaceId: "w", archived: false });
    await vi.waitFor(() => expect(harness.storage.get("workspaceOverrides")).toEqual({ w: true }));
    harness.cleanup();
  });

  it("stays off and writes nothing when the persisted settings cannot be read", async () => {
    const harness = activationHarness(true, "data", { failReads: true });
    await vi.waitFor(() => expect(harness.emitted).toContain("degraded"));
    harness.menu().onSelect({ workspaceId: "w1", archived: false });
    await Promise.resolve();
    expect(harness.storage.has("workspaceOverrides")).toBe(false);
    expect(harness.registered.session).toBe(0);
    expect(harness.menu().visible?.({ workspaceId: "w1", archived: false })).toBe(false);
  });

  it("does not read an opted-out workspace when the real settings component mounts", async () => {
    const harness = activationHarness(true, "data", { overrides: { w: false } });
    const current = harness.mountSettings();
    await vi.waitFor(() => expect(findSwitch(current())?.checked).toBe(true));
    expect(harness.documentReads).toEqual([]);
    harness.cleanup();
  });

  it("keeps a failed workspace enable inactive and permits a later persisted enable", async () => {
    const entered = deferred();
    const release = deferred();
    let firstWrite = true;
    const harness = activationHarness(false, "data", {
      overrides: { w: false },
      beforeWrite: async () => {
        if (!firstWrite) return;
        firstWrite = false;
        entered.resolve();
        await release.promise;
      },
    });
    await vi.waitFor(() => expect(harness.menu().visible?.({ workspaceId: "w", archived: false })).toBe(true));
    harness.menu().onSelect({ workspaceId: "w", archived: false });
    await entered.promise;
    await harness.beforeTurn("w");
    expect(harness.documentReads).toEqual([]);
    release.reject(new Error("disk full"));
    await vi.waitFor(() => expect(harness.emitted).toContain("degraded"));
    expect(harness.storage.get("workspaceOverrides")).toEqual({ w: false });
    await harness.beforeTurn("w", "after-failure");
    expect(harness.documentReads).toEqual([]);
    harness.menu().onSelect({ workspaceId: "w", archived: false });
    await vi.waitFor(() => expect(harness.storage.get("workspaceOverrides")).toEqual({ w: true }));
    await harness.beforeTurn("w", "after-success");
    expect(harness.documentReads).toContain("w.ccb");
    harness.cleanup();
  });

  it("preserves repeated enable selections rather than toggling when queued writes run", async () => {
    const entered = deferred();
    const release = deferred();
    const harness = activationHarness(true, "data", {
      overrides: { w: false },
      beforeWrite: async () => { entered.resolve(); await release.promise; },
    });
    await vi.waitFor(() => expect(harness.registered.session).toBe(1));
    harness.menu().onSelect({ workspaceId: "w", archived: false });
    await entered.promise;
    harness.menu().onSelect({ workspaceId: "w", archived: false });
    release.resolve();
    await vi.waitFor(() => expect(harness.writes).toHaveLength(2));
    await harness.beforeTurn("w");
    expect(harness.storage.get("workspaceOverrides")).toEqual({ w: true });
    expect(harness.documentReads).toContain("w.ccb");
    harness.cleanup();
  });

  it("preserves a sibling workspace commit when a later queued write fails", async () => {
    const entered = deferred();
    const release = deferred();
    const harness = activationHarness(true, "data", {
      beforeWrite: async (_key, value) => {
        if ((value as Record<string, boolean>).w2 === false) throw new Error("disk full");
        entered.resolve();
        await release.promise;
      },
    });
    await vi.waitFor(() => expect(harness.registered.session).toBe(1));
    harness.menu().onSelect({ workspaceId: "w1", archived: false });
    await entered.promise;
    harness.menu().onSelect({ workspaceId: "w2", archived: false });
    release.resolve();
    await vi.waitFor(() => expect(harness.emitted).toContain("degraded"));
    expect(harness.storage.get("workspaceOverrides")).toEqual({ w1: false });
    await harness.beforeTurn("w1");
    await harness.beforeTurn("w2");
    expect(harness.documentReads).not.toContain("w1.ccb");
    expect(harness.documentReads).toContain("w2.ccb");
    harness.cleanup();
  });

  it("does not reactivate hooks when a settings enable finishes after unload", async () => {
    const entered = deferred();
    const release = deferred();
    const harness = activationHarness(false, "data", {
      beforeWrite: async () => { entered.resolve(); await release.promise; },
    });
    const current = harness.mountSettings();
    await vi.waitFor(() => expect(findSwitch(current())).toBeDefined());
    findSwitch(current())!.onChange({ currentTarget: { checked: true } });
    await entered.promise;
    expect(harness.registered.session).toBe(0);
    harness.cleanup();
    release.resolve();
    await vi.waitFor(() => expect(findSwitch(current())?.checked).toBe(true));
    expect(harness.storage.get("bridgeConfig")).toEqual({ automationEnabled: true, ttlDays: 7 });
    expect(harness.registered.session).toBe(0);
    expect(harness.registered.turn).toBe(0);
    expect(harness.documentReads).toEqual([]);
  });

  it("does not reactivate hooks when a pending disable fails after unload", async () => {
    const entered = deferred();
    const release = deferred();
    const harness = activationHarness(true, "data", {
      beforeWrite: async () => { entered.resolve(); await release.promise; },
    });
    const current = harness.mountSettings();
    await vi.waitFor(() => expect(findSwitch(current())?.checked).toBe(true));
    harness.documentReads.length = 0;
    findSwitch(current())!.onChange({ currentTarget: { checked: false } });
    expect(harness.disposed).toContain("turn");
    await entered.promise;
    harness.cleanup();
    release.reject(new Error("disk full"));
    await vi.waitFor(() => expect(JSON.stringify(current())).toContain("disk full"));
    expect(harness.registered.session).toBe(1);
    expect(harness.registered.turn).toBe(1);
    expect(harness.documentReads).toEqual([]);
    expect(harness.storage.get("bridgeConfig")).toEqual(expect.objectContaining({ automationEnabled: true }));
  });
});
