import { copyFile } from "node:fs/promises";
import { resolve } from "node:path";
import { defineConfig, type Plugin } from "vite";

/**
 * Copies the single-source repo-root manifest next to the built `main.js`, so the
 * emitted `dist/` directory is itself an installable bundle: the host requires
 * `manifest.json` and `main.js` side by side at the bundle root.
 */
export function copyManifest(outDir: string, root: string): Promise<void> {
  return copyFile(resolve(root, "manifest.json"), resolve(outDir, "manifest.json"));
}

export function emitManifest(): Plugin {
  let root = process.cwd();
  let outDir = "dist";
  return {
    name: "ccb-emit-manifest",
    apply: "build",
    configResolved(config) {
      root = config.root;
      outDir = resolve(config.root, config.build.outDir);
    },
    async closeBundle() {
      await copyManifest(outDir, root);
    },
  };
}

export default defineConfig({
  plugins: [emitManifest()],
  build: {
    lib: {
      entry: "src/index.ts",
      formats: ["es"],
      fileName: () => "main.js",
    },
    rollupOptions: {
      output: {
        inlineDynamicImports: true,
      },
    },
  },
});
