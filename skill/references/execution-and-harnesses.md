# Execution Controls, Verified Harnesses & API Run Triggering

## 1. Verified Worker Harnesses & Adapter Routing

Even if you installed skills for multiple coding CLIs locally, **Orchestration Panel execution only admits verified supervised harnesses**:

| Category | Harness IDs | Notes |
| :--- | :--- | :--- |
| **Verified (Selectable)** | `claude`, `codex`, `opencode`, `omp`, `antigravity` | Supported within documented Orca runtime & host bounds |
| **Refused (`unverified_harness`)** | `gemini`, `grok`, `cursor`, `droid`, `kimi` | Always refused at write, preview, and launch admission (never suggest them for worker nodes) |

### Effort & Model Routing Highlights
- **Per-node `--effort`**:
  - Supported by `claude`, `codex`, and (on Orca `>= 1.4.263` CLI + runtime) `omp` paired with an explicit model or `@role` selector.
  - Antigravity rejects every nonempty `--effort` (`unsupported_effort`).
  - Always use named effort levels (`low`, `medium`, `high`, `xhigh`), never raw numeric `reasoning_effort` values (which are not a 0–100 percentage scale).
- **OpenCode interface & model routing**:
  - `Auto` uses native `opencode2` for default model (running Orca `>= 1.4.220`), or native `opencode` for plain explicit models on local POSIX current/existing non-lane placements when running Orca `>= 1.4.241`.
  - `#variant`, effort, new-worktree models, or older runtimes retain CLI one-shot compatibility or explicit `mini` / `tui` adapters (on local Linux current/existing non-lane workspaces with running Orca `>= 1.4.222` & OpenCode CLI `>= 2.1.2`).
  - **Strict preservation rule**: Always keep requested `model#variant` intact — never strip or mutate a variant just to force a native route, and never confuse provider stream activity with Orca Dispatch settlement.
- **UI Presentation Note**: Orca `worker-list` omits runtime launch/provider metadata on settled workers, so `orca-dag` preserves observed `agent`, `model`, `effort`, `worktreeName`, and Git `branch` across settlement (and renders them on the `296×136` canvas cards, Inspector, and Status Board).

---

## 2. Launch Preview, Account Quotas & L1 Native Resume

Before recommending immediate execution (especially when calling `/api/run` in Route B), inspect readiness and preflight:
- **`POST /api/launch-preview`**: Validates topology, Stage-Git merge protocol markers, placement validity, and adapter route selection — returns warnings/blockers cleanly before binding any coordinator terminal. Does **not** verify external test resources described only in Task prose.
- **`GET /api/accounts`**: Reports local CLI subscription/auth status and remaining quota advisories (`claude`, `codex`, etc.) so rate limits are caught before fanning out waves.
- **Native Plugin Session & L1 Native Session Resume (`orchestration-panel`, Orca `>= 1.4.263`)**:
  - **Session cards** read transcripts directly from scoped `worker-read`; plugin status/tool/prompt events serve purely as wake triggers without forwarding transcript previews.
  - **L1 Native Resume** (available on `claude`, `codex`, `opencode` — **unavailable on `omp` and `antigravity`**) requires matching local workspace + provider + exact session history in Orca with **no active session** and **no existing terminal pane**.
  - Failed worker starts are **never auto-retried** — they park the Task for inspection or explicit human retry (`retryWorker`).

---

## 3. Coordination Modes in Live Execution UI

Orchestration Panel surfaces **6 distinct coordination states** live on the canvas Coordinator Hub, Topbar Health Popover, and Run Picker:
1. `human_panel`: Bound coordinator terminal matches this Orchestration Panel instance (autonomous wave loop active).
2. `panel_mismatch`: Bound to another `orca-dag coordinator` terminal (different tab/window/workspace hash) — explicit confirmation required to touch.
3. `agent_native_chat`: Driven by an Orca-native Chat agent session (e.g. Route C in an Orca chat); Panel stays read-only.
4. `agent_terminal`: Driven by an external non-panel terminal agent session (e.g. Route C in an interactive terminal); Panel stays read-only.
5. `unbound`: Run currently has no bound coordinator; ready for human click or explicit takeover confirmation.
6. `unknown`: Binding status could not be confirmed from Orca readiness/run state.

---

## 4. Safe Viewer API Run Launch Recipe (Route B Only)

Follow **Route B** **only** when the user explicitly asks you to trigger execution through Orchestration Panel (`POST /api/run`) instead of clicking the UI themselves.

### Security & verification rules before sending a token
1. **Trust boundary**: Obtain the loopback port **only** from stdout of an `orca-orchestration-launcher` process you started for this exact workspace, OR an Orca browser tab visibly opened for this exact workspace.
2. **Verify workspace first**: Confirm the viewer's `/api/health` matches the intended workspace before requesting or posting `/api/session` tokens.
3. **Never** scrape ports from `.orca-dag/` workspace files, guess common ports, read the private plugin endpoint registry, follow HTTP redirects, or bypass proxy checks. If the verified URL cannot be confirmed, stop and ask the user to click Run in the UI.
4. **Inspect preflight first**: Check `POST /api/launch-preview` and `GET /api/accounts` before posting `POST /api/run`.

### Verified `/api/run` Trigger Pattern
```bash
(
  set -o pipefail
  PORT='<verified_port>' # Replace strictly with port verified from this workspace's launcher output/tab.
  if [[ ! $PORT =~ ^[1-9][0-9]{0,4}$ ]] || (( PORT > 65535 )); then
    printf '%s\n' 'Expected a numeric viewer port from 1 to 65535.' >&2
    exit 1
  fi
  VIEWER="http://127.0.0.1:${PORT}"
  TOKEN=$(curl -q --noproxy '*' --fail --silent --show-error "$VIEWER/api/session" |
    python3 -c '
import json, re, sys
token = json.load(sys.stdin)["token"]
if not isinstance(token, str) or not re.fullmatch(r"[A-Za-z0-9_-]{43}", token):
    sys.exit("Invalid viewer token")
print(token)
') || exit 1
  curl -q --noproxy '*' --fail --silent --show-error "$VIEWER/api/run" \
    -H "X-Orca-Dag-Token: $TOKEN" -H "Content-Type: application/json" \
    -d '{"runId":"<run_id>","defaultHarness":"codex","maxConcurrency":2}'
)
```
*(Adjust `defaultHarness`, `maxConcurrency`, `modelByTask`, `effortByTask`, `laneByTask`, or `worktreeLanes` to match the user's explicit choices or approved defaults.)*
