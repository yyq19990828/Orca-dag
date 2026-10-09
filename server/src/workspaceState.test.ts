import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { ActivityJournal, createViewerActivity } from "./activity";
import { loadConfig, saveConfig } from "./config";
import { LaunchHistory } from "./launchHistory";
import { ProviderSessionStore } from "./providerSessions";
import { RequestLedger } from "./requestLedger";
import { initializeWorkspaceState, legacyWorkspaceStatePath, prepareWorkspaceStateFile, workspaceStateReadPath, WORKSPACE_STATE_FILES } from "./workspaceState";

let root: string;
let workspace: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "orca-dag-state-test-"));
  workspace = join(root, "workspace");
  mkdirSync(workspace);
});
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

describe("workspace state layout and migration", () => {
  it("uses the shared .orca-dag directory for all five stores without creating files on empty reads", async () => {
    assert.deepEqual(Object.values(WORKSPACE_STATE_FILES), [
      ".orca-dag/config.json", ".orca-dag/activity.jsonl", ".orca-dag/launches.jsonl", ".orca-dag/requests.jsonl", ".orca-dag/sessions.json",
    ]);
    assert.deepEqual(await loadConfig(workspace), {});
    assert.deepEqual(await new ActivityJournal(workspace).list("run_a"), []);
    assert.deepEqual(await new RequestLedger(workspace).list(), []);
    assert.equal((await new LaunchHistory(workspace).list("run_a")).size, 0);
    assert.deepEqual(await new ProviderSessionStore(workspace).list(), []);
    assert.equal(initializeWorkspaceState(workspace).length, 1);
    assert.equal(existsSync(join(workspace, ".orca-dag")), false);
  });

  it("moves all legacy files byte-for-byte, preserves modes, and is idempotent", () => {
    const contents = new Map<string, Buffer>();
    for (const file of Object.values(WORKSPACE_STATE_FILES)) {
      const bytes = Buffer.from(`{"source":"${file}"}\r\n{"torn":`, "utf8");
      contents.set(file, bytes);
      writeFileSync(legacyWorkspaceStatePath(workspace, file), bytes, { mode: 0o600 });
    }
    const report = initializeWorkspaceState(workspace);
    assert.equal(report.filter((line) => line.startsWith("Moved workspace state:")).length, 5);
    for (const file of Object.values(WORKSPACE_STATE_FILES)) {
      const path = join(workspace, file);
      assert.deepEqual(readFileSync(path), contents.get(file));
      assert.equal(statSync(path).mode & 0o777, 0o600);
      assert.equal(existsSync(legacyWorkspaceStatePath(workspace, file)), false);
      assert.equal(prepareWorkspaceStateFile(workspace, file).status, "present");
    }
    assert.equal(initializeWorkspaceState(workspace).length, 1);
  });

  it("never overwrites an existing new file or silently merges conflicting history", async () => {
    const file = WORKSPACE_STATE_FILES.config;
    mkdirSync(join(workspace, ".orca-dag"));
    writeFileSync(join(workspace, file), '{"runId":"run_new","defaultHarness":"codex"}\n');
    const legacy = legacyWorkspaceStatePath(workspace, file);
    const old = '{"runId":"run_old","defaultHarness":"claude"}\n';
    writeFileSync(legacy, old);
    assert.equal(prepareWorkspaceStateFile(workspace, file).status, "conflict");
    assert.match(initializeWorkspaceState(workspace).join("\n"), /WARNING: both.*Reconcile manually/);
    assert.deepEqual(await loadConfig(workspace), { runId: "run_new", defaultHarness: "codex" });
    await saveConfig(workspace, { maxConcurrency: 3 });
    assert.equal(readFileSync(legacy, "utf8"), old);
    assert.equal((await loadConfig(workspace)).runId, "run_new");
  });

  for (const dangling of [false, true]) {
    it(`refuses a ${dangling ? "dangling" : "valid"} shared-directory symlink without moving old files`, () => {
      const target = join(root, "external");
      if (!dangling) mkdirSync(target);
      symlinkSync(target, join(workspace, ".orca-dag"));
      const file = WORKSPACE_STATE_FILES.config;
      const legacy = legacyWorkspaceStatePath(workspace, file);
      writeFileSync(legacy, "{}\n");
      assert.throws(() => prepareWorkspaceStateFile(workspace, file, true), /real directory/);
      assert.match(initializeWorkspaceState(workspace).join("\n"), /WARNING/);
      assert.equal(readFileSync(legacy, "utf8"), "{}\n");
      assert.equal(existsSync(join(target, "config.json")), false);
    });
  }

  it("refuses symlinked state files in either layout without overwriting their targets", () => {
    const file = WORKSPACE_STATE_FILES.config;
    const target = join(root, "external-config");
    writeFileSync(target, "external data\n");
    const legacy = legacyWorkspaceStatePath(workspace, file);
    symlinkSync(target, legacy);
    assert.throws(() => prepareWorkspaceStateFile(workspace, file, true), /regular file/);
    rmSync(legacy);
    mkdirSync(join(workspace, ".orca-dag"));
    symlinkSync(target, join(workspace, file));
    assert.throws(() => prepareWorkspaceStateFile(workspace, file, true), /regular file/);
    assert.equal(readFileSync(target, "utf8"), "external data\n");
  });

  it("does not interpret a directory with a legacy state filename as disposable state", () => {
    const file = WORKSPACE_STATE_FILES.config;
    mkdirSync(legacyWorkspaceStatePath(workspace, file));
    assert.throws(() => prepareWorkspaceStateFile(workspace, file), /regular file/);
    assert.equal(existsSync(join(workspace, ".orca-dag")), false);
  });

  it("keeps old config readable if migration cannot write, without writing back to the root", async (t) => {
    if (process.getuid?.() === 0) { t.skip("root bypasses read-only directory permissions"); return; }
    const file = WORKSPACE_STATE_FILES.config;
    const legacy = legacyWorkspaceStatePath(workspace, file);
    writeFileSync(legacy, '{"runId":"run_old"}\n');
    const dataDir = join(workspace, ".orca-dag");
    mkdirSync(dataDir);
    chmodSync(dataDir, 0o500);
    try {
      assert.equal(workspaceStateReadPath(workspace, file), legacy);
      assert.equal((await loadConfig(workspace)).runId, "run_old");
      await assert.rejects(() => saveConfig(workspace, { runId: "run_new" }));
      assert.equal(readFileSync(legacy, "utf8"), '{"runId":"run_old"}\n');
    } finally {
      chmodSync(dataDir, 0o700);
    }
  });

  it("all stores survive a legacy-layout restart and never recreate the root files", async () => {
    await saveConfig(workspace, { runId: "run_a", defaultHarness: "codex" });
    await new ActivityJournal(workspace).append(createViewerActivity({ runId: "run_a", kind: "reply", title: "Reply", summary: "Preserved activity" }));
    await new RequestLedger(workspace).record({ requestId: "request_a", operation: "worker-start", runId: "run_a", taskId: "task_a", dispatchId: "ctx_a" });
    await new LaunchHistory(workspace).record({ runId: "run_a", taskId: "task_a", dispatchId: "ctx_a", harness: "codex", source: "viewer-launch" });
    await new ProviderSessionStore(workspace).bind({ runId: "run_a", taskId: "task_a", dispatchId: "ctx_a", harness: "codex", sessionId: "session_a", workspace, host: "local:local", source: "manual" });
    const bytes = new Map<string, Buffer>();
    for (const file of Object.values(WORKSPACE_STATE_FILES)) {
      const path = join(workspace, file);
      bytes.set(file, readFileSync(path));
      renameSync(path, legacyWorkspaceStatePath(workspace, file));
    }
    assert.equal((await loadConfig(workspace)).runId, "run_a");
    assert.equal((await new ActivityJournal(workspace).list("run_a"))[0].summary, "Preserved activity");
    assert.equal((await new RequestLedger(workspace).list())[0].requestId, "request_a");
    assert.equal((await new LaunchHistory(workspace).list("run_a")).get("ctx_a")?.harness, "codex");
    assert.equal((await new ProviderSessionStore(workspace).list("run_a"))[0].sessionId, "session_a");
    for (const file of Object.values(WORKSPACE_STATE_FILES)) {
      assert.equal(existsSync(legacyWorkspaceStatePath(workspace, file)), false);
      assert.deepEqual(readFileSync(join(workspace, file)), bytes.get(file));
      assert.equal(dirname(join(workspace, file)), join(workspace, ".orca-dag"));
    }
    await new RequestLedger(workspace).record({ requestId: "request_b", operation: "worker-release", runId: "run_a", taskId: "task_a", dispatchId: "ctx_a" });
    assert.equal(existsSync(legacyWorkspaceStatePath(workspace, WORKSPACE_STATE_FILES.requests)), false);
    assert.equal((await new RequestLedger(workspace).list()).length, 2);
  });
});
