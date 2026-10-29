# Compatibility and Verification Matrix

English | [简体中文](compatibility_zh.md)

Back to [README](../../README.md) · [Documentation Index](../README.md)

This document records the supported version floors, runtime verification gates, and historical real-provider test results for the `orca-dag` viewer and coordinator.

> **Important:** Compatibility floors are **not** an exhaustive tested-version matrix. The native-agent and experimental-TUI gates use the **running Orca app version** (`result.runtime.appVersion` in `orca status --json`), not just the installed CLI version. Do not infer verified execution on unlisted versions or agent combinations.

---

## Supported Version Floors

| Capability / launch path | Minimum Orca version | Conditions and boundaries |
|---|---|---|
| **View Runs, Tasks, and gates** | **1.4.160** | Baseline for Run/Task/Dispatch schema (PR #9925). Runtimes 1.4.160–1.4.204 remain view-only (DAG renders, execution controls disable themselves). Older runtimes are unsupported. |
| **Execute DAGs with supervised workers** | **1.4.205** | Execution floor where supervised Dispatch landed. Individual agent launch paths may require newer versions. |
| **Native Codex startup** | **1.4.217** | Local POSIX current/existing workspaces. Older/unknown runtimes and newly created local workspaces retain the compatibility adapter. |
| **Native OpenCode 2 TUI** | **1.4.220** | Requires no per-node model override; the viewer's `opencode` choice maps to Orca's `opencode2` agent. |
| **Explicit Mini / Full TUI selection** | **1.4.222** | OpenCode ≥ **2.1.2**; local Linux current/existing non-lane workspaces. Auto remains the default. |
| **API-preselected OpenCode 2 full TUI** | **1.4.222** | Explicit model + `ORCA_DAG_OPENCODE_TUI=1`; local POSIX current/existing non-lane workspaces only. Default-off and experimental. |
| **Native OpenCode model in Auto** | **1.4.241** | Advertised launch preferences (`orchestration.worker-launch-preferences.v1`); local POSIX current/existing non-lane workspace; no variant or effort. Uses distinct `opencode` agent and execution-host model/CLI verification. |

---

## Recorded Real-Runtime Verification

As of **2026-10-29**, the following combinations have been verified against real running runtimes:

| Orca app | Agent version | What was verified |
|---|---|---|
| **1.4.217** | **Codex CLI 0.159.2** | Local read-only native Task: prompt execution, `live / agent_status`, exact transcript, and accepted `worker_done`. |
| **1.4.222** | **OpenCode 2.0.22** | Opt-in API-preselected full TUI: per-node model/variant, dependent Tasks, restart recovery without duplicate Dispatches, output after terminal close, successful completion cleanup, and provider-confirmed Stop. Stop can retain the pane after fencing; it is not a guarantee of automatic terminal closure. |
| **1.4.229** | **OpenCode 2.0.28** | Recorded local POSIX explicit-model one-shot certification: two dependent Tasks with `deepseek/deepseek-flash`, blocking ask/reply, multiple approval gates, same-Run recovery without a duplicate producer, accepted `worker_done`, independently recomputed artifacts, and no remaining experiment-owned terminal or cleanup debt. This is not native `opencode2` model selection or API-preselected TUI coverage; see the operations tutorial for the recorded evidence. |
| **1.4.235** | **OpenCode 2.1.2** | Linux viewer-selected Mini / Full TUI with explicit and configured default models, file writes, and accepted `worker_done`; Mini foreground wait of 400.027 seconds plus acknowledged follow-up, explicit retention, and active Stop. Mini can still report fleet `missing_status`; configured providers must be authorized (the initial free-provider default returned 403). |
| **1.4.241** | **OpenCode 2.1.2** | Isolated Linux headless runtime, native `opencode` + `deepseek/deepseek-flash`: file write/readback, accepted `worker_done`, effective-model receipt, and terminal release; viewer restart recovered the same Dispatch and completed a dependent Task with no duplicate workers or cleanup debt. Nested-helper execution was refused by the profile's depth limit of 1; helper custody/handback is covered by the regression suite, not claimed as live-provider verified. |
| **1.4.242** | **Codex 0.164.0** | Isolated Linux native worker: file write/readback, rendered provider transcript, forward cursor paging over multiple bounded pages, accepted `worker_done`, terminal release, and readable transcript archive after release. A separate live desktop viewer A/B → C flow observed parallel root workers, completed all three Tasks with result `51`, and used exactly three Dispatches with reuse/retention decisions and no cleanup debt. This does not establish remote/Windows coverage or reproduce the late-start-error race on a live provider. |
| **1.4.243** | **OpenCode 2.2.0** | Isolated Linux native worker (`opencode` + `deepseek/deepseek-flash`): file write/readback of `{"verified":243,"frontend":"native"}`, accepted `worker_done`, exact 1 Dispatch, terminal release, and no cleanup debt. Verified execution succeeded even when local viewer model discovery failed (`opencode models` exit 23), proving discovery is advisory rather than an execution-host failure. Heartbeat preamble preview generated across 5m/off/15m profiles without commands when off. Explicit Mini and Full TUI both failed the startup identity ready gate (terminal title did not update to `OC | odag:<request>` within 60s, safely refusing before Task input/Dispatch and settling via `start_failed` with no cleanup debt; no provider task execution coverage). Does not verify remote/Windows, new worktree model override, variant, effort, or live multiaccount authentication. |

---

## Path Boundaries and Historical Findings

- **Native OpenCode 2 path:** Passed read-only and isolated-worktree file-writing checks with **OpenCode 2.0.22** (Orca ≥ 1.4.220). This is separate from the experimental API-preselected adapter, whose real-runtime checks ran on macOS with **Node.js 22.23.0** and did **not** cover long coding runs, Git Stage, newly created workspaces, lanes, remote, or Windows execution.
- **Orca 1.4.243 and OpenCode 2.2.0 boundaries:**
  - **Advisory model discovery and manual entry:** Local viewer workspace discovery (`GET /api/models/:harness`, `scope: "local-workspace"`) is advisory and distinct from execution-host model verification. Discovery failure or an empty catalog does not prevent manual entry of valid `provider/model[#variant]`, and saved unlisted models are preserved. Local discovery failure does not change native routing gates or authorize fallback.
  - **Heartbeat authoritative rules:** Heartbeats (`type: "heartbeat"`) provide **liveness evidence only**, never completion or settlement. Orca rejects heartbeat and `worker_done` in group messages (`@all`, `@worktree`); isolated profile preamble preview supports 5m/off/15m intervals without emitting heartbeat commands when turned off, does not alter global user settings, and does not claim unexercised live heartbeat worker execution or hot-reloading worker settings.
  - **Removed-work ledger:** `run-show` optional summary and on-demand cursor pagination (`/api/runs/:runId/removed-work`); missing summary on older hosts remains unavailable rather than zero; historical `activeWorkersAtRemoval` is not a live process check; no reset button is provided.
  - **Explicit Mini / Full TUI and backend visibility loss:** Explicit Mini and Full TUI on OpenCode 2.2.0 both failed the startup identity ready gate during live testing: while the original API session model and location were established correctly, the created terminal did not update its title to `OC | odag:<request>` within the 60-second deadline. The adapter safely refused before Task input or Dispatch, closing the uninputted pane and recording `settledVia=start_failed` with no cleanup debt; neither frontend provides provider task execution coverage on 1.4.243 + 2.2.0. This does not claim that all OpenCode 2.2.0 environments are unconditionally unsupported (root cause is unverified), but the startup identity gate is not relaxed. With no Orca managed OpenCode accounts, multiaccount execution is not claimed as verified. Regression fixtures cover backend visibility loss after pane creation, holding preparation and forbidding `worker-start`, pane closure, or replacement Dispatch for both Mini and Full TUI.
  - **No worker support expansion:** Neither upstream PR 32006 (nativeChat models) nor new-top-level worktree fixes expand worker model support for `opencode2`, new worktrees, variant/effort, or remote/Windows placements. Older compatibility matrices and version floors remain unchanged.
  - **Read-only CLI-run observation:** Existing exact-bound `openai/gpt-6.1-sol#xhigh` sessions were read as provider `active` and `exited`, with assistant-message model evidence and `opencode-api` output, while native fleet remained `unverifiable`. This is observation coverage, not new Task-success, Mini/TUI or worker-harness certification. Provider evidence does not expand retry/Stop/release authority; bounded or unavailable history stays explicit.
- **Task readiness prerequisites:** Ordinary approval gates accept only the exact resolved decisions `approve` or `approved`; `integrated` remains an exact separate integration decision. Every gate and every dependency in the same Run must be satisfied before a Task is runnable, even when Orca's task row says `ready`.
- **Verified Built-in Worker Harnesses:** Only `claude`, `codex`, and `opencode` are supported as built-in worker harnesses in the viewer, respecting their recorded version and placement constraints. Claude Code has a historical end-to-end check on Orca **1.4.209**, but its exact CLI version was not recorded.
- **Unverified Harnesses Refused for Launch:** The five harnesses `gemini`, `grok`, `cursor`, `droid`, and `kimi` have NOT been concretely verified as supervised worker harnesses and are not exposed as built-in presets or launchable harnesses in the viewer. Any node or saved configuration attempting to launch with these unverified harnesses is rejected upfront with an explicit `unverified_harness` error; they are neither silently substituted nor auto-migrated. Historical records and logs created under those names remain readable in the viewer.
- **Experimental Custom Commands vs Bare IDs:** User-defined custom commands require launching with `ORCA_DAG_ALLOW_CUSTOM_COMMANDS=1`, run via the legacy local path without isolated placement, and are NOT a verified support claim. The five unverified bare IDs (`gemini`, `grok`, `cursor`, `droid`, `kimi`) are rejected with `unverified_harness` even when custom commands are enabled.
- **Skill Installation and Planning Independent:** Bundled skill installation and planning support for detected agents (such as Claude Code, Cursor, Gemini CLI, Droid, Grok, Kiro, Qoder, CodeBuddy, Codex, OpenCode, Pi, OMP, Kimi) remain intact and operational, as skill-capable planning and agent skill installation are separate from supervised worker execution verification. Installing the skill for an agent does **not** establish verified worker execution.
- **Older findings:**
  - Codex **0.156.1** on Orca **1.4.209** exhibited missing fleet status (`unverifiable / missing_status`).
  - OpenCode **2.0.15** on Orca **1.4.209** failed native prompt delivery (`input_accepted` receipt without prompt execution).
  - These historical combinations are documented limitations, not recommended deployments.
- For detailed operational limitations, failure modes, and tested workarounds, consult [Runtime findings and launch-path boundaries](../tutorials/viewer-operations.md#known-limitations).

## Repeating Verification

The [development guide](../development.md) documents real Codex verification, provider usage, observation deadlines, and evidence paths. `verify:live` is opt-in, not part of normal checks; unknown starts never trigger automatic retry or cancellation.
