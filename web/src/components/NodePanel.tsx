import { useEffect, useState } from "react";
import { fetchEnvironmentRepos, fetchEnvironmentWorktrees, fetchEnvironments, fetchModels } from "../api";
import {
  effectiveHarness,
  getDefaultHarness,
  getNodeHarness,
  getNodeModel,
  getNodeEffort,
  getNodeRetain,
  getNodeEnvironment,
  getNodePlacement,
  setNodeHarness,
  setNodeModel,
  setNodeEffort,
  setNodeRetain,
  setNodeEnvironment,
  setNodePlacement,
  useConfig,
  useFlags,
} from "../harness";
import {
  HARNESSES,
  EFFORT_LEVELS,
  EFFORT_SUPPORTED,
  MODEL_PICKER,
  STATUS_META,
  type DagNode,
  type DagNodeReadiness,
  type OrcaEnvironmentView,
  type OrcaRepoView,
  type OrcaWorktreeView,
  type PlacementSpec,
} from "../types";
import { DoodleSelect } from "./DoodleSelect";

const INHERIT = "__inherit__";
const CUSTOM = "__custom__";
const KNOWN = HARNESSES as readonly string[];
const CUSTOM_OFF_HINT = "Custom commands are disabled — start the viewer with ORCA_DAG_ALLOW_CUSTOM_COMMANDS=1";

interface WorkerReportResult {
  provenance?: string;
  outcome?: string;
  subject?: string;
  body?: string;
  completedAt?: string;
  reportedBy?: string;
  completedBy?: string;
  messageId?: string;
  filesModified?: string[];
  reportPath?: string | null;
}

function parseWorkerReport(raw: string): WorkerReportResult | null {
  try {
    const value = JSON.parse(raw) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    return value as WorkerReportResult;
  } catch {
    return null;
  }
}

function resultExcerpt(body: string): { text: string; clipped: boolean } {
  const normalized = body.replace(/\s+/g, " ").trim();
  if (normalized.length <= 420) return { text: normalized, clipped: false };
  const candidate = normalized.slice(0, 420);
  const sentenceEnd = Math.max(candidate.lastIndexOf(". "), candidate.lastIndexOf("。"));
  const text = sentenceEnd > 180 ? candidate.slice(0, sentenceEnd + 1) : candidate.trimEnd();
  return { text, clipped: true };
}

function resultTime(value: string | undefined): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function ResultSummary({ raw }: { raw: string }) {
  const report = parseWorkerReport(raw);
  if (!report) return <p className="node-panel__result-text">{raw}</p>;

  const outcome = report.outcome?.trim() || "reported";
  const body = typeof report.body === "string" ? resultExcerpt(report.body) : null;
  const files = Array.isArray(report.filesModified)
    ? report.filesModified.filter((file): file is string => typeof file === "string" && Boolean(file.trim()))
    : [];
  const completedAt = resultTime(report.completedAt);
  return (
    <section className="node-result" data-outcome={outcome} aria-label="Stage result summary">
      <div className="node-result__head">
        <span className="node-result__outcome">{outcome.replaceAll("_", " ")}</span>
        {completedAt && <time dateTime={report.completedAt}>{completedAt}</time>}
      </div>
      <strong>{report.subject?.trim() || "Worker report"}</strong>
      {body?.text && <p>{body.text}</p>}
      {files.length > 0 && (
        <div className="node-result__files">
          <span>{files.length} file{files.length === 1 ? "" : "s"} modified</span>
          <ul>
            {files.map((file) => <li key={file}><code>{file}</code></li>)}
          </ul>
        </div>
      )}
      {report.reportPath && <p className="node-result__report">Report: <code>{report.reportPath}</code></p>}
      <details className="node-result__details">
        <summary>{body?.clipped ? "Full report and technical details" : "Technical details"}</summary>
        {body?.clipped && <p>{report.body}</p>}
        <dl>
          {report.reportedBy && <><dt>Reported by</dt><dd><code>{report.reportedBy}</code></dd></>}
          {!report.reportedBy && report.completedBy && <><dt>Completed by</dt><dd><code>{report.completedBy}</code></dd></>}
          {report.messageId && <><dt>Message</dt><dd><code>{report.messageId}</code></dd></>}
          {report.provenance && <><dt>Provenance</dt><dd>{report.provenance.replaceAll("_", " ")}</dd></>}
        </dl>
        <pre>{JSON.stringify(report, null, 2)}</pre>
      </details>
    </section>
  );
}

