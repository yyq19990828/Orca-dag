import { useCallback, useEffect, useRef, useState } from "react";
import { fetchRunById, fetchRunsPage } from "../api";
import { useT } from "../i18n";
import type { OrcaRun } from "../types";
import { usePageVisible } from "../visibility";
import { DoodleSelect } from "./DoodleSelect";

/**
 * Run selector — cursor-paginated with exact-ID navigation (Phase 7).
 *
 * Since Orca 1.4.160 tasks are not global: every task belongs to exactly one
 * Run, and `task-list` refuses to answer without one. So the viewer always
 * shows the DAG *of a Run*, and this picker is how you choose which.
 *
 * History loads as bounded cursor pages: the polled first page keeps the
 * newest Runs fresh, picker.loadOlder walks the opaque cursor, and an exact Run
 * ID can be opened directly even when pagination has not reached it.
 * Workspace ownership is checked server-side; exact lookup reports separate
 * ownership evidence and does not claim an unproven Run belongs here.
 *
 * A Run is a namespace, not a graph — nothing stops several unrelated DAGs
 * living in one Run. The orca-dag skill tells your agent to create a fresh
 * Run per plan, which is what makes "one Run = one DAG" hold in practice.
 */

const PAGE_SIZE = 25;

export interface RunListReadState {
  loaded: boolean;
  error: string | null;
  count?: number;
}

