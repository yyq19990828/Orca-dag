import { useEffect, useRef, useState } from "react";
import { fetchLocalWorkspaces, removeCleanupWorktree } from "../api";
import { useT } from "../i18n";
import { useDecisionDialog } from "./DecisionDialog";
import type { OrcaWorktreeView } from "../types";


/** On-demand evidence only; the server rechecks custody before every removal. */
export function CleanupPanel({ runId, disabled }: { runId: string; disabled: boolean }) {
  const t = useT();
  const dialog = useDecisionDialog();
  const generation = useRef(0);
  const [candidates, setCandidates] = useState<OrcaWorktreeView[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [receipts, setReceipts] = useState<Record<string, string>>({});
  const [deleteBranches, setDeleteBranches] = useState<Record<string, boolean>>({});
  useEffect(() => {
    generation.current++;
    setCandidates(null); setError(null); setReceipts({}); setDeleteBranches({}); setBusy(false);
    return () => { generation.current++; };
  }, [runId]);
  async function review() {
    const seq = ++generation.current;
    setBusy(true); setError(null);
    try {
      const result = await fetchLocalWorkspaces(true);
      if (seq === generation.current) setCandidates(result);
    } catch (e) {
      if (seq === generation.current) setError(String((e as Error).message ?? e));
    } finally { if (seq === generation.current) setBusy(false); }
  }
  async function remove(worktree: OrcaWorktreeView) {
    const seq = generation.current;
    const choice = Boolean(deleteBranches[worktree.id]);
    const typed = await dialog.prompt({ title: t("cleanup.confirmTitle"), message: t("cleanup.confirmMessage", { id: worktree.id, branch: worktree.branch ?? t("worker.unknown"), choice: t(choice ? "cleanup.deleteMerged" : "cleanup.preserve") }), fieldLabel: t("cleanup.confirmField"), required: true, confirmLabel: t("cleanup.remove"), tone: "danger" });
    if (seq !== generation.current || typed !== worktree.id) return;
    setBusy(true); setError(null);
    try {
      const result = await removeCleanupWorktree(runId, worktree.id, choice);
      if (seq === generation.current) {
        setReceipts((old) => ({ ...old, [worktree.id]: JSON.stringify(result) }));
        setCandidates((old) => old?.filter((item) => item.id !== worktree.id) ?? null);
      }
    } catch (e) { if (seq === generation.current) setError(String((e as Error).message ?? e)); }
    finally { if (seq === generation.current) setBusy(false); }
  }
  return <section className="gates cleanup" aria-label={t("cleanup.title")}>
    <h3>{t("cleanup.title")}</h3>
    <p className="inbox__meta">{t("cleanup.intro")}</p>
    <button type="button" className="btn btn--gate" disabled={!runId || busy} onClick={() => void review()}>{t("cleanup.review")}</button>
    {error && <div role="status" className="exec__err">{error}</div>}
    {candidates && candidates.length === 0 && <p>{t("cleanup.empty")}</p>}
    {candidates?.map((worktree) => <div className="gate" key={worktree.id}>
      <div><code className="cleanup__identity">{worktree.id}</code></div>
      <div className="inbox__meta">{t("cleanup.branch")}: {worktree.branch ?? t("worker.unknown")} · {worktree.isMainWorktree === true ? t("cleanup.main") : worktree.isMainWorktree === null ? t("cleanup.unknown") : t("cleanup.recheck")}</div>
      <label><input type="checkbox" checked={Boolean(deleteBranches[worktree.id])} disabled={disabled || busy || worktree.isMainWorktree !== false} onChange={(e) => setDeleteBranches((old) => ({ ...old, [worktree.id]: e.target.checked }))} /> {t("cleanup.deleteMerged")}</label>
      <div><button type="button" className="btn btn--gate" disabled={disabled || busy || worktree.isMainWorktree !== false} onClick={() => void remove(worktree)}>{t("cleanup.remove")}</button></div>
    </div>)}
    {Object.entries(receipts).map(([id, receipt]) => <div key={id} role="status" className="inbox__body"><strong>{t("cleanup.receipt")}</strong> <code className="cleanup__identity">{id}</code><pre className="cleanup__receipt">{receipt}</pre></div>)}
  </section>;
}
