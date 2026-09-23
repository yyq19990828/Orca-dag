#!/usr/bin/env node
// Deterministic Orca 1.4.205 CLI double for coordinator.test.ts (plan §9.2).
//
// Emulates exactly the surface the Phase 3 coordinator drives: FIFO Deliveries
// that replay until `check --ack`, `worker-list` terminal accounting,
// `worker-release` / `worker-retain` / `worker-stop` receipts (release_unknown
// exits non-zero, per the runtime contract), `worker-read` archives, and the
// worker-start / tracking-dispatch launch paths. All state lives in one JSON
// file (FAKE_ORCA_STATE) so the coordinator's many short-lived child processes
// see one consistent world; every invocation takes a lockfile so concurrent
// calls (the coordinator starts waves in parallel) serialize. Every argv is
// appended to FAKE_ORCA_LOG for call-order assertions.
//
// Orca behaviors the tests rely on are reproduced faithfully:
//   * a task whose deps are all terminal flips pending → ready (Orca drives
//     the DAG forward, not the viewer);
//   * accepting a worker's mail settles nothing by itself — the task row the
//     test mutates stands in for the runtime's own settlement write;
//   * `worker-release` answers release_pending / release_unknown exactly as
//     documented, including the non-zero exit for the unknown case.
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";

const args = process.argv.slice(2);
const statePath = process.env.FAKE_ORCA_STATE ?? "";
const logPath = process.env.FAKE_ORCA_LOG ?? "";

function busySleep(ms) {
  const t = Date.now();
  while (Date.now() - t < ms) {
    /* synchronous: the fake must answer inside one process lifetime */
  }
}

// --- lock + state -----------------------------------------------------------

const lockDir = `${statePath}.lock`;
const lockStart = Date.now();
for (;;) {
  try {
    mkdirSync(lockDir);
    break;
  } catch {
    if (Date.now() - lockStart > 10_000) {
      process.stderr.write("fake-orca: state lock timeout\n");
      process.exit(1);
    }
    busySleep(3);
  }
}

let state = {};
try {
  state = existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")) : {};
} catch {
  state = {};
}

function save() {
  writeFileSync(statePath, JSON.stringify(state));
}

/**
 * Land one supervised worker-start: mint the Dispatch, flip the task, return
 * the receipt outcome. Shared by the normal path and both recovery replays so
 * "exactly one Dispatch per landed start" is structural, not incidental.
 *
 * Creating placements (`--worktree new-child|new-top-level`) resolve to a
 * durable worktree row: the runtime creates (or finds, for a retried
 * creation) the workspace and reports its EXACT selector back — in the
 * receipt echo and in the dispatch row's launch projection. That echo is the
 * positive evidence the coordinator's lane identity recovery adopts;
 * `laneDiscoveryOnly` suppresses it to exercise the discovery fallback.
 */
function resolveWorktreeIdentity() {
  const wt = flag("--worktree");
  if (wt !== "new-child" && wt !== "new-top-level") return wt ?? null;
  const name = flag("--name");
  if (!name) fail("invalid_argument", "creating placements require --name");
  state.worktrees ??= [];
  const repoSel = wt === "new-top-level" ? (flag("--repo") ?? "") : "";
  const repoId = repoSel.startsWith("id:") ? repoSel.slice(3) : repoSel ? null : "repoL";
  let row = state.worktrees.find(
    (w) => (w.displayName ?? w.name) === name && (wt !== "new-top-level" || w.repoId === repoId),
  );
  if (!row) {
    row = {
      id: `id:${repoId ?? "repoX"}::/ws/${name}`,
      repoId,
      path: `/ws/${name}`,
      displayName: name,
      branch: flag("--base-branch") ?? `orca/${name}`,
      hostId: null,
      parentWorktreeId: wt === "new-child" ? "id:repoL::/ws/main" : null,
      isMainWorktree: false,
    };
    state.worktrees.push(row);
  }
  return row.id;
}

