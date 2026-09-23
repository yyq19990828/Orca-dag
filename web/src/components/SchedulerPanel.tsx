import { useT } from "../i18n";
import { STATUS_META, type DagNode, type DagResponse, type RunStatus } from "../types";

/**
 * Compact scheduler / ready-queue surface (Phase 4, operations epic O5) —
 * deliberately a SEPARATE panel from Activity/Chat: it answers "what would the
 * coordinator run next, and why is everything else waiting", not "what
 * happened". Every line is derived from Run-scoped task/gate facts the server
 * projected onto /api/dag (`readyWave` + `readiness`), plus this viewer
 * coordinator's occupancy from /api/run-status. Read-only by design; the
 * coordinator alone decides what to dispatch, and no order is implied among
 * equally ready Tasks (they render in id order, labeled as such).
 */

/** One line per waiting task: its label plus the first evidence-backed reason. */
function WaitingRow({ node, reason, onClick }: { node: DagNode; reason: string; onClick: () => void }) {
  const meta = STATUS_META[node.status];
  return (
    <li className="scheduler-panel__waiting-row">
      <button
        type="button"
        className="scheduler-panel__task-link"
        onClick={onClick}
        title={reason}
      >
        <span className="dot" style={{ background: meta.color }} />
        {node.label}
      </button>
      <span className="scheduler-panel__reason" title={reason}>
        {reason}
      </span>
    </li>
  );
}

export function SchedulerPanel({
  dag,
  runStatus,
  runId,
  onSelectTask,
}: {
  dag: DagResponse;
  runStatus: RunStatus | null;
  runId: string;
  onSelectTask: (id: string) => void;
}) {
  const t = useT();
  const nodesById = new Map(dag.nodes.map((n) => [n.id, n]));
  const readyWave = dag.readyWave ?? { taskIds: [], freeSlots: null };
  const readiness = dag.readiness ?? {};

  // Capacity is a viewer-coordinator fact: only meaningful while THIS viewer's
  // coordinator is running THIS Run. Anything else is unknown — never zero.
  const statusForRun = runStatus?.running && runStatus.runId === runId ? runStatus : null;
  const capacityKnown = statusForRun !== null;
  const busy = statusForRun?.busy ?? null;
  const max = statusForRun?.maxConcurrency ?? null;

  const readyNodes = readyWave.taskIds
    .map((id) => nodesById.get(id))
    .filter((n): n is DagNode => Boolean(n));
  const queuedNodes = readyNodes.filter((n) =>
    (readiness[n.id]?.codes ?? []).includes("waiting_for_capacity"),
  );

  // Waiting = every non-runnable node that still owes work (pending/blocked),
  // plus ready nodes parked on capacity. Finished and in-flight tasks are the
  // scheduler's business only when they block others, which the readiness
  // reasons of those others already express.
  const waitingNodes = dag.nodes
    .filter((n) => n.status === "pending" || n.status === "blocked")
    .map((n) => ({ node: n, reasons: readiness[n.id]?.reasons ?? [] }))
    .filter(({ reasons }) => reasons.length > 0);

  const nothingWaiting = readyNodes.length === 0 && waitingNodes.length === 0;

  return (
    <aside className="scheduler-panel" aria-label={t("scheduler.aria")}>
      <header className="scheduler-panel__head">
        <span className="scheduler-panel__title">{t("scheduler.title")}</span>
        <span className="scheduler-panel__wave" title={t("scheduler.waveTitle")}>
          {t("scheduler.waveReady", { n: readyNodes.length })}
        </span>
      </header>

      <p className="scheduler-panel__capacity" aria-live="polite">
        {capacityKnown && max !== null ? (
          <>
            {t("scheduler.workers")} <b>{busy}/{max}</b>
            {readyWave.freeSlots !== null && (
              <>
                {readyWave.freeSlots === 0
                  ? t("scheduler.noFreeSlot")
                  : readyWave.freeSlots === 1
                    ? t("scheduler.freeSlotOne", { n: readyWave.freeSlots })
                    : t("scheduler.freeSlotMany", { n: readyWave.freeSlots })}
              </>
            )}
          </>
        ) : (
          t("scheduler.capacityUnknown")
        )}
      </p>

      {readyNodes.length > 0 && (
        <section className="scheduler-panel__section">
          <h4 className="scheduler-panel__key">{t("scheduler.readyQueue")}</h4>
          <ul className="scheduler-panel__queue">
            {readyNodes.map((n) => (
              <li key={n.id}>
                <button
                  type="button"
                  className={`scheduler-panel__chip${queuedNodes.includes(n) ? " scheduler-panel__chip--queued" : ""}`}
                  onClick={() => onSelectTask(n.id)}
                  title={
                    queuedNodes.includes(n)
                      ? t("scheduler.chipQueuedTitle")
                      : t("scheduler.chipReadyTitle")
                  }
                >
                  <span className="dot" style={{ background: STATUS_META.ready.color }} />
                  {n.label}
                </button>
              </li>
            ))}
          </ul>
          <p className="scheduler-panel__hint">{t("scheduler.idOrderHint")}</p>
        </section>
      )}

      {waitingNodes.length > 0 && (
        <section className="scheduler-panel__section">
          <h4 className="scheduler-panel__key">{t("scheduler.waiting", { n: waitingNodes.length })}</h4>
          <ul className="scheduler-panel__waiting">
            {waitingNodes.slice(0, 7).map(({ node, reasons }) => (
              <WaitingRow
                key={node.id}
                node={node}
                reason={reasons[0]}
                onClick={() => onSelectTask(node.id)}
              />
            ))}
          </ul>
          {waitingNodes.length > 7 && (
            <p className="scheduler-panel__hint">
              {t("scheduler.moreWaiting", { n: waitingNodes.length - 7 })}
            </p>
          )}
        </section>
      )}

      {nothingWaiting && dag.nodes.length > 0 && (
        <p className="scheduler-panel__hint scheduler-panel__hint--alone">
          {t("scheduler.nothingWaiting")}
        </p>
      )}
    </aside>
  );
}
