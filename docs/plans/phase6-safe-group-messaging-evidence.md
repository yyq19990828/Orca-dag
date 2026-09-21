# Phase 6 evidence — safe group messaging (operations epic)

Status: complete
Executed: 2026-09-21 (single dispatched worker session)
Task: `task_bbeea766b83a` · Dispatch: `ctx_dadeef19c649` · Run: `run_25f621fb6508`
Plan: `docs/plans/1789983824_phase-6-safe-group-messaging.md`

Not to be confused with `phase6-evidence.md`, which covers Phase 6 of the
older hardening epic (connected-server placement).

## What was implemented

**Boundary (`server/src/security.ts`)**
- `validateGroupAudience` — grammar-only allowlist: `@all`, `@idle`,
  `@<KNOWN_HARNESSES>`, `@worktree:<non-empty id>`. Everything else is
  `invalid_audience` — arbitrary addresses, `run:`/`dispatch:`/handle
  cross-Run targets, lifecycle pseudo-groups (`@worker_done`) — rejected
  before any Orca call.
- `assertDiscoveredWorktreeAudience` — the exactness gate. Takes a LAZY
  discovery callback so only worktree audiences spend a `worktree list`
  read; a well-formed but undiscovered id is `unknown_audience`; a failed
  discovery fails CLOSED (unverifiable workspace ≠ recipient).
- `validateGroupMessageType` — `status` | `question` only; `worker_done` /
  `heartbeat` get a dedicated `forbidden_group_type` (lifecycle signals are
  exact-Dispatch by Orca contract), everything else `invalid_message_type`.
- `validateGroupMessagePriority` — `low|normal|high|urgent` (case-folded),
  absent → null.

**Adapter (`server/src/orca.ts`)**
- `sendCoordinatorGroupMessage` — the only place a group `--to` is composed.
  argv pinned in tests: `--to <audience> --run <runId> --from <handle>
  --subject --body --type [--priority]`. Deliberately NO `--task-id` /
  `--dispatch-id` (a group message has no single attempt).
- `previewRunAudiences` — pure estimate builder from Run-scoped worker rows +
  discovered worktrees. Only `dispatchStatus === "dispatched"` rows count;
  `@idle` narrows by stage-activity/attention signals; harness groups are
  offered only with ≥1 active match; worktree groups appear only for exact
  discovered ids. Every option ships `exact: false` — Orca exposes no
  group-membership read, so counts are estimates by construction.

**Activity (`server/src/activity.ts`)**
- `ActivityEvent.audience` (null on one-to-one rows). `normalizeMessage`
  treats an `@`-prefixed `to_handle` as an OUTGOING coordinator row and keeps
  the address in the title ("Coordinator messaged @all"), so the
  authoritative Orca row renders with the same audience provenance as the
  optimistic journal row.
- `removeJournalMessageDuplicates` — journal group rows (no Task/Dispatch
  identity) are superseded by the durable row via audience + body + 15 s
  window; one-to-one matching unchanged.
- `createViewerActivity` accepts `audience` / `priority` / `payload` (the
  raw accepted enqueue receipt is journaled verbatim); `hydrateEvent`
  normalizes the new field on pre-Phase-6 journal rows.

**API (`server/src/app.ts`)**
- `GET /api/audiences?run=` (read-only, token-free like every read): preview
  + `coordinatorActive` flag. Reads run under `Promise.allSettled`; failures
  surface as explicit `workersError` / `worktreesError` fields with an empty
  audience list — absence of evidence is never rendered as "no audiences".
- `POST /api/messages/group` — gate order: token → shape validation → FRESH
  discovery + exact worktree membership → execution gate → live-coordinator
  check (this viewer's own coordinator terminal for the selected Run; never
  a borrowed throwaway, which would fence a real coordinator) → send →
  journal the accepted enqueue receipt.

