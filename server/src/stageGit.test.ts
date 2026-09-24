import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MERGE_PREP_MARKER, StageGit, validateStagePlan } from "./stageGit";
import type { OrcaTask } from "./orca";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function git(dir: string, ...args: string[]): string {
  return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" }).trim();
}

function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), "orca-stage-git-"));
  dirs.push(dir);
  git(dir, "init", "-b", "main");
  git(dir, "config", "user.name", "Test");
  git(dir, "config", "user.email", "test@example.com");
  writeFileSync(join(dir, "base.txt"), "base\n");
  git(dir, "add", "base.txt");
  git(dir, "commit", "-m", "base");
  return dir;
}

function task(id: string, deps: string[], spec = "develop"): OrcaTask {
  return { id, deps: JSON.stringify(deps), spec, status: "pending" } as OrcaTask;
}

describe("committed Stage Git contract", () => {
  it("rejects a Stage that committed only in a nested worktree", async () => {
    const root = repo();
    const store = await StageGit.open(root, "run_nested", [task("a", [])]);
    const assigned = join(root, "..", `${root.split("/").at(-1)}-assigned`);
    const nested = join(root, "..", `${root.split("/").at(-1)}-nested`);
    dirs.push(assigned, nested);
    git(root, "worktree", "add", "-b", "stage-a", assigned, store.base);
    git(root, "worktree", "add", "-b", "stage-a-nested", nested, store.base);
    writeFileSync(join(nested, "result.md"), "nested result\n");
    git(nested, "add", "result.md");
    git(nested, "commit", "-m", "nested result");
    await assert.rejects(store.snapshot("a", "ctx_a", assigned), /left its assigned worktree.*at Run base/);
    assert.equal(store.artifact("a"), undefined);
  });

  it("captures immutable source tips and verifies a clean history-preserving merge", async () => {
    const root = repo();
    const tasks = [task("a", []), task("b", []), task("merge", ["a", "b"], MERGE_PREP_MARKER), task("dev", ["merge"])];
    const store = await StageGit.open(root, "run_test", tasks);
    const base = store.base;
    const a = join(root, "..", `${root.split("/").at(-1)}-a`);
    const b = join(root, "..", `${root.split("/").at(-1)}-b`);
    dirs.push(a, b);
    git(root, "worktree", "add", "-b", "stage-a", a, base);
    git(root, "worktree", "add", "-b", "stage-b", b, base);
    writeFileSync(join(a, "a.txt"), "a\n");
    git(a, "add", "a.txt");
    git(a, "commit", "-m", "stage a");
    writeFileSync(join(b, "b.txt"), "b\n");
    git(b, "add", "b.txt");
    git(b, "commit", "-m", "stage b");
    const aRecord = await store.snapshot("a", "ctx_a", a);
    const bRecord = await store.snapshot("b", "ctx_b", b);
    assert.equal(aRecord.sha, git(a, "rev-parse", "HEAD"));
    assert.equal(bRecord.sha, git(b, "rev-parse", "HEAD"));
    await assert.rejects(store.verifyDependencies(tasks[2], root), /not an ancestor/);
    git(root, "merge", "--no-ff", "--no-edit", aRecord.sha);
    git(root, "merge", "--no-ff", "--no-edit", bRecord.sha);
    await store.verifyDependencies(tasks[2], root);
    await store.snapshot("merge", "ctx_merge", root);
    const reloaded = await StageGit.open(root, "run_test", tasks);
    assert.equal(reloaded.artifact("a")?.sha, aRecord.sha);
    await reloaded.verifyDependencies(tasks[3], root);
    writeFileSync(join(root, "dirty.txt"), "uncommitted\n");
    await assert.rejects(reloaded.verifyDependencies(tasks[3], root), /uncommitted changes/);
  });

  it("requires a merge-prep Task at every cross-workspace edge and orders shared worktrees", () => {
    const tasks = [task("a", []), task("b", []), task("merge", ["a", "b"], MERGE_PREP_MARKER), task("dev", ["merge"])];
    const lanes = { a: "lane_a", b: "lane_b" };
    assert.deepEqual(validateStagePlan(tasks, lanes), []);
    assert.ok(validateStagePlan([...tasks, task("rogue", ["a"])], lanes)
      .some((issue) => issue.includes("rogue consumes another workspace")));
    const bad = [task("a", []), task("b", []), task("merge", ["a", "b"], MERGE_PREP_MARKER), task("dev", ["merge", "a"])];
    assert.ok(validateStagePlan(bad, lanes).some((issue) => issue.includes("dev consumes another workspace")));
  });
});
