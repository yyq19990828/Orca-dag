import { useEffect, useMemo, useState } from "react";
import {
  fetchEnvironmentRepos,
  fetchEnvironmentWorktrees,
  fetchLocalRepos,
  fetchLocalWorkspaces,
} from "../api";
import { creationFieldProblems } from "../placement";
import {
  SETUP_POLICIES,
  type CreationOptions,
  type OrcaRepoView,
  type OrcaWorktreeView,
  type PlacementSpec,
  type SetupPolicy,
} from "../types";
import { DoodleSelect } from "./DoodleSelect";

/**
 * The placement editor (Phase 7).
 *
 * Three scopes over ONE grammar:
 *  - "local": the full four-choice matrix — `current` (the coordinator
 *    workspace, the zero-config default), an exact existing workspace,
 *    a stacked `new-child` worktree, or a `new-top-level` worktree created
 *    from an exact repo selector.
 *  - "remote": the only two remote-safe choices — an exact existing
 *    workspace or a new top-level worktree. Remote `current` and
 *    `new-child` are invalid and are never offered.
 *  - "lane": a lane's seed — every non-current kind (`current` is no lane).
 *
 * Everything listed in the pickers comes verbatim from Orca discovery
 * (`/api/worktrees`, `/api/repos`, or the environment-scoped variants);
 * selectors are echoed back exactly as discovered — a bare repo id is NOT a
 * worktree id, and the viewer never reconstructs one. Creation-only fields
 * (name, setup policy, base branch, display name, comment) render ONLY for
 * the two creation kinds: current/existing reject them all and never rerun
 * setup.
 */

const CURRENT = "current";
const NEW_CHILD = "new-child";
const NEW_TOP_LEVEL = "new-top-level";

/** DoodleSelect value for an exact-existing choice (selectors may contain `:`). */
function existingValue(selector: string): string {
  return `existing:${selector}`;
}

function modeValueOf(p: PlacementSpec | null): string {
  if (!p || p.kind === "current") return CURRENT;
  if (p.kind === "existing") return existingValue(p.selector);
  return p.kind;
}

type CreationPlacement = Extract<PlacementSpec, { kind: "new-child" | "new-top-level" }>;

/** Overloads the stored selector into the DoodleSelect's "existing" mode key. */
const EXISTING_MODE = "__existing__";

