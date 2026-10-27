import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import {
  bindRun, closeTerminalStrict, createTempCoordinatorTerminal, initOrcaRuntime,
  listTasks, listWorkers, readWorkerOutput, runOrca, type OrcaTask,
} from "./orca";
import { assertWorkspaceStateDirectory, WORKSPACE_DATA_DIR } from "./workspaceState";

interface VerificationStatus {
  runId: string | null;
  running: boolean;
  phase: string;
  attempts: Array<{
    taskId: string; dispatchId: string | null; settled: boolean;
    outcome: string | null; terminalDecision: string; startedAt: number;
  }>;
  cleanupDebt: unknown[];
  inbox: { pending: unknown[]; pendingDeliveryId: string | null };
}

/** Observation only: a missing ready receipt must never cancel or replace work. */
export function liveVerificationProgress(
  status: VerificationStatus,
  tasks: ReadonlyArray<Pick<OrcaTask, "id" | "status">>,
): "waiting" | "failed" | "passed" {
  if (tasks.some(task => task.status === "failed") ||
      status.attempts.some(attempt => attempt.settled && attempt.outcome === "failed")) return "failed";
  // Late accepted worker_done can settle the SAME Dispatch after start_unknown.
  // Even a stale/completed loop snapshot is not proof that this worker died.
  if (status.attempts.some(attempt => !attempt.settled)) return "waiting";
  if (status.phase !== "completed") return "waiting";
  return tasks.length === 3 && tasks.every(task => task.status === "completed") &&
    status.attempts.length === 3 && tasks.every(task =>
      status.attempts.some(attempt => attempt.taskId === task.id && attempt.outcome === "succeeded" &&
        ["released", "reused", "retained", "closed", "not_needed"].includes(attempt.terminalDecision))) &&
    status.cleanupDebt.length === 0 && status.inbox.pending.length === 0 && !status.inbox.pendingDeliveryId
    ? "passed" : "failed";
}

