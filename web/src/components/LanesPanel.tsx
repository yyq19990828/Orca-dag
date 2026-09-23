import { memo, useCallback, useEffect, useState } from "react";
import { fetchWorktreeLanes, openLaneChanges, removeLaneWorktree } from "../api";
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

/** Short human explanation per lane state. Unknown states stay verbatim. */
function stateHint(state: WorktreeLaneRuntimeView["state"]): string {
  switch (state) {
    case "planned":
      return "The lane is configured but no worker has created or opened its workspace yet.";
    case "creating":
      return "A worker-start is creating the lane's worktree right now.";
    case "active":
      return "The lane's workspace is positively identified and a worker is using it.";
    case "integration_required":
      return "Work in this lane finished, but a downstream task in another lane waits on a human integration gate.";
    case "settled":
      return "Every task in the lane settled; the workspace is retained until you explicitly remove it.";
    case "unverifiable":
      return "The lane's workspace identity could not be positively recovered — nothing will be guessed or recreated.";
    case "removal_blocked":
      return "The worktree cannot be removed right now — check the warnings for the blocking evidence.";
    case "removed":
      return "The worktree was removed through Orca (`orca worktree rm`).";
    default:
      return "The runtime reported this state verbatim.";
  }
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
            `Opened ${mode} through Orca${receipt.workspace ? ` in ${receipt.workspace}` : ""}${
              receipt.note ? ` — ${receipt.note}` : ""
            }`,
          );
          return next;
        });
      } catch (e) {
        setErr(String((e as Error).message ?? e));
      } finally {
        setBusyId(null);
      }
    },
    [],
  );

  const remove = useCallback(
    async (lane: WorktreeLaneRuntimeView) => {
      // The confirmation token is the worktree's OWN identity — the id when
      // Orca reported one, else its display name/path tail. The server
      // compares the typed string before it acts.
      const token = lane.worktreeId ?? lane.path?.split("/").filter(Boolean).pop() ?? lane.laneId;
      const typed = await dialog.prompt({
        title: "Remove this worktree?",
        message:
          `This runs \`orca worktree rm\` on the lane's workspace` +
          (lane.path ? `:\n\n${lane.path}` : ".") +
          `\n\nUncommitted work is lost and this cannot be undone. Type ` +
          `${token} to confirm.`,
        fieldLabel: `Type ${token}`,
        placeholder: token,
        confirmLabel: "Remove worktree",
        tone: "danger",
        required: true,
      });
      if (typed !== token) {
        if (typed !== null) {
          setErr("The confirmation text did not match — nothing was removed.");
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
            `Removal receipt: ${receipt.state ?? "unknown"}${
              receipt.reason ? ` — ${receipt.reason}` : ""
            }${receipt.requestId ? ` · request ${receipt.requestId.slice(0, 8)}…` : ""}`,
          );
          return next;
        });
      } catch (e) {
        setErr(String((e as Error).message ?? e));
      } finally {
        setBusyId(null);
      }
    },
    [dialog],
  );

  if (!runId || loadedFor !== runId) return null;

  return (
    <div className="gates lanes" data-testid="lanes-panel">
      <div className="gate inbox__item">
        <div className="gate__badge">Workspace lanes · shared serial workspaces</div>
        {err && <div className="exec__err inbox__err">⚠️ {err}</div>}
        {lanes.length === 0 && !err && (
          <div className="inbox__body">No lanes are configured for this Run.</div>
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
                  {lane.taskIds.length} task{lane.taskIds.length === 1 ? "" : "s"}
                  {lane.activeDispatchIds.length > 0
                    ? ` · ${lane.activeDispatchIds.length} active dispatch${lane.activeDispatchIds.length === 1 ? "" : "es"}`
                    : ""}
                  {lane.source ? ` · via ${lane.source}` : ""}
                </span>
              </div>
              <div className="lanes__facts">
                <span>
                  Selector:{" "}
                  {lane.selector ? <code>{lane.selector}</code> : <i>unknown (no positive evidence yet)</i>}
                </span>
                {lane.worktreeId && (
                  <span>
                    Worktree: <code>{lane.worktreeId}</code>
                  </span>
                )}
                {lane.path && (
                  <span>
                    Path: <code>{lane.path}</code>
                  </span>
                )}
                {lane.branch && <span>Branch: {lane.branch.replace(/^refs\/heads\//, "")}</span>}
                {lane.head && (
                  <span>
                    Head: <code>{lane.head.slice(0, 12)}</code>
                  </span>
                )}
                {lane.creationDispatchId && (
                  <span>
                    Created by dispatch <code>{lane.creationDispatchId}</code>
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
                      ? "Open the workspace's changed files through Orca"
                      : "Needs a positively identified workspace"
                  }
                  onClick={() => void review(lane.laneId, "files")}
                >
                  Changed files
                </button>
                <button
                  className="btn btn--gate"
                  disabled={!reviewable || disabled || busyId === lane.laneId}
                  title={
                    reviewable
                      ? "Open the workspace's diff through Orca"
                      : "Needs a positively identified workspace"
                  }
                  onClick={() => void review(lane.laneId, "diff")}
                >
                  Diff
                </button>
                <button
                  className="btn btn--gate btn--danger"
                  disabled={!removable || disabled || busyId === lane.laneId}
                  title={
                    removable
                      ? "Remove the worktree through orca worktree rm (asks for typed confirmation)"
                      : `Removal needs settled ownership — this lane is ${lane.state}`
                  }
                  onClick={() => void remove(lane)}
                >
                  Remove worktree…
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
