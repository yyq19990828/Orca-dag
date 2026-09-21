import { useState } from "react";
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
 */
export function GatePanel({
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
      {pending.map((g) => (
        <div key={g.id} className="gate">
          <div className="gate__badge">{disabled ? "Execution unavailable" : "Approval needed"}</div>
          <div className="gate__question">{g.question || "Resolve this decision gate"}</div>
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
      ))}
    </div>
  );
}
