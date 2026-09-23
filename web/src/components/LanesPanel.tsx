import { memo, useCallback, useEffect, useState } from "react";
import { fetchWorktreeLanes, openLaneChanges, removeLaneWorktree } from "../api";
import { t, useT, type TranslationKey } from "../i18n";
import { useDecisionDialog } from "./DecisionDialog";
import { usePageVisible } from "../visibility";
import type { WorktreeLaneRuntimeView, WorktreeLanesResponse } from "../types";

/**
 * Workspace lanes — the runtime half (Phase 7).
 *
 * The launch half (seed placement, membership) lives in the node editor and
 * the config file; this panel renders what the COORDINATOR actually did with
 * it, straight from `GET /api/worktree-lanes`. Every field is Orca evidence:
 * a null selector/path means "not positively recovered yet" and is rendered
 * as unknown — never reconstructed from a name, branch, or path.
 *
 * Actions mirror the PRD's honesty rules:
 *  - changed files / diffs open through Orca in the PROVEN workspace only;
 *  - removal requires `settled` ownership, an explicit typed confirmation
 *    (the worktree's own id/name token), and runs only as `orca worktree rm`.
 * An `unverifiable` or `removal_blocked` lane shows its warnings and
 * authorizes nothing destructive.
 */

/** state -> key. A state the runtime adds later falls back to lane.state.other. */
const LANE_STATE_KEY: Record<string, TranslationKey> = {
  planned: "lane.state.planned",
  creating: "lane.state.creating",
  active: "lane.state.active",
  integration_required: "lane.state.integration_required",
  settled: "lane.state.settled",
  unverifiable: "lane.state.unverifiable",
  removal_blocked: "lane.state.removal_blocked",
  removed: "lane.state.removed",
};

/**
 * Short human explanation per lane state. The state TOKEN itself is always
 * rendered verbatim (it is Orca's own word); only this hint is translated,
 * and an unknown state says so rather than guessing.
 */
function stateHint(state: string): string {
  return t(LANE_STATE_KEY[state] ?? "lane.state.other");
}

