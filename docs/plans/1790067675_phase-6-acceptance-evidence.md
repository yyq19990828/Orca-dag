# Phase 6 evidence: integration, documentation and acceptance

This retained acceptance record was produced from the completed Epic and phase-6
implementation plan. Those planning documents are intentionally not shipped with
the implementation; this file preserves the live evidence and its provenance.

Acceptance executed 2026-09-22/23 against the live Orca **1.4.206** runtime (the documented
1.4.205 execution floor is preserved). Live receipts were captured through the resolved
`orca` CLI from a throwaway Run (`run_9cf628fa883b`) whose tasks, worktrees, and terminal
were created and retired solely for this phase. Browser evidence was captured with
agent-browser/CDP (1440×900) against a scratch viewer on `127.0.0.1:8821` (since shut
down); the production viewer on `:8787` was left untouched — it was actively coordinating
the implementation Run and was never disturbed. Screenshots live in `/tmp/opencode/accept/`
and are deliberately **not** committed (no generated artifacts in Git).

**Evidence classes, kept separate on purpose:**

- **Automated** — Node test-runner assertions (468 passing) against a fake `orca`
  executable or pure functions. Deterministic lifecycle and boundary behavior.
- **Runtime** — read/live observations against the real Orca 1.4.206 runtime during this
  phase: worker-start receipts, worktree inventory, worker release receipts, viewer API
  responses. Establishes that Orca itself behaves as the adapters assume.
- **Visual** — browser screenshots of the built SPA served by the scratch viewer.
  Establishes presentation behavior only.

---

## 0. Verdict summary

- Automated checks: **PASS** (`npm run check` green — 468 tests, skill validation,
  typecheck, web build; `git diff --check` clean; `npm run check:skill` green).
- Live placement matrix: current / exact-existing / new-child / new-top-level all
  **executed and verified on the live runtime**, including Orca-side lineage and
  per-worker `pwd` proof of effective placement. **PASS.**
- Browser verification: placement editor (4 local modes), lane field, scheduler,
  fleet view, lanes panel, capabilities panel, exact-id lookup, fencing confirmation —
  all render as documented. **PASS.**
- Demonstrated source defect (this task owns docs/evidence, not source): the viewer's
  HTTP-boundary selector validator **rejects the exact selectors its own discovery
  endpoint returns on this machine** (non-ASCII workspace paths). Recorded as a
  **FAILED acceptance result** for the viewer-path exact-existing mode in §6; the
  runtime contract itself passes (§3), and the defect blocks no other mode.
- Cleanup: every acceptance worktree has an explicit final state (§4). No unexplained
  gate, request, worker, or cleanup debt remains.

## 1. Epic acceptance criteria → evidence

### AC1 — Four local placement modes selectable; receipt shows requested vs. effective

- **Automated:** `server/src/security.test.ts` — placement-matrix validation cases (four
  local kinds, creation metadata bounds, conflicting fields rejected, remote
  current/new-child refused); `server/src/orca.test.ts` — exact `worker-start` argv pins
  for all four local modes with no creation flags leaking onto current/existing starts.
- **Runtime:** §3 — all four modes started live; each receipt carries the worktree
  effect (`reused` / `created_child` / `created_top_level`) and setup
  (`not_applicable` vs `requested: run, effective: run`).
- **Visual:** `shot-04-stagecard.png` (Stage card with Environment / Workspace lane /
  Placement fields) and `shot-05-local-modes.png` (picker open: Current workspace /
  Existing workspace / New child worktree / New top-level worktree).

### AC2 — Two leaf Tasks in distinct Orca-created worktrees, correct lineage in Orca IDE

- **Runtime:** §3 — `accept-child` (created_child, parent = this worktree, lineage
  populated) and `accept-toplevel` (created_top_level, parent = none) appeared in
  `orca worktree list` simultaneously, each with its own agent terminal, while the
  current/existing probes ran in the coordinator workspace. All four ran as one
  parallel wave.
- **Visual:** same receipts; the Orca IDE worktree inventory listed both new worktrees
  with display names `accept: stacked child` / `accept: top level` and branches
  `refs/heads/feat/accept-child` / `refs/heads/feat/accept-toplevel`.

### AC3 — Creation flags only on new worktrees; validated metadata; exact repo selector

- **Automated:** `server/src/orca.test.ts` argv pins (creation flags structurally
  emitted only inside the `new-child`/`new-top-level` branch; `--repo` new-top-level
  only); `server/src/security.test.ts` — creation metadata validation (name token
  grammar, base-branch ref grammar, bounded display name/comment, setup enum).