export function PlacementEditor({
  scope,
  envId,
  value,
  onChange,
  disabled,
  title,
}: {
  scope: "local" | "remote" | "lane";
  /** Saved-environment id for the remote scope; local/lane use local discovery. */
  envId: string | null;
  value: PlacementSpec | null;
  onChange: (p: PlacementSpec | null) => void;
  disabled: boolean;
  /** Wrapper label (e.g. "Placement" / "Workspace lane placement"). */
  title: string;
}) {
  // Discovery data. Remote scope keeps the environment-scoped fetches it
  // always used; local/lane share the local endpoints. Empty-on-failure
  // keeps the pickers empty with a hint — never filled with guesses.
  const [worktrees, setWorktrees] = useState<OrcaWorktreeView[] | null>(null);
  const [repos, setRepos] = useState<OrcaRepoView[] | null>(null);
  useEffect(() => {
    let alive = true;
    if (scope === "remote" && envId) {
      fetchEnvironmentWorktrees(envId)
        .then((w) => alive && setWorktrees(w))
        .catch(() => alive && setWorktrees([]));
      fetchEnvironmentRepos(envId)
        .then((r) => alive && setRepos(r))
        .catch(() => alive && setRepos([]));
    } else {
      fetchLocalWorkspaces()
        .then((w) => alive && setWorktrees(w))
        .catch(() => alive && setWorktrees([]));
      fetchLocalRepos()
        .then((r) => alive && setRepos(r))
        .catch(() => alive && setRepos([]));
    }
    return () => {
      alive = false;
    };
  }, [scope, envId]);

  const loading = worktrees === null || repos === null;
  const mode = modeValueOf(value);
  const onExisting = mode.startsWith("existing:");

  const modeOptions = useMemo(() => {
    const options: { value: string; label: string; disabled?: boolean; hint?: string }[] = [];
    if (scope === "local") {
      options.push({ value: CURRENT, label: "Current workspace (default)" });
    }
    options.push({
      value: EXISTING_MODE,
      label: "Existing workspace…",
      disabled: loading,
    });
    if (scope !== "remote") {
      options.push({ value: NEW_CHILD, label: "New child worktree…", disabled: loading });
    }
    options.push({
      value: NEW_TOP_LEVEL,
      label: "New top-level worktree…",
      disabled: loading || (repos !== null && repos.length === 0),
      hint: repos !== null && repos.length === 0 ? "no repositories discovered" : undefined,
    });
    return options;
  }, [scope, loading, repos]);

  function pickMode(v: string) {
    if (disabled) return;
    if (v === CURRENT) {
      onChange({ kind: "current" });
    } else if (v === NEW_CHILD) {
      // Fresh creation spec with Orca's default policy; the name stays empty
      // → the server derives a deterministic bounded name.
      onChange({ kind: "new-child", setup: "run" });
    } else if (v === NEW_TOP_LEVEL) {
      const repo = repos?.[0]?.id ?? "";
      if (repo) onChange({ kind: "new-top-level", repo, setup: "run" });
    } else if (v.startsWith("existing:")) {
      onChange({ kind: "existing", selector: v.slice("existing:".length) });
    }
  }

  function pickExisting(selector: string) {
    if (!disabled) onChange({ kind: "existing", selector });
  }

  function pickRepo(repo: string) {
    if (disabled) return;
    if (value?.kind === "new-top-level") onChange({ ...value, repo });
  }

  function patchCreation(patch: Partial<CreationOptions>): void {
    if (disabled) return;
    if (value?.kind === "new-child" || value?.kind === "new-top-level") {
      onChange({ ...value, ...patch });
    }
  }

  const problems = value ? creationFieldProblems(value) : [];
  const creation: CreationPlacement | null =
    value?.kind === "new-child" || value?.kind === "new-top-level" ? value : null;
  // Remote creation happens on ANOTHER server: a derived name could collide
  // with worktrees we cannot see, so the runtime requires an explicit name.
  const nameRequired = scope === "remote" && creation?.kind === "new-top-level";
  const nameMissing = Boolean(nameRequired && creation && !creation.name);

  return (
    <div className="placement">
      <span className="node-panel__key">{title}</span>
      {onExisting ? (
        <DoodleSelect
          value={mode}
          onChange={pickExisting}
          disabled={disabled}
          loading={worktrees === null}
          options={(worktrees ?? []).map((w) => ({
            value: existingValue(w.id),
            label: `▸ ${w.displayName ?? w.path ?? w.id}${
              w.branch ? ` · ${w.branch.replace(/^refs\/heads\//, "")}` : ""
            }`,
            hint: w.id,
          }))}
        />
      ) : (
        <DoodleSelect
          value={mode}
          onChange={pickMode}
          disabled={disabled}
          loading={loading}
          options={modeOptions}
        />
      )}

      {value?.kind === "current" && (
        <span className="node-panel__hint">
          Runs in the coordinator workspace. No creation fields apply, and setup never reruns.
        </span>
      )}

      {value?.kind === "existing" && (
        <>
          <span className="node-panel__hint">
            Exact workspace: <code>{value.selector}</code>
          </span>
          <span className="node-panel__hint">
            Existing workspaces are reused as-is — no creation fields apply, and setup never reruns.
          </span>
        </>
      )}

      {value?.kind === "new-child" && (
        <span className="node-panel__hint">
          Orca creates a stacked child worktree anchored on the current workspace’s repo.
        </span>
      )}

      {value?.kind === "new-top-level" && (
        <div className="placement__repo">
          <span className="node-panel__key">Repository</span>
          <DoodleSelect
            value={value.repo}
            onChange={pickRepo}
            disabled={disabled}
            loading={repos === null}
            options={(repos ?? []).map((r) => ({
              value: r.id,
              label: r.displayName ?? r.id,
              hint: r.id,
            }))}
          />
        </div>
      )}

      {creation && (
        <div className="placement__creation">
          <div className="placement__row">
            <label className="placement__field">
              <span>Name {nameRequired ? "(required)" : "(optional)"}</span>
              <input
                className="node-panel__custom"
                value={creation.name ?? ""}
                placeholder={nameRequired ? "worktree name" : "derived from the Run if empty"}
                onChange={(e) => {
                  const name = e.target.value.trim();
                  patchCreation(name ? { name } : { name: undefined });
                }}
                disabled={disabled}
                spellCheck={false}
              />
            </label>
            <label className="placement__field">
              <span>Setup hooks</span>
              <DoodleSelect
                value={creation.setup}
                onChange={(v) => patchCreation({ setup: v as SetupPolicy })}
                disabled={disabled}
                options={SETUP_POLICIES.map((p) => ({
                  value: p,
                  label:
                    p === "run" ? "run (default)" : p === "skip" ? "skip" : "inherit (from base)",
                }))}
              />
            </label>
          </div>
          <div className="placement__row">
            <label className="placement__field">
              <span>Base branch (optional)</span>
              <input
                className="node-panel__custom"
                value={creation.baseBranch ?? ""}
                placeholder="e.g. main or feature/x"
                onChange={(e) => {
                  const baseBranch = e.target.value.trim();
                  patchCreation(baseBranch ? { baseBranch } : { baseBranch: undefined });
                }}
                disabled={disabled}
                spellCheck={false}
              />
            </label>
            <label className="placement__field">
              <span>Display name (optional)</span>
              <input
                className="node-panel__custom"
                value={creation.displayName ?? ""}
                placeholder="shown in the Orca IDE"
                onChange={(e) => {
                  const displayName = e.target.value.trim();
                  patchCreation(displayName ? { displayName } : { displayName: undefined });
                }}
                disabled={disabled}
              />
            </label>
          </div>
          <label className="placement__field">
            <span>Comment (optional)</span>
            <textarea
              className="placement__comment"
              rows={2}
              value={creation.comment ?? ""}
              placeholder="stored in Orca worktree metadata"
              onChange={(e) => {
                const comment = e.target.value.trim();
                patchCreation(comment ? { comment } : { comment: undefined });
              }}
              disabled={disabled}
            />
          </label>
        </div>
      )}

      {nameMissing && (
        <span className="node-panel__hint placement__warn">
          A remote new worktree needs an explicit name — the coordinator would refuse to start without one.
        </span>
      )}
      {problems.map((p) => (
        <span key={p} className="node-panel__hint placement__warn">
          {p}
        </span>
      ))}
    </div>
  );
}