async function verifyLive(base: string): Promise<void> {
  const url = new URL(base);
  assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(url.hostname), "Live verification requires a local viewer");
  const session = await fetch(new URL("/api/session", url)).then(response => response.json()) as { token: string };
  async function api<T>(path: string, body?: unknown, method = body === undefined ? "GET" : "POST"): Promise<T> {
    const response = await fetch(new URL(path, url), {
      method,
      headers: body === undefined ? {} : { "Content-Type": "application/json", "X-Orca-Dag-Token": session.token },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const value = await response.json();
    assert.ok(response.ok, JSON.stringify({ path, status: response.status, value }));
    return value as T;
  }
  const readiness = await api<{ cli: string; workspace: string; worktree: string; executionEnabled: boolean }>("/api/readiness");
  assert.ok(readiness.executionEnabled, "Viewer execution is disabled");
  assert.equal((await api<VerificationStatus>("/api/run-status")).running, false, "Do not interrupt another coordinator");
  // This process creates its own short-lived planning terminal. Inheriting the
  // launching user's terminal attestation would fence its --from identity.
  for (const key of ["ORCA_TERMINAL_HANDLE", "ORCA_TAB_ID", "ORCA_WORKSPACE_ID", "ORCA_WORKTREE_ID"]) delete process.env[key];
  initOrcaRuntime({ cwd: readiness.workspace, env: {
    ...process.env, ORCA_CLI_COMMAND: readiness.cli, WORKSPACE_DIR: readiness.workspace, ORCA_WORKTREE: readiness.worktree,
  } });
  const runtime = await runOrca<{ runtime?: { appVersion?: string } }>(["status"]);
  assertWorkspaceStateDirectory(readiness.workspace);
  const dataDir = join(readiness.workspace, WORKSPACE_DATA_DIR);
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  assertWorkspaceStateDirectory(readiness.workspace);
  const output = await mkdtemp(join(dataDir, new Date().toISOString().replace(/[-:.]/g, "") + "-verification-"));
  const previousConfig = await api<Record<string, unknown>>("/api/config");
  let runId: string | null = null;
  const report: Record<string, unknown> = { outcome: "unverifiable", output, appVersion: runtime.runtime?.appVersion ?? null };
  try {
    // New immutable specs replace the broken barrier-based TEST DESIGN. Never
    // create another Run automatically to retry a failed launch in this flow.
    const created = await api<{ run: { id: string } }>("/api/runs", {
      objective: "Live verification: barrier-free Codex A/B inputs → dependent C calculation",
    });
    runId = created.run.id;
    report.runId = runId;
    const from = await createTempCoordinatorTerminal(readiness.worktree);
    const taskIds: string[] = [];
    const common = "Constraints: edit only your owned verification file. Do not explore or edit repository source, config, Git state or unrelated files. Do not start helpers or another Run. Use the exact lifecycle commands and IDs in the live preamble, process/ack coordinator mail, then send worker_done with an explicit outcome and idle. No release flag or coordinator permission is required after file validation.";
    try {
      await bindRun(runId, from);
      const specs = [
        `Target/Ownership: ${join(output, "numbers.json")} only. Change: write {"values":[2,3,5,7],"stage":"A"} as JSON. Observable acceptance: read the file back, validate the exact parsed value, and report succeeded immediately. ${common}`,
        `Target/Ownership: ${join(output, "policy.json")} only. Change: write {"multiplier":3,"stage":"B"} as JSON. Observable acceptance: read the file back, validate the exact parsed value, and report succeeded immediately. ${common}`,
        `Target: read ${join(output, "numbers.json")} and ${join(output, "policy.json")}. Ownership: ${join(output, "result.json")} only. Change: parse both inputs, sum numbers.values and multiply by policy.multiplier; write {"sum":<computed sum>,"multiplier":<read multiplier>,"result":<computed product>,"verified":true}. Observable acceptance: compute from the files, read back the result, validate its arithmetic, and report succeeded immediately. ${common}`,
      ];
      for (let index = 0; index < specs.length; index++) {
        const task = await runOrca<{ task: { id: string } }>([
          "orchestration", "task-create", "--run", runId, "--from", from,
          "--task-title", `Live verification ${["A: numbers", "B: policy", "C: join"][index]}`,
          "--spec", specs[index], "--deps", JSON.stringify(index === 2 ? taskIds : []),
        ]);
        taskIds.push(task.task.id);
      }
    } finally { await closeTerminalStrict(from); }
    report.taskIds = taskIds;
    await writeFile(join(output, "plan.json"), JSON.stringify({ ...report, base, previousConfig }, null, 2));
    await api("/api/config", { ...previousConfig, runId, maxConcurrency: 2 }, "PUT");
    // Start ONCE through the viewer. Its coordinator owns starts, unknown
    // receipts, FIFO mail, late settlement and cleanup. No manual worker-start.
    await api("/api/run", {
      runId, defaultHarness: "codex", maxConcurrency: 2, harnessByTask: {}, modelByTask: {}, effortByTask: {},
      defaultOpenCodeUi: "auto", openCodeUiByTask: {}, environmentByTask: {}, placementByTask: {},
      worktreeLanes: {}, laneByTask: {}, retainByTask: {},
    });
    console.log(JSON.stringify({ stage: "observing", runId, taskIds, output }));
    const deadline = Date.now() + 15 * 60_000;
    let previous = "";
    let parallelWitness: unknown = null;
    while (true) {
      const status = await api<VerificationStatus>("/api/run-status");
      assert.equal(status.runId, runId, "Viewer switched Runs; leave all workers untouched");
      const tasks = await listTasks(runId);
      const workers = await listWorkers(runId, { includeRemote: true });
      // Passive witness only. Sampling or startup uncertainty never blocks a
      // worker from completing and never becomes a synthetic Task dependency.
      if (!parallelWitness) {
        const roots = workers.filter(worker => taskIds.slice(0, 2).includes(worker.taskId ?? "") &&
          ["pending", "dispatched"].includes(worker.dispatchStatus) &&
          worker.projection?.liveness?.verdict === "live");
        if (roots.length === 2) parallelWitness = { at: new Date().toISOString(), workers: roots };
      }
      const progress = liveVerificationProgress(status, tasks);
      const summary = JSON.stringify({ phase: status.phase, progress, tasks: tasks.map(task => ({ id: task.id, status: task.status })), attempts: status.attempts });
      if (summary !== previous) {
        previous = summary;
        console.log(summary);
        await appendFile(join(output, "observations.jsonl"), JSON.stringify({ at: new Date().toISOString(), ...JSON.parse(summary) }) + "\n");
      }
      Object.assign(report, { status, tasks, workers, parallelWitness });
      if (progress === "failed") { report.outcome = "failed"; break; }
      if (progress === "passed") {
        assert.equal(workers.length, 3, "No duplicate or helper Dispatches");
        const numbers = JSON.parse(await readFile(join(output, "numbers.json"), "utf8"));
        const policy = JSON.parse(await readFile(join(output, "policy.json"), "utf8"));
        const result = JSON.parse(await readFile(join(output, "result.json"), "utf8"));
        assert.deepEqual(numbers, { values: [2, 3, 5, 7], stage: "A" });
        assert.deepEqual(policy, { multiplier: 3, stage: "B" });
        assert.deepEqual(result, { sum: 17, multiplier: 3, result: 51, verified: true });
        const joinAttempt = status.attempts.find(attempt => attempt.taskId === taskIds[2])!;
        for (const id of taskIds.slice(0, 2)) {
          const task = tasks.find(task => task.id === id)!;
          const time = task.completed_at ?? "";
          const completedAt = Date.parse(/^\d{4}-\d\d-\d\d /.test(time) ? time.replace(" ", "T") + "Z" : time);
          assert.ok(Number.isFinite(completedAt) && joinAttempt.startedAt >= completedAt, "C must follow accepted A/B completion");
        }
        const reclaimable = await listWorkers(runId, { includeRemote: true, terminalState: "reclaimable" });
        assert.equal(reclaimable.length, 0, "Every settled worker needs a cleanup/ownership decision");
        const outputs = [];
        for (const worker of workers) outputs.push(await readWorkerOutput(worker.dispatchId, { limit: 8 }));
        Object.assign(report, { outcome: "passed", result, reclaimable, outputs });
        break;
      }
      // A local observation deadline is not a worker failure or permission to
      // stop/retry/release. Preserve the Run and coordinator for inspection.
      if (Date.now() >= deadline) break;
      await delay(2000);
    }
  } catch (error) {
    report.error = String(error);
    throw error;
  } finally {
    report.observedAt = new Date().toISOString();
    await writeFile(join(output, "verification.json"), JSON.stringify(report, null, 2));
    const current = await api<Record<string, unknown>>("/api/config");
    if (runId && current.runId === runId && current.maxConcurrency === 2) {
      await api("/api/config", { ...current, maxConcurrency: previousConfig.maxConcurrency }, "PUT");
    }
    console.log(JSON.stringify({ outcome: report.outcome, runId, result: report.result, evidence: join(output, "verification.json") }));
    if (report.outcome !== "passed") process.exitCode = report.outcome === "failed" ? 1 : 2;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  verifyLive(process.argv[2] ?? "http://127.0.0.1:8787").catch(error => {
    console.error(String(error));
    process.exitCode = 1;
  });
}
