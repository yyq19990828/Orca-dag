import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { LaunchHistory, LAUNCHES_FILE } from "./launchHistory";

describe("LaunchHistory", () => {
  let workspace: string;

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), "orca-dag-launch-history-"));
  });

  afterEach(() => {
    rmSync(workspace, { recursive: true, force: true });
  });

  it("parses legacy 5-field lines and rejects invalid optional metadata", async () => {
    const file = join(workspace, LAUNCHES_FILE);
    mkdirSync(dirname(file), { recursive: true });
    appendFileSync(
      file,
      [
        JSON.stringify({
          runId: "run_legacy",
          taskId: "task_1",
          dispatchId: "ctx_1",
          harness: "codex",
          source: "viewer-launch",
        }),
        JSON.stringify({
          runId: "run_legacy",
          taskId: "task_bad",
          dispatchId: "ctx_bad",
          harness: "codex",
          model: "bad\nmodel",
          source: "viewer-launch",
        }),
      ].join("\n") + "\n",
      "utf8",
    );

    const store = new LaunchHistory(workspace);
    await store.record({
      runId: "run_legacy",
      taskId: "task_2",
      dispatchId: "ctx_2",
      harness: "claude",
      model: "claude-sonnet-4-6",
      effort: "high",
      worktree: "id:repo_1::/tmp/wt-auth",
      worktreeName: "wt-auth",
      branch: "feat/auth",
      source: "viewer-launch",
    });
    // Rejected at write boundary too when control characters are present.
    await store.record({
      runId: "run_legacy",
      taskId: "task_3",
      dispatchId: "ctx_3",
      harness: "claude",
      branch: "bad\x00branch",
      source: "viewer-launch",
    });

    const records = await store.list("run_legacy");
    assert.equal(records.size, 2);
    assert.equal(records.get("ctx_1")?.harness, "codex");
    assert.equal(records.get("ctx_1")?.model, null);
    assert.deepEqual(records.get("ctx_2"), {
      runId: "run_legacy",
      taskId: "task_2",
      dispatchId: "ctx_2",
      harness: "claude",
      model: "claude-sonnet-4-6",
      effort: "high",
      worktree: "id:repo_1::/tmp/wt-auth",
      worktreeName: "wt-auth",
      branch: "feat/auth",
      source: "viewer-launch",
    });
  });

  it("merges richer observations across appends without downgrading worker-show authority", async () => {
    const store = new LaunchHistory(workspace);
    await store.record({
      runId: "run_merge",
      taskId: "task_a",
      dispatchId: "ctx_a",
      harness: "claude",
      worktree: "id:repo_1::/tmp/wt-a",
      source: "viewer-launch",
    });
    await store.record({
      runId: "run_merge",
      taskId: "task_a",
      dispatchId: "ctx_a",
      harness: "claude",
      model: "claude-opus-4-6",
      effort: "medium",
      branch: "feat/merge-a",
      source: "viewer-launch",
    });
    await store.record({
      runId: "run_merge",
      taskId: "task_a",
      dispatchId: "ctx_a",
      harness: "codex",
      model: "gpt-5.4",
      source: "worker-show",
    });
    // Later weaker append must not wipe worker-show harness/model/source or earlier worktree/branch.
    await store.record({
      runId: "run_merge",
      taskId: "task_a",
      dispatchId: "ctx_a",
      harness: "claude",
      model: "claude-haiku",
      worktreeName: "lane-a",
      source: "viewer-launch",
    });

    const merged = (await store.list("run_merge")).get("ctx_a");
    assert.deepEqual(merged, {
      runId: "run_merge",
      taskId: "task_a",
      dispatchId: "ctx_a",
      harness: "codex",
      model: "gpt-5.4",
      effort: "medium",
      worktree: "id:repo_1::/tmp/wt-a",
      worktreeName: "lane-a",
      branch: "feat/merge-a",
      source: "worker-show",
    });
  });
});