function landSupervised(taskId, runId) {
  state.seq ??= {};
  state.seq.dispatch = (state.seq.dispatch ?? 0) + 1;
  const id = `ctx_s${state.seq.dispatch}`;
  state.dispatches ??= {};
  const reuseHandle = flag("--terminal");
  if (reuseHandle) {
    // Terminal ownership MOVES to the new Dispatch: the old one no longer
    // holds a reclaimable resource (mirrors the runtime's accounting after a
    // `worker-start --terminal` takeover).
    for (const d of Object.values(state.dispatches ?? {})) {
      if (
        d.agentTerminal === reuseHandle &&
        d.id !== id &&
        ["active", "reclaimable"].includes(d.terminalState ?? "active")
      ) {
        d.terminalState = "released";
      }
    }
  }
  const effectiveWorktree = resolveWorktreeIdentity();
  const discoveryOnly = state.laneDiscoveryOnly === true;
  state.dispatches[id] = {
    id,
    task_id: taskId,
    run_id: runId,
    status: "dispatched",
    workerState: "supervised",
    terminalState: "active",
    retryOf: flag("--retry-of") ?? null,
    // The runtime always starts a worker on a terminal and reports its handle
    // in worker-list rows (`agentTerminalHandle`). A fresh start mints one; a
    // REUSE start takes over the given handle, so the new Dispatch's row
    // carries the SAME handle — the identity reuse tests assert with.
    agentTerminal: reuseHandle ?? `term_w${state.seq.dispatch}`,
    retryOf: flag("--retry-of") ?? null,
    launch: {
      agent: flag("--agent") ?? null,
      model: flag("--model") ?? null,
      effort: flag("--effort") ?? null,
      // The resolved workspace — the durable exact-selector evidence a
      // restarting viewer recovers a lane's identity from.
      worktree: discoveryOnly ? null : effectiveWorktree,
      terminal: reuseHandle ?? null,
      on: flag("--on") ?? null,
    },
    // Phase 6: `--on` records the execution environment on the Dispatch row —
    // worker-list reports such rows through projection.host and (as the real
    // runtime does) hides them from a plain local fleet listing.
    on: flag("--on") ?? null,
  };
  const t = state.tasks?.[taskId];
  if (t) {
    t.status = "dispatched";
    t.dispatch_id = id;
  }
  // The receipt echoes what actually ran — the "effective" half of the
  // requested/effective pair. A remote start echoes its environment.
  const outcome = { dispatchId: id, status: "ready" };
  if (!discoveryOnly && flag("--worktree")) outcome.worktree = effectiveWorktree;
  if (flag("--on")) outcome.on = flag("--on");
  if (flag("--agent")) outcome.agent = flag("--agent");
  return outcome;
}

/** Commit state + log, then answer with unparsable text (lost response). */
function finishLostResponse(text) {
  save();
  if (logPath) appendFileSync(logPath, JSON.stringify({ argv: args, cwd: process.cwd() }) + "\n");
  rmSync(lockDir, { recursive: true, force: true });
  process.stdout.write(text);
  process.exit(1);
}

function finish(envelope, exitCode = 0) {
  try {
    save();
  } finally {
    // The argv is logged only AFTER the state mutation is committed, so a test
    // that sees a call in the log can safely read its effects from the state.
    if (logPath) appendFileSync(logPath, JSON.stringify({ argv: args, cwd: process.cwd() }) + "\n");
    rmSync(lockDir, { recursive: true, force: true });
  }
  process.stdout.write(JSON.stringify(envelope));
  process.exit(exitCode);
}

const ok = (result) => finish({ ok: true, result });
const fail = (code, message) => finish({ ok: false, error: { code, message } }, 1);

/**
 * Phase 4: a response that was LOST after the state mutation may already have
 * committed — same save/log discipline as finish(), but the stdout is plain
 * text the caller cannot parse. This is exactly the ambiguity that
 * `request-show` + `--retry-request` exist to resolve.
 */
function finishGarbage() {
  try {
    save();
  } finally {
    if (logPath) appendFileSync(logPath, JSON.stringify({ argv: args, cwd: process.cwd() }) + "\n");
    rmSync(lockDir, { recursive: true, force: true });
  }
  process.stdout.write("error: worker hold marker present — no JSON this time\n");
  process.exit(1);
}

function flag(name) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

// --- plain-text surface -----------------------------------------------------