- **Runtime:** §3 — current/existing receipts show `setup: not_applicable` (no creation
  flags, no setup rerun); child/top-level receipts show `requested: run → effective:
  run, source: explicit_request` and an exact repo selector
  (`id:1fc5325b-aa02-4f2a-a656-a2dcb0262947`) on the top-level start.

### AC4 — No native Git worktree creation/removal anywhere

- **Automated + Runtime:** forbidden-pattern search over `server/src`, `web/src`,
  `scripts` (production and test): the only `git worktree` matches are **comments** —
  `server/src/orca.ts:3502` ("git status for the SELECTED worktree"),
  `web/src/api.ts:467` (folder workspaces are valid exact-existing targets only), and
  `server/src/orca.test.ts:3086` ("no `git worktree` command is spawned, ever" — the
  assertion itself). No `worktree add`/`remove`/`prune` invocation exists. The only
  `rmSync` is `server/src/uninstall.ts` (the viewer's own uninstall of skill dirs and
  journals — unrelated to Orca worktrees, which are removed exclusively through
  `orca worktree rm`, exercised live in §4).

### AC5 — A failed new-worktree start never falls back to current or recreates from absence

- **Automated:** `server/src/coordinator.test.ts` — setup-failure-with-residual-resources,
  lost-response reconciliation via `request-show` + worker-list, exact-selector retry,
  and unverifiable-retry refusal (`placement` cannot be re-proven → refused).
- **Runtime (boundary):** this phase's own failed removal (§4) was preserved and
  reported verbatim, never retried blind; and the workspace-level `coordinator_conflict`
  receipt (§5, scratch viewer vs. the live implementation viewer) shows the viewer
  refusing to act while another coordinator owns the workspace — no silent takeover.

### AC6 — Same-lane tasks ordered, never concurrent, exact selector reused across restart

- **Automated:** `server/src/dag.test.ts` + `server/src/coordinator.test.ts` — lane
  seriality (unordered same-lane tasks rejected before mutation), one unsettled Dispatch
  per lane, restart adoption of a live lane worker, exact-selector continuation after
  fresh start and after viewer restart, conflicting-evidence lanes blocked.
- **Visual:** `shot-04-stagecard.png` — the lane field's hint renders the contract:
  "Tasks in one lane never run concurrently; different lanes may."

### AC7 — Same-lane retry repeats proven placement; unverifiable blocks

- **Automated:** `server/src/coordinator.test.ts` — retry repeats the lane's positively
  recovered selector; `lane_identity_unverifiable` blocks new starts instead of
  substituting a name, path, or the current workspace.

### AC8 — Cross-lane joins blocked by one visible Orca gate until `integrated`

- **Automated:** `server/src/coordinator.test.ts` — idempotent gate creation with the
  stable `[orca-dag:integration]` marker, restart adoption of the existing gate,
  duplicate prevention, unresolved-gate blocking with all dependencies complete,
  `integrated` resumption without Git mutation.
- **Visual:** no cross-lane join exists in the acceptance Run (independent leaves), so
  no gate renders — the GatePanel's integration rendering is covered by the automated
  cases above and the lanes panel's `integration_required` state in
  `web/src/components/LanesPanel.tsx`.

### AC9 — No auto-merge/commit/rebase/push/delete/force-remove

- **Automated + Runtime:** the coordinator's only cross-lane authority is the Orca gate;
  no merge/commit/push/branch-delete code path exists (§AC4 search). Removal is only
  `orca worktree rm`; the live removal refused a dirty worktree and was completed only
  through Orca's own documented `--force` path (§4), which does not delete branches.

### AC10 — OpenCode/custom legacy placement refuses non-current, no fallback

- **Automated:** `server/src/coordinator.test.ts` + `server/src/security.test.ts` —
  `lane_legacy_unsupported` / `remote_legacy_unsupported` refusals before any terminal
  or Dispatch exists; no fallback to current after `agent_unconfigured`.

### AC11 — Stop and abandon are audited, evidence-gated, and scoped to one Dispatch

- **Automated:** `server/src/app.test.ts` + `server/src/orca.test.ts` — fresh
  `worker-show` re-read before acting; abandon refused with `abandon_refused` while
  Orca proves the worker live; `502 response_lost` carries the request id for the
  request-show probe instead of a blind retry; unrelated Dispatches untouched.
- **Runtime:** the acceptance workers settled positively (`worker-show` →
  `status: completed`, terminals `exited`, capability revoked), so no stop/abandon was
  authorized or attempted — evidence gates held on live data.

### AC12 — Focus requires fresh local exact `agentWait`; remote/inexact exposes nothing

