import { memo, useCallback, useState } from "react";
import { retryWorker } from "../api";
import type { RunAttempt, RunStatus } from "../types";

/**
 * Restart-recovery surface (Phase 4): what the coordinator found when it bound
 * the Run, what it still cannot verify, and the explicit retry action for
 * positively failed starts. Everything here is evidence-backed — receipts,
 * adoption summaries, Orca's literal prescribed nextAction — never a guess.
 *
 * The panel renders only when there is something recovery-shaped to show; a
 * boring healthy run renders nothing at all. It no longer polls the
 * coordinator status itself: App owns the single visibility-gated
 * /api/run-status poll and passes the snapshot down, so a backgrounded page
 * never hears a second caller of that endpoint.
 */
export const RecoveryPanel = memo(function RecoveryPanel({
  runId,
  status = null,
  onRetried,
  disabled = false,
  disabledReason,
}: {
  runId: string;
  /** The process-local run-status snapshot from App (see ExecControls). */
  status?: RunStatus | null;
  /** Called after a successful retry so the parent can refresh. */
  onRetried: () => void;
  /** Execution disabled (readiness gate) — inputs render but stay off. */
  disabled?: boolean;
  disabledReason?: string | null;
}) {
  const [busyId, setBusyId] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());

  // `/api/run-status` is process-local. Never render Run A's recovery while
  // the inspector is showing Run B.
  const scopedStatus = status?.runId === runId ? status : null;
  const recovery = scopedStatus?.recovery ?? null;
  const attempts = scopedStatus?.attempts ?? [];

  // Failed starts whose receipt is the release/retry evidence.
  const failedStarts = attempts.filter(
    (a) => a.settledVia === "start_failed" && a.startReceipt && !dismissed.has(a.taskId),
  );
  // Starts still carrying a durable retry-request id — the outcome is not
  // known yet and the id is what makes the eventual replay safe.
  const pendingStarts = attempts.filter((a) => a.startRequestId);
  // Orca prescribes a literal action (argv) — shown verbatim, never invented.
  const prescribed = attempts.filter((a) => (a.nextAction?.argv?.length ?? 0) > 0);
  const adoptedActive = attempts.filter((a) => a.adopted && !a.settled);
  const anythingToShow =
    (recovery !== null &&
      (recovery.activeAdopted.length > 0 ||
        recovery.settledAdopted.length > 0 ||
        recovery.unverifiable.length > 0 ||
        recovery.leftDecided > 0)) ||
    failedStarts.length > 0 ||
    pendingStarts.length > 0 ||
    prescribed.length > 0 ||
    adoptedActive.length > 0;

  const busy = useCallback((id: string) => busyId === id, [busyId]);

  async function retry(attempt: RunAttempt) {
    if (disabled || busy(attempt.taskId)) return;
    setBusyId(attempt.taskId);
    setErr(null);
    try {
      await retryWorker(attempt.startReceipt?.dispatchId ?? attempt.dispatchId ?? attempt.taskId);
      setDismissed((d) => new Set(d).add(attempt.taskId));
      onRetried();
    } catch (e) {
      setErr(String((e as Error).message ?? e));
    } finally {
      setBusyId(null);
    }
  }

  if (!runId || !anythingToShow) return null;

  return (
    <div className="gates inbox recovery" data-testid="recovery-panel">
      {recovery && recovery.activeAdopted.length > 0 && (
        <div className="gate inbox__item">
          <div className="gate__badge">Restart recovery</div>
          <div className="gate__question">
            Adopted {recovery.activeAdopted.length} running Dispatch
            {recovery.activeAdopted.length === 1 ? "" : "es"} from before the restart
          </div>
          <div className="inbox__body">
            {recovery.activeAdopted.map((id) => (
              <div key={id}>
                <code>{id}</code> — counted against concurrency, never double-placed
              </div>
            ))}
          </div>
        </div>
      )}

      {recovery && recovery.settledAdopted.length > 0 && (
        <div className="gate inbox__item">
          <div className="gate__badge">Restart recovery</div>
          <div className="gate__question">
            {recovery.settledAdopted.length} settled Dispatch
            {recovery.settledAdopted.length === 1 ? "" : "es"} awaiting cleanup
          </div>
          <div className="inbox__body">
            {recovery.settledAdopted.map((id) => (
              <div key={id}>
                <code>{id}</code> — released (or surfaced as debt) from Orca's own records
              </div>
            ))}
          </div>
        </div>
      )}

      {recovery && recovery.unverifiable.length > 0 && (
        <div className="gate inbox__item inbox__debt">
          <div className="gate__badge">Unverifiable Dispatch</div>
          <div className="gate__question">{recovery.unverifiable.length} Dispatch{recovery.unverifiable.length === 1 ? "" : "es"} without verifiable state</div>
          <div className="inbox__body">
            {recovery.unverifiable.map((id) => (
              <div key={id}>
                <code>{id}</code> — left untouched: missing/unverifiable status is never acted on
              </div>
            ))}
          </div>
        </div>
      )}

      {pendingStarts.map((a) => (
        <div key={`pending-${a.taskId}`} className="gate inbox__item">
          <div className="gate__badge">Start outcome pending</div>
          <div className="gate__question">
            <code>{a.taskId}</code> — worker-start response lost, resolving idempotently
          </div>
          <div className="inbox__body">
            Durable request id <code>{a.startRequestId}</code>: the coordinator asks Orca whether the
            start landed and replays the SAME id — never a second Dispatch.
          </div>
        </div>
      ))}

      {failedStarts.map((a) => (
        <div
          key={`failed-${a.taskId}`}
          className="gate inbox__item inbox__debt"
          data-operation-kind="recovery"
          data-operation-id={a.taskId}
          tabIndex={-1}
        >
          <div className="gate__badge">Start failed{a.startReceipt?.failedStage ? ` at ${a.startReceipt.failedStage}` : ""}</div>
          <div className="gate__question">
            <code>{a.taskId}</code>
            {a.startReceipt?.requestId ? ` · request ${a.startReceipt.requestId.slice(0, 8)}…` : ""}
          </div>
          {a.terminalDetail && <div className="inbox__body">{a.terminalDetail}</div>}
          {a.startReceipt && a.startReceipt.recoveryCommands.length > 0 && (
            <div className="inbox__body">
              Prescribed: {a.startReceipt.recoveryCommands.map((c) => <code key={c}>{c}</code>)}
            </div>
          )}
          <div className="gate__actions">
            <button
              className="btn btn--gate btn--ok"
              disabled={disabled || busy(a.taskId) || !status?.running}
              title={
                !status?.running
                  ? "Start the coordinator first — the retry needs its bound terminal"
                  : "Re-place this attempt with the same harness/model/placement (worker-start --retry-of)"
              }
              onClick={() => void retry(a)}
            >
              {busy(a.taskId) ? "…" : "Retry"}
            </button>
          </div>
        </div>
      ))}

      {prescribed.map((a) => (
        <div key={`next-${a.taskId}`} className="gate inbox__item">
          <div className="gate__badge">Orca prescribes</div>
          <div className="gate__question">
            <code>{a.taskId}</code> — {a.nextAction!.kind}
          </div>
          <div className="inbox__body">
            <code>{a.nextAction!.argv.join(" ")}</code>
          </div>
        </div>
      ))}

      {err && <div className="exec__err inbox__err">⚠️ {err}</div>}
      {disabled && disabledReason && <div className="exec__hint">🔒 {disabledReason}</div>}
    </div>
  );
});
