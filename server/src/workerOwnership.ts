import { showWorkerDetail, type OrcaTask, type OrcaWorkerRow, type WorkerDetailView } from "./orca";

export interface WorkerCreatorEvidence {
  checkedAt: number;
  /** Undefined is unreadable/older protocol, not a root-worker assertion. */
  creatorId: string | null | undefined;
}

export interface WorkerOwnershipSnapshot {
  heldTaskIds: Set<string>;
  heldDispatchIds: Set<string>;
  /** Helpers whose exact creator has positively settled; custody returns to the Run. */
  handedBack: OrcaWorkerRow[];
}

const CREATOR_RECHECK_MS = 10_000;
const SETTLED_DISPATCH: Readonly<Record<string, boolean>> = {
  completed: true, succeeded: true, failed: true, stopped: true, abandoned: true, circuit_broken: true,
};

/**
 * Same-Run helpers report to their active creator, not to this viewer (Orca
 * 1.4.238+). parent_id is only a hint to inspect, never ownership evidence.
 * worker-list omits creatorDispatchId even on 1.4.241: read the exact Dispatch
 * once, cache only immutable lineage, and judge its creator from fresh fleet
 * state. A missing creator is uncertainty, not permission to take its helper.
 */
export async function readWorkerOwnership(
  runId: string,
  tasks: OrcaTask[],
  rows: OrcaWorkerRow[],
  cache: Map<string, WorkerCreatorEvidence>,
): Promise<WorkerOwnershipSnapshot> {
  const result: WorkerOwnershipSnapshot = {
    heldTaskIds: new Set(), heldDispatchIds: new Set(), handedBack: [],
  };
  const taskById = new Map(tasks.map(task => [task.id, task]));
  const rowById = new Map(rows.map(row => [row.dispatchId, row]));
  const details = new Map<string, Promise<WorkerDetailView | null>>();
  const detail = (id: string): Promise<WorkerDetailView | null> => {
    let pending = details.get(id);
    if (!pending) {
      pending = showWorkerDetail(id).catch(() => null);
      details.set(id, pending);
    }
    return pending;
  };
  // Retention decides terminal custody, not whether a helper still reports to
  // an active creator. Only positively settled, already-decided history drops out.
  const relevant = rows.filter(row => row.runId === runId &&
    !(SETTLED_DISPATCH[row.dispatchStatus] === true && ["released", "retained"].includes(row.terminalState)));
  const relevantIds = new Set(relevant.map(row => row.dispatchId));
  for (const id of cache.keys()) if (!relevantIds.has(id)) cache.delete(id);

  // Reads are needed only for hierarchical workers with unresolved custody,
  // not every historical Dispatch on every three-second coordinator tick.
  for (const row of relevant) {
    const task = taskById.get(row.taskId);
    if (!task?.parent_id && !row.projection?.parent && !cache.has(row.dispatchId)) continue;
    let evidence = cache.get(row.dispatchId);
    if (!evidence || evidence.creatorId === undefined && Date.now() - evidence.checkedAt >= CREATOR_RECHECK_MS) {
      const exact = await detail(row.dispatchId);
      const matches = exact?.dispatch?.id === row.dispatchId &&
        exact.dispatch.runId === runId && exact.dispatch.taskId === row.taskId;
      evidence = {
        checkedAt: Date.now(),
        creatorId: matches
          ? exact.dispatch!.creatorDispatchId ?? (exact.dispatch!.creatorDispatchId === null || exact.dispatch!.depth === 1 ? null : undefined)
          : undefined,
      };
      cache.set(row.dispatchId, evidence);
    }
    if (evidence.creatorId === null) continue;
    let settled = false;
    if (evidence.creatorId) {
      const creator = rowById.get(evidence.creatorId);
      if (creator?.runId === runId) {
        settled = SETTLED_DISPATCH[creator.dispatchStatus] === true;
      } else {
        const exact = await detail(evidence.creatorId);
        settled = exact?.dispatch?.id === evidence.creatorId && exact.dispatch.runId === runId &&
          SETTLED_DISPATCH[exact.dispatch.status ?? ""] === true;
      }
    }
    if (settled) result.handedBack.push(row);
    else {
      result.heldTaskIds.add(row.taskId);
      result.heldDispatchIds.add(row.dispatchId);
    }
  }
  return result;
}
