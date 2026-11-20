import { after, beforeEach } from "node:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { ProviderSessionStore } from "../providerSessions";
import { coordinatorStatus } from "../coordinator";
import {
  initOrcaRuntime,
  startOpenCodeInteractiveWorker,
  startOpenCodeTuiWorker,
} from "../orca";

export function setupOpenCodeHarness() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "orca-dag-tui-test-")));
  const orcaFile = join(root, "orca.json");
  const providerFile = join(root, "provider.json");
  const orcaLog = join(root, "orca.log");
  const providerLog = join(root, "provider.log");
  const oldPath = process.env.PATH;
  const envKeys = ["FAKE_ORCA_STATE", "FAKE_ORCA_LOG", "FAKE_OPENCODE_STATE", "FAKE_OPENCODE_LOG", "FAKE_OPENCODE_JOURNAL"];
  const previousEnv = envKeys.map((key) => process.env[key]);
  const bin = join(root, "opencode");
  const orcaBin = join(root, "orca");
  writeFileSync(bin, readFileSync(new URL("../../test/fixtures/fake-opencode.mjs", import.meta.url)));
  writeFileSync(orcaBin, readFileSync(new URL("../../test/fixtures/fake-orca.mjs", import.meta.url)));
  chmodSync(bin, 0o755);
  chmodSync(orcaBin, 0o755);
  process.env.PATH = `${root}:${oldPath}`;
  process.env.FAKE_ORCA_STATE = orcaFile;
  process.env.FAKE_ORCA_LOG = orcaLog;
  process.env.FAKE_OPENCODE_STATE = providerFile;
  process.env.FAKE_OPENCODE_LOG = providerLog;
  process.env.FAKE_OPENCODE_JOURNAL = join(root, ".orca-dag/sessions.json");

  const store = new ProviderSessionStore(root);
  const load = (file: string) => JSON.parse(readFileSync(file, "utf8"));
  const update = (file: string, changes: Record<string, unknown>) =>
    writeFileSync(file, JSON.stringify({ ...load(file), ...changes }));
  const calls = (file: string, verb: string) =>
    readFileSync(file, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line))
      .filter((row) => row.argv[1] === verb);

  const start = () =>
    startOpenCodeTuiWorker({
      taskId: "task_test",
      runId: "run_test",
      from: "term_coordinator",
      worktree: `path:${root}`,
      model: "provider/model#high",
      retryRequestId: randomUUID(),
      onHandle: () => {},
    });

  const interactive = (frontend: "mini" | "tui" = "mini", model: string | null = "provider/model#high") =>
    startOpenCodeInteractiveWorker({
      frontend,
      taskId: "task_test",
      runId: "run_test",
      from: "term_coordinator",
      worktree: `path:${root}`,
      model,
      retryRequestId: randomUUID(),
      onHandle: () => {},
    });

  const settle = () => {
    const data = load(orcaFile);
    const dispatch = Object.values(data.dispatches)[0] as Record<string, unknown>;
    dispatch.status = "completed";
    dispatch.terminalState = "reclaimable";
    data.tasks.task_test.status = "completed";
    writeFileSync(orcaFile, JSON.stringify(data));
    update(providerFile, { active: false });
  };

  const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  async function waitFor(check: () => boolean): Promise<void> {
    for (let i = 0; i < 200; i++) {
      if (check()) return;
      await pause(25);
    }
    throw new Error(`Timed out: ${JSON.stringify(coordinatorStatus())}`);
  }

  async function settleWithLock(): Promise<void> {
    for (;;) {
      try {
        mkdirSync(`${orcaFile}.lock`);
        break;
      } catch {
        await pause(5);
      }
    }
    try {
      settle();
    } finally {
      rmSync(`${orcaFile}.lock`, { recursive: true });
    }
  }

  const coordinatorOpts = () => ({
    runId: "run_test",
    worktree: `path:${root}`,
    defaultHarness: "opencode",
    harnessByTask: {},
    modelByTask: { task_test: "provider/model#high" },
    maxConcurrency: 1,
    tickWaitMs: 25,
  });

  beforeEach(() => {
    rmSync(join(root, ".orca-dag"), { recursive: true, force: true });
    writeFileSync(
      orcaFile,
      JSON.stringify({
        openCodeTui: true,
        version: "1.4.222",
        runs: { run_test: { id: "run_test", objective: "test", legacy: 0 } },
        worktrees: [{ id: "worktree_test", path: root, hostId: "local" }],
        tasks: { task_test: { id: "task_test", run_id: "run_test", status: "ready", deps: "[]" } },
      }),
    );
    writeFileSync(providerFile, JSON.stringify({ active: true }));
    writeFileSync(orcaLog, "");
    writeFileSync(providerLog, "");
    initOrcaRuntime({ env: { ORCA_CLI_COMMAND: orcaBin, WORKSPACE_DIR: root }, cwd: root });
  });

  after(() => {
    process.env.PATH = oldPath;
    envKeys.forEach((key, i) => {
      if (previousEnv[i] === undefined) delete process.env[key];
      else process.env[key] = previousEnv[i];
    });
    rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 25 });
  });

  return {
    root,
    orcaFile,
    providerFile,
    orcaLog,
    providerLog,
    store,
    load,
    update,
    calls,
    start,
    interactive,
    settle,
    pause,
    waitFor,
    settleWithLock,
    coordinatorOpts,
  };
}