if (args[0] === "--version") {
  const version = state.version ?? "1.4.205";
  if (logPath) appendFileSync(logPath, JSON.stringify({ argv: args, cwd: process.cwd() }) + "\n");
  rmSync(lockDir, { recursive: true, force: true });
  process.stdout.write(`${version}\n`);
  process.exit(0);
}

// --- delivery helpers -------------------------------------------------------

function emptyDelivery(extra = {}) {
  return {
    runId: state.runId ?? null,
    dispatchId: null,
    deliveryId: null,
    messages: [],
    count: 0,
    replayed: false,
    acknowledged: null,
    timedOut: false,
    cancelled: false,
    connectionLost: false,
    ...extra,
  };
}

/** Orca flips pending tasks to ready once every dep is terminal. */
function deriveReadiness() {
  for (const t of Object.values(state.tasks ?? {})) {
    if (t.status !== "pending") continue;
    let deps = [];
    try {
      deps = JSON.parse(t.deps || "[]");
    } catch {
      deps = [];
    }
    const settled = deps.every((d) => ["completed", "failed"].includes(state.tasks?.[d]?.status));
    if (settled) t.status = "ready";
  }
}

function workerRows(runId, terminalStateFilter) {
  const includeRemote = args.includes("--include-remote");
  let rows = Object.values(state.dispatches ?? {})
    .filter((d) => !runId || d.run_id === runId)
    // Phase 6: a plain listing reads the LOCAL fleet only — remote rows
    // (started with --on) appear exclusively under --include-remote, exactly
    // the documented `worker-list` contract the coordinator reconciles with.
    .filter((d) => includeRemote || !d.on)
    .map((d) => ({
      dispatchId: d.id,
      taskId: d.task_id,
      runId: d.run_id,
      workerState: d.workerState ?? "supervised",
      dispatchStatus: d.status,
      agentTerminalHandle: d.agentTerminal ?? null,
      terminalState: d.terminalState ?? "active",
      projection: {
        id: d.id,
        dispatchId: d.id,
        taskId: d.task_id,
        runId: d.run_id,
        role: "worker",
        // The execution host that owns this worker's process/filesystem/
        // transcript facts: local rows say `local`; a --on row names the
        // environment it was started on.
        host: d.on ? { kind: "environment", id: d.on } : { kind: "local", id: "local" },
        outcome: ["completed", "failed", "stopped"].includes(d.status) ? d.status : null,
        liveness: {
          verdict: state.livenessOverride?.[d.id] ??
            (d.terminalState === "active" ? "live" : "exited"),
          reason: state.livenessReason?.[d.id] ?? (state.livenessOverride?.[d.id] ? "fleet contact lost" : d.terminalState),
        },
        stage: null,
        // Scripted per-dispatch recovery action (Phase 4 item 6 tests): the
        // coordinator must follow this argv only when non-empty and never
        // invent one when it is null/"none". Accept both the wire shape
        // ({ kind, argv }) and a bare argv array shorthand.
        nextAction: (() => {
          const raw = state.nextAction?.[d.id] ?? null;
          if (Array.isArray(raw)) return { kind: raw[1] ?? "prescribed", argv: raw };
          return raw;
        })(),
        attention: null,
        launch: d.launch ?? null,
      },
    }));
  if (terminalStateFilter) rows = rows.filter((r) => r.terminalState === terminalStateFilter);
  return rows;
}

// --- orchestration surface --------------------------------------------------

const [ns, verb] = args;

