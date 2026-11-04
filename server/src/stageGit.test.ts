import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MERGE_PREP_MARKER, MERGE_INPUTS_V3_MARKER, MERGE_INPUTS_SUBJECT, StageGit, buildMergeInputs, isMergeInputsQuestion, validateStagePlan } from "./stageGit";
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
    writeFileSync(join(a, "later.txt"), "later branch tip\n");
    git(a, "add", "later.txt");
    git(a, "commit", "-m", "advance branch after capture");
    const protocolTask = { ...tasks[2], spec: `${MERGE_PREP_MARKER} ${MERGE_INPUTS_V3_MARKER}` };
    const instructions = await buildMergeInputs(store, protocolTask, root);
    assert.match(instructions, new RegExp(aRecord.sha));
    assert.match(instructions, new RegExp(bRecord.sha));
    assert.ok(!instructions.includes(git(a, "rev-parse", "HEAD")));
    writeFileSync(join(root, "dirty-before-inputs.txt"), "uncommitted\n");
    await assert.rejects(buildMergeInputs(store, protocolTask, root), /uncommitted changes/);
    rmSync(join(root, "dirty-before-inputs.txt"));
    await assert.rejects(buildMergeInputs(store, tasks[2], root), /does not declare/);
    assert.notEqual(aRecord.sha, git(a, "rev-parse", "HEAD"));
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
    assert.ok(validateStagePlan(tasks, lanes).some((issue) => issue.includes("unsafe legacy merge input")));
    const modern = tasks.map(item => item.id === "merge" ? { ...item, spec: `${MERGE_PREP_MARKER} ${MERGE_INPUTS_V3_MARKER}` } : item);
    assert.deepEqual(validateStagePlan(modern, lanes), []);
    const historical = tasks.map((item) => item.id === "merge" ? { ...item, status: "completed" as const } : item);
    assert.deepEqual(validateStagePlan(historical, lanes), []);
    assert.ok(validateStagePlan([...tasks, task("rogue", ["a"])], lanes)
      .some((issue) => issue.includes("rogue consumes another workspace")));
    const bad = [task("a", []), task("b", []), task("merge", ["a", "b"], MERGE_PREP_MARKER), task("dev", ["merge", "a"])];
    assert.ok(validateStagePlan(bad, lanes).some((issue) => issue.includes("dev consumes another workspace")));
  });

  it("recognizes only protocol questions, never ordinary status or substring subjects", () => {
    assert.equal(isMergeInputsQuestion({ type: "question", subject: MERGE_INPUTS_SUBJECT, payload: null }), true);
    assert.equal(isMergeInputsQuestion({ type: "status", subject: MERGE_INPUTS_SUBJECT, payload: null }), false);
    assert.equal(isMergeInputsQuestion({ type: "question", subject: `${MERGE_INPUTS_SUBJECT} extra`, payload: null }), false);
    assert.equal(isMergeInputsQuestion({ type: "question", subject: "inputs", payload: JSON.stringify({ marker: MERGE_INPUTS_V3_MARKER }) }), true);
  });
});
