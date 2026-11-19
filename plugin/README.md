# Orchestration Panel (`plugin/`)

Native Orca companion plugin (`id: "orchestration-panel"`, `manifestVersion: 2`, `execution: "trusted-worker"`, `pluginApi: 1`, `engines.orca: ">=1.4.263"`) for **Orca DAG**.

## What it provides

- **Companion loopback bridge (M1)**: Discovers local Orca DAG viewers via `<workspace>/.orca-dag/endpoint.json` (`0o600`, symlink-rejected) over loopback HTTP (`127.0.0.1`), authenticates with a dedicated `x-orca-plugin-token`, maintains Orca's status bar item (`Orchestration`) and desktop gate/failure notifications.
- **Live agent & tool acceleration (M2)**: Streams `agent.status.changed`, observe-only `agent.tool.after` (bounded RAM rings, never written to `activity.jsonl`), and observe-only `agent.prompt.before` to wake the viewer's centralized `OutputTail` SSE and power live tool-call cards in the node **Session** tab.
- **Native session resume (M3)**: Answers viewer `workspace.list`, `agent.listSessions`, and `agent.resume` commands so exited local verified workers can resume in-place via Orca's native session launcher and re-bind with `worker-start --terminal --retry-of` under coordinator authority.
- **Native right-sidebar HTML panel (M4)**: Renders the full Orca DAG SPA inside Orca's sidebar panel (`panel/index.html`) by proxying `/api/*` (blocking `/api/plugin/*`) and SSE streams (`orca-dag.activity`, `orca-dag.output`) through the trusted worker.

## Layout

- `orca-plugin.json` — Manifest validated against the installed Orca runtime (`orca skills get orca-plugin-authoring`).
- `src/worker.ts` — Trusted-worker entry (`activate` / `deactivate`).
- `src/protocol.ts` — Shared `PluginRequests` and `PluginPanelEvents` contract.
- `src/worker.test.ts` — Unit tests run via `orca-ide plugin test ./plugin --json`.
- `panel/` — Built Vite SPA output (`npm run build:plugin-panel`, gitignored).

## Local Development

```bash
# 1. Build the sidebar SPA into plugin/panel/
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

## Production Packaging (`dist-plugin/`)

```bash
npm run build:plugin
orca-ide plugin validate ./dist-plugin --json
orca-ide plugin inspect ./dist-plugin --json
```

`scripts/build-plugin.mjs` produces a self-contained, zero-`node_modules` directory at `dist-plugin/` (`worker.mjs` bundled by esbuild + `panel/` built by Vite + rewritten `orca-plugin.json` + `README.md` + `LICENSE`) and enforces Orca's archive limits (`<= 2,000` files, `<= 50 MiB`).

To publish as an Orca plugin repository, push the contents of `dist-plugin/` (or the plugin tree) to its dedicated repository, tag `v<version>`, add the `orca-plugin` GitHub topic, and optionally generate a catalog entry via `orca-ide plugin release-entry ./dist-plugin --json`.
