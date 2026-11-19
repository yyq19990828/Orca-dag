#!/usr/bin/env node
// Stage the standalone, distribution-ready Orca companion plugin (`orchestration-panel`).
//
//   node scripts/build-plugin.mjs   → dist-plugin/
//
// Layout (Orca plugin archive limits: <= 2,000 files, <= 50 MiB, zero node_modules):
//
//   dist-plugin/
//     orca-plugin.json   ← manifest rewritten with `"main": "worker.mjs"`
//     worker.mjs         ← esbuild ESM bundle of plugin/src/worker.ts (Node 22+)
//     panel/**           ← Vite SPA build with `VITE_BASE=./` for Orca's HTML panel
//     README.md, LICENSE ← plugin documentation & license
//
// Validate the staged directory against the installed Orca runtime:
//   orca-ide plugin validate ./dist-plugin --json
//   orca-ide plugin inspect ./dist-plugin --json

import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const MAX_PLUGIN_FILES = 2_000;
const MAX_PLUGIN_BYTES = 50 * 1024 * 1024;

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const webDir = join(root, "web");
const pluginDir = join(root, "plugin");
const outDir = join(root, "dist-plugin");
const manifest = JSON.parse(readFileSync(join(pluginDir, "orca-plugin.json"), "utf8"));
const version = (process.env.PKG_VERSION ?? manifest.version ?? "0.1.0").replace(/^v/, "");

function run(cmd, args, opts = {}) {
  console.log(`\n$ ${cmd} ${args.join(" ")}`);
  execFileSync(cmd, args, { cwd: root, stdio: "inherit", ...opts });
}

function measureTree(dir) {
  let files = 0;
  let bytes = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      const sub = measureTree(full);
      files += sub.files;
      bytes += sub.bytes;
    } else if (entry.isFile()) {
      files += 1;
      bytes += statSync(full).size;
    }
  }
  return { files, bytes };
}

// 1. Reset staging directory --------------------------------------------------
rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

// 2. Build the HTML sidebar panel SPA with relative asset URLs ----------------
const panelOutDir = join(outDir, "panel");
run(
  process.platform === "win32" ? "npx.cmd" : "npx",
  ["vite", "build", "--outDir", panelOutDir, "--emptyOutDir"],
  { cwd: webDir, env: { ...process.env, VITE_BASE: "./" } },
);
if (!existsSync(join(panelOutDir, "index.html"))) {
  throw new Error(`vite build produced no ${join(panelOutDir, "index.html")}`);
}

// 3. Bundle the trusted-worker entrypoint (zero runtime dependencies) ---------
const esbuildBin = join(
  root,
  "node_modules",
  ".bin",
  process.platform === "win32" ? "esbuild.cmd" : "esbuild",
);
run(esbuildBin, [
  join(pluginDir, "src", "worker.ts"),
  "--bundle",
  "--platform=node",
  "--target=node22",
  "--format=esm",
  "--legal-comments=none",
  `--outfile=${join(outDir, "worker.mjs")}`,
]);

// 4. Emit production manifest + docs ------------------------------------------
const prodManifest = {
  ...manifest,
  version,
  main: "worker.mjs",
};
writeFileSync(join(outDir, "orca-plugin.json"), JSON.stringify(prodManifest, null, 2) + "\n");

if (existsSync(join(pluginDir, "icon.png"))) {
  cpSync(join(pluginDir, "icon.png"), join(outDir, "icon.png"));
}
if (existsSync(join(pluginDir, "README.md"))) {
  cpSync(join(pluginDir, "README.md"), join(outDir, "README.md"));
}
if (existsSync(join(root, "LICENSE"))) {
  cpSync(join(root, "LICENSE"), join(outDir, "LICENSE"));
}

// 5. Enforce Orca plugin archive size & file-count limits ---------------------
const { files, bytes } = measureTree(outDir);
if (files > MAX_PLUGIN_FILES) {
  throw new Error(`dist-plugin has ${files} files, exceeding Orca's ${MAX_PLUGIN_FILES}-file limit.`);
}
if (bytes > MAX_PLUGIN_BYTES) {
  throw new Error(`dist-plugin is ${bytes} bytes, exceeding Orca's ${MAX_PLUGIN_BYTES}-byte limit.`);
}

const kb = (bytes / 1024).toFixed(1);
console.log(`\n✅ Staged Orca plugin → dist-plugin/ (id=${prodManifest.id}, version=${version})`);
console.log(`   Archive size: ${files} files, ${kb} KiB (limits: ${MAX_PLUGIN_FILES} files, 50 MiB)`);
console.log(`   Validate:     orca-ide plugin validate ./dist-plugin --json`);
console.log(`   Inspect:      orca-ide plugin inspect ./dist-plugin --json`);
