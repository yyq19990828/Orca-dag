import { memo, useState } from "react";
import { resolveGate } from "../api";
import type { Gate } from "../types";
import { useDecisionDialog } from "./DecisionDialog";

/**
 * Pending decision gates. Resolving one is a Run-scoped mutation, so the server
 * has to borrow a coordinator terminal for it — see `asCoordinator` there.
 *
 * `disabled` is the readiness gate (Phase 2): on a runtime the viewer can't
 * execute against, resolutions stay visibly off with the server's reason
 * instead of failing with a confusing CLI error.
 *
 * Integration gates (Phase 7) get their own honest explanation: a task whose
 * dependencies crossed workspace lanes stays blocked here until a HUMAN
 * asserts the branches were integrated. Resolving `integrated` records that
 * human assertion — it is never presented as a verified Git merge, and
 * Orca-dag performs no automatic merge, rebase, cherry-pick, commit, push,
 * or branch deletion.
 */

/** The single resolution the coordinator's integration gates offer. */
const INTEGRATION_OPTIONS = new Set(["integrated"]);

function isIntegrationGate(g: Gate): boolean {
  return g.options.length > 0 && g.options.every((o) => INTEGRATION_OPTIONS.has(o.trim().toLowerCase()));
}
export const GatePanel = memo(function GatePanel({
  gates,
  runId,
  onResolved,
  disabled = false,
  disabledReason,
}: {
  gates: Gate[];
  runId: string;
  onResolved: () => void;
  /** Execution disabled (readiness gate) — shows the reason, blocks resolving. */
  disabled?: boolean;
  disabledReason?: string | null;
}) {
  const dialog = useDecisionDialog();
  const [busyId, setBusyId] = useState<string | null>(null);
  const pending = gates.filter((g) => g.status === "pending" || g.status === "open" || !g.resolution);

  if (pending.length === 0 || !runId) return null;

  async function resolve(gate: Gate, resolution: string) {
    if (disabled || busyId === gate.id) return;
    setBusyId(gate.id);
    try {
      await resolveGate(gate.id, resolution, runId);
      onResolved();
    } catch (err) {
      await dialog.alert({
        title: "Gate resolution failed",
        message: String((err as Error).message ?? err),
        tone: "danger",
      });
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="gates">
      {pending.map((g) => {
        const integration = isIntegrationGate(g);
        return (
          <div
            key={g.id}
            className={`gate${integration ? " gate--integration" : ""}`}
            data-operation-kind="gate"
            data-operation-id={g.id}
            tabIndex={-1}
          >
            <div className="gate__badge">
              {disabled
                ? "Execution unavailable"
                : integration
                  ? "Integration checkpoint — human assertion required"
                  : "Approval needed"}
            </div>
            <div className="gate__question">{g.question || "Resolve this decision gate"}</div>
            {integration && (
              <p className="gate__explain">
                The dependencies of this task ran in separate workspace lanes. Dependency completion
                alone is not evidence of a merge: branches from different workspaces must be
                integrated by a person before this task may start. Resolving{" "}
                <code>integrated</code> records YOUR assertion that the integration happened — the
                viewer never merges, rebases, cherry-picks, commits, pushes, or deletes branches
                itself.
              </p>
            )}
            <div className="gate__actions">
              {g.options.map((opt) => (
                <button
                  key={opt}
                  className={`btn btn--gate ${/reject|deny|no/i.test(opt) ? "btn--danger" : "btn--ok"}`}
                  disabled={disabled || busyId === g.id}
                  title={disabled ? disabledReason ?? "Execution is unavailable" : undefined}
                  onClick={() => resolve(g, opt)}
                >
                  {opt}
                </button>
              ))}
            </div>
            {disabled && disabledReason && <div className="exec__hint">🔒 {disabledReason}</div>}
          </div>
        );
      })}
    </div>
  );
});
