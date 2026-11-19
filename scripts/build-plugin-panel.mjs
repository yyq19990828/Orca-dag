#!/usr/bin/env node
/**
 * Build local dev assets inside `plugin/` so Orca can run the plugin completely
 * self-contained (zero manual terminal required):
 *   1. `plugin/panel/`         — Vite SPA with relative paths (`VITE_BASE=./`)
 *   2. `plugin/server/index.mjs` — esbuild zero-dep bundle of `server/src/index.ts`
 *      spawned lazily by `plugin/src/worker.ts` when no external viewer runs.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const webDir = join(root, "web");
const panelOutDir = join(root, "plugin", "panel");
const serverOutDir = join(root, "plugin", "server");

execFileSync(
  process.platform === "win32" ? "npx.cmd" : "npx",
  ["vite", "build", "--outDir", panelOutDir, "--emptyOutDir"],
  {
    cwd: webDir,
    stdio: "inherit",
    env: { ...process.env, VITE_BASE: "./" },
  },
);

rmSync(serverOutDir, { recursive: true, force: true });
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
