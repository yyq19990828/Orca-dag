# Workspace Artifacts, Protocol Semantics & Troubleshooting

## 1. `.orca-dag/` Directory & State Governance

Both **human planning documents** and **viewer runtime state** share `.orca-dag/`, separated cleanly by structure:

| Path | Owner | Purpose & lifecycle policy |
| :--- | :--- | :--- |
| `.orca-dag/<UTC YYYYMMDD-HHmmss-SSS>/PRD.md` & `TECH_SPEC.md` | Agent (`orca-dag` skill) | Per-plan design docs. Created exclusively per new Run/replan. **Always preserved — even by `uninstall --purge`.** |
| `.orca-dag/config.json` | Viewer | Harness, model, effort, placement, lane, layout, concurrency, active `runId` |
| `.orca-dag/activity.jsonl` | Viewer | Run activity & coordinator check history |
| `.orca-dag/launches.jsonl` | Viewer | Dispatch-scoped historical launch identity (`harness`, `model`, `effort`, `worktree`, `worktreeName`, `branch`) |
| `.orca-dag/requests.jsonl` | Viewer | Mutation request ID audit ledger |
| `.orca-dag/sessions.json` | Viewer | Provider session bindings + critical recovery journals (`mailboxChecks`, `guidanceSends`, `operatorMessages`, `resumeAttempts`) + `openCodeLaunches` |
| `<skill-dir>/USER_PREFERENCES.md` | Agent (`orca-dag` skill) | Persistent cross-project workflow defaults; preserved on upgrade & ordinary `uninstall`, removed only with `--purge` |

### Key State & Safety Rules
1. **Never hand-edit viewer state stores** during planning.
2. **No hot-downgrades on `sessions.json`**: The critical recovery journals (`mailboxChecks`, `guidanceSends`, `operatorMessages`, `resumeAttempts`) serve as recovery authority, not rotating logs. Older viewer versions that lack support for newer journal schemas will fail safely; always stop older viewers cleanly before upgrading.
3. **Private plugin registry**: Endpoint discovery for `orchestration-panel` lives in the private per-user plugin registry (never a workspace API artifact).
4. **Legacy migration**: Running a modern viewer migrates legacy root `.orca-dag.*` files byte-for-byte into `.orca-dag/` after acquiring its HTTP port without overwriting existing destinations. Historical `.orca/` planning folders stay untouched.
5. **`.gitignore` & `uninstall` symmetry**:
   - `npx orca-orchestration-launcher` adds an exact managed `# >>> orca-dag planning artifacts (managed)` / `.orca-dag/` block unless `--no-workspace-init` (standalone plugin does **not** edit `.gitignore` — check before planning).
   - `npx orca-orchestration-launcher uninstall` removes installed skill files (keeping `USER_PREFERENCES.md` unless `--purge`), removes private registry entries & orphaned `orca-dag coordinator` terminals, removes exact managed `.gitignore` blocks, keeps state files unless `--purge`, and **always preserves** `.orca-dag/<timestamp>/` and legacy `.orca/` planning documents.

---

## 2. Runtime Protocol & Mailbox Semantics Reference

- **Protocol numbers**: Official public Orca orchestration contract is `contract 1` (`orchestration.contract.v1`); runtime protocol is `3`; federation lifecycle settlement protocol is `3`; control mail protocol is `2`. Local viewer V3 migration and `[orca-dag:merge-inputs-v3]` are viewer-local contract markers only.
- **Mailbox reads vs ACKs**: Legacy FIFO checks replay the oldest unacknowledged Delivery; consuming checks acknowledge on read, and a standalone ACK never fetches the next batch. Transport ACK does **not** mean local processing finished — durable progress lives in `sessions.json` (`mailboxChecks`). Use `--peek` for read-only inspection only; never consume another agent's mailbox to monitor it.
- **`stopReason` escalations**: Native escalations (`finished`, `errored`, `needs-input`, `exited`, `lost`) are **events**, not replyable question threads. Resolution follows exact Dispatch steering (`send`), operator decision, or authoritative settlement — never fabricate answers or mark an interrupted task succeeded.
- **Guidance redirects**: Guidance sends support positively evidenced `recipient_run_bound_redirect` targeting actual destination mailboxes without adopting helper/child custody.
- **Orca `>= 1.4.263` capabilities**:
  - `orchestration.worker-stop-helpers.v1`: stopping a parent worker cascades helper cleanup receipts under `helpers`.
  - `orchestration.peer-mail.v1` (`send --on <server>`) & `orchestration.remote-owned-workers.v1` (`request-show --on <server>`).
  - Run-scoped `orchestration inbox --run <id>` & single-use worker permission prompts (`POST /api/workers/:dispatchId/permission`, backed by `approve`/`deny` when enabled in Orca settings).

---

## 3. Troubleshooting Quick Reference

| Symptom / Error | Root Cause | Correct Recovery Action |
| :--- | :--- | :--- |
| **`orca --version` prints `42.x` or hangs on Linux** | Resolved GNOME screen reader `/usr/bin/orca` outside Orca terminal | Switch strictly to `orca-ide` (or `orca-dev` / `ORCA_CLI_COMMAND`) per Phase 0.1 |
| **Mutations fail with `consumer_fenced`** | Another coordinator (e.g., Orchestration Panel after clicking Run) currently holds the Run lock | Do not force keystrokes into terminals. Read-only `task-list --run <id>` works; hand authority back explicitly via runtime guide's `run-use` or UI confirmation (`coordinatorControl`) |
| **Need to edit a Task's title, spec, or `deps` after creation** | Orca Tasks are immutable on title/spec/deps and cannot be deleted | Add new Tasks/Gates if the graph hasn't finished; to fix existing nodes/edges, create a **new Run** and redraw — never `reset` |
| **Task trips `circuit_broken`** | Three consecutive failed start attempts in one `--retry-of` chain (worker's own `failed` result does not increment it) | Do **not** invent a duplicate Task/Run around it. Escalate to the user; if retry is authorized, Coordinator inspects `worker-show`/`worker-read`, releases reclaimable failed terminals, and reopens the **same Task** |
| **Execution rejected (`503 execution_disabled`)** | Runtime state is not `ready`, or CLI/appVersion `< 1.4.205` | Run `orca open` or upgrade Orca desktop runtime |
| **Retired commands return no-op / errors** | Old `orchestration run` / `run-stop` / `coordinator-start` / `coordinator-stop` are retired | Never invoke retired scheduler commands; use Orchestration Panel or wake-driven coordinator loop (`skills get orchestration`) |