- **Automated:** `server/src/app.test.ts` — `focus_unavailable` for remote, inexact,
  stale, absent, or missing-handle cases; the focus action is not rendered without
  positive evidence.

### AC13 — Paged/exact Run discovery preserves workspace scoping

- **Runtime:** `GET /api/runs/page` returned 15 registry rows with `nextCursor: null`
  (one honest page); `GET /api/runs/:runId` answered `owned: true · evidence: "task
  creator marker"` for this workspace's Runs and `owned: false · evidence: "no task in
  this Run was created from this workspace"` for foreign Runs
  (`run_79a908e9525a`, `run_25f621fb6508`).
- **Visual:** `shot-02-exact-id.png` — exact-id lookup adopted the acceptance Run;
  `shot-10-runpicker.png` — workspace-scoped picker with search; "Load older" is
  correctly absent when Orca returns no next cursor.

### AC14 — Review through Orca; removal only via `orca worktree rm` after preconditions

- **Automated:** `server/src/app.test.ts` + `server/src/security.test.ts` — file/diff/
  open-changed path validation against the proven workspace; removal preconditions
  (`removal_evidence_required` unless Orca positively shows settled ownership);
  receipt states removed / branch-retained / archive-hook-refused / unverifiable.
- **Runtime:** §4 — removal refused on a dirty worktree, then completed through Orca
  after explicit operator review; release receipts captured for all four Dispatches.

### AC15 — Umbrella capabilities informational only

- **Automated:** `server/src/orca.test.ts` + `web/src/components/CapabilityPanel.tsx` —
  `orchestration.contract.v1` / `orchestration.federation.v1` render as known
  informational umbrella rows and never enable narrower capabilities.
- **Runtime/Visual:** this runtime advertises nothing (`advertised: null, source:
  local-runtime`), so all seven canonical rows read "Not advertised" and every control
  stays gated off (`shot-07-operations.png` / `shot-08-capabilities.png`) — support is
  never inferred from the 1.4.206 version string.

### AC16 — Tests, typecheck, build, skill validation, `npm run check` pass

- **Automated:** §2 — 468/468 tests, strict TypeScript, web build, skill validation,
  `npm run check` end-to-end, `git diff --check` clean.

### AC17 — English and Simplified Chinese docs synchronized on the new surface

- **Source:** `README.md` / `README_zh.md` updated together in this change set — the
  complete local matrix (current / exact existing / new-child / new-top-level),
  creation metadata, remote two-mode matrix, workspace lanes, integration gates,
  harness boundary (legacy refusal without fallback), per-Dispatch intervention, Run
  pagination + exact-id history, review and removal; HTTP table extended with every new
  route; code layout updated. `skill/SKILL.md` stays thin: workflow-level placement and
  integration-checkpoint guidance only, still loading the runtime-matched guide
  (`npm run check:skill` green — no mutation syntax in fenced blocks).

## 2. Automated checks (this phase)

| Check | Result |
| --- | --- |
| `npm run check` (skill → typecheck → 468 tests → web build) | **PASS** |
| `npm run check:skill` | **PASS** (`✅ skill/SKILL.md ok`) |
| `git diff --check` | **PASS** (clean) |
| Forbidden-pattern search (`git worktree`, recursive deletion, selector reconstruction) | **PASS** — comment-only matches, documented in AC4 |

## 3. Live Orca IDE acceptance — placement matrix (runtime receipts)

