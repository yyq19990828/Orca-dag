import { memo, useMemo, useState } from "react";
import { t, useLang, useT } from "../i18n";
import type { DagResponse, Gate, RunAttempt, RunStatus, WorkerRowView } from "../types";
import "./operations-attention.css";

export type OperationFocus = {
  kind: "gate" | "recovery" | "worker";
  /** Gate id, recovery task id, or worker Dispatch id. */
  id: string;
};

export interface OperationsAttentionProps {
  runId: string;
  /** Pass null until this Run's DAG snapshot is available. */
  dag: DagResponse | null;
  /** Pass null until the process-local status for this Run is available. */
  status: RunStatus | null;
  /** Pass null while the durable, Run-scoped worker list is unavailable. */
  workers: readonly WorkerRowView[] | null;
  onFocus: (target: OperationFocus) => void;
}

export interface ActionableOperationSnapshots {
  runId: string;
  dag: DagResponse | null;
  status: RunStatus | null;
  workers: readonly WorkerRowView[] | null;
}

const DECIDED_TERMINAL_STATES = new Set([
  "released",
  "retained",
  "closed",
  "reused",
  "not_needed",
]);

function statusForRun(status: RunStatus | null, runId: string): RunStatus | null {
  return status?.runId === runId ? status : null;
}

function dagForRun(dag: DagResponse | null, runId: string): DagResponse | null {
  return dag?.runId === runId ? dag : null;
}

function pendingGates(gates: readonly Gate[]): Gate[] {
  // Keep eligibility in sync with GatePanel: an unset resolution is still
  // pending evidence, even if an older Orca snapshot uses another status word.
  return gates.filter((gate) =>
    gate.status === "pending" || gate.status === "open" || !gate.resolution,
  );
}

function verifiedFailedStarts(attempts: readonly RunAttempt[]): RunAttempt[] {
  // A failed start is actionable only when Orca settled the attempt through
  // start_failed and the retained receipt positively says the start failed.
  return attempts.filter(
    (attempt) => attempt.settledVia === "start_failed" && attempt.startReceipt?.ok === false,
  );
}

function attemptForWorker(
  row: WorkerRowView,
  attempts: readonly RunAttempt[],
): RunAttempt | undefined {
  return (
    (row.dispatchId
      ? attempts.find((attempt) => attempt.dispatchId === row.dispatchId)
      : undefined) ?? attempts.find((attempt) => attempt.taskId === row.taskId)
  );
}

function workerNeedsDecision(row: WorkerRowView, attempt: RunAttempt | undefined): boolean {
  // Match WorkerPanel's positive evidence: Orca's release_pending accounting,
  // or this Run's own settled attempt with no completed terminal decision.
  return (
    row.terminalState === "release_pending" ||
    (attempt?.settled === true && !DECIDED_TERMINAL_STATES.has(attempt.terminalDecision))
  );
}

type AttentionItem = {
  key: string;
  kind: OperationFocus["kind"];
  id: string;
  tone: "gate" | "recovery" | "worker";
  eyebrow: string;
  title: string;
  detail: string;
  action: string;
};

function makeItems({ runId, dag, status, workers }: ActionableOperationSnapshots): AttentionItem[] {
  if (!runId) return [];
  const scopedDag = dagForRun(dag, runId);
  const scopedStatus = statusForRun(status, runId);
  const items: AttentionItem[] = [];
  const labels = new Map(scopedDag?.nodes.map((node) => [node.id, node.label]));

  for (const gate of pendingGates(scopedDag?.gates ?? [])) {
    items.push({
      key: `gate:${gate.id}`,
      kind: "gate",
      id: gate.id,
      tone: "gate",
      eyebrow: t("attention.decision"),
      title: gate.question || t("gate.resolveFallback"),
      detail: gate.taskId
        ? t("attention.taskDetail", { id: labels.get(gate.taskId) || gate.taskId })
        : t("attention.gateDetail", { id: gate.id }),
      action: t("attention.reviewGate"),
    });
  }

  for (const attempt of verifiedFailedStarts(scopedStatus?.attempts ?? [])) {
    // RecoveryPanel treats taskId as the stable operation key for Retry.
    // Deduplicate stale repeated attempt receipts for the same task in this compact list.
    if (items.some((item) => item.kind === "recovery" && item.id === attempt.taskId)) continue;
    items.push({
      key: `recovery:${attempt.taskId}`,
      kind: "recovery",
      id: attempt.taskId,
      tone: "recovery",
      eyebrow: t("attention.startFailed"),
      title: labels.get(attempt.taskId) || attempt.taskId,
      detail: attempt.terminalDetail || t("attention.startFailedDetail"),
      action: t("attention.reviewRetry"),
    });
  }

  for (const row of workers ?? []) {
    if (row.runId !== runId) continue;
    const attempt = scopedStatus ? attemptForWorker(row, scopedStatus.attempts) : undefined;
    const decisionOwed = workerNeedsDecision(row, attempt);
    const attention = row.projection?.attention;
    if (!decisionOwed && !attention?.requiresAction) continue;
    // A task can have more than one historical Dispatch. The panel's durable
    // decision control is row-scoped; keep each Dispatch actionable once.
    const dispatchKey = row.dispatchId || row.taskId;
    items.push({
      key: `worker:${dispatchKey}`,
      kind: "worker",
      id: dispatchKey,
      tone: "worker",
      eyebrow: decisionOwed ? t("attention.decisionOwed") : t("attention.workerNeedsAttention"),
      title: labels.get(row.taskId) || row.taskId,
      detail: decisionOwed
        ? row.terminalState === "release_pending"
          ? t("attention.decisionPending")
          : t("attention.decisionMarked", {
              state: attempt?.terminalDecision ?? t("attention.pending"),
            })
        : t("attention.flagged", {
            categories: attention?.categories.join(", ") || t("attention.thisWorker"),
          }),
      action: t("attention.reviewWorker"),
    });
  }

  return items;
}

