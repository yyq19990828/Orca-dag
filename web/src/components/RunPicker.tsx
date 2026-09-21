import { useCallback, useEffect, useState } from "react";
import { createRun, fetchRuns } from "../api";
import type { OrcaRun } from "../types";
import { DoodleSelect } from "./DoodleSelect";
import { useDecisionDialog } from "./DecisionDialog";

/**
 * Run selector.
 *
 * Since Orca 1.4.160 tasks are not global: every task belongs to exactly one
 * Run, and `task-list` refuses to answer without one. So the viewer always
 * shows the DAG *of a Run*, and this picker is how you choose which.
 *
 * A Run is a namespace, not a graph — nothing stops several unrelated DAGs
 * living in one Run. The orca-dag skill tells your agent to create a fresh Run
 * per plan, which is what makes "one Run = one DAG" hold in practice.
 */
export function RunPicker({
  runId,
  onPick,
  autoPick = true,
  disabled = false,
}: {
  runId: string;
  onPick: (id: string) => void;
  /** Gate for the newest-Run fallback. Off until the stored config has
   *  hydrated — auto-picking before that would overwrite the saved choice. */
  autoPick?: boolean;
  disabled?: boolean;
}) {
  const dialog = useDecisionDialog();
  const [runs, setRuns] = useState<OrcaRun[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const load = useCallback(async () => {
    try {
      const next = await fetchRuns();
      setRuns(next);
      setErr(null);
      // Nothing selected (or the stored Run is gone) → fall back to newest.
      if (autoPick && next.length > 0 && !next.some((r) => r.id === runId)) onPick(next[0].id);
    } catch (e) {
      setErr(String((e as Error).message ?? e));
    }
  }, [runId, onPick, autoPick]);

  useEffect(() => {
    load();
    const t = window.setInterval(load, 10_000);
    return () => window.clearInterval(t);
  }, [load]);

  async function onCreate() {
    const objective = await dialog.prompt({
      title: "Create a new Run",
      message: "A Run is an orchestration namespace for one task graph. Give this one a concise objective.",
      fieldLabel: "Objective",
      placeholder: "What should this Run accomplish?",
      confirmLabel: "Create Run",
      required: true,
    });
    if (!objective?.trim()) return;
    setCreating(true);
    setErr(null);
    try {
      const run = await createRun(objective.trim());
      onPick(run.id);
      await load();
    } catch (e) {
      setErr(String((e as Error).message ?? e));
    } finally {
      setCreating(false);
    }
  }

  const current = runs.find((r) => r.id === runId);

  return (
    <div className="runpick">
      <span className="exec__label">Run</span>
      <DoodleSelect
        value={runId}
        onChange={onPick}
        disabled={disabled || runs.length === 0}
        placeholder="(no Runs)"
        emptyText="(no Runs)"
        title={current ? `${current.id}\n${current.objective || "No objective"}` : "Pick a Run"}
        options={runs.map((r) => ({
          value: r.id,
          label: r.id,
          hint: r.objective || "No objective",
        }))}
      />
      <button
        className="btn btn--ghost"
        onClick={onCreate}
        disabled={disabled || creating}
        title="Create an empty Run in this workspace and select it"
      >
        ＋ Create Run
      </button>
      {err && <span className="exec__err">⚠️ {err}</span>}
    </div>
  );
}