**Web (`web/src/types.ts`, `api.ts`, `components/ChatPanel.tsx`, `styles.css`)**
- Run-control group composer: audience/type/priority `DoodleSelect`s fed
  ONLY by the preview endpoint (recipients are chosen, never typed),
  optional subject, estimate line capped at six named stages with the
  estimate caveat, and the enqueue-only note under the composer.
- In-app confirmation via `DecisionDialog.confirm` for every group send,
  stating recipient estimate, enqueue-only guarantee, and that the count is
  not a confirmed delivery list.
- Distinct outgoing group bubbles: double-ruled `chat-message--group`
  border, `To <audience>` chip, requested-priority chip (non-normal only),
  "Enqueued — delivery to each recipient is not proven" note; a failed
  preview renders "Audience discovery failed", not an eternal spinner.

## Acceptance mapping

| Criterion (plan) | Evidence |
| --- | --- |
| Reject arbitrary addresses | security.test.ts `rejects arbitrary, cross-Run and lifecycle recipient shapes outright`; app.test.ts 400 `invalid_audience` for `dispatch:`/`run:`/handle/`@kernel`. |
| Reject inactive coordinator | app.test.ts 409 `not_running` on a valid request; live: 409 for both `@all` and an exact discovered `@worktree:` address. |
| Forbid lifecycle group messages | security.test.ts + app.test.ts 400 `forbidden_group_type` for `worker_done`/`heartbeat`. |
| Accept allowlisted Run groups + exact discovered worktree groups | security.test.ts accepts `@all`/`@idle`/harness groups/well-formed `@worktree:`; membership gate accepts exact ids, refuses `unknown_audience`, and proves non-worktree shapes never spend a discovery read; orca.test.ts pins the group-send argv (incl. priority as one argv value, no attempt ids). |
| Audience preview from current Run facts, labeled estimate | orca.test.ts preview suite (dispatch-only recipients, `exact: false` on every option); UI estimate line + hint text. |
| In-app confirmation + enqueue-only wording | ChatPanel `dialog.confirm` copy; composer note; per-bubble enqueue provenance. |
| Outgoing group messages retain audience, priority, provenance | journal row carries audience + requested priority + raw receipt payload; authoritative row echoes `to_handle`; both render chips. |
| `npm run check` passes | final run: skill check + typecheck + 333/333 tests + web build, all green. |

## Live verification (real Orca 1.4.206, read-only paths)

Booted the viewer (`NO_OPEN=1 PORT=8791 npx tsx server/src/index.ts`) and:

- `GET /api/audiences?run=run_25f621fb6508` → `@all` (1 estimated recipient:
  this dispatch), `@idle` (0), two exact `@worktree:<id>` audiences with
  display names, `coordinatorActive: false`, both error fields null.
- Boundary POSTs, in order: no token → 403 `invalid_token`;
  `dispatch:ctx_x` → 400 `invalid_audience`; `type: worker_done` → 400
  `forbidden_group_type`; `@worktree:nope` → 400 `unknown_audience`; valid
  `@all` and valid discovered-worktree requests → 409 `not_running`. No
  message was sent and no coordinator was touched.

## Scope check and limitations

Modified set is exactly the plan's likely-files list (server
orca/security/app + tests, web types/api/ChatPanel/styles). Nothing
committed, nothing delegated, prior phases untouched.

1. Recipient counts stay estimates — Orca exposes no group-membership read;
   `exact` exists in the wire shape so a future runtime can flip it per
   audience without a UI change.
2. The authority gate is proven at the 409 level; a live second-coordinator
   send was deliberately NOT attempted (it would fence the real coordinator).
3. Journal→authoritative dedupe for group rows relies on Orca echoing
   `to_handle` verbatim; a normalized variant would show both rows (cosmetic,
   and the authoritative row always wins the thread).
4. The preview is fetched on Run-control open / coordination change / after
   each send — not polled; estimates can lag fleet churn by seconds.