/**
 * Return an exact actionable count for a Run, preserving unknown as null.
 * Empty arrays mean a successfully loaded zero; null or a snapshot for another
 * Run means the total is not yet known. The gate/retry/worker rules mirror
 * their existing panels and never invoke mutations.
 */
export function countActionableOperations(
  snapshots: ActionableOperationSnapshots,
): number | null {
  const { runId, dag, status, workers } = snapshots;
  if (
    !runId ||
    !dagForRun(dag, runId) ||
    !statusForRun(status, runId) ||
    workers === null
  ) {
    return null;
  }
  return makeItems(snapshots).length;
}

/** The number already proved by available snapshots, even while others load. */
export function countKnownActionableOperations(
  snapshots: ActionableOperationSnapshots,
): number {
  return makeItems(snapshots).length;
}

export const OperationsAttention = memo(function OperationsAttention({
  runId,
  dag,
  status,
  workers,
  onFocus,
}: OperationsAttentionProps) {
  const t = useT();
  // makeItems() builds translated labels with the non-reactive `t` (t's
  // identity is stable by design), so `lang` is what has to invalidate this
  // memo — a memo keyed only on data would keep the pre-switch wording.
  const lang = useLang();
  const [expanded, setExpanded] = useState(false);
  const snapshots = { runId, dag, status, workers };
  const items = useMemo(() => makeItems(snapshots), [dag, lang, runId, status, workers]);
  const count = countActionableOperations(snapshots);
  const visibleItems = expanded ? items : items.slice(0, 4);
  const hiddenCount = items.length - visibleItems.length;

  if (!runId) return null;

  return (
    <section className="ops-attention" aria-labelledby="ops-attention-title">
      <header className="ops-attention__header">
        <div className="ops-attention__heading">
          <h2 id="ops-attention-title">{t("attention.title")}</h2>
          <p>
            {count === null
              ? items.length > 0
                ? items.length === 1
                  ? t("attention.atLeastOne", { n: items.length })
                  : t("attention.atLeastMany", { n: items.length })
                : t("attention.unknownTotal")
              : count === 0
                ? t("attention.none")
                : count === 1
                  ? t("attention.countOne", { n: count })
                  : t("attention.countMany", { n: count })}
          </p>
        </div>
        <span
          className={`ops-attention__count${count === 0 ? " ops-attention__count--clear" : ""}`}
          aria-label={count === null
            ? items.length > 0
              ? t("attention.atLeastAria", { n: items.length })
              : t("attention.unknownAria")
            : t("attention.countAria", { n: count })}
        >
          {count === null ? items.length > 0 ? `${items.length}+` : "—" : count}
        </span>
      </header>

      {items.length > 0 ? (
        <ul className="ops-attention__list">
          {visibleItems.map((item) => (
            <li className={`ops-attention__item ops-attention__item--${item.tone}`} key={item.key}>
              <div className="ops-attention__copy">
                <span className="ops-attention__item-label">{item.eyebrow}</span>
                <strong title={item.title}>{item.title}</strong>
                <span className="ops-attention__detail" title={item.detail}>
                  {item.detail}
                </span>
              </div>
              <button
                className="ops-attention__action"
                type="button"
                onClick={() => onFocus({ kind: item.kind, id: item.id })}
                aria-label={`${item.action}: ${item.title}`}
              >
                {item.action}
                <span aria-hidden="true"> →</span>
              </button>
            </li>
          ))}
          {items.length > 4 && (
            <li className="ops-attention__more">
              <button
                className="ops-attention__more-button"
                type="button"
                aria-expanded={expanded}
                onClick={() => setExpanded((value) => !value)}
              >
                {expanded ? t("attention.showFewer") : t("attention.showMore", { n: hiddenCount })}
              </button>
            </li>
          )}
        </ul>
      ) : count === null ? (
        <div className="ops-attention__empty ops-attention__empty--unknown" role="status">
          {t("attention.emptyUnknown")}
        </div>
      ) : (
        <div className="ops-attention__empty">
          <span aria-hidden="true">✓</span> {t("attention.emptyClean")}
        </div>
      )}
    </section>
  );
});
