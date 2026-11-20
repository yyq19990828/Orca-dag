import { createHash, createHmac } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export interface PluginEndpointRecord {
  version: 2;
  port: number;
  pid: number;
  instanceId: string;
  pluginToken: string;
  workspace: string;
}

// This is a trust registry, not workspace state. A checkout (including its
// ignored paths) must not be able to enroll a server for the trusted worker.
export function pluginEndpointPath(workspace: string, create = false): string {
  let canonical: string;
  try { canonical = realpathSync(workspace); }
  catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT" || create) throw err;
    canonical = resolve(workspace); // uninstall can run after the worktree disappears
  }
  const directory = join(homedir(), ".orca-dag-viewers");
  if (create) {
    try { mkdirSync(directory, { mode: 0o700 }); }
    catch (err) { if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err; }
  }
  const stat = lstatSync(directory);
  if (!stat.isDirectory() || (process.getuid && (stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0))) {
    throw new Error(`${directory} must be a private, user-owned directory`);
  }
  const key = createHash("sha256").update(canonical).digest("hex");
  return join(directory, `${key}.json`);
}

export function checkPluginEndpointFile(path: string): void {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.nlink !== 1 || stat.size > 16_384 ||
      (process.getuid && (stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0))) {
    throw new Error(`${path} must be a private, user-owned endpoint file`);
  }
}

export function readPluginEndpointFile(workspace: string): PluginEndpointRecord | null {
  try {
    const path = pluginEndpointPath(workspace);
    checkPluginEndpointFile(path);
    const row = JSON.parse(readFileSync(path, "utf8")) as Partial<PluginEndpointRecord> | null;
    return row?.version === 2 && row.workspace === realpathSync(workspace) &&
      typeof row.port === "number" && Number.isInteger(row.port) && row.port > 0 && row.port <= 65535 &&
      typeof row.pid === "number" && Number.isSafeInteger(row.pid) && row.pid > 0 &&
      typeof row.instanceId === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(row.instanceId) &&
      typeof row.pluginToken === "string" && /^[A-Za-z0-9_-]{32}$/.test(row.pluginToken)
      ? row as PluginEndpointRecord : null;
  } catch {
    return null;
  }
}

// Keep the signing key off the HTTP connection; a stale port can see a request
// credential but cannot forge a fresh proof or sign an inbox command.
export function pluginRequestToken(key: string): string {
  return createHmac("sha256", key).update("orca-dag:plugin-request:v2").digest("base64url");
}

export const PLUGIN_NONCE = /^[A-Za-z0-9_-]{22}$/;

export function signPluginReply(key: string, kind: "hello" | "inbox", nonce: string, body: string): string {
  return createHmac("sha256", key).update(`orca-dag:plugin-reply:v2:${kind}:${nonce}:`).update(body).digest("base64url");
}
