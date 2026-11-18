# Orca Native Plugin (`plugin/`)

This directory is reserved for packaging **Orca DAG Viewer** as an **Orca Alpha Native Plugin** (`orca-plugin.json`, Host API `1.10+`).

## Status

- **Current state**: Subdirectory reserved; formal plugin worker packaging is intentionally deferred while the standalone launcher (`npx orca-orchestration-launcher` / `dist/orca-dag`) and Orca 1.4.263 orchestration primitives stabilize.
- **Already prepared in `web/`**:
  - `web/src/bridge/orcaBridge.ts` implements `?orcaPlugin=1` detection, `postMessage` RPC (`orca-dag:api-request` / `orca-dag:api-response`), SSE forwarding (`orca-dag:sse-*`), and host theme synchronization (`orca-dag:theme`).
  - `web/src/ide-workbench.css` maps `--orca-*` host CSS variables (`--orca-bg-primary`, `--orca-fg-primary`, `--orca-border`, etc.) with automatic Zinc Light / Obsidian Dark fallbacks, plus `?embed=sidebar` single-column mode.

## Planned Layout (When Activated)

- `orca-plugin.json` — Manifest declaring `hostApiVersion: "1.10"`, `runtime.type: "trusted-worker"`, sidebar/tab HTML panels, and orchestration permissions (`orca skills get orca-plugin-authoring` is the authoritative spec).
- `src/worker.ts` — Trusted-worker entry bridging `orcaBridge.ts` RPCs, `statusBar.update` Run progress, and `notifications.show` gate/permission alerts.
