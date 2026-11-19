# Orchestration Panel (`orca-dag`) — skill + viewer + native Orca plugin

English | [简体中文](README_zh.md)

> Forked from [ZinkLu/Orca-Orchestration](https://github.com/ZinkLu/Orca-Orchestration), extended and published independently as [`orca-orchestration-launcher`](https://www.npmjs.com/package/orca-orchestration-launcher) along with the native Orca companion plugin (`orchestration-panel`).

**Orchestration Panel** (`orca-dag`) cleanly separates agent-based planning from visual coordination and execution across three cooperating pieces:

1. **Skill** ([`skill/SKILL.md`](skill/SKILL.md) · [中文审阅版](docs/SKILL_zh.md)): Your agent writes a PRD, technical design, and Orca task DAG using the runtime-matched orchestration guide (`orca skills get orchestration`). Planning stays in your agent; no Agent SDK is embedded in the viewer.
2. **Viewer & Coordinator** (`server/` + `web/`): A dual-theme monochrome 4-zone IDE workbench with live DAG canvas, per-node launch controls, centralized `OutputTail` SSE + structured **Session** tool cards, L1 native session resume, and a self-driven coordinator loop.
3. **Native Orca Plugin** (`plugin/` → `dist-plugin/`): Self-contained companion plugin (`orchestration-panel`, Host API 1.10 `trusted-worker`) that embeds the backend server automatically (no manual terminal required), adds a streamlined right-sidebar companion (`SidebarApp`) with one-click full Tab handoff (`↗ Tab`), streams live `agent.tool.after` / `agent.status.changed` hooks into the **Session** tab, powers L1 native `agent.resume`, and shows live Run progress in Orca's status bar.

## Prerequisites

CLI examples use `orca` inside managed Orca terminals; on Linux outside them, use `orca-ide`, not the GNOME screen reader at `/usr/bin/orca`. Explicit overrides and development builds follow the [startup resolution rules](docs/tutorials/viewer-operations.md#startup-parameters).

- **Orca version:** ≥ **1.4.160** for viewing, ≥ **1.4.205** for executing (`result.runtime.appVersion` in `orca status --json`), and ≥ **1.4.263** for the native `orchestration-panel` plugin, OMP `--effort`, cascading helper stops, and single-use worker permission prompts.
- **Orca state:** Orca must be running (`orca status --json` reports `"ready"`; run `orca open` if not).
- **Experimental features:** Orchestration experimental feature must be enabled (**Settings → Experimental**).
- **Managed workspace:** Project must be an Orca-managed worktree (`orca repo add <path>` or `orca worktree ...`).
- **Agents:** Selected worker agents must be installed and configured in Orca, and able to execute tools and report `worker_done` autonomously.
- **Presets:** `claude`, `codex`, `opencode`, `omp`, and `antigravity`, within their [version and placement limits](docs/reference/compatibility.md). The other five unverified agent IDs remain unavailable, even with custom commands enabled.
- **Runtime:** **Node.js ≥ 20** for npm, or a standalone binary; both need the resolved Orca CLI on PATH.

## Installation

### Option 1 — CLI / Web Viewer (`npx orca-orchestration-launcher`)

Start from the **root of an Orca-managed project** in an ordinary shell. Inside an Orca terminal, use the [clean-environment startup recipe](docs/tutorials/viewer-operations.md#startup-parameters) to avoid inherited terminal-identity conflicts.

```bash
cd ~/any/orca-managed/project
npx orca-orchestration-launcher
```

This installs the `orca-dag` skill for detected coding agents, initializes a managed `.orca-dag/` ignore rule, and serves **Orchestration Panel** at <http://localhost:8787>. Shared-agent and relocated-home rules are covered in [skill installation](docs/tutorials/viewer-operations.md#skill-installation-and-agent-homes). Planning documents and viewer history stay local in `.orca-dag/`.

> **No Node.js?** Download a standalone binary from [GitHub Releases](https://github.com/yyq19990828/Orca-dag/releases). For skill-only use without the viewer: `npx skills add yyq19990828/Orca-dag --skill orca-dag --global`.

### Option 2 — Self-Contained Native Orca Plugin (`orchestration-panel`)

On Orca ≥ **1.4.263**, build and load the native companion plugin directly into Orca — **no manually kept terminal needed**:

```bash
npm install
npm run build:plugin-panel
orca-ide plugin dev load ./plugin --json
```

Once approved and running, the plugin automatically spawns an isolated loopback backend per active workspace whenever no external viewer terminal is running (and transparently attaches/fails over if you start or close one). Open the **Orchestration Panel** sidebar icon in Orca's right rail or click the status bar item to jump straight into the full workbench Tab. See [`plugin/README.md`](plugin/README.md) for staging `dist-plugin/`.

## Quick Start

After installation:

1. **Plan in your agent:**
   > Use the orca-dag skill: break "add CSV export to the reports page" into a task DAG.

   The agent writes `.orca-dag/<timestamp>/{PRD.md,TECH_SPEC.md}` and returns the Run ID.
2. **Select and configure:** Pick that Run in the full **Orchestration Panel** Tab (or sidebar). Choose the default harness, supported per-node overrides (model, effort, worktree placement/lanes), and **Max parallel**.
3. **Run:** Click **"▶ Run with Orca"** (reviewing the launch preview and quota hints) and confirm coordinator handoff; it fences the previous coordinator for this Run.
4. **Observe and decide:** Follow live tool calls in the **Session** tab, chat bubbles in **Messages**, approval/permission prompts in **Pending** / **Decisions**, and live **Activity**. Resume exited local sessions in-place with **Resume** (L1 native resume) when needed.
5. **Revise:** Ask the agent to rebuild task definitions or dependencies in a fresh Run; keep the old Run as history.

## Key Features

- **Dual-Surface UX (Full Workbench Tab + Compact Orca Sidebar):**
  - **Full Tab (`App.tsx`)**: Dual-theme (Light & Dark, following Orca host theme) monochrome 4-zone IDE workbench — Left Fleet/Gates Explorer, Center persistent React Flow DAG Canvas / Status Board / Run History / Resources / Settings, Resizable Bottom Dock (`Activity Stream`, `Worker Output`, `Request Ledger`), and Right Contextual Inspector (`Messages`, `Session`, `Task`, `Config`).
  - **Right Sidebar (`SidebarApp.tsx`)**: Streamlined narrow-width (`320–450px`) companion with Run progress strip, 3 primary tabs (**Tasks** / **Pending** / **Live**), task drill-in reusing the exact workbench **Messages** chat bubbles alongside **Session** and **Output**, and a single `↗ Tab` button that opens or revives the full Tab in-place.
- **Live Session Stream & Plugin Hook Acceleration:** Centralized server-side `OutputTail` SSE (`/api/workers/:dispatchId/output/stream`) paired with native plugin `agent.status.changed` and observe-only `agent.tool.after` hooks (RAM-only, never persisted to `activity.jsonl`) renders collapsible tool-call cards live in the **Session** tab.
- **L1 Native Session Resume:** Inspect (`GET /api/workers/:dispatchId/resume-preview`) and resume (`POST /api/workers/:dispatchId/resume`) exited local verified worker sessions via Orca's native `agent.resume`, re-binding a fresh Dispatch (`worker-start --terminal --retry-of`) with durable crash-recovery journals (`sessions.json` `resumeAttempts`).
- **Agent Controls & Launch Preview:** Per-node harness selection (`claude`, `codex`, `opencode`, `omp`, `antigravity`), model/effort overrides (including OMP `--effort` on Orca ≥ 1.4.263), OpenCode Auto / Mini TUI / Full TUI modes, and pre-launch account/quota diagnostics (`GET /api/accounts`).
- **Local & Remote Placement + Workspace Lanes:** 4 local placement modes (`current`, `existing`, `new-child`, `new-top-level`), 2 remote placement modes, serial shared-worktree lanes, and human-asserted cross-lane integration gates.
- **Governance, Permissions & Audit:** Single-use worker permission approvals (`POST /api/workers/:dispatchId/permission`), canonical gate creation for pending tasks, on-demand workspace cleanup with safe merged-branch deletion, and pre-mutation request audit ledger (`.orca-dag/requests.jsonl`).
- **Bilingual Interface:** Instant one-click toggle between English and Simplified Chinese (**中 / EN**).

## Important Caveats

- **Task definitions are immutable:** Specs, titles, and dependencies cannot be edited in place; status/results can change. Replan in a fresh Run. Never use `reset --tasks` for this: it wipes all Runs.
- **Unknown ≠ dead:** Unknown or disconnected workers keep their concurrency slots; uncertainty never authorizes automatic retry, cancellation, or replacement.
- **Messaging, coordinator authority, and recovery:** Runtime mailbox and coordinator semantics differ; follow the installed guide. The official public orchestration contract is contract 1 (`orchestration.contract.v1`), runtime protocol is 3, federation lifecycle settlement protocol is 3, and control mail protocol is 2; `[orca-dag:merge-inputs-v3]` is a local viewer contract marker. One-off coordinator mutations refuse implicit takeover (requiring explicit control consent with 409 `coordinator_control_required`). StopReason escalations are events, not replyable question threads. Critical recovery journals (`mailboxChecks`, `guidanceSends`, `operatorMessages`, `resumeAttempts`) in `sessions.json` act as recovery authority, not rotating audit logs, and cannot safely be hot-downgraded across unsupported readers. Worker output, release, and retain are strictly scoped to the selected Run. Incomplete remote observations (`partialHostErrors`) are preserved across worker list pages and never clear debt. See [orchestration](docs/tutorials/orchestration.md#worker-and-mailbox-parameters-you-will-see) and [HTTP API](docs/reference/http-api.md#guidance-delivery-recovery-and-follow-up-lifecycle).
- **Local control plane:** The server binds `127.0.0.1`, has no CORS, requires `X-Orca-Dag-Token` for UI mutations, and isolates `/api/plugin/*` behind a separate `x-orca-plugin-token` stored in `0o600` `.orca-dag/endpoint.json`. Custom commands are opt-in.
- **OMP / Antigravity:** Local Linux Current or exact Existing requires running Orca and resolved CLI ≥ **1.4.245**; new Git worktrees (`new-child`, `new-top-level`) and workspace lanes require both ≥ **1.4.246**. OMP `--effort` requires running Orca ≥ **1.4.263**; Antigravity rejects nonempty effort. See [placement, output, Stop, and verification boundaries](docs/reference/compatibility.md#path-boundaries-and-historical-findings).

## Documentation

Start with the [documentation index](docs/README.md) ([中文](docs/README_zh.md)).

| Area | Guides |
| --- | --- |
| Tutorials | [Plan a DAG](docs/tutorials/orchestration.md) · [Operate the viewer](docs/tutorials/viewer-operations.md) · [Worktree isolation](docs/tutorials/worktree-isolation.md) · [Orca Plugin](plugin/README.md) |
| Reference | [Compatibility](docs/reference/compatibility.md) · [Features](docs/reference/viewer-features.md) · [Architecture](docs/reference/architecture.md) · [HTTP API and security](docs/reference/http-api.md) · [Skill 中文审阅版](docs/SKILL_zh.md) |
| Development | [Build, verify, and release](docs/development.md) · [UI layout](docs/ui-layout.md) |

## Uninstall

```bash
npx orca-orchestration-launcher uninstall   # Add --dry-run to preview, --purge to remove viewer state files
```

Unlinks skills from agent directories, closes orphaned viewer coordinator terminals, removes stale `.orca-dag/endpoint.json`, and cleans managed `.gitignore` blocks. Planning files and Orca state are preserved.

## Development

```bash
npm install                # Install dependencies
npm run check              # Skill validation, typecheck, tests, and web build
npm run dev                # Development mode (:5173 with API proxy to :8787)
npm run build:plugin-panel # Build SPA + embedded server into plugin/ for Orca dev loading
npm run build:plugin       # Stage zero-dep Orca plugin bundle into dist-plugin/
```

See the [development guide](docs/development.md) for packaging, OIDC releases, and opt-in `verify:live` checks. Live verification creates real workers and consumes provider usage; it is not part of `npm run check`.