export function RunPicker({
  runId,
  onPick,
  autoPick = true,
  disabled = false,
  onReadStateChange,
}: {
  runId: string;
  onPick: (id: string) => void;
  /** Gate for the newest-Run fallback. Off until the stored config has
   *  hydrated — auto-picking before that would overwrite the saved choice. */
  autoPick?: boolean;
  disabled?: boolean;
  /** First-read failure is not an empty workspace; App uses this for recovery. */
  onReadStateChange?: (state: RunListReadState) => void;
}) {
  const t = useT();
  // Newest page (polled) + accumulated older pages + exact-ID pins, deduped
  // for display. The ref mirrors the combined list so the poll's newest-Run
  // fallback can see Runs that only exist on an older page or via a pin —
  // without it, picking a Run the first page has not reached would get
  // auto-switched away on the next poll.
  const [firstPage, setFirstPage] = useState<OrcaRun[]>([]);
  const [older, setOlder] = useState<OrcaRun[]>([]);
  const [pinned, setPinned] = useState<OrcaRun[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [listRead, setListRead] = useState<RunListReadState>({ loaded: false, error: null });
  const loadPending = useRef(false);
  const firstPageRef = useRef<OrcaRun[]>([]);
  const historyStarted = useRef(false);
  const [err, setErr] = useState<string | null>(null);
  const [ownership, setOwnership] = useState<Record<string, { owned: boolean; evidence: string }>>({});
  const [exactId, setExactId] = useState("");
  const [exactBusy, setExactBusy] = useState(false);
  const combined = dedupeById([...pinned, ...firstPage, ...older]);
  const combinedRef = useRef(combined);
  combinedRef.current = combined;

  useEffect(() => {
    onReadStateChange?.({ ...listRead, count: combined.length });
  }, [listRead, combined.length, onReadStateChange]);

  const load = useCallback(async () => {
    // Polling must not make every slow response obsolete. Keep one read in
    // flight so an 11-second request still lands with the 10-second timer.
    if (loadPending.current) return;
    loadPending.current = true;
    try {
      const page = await fetchRunsPage({ limit: PAGE_SIZE });
      const previous = firstPageRef.current;
      firstPageRef.current = page.runs;
      setOlder((current) => dedupeById([...previous, ...current]));
      setFirstPage(page.runs);
      if (!historyStarted.current) setNextCursor(page.nextCursor);
      setErr(null);
      setListRead((previous) => previous.loaded && !previous.error ? previous : { loaded: true, error: null });
    } catch (e) {
      const error = String((e as Error).message ?? e);
      setListRead((previous) => previous.error === error ? previous : { ...previous, error });
    } finally {
      loadPending.current = false;
    }
  }, []);

  // A saved selection may be outside the bounded first page. Preserve it and
  // resolve it explicitly rather than replacing it with a newer Run.
  useEffect(() => {
    if (autoPick && !runId && combined.length > 0) onPick(combined[0].id);
  }, [autoPick, combined, runId, onPick]);

  useEffect(() => {
    if (!autoPick || !runId) return;
    let alive = true;
    void fetchRunById(runId).then(({ run, workspace }) => {
      if (!alive) return;
      setPinned((previous) => dedupeById([run, ...previous]));
      setOwnership((previous) => ({ ...previous, [run.id]: workspace }));
    }).catch((error) => {
      if (!alive) return;
      const msg = String((error as Error).message ?? error);
      setErr(msg);
      const code = (error as { code?: string })?.code;
      const status = (error as { status?: number })?.status;
      const isMissing = code === "run_not_found" || status === 404 || status === 409 || /not_found|not found/i.test(msg);
      if (isMissing) {
        const available = combinedRef.current;
        if (available.length > 0) {
          const fallback = available.find((r) => r.id !== runId);
          onPick(fallback ? fallback.id : "");
        } else {
          onPick("");
        }
      }
    });
    return () => { alive = false; };
  }, [autoPick, runId, onPick]);

  // Interval paused while the tab is hidden (Orca never throttles
  // background timers, so the 10s list poll would run forever unseen). The
  // effect re-run on becoming visible doubles as the immediate refresh: one
  // load, then the interval re-arms.
  const visible = usePageVisible();
  useEffect(() => {
    if (!visible) return;
    load();
    const t = window.setInterval(load, 10_000);
    return () => window.clearInterval(t);
  }, [load, visible]);

  async function loadOlder() {
    if (!nextCursor || loadingMore) return;
    historyStarted.current = true;
    setLoadingMore(true);
    setErr(null);
    try {
      const page = await fetchRunsPage({ cursor: nextCursor, limit: PAGE_SIZE });
      setOlder((prev) => dedupeById([...prev, ...page.runs]));
      setNextCursor(page.nextCursor);
    } catch (e) {
      setErr(String((e as Error).message ?? e));
    } finally {
      setLoadingMore(false);
    }
  }

  async function openExact(close: () => void) {
    const id = exactId.trim();
    if (!id || exactBusy) return;
    setExactBusy(true);
    setErr(null);
    try {
      const { run, workspace } = await fetchRunById(id);
      setOwnership((prev) => ({ ...prev, [run.id]: workspace }));
      setPinned((prev) => dedupeById([run, ...prev]));
      setExactId("");
      onPick(run.id);
      close();
    } catch (e) {
      setErr(String((e as Error).message ?? e));
    } finally {
      setExactBusy(false);
    }
  }


  const current = combined.find((r) => r.id === runId);
  const placeholder = runId || (listRead.error
    ? t("picker.unavailable")
    : !listRead.loaded ? t("picker.loadingRuns") : t("picker.noRuns"));
  const displayedError = err ?? listRead.error;

  return (
    <div className="runpick">
      <DoodleSelect
        size="sm"
        value={runId}
        onChange={onPick}
        disabled={disabled}
        placeholder={placeholder}
        loading={!listRead.loaded && !listRead.error}
        emptyText={placeholder}
        ariaLabel={runId ? `${t("picker.pickRun")}: ${current?.objective?.trim() || runId}` : t("picker.pickRun")}
        panelActions={(close) => (
          <div className="runpick__actions" role="group" aria-label={t("picker.actionsAria")}>
            {nextCursor && (
              <button type="button" className="btn btn--ghost runpick__more" onClick={loadOlder} disabled={disabled || loadingMore} title={t("picker.loadOlderTitle")}>
                {loadingMore ? t("picker.loading") : t("picker.loadOlder")}
              </button>
            )}
            <label className="runpick__exact-label" htmlFor="runpick-exact-id">{t("picker.exactLabel")}</label>
            <span className="runpick__exact">
              <input id="runpick-exact-id" className="runpick__exact-input" value={exactId} placeholder="run_…" spellCheck={false}
                onChange={(event) => setExactId(event.target.value)}
                onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); void openExact(close); } }} />
              <button type="button" className="btn btn--ghost" onClick={() => void openExact(close)} disabled={disabled || exactBusy || !exactId.trim()} title={t("picker.exactTitle")}>
                {exactBusy ? "…" : t("picker.go")}
              </button>
            </span>
          </div>
        )}
        title={
          current
            ? `${current.id}\n${current.objective || t("picker.noObjective")}`
            : t("picker.pickRun")
        }
        options={combined.map((r) => ({
          value: r.id,
          // The objective is what helps distinguish Runs at a glance. Keep
          // the durable id in the option hint and trigger title for precise
          // navigation without spending the whole top row on an opaque id.
          label: r.objective?.trim() || r.id,
          hint: ownership[r.id] && !ownership[r.id].owned
            ? `${r.id} · ${t("picker.unprovenOwnership")} · ${ownership[r.id].evidence}`
            : r.id,
        }))}
      />
      {current && ownership[current.id] && !ownership[current.id].owned && (
        <span className="runpick__error" role="status">{t("picker.unprovenOwnership")}: {ownership[current.id].evidence}</span>
      )}
      {displayedError && (
        <span className="runpick__error" role="status" title={displayedError}>
          {err ? `⚠ ${err}` : t("picker.readFailed")}
        </span>
      )}
    </div>
  );
}

/** Drop duplicate ids, keeping the first occurrence (newest page wins). */
function dedupeById(runs: OrcaRun[]): OrcaRun[] {
  const seen = new Set<string>();
  const out: OrcaRun[] = [];
  for (const r of runs) {
    if (seen.has(r.id)) continue;
    seen.add(r.id);
    out.push(r);
  }
  return out;
}
