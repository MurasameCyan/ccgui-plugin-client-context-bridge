// Release metadata must agree before either CI packaging or publication.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const root = fileURLToPath(new URL("..", import.meta.url));
const fail = (message) => {
  console.error(`release check failed: ${message}`);
  process.exit(1);
};
const readJson = (name) => JSON.parse(readFileSync(resolve(root, name), "utf8"));

const manifest = readJson("manifest.json");
const packageJson = readJson("package.json");
const lock = readJson("package-lock.json");
const version = manifest.version;
if (typeof version !== "string" || !/^\d+\.\d+\.\d+$/.test(version)) {
  fail(`manifest.version must be a numeric x.y.z version, got ${JSON.stringify(version)}`);
}

for (const [name, actual] of [
  ["package.json version", packageJson.version],
  ["package-lock.json version", lock.version],
  ["package-lock.json root package version", lock.packages?.[""]?.version],
]) {
  if (actual !== version) {
    fail(`${name} ${JSON.stringify(actual)} != manifest.version ${version}`);
  }
}

if (process.env.GITHUB_REF_TYPE === "tag" && process.env.GITHUB_REF_NAME !== version) {
  fail(`tag ${JSON.stringify(process.env.GITHUB_REF_NAME)} != manifest.version ${version}; use the exact version without a v prefix`);
}

console.log(`release metadata ok: ${manifest.id} ${version}`);