Throwaway Run `run_9cf628fa883b` (objective: "orca-dag docs acceptance: placement matrix
live validation"). One parallel wave of four supervised `worker-start` calls, mirroring
the viewer's argv (`--task … --agent claude --worktree … --run … --from … --retry-request
<uuid>`), dispatched from a throwaway coordinator terminal bound with `run-use` (the
viewer's own `asCoordinator` pattern; this worker terminal is itself a dispatched worker
at depth 1, and Orca correctly refused sub-worker dispatch from it with
`nested_worker_depth_exceeded` — receipts retained).

| Mode | Task / Dispatch | Worktree effect | Setup | Worker `pwd` proof |
| --- | --- | --- | --- | --- |
| `current` | `task_b91a9b4e33b7` / `ctx_6a9e51b4c7cf` | `reused` → `1fc5325b…::/home/tyjt/桌面/Orca-dag` | `not_applicable` | `/home/tyjt/桌面/Orca-dag`, branch `main` |
| exact existing | `task_f4cd7f989d62` / `ctx_dadbcc869bf6` | `reused` → `1fc5325b…::/home/tyjt/桌面/Orca-dag` (selector as discovered) | `not_applicable` | `/home/tyjt/桌面/Orca-dag`, branch `main` |
| `new-child` | `task_a1b8a353a951` / `ctx_5c1e6267dee0` | `created_child` → `1fc5325b…::/home/tyjt/orca/workspaces/Orca-dag/accept-child` | `requested: run → effective: run` (`hookFound: true`) | `/home/tyjt/orca/workspaces/Orca-dag/accept-child`, branch `feat/accept-child` |
| `new-top-level` | `task_150accb39b88` / `ctx_a5438ad6b38d` | `created_top_level` → `1fc5325b…::/home/tyjt/orca/workspaces/Orca-dag/accept-toplevel` | `requested: run → effective: run` | `/home/tyjt/orca/workspaces/Orca-dag/accept-toplevel`, branch `feat/accept-toplevel` |

Creation metadata on the two created worktrees: explicit name (`accept-child`) /
derived-name path (top-level), display names `accept: stacked child` / `accept: top
level`, comment `orca-dag docs acceptance`, `--setup run`, exact repo selector on the
top-level start. Every worker reported `outcome: succeeded` with a read-only probe
(`pwd` + `git rev-parse --abbrev-ref HEAD`) — the `pwd` output above is the worker's own
proof of **effective** placement, matching the receipt's worktree effect exactly.

Orca IDE lineage after creation (`orca worktree list`): `accept-child` showed
`parentWorktreeId = 1fc5325b…` with populated `lineage`; `accept-toplevel` showed
`parentWorktreeId = null` (independent).

## 4. Cleanup ledger — every resource accounted for

| Resource | Final state | How |
| --- | --- | --- |
| Worktree `…/accept-child` | **Orca-removed** | `orca worktree rm --worktree <exact-selector>` — first attempt **refused** (`Failed to delete worktree … M package-lock.json`), receipt retained; after operator inspection (below) completed with Orca's documented `--force --run-hooks`; result `{"removed": true}` |
| Worktree `…/accept-toplevel` | **Orca-removed** | same path — `{"removed": true}` |
| Branches `feat/accept-child`, `feat/accept-toplevel` | removed by Orca's removal path | verified **before** removal: `git log main..HEAD` empty in both worktrees — zero commits, no authored work existed; the only dirty content was a machine-generated `package-lock.json` normalization produced by the setup hook Orca itself ran |
| Four probe Dispatches | settled (`completed`), terminals released | `worker-release` × 4: two `released` (`processAction: closed_agent_terminal`, archive captured), two `release_unknown` → reconciled by re-read (`worker-show`: terminal `status: "exited"`, `exactWorker: true`) — resolved by evidence, never a blind retry |
| Throwaway coordinator terminal `term_be148770…` | closed | `orca terminal close` (the `asCoordinator` bind → act → close pattern); Run binding released |
| Tasks `task_34654e4e426a`, `task_a2f9e6e54d71`, `task_70cefeae6b90`, `task_dfdcc742036c` | **retained, never dispatched** | planning-side duplicates: a `task-create` loop succeeded server-side while its output parsing failed, and the loop was re-run — an operator error, not a worker or source behavior. They remain `ready` in the throwaway Run as history (Orca has no single-task delete); no worker, gate, or request was ever attached to them |
| Run `run_9cf628fa883b` | retained as history | throwaway acceptance Run; 4 completed + 4 explained never-dispatched tasks; no gates; no live workers; no residual worktrees |
| Production viewer (`:8787`) and implementation Run `run_9f2ef2b42156` | **untouched** | the scratch viewer's start attempt against the same workspace answered `409 coordinator_conflict` (receipt in §5) — the safety boundary held and was honored |

## 5. Browser verification log (visual)

Scratch viewer `127.0.0.1:8821` (workdir = repo root, web build under test), agent-browser/CDP
at 1440×900. Read-only pass: no config values were changed, no run started.

- `shot-01-initial.png` — implementation Run renders with status legend, scheduler card
  ("Wave · 0 ready", honest "worker capacity unknown" while not coordinating), per-node
  harness badges; amber **External coordinator** badge for the Run another viewer owns.
- `shot-02-exact-id.png` — exact-ID lookup opens the acceptance Run: 8 tasks (4 Done,
  4 Ready), scheduler READY QUEUE lists the never-dispatched duplicates in id order
  ("Id order — equally ready tasks are equally dispatchable").
- `shot-03/04-stagecard.png` — Stage card: Harness / **Environment** / **Workspace
  lane** ("Tasks in one lane never run concurrently; different lanes may.") /
  **Placement (local workspace)** / Model / retain checkbox / spec preview.
- `shot-05-local-modes.png` — local placement picker: **Current workspace (default) /
  Existing workspace… / New child worktree… / New top-level worktree…** — the
  four-choice matrix.
- `shot-06-activity.png` — Activity timeline: four worker completions with UNREAD
  badges, stage links, expandable Technical details.
- `shot-07-operations.png` — Operations tab: **Workers · durable fleet view · 4 of 4**
  with honest liveness (EXITED for confirmed terminal closes, UNVERIFIABLE for the two
  `release_unknown` rows — a non-coordinating viewer never guesses liveness),
  succeeded · local (this server) · released/release_unknown provenance; **Workspace
  lanes** panel with its empty state ("No lanes are configured for this Run.");
  **Runtime capabilities** panel with the never-guess disclaimer, all rows "Not
  advertised" on this non-advertising runtime.
- `shot-09-run-dialog.png` — the fencing confirmation: "Let Viewer coordinate this
  Run? … Any agent terminal currently coordinating this Run will be fenced …" with the
  reclaim command and Not now / Start Run. **Cancelled** — no mutation fired.
- `shot-10-runpicker.png` — workspace-scoped Run picker with search; "Load older" is
  absent when Orca returns no next cursor (honest pagination).

Environment limits recorded honestly: no saved connected environments exist on this
Orca instance, so the remote two-mode editor could not be exercised visually (covered
by the automated matrix tests); the umbrella capability rows have no live advertisement
to render (AC15).

## 6. Demonstrated source defect — FAILED acceptance result (viewer-path exact-existing)

**Finding:** the HTTP-boundary selector validator rejects the exact selectors the
viewer's own discovery returns on this machine, so the **viewer-path exact-existing
mode cannot start on workspaces with non-ASCII paths** (this machine's workspace path
contains `桌面`).

Evidence chain:

1. `GET /api/worktrees` (backed by `orca worktree list`) returns the local workspace as
   `{"id": "1fc5325b-aa02-4f2a-a656-a2dcb0262947::/home/tyjt/桌面/Orca-dag", …}` — the
   PlacementEditor stores this string verbatim as `existing.selector`.
2. `server/src/security.ts` `SELECTOR_PATTERN`
   (`/^[A-Za-z0-9][A-Za-z0-9._:@/\\-]{0,255}$/`) allows only ASCII selector characters;
   every spelling of this workspace's path (`<repoId>::<path>`, `id:<repoId>::<path>`,
   `path:<path>`) fails on the CJK characters, while an ASCII-path control passes.
3. Live receipts: `PUT /api/config` and `POST /api/run` with the discovered selector
   both answer `400 {"code":"invalid_selector","error":"… must look like an Orca
   selector (got \"1fc5325b-…::/home/tyjt/桌面/Orca-dag\")"}`; the identical request
   with an ASCII-only path passes this layer (and proceeds to the next gate).
4. The **runtime contract is sound**: the same selector sent directly to
   `worker-start` (bypassing the viewer) was accepted and produced the `reused`
   worktree effect with correct placement (§3). The defect is localized to the viewer's
   validation character class; `shell: false` argv passing means non-ASCII selectors
   pose no shell-metacharacter risk.
5. No test covers non-ASCII paths (`server/src/security.test.ts` has no such case).

**Consequence for this phase:** AC1's UI-plus-validation chain and phase-6 scenario 2
are **not fully accepted** for the exact-existing mode on non-ASCII workspaces; the
documentation in `README.md`/`README_zh.md` describes the intended contract and is not
changed by this finding. Per ownership rules this task reports the defect instead of
editing source; the fix belongs to the selector-validator owner (widen the character
class to non-control, non-whitespace, non-shell-metacharacter Unicode, or normalize via
Orca's identity form) with a regression test for CJK paths.

## 7. Constraints compliance

- Worktree creation only through `orca orchestration worker-start` (§3 receipts);
  removal only through `orca worktree rm` (§4 receipts). No native Git worktree
  command, direct deletion, merge, rebase, reset, commit, tag, push, or publish was
  executed (AC4 search + this phase's shell history).
- No generated or runtime artifact was edited or committed (`.orca-dag.config.json`,
  journals, `dist/`, embedded assets all untouched/uncommitted; the one config `PUT`
  attempt was **rejected by the server** and changed nothing).
- Failures are preserved, not papered over: the removal refusal, the two
  `release_unknown` reconciliations, the `nested_worker_depth_exceeded` boundary, the
  `coordinator_conflict`, and the duplicate-task operator error are all recorded here
  with receipts rather than cleaned away.
- The published skill stays thin and runtime-matched (`npm run check:skill` green).