interface NodePanelProps {
  node: DagNode;
  runId: string;
  isLead: boolean;
  /** Resolved parent Task label, when the node's parent_id is in this Run. */
  parentLabel: string | null;
  /** Labels of Tasks in this Run whose parent_id is this node. */
  childLabels: string[];
  /** Server-projected readiness explanation for this node (Phase 4). */
  readiness: DagNodeReadiness | null;
  onLeadChange: (taskId: string | null) => void;
  /** Evidence accumulated from worker-list for this Run during this page session. */
  permanentlyLocked: boolean;
  /** The selected Run's coordinator has an immutable launch-plan snapshot. */
  temporarilyLocked: boolean;
  /** The selected Run is binding/recovering before its status has a runId. */
  coordinatorStarting: boolean;
  workerHistoryLoading: boolean;
  workerHistoryError: string | null;
  onClose: () => void;
}

/**
 * Node detail + per-node harness. The description/deps are read-only (Orca can't
 * rewrite a stored spec — to change the plan, ask your agent to redraw the DAG).
 * The harness is this node's choice of agent when the coordinator fires it.
 */
export function NodePanel({
  node,
  runId,
  isLead,
  parentLabel,
  childLabels,
  readiness,
  onLeadChange,
  permanentlyLocked,
  temporarilyLocked,
  coordinatorStarting,
  workerHistoryLoading,
  workerHistoryError,
  onClose,
}: NodePanelProps) {
  const meta = STATUS_META[node.status];
  useConfig(); // re-render when the default harness (or this node's) changes
  const { customCommandsAllowed: customOk } = useFlags(); // gates the "Custom…" option
  // A current Dispatch, completed Task, or failed Task is a conservative
  // session-local fallback while worker-list is loading. The durable worker
  // set supplied by App covers settled history after a viewer restart.
  const fallbackPermanentLock =
    node.dispatchId !== null || node.status === "completed" || node.status === "failed";
  const historyLocked = workerHistoryLoading || Boolean(workerHistoryError);
  const launchLocked =
    permanentlyLocked || fallbackPermanentLock || temporarilyLocked || coordinatorStarting || historyLocked;
  const permanentLock = permanentlyLocked || fallbackPermanentLock;
  const lockReason = permanentLock
    ? "Launch settings locked after the first Dispatch. Safe retry preserves the original launch plan."
    : temporarilyLocked
      ? "Launch settings are frozen while this Run is executing. Stop the coordinator to edit Tasks that have not started."
      : coordinatorStarting
        ? "Launch settings are frozen while this Run is starting. Wait for coordinator binding and recovery to finish before editing."
        : workerHistoryError
          ? "Launch settings are locked while Dispatch history could not be verified. Wait for worker history to recover before editing."
          : workerHistoryLoading
            ? "Launch settings are locked while Dispatch history is loading. Wait for worker history to finish before editing."
      : null;
  const stored = getNodeHarness(node.id);
  const [sel, setSel] = useState(stored === null ? INHERIT : KNOWN.includes(stored) ? stored : CUSTOM);
  const [custom, setCustom] = useState(stored && !KNOWN.includes(stored) ? stored : "");
  const [specExpanded, setSpecExpanded] = useState(false);

  useEffect(() => {
    const s = getNodeHarness(node.id);
    setSel(s === null ? INHERIT : KNOWN.includes(s) ? s : CUSTOM);
    setCustom(s && !KNOWN.includes(s) ? s : "");
    // A newly selected stage starts compact even if the previous stage's
    // description was expanded. The explicit button preserves accessibility.
    setSpecExpanded(false);
  }, [node.id]);

  function pick(v: string) {
    if (launchLocked) return;
    setSel(v);
    if (v === INHERIT) setNodeHarness(node.id, null);
    else if (v !== CUSTOM) setNodeHarness(node.id, v);
  }
  function pickCustom(v: string) {
    if (!customOk || launchLocked) return; // keep the stored value intact while locked
    setCustom(v);
    setNodeHarness(node.id, v.trim() || null);
  }

  // --- per-node environment + exact placement (Phase 6) ----------------
  // The environment picker lists ONLY what `orca environment list` discovered
  // (Local default + saved environments) — the viewer never invents a target.
  // Selecting a remote environment reveals the placement editor, whose two
  // forms are the only remote-safe ones Orca supports: an exact existing
  // workspace (full `id:<repo>::<path>` selector, verbatim) or a new
  // top-level worktree (exact repo selector + explicit name). Remote
  // `current` and `new-child` are never offered — they are invalid.
  const [envs, setEnvs] = useState<OrcaEnvironmentView[] | null>(null);
  useEffect(() => {
    let alive = true;
    fetchEnvironments()
      .then((e) => alive && setEnvs(e))
      .catch(() => alive && setEnvs([]));
    return () => {
      alive = false;
    };
  }, []);
  const envId = getNodeEnvironment(node.id);
  const placement = getNodePlacement(node.id);
  const selectedEnv = envs?.find((e) => e.id === envId) ?? null;
  // Peer capability gates: an unadvertised capability is treated as absent —
  // the matching controls hide rather than mislead (mixed-version peers).
  const peerModelEffort = !envId || (selectedEnv?.peer.modelEffort ?? false);

  // Exact-workspace and repo discovery for the placement editor, loaded per
  // selected environment (cached list data; empty on failure → the pickers
  // stay empty with a hint, never filled with guesses).
  const [worktrees, setWorktrees] = useState<OrcaWorktreeView[] | null>(null);
  const [repos, setRepos] = useState<OrcaRepoView[] | null>(null);
  useEffect(() => {
    if (!envId) {
      setWorktrees(null);
      setRepos(null);
      return;
    }
    let alive = true;
    fetchEnvironmentWorktrees(envId)
      .then((w) => alive && setWorktrees(w))
      .catch(() => alive && setWorktrees([]));
    fetchEnvironmentRepos(envId)
      .then((r) => alive && setRepos(r))
      .catch(() => alive && setRepos([]));
    return () => {
      alive = false;
    };
  }, [envId]);

  function pickEnvironment(v: string) {
    if (launchLocked) return;
    // "" = Local. setNodeEnvironment clears a stale placement with the env.
    setNodeEnvironment(node.id, v || null);
  }

  function pickPlacement(p: PlacementSpec | null) {
    if (launchLocked) return;
    setNodePlacement(node.id, p);
  }

  // --- per-node model ------------------------------------------------
  // The model picker depends on the node's EFFECTIVE harness (its own override,
  // else the inherited default), not the {sel,custom} transient state — so it
  // reacts correctly even when the node just inherits. opencode → dropdown from
  // `opencode models`; claude/codex/cursor → free-text (no enumerable list);
  // anything else → no model control.
  const effHarness = effectiveHarness(node.id);
  const picker = MODEL_PICKER[effHarness] ?? "none";
  const model = getNodeModel(node.id);
  const [openCodeModels, setOpenCodeModels] = useState<string[] | null>(null);
  useEffect(() => {
    if (effHarness !== "opencode") return;
    let alive = true;
    fetchModels("opencode")
      .then((m) => {
        if (alive) setOpenCodeModels(m);
      })
      .catch(() => {
        if (alive) setOpenCodeModels([]);
      });
    return () => {
      alive = false;
    };
  }, [effHarness]);

  return (
    <aside className="node-panel">
      <button className="node-panel__close" onClick={onClose} aria-label="Close">
        ✕
      </button>

      <div className="node-panel__status" style={{ color: meta.ink }}>
        <span className="dot" style={{ background: meta.color }} />
        {meta.label}
      </div>
      <h3 className="node-panel__title">{node.label}</h3>
      <div className="node-panel__id">
        <code>{node.id}</code>
      </div>

      {/* Phase 4: scheduler state + ownership, derived from Run-scoped
          task/gate/coordinator facts the server projected onto /api/dag.
          A parent relation is ownership, never a dependency — the copy says
          so explicitly so nobody reads order into it. */}
      {(parentLabel || childLabels.length > 0 || (readiness && readiness.reasons.length > 0)) && (
        <div className="node-panel__field node-panel__scheduler">
          {parentLabel && (
            <p className="node-panel__relation">
              <span aria-hidden="true">┄</span> Sub-stage of <strong>{parentLabel}</strong>
              <span className="node-panel__hint"> ownership only — not a dependency</span>
            </p>
          )}
          {childLabels.length > 0 && (
            <p className="node-panel__relation">
              <span aria-hidden="true">┄</span> Parent of {childLabels.length}{" "}
              {childLabels.length === 1 ? "sub-stage" : "sub-stages"}: {childLabels.join(", ")}
            </p>
          )}
          {readiness && readiness.reasons.length > 0 && (
            <ul className="node-panel__readiness" aria-label="Why this stage is not running yet">
              {readiness.reasons.map((reason, i) => (
                <li key={readiness.codes[i] ?? i} data-code={readiness.codes[i] ?? "unknown"}>
                  {reason}
                </li>
              ))}
            </ul>
          )}
          {readiness && readiness.runnable && readiness.reasons.length === 0 && (
            <p className="node-panel__relation node-panel__relation--ready">Ready — dispatchable now.</p>
          )}
        </div>
      )}

      <div className="node-panel__lead" aria-live="polite">
        {isLead ? (
          <>
            <div className="node-panel__lead-state">
              <span aria-hidden="true">★</span>
              <span>
                <strong>Lead stage</strong>
                <small>Semantic main-agent ownership for Run {runId}</small>
              </span>
            </div>
            <button
              type="button"
              className="node-panel__lead-clear"
              onClick={() => onLeadChange(null)}
              aria-label={`Clear lead stage for ${node.label}`}
            >
              Clear
            </button>
          </>
        ) : (
          <button
            type="button"
            className="node-panel__lead-mark"
            onClick={() => onLeadChange(node.id)}
            aria-pressed="false"
            title="Mark this Task as the semantic lead stage; this does not change Orca coordinator authority"
          >
            <span aria-hidden="true">☆</span> Mark as lead stage
          </button>
        )}
      </div>

      {workerHistoryLoading && (
        <div className="node-panel__history" role="status">
          Checking Dispatch history…
        </div>
      )}
      {workerHistoryError && (
        <div className="node-panel__history node-panel__history--warn" role="status">
          Could not verify Dispatch history; launch settings remain locked until verification recovers.
        </div>
      )}

      {lockReason && (
        <div className="node-panel__lock" role="note">
          <span aria-hidden="true">🔒</span>
          <span>{lockReason}</span>
        </div>
      )}

      <div className="node-panel__field">
        <span className="node-panel__key">Harness (which agent runs this node)</span>
        <DoodleSelect
          value={sel}
          onChange={pick}
          disabled={launchLocked}
          title={launchLocked ? lockReason ?? "Launch settings are locked" : undefined}
          options={[
            { value: INHERIT, label: `Default (${getDefaultHarness()})` },
            ...HARNESSES.map((h) => ({ value: h, label: h })),
            // Same policy as the toolbar: no "Custom…" unless the server allows
            // it — but a stored custom value stays visible (and clearable via
            // "Inherit") while the flag is off.
            ...(customOk || (stored !== null && !KNOWN.includes(stored))
              ? [
                  {
                    value: CUSTOM,
                    label: customOk ? "Custom…" : "Custom (disabled)",
                    disabled: !customOk,
                    hint: customOk ? undefined : "ORCA_DAG_ALLOW_CUSTOM_COMMANDS=1",
                  },
                ]
              : []),
          ]}
        />
        {sel === CUSTOM && (
          <input
            className="node-panel__custom"
            value={custom}
            placeholder="command, e.g. aider"
            onChange={(e) => pickCustom(e.target.value)}
            disabled={!customOk || launchLocked}
          />
        )}
        {sel === CUSTOM && !customOk && (
          <span className="node-panel__hint">{CUSTOM_OFF_HINT}</span>
        )}
      </div>

      {/* Phase 6: run this node on a saved environment (or keep it local —
          the zero-configuration default). List contents come only from
          `orca environment list`; nothing is ever invented client-side. */}
      <div className="node-panel__field">
        <span className="node-panel__key">Environment (which server executes this node)</span>
        <DoodleSelect
          value={envId ?? ""}
          onChange={pickEnvironment}
          disabled={launchLocked}
          loading={envs === null}
          options={[
            { value: "", label: `Local (this server)` },
            ...(envs ?? []).map((e) => ({
              value: e.id,
              label: e.name === e.id ? e.id : `${e.name} (${e.id})`,
            })),
          ]}
        />
        {envId && envs !== null && !selectedEnv && (
          <span className="node-panel__hint">
            Saved environment “{envId}” is no longer listed — re-discover it or switch back to Local.
          </span>
        )}
        {envId && selectedEnv && !selectedEnv.peer.modelEffort && (
          <span className="node-panel__hint">
            This peer does not advertise model/effort — those controls are hidden for this node.
          </span>
        )}
      </div>

      {/* Placement editor: ONLY for a remote environment, ONLY in the two
          remote-safe forms. Local/current needs no editor (the default). */}
      {envId && (
        <div className="node-panel__field">
          <span className="node-panel__key">Placement on {selectedEnv?.name ?? envId}</span>
          <DoodleSelect
            value={placement?.kind === "existing" ? `existing:${placement.selector}` : placement?.kind === "new-top-level" ? "new-top-level" : ""}
            onChange={(v) => {
              if (launchLocked) return;
              if (v.startsWith("existing:")) pickPlacement({ kind: "existing", selector: v.slice("existing:".length) });
              else if (v === "new-top-level") {
                const repo = repos?.[0]?.id ?? "";
                pickPlacement(repo ? { kind: "new-top-level", repo, name: `${node.id.slice(0, 24)}-wt` } : null);
              } else pickPlacement(null);
            }}
            disabled={launchLocked}
            loading={worktrees === null || repos === null}
            options={[
              { value: "", label: "(pick a workspace…)" },
              ...(worktrees ?? []).map((w) => ({
                value: `existing:${w.id}`,
                label: `▸ ${w.displayName ?? w.path ?? w.id}${w.branch ? ` · ${w.branch.replace(/^refs\/heads\//, "")}` : ""}`,
                hint: w.id,
              })),
              ...(repos && repos.length > 0
                ? [{ value: "new-top-level", label: "＋ New top-level worktree…" }]
                : []),
            ]}
          />
          {placement?.kind === "existing" && (
            <span className="node-panel__hint">
              Exact workspace: <code>{placement.selector}</code>
            </span>
          )}
          {placement?.kind === "new-top-level" && (
            <div className="node-panel__custom-block">
              <DoodleSelect
                value={placement.repo}
                onChange={(repo) => pickPlacement({ ...placement, repo })}
                disabled={launchLocked}
                loading={repos === null}
                options={(repos ?? []).map((r) => ({ value: r.id, label: r.displayName ?? r.id }))}
              />
              <input
                className="node-panel__custom"
                value={placement.name}
                placeholder="worktree name"
                onChange={(e) => {
                  if (launchLocked) return;
                  const name = e.target.value.trim();
                  pickPlacement(name ? { ...placement, name } : null);
                }}
                disabled={launchLocked}
              />
              <span className="node-panel__hint">New independent top-level worktree: exact repo + explicit name.</span>
            </div>
          )}
          {placement === null && (
            <span className="node-panel__hint">
              Pick an exact workspace or a new top-level worktree — remote “current” is not a valid placement.
            </span>
          )}
        </div>
      )}

      {/* Model/effort are gated on the peer: a remote environment that does
          not advertise model/effort forwarding hides both controls (the
          coordinator would refuse the start anyway — this makes it honest
          UI instead of a runtime error). */}
      {picker !== "none" && peerModelEffort && (
        <div className="node-panel__field">
          <span className="node-panel__key">
            Model ({effHarness}){model ? null : " · default"}
          </span>
          {picker === "select" ? (
            <DoodleSelect
              value={model ?? ""}
              onChange={(v) => {
                if (!launchLocked) setNodeModel(node.id, v || null);
              }}
              disabled={launchLocked}
              loading={openCodeModels === null}
              options={[
                { value: "", label: "(default model)" },
                ...(openCodeModels ?? []).map((m) => ({ value: m, label: m })),
              ]}
            />
          ) : (
            <input
              className="node-panel__custom"
              value={model ?? ""}
              placeholder={`model name, e.g. ${effHarness === "claude" ? "opus" : effHarness === "codex" ? "o3" : "<model>"}`}
              onChange={(e) => setNodeModel(node.id, e.target.value.trim() || null)}
              disabled={launchLocked}
            />
          )}
        </div>
      )}

      {/* Phase 5: effort only exists WITH a model (worker-start --effort
          requires --model), and only for harnesses that take the flag at all
          — opencode runs the legacy path and has none. Clearing the model
          clears the effort in the store, so the pair can never dangle.
          Phase 6: also gated on the peer advertising model/effort. */}
      {model && EFFORT_SUPPORTED.has(effHarness) && peerModelEffort && (
        <div className="node-panel__field">
          <span className="node-panel__key">Effort ({effHarness})</span>
          <DoodleSelect
            value={getNodeEffort(node.id) ?? ""}
            onChange={(v) => {
              if (!launchLocked) setNodeEffort(node.id, v || null);
            }}
            disabled={launchLocked}
            options={[
              { value: "", label: "(default effort)" },
              ...EFFORT_LEVELS.map((e) => ({ value: e, label: e })),
            ]}
          />
          <span className="node-panel__hint">Reasoning effort for the selected model.</span>
        </div>
      )}

      {/* Phase 5: retain-for-debugging — the settled worker's terminal stays
          alive and visible (in the Workers panel) until manually released. */}
      <label className="node-panel__field node-panel__retain">
        <input
          type="checkbox"
          checked={getNodeRetain(node.id)}
          onChange={(e) => setNodeRetain(node.id, e.target.checked)}
        />
        <span className="node-panel__key">Keep terminal for debugging after this node settles</span>
      </label>

      {/* Orca tracks the running attempt as a Dispatch; task-list only carries
          these while the task is dispatched. */}
      {node.dispatchId && (
        <div className="node-panel__field">
          <span className="node-panel__key">Current Dispatch (this attempt)</span>
          <div className="node-panel__id">
            <code>{node.dispatchId}</code>
          </div>
          {node.assigneeHandle && (
            <span className="node-panel__hint">
              Worker terminal <code>{node.assigneeHandle}</code> · inspect output with{" "}
              <code>orca orchestration worker-read --dispatch {node.dispatchId}</code>
            </span>
          )}
        </div>
      )}

      <div className="node-panel__field">
        <div className="node-panel__spec-head">
          <span className="node-panel__key">Spec</span>
          <button
            type="button"
            className="node-panel__spec-toggle"
            aria-expanded={specExpanded}
            aria-controls={`stage-spec-${node.id}`}
            onClick={() => setSpecExpanded((open) => !open)}
          >
            {specExpanded ? "Collapse" : "Expand"}
          </button>
        </div>
        <p
          id={`stage-spec-${node.id}`}
          className={`node-panel__spec-ro${specExpanded ? " node-panel__spec-ro--expanded" : ""}`}
          title={specExpanded ? undefined : node.spec}
        >
          {node.spec}
        </p>
        <span className="node-panel__hint">
          To change the spec or deps, have your agent redraw the DAG in a fresh Run.
        </span>
      </div>

      {node.result && (
        <div className="node-panel__field">
          <span className="node-panel__key">Result</span>
          <ResultSummary raw={node.result} />
        </div>
      )}
    </aside>
  );
}