export const LanesPanel = memo(function LanesPanel({
  runId,
  active = true,
  disabled = false,
  disabledReason,
}: {
  runId: string;
  /** Pause the lane poll while Operations is out of view. */
  active?: boolean;
  /** Execution-disabled gate (readiness): mutations hide behind the reason. */
  disabled?: boolean;
  disabledReason?: string | null;
}) {
  const dialog = useDecisionDialog();
  const t = useT();
  const [lanes, setLanes] = useState<WorktreeLaneRuntimeView[]>([]);
  const [loadedFor, setLoadedFor] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [notes, setNotes] = useState<Map<string, string>>(new Map());
  const visible = usePageVisible();

  useEffect(() => {
    // A Run switch must not show the previous Run's lanes for one poll
    // interval — drop stale rows before the first scoped response lands.
    setLanes([]);
    setErr(null);
    setLoadedFor(null);
    setNotes(new Map());
  }, [runId]);

  useEffect(() => {
    if (!active || !visible || !runId) return;
    let alive = true;
    const load = async () => {
      try {
        const page: WorktreeLanesResponse = await fetchWorktreeLanes(runId);
        if (!alive) return;
        // Never paint another Run's lanes over this one.
        if (page.runId && page.runId !== runId) return;
        setLanes(page.lanes ?? []);
        setLoadedFor(runId);
        setErr(null);
      } catch (e) {
        if (alive) {
          setLoadedFor(runId);
          setErr(String((e as Error).message ?? e));
        }
      }
    };
    void load();
    const t = window.setInterval(load, 4000);
    return () => {
      alive = false;
      window.clearInterval(t);
    };
  }, [active, runId, visible]);

  const review = useCallback(
    async (laneId: string, mode: "files" | "diff") => {
      setBusyId(laneId);
      setErr(null);
      try {
        const receipt = await openLaneChanges(laneId, mode);
        setNotes((prev) => {
          const next = new Map(prev);
          next.set(
            laneId,
            t(mode === "files" ? "lane.openedFiles" : "lane.openedDiff") +
              (receipt.workspace ? t("lane.openedIn", { workspace: receipt.workspace }) : "") +
              (receipt.note ? t("lane.openedNote", { note: receipt.note }) : ""),
          );
          return next;
        });
      } catch (e) {
        setErr(String((e as Error).message ?? e));
      } finally {
        setBusyId(null);
      }
    },
    // t is a stable module function; the note snapshots the language of the click.
    [t],
  );

  const remove = useCallback(
    async (lane: WorktreeLaneRuntimeView) => {
      // The confirmation token is the worktree's OWN identity — the id when
      // Orca reported one, else its display name/path tail. The server
      // compares the typed string before it acts.
      const token = lane.worktreeId ?? lane.path?.split("/").filter(Boolean).pop() ?? lane.laneId;
      const typed = await dialog.prompt({
        title: t("lane.removeTitle"),
        message: lane.path
          ? t("lane.removeMessageWithPath", { path: lane.path, token })
          : t("lane.removeMessageNoPath", { token }),
        fieldLabel: t("lane.removeFieldLabel", { token }),
        placeholder: token,
        confirmLabel: t("lane.removeConfirm"),
        tone: "danger",
        required: true,
      });
      if (typed !== token) {
        if (typed !== null) {
          setErr(t("lane.confirmMismatch"));
        }
        return;
      }
      setBusyId(lane.laneId);
      setErr(null);
      try {
        const receipt = await removeLaneWorktree(lane.laneId, typed);
        setNotes((prev) => {
          const next = new Map(prev);
          next.set(
            lane.laneId,
            t("lane.receipt", { state: receipt.state ?? t("lane.receiptUnknownState") }) +
              (receipt.reason ? t("lane.receiptReason", { reason: receipt.reason }) : "") +
              (receipt.requestId
                ? t("lane.receiptRequest", { id: receipt.requestId.slice(0, 8) })
                : ""),
          );
          return next;
        });
      } catch (e) {
        setErr(String((e as Error).message ?? e));
      } finally {
        setBusyId(null);
      }
    },
    [dialog, t],
  );

  if (!runId || loadedFor !== runId) return null;

  return (
    <div className="gates lanes" data-testid="lanes-panel">
      <div className="gate inbox__item">
        <div className="gate__badge">{t("lane.badge")}</div>
        {err && <div className="exec__err inbox__err">⚠️ {err}</div>}
        {lanes.length === 0 && !err && (
          <div className="inbox__body">{t("lane.none")}</div>
        )}
        {lanes.map((lane) => {
          const removable = lane.state === "settled";
          const reviewable = Boolean(lane.selector || lane.path) && lane.state !== "removed";
          const note = notes.get(lane.laneId) ?? null;
          return (
            <div key={lane.laneId} className="lanes__row" data-state={lane.state}>
              <div className="lanes__head">
                <span className="lanes__state" data-state={lane.state} title={stateHint(lane.state)}>
                  {lane.state}
                </span>
                <code className="lanes__id">{lane.laneId}</code>
                <span className="inbox__meta">
                  {lane.taskIds.length === 1
                    ? t("lane.taskCountOne", { n: lane.taskIds.length })
                    : t("lane.taskCountMany", { n: lane.taskIds.length })}
                  {lane.activeDispatchIds.length === 1
                    ? t("lane.activeDispatchOne", { n: lane.activeDispatchIds.length })
                    : lane.activeDispatchIds.length > 1
                      ? t("lane.activeDispatchMany", { n: lane.activeDispatchIds.length })
                      : ""}
                  {lane.source ? t("lane.via", { source: lane.source }) : ""}
                </span>
              </div>
              <div className="lanes__facts">
                <span>
                  {t("lane.selectorLabel")}{" "}
                  {lane.selector ? <code>{lane.selector}</code> : <i>{t("lane.selectorUnknown")}</i>}
                </span>
                {lane.worktreeId && (
                  <span>
                    {t("lane.worktreeLabel")} <code>{lane.worktreeId}</code>
                  </span>
                )}
                {lane.path && (
                  <span>
                    {t("lane.pathLabel")} <code>{lane.path}</code>
                  </span>
                )}
                {lane.branch && (
                  <span>{t("lane.branchLabel", { branch: lane.branch.replace(/^refs\/heads\//, "") })}</span>
                )}
                {lane.head && (
                  <span>
                    {t("lane.headLabel")} <code>{lane.head.slice(0, 12)}</code>
                  </span>
                )}
                {lane.creationDispatchId && (
                  <span>
                    {t("lane.createdByDispatch")} <code>{lane.creationDispatchId}</code>
                  </span>
                )}
              </div>
              <p className="inbox__meta lanes__hint">{stateHint(lane.state)}</p>
              {lane.warnings.map((w, i) => (
                <div key={i} className="inbox__body lanes__warning">
                  ⚠ {w}
                </div>
              ))}
              {note && <div className="inbox__body workers__decision">{note}</div>}
              <div className="gate__actions">
                <button
                  className="btn btn--gate"
                  disabled={!reviewable || disabled || busyId === lane.laneId}
                  title={
                    reviewable
                      ? t("lane.openChangedFilesTitle")
                      : t("lane.needsWorkspace")
                  }
                  onClick={() => void review(lane.laneId, "files")}
                >
                  {t("lane.changedFiles")}
                </button>
                <button
                  className="btn btn--gate"
                  disabled={!reviewable || disabled || busyId === lane.laneId}
                  title={
                    reviewable
                      ? t("lane.openDiffTitle")
                      : t("lane.needsWorkspace")
                  }
                  onClick={() => void review(lane.laneId, "diff")}
                >
                  {t("lane.diff")}
                </button>
                <button
                  className="btn btn--gate btn--danger"
                  disabled={!removable || disabled || busyId === lane.laneId}
                  title={
                    removable
                      ? t("lane.removeWorktreeTitle")
                      : t("lane.removeNeedsSettled", { state: lane.state })
                  }
                  onClick={() => void remove(lane)}
                >
                  {t("lane.removeWorktree")}
                </button>
              </div>
              {disabled && disabledReason && <div className="exec__hint">🔒 {disabledReason}</div>}
            </div>
          );
        })}
      </div>
    </div>
  );
});
