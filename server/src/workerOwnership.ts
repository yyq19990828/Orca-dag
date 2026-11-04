import { showWorkerDetail, type OrcaTask, type OrcaWorkerRow, type WorkerDetailView } from "./orca";

export interface WorkerCreatorEvidence {
  checkedAt: number;
  /** Undefined is unreadable/older protocol, not a root-worker assertion. */
  creatorId: string | null | undefined;
  /** This read positively identified a settled, disposed historical Dispatch. */
  historical?: boolean;
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
  for (const evidence of cache.values()) evidence.historical = false;

  // Inspect exact Dispatches, not Task parentage: an unparented Task can still
  // have a creator, and an unreadable creator must remain under custody.
  for (const row of relevant) {
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
    // Older runtimes omit creator metadata even for ordinary root workers.
    // Retain the existing conservative hint for unreadable hierarchical rows.
    if (evidence.creatorId === undefined && !taskById.get(row.taskId)?.parent_id && !row.projection?.parent) continue;
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
  // Follow only exact same-Run creator links through disposed history. These
  // identities are lineage evidence, never active attempts or occupancy.
  const visited = new Set<string>();
  const pending = relevant.map(row => cache.get(row.dispatchId)?.creatorId).filter((id): id is string => !!id);
  while (pending.length) {
    const id = pending.pop()!;
    if (visited.has(id)) continue;
    visited.add(id);
    const row = rowById.get(id);
    if (row && (row.runId !== runId || SETTLED_DISPATCH[row.dispatchStatus] !== true ||
        !["released", "retained"].includes(row.terminalState))) continue;
    const exact = await detail(id);
    if (exact?.dispatch?.id !== id || exact.dispatch.runId !== runId ||
        (row && exact.dispatch.taskId !== row.taskId)) continue;
    if (!row && (SETTLED_DISPATCH[exact.dispatch.status ?? ""] !== true ||
        !["released", "retained"].includes(exact.fleet?.terminalState ?? ""))) continue;
    const creatorId = exact.dispatch.creatorDispatchId ??
      (exact.dispatch.creatorDispatchId === null || exact.dispatch.depth === 1 ? null : undefined);
    cache.set(id, { checkedAt: Date.now(), creatorId, historical: true });
    if (creatorId) pending.push(creatorId);
  }
  const keep = new Set([...relevant.map(row => row.dispatchId), ...visited]);
  for (const id of cache.keys()) if (!keep.has(id)) cache.delete(id);
  return result;
}
