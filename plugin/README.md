# Orchestration Panel (`plugin/`)

Native, self-contained Orca companion plugin (`id: "orchestration-panel"`, `manifestVersion: 2`, `execution: "trusted-worker"`, `pluginApi: 1`, `engines.orca: ">=1.4.263"`) for **Orca DAG**.

## What it provides

- **Self-contained embedded backend (zero manual terminals)**: Bundles the viewer server (`server/index.mjs`) and SPA (`panel/`) directly inside the plugin. When no external `npx orca-orchestration-launcher` terminal is running for an Orca workspace, the worker automatically spawns an isolated loopback server (`PORT=0`, `127.0.0.1`, `NO_OPEN=1`, `ORCA_DAG_WEB_DIR=<panel>`) and cleans it up when the workspace closes or the plugin deactivates. It discovers external viewers via the private runtime v2 registry at `~/.orca-dag-viewers/<sha256 of canonical workspace path>.json` (POSIX directory `0700`, file `0600`) and returns to the embedded backend when an external viewer closes. It never reads a workspace file to discover a viewer.
- **Companion loopback bridge (M1)**: Authenticates over `127.0.0.1` with a per-process `x-orca-plugin-token` derived from the registry entry's signing key. The trusted worker verifies signed hello and inbox responses, maintains Orca's status bar progress item (`Orchestration`), and delivers desktop gate/failure notifications. The registry is not for browser or operator API clients.
- **Live Session wakeups (M2)**: `agent.status.changed` and the observe-only `agent.tool.after` and `agent.prompt.before` hooks forward only a terminal ID to wake matching, exactly scoped `worker-read` polls. Tool previews and prompt contents never cross the bridge. The node **Session** tab renders tool cards from native transcript data via `OutputTail` SSE. The `toolStream` setting toggles tool wakeups only; it does not turn transcript reads off.
- **Native session resume (M3)**: Answers `workspace.list`, `agent.listSessions`, and `agent.resume`. Only an eligible exited worker with exact session history in the same local workspace and provider can resume under coordinator authority. Active sessions and existing panes are refused; only a newly resumed pane can be bound with `worker-start --terminal --retry-of`. OMP and Antigravity do not use this route.
- **Dual-surface Sidebar + Full Tab UX (M4–M5)**:
  - **Right-sidebar panel (`panel/index.html?view=sidebar`)**: Streamlined single-column `SidebarApp` (`Tasks` / `Pending` / `Live`, task drill-in reusing the full workbench's `ChatPanel` bubbles for **Messages**, `NodeSessionPanel` for **Session**, and `WorkerOutputDockView` for **Output**) with a single `↗ Tab` button to open or reuse the full workbench.
  - **Full workbench Tab (`orchestration-panel.openTab` / status bar click)**: Opens or reuses the full 4-zone IDE workbench in an Orca browser tab (`POST /api/open-tab`), probing existing tabs and reviving any stale/closed-port tab in-place via `orca goto`.

Before using the plugin in a Git project that does not already ignore `.orca-dag/`, add `.orca-dag/` to the project's `.gitignore`. The plugin does not edit `.gitignore` automatically. This directory holds local planning and viewer state, never the endpoint record.

## Layout

- `orca-plugin.json` — Manifest validated against the installed Orca runtime (`orca skills get orca-plugin-authoring`).
- `icon.png` — Custom fork-join DAG plugin icon (`256×256` PNG).
- `assets/workbench-dark.png` — Dark workbench screenshot referenced by manifest `cover` and `screenshots`.
- `DIST_README.md` — Template rendered to `dist-plugin/README.md` for the standalone plugin distribution repository.
- `src/worker.ts` — Trusted-worker entry (`activate` / `deactivate`), endpoint discovery, embedded server manager, API/SSE proxy, and host bridge.
- `src/protocol.ts` — Shared `PluginRequests` and `PluginPanelEvents` contract.
- `src/worker.test.ts` — Unit tests run via `orca-ide plugin test ./plugin --json`.
- `panel/` — Built Vite SPA output (`npm run build:plugin-panel`, gitignored).
- `server/` — Bundled zero-`node_modules` viewer server (`npm run build:plugin-panel`, gitignored).

## Local Development

```bash
# 1. Build the sidebar SPA (plugin/panel/) and embedded server (plugin/server/index.mjs)
npm run build:plugin-panel

# 2. Generate/refresh Orca plugin typings, typecheck, test, validate
orca-ide plugin types ./plugin --json
npx tsc -p plugin/tsconfig.json --noEmit
orca-ide plugin test ./plugin --json
orca-ide plugin validate ./plugin --json
orca-ide plugin inspect ./plugin --json

# 3. Load into Orca (first run prints exact grants + --approve <fingerprint>)
orca-ide plugin dev load ./plugin --json
# After subsequent edits:
orca-ide plugin dev reload ./plugin --json
```

## Production Packaging (`dist-plugin/`) & Automated Publishing

```bash
npm run build:plugin
orca-ide plugin validate ./dist-plugin --json
orca-ide plugin inspect ./dist-plugin --json
```

`scripts/build-plugin.mjs` produces a self-contained, zero-`node_modules` directory at `dist-plugin/` (`worker.mjs` + non-test `src/*.ts` sources + `server/index.mjs` + `panel/` built by Vite + `icon.png` + `assets/` + rewritten `orca-plugin.json` + rendered `README.md` from `DIST_README.md` + `LICENSE`) and enforces Orca's archive limits (`<= 2,000` files, `<= 50 MiB`, no symlinks, no disallowed binary/font extensions).

When a stable release tag `vX.Y.Z` is pushed to `Orca-dag`, `.github/workflows/release.yml` builds `dist-plugin/` (with `version` synced to `X.Y.Z`) and automatically pushes it (along with the `vX.Y.Z` tag) to `yyq19990828/orchestration-panel` (overridable via `vars.ORCA_PLUGIN_REPO`) when `secrets.ORCA_PLUGIN_DEPLOY_KEY` (recommended repo-scoped write deploy key) or `secrets.ORCA_PLUGIN_PUSH_TOKEN` is configured. For Orca's automated Community Plugins catalog (`stablyai/orca-community-plugins`), ensure that target repository is **public**, **not a fork**, and carries the `orca-plugin` GitHub topic (`https://www.onorca.dev/plugins/yyq19990828/orchestration-panel`).
