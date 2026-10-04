import type { Gate, OrcaMessage, OrcaRun, OrcaTask, OrcaWorkerRow } from "./orca";

/**
 * Selected-Run ownership and health (operations epic O2, Phase 1).
 *
 * Everything here is a READ model: it never mutates Orca and never claims
 * authority. Orca's Run record (`run-show`) is the sole evidence for who is
 * bound; this viewer's process-local coordinator state (`coordinatorStatus()`)
 * is the sole evidence for what THIS viewer currently owns. The two are
 * combined by `evaluateRunOwnership`, a pure function, so every ownership
 * branch is testable without spawning a CLI.
 *
 * Deliberate non-goals (plan §26):
 *  - we never call `terminal list` to judge a bound coordinator "stale".
 *    Ownership comes from the Run record alone; a handle missing from a
 *    local terminal list proves nothing (remote/federated terminals are
 *    invisible to it).
 *  - we never infer "empty" from a failed read. A read that failed leaves
 *    its count `null` and adds an evidence warning instead.
 */

/** The five ownership states the plan requires the viewer to distinguish. */
export type RunOwnershipState =
  | "viewer_coordinator"
  | "viewer_coordinator_other_run"
  | "external_coordinator"
  | "unbound"
  | "unverifiable";

/** What this viewer's process-local coordinator currently reports. */
export interface ViewerCoordinatorFacts {
  running: boolean;
  /** The Run the live loop bound itself to (null when idle). */
  runId: string | null;
  /** The Orca terminal handle the live loop borrowed (null when idle). */
  coordinatorHandle: string | null;
}

export interface RunOwnershipView {
  state: RunOwnershipState;
  /** Readable English explanation; safe to render verbatim (no raw JSON). */
  detail: string;
}

/** The Run-record fields the ownership + health projections read. */
export type RunRecordEvidence = Pick<OrcaRun, "id" | "coordinator_handle" | "consumer_generation">;

/**
 * Classify who owns `run` from the Run record + this viewer's coordinator
 * facts. Precedence: unreadable record → unverifiable; no bound handle →
 * unbound; bound handle === our live loop's handle → viewer-owned (split by
 * which Run the loop believes it is serving — a mismatch is surfaced, never
 * papered over); anything else is an external coordinator.
 */
export function evaluateRunOwnership(
  run: RunRecordEvidence | null,
  viewer: ViewerCoordinatorFacts,
): RunOwnershipView {
  if (!run) {
    return {
      state: "unverifiable",
      detail:
        "The Run record could not be read (unknown id, or the run-show read failed). " +
        "Ownership is unknown; mutation stays unavailable.",
    };
  }
  const bound = typeof run.coordinator_handle === "string" ? run.coordinator_handle.trim() : "";
  if (!bound) {
    return {
      state: "unbound",
      detail:
        "No coordinator is bound to this Run. This viewer may start it; the start will " +
        "bind its own coordinator terminal.",
    };
  }
  const ourHandle = viewer.coordinatorHandle?.trim() ?? "";
  if (viewer.running && ourHandle && bound === ourHandle) {
    if (viewer.runId === run.id) {
      return {
        state: "viewer_coordinator",
        detail: "This viewer's live coordinator is bound to this Run and owns its scheduling.",
      };
    }
    return {
      state: "viewer_coordinator_other_run",
      detail: `This viewer's coordinator terminal is bound here, but the loop reports Run ${viewer.runId ?? "unknown"} — the two disagree, which needs attention before starting anything.`,
    };
  }
  const elsewhere =
    viewer.running && viewer.runId && viewer.runId !== run.id
      ? " This viewer's coordinator is currently bound to another Run."
      : "";
  // Orca 1.4.218+ lets a native chat coordinate a Run under its own session
  // id. The viewer may observe it, but the Run button will fence that chat.
  const chat = bound.startsWith("orca_session_id:") || bound.startsWith("session:");
  return {
    state: "external_coordinator",
    detail:
      `${chat ? "Native chat" : "Terminal"} ${bound} is bound as this Run's coordinator. ` +
      `This viewer cannot mutate the Run until it takes over, which would fence that ` +
      `${chat ? "chat" : "terminal"}.` + elsewhere,
  };
}

/** One evidence-backed health warning. `code` is a stable machine key. */
export interface RunHealthWarning {
  code:
    | "messages_without_tasks"
    | "dispatched_task_without_worker"
    | "reclaimable_workers"
    | "pending_gates"
    | "evidence_incomplete"
    | "foreign_workspace";
  severity: "info" | "warning";
  message: string;
}

/** Per-source evidence: `null` rows mean the read FAILED (never "empty"). */
export interface RunHealthEvidence {
  tasks: OrcaTask[] | null;
  taskError: string | null;
  gates: Gate[] | null;
  gateError: string | null;
  messages: OrcaMessage[] | null;
  messageError: string | null;
  workers: OrcaWorkerRow[] | null;
  workerError: string | null;
}

/** The RunHealthView contract from the epic's data additions. */
export interface RunHealthView {
  runId: string;
  ownership: RunOwnershipState;
  ownershipDetail: string;
  /** The coordinator handle the Run record reports, verbatim (null = none). */
  coordinatorHandle: string | null;
  /** The Run's fencing generation, verbatim (null = record unavailable). */
  consumerGeneration: number | null;
  viewerCoordinator: ViewerCoordinatorFacts;
  counts: {
    tasks: number | null;
    messages: number | null;
    workers: number | null;
    gates: number | null;
    pendingGates: number | null;
  };
  /** False when any read failed — counts are then unknown, not zero. */
  evidenceComplete: boolean;
  warnings: RunHealthWarning[];
}