if (ns === "orchestration" && verb === "task-list") {
  deriveReadiness();
  ok({ tasks: Object.values(state.tasks ?? {}) });
} else if (ns === "orchestration" && verb === "gate-list") {
  ok({ gates: state.gates ?? [] });
} else if (ns === "orchestration" && verb === "gate-create") {
  const taskId = flag("--task");
  const question = flag("--question") ?? "";
  let options = ["approved", "rejected"];
  try {
    const parsed = JSON.parse(flag("--options") ?? "null");
    if (Array.isArray(parsed)) options = parsed.map(String);
  } catch {
    /* default options */
  }
  const t = state.tasks?.[taskId];
  if (!t) fail("task_not_found", `no task ${taskId}`);
  state.gates ??= [];
  // Durable idempotency: the viewer's stable marker + task binding is the
  // dedupe key. A repeated create for the same join returns the existing
  // gate verbatim — never a second one (duplicate-gate prevention).
  if (question.includes("[orca-dag:integration]")) {
    const existing = state.gates.find(
      (g) => g.task_id === taskId && String(g.question ?? "").includes("[orca-dag:integration]"),
    );
    if (existing) {
      ok({ gate: existing, deduped: true });
    }
  }
  state.seq ??= {};
  state.seq.gate = (state.seq.gate ?? 0) + 1;
  const gate = {
    id: `gate_${state.seq.gate}`,
    task_id: taskId,
    question,
    options,
    status: "pending",
    resolution: null,
  };
  state.gates.push(gate);
  // A gate BLOCKS its task — the runtime parks a ready task the moment the
  // gate exists, and it stays blocked until a resolution nudges it out.
  if (t.status === "ready") t.status = "blocked";
  ok({ gate });
} else if (ns === "orchestration" && verb === "task-update") {
  const t = state.tasks?.[flag("--id")];
  if (t) t.status = flag("--status");
  ok({});
} else if (ns === "orchestration" && verb === "run-use") {
  const runId = flag("--id");
  // Scripted startup failure (coordinator-lifecycle coverage): the Run
  // refuses a new coordinator binding AFTER the terminal was created, so
  // startCoordinator must fail AND close its provisional pane. Default-off —
  // no existing test sets it.
  if (state.runUseFail) fail("run_use_refused", "scripted: binding refused");
  ok({ run: state.runs?.[runId] ?? { id: runId, objective: "", legacy: 0 } });
} else if (ns === "orchestration" && verb === "run-show") {
  // Read-only: the Run record names its bound coordinator handle — the key a
  // restarting viewer uses to identify its own dead incarnation's terminal.
  const run = state.runs?.[flag("--id")];
  if (!run) fail("run_not_found", `no run ${flag("--id")}`);
  ok({
    run: {
      id: run.id,
      objective: run.objective ?? "",
      coordinator_handle: run.coordinator_handle ?? null,
      consumer_generation: run.consumer_generation ?? 1,
      legacy: run.legacy ?? 0,
      created_at: run.created_at ?? "",
      updated_at: run.updated_at ?? "",
    },
  });
} else if (ns === "orchestration" && verb === "worker-list") {
  const workers = workerRows(flag("--run"), flag("--terminal-state"));
  // The real worker-list receipt always carries an explicit page envelope,
  // even for a terminal one-page result. Keep the shared fixture honest so
  // callers can fail closed on missing pagination metadata without weakening
  // coordinator tests that do not exercise multiple pages.
  ok({ workers, page: { limit: 100, total: workers.length, hasMore: false, nextCursor: null } });
} else if (ns === "orchestration" && verb === "check") {
  const box = state.mailboxes?.[flag("--terminal")] ?? [];
  const ack = flag("--ack");
  if (ack) {
    const delivery = box.find((d) => d.deliveryId === ack);
    if (delivery) delivery.open = false;
    ok(emptyDelivery({ acknowledged: ack }));
  } else {
    const open = box.find((d) => d.open !== false);
    if (open) {
      open.seen = (open.seen ?? 0) + 1;
      ok(
        emptyDelivery({
          deliveryId: open.deliveryId,
          messages: open.messages,
          count: open.messages.length,
          replayed: open.seen > 1,
        }),
      );
    } else if (flag("--wait")) {
      // Block briefly (never the full requested timeout — tests want speed)
      // and answer with the timedOut batch the real CLI emits on an empty box.
      busySleep(Math.min(Number(flag("--timeout-ms") ?? 0), 20));
      ok(emptyDelivery({ timedOut: true }));
    } else {
      ok(emptyDelivery());
    }
  }
} else if (ns === "orchestration" && verb === "send") {
  const target = flag("--to") ?? "";
  const dispatchId = target.startsWith("dispatch:") ? target.slice("dispatch:".length) : null;
  const dispatch = dispatchId ? state.dispatches?.[dispatchId] : null;
  if (!dispatch || dispatch.status !== "dispatched") {
    fail("dispatch_not_active", `no active dispatch ${dispatchId ?? target}`);
  }
  state.seq ??= {};
  state.seq.message = (state.seq.message ?? 0) + 1;
  const sent = {
    id: `msg_sent_${state.seq.message}`,
    run_id: flag("--run"),
    task_id: flag("--task-id"),
    dispatch_id: flag("--dispatch-id"),
    to: target,
    from: flag("--from"),
    subject: flag("--subject"),
    body: flag("--body"),
    type: flag("--type"),
  };
  state.sentMessages ??= [];
  state.sentMessages.push(sent);
  ok({ message: sent });
} else if (ns === "orchestration" && verb === "reply") {
  const id = flag("--id");
  for (const box of Object.values(state.mailboxes ?? {})) {
    for (const d of box) {
      // A replied message is marked handled: it no longer replays.
      d.messages = d.messages.filter((m) => m.id !== id);
    }
  }
  ok({});
} else if (ns === "orchestration" && verb === "worker-start") {
  // Phase 4 idempotency: a repeated worker-start carrying an ALREADY-completed
  // retry-request id returns the recorded outcome verbatim — no second
  // Dispatch is minted. A `pending` record lands the start on the replay,
  // exactly once. This is the contract resolveAmbiguousStart relies on after
  // a lost response.
  const requestId = flag("--retry-request");
  state.requests ??= {};
  const rec = requestId ? state.requests[requestId] : undefined;
  if (rec?.state === "completed") {
    ok(rec.outcome);
  } else if (rec?.state === "pending") {
    const outcome = landSupervised(flag("--task"), flag("--run"));
    state.requests[requestId] = {
      state: "completed",
      interpretation: "worker-start landed on replay after a pending probe",
      outcome,
    };
    ok(outcome);
  } else if (state.workerStartFail) {
    const f = state.workerStartFail;
    if (f.receipt) {
      // Failed-before-ready WITH a receipt: the envelope carries error.data.receipt
      // (stage, residual resources, recovery commands) for the coordinator to retain.
      finish(
        {
          ok: false,
          error: { code: f.code ?? "start_failed", message: f.message ?? "start failed", data: { receipt: f.receipt } },
        },
        1,
      );
    }
    fail(f.code ?? "start_failed", f.message ?? "start failed");
  } else if (state.workerStartAmbiguous) {
    // Lost-response modes. "lost": the mutation LANDS (dispatch created, request
    // recorded completed) but the response is garbage — the caller must recover
    // via request-show + same-id replay. "pending": the response is lost BEFORE
    // any outcome is recorded — the probe answers pending, and the same-id
    // replay lands the start exactly once. "lost_noreceipt": nothing lands and
    // no request is recorded — probe says absent, start stays unresolved.
    const mode = state.workerStartAmbiguous;
    if (mode === "lost") {
      const outcome = landSupervised(flag("--task"), flag("--run"));
      if (requestId) {
        state.requests[requestId] = {
          state: "completed",
          interpretation: "worker-start completed; the first response was lost",
          outcome,
        };
      }
      finishLostResponse("<html>502 Bad Gateway</html>");
    }
    if (mode === "pending") {
      if (requestId) {
        state.requests[requestId] = {
          state: "pending",
          interpretation: "worker-start is still running or its outcome was not recorded",
        };
      }
      finishLostResponse("\x1b[31mconnection reset\x1b[0m");
    }
    // lost_noreceipt: die loudly WITHOUT mutating or recording anything.
    finishLostResponse("\x1b[31mterminated\x1b[0m");
  } else {
    const taskId = flag("--task");
    const t = state.tasks?.[taskId];
    if (!t) fail("task_not_found", `no task ${taskId}`);
    const outcome = landSupervised(taskId, flag("--run"));
    if (requestId) {
      state.requests[requestId] = {
        state: "completed",
        interpretation: "worker-start completed",
        outcome,
      };
    }
    ok(outcome);
  }
} else if (ns === "orchestration" && verb === "request-show") {
  // Read-only probe: did mutation under this retry-request id land?
  const requestId = flag("--request");
  const rec = state.requests?.[requestId];
  if (rec) ok({ requestId, state: rec.state, interpretation: rec.interpretation ?? null, outcome: rec.outcome ?? null });
  else ok({ requestId, state: "absent", interpretation: "no recorded request", outcome: null });
} else if (ns === "orchestration" && verb === "dispatch") {
  // Tracking dispatch (legacy lane): mints a real dispatch id, no worker.
  // Runtime 1.4.206 does NOT accept --retry-of on this legacy command; only
  // worker-start owns retry lineage. Keep the fake strict so the viewer cannot
  // accidentally route supervised-only flags into opencode's workaround.
  if (args.includes("--retry-of")) fail("invalid_argument", "Unknown flag --retry-of for command: orchestration dispatch");
  const taskId = flag("--task");
  const t = state.tasks?.[taskId];
  state.seq ??= {};
  state.seq.dispatch = (state.seq.dispatch ?? 0) + 1;
  const id = `ctx_t${state.seq.dispatch}`;
  state.dispatches ??= {};
  state.dispatches[id] = {
    id,
    task_id: taskId,
    run_id: flag("--run"),
    status: "dispatched",
    workerState: "unsupervised",
    terminalState: "active",
  };
  if (t) {
    t.status = "dispatched";
    t.dispatch_id = id;
  }
  ok({ dispatchId: id });
} else if (ns === "orchestration" && verb === "dispatch-show") {
  ok({
    preamble: `PREAMBLE for ${flag("--task")} — run: orca orchestration send --type worker_done`,
  });
} else if (ns === "orchestration" && verb === "worker-release") {
  const dispatchId = flag("--dispatch");
  // Echo the retry-request id back (the coordinator retains it across
  // release_pending retries so Orca replays the same request, not a new one).
  const requestId = flag("--retry-request");
  state.requests ??= {};
  const rec = requestId ? state.requests[requestId] : undefined;
  if (rec?.state === "completed") {
    // Same-id replay after a lost response: recorded outcome, no second release.
    ok(rec.outcome);
  }
  const d = state.dispatches?.[dispatchId];
  const mode = state.releaseMode?.[dispatchId] ?? "normal";
  state.seq ??= {};
  if (state.releaseLost?.[dispatchId]) {
    // The release lands but its response is lost — the caller must resolve the
    // ambiguity via request-show + same-id replay instead of release_unknown.
    if (d) d.terminalState = "released";
    const outcome = {
      dispatchId,
      requestId,
      state: "released",
      reason: null,
      processAction: "terminated",
      warning: null,
      archive: null,
    };
    state.requests[requestId] = {
      state: "completed",
      interpretation: "worker-release completed; the first response was lost",
      outcome,
    };
    finishLostResponse("error: release hold marker — no JSON this time\n");
  } else if (mode === "release_pending") {
    if (d) d.terminalState = "release_pending";
    ok({
      dispatchId,
      requestId,
      state: "release_pending",
      reason: "terminal is draining; retry release",
      processAction: "none",
      warning: null,
      archive: null,
    });
  } else if (mode === "release_unknown") {
    // The one release outcome that exits non-zero (runtime contract).
    if (d) d.terminalState = "release_unknown";
    fail("release_unknown", "terminal ownership could not be verified");
  } else {
    if (d) d.terminalState = "released";
    ok({
      dispatchId,
      requestId,
      state: "released",
      reason: null,
      processAction: "terminated",
      warning: null,
      archive: state.archives?.[dispatchId] ? { tail: state.archives[dispatchId] } : null,
    });
  }
} else if (ns === "orchestration" && verb === "worker-retain") {
  const dispatchId = flag("--dispatch");
  const d = state.dispatches?.[dispatchId];
  if (d) d.terminalState = "retained";
  ok({
    dispatchId,
    requestId: flag("--retry-request"),
    state: "retained",
    reason: null,
    processAction: "none",
    warning: null,
    archive: null,
  });
} else if (ns === "orchestration" && verb === "worker-read") {
  const dispatchId = flag("--dispatch");
  if (state.readFail?.[dispatchId]) fail("read_failed", "output source unavailable");
  // Phase 5: scripted source_changed ONCE per dispatch — a cursor pinned to a
  // replaced source is refused at the first read that carries one; the retry
  // (cursor dropped) succeeds. The deletion persists via fail()'s save().
  if (state.readCursorFail?.[dispatchId] && flag("--cursor")) {
    delete state.readCursorFail[dispatchId];
    fail("source_changed", "the output source changed since the cursor was issued");
  }
  ok({
    dispatchId,
    source: flag("--source") ?? "terminal",
    cursor: "cursor_1",
    terminal: { tail: [state.archives?.[dispatchId] ?? ""], truncated: false, limited: true },
    contentComplete: true,
    warnings: state.readWarnings?.[dispatchId] ?? [],
  });
} else if (ns === "orchestration" && verb === "worker-stop") {
  const dispatchId = flag("--dispatch");
  if (state.stopMode?.[dispatchId] === "fail") {
    fail("stop_failed", "worker contact lost; outcome unknown");
  }
  const d = state.dispatches?.[dispatchId];
  const alreadySettled = ["completed", "failed", "stopped"].includes(d?.status ?? "");
  if (d && !alreadySettled) {
    d.status = "stopped";
    // The real runtime parks an interrupted Task instead of making it ready
    // for an unqualified fresh Dispatch. Resuming must carry --retry-of.
    const task = state.tasks?.[d.task_id];
    if (task) {
      task.status = "blocked";
      delete task.dispatch_id;
      delete task.assignee_handle;
    }
  }
  ok({
    dispatchId,
    state: "stopped",
    alreadySettled,
    processAction: alreadySettled ? "none" : "terminated",
    warning: null,
  });
} else if (ns === "environment" && verb === "list") {
  ok({ environments: state.environments ?? [] });
} else if (ns === "environment" && verb === "show") {
  const id = flag("--environment");
  const env = (state.environments ?? []).find((e) => e.id === id);
  if (!env) fail("invalid_argument", `Unknown environment: ${id}`);
  ok({ environment: env });
} else if (ns === "repo" && verb === "list") {
  ok({ repos: state.repos ?? [] });
} else if (ns === "worktree" && verb === "list") {
  // hideWorktrees simulates a workspace Orca holds but this listing cannot
  // see (scoped/host-paged listings) — the identity-exists-but-unverifiable
  // case, which the coordinator must treat as REFUSAL, not replacement.
  ok({ worktrees: state.hideWorktrees ? [] : state.worktrees ?? [] });
} else if (ns === "worktree" && verb === "show") {
  // Exact-selector revalidation: only a row Orca positively holds answers;
  // an unknown selector is `selector_not_found` (the refusal evidence).
  const sel = flag("--worktree");
  const row = (state.worktrees ?? []).find((w) => w.id === sel || w.path === sel);
  if (!row) fail("selector_not_found", `no workspace matches ${sel}`);
  ok({ worktree: row });
} else if (ns === "project" && verb === "list") {
  ok({ projects: state.projects ?? [] });
} else if (ns === "terminal" && verb === "list") {
  ok({ terminals: state.terminals ?? [] });
} else if (ns === "terminal" && verb === "create") {
  state.seq ??= {};
  state.seq.terminal = (state.seq.terminal ?? 0) + 1;
  const handle = `term_f${state.seq.terminal}`;
  state.terminals ??= [];
  state.terminals.push({ handle, title: flag("--title") ?? null, connected: true });
  ok({ terminal: { handle } });
} else if (ns === "terminal" && verb === "close") {
  const handle = flag("--terminal");
  if ((state.closeFail ?? []).includes(handle)) {
    fail("close_failed", "terminal refused to close");
  }
  const t = (state.terminals ?? []).find((x) => x.handle === handle);
  if (t) t.connected = false;
  ok({});
} else if (ns === "terminal" && verb === "wait") {
  ok({ wait: { satisfied: true } });
} else if (ns === "terminal" && verb === "read") {
  ok({ terminal: { source: "screen", tail: ["model: GPT-6-Luna", "› Ask Codex to do anything"] } });
} else if (ns === "terminal" && verb === "send") {
  ok({});
} else {
  // Unknown surface: fail loudly rather than silently succeeding, so a drift
  // between the adapter and this double shows up as a test error, not a lie.
  fail("unknown_command", `fake-orca has no handler for: ${args.join(" ")}`);
}
