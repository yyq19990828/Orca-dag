#!/usr/bin/env node
/**
 * Build local dev assets inside `plugin/` so Orca can run the plugin completely
 * self-contained (zero manual terminal required):
 *   1. `plugin/panel/`         — Vite SPA with relative paths (`VITE_BASE=./`)
 *   2. `plugin/server/index.mjs` — esbuild zero-dep bundle of `server/src/index.ts`
 *      spawned lazily by `plugin/src/worker.ts` when no external viewer runs.
 * Pass --dist to build the same assets in a fresh `dist-plugin/` staging tree.
 */
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { stageSkill } from "./stage-skill.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const webDir = join(root, "web");
const stageDist = process.argv[2] === "--dist";
const outputRoot = join(root, stageDist ? "dist-plugin" : "plugin");
const panelOutDir = join(outputRoot, "panel");
const serverOutDir = join(outputRoot, "server");

function assertDirectory(dir, missingOk = false) {
  const stat = lstatSync(dir, { throwIfNoEntry: false });
  if (stat?.isDirectory()) return true;
  if (!stat && missingOk) return false;
  throw new Error(`Expected a real directory (not a symbolic link): ${dir}`);
}

function checkPublicAssets(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      checkPublicAssets(path);
    } else if (!entry.isFile()) {
      throw new Error(`Expected a regular public asset (not a symbolic link): ${path}`);
    }
  }
}

assertDirectory(outputRoot, stageDist);
assertDirectory(panelOutDir, true);
assertDirectory(serverOutDir, true);
assertDirectory(webDir);
const publicDir = join(webDir, "public");
// Vite follows links when copying public assets. Check the entire tree first.
if (assertDirectory(publicDir, true)) checkPublicAssets(publicDir);

const viteBin = [webDir, root]
  .map((dir) => join(dir, "node_modules", "vite", "bin", "vite.js"))
  .find((bin) => existsSync(bin));
if (!viteBin) {
  throw new Error("Local Vite installation not found. Run npm ci from the repository root.");
}

// Start with a fresh panel so Vite never clears or writes through old entries.
rmSync(stageDist ? outputRoot : panelOutDir, { recursive: true, force: true });
execFileSync(process.execPath, [viteBin, "build", "--outDir", panelOutDir], {
  cwd: webDir,
  stdio: "inherit",
  env: { ...process.env, VITE_BASE: "./" },
});
const panelEntry = join(panelOutDir, "index.html");
if (!existsSync(panelEntry)) throw new Error(`Vite build produced no ${panelEntry}`);

if (!stageDist) rmSync(serverOutDir, { recursive: true, force: true });
mkdirSync(serverOutDir, { recursive: true });
const esbuildBin = join(
  root,
  "node_modules",
  ".bin",
  process.platform === "win32" ? "esbuild.cmd" : "esbuild",
);
execFileSync(
  esbuildBin,
  [
    join(root, "server", "src", "index.ts"),
    "--bundle",
    "--platform=node",
    "--target=node22",
    "--format=esm",
    "--legal-comments=none",
    "--external:./generated/webAssets",
    `--banner:js=import{createRequire as __cr}from "node:module";const require=__cr(import.meta.url);`,
    `--outfile=${join(serverOutDir, "index.mjs")}`,
  ],
  { cwd: root, stdio: "inherit" },
);
stageSkill(join(root, "skill"), join(serverOutDir, "skill"));
