import { describe, expect, it, vi } from "vitest";
import activate from "../src/activate";
import type { PluginContext } from "../src/sdk";

function activationHarness(initialAutomation = false, initialLocation: "data" | "program" | "custom" = "data") {
  const storage = new Map<string, unknown>([["bridgeConfig", { automationEnabled: initialAutomation, location: initialLocation, ttlDays: 7 }]]);
  const registered = { settings: 0, status: 0, session: 0, turn: 0, runtimeSwitch: 0, i18n: 0 };
  const calls = { selectLocation: 0, getLocation: 0 };
  const disposed: string[] = [];
  let settingsComponent: (() => unknown) | undefined;
  let statusComponent: (() => unknown) | undefined;
  const context = {
    pluginId: "ccgui.client-context-bridge",
    version: "1.0.0",
    react: { createElement: () => null, Fragment: Symbol("fragment"), useEffect: () => {}, useState: <T>(value: T) => [value, () => {}] },
    hooks: {
      registerSessionHooks() { registered.session += 1; return () => disposed.push("session"); },
      registerTurnHooks() { registered.turn += 1; return () => disposed.push("turn"); },
      registerRuntimeSwitchHooks() { registered.runtimeSwitch += 1; return () => disposed.push("switch"); },
    },
    workspace: { getMetadata: async () => ({ id: "w", path: "C:/repo" }) },
    documentStorage: {
      getLocation: async () => { calls.getLocation += 1; return { kind: "data" as const, path: "C:/data" }; },
      selectLocation: async (kind: "data" | "program" | "custom") => { calls.selectLocation += 1; return { kind, path: "C:/data" }; },
      readText: async () => null,
      writeTextAtomic: async () => ({ version: "1" }),
      remove: async () => {},
      list: async () => [],
    },
    ui: {
      registerSettingsSection(definition: { component: () => unknown }) { registered.settings += 1; settingsComponent = definition.component; return () => disposed.push("settings"); },
      registerStatusBarItem(definition: { component: () => unknown }) { registered.status += 1; statusComponent = definition.component; return () => disposed.push("status"); },
    },
    i18n: { addBundle() { registered.i18n += 1; return () => disposed.push("i18n"); } },
    storage: {
      get: async <T>(key: string) => (storage.get(key) as T | undefined) ?? null,
      set: async (key: string, value: unknown) => { storage.set(key, value); },
      delete: async (key: string) => { storage.delete(key); },
    },
    events: { on: () => () => {}, emit: () => {} },
    host: { appVersion: "1.0.0", sdkVersion: "0.4.0", locale: "en-US", isWeb: false },
  } as unknown as PluginContext;
  const cleanup = activate(context);
  return { storage, registered, disposed, settingsComponent, statusComponent, cleanup, calls };
}

describe("plugin activation", () => {
  it("always registers settings, status and i18n but leaves operations off by default", async () => {
    const harness = activationHarness(false);
    await Promise.resolve();
    expect(harness.registered).toEqual({ settings: 1, status: 1, session: 0, turn: 0, runtimeSwitch: 0, i18n: 2 });
    expect(harness.settingsComponent).toBeTypeOf("function");
    expect(harness.statusComponent).toBeTypeOf("function");
  });

  it("enables operations from persisted settings and cleans every registration", async () => {
    const harness = activationHarness(true);
    await vi.waitFor(() => expect(harness.registered.session).toBe(1));
    expect(harness.registered.turn).toBe(1);
    expect(harness.registered.runtimeSwitch).toBe(1);
    harness.cleanup?.();
    expect(harness.disposed).toEqual(expect.arrayContaining(["session", "turn", "switch", "settings", "status", "i18n"]));
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
});
