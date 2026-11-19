#!/usr/bin/env node
/**
 * Build the web SPA with relative asset paths (`VITE_BASE=./`) and stage it
 * directly into `plugin/panel/` so Orca's isolated HTML sidebar panel renders
 * the full Orchestration UI through the companion plugin worker bridge.
 */
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const webDir = join(root, "web");
const outDir = join(root, "plugin", "panel");

execFileSync(
  process.platform === "win32" ? "npx.cmd" : "npx",
  ["vite", "build", "--outDir", outDir, "--emptyOutDir"],
  {
    cwd: webDir,
    stdio: "inherit",
    env: { ...process.env, VITE_BASE: "./" },
  },
);
