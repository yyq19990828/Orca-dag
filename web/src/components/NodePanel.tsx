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

/**
 * Node detail + per-node harness. The description/deps are read-only (Orca can't
 * rewrite a stored spec — to change the plan, ask your agent to redraw the DAG).
 * The harness is this node's choice of agent when the coordinator fires it.
 */
export function NodePanel({ node, onClose }: { node: DagNode; onClose: () => void }) {
  const meta = STATUS_META[node.status];
  useConfig(); // re-render when the default harness (or this node's) changes
  const { customCommandsAllowed: customOk } = useFlags(); // gates the "Custom…" option
  const stored = getNodeHarness(node.id);
  const [sel, setSel] = useState(stored === null ? INHERIT : KNOWN.includes(stored) ? stored : CUSTOM);
  const [custom, setCustom] = useState(stored && !KNOWN.includes(stored) ? stored : "");

  useEffect(() => {
    const s = getNodeHarness(node.id);
    setSel(s === null ? INHERIT : KNOWN.includes(s) ? s : CUSTOM);
    setCustom(s && !KNOWN.includes(s) ? s : "");
  }, [node.id]);

  function pick(v: string) {
    setSel(v);
    if (v === INHERIT) setNodeHarness(node.id, null);
    else if (v !== CUSTOM) setNodeHarness(node.id, v);
  }
  function pickCustom(v: string) {
    if (!customOk) return; // server would 403 anyway; keep the stored value intact
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
    // "" = Local. setNodeEnvironment clears a stale placement with the env.
    setNodeEnvironment(node.id, v || null);
  }

  function pickPlacement(p: PlacementSpec | null) {
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

      <div className="node-panel__field">
        <span className="node-panel__key">Harness (which agent runs this node)</span>
        <DoodleSelect
          value={sel}
          onChange={pick}
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
            disabled={!customOk}
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
              if (v.startsWith("existing:")) pickPlacement({ kind: "existing", selector: v.slice("existing:".length) });
              else if (v === "new-top-level") {
                const repo = repos?.[0]?.id ?? "";
                pickPlacement(repo ? { kind: "new-top-level", repo, name: `${node.id.slice(0, 24)}-wt` } : null);
              } else pickPlacement(null);
            }}
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
                loading={repos === null}
                options={(repos ?? []).map((r) => ({ value: r.id, label: r.displayName ?? r.id }))}
              />
              <input
                className="node-panel__custom"
                value={placement.name}
                placeholder="worktree name"
                onChange={(e) => {
                  const name = e.target.value.trim();
                  pickPlacement(name ? { ...placement, name } : null);
                }}
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
              onChange={(v) => setNodeModel(node.id, v || null)}
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
            onChange={(v) => setNodeEffort(node.id, v || null)}
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
        <span className="node-panel__key">Spec</span>
        <p className="node-panel__spec-ro">{node.spec}</p>
        <span className="node-panel__hint">
          To change the spec or deps, have your agent redraw the DAG in a fresh Run.
        </span>
      </div>

      {node.result && (
        <div className="node-panel__field">
          <span className="node-panel__key">Result</span>
          <pre className="node-panel__result">{node.result}</pre>
        </div>
      )}
    </aside>
  );
}
