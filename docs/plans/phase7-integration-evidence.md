# Phase 7 evidence: integration, documentation and acceptance

Governing documents: `1789983818_orca-orchestration-operations-epic.md` (Epic) and
`1789983825_phase-7-integration-docs-and-acceptance.md` (this phase).

**Evidence classes, kept separate on purpose** (per the phase constraints):

- **Automated** — Node test-runner assertions against a fake `orca` executable or pure
  functions. Deterministic; establish lifecycle and boundary behavior.
- **Runtime** — read-only observations against the real Orca 1.4.206 runtime during this
  phase (`/api/*` responses on a scratch viewer at `127.0.0.1:8821`, since shut down).
  Establish that the adapters answer honestly on the live runtime.
- **Visual** — browser screenshots (agent-browser/CDP, 1440×900 desktop viewport) of the
  built SPA served by that viewer. Establish presentation behavior only. Screenshots live
  in `/tmp/opencode/` and are deliberately **not** committed (no generated artifacts in Git).

Headline checks (this phase): `npm run check` green, `git diff --check` clean, focused
suites green (338 server tests after this phase's additions; see §3 for the new ones).

---

## 1. Epic acceptance criteria → evidence

### AC1 — Canonical 1.4.206 capabilities recognized and tested; unknown capabilities stay gated off

- **Automated:** `server/src/orca.test.ts` — "unproven capabilities are absent, never
  assumed", "keeps unknown capabilities unsupported and reports them verbatim", and the
  alias-table cases (`describeRuntimeCapabilities`); `server/src/runHealth.test.ts` —
  "GET /api/capabilities → projects the canonical table without inventing local support".
- **Runtime:** `GET /api/capabilities` on 1.4.206 returned `advertised: null,
  advertisedSource: "local-runtime"` with every canonical capability `absent` — the local
  runtime exposes no advertisement, and the viewer gated everything off rather than
  inferring support from the version.
- **Visual:** `phase7-05-operations-open.png` — "Runtime capabilities" panel renders the
  disclaimer ("…so every capability below reads 'Not advertised' — the viewer treats that
  as unsupported, never as a guess from the version number") with all rows "Not advertised".

### AC2 — `zai-coding-plan/glm-5.3-flash#high` passes validation and stays one quoted argv value

- **Automated:** `server/src/security.test.ts` — "accepts the bounded #variant suffix for
  opencode, including zai-coding-plan/glm-5.3-flash#high"; "rejects malformed or
  shell-shaped #variant suffixes (epic A4)" (space, double `#`, trailing `/x`);
  `server/src/app.test.ts` — "rejects malformed opencode models against the
  provider/model grammar"; `server/src/orca.test.ts` — `listModels` filter accepts the
  variant grammar so the enumerated picker round-trips the same shape. The opencode path
  quotes the model as a single `execFile` argv element (`shell: false`).
- **Runtime:** this Run itself was dispatched with
  `zai-coding-plan/glm-5.3-flash#high` (see the Epic's Required model header and the Run
  objective); the live Activity timeline renders the actor model with the variant intact.
- **Visual:** `phase7-02-activity-open.png` — heartbeat rows carry the stage link; the
  actor/model summary is rendered from runtime-observed facts.

### AC3 — The selected Run visibly distinguishes viewer-owned, external, unbound and inconsistent states

- **Automated:** `server/src/runHealth.test.ts` — `evaluateRunOwnership` cases
  (`viewer_coordinator`, `viewer_coordinator_other_run`, `external_coordinator`,
  `unbound`, `unverifiable`/inconsistent) plus HTTP cases "reports an external
  coordinator from the run-show binding", "reports an unbound Run", "degrades to
  unverifiable when the Run record cannot be read".
- **Runtime:** the Epic Run answered `ownership: "external_coordinator"` with the real
  bound handle `term_4bf55960-c36a-4b4a-8613-8d75ad7801ad · generation 1`; a foreign
  empty Run (`run_b93c836ca6a0`, tasks 0 / messages 23) answered `unbound`.
- **Visual:** `phase7-01-initial.png` (amber "External coordinator" badge) and
  `phase7-07-runhealth.png` (popover: OWNERSHIP handle + generation, EVIDENCE counts
  "Tasks 7 · Messages 34 · Workers 7 · Gates 0 (0 pending)", the fencing explanation,
  and "No warnings — the reads that back this view all succeeded").

### AC4 — Historical workers remain inspectable after a viewer restart or on a non-coordinating viewer

- **Automated:** `server/src/orca.test.ts` — the two-instance durable-history cases
  (a second viewer instance reads `run_durable` workers it never dispatched, lines ~2539);
  `server/src/coordinator.test.ts` — worker-list projection with remote rows.
- **Runtime:** `/api/workers?run=run_25f621fb6508` on this viewer — which coordinates
  nothing — returned all 7 phase workers with dispatch ids, terminal states and attention
  flags (`root_completion`), none of which this process created.
- **Visual:** `phase7-05-operations-open.png` — "Workers · durable fleet view · 7 of 7
  workers", every row `UNVERIFIABLE` (honest: this viewer does not own the Run), with
  `succeeded · unsupervised · local (this server) · retained` provenance per row.

### AC5 — Worker detail presents `worker-show` evidence without treating PTY liveness as agent liveness; documented fleet gaps show qualified live evidence

- **Automated:** `server/src/orca.test.ts` — "qualifies a missing_status gap when the
  exact observation proves live", "qualifies a capability_unsupported gap the same way",
  plus the negative case (a generic fleet observation must NOT qualify); scope-boundary
  cases for `/api/workers/:dispatchId` in `server/src/app.test.ts` ("validates
  worker-detail scope and ids before invoking Orca").
- **Runtime:** worker rows on the live Run render liveness `unverifiable` (not `exited`)
  because the coordinating terminal is external — absence of proof is never read as exit.
- **Visual:** `phase7-03-chat.png` — the stage runtime line "Agent working · terminal
  live · supervised liveness unav…(ilable)" shows the same qualified-liveness discipline
  in the conversation surface.

### AC6 — Chat renders thread, priority and unread semantics; warns when completeness is unprovable

- **Automated:** `server/src/chatHistory.test.ts` — "threads question/reply/ack through
  the API with priority and tri-state read"; the inbox-window completeness cases
  (`saturated` flag drives the warning; absence of the flag renders no claim).
- **Runtime:** `/api/activity` returned `inboxWindow: {limit: 5000, observed: 839,
  saturated: false}` — completeness metadata always travels; the warning correctly does
  not render for an unsaturated window.
- **Visual:** `phase7-04-operations.png` — the coordinator correction message renders an
  **UNREAD** badge in the timeline; `phase7-03-chat.png` — conversation list with unread
  dots per stage. (The saturated-window banner itself was not reachable visually — no
  saturated inbox exists on this machine; see §5.)

### AC7 — Parent/child structure and dependency edges visually distinct; next ready wave readable

- **Automated:** `server/src/dag.test.ts` — hierarchy links vs dependency edges,
  ready-wave and per-stage readiness-reason cases.
- **Visual:** `phase7-01-initial.png` — the legend distinguishes "→ dependency" from
  "⋯ parent" with the **Hide parent links** toggle; the **Scheduler** card shows
  "Wave · 0 ready" plus the honest capacity line "Viewer coordinator not running this
  Run — worker capacity unknown" and "Nothing waiting — every task has run or is
  running." (`phase7-06-nodepanel.png` shows the node card repeating readiness: "This
  task has already completed — nothing left to schedule.")

### AC8 — Mutation request receipts and archived output inspectable without replaying a mutation

- **Automated:** `server/src/requestAudit.test.ts` — ledger list + `request-show` probe
  states (`completed` / `pending` / `absent` / `unknown`), Run-scoping and
  cross-Run-404 cases; `server/src/requestLedger.test.ts` — bounded, atomic,
  metadata-only ledger; `server/src/coordinator.test.ts` — bounded output reads
  (`/output?source=…`, cursor staleness, clamp cases, lines ~1539–1577).
- **Runtime:** this workspace has no `.orca-dag.requests.jsonl` (this Run was coordinated
  by Orca's own coordinator, not a viewer), so the audit panel correctly renders nothing —
  an empty ledger is not faked.
- **Visual:** not exercisable without performing real mutations from this viewer
  (deliberately not done — see §5); presentation is covered by the automated surface
  above and Phase 5's evidence doc.

### AC9 — Group guidance allowlisted, authority-gated, visibly distinct from one-to-one guidance

- **Automated:** `server/src/app.test.ts` — "Phase 6: safe group messaging boundaries"
  (token 403, `invalid_audience` for arbitrary/cross-Run shapes, `unknown_audience` for
  undiscovered worktrees, `forbidden_group_type` for lifecycle signals,
  `invalid_priority`, `409 not_running` when not the live coordinator); plus this phase's
  new boundary tests for `/api/audiences` (§3).
- **Runtime:** `GET /api/audiences?run=…` shape verified (§3 new test asserts the
  degraded-empty-list contract; the live server exposes the same endpoint).
- **Visual:** `phase7-03-chat.png` — the compose area states "Start this Run's
  coordinator to send guidance to its active Dispatch." — the broadcast controls are
  authority-gated in the exact state an external-coordinator Run should show.

### AC10 — Server tests cover new adapters and HTTP boundaries; `npm run check` passes

- All suites green this phase: `npm test -w server` (338 passing after this phase's
  additions) and the full `npm run check`
  (skill validation → typecheck → tests → web build). `git diff --check` clean.

### AC11 — README documentation explains the new operations surfaces and epistemic limits

- `README.md` and `README_zh.md` updated **together** in this phase: new feature bullets
  (Run health badge, runtime capability matrix, faithful conversation semantics +
  completeness warning, coordinator group messaging) and five new HTTP rows
  (`/api/capabilities`, `/api/run-health`, `GET /api/workers/:dispatchId`,
  `/api/audiences`, `POST /api/messages/group`), each stating its epistemic limit
  (never guess recipients, "Sent" ≠ read, degraded discovery ≠ guessed list).

---

## 2. Phase 7 required acceptance scenarios → evidence

| # | Scenario | Evidence |
| --- | --- | --- |
| 1 | Empty Run with retained messages | **Automated:** `runHealth.test.ts` "explains an empty-with-history Run instead of looking like a rendering bug" (`messages_without_tasks` warning). **Runtime:** `run_b93c836ca6a0` → `unbound, tasks 0, messages 23`. |
| 2 | Viewer-owned, external and unbound coordinator states | **Automated:** `runHealth.test.ts` ownership matrix + live-loop case. **Runtime/Visual:** external state on the Epic Run (`phase7-01/07`), unbound on the foreign Run (API). Viewer-owned covered by `runHealth.test.ts` "reports viewer_coordinator when the loop's handle is the bound one" — this viewer intentionally never took over the Run (it would fence the real coordinator). |
| 3 | Historical released worker and live unverifiable remote worker | **Automated:** `orca.test.ts` durable two-instance history; `coordinator.test.ts` remote/unverifiable liveness. **Visual:** `phase7-05-operations-open.png` — 7 historical rows incl. released/retained states, all `UNVERIFIABLE` here. |
| 4 | Agent-wait detail present, absent and unknown | **Automated:** `orca.test.ts` worker-detail/observation qualification cases (present / absent / `missing_status` / `capability_unsupported` paths). **Visual:** qualified liveness line in `phase7-03-chat.png`. |
| 5 | Threaded urgent question and coordinator reply | **Automated:** `chatHistory.test.ts` threaded question/reply/ack with priority + read state; `coordinator.test.ts` reply routing (`/api/messages/:id/reply`). **Runtime:** the Run's own thread history (34 messages) renders threaded in Chat — `phase7-03/04`. |
| 6 | Saturated inbox completeness warning | **Automated:** `chatHistory.test.ts` completeness cases (warning only when the observed window is saturated). **Runtime:** unsaturated here (`observed 839 / limit 5000`) → metadata present, warning correctly absent. Banner not visually reachable (§5). |
| 7 | Parent task plus dependency edges and a blocked gate | **Automated:** `dag.test.ts` hierarchy + readiness/blocked-gate reasons. **Visual:** dependency/parent legend + Scheduler wave card (`phase7-01`); this Run has no pending gate ("Gates 0 (0 pending)" in `phase7-07`), so a blocked-gate card is covered by tests, not pixels. |
| 8 | Completed and absent request receipts | **Automated:** `requestAudit.test.ts` — `completed` and `absent` probe states + "absence is NOT proof the mutation did not happen" labeling; unknown-on-probe-failure. Runtime/visual: no viewer ledger exists here (AC8). |
| 9 | Confirmed `@all` guidance with enqueue-only wording | **Automated:** `app.test.ts` group boundaries (audience allowlist, forbidden lifecycle types, 409 authority gate); ChatPanel renders the requested priority on the bubble and journals the *enqueue receipt* as provenance, superseded by the durable row. **Visual:** authority-gated compose in `phase7-03-chat.png`. The confirmed-send dialog itself requires coordinating authority — not exercised live (§5). |
| 10 | OpenCode model `zai-coding-plan/glm-5.3-flash#high` preserved through validation and launch construction | **Automated:** `security.test.ts` variant grammar round-trip; `orca.test.ts` `listModels` grammar; single-quoted-argv launch construction (`shell: false`). **Runtime:** this very dispatch runs on that model id (Epic header). |

---

## 3. What Phase 7 changed (integration diff)

- **Deduplication without losing why-comments:** finished the interrupted
  `web/src/format.ts` extraction — one module now owns `formatClock` / `formatDateTime` /
  `formatTimestamp` / `timeAgo` / `isUrgent` / `priorityLabel`. `ChatPanel.tsx` (its 8
  orphaned call sites were still referencing deleted locals — the tree did not typecheck),
  `ActivityPanel.tsx`, `RequestAuditPanel.tsx`, `InboxPanel.tsx` and `NodePanel.tsx` all
  import from it now; the load-bearing comments (e.g. "only Orca's own high/urgent
  priorities may render the urgent flag") moved with the code into `format.ts`. No Orca
  why-comments were stripped; no server-side duplication found worth collapsing (the
  server/web type mirrors are deliberate view contracts).
- **New HTTP-boundary regression tests** (`server/src/app.test.ts`, "integration:
  remaining HTTP boundaries"): `/api/audiences` Run-scope validation + degraded-empty-list
  shape; `/api/workers/:dispatchId/retain` and `/retry` token + id validation before any
  Orca work; `/api/models/:harness` non-enumerable fallback + name normalization. All
  fire before the execution gate, so they hold with or without an `orca`/`opencode` on
  PATH.
- **Docs:** README.md + README_zh.md as described in AC11.
- **Scope discipline:** Activity/Chat (communication center), Worker Operations
  (Operational details), Run Health (top-bar badge + popover) and the DAG Ready Queue
  (Scheduler card) remain separate surfaces; Phase 7 only wired shared presentation
  helpers between them.

## 4. Phase outcomes 1–7 (all explicit)

| Phase | Outcome | Evidence |
| --- | --- | --- |
| 1 Capability + Run health | Capability matrix + `/api/run-health` + ownership badge | `phase2-evidence.md` §Phase 1, this doc AC1/AC3 |
| 2 Durable worker operations | `worker-list`-backed fleet + `/api/workers/:dispatchId` | `phase2-evidence.md`, AC4/AC5 |
| 3 Threaded chat + history integrity | Thread/priority/read semantics + completeness metadata | `phase3-evidence.md`, AC6 |
| 4 DAG hierarchy + ready waves | Parent/child grammar + wave/readiness reasons + safe retry | `phase4-dag-hierarchy-evidence.md`, `phase4-handoff-fenced-worker.md`, AC7 |
| 5 Recovery + output audit | Request ledger + `request-show` receipts + bounded sourced output | `phase5-evidence.md`, `phase5-recovery-output-audit-evidence.md`, AC8 |
| 6 Safe group messaging | Allowlisted, confirmed, authority-gated broadcast | `phase6-evidence.md`, `phase6-safe-group-messaging-evidence.md`, AC9 |
| 7 Integration + acceptance | This document; dedup, boundary tests, docs, visual pass | `npm run check` green, `git diff --check` clean |

## 5. Honest limitations

- **Viewer-owned Run state and the confirmed group-send dialog were not exercised
  visually.** The Epic Run is coordinated by the real Orca coordinator; taking it over
  would fence the user's coordinator, and starting a viewer coordinator or sending group
  mail are real mutations. Both paths are covered by automated tests
  (`runHealth.test.ts` live-loop case; `app.test.ts` group boundaries).
- **The saturated-inbox warning banner was not reachable visually** (this machine's
  global inbox is at 839/5000). Covered by `chatHistory.test.ts`.
- **No gate existed in the Run during the visual pass**, so the blocked-gate card is
  evidenced by `dag.test.ts`, not by a screenshot.
- **The foreign empty Run (`run_b93c836ca6a0`) is not selectable in the picker** —
  workspace scoping is designed behavior — so its empty-with-messages state is evidenced
  via the health API + automated tests rather than a screenshot.
- **Cleanup debt from this phase: none.** The scratch viewer ran on a private port with
  `NO_OPEN=1`, created no coordinator terminal (verified via `orca terminal list`), and
  was shut down; screenshots live outside the repo.

## 6. Verification record (this phase)

- `npx tsc -b web` — green (failed with 9 errors before the ChatPanel fix; the tree did
  not typecheck on arrival).
- `npm test -w server` — all suites green (app, security, coordinator, orca, runHealth,
  chatHistory, dag, activity, requestAudit, requestLedger, config).
- `npm run check` — skill validation → typecheck → tests → web build, green.
- `git diff --check` — clean (no whitespace/conflict-marker noise).
- Visual pass — 9 screenshots at 1440×900 covering: initial DAG + badges, Activity
  open/refit, Chat conversations, unread + operational details, durable fleet + capability
  matrix, Node panel + launch lock, Run-health popover, force layout, panel close + refit.
