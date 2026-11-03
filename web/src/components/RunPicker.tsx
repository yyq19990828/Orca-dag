import { useCallback, useEffect, useRef, useState } from "react";
import { createRun, fetchRunById, fetchRunsPage } from "../api";
import { useT } from "../i18n";
import { useReadiness } from "../harness";
import type { OrcaRun } from "../types";
import { usePageVisible } from "../visibility";
import { DoodleSelect } from "./DoodleSelect";
import { useDecisionDialog } from "./DecisionDialog";

/**
 * Run selector — cursor-paginated with exact-ID navigation (Phase 7).
 *
 * Since Orca 1.4.160 tasks are not global: every task belongs to exactly one
 * Run, and `task-list` refuses to answer without one. So the viewer always
 * shows the DAG *of a Run*, and this picker is how you choose which.
 *
 * History loads as bounded cursor pages: the polled first page keeps the
 * newest Runs fresh, picker.loadOlder walks the opaque cursor, and an exact Run
 * ID can be opened directly even when pagination has not reached it. Every
 * path preserves workspace ownership — that check lives server-side, and a
 * miss renders as "not found in this workspace", never a global lookup.
 *
 * A Run is a namespace, not a graph — nothing stops several unrelated DAGs
 * living in one Run. The orca-dag skill tells your agent to create a fresh
 * Run per plan, which is what makes "one Run = one DAG" hold in practice.
 */

const PAGE_SIZE = 25;

export interface RunListReadState {
  loaded: boolean;
  error: string | null;
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
  const dialog = useDecisionDialog();
  const t = useT();
  // Browsing Runs remains read-only; only creating one needs runtime readiness.
  const readiness = useReadiness();
  const execOff = readiness !== null && !readiness.executionEnabled;
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
  const [err, setErr] = useState<string | null>(null);
  const [exactId, setExactId] = useState("");
  const [exactBusy, setExactBusy] = useState(false);
  const [creating, setCreating] = useState(false);
  const combined = dedupeById([...pinned, ...firstPage, ...older]);

  useEffect(() => {
    onReadStateChange?.(listRead);
  }, [listRead, onReadStateChange]);

  const load = useCallback(async () => {
    // Polling must not make every slow response obsolete. Keep one read in
    // flight so an 11-second request still lands with the 10-second timer.
    if (loadPending.current) return;
    loadPending.current = true;
    try {
      const page = await fetchRunsPage({ limit: PAGE_SIZE });
      setFirstPage(page.runs);
      setNextCursor(page.nextCursor);
      setErr(null);
      setListRead((previous) => previous.loaded && !previous.error ? previous : { loaded: true, error: null });
    } catch (e) {
      const error = String((e as Error).message ?? e);
      setListRead((previous) => previous.error === error ? previous : { ...previous, error });
    } finally {
      loadPending.current = false;
    }
  }, []);

  // Newest-Run fallback, evaluated on the combined list AFTER a page lands.
  // It must consider every loaded page and pin — checking only the polled
  // first page would auto-switch away from a Run the user reached via an
  // older page or an exact-ID open.
  useEffect(() => {
    if (
      autoPick &&
      combined.length > 0 &&
      !combined.some((r) => r.id === runId)
    ) {
      onPick(combined[0].id);
    }
  }, [autoPick, combined, runId, onPick]);

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

  async function openExact() {
    const id = exactId.trim();
    if (!id || exactBusy) return;
    setExactBusy(true);
    setErr(null);
    try {
      const run = await fetchRunById(id);
      setPinned((prev) => dedupeById([run, ...prev]));
      setExactId("");
      onPick(run.id);
    } catch (e) {
      setErr(String((e as Error).message ?? e));
    } finally {
      setExactBusy(false);
    }
  }

  async function onCreate() {
    const objective = await dialog.prompt({
      title: t("picker.createTitle"),
      message: t("picker.createMessage"),
      fieldLabel: t("picker.createFieldLabel"),
      placeholder: t("picker.createPlaceholder"),
      confirmLabel: t("picker.createConfirm"),
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
        disabled={disabled || combined.length === 0}
        placeholder={placeholder}
        loading={!listRead.loaded && !listRead.error}
        emptyText={placeholder}
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
          hint: r.id,
        }))}
      />
      <details className="runpick__menu">
        <summary aria-label={t("picker.moreAria")} title={t("picker.moreTitle")}>
          <span aria-hidden="true">⋯</span>
        </summary>
        <div className="runpick__menu-panel" role="group" aria-label={t("picker.actionsAria")}>
          <button className="btn btn--ghost menu-close" type="button" onClick={(event) => {
            const menu = event.currentTarget.closest("details");
            if (menu) {
              menu.open = false;
              menu.querySelector<HTMLElement>("summary")?.focus();
            }
          }}>{t("dialog.close")}</button>
          <button
            type="button"
            className="btn btn--ghost"
            onClick={onCreate}
            disabled={disabled || creating || execOff}
            title={(execOff && readiness?.reason) || t("picker.newRunTitle")}
          >
            {t("picker.newRun")}
          </button>
          {nextCursor && (
            <button
              type="button"
              className="btn btn--ghost runpick__more"
              onClick={loadOlder}
              disabled={disabled || loadingMore}
              title={t("picker.loadOlderTitle")}
            >
              {loadingMore ? t("picker.loading") : t("picker.loadOlder")}
            </button>
          )}
          <label className="runpick__exact-label" htmlFor="runpick-exact-id">
            {t("picker.exactLabel")}
          </label>
          <span className="runpick__exact">
            <input
              id="runpick-exact-id"
              className="runpick__exact-input"
              value={exactId}
              placeholder="run_…"
              spellCheck={false}
              aria-label={t("picker.exactLabel")}
              onChange={(e) => setExactId(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void openExact();
              }}
            />
            <button
              type="button"
              className="btn btn--ghost"
              onClick={openExact}
              disabled={disabled || exactBusy || !exactId.trim()}
              title={t("picker.exactTitle")}
            >
              {exactBusy ? "…" : t("picker.go")}
            </button>
          </span>
        </div>
      </details>
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