/** Bounded id list for warning messages (readable, never a raw dump). */
function summarizeIds(ids: string[], max = 3): string {
  if (ids.length <= max) return ids.join(", ");
  return `${ids.slice(0, max).join(", ")} +${ids.length - max} more`;
}

/** The workspace-creator marker listWorkspaceRuns derives Run scope from. */
function taskFromWorkspace(task: OrcaTask, workspaceDir: string): boolean {
  const incarnation = task.created_by_process_incarnation;
  return typeof incarnation === "string" && incarnation.includes(`::${workspaceDir}@@`);
}

/**
 * Combine one Run's reads into the health projection. Every warning below
 * fires only on positive evidence; reads that failed gate their checks off
 * and say so, because "couldn't read workers" must never read as "no
 * workers" (epic invariant: never infer from missing data).
 */
export function buildRunHealth(opts: {
  runId: string;
  /** `run-show` result; null when the record could not be read. */
  run: RunRecordEvidence | null;
  viewer: ViewerCoordinatorFacts;
  evidence: RunHealthEvidence;
  /** Workspace dir — enables the foreign-workspace task-creator check. */
  workspaceDir?: string;
}): RunHealthView {
  const { runId, run, viewer, evidence } = opts;
  const ownership = evaluateRunOwnership(run, viewer);
  const warnings: RunHealthWarning[] = [];

  // --- messages without tasks: an "empty" Run that actually has history ----
  if (evidence.tasks !== null && evidence.messages !== null && evidence.tasks.length === 0 && evidence.messages.length > 0) {
    warnings.push({
      code: "messages_without_tasks",
      severity: "info",
      message:
        `This Run has ${evidence.messages.length} message${evidence.messages.length === 1 ? "" : "s"} but no tasks — ` +
        `an empty graph with retained history, not a rendering failure.`,
    });
  }

  // --- dispatched task with no fleet worker: a possibly-dead attempt --------
  if (evidence.tasks !== null && evidence.workers !== null) {
    const dispatched = evidence.tasks.filter((t) => t.status === "dispatched");
    const orphaned = dispatched.filter((task) => {
      return !evidence.workers!.some(
        (row) =>
          (task.dispatch_id ? row.dispatchId === task.dispatch_id : false) ||
          row.taskId === task.id,
      );
    });
    if (orphaned.length > 0) {
      warnings.push({
        code: "dispatched_task_without_worker",
        severity: "warning",
        message:
          `${orphaned.length} dispatched task${orphaned.length === 1 ? "" : "s"} have no worker in the fleet ` +
          `accounting (${summarizeIds(orphaned.map((t) => t.id))}) — the attempt may have died without settling.`,
      });
    }
  }

  // --- reclaimable worker terminals: a previous start left them behind -----
  if (evidence.workers !== null) {
    const reclaimable = evidence.workers.filter((row) => row.terminalState === "reclaimable");
    if (reclaimable.length > 0) {
      warnings.push({
        code: "reclaimable_workers",
        severity: "warning",
        message:
          `${reclaimable.length} worker terminal${reclaimable.length === 1 ? " is" : "s are"} reclaimable — ` +
          `left behind by an earlier start; release or reclaim them to settle ownership.`,
      });
    }
  }

  // --- pending gates: human decisions blocking work -------------------------
  if (evidence.gates !== null) {
    const pending = evidence.gates.filter((g) => g.status === "pending");
    if (pending.length > 0) {
      warnings.push({
        code: "pending_gates",
        severity: "info",
        message:
          `${pending.length} decision gate${pending.length === 1 ? " is" : "s are"} waiting for a human resolution; ` +
          `the gated tasks stay blocked until then.`,
      });
    }
  }

  // --- evidence gaps: name exactly which reads failed ----------------------
  const failures = [
    evidence.taskError && "tasks",
    evidence.gateError && "gates",
    evidence.messageError && "messages",
    evidence.workerError && "workers",
  ].filter((x): x is string => Boolean(x));
  if (failures.length > 0) {
    warnings.push({
      code: "evidence_incomplete",
      severity: "warning",
      message:
        `The ${failures.join(" and ")} read${failures.length === 1 ? "" : "s"} failed, so those counts are ` +
        `unknown (shown as “—”) rather than zero.`,
    });
  }

  // --- workspace leakage: tasks created from a different workspace ---------
  if (opts.workspaceDir && evidence.tasks !== null && evidence.tasks.length > 0) {
    const anyLocal = evidence.tasks.some((t) => taskFromWorkspace(t, opts.workspaceDir!));
    if (!anyLocal) {
      warnings.push({
        code: "foreign_workspace",
        severity: "warning",
        message:
          "This Run's tasks were created from a different workspace; it is visible only because it was " +
          "selected or persisted explicitly.",
      });
    }
  }

  return {
    runId,
    ownership: ownership.state,
    ownershipDetail: ownership.detail,
    coordinatorHandle: run && typeof run.coordinator_handle === "string" && run.coordinator_handle.trim() ? run.coordinator_handle : null,
    consumerGeneration: run && typeof run.consumer_generation === "number" ? run.consumer_generation : null,
    viewerCoordinator: {
      running: viewer.running,
      runId: viewer.runId,
      coordinatorHandle: viewer.coordinatorHandle,
    },
    counts: {
      tasks: evidence.tasks ? evidence.tasks.length : null,
      messages: evidence.messages ? evidence.messages.length : null,
      workers: evidence.workers ? evidence.workers.length : null,
      gates: evidence.gates ? evidence.gates.length : null,
      pendingGates: evidence.gates ? evidence.gates.filter((g) => g.status === "pending").length : null,
    },
    evidenceComplete:
      evidence.tasks !== null &&
      evidence.gates !== null &&
      evidence.messages !== null &&
      evidence.workers !== null,
    warnings,
  };
}
