// Deterministic, non-interactive SDK mirror consistency check (CI-callable).
// Exits non-zero on any drift; never uses `as any`, `@ts-ignore`, or a
// string allowlist to pass. Verifies three things a manual sync can silently
// get wrong:
//   1. manifest.sdkVersion declares a >=x.y.z minimum, accepting newer hosts.
//   2. src/sdk.ts's mirror stamp equals that minimum supported contract.
//   3. the mirrored PluginContext's top-level capability keys are exactly the
//      frozen set — a later sync dropping or renaming one fails here.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const root = fileURLToPath(new URL("..", import.meta.url));
const fail = (message) => {
  console.error(`sdk-mirror check failed: ${message}`);
  process.exit(1);
};

const manifest = JSON.parse(readFileSync(resolve(root, "manifest.json"), "utf8"));
const range = manifest.sdkVersion;
const minimum = typeof range === "string" ? range.match(/^>=(\d+\.\d+\.\d+)$/) : null;
if (!minimum) {
  fail(`manifest.sdkVersion must declare a >=x.y.z minimum, got ${JSON.stringify(range)}`);
}

const sdk = readFileSync(resolve(root, "src/sdk.ts"), "utf8");
const stamp = sdk.match(/@ccgui\/plugin-sdk mirror v(\d+\.\d+\.\d+)/);
if (!stamp) fail("src/sdk.ts is missing its `@ccgui/plugin-sdk mirror v<x.y.z>` stamp");
if (stamp[1] !== minimum[1]) fail(`src/sdk.ts stamp v${stamp[1]} != minimum SDK ${minimum[1]}`);

// This plugin mirrors only the capabilities it consumes; the set is frozen so
// a future host sync that drops or adds a top-level key trips CI instead of
// silently diverging from the minimum supported contract.
const expected = [
  "pluginId", "version", "react", "hooks", "workspace", "workspaces",
  "documentStorage", "ui", "i18n", "storage", "events", "host",
].sort();

const open = sdk.indexOf("export interface PluginContext {");
if (open < 0) fail("src/sdk.ts does not declare `export interface PluginContext`");
const found = new Set();
let depth = 0;
let seenBody = false;
for (const raw of sdk.slice(open).split("\n")) {
  if (seenBody && depth === 1) {
    const member = raw.match(/^\s{2}([A-Za-z][A-Za-z0-9]*)\??\s*[:(]/);
    if (member) found.add(member[1]);
  }
  for (const ch of raw) {
    if (ch === "{") { depth++; seenBody = true; }
    else if (ch === "}") { depth--; }
  }
  if (seenBody && depth === 0) break;
}

const actual = [...found].sort();
const missing = expected.filter((k) => !found.has(k));
const extra = actual.filter((k) => !expected.includes(k));
if (missing.length || extra.length) {
  fail(
    `PluginContext top-level keys drifted from the frozen mirror.` +
      (missing.length ? ` missing: ${missing.join(", ")}.` : "") +
      (extra.length ? ` unexpected: ${extra.join(", ")}.` : ""),
  );
}

console.log(`sdk-mirror ok: ccgui.client-context-bridge requires ${range}, ${actual.length} capability keys`);
