import { existsSync } from "node:fs";
import { mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { copyManifest, emitManifest } from "../vite.config";

const root = resolve(import.meta.dirname, "..");

describe("plugin bundle", () => {
  it("places the manifest beside the built entry point", async () => {
    const source = await mkdtemp(join(tmpdir(), "ccb-source-"));
    const dist = await mkdtemp(join(tmpdir(), "ccb-dist-"));
    await writeFile(join(source, "manifest.json"), '{"id":"ccgui.client-context-bridge"}');
    await writeFile(join(dist, "main.js"), "export default function activate() {}");
    await copyManifest(dist, source);
    expect(await readFile(join(dist, "manifest.json"), "utf8")).toBe('{"id":"ccgui.client-context-bridge"}');
    expect((await readdir(dist)).sort()).toEqual(["main.js", "manifest.json"]);
  });

  it("ships the real repo manifest next to the emitted main.js", async () => {
    const dist = await mkdtemp(join(tmpdir(), "ccb-dist-"));
    await writeFile(join(dist, "main.js"), "export default function activate() {}");
    await copyManifest(dist, root);
    const shipped: unknown = JSON.parse(await readFile(join(dist, "manifest.json"), "utf8"));
    const declared: unknown = JSON.parse(await readFile(join(root, "manifest.json"), "utf8"));
    expect(shipped).toEqual(declared);
    expect(shipped).toMatchObject({ id: "ccgui.client-context-bridge", tier: "js", sdkVersion: ">=0.4.0" });
    expect((await readdir(dist)).sort()).toEqual(["main.js", "manifest.json"]);
  });

  it("copies the manifest as a build-only step of the emitted bundle", () => {
    const plugin = emitManifest();
    expect(plugin.name).toBe("ccb-emit-manifest");
    expect(plugin.apply).toBe("build");
    expect(plugin.closeBundle).toBeTypeOf("function");
  });

  it("keeps one manifest source and no legacy duplicate", () => {
    expect(existsSync(join(root, "manifest.json"))).toBe(true);
    expect(existsSync(join(root, "ccgui.plugin.json"))).toBe(false);
  });
});
