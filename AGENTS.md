# AGENTS.md

Guidance for agents working **in this repo** (editing the viewer/tooling or the skill doc). For using the skill to build DAGs, read `skill/SKILL.md` and `README.md` instead. `CLAUDE.md` is a symlink to this file — edit here, don't replace the link.

## Project shape

Two independent modules in one npm-workspaces repo (`workspaces: [server, web]`):

- **`skill/SKILL.md`** — a published agent skill (frontmatter + prose): a deliberately **thin** project workflow (PRD → technical design → task DAG → viewer). It resolves the correct Orca CLI, loads the runtime-matched guide with `orca skills get orchestration`, and delegates all command syntax and lifecycle rules to that guide — hard-coded command copies drift from the installed runtime, and `scripts/check-skill.mjs` rejects them. No code; edit it like a doc, keep frontmatter intact.
- **`server/` + `web/`** — the `orca-dag` viewer: an Express API + React Flow SPA that visualizes a Run's DAG and runs a self-driven coordinator loop. Compiles to a single portable binary (`dist/orca-dag`).

This repo is a thin, heavily-commented wrapper over the `orca` CLI. Every Orca quirk is documented in `server/src/orca.ts` comments — **read them before touching orchestration code.**

## Commands

```bash
npm install
npm run dev            # BOTH server (:8787) + web (:5173) via concurrently; vite proxies /api → :8787
npm run dev:server     # tsx watch src/index.ts (server only)
npm run dev:web        # vite (web only)
npm run build          # web only: tsc -b && vite build → web/dist
npm run build:binary   # web build → embed as base64 in server/src/generated/webAssets.ts → bun --compile → dist/orca-dag
npm run build:npm      # web build → esbuild the server → dist-npm/ (the publishable `orca-dag` package; Node only, no Bun)
npm start              # server (tsx) against web/dist on disk; needs `npm run build` first for UI
```

- **Root scripts exist** (`typecheck` / `test` / `check:skill` / `check`): `npm run typecheck` covers both packages (`tsc -p server/tsconfig.json --noEmit && tsc -b web`), `npm test` runs the server suite, `npm run check:skill` validates SKILL.md, and `npm run check` chains them — skill → typecheck → tests → web build. CI runs exactly `npm run check` (plus an `npm audit --audit-level=high` gate), so keep local and CI on the same script.
- **Tests exist server-side only** (`npm test -w server`, `tsx --test src/*.test.ts`, Node's built-in runner — no second test framework). `orca.test.ts` covers CLI/workspace resolution, readiness gating and coordinator conflicts against a fake `orca` executable; `app.test.ts`/`security.test.ts` cover the HTTP surface. There is no web test target yet.
- **`build:binary` requires `bun` on PATH** (not declared as a dependency). Cross-compile with `TARGET=bun-linux-x64 npm run build:binary`.
- Binary runtime env: `PORT` (8787), `NO_OPEN=1` (skip browser), `WORKSPACE_DIR` (an existing directory, resolved to its realpath — becomes the exact `path:` worktree selector), `ORCA_WORKTREE` (explicit selector, overrides the `path:` default), `ORCA_CLI_COMMAND` (exact Orca CLI as quoted argv, parsed with **no shell** — operators/redirections/substitution are rejected).

## Distribution

Two artifacts ship from this repo, and **neither is an Orca plugin** — Orca's plugin panels are `srcdoc` iframes under `default-src 'none'; connect-src 'none'`, so a panel can't `fetch` the viewer's API at all, and `TabContentType` is a closed union with no registry for third-party panes. Orca also deliberately ships no scheduler ("A Run is a namespace and home inbox. It never schedules or places workers."), so an external coordinator like this one is the intended shape, not a workaround.

- **`npx orca-dag` is the whole install.** `server/src/skill.ts` writes `skill/SKILL.md` into every agent skills directory that exists under `$HOME` before the server listens, so the skill half and the viewer half arrive together. It must stay best-effort: never throw, never rewrite an unchanged file, and **never write through a symlinked skill directory** (that's the `ln -s "$PWD/skill"` recipe — following it would clobber someone's working copy). `--no-skill` / `ORCA_DAG_NO_SKILL=1` opts out.
- **`orca-dag uninstall` (`server/src/uninstall.ts`) is the mirror image and has to stay that way** — anything a future startup step writes outside the workspace must get a matching removal here, or the install becomes a one-way door. It shares `AGENT_SKILL_DIRS`/`SKILL_NAME` with `skill.ts` so the two can't drift. It unlinks symlinked skill dirs rather than following them, keeps `.orca-dag.config.json` unless `--purge` (it's real user work: harness/model picks and canvas layout), and closes every terminal whose title starts with `COORDINATOR_TITLE` — a crashed viewer otherwise leaves one bound to the Run, fencing the user's own agent.
- **Subcommands are dispatched at the top of `index.ts`**, before the express app is built, so `uninstall` and `--help` never bind a port, create an Orca terminal, or install the skill on their way out. Keep new subcommands in that block.
- **The skill** also installs through the community skills CLI straight from this repo: `npx skills add ZinkLu/Orca-Orchestration --skill orca-dag`. Discovery keys off `skill/SKILL.md`'s frontmatter — `scripts/check-skill.mjs` guards it in CI (don't shell out to `skills add . --list` there; it prompts when no agent is detected and hangs). The same script rejects drift: the body must load `skills get orchestration`, state the 1.4.205 execution baseline, and contain no fenced copy-paste orchestration mutation command lines — command syntax belongs to the runtime-matched guide.
- **The binary embeds the skill too** (`SKILL_MD` in the generated `webAssets.ts`, next to `WEB_ASSETS`) — it has no package directory to read from, and a single downloaded file has to behave like the npm package. CI boots it with a throwaway `HOME` and greps the installed copy for `skills get orchestration`, so the embed can't go stale when the skill changes.
- **The viewer** publishes as the `orca-dag` npm package (`npx orca-dag`), plus standalone Bun binaries attached to the GitHub release for people without Node. `scripts/build-npm.mjs` stages `dist-npm/`; the bundle lands at `dist/server/index.mjs` **on purpose** — `index.ts`'s disk fallback looks in `join(__dirname, "..", "..", "web", "dist")`, which only resolves inside the package at that depth. Moving either path breaks the SPA silently (API still answers, UI 404s), which is exactly what the CI smoke test checks.
- Inside Orca, the viewer surfaces via `orca tab create --url` (already how `openBrowser` works) — a real Electron browser tab with no CSP restrictions.
- **Releasing is one command: `npm run release <version>`** (`scripts/release.mjs`) — it refuses a dirty tree, a non-`main` branch, a bad semver or an existing tag, runs the checks, then tags and pushes. `.github/workflows/release.yml` takes it from there. **The tag is the version of record** — `PKG_VERSION` overrides the staged `package.json`, so the repo's own version never needs bumping in a commit.
- `.github/workflows/ci.yml` runs `npm run check` (skill validation + typecheck + tests + web build) plus an npm-audit gate, then stages the package and boots the packed tarball on plain Node. `release.yml` publishes to npm with provenance and cross-compiles every binary target from one Linux runner.
- **`NPM_TOKEN` must be a Granular Access Token or a classic *Automation* token.** A classic *Publish* token — what `npm token create` mints — fails in CI on a 2FA-enabled account with `E403 … Two-factor authentication or granular access token with bypass 2fa enabled is required`. Verified the hard way on the v0.1.0 tag: the binaries job succeeded and the publish job did not.
- **A failed publish is recoverable without burning a version.** npm rejects the whole request, so the version stays unclaimed — fix the credential and `gh run rerun <run-id> --failed`. The rerun checks out the same tag, so it publishes exactly the tagged tree regardless of what has since landed on main. Don't cut a new version for a credential error.

## Architecture gotchas

- **The viewer is the scheduler.** Orca ships no scheduler by design (`run`/`run-stop`/`coordinator-start`/`coordinator-stop` are retired no-ops). `server/src/coordinator.ts` owns the dispatch loop: each tick starts a worker for every `ready` task up to `maxConcurrency`.
- **Authority model shapes the whole server.** Reads (`task-list`/`gate-list`) need only `--run <id>` (any process). Mutations (`dispatch`/`gate-resolve`/`task-create`/`worker-start`) require the caller to be the live Orca terminal bound to the Run, proven via `--from <handle>`. So the server keeps its own "orca-dag coordinator · <workspace-hash> · <instance-id>" Orca terminal for pane identity (`ensureCoordinatorTerminal` in `orca.ts`). The hash scopes the terminal to one workspace: another viewer on a *different* workspace can never adopt it, and another viewer on the *same* workspace gets `coordinator_conflict` (never silent reuse, never close). The stable `orca-dag coordinator` prefix is uninstall's discovery contract — don't change it.
- **CLI + workspace resolve once, at startup** (`initOrcaRuntime` in `orca.ts`, called from `index.ts`): resolution order is `ORCA_CLI_COMMAND` → `orca-dev` when `ORCA_DEV_REPO_ROOT` is set → `orca-ide` on Linux *outside* a managed Orca terminal (bare `orca` there is GNOME's screen reader at `/usr/bin/orca`) → `orca`. Every CLI call spawns the resolved `{ executable, prefixArgs }` with `shell: false` and `cwd: <workspace>`. `WORKSPACE_DIR` must exist and is `realpathSync`'d, so symlinked spellings of the same directory share one identity (and one coordinator-title hash).
- **`asCoordinator` (index.ts) never reuses the loop's terminal** for one-off mutations — it creates a throwaway, uniquely-titled terminal, binds, acts, closes. Reusing the loop's terminal would fence and then kill a running coordinator. Preserve this pattern.
- **`dispatch --inject` does not reliably submit** the preamble into the agent TUI. `startLegacyWorker` sleeps ~2s then sends an Enter; a stray Enter on already-submitted input is an intentional no-op. Don't "fix" this.
- **opencode bypasses `worker-start` entirely** (`coordinator.ts` routes harness `opencode` straight to legacy). `worker-start --agent opencode` opens the TUI but never lands the injected preamble (orca #9951), so `startOpencodeWorker` opens a **bare shell**, mints a tracking dispatch (for a real `dispatch_id`), fetches the preamble, and runs `opencode run --auto "$(cat <preamble-file>)"`. **`--auto` is mandatory** — opencode's default permission policy auto-rejects tool calls (e.g. writing outside the project) and silently kills the task. Verified end-to-end 2026-08-10.
- **Per-node model override (`modelByTask` in `.orca-dag.config.json`)** is only wired for harnesses that support it: **opencode** (`opencode run -m <provider/model>`, enumerable via `opencode models` → `listModels` in `orca.ts`), and **claude/codex/cursor** (free-text). Claude/Cursor pass the model through `worker-start --model`; local Codex on a current/existing worktree prestarts its TUI with `codex -m` and binds it via `worker-start --terminal` once the composer is ready, because a cold Codex repaint can swallow Orca's injected preamble and `--terminal` cannot combine with `--model`. Remote/creating Codex starts retain Orca's native path. Everything else ignores the field. The dispatch loop threads the model through the selected launch adapter; shell-command arguments are quoted.
- **Viewer must run inside an Orca-managed worktree** — `orca terminal create --worktree` needs the cwd to be registered (`orca repo add`/`orca worktree`), else `selector_not_found`.
- **Requires Orca ≥ 1.4.160 to view, ≥ 1.4.205 to execute** (Run/Task/Dispatch contract: PR #9925, 2026-07-29; supervised-worker execution floor: 1.4.205). Older Orca lacks `worker-start` as used here. `GET /api/readiness` probes `--version` through the resolved CLI; execution mutations (`POST /api/runs`, `/api/run`, gate resolve) answer `503 execution_disabled` when it fails, and the UI disables the matching controls.

## Web app gotchas

- **`web/src/harness.ts` is the single config store** (`useSyncExternalStore`). The server-side `.orca-dag.config.json` is the source of truth; localStorage is only a one-time migration source plus a write-through mirror. Writes debounce 250ms before `PUT /api/config`.
- **Hydration order matters**: `App.tsx` gates `RunPicker`'s auto-pick behind a `hydrated` flag — if the picker fell back to "newest Run" before `initConfig()` resolved, it would overwrite the stored Run choice.
- The UI polls `GET /api/dag` every 2s. Manually dragged nodes keep their positions across refreshes (only untouched nodes follow auto-layout; ↻ Re-layout bumps `reorgNonce` to clear drags). Layout algorithms live in `web/src/layout.ts` (dagre layered LR/TB + Fruchterman–Reingold force).
- **The crayon look is SVG `feTurbulence` filters** defined once in `App.tsx` (`#crayon*`, `#pencil-edge*`, `#crayon-fill`), with tuned seeds/regions — e.g. `pencil-edge` uses `userSpaceOnUse` with an oversized region so perfectly horizontal edges don't collapse the filter to nothing. The comments explain each knob; read them before retuning. `DoodleSelect.tsx` replaces native `<select>`s to keep the style.

## Generated / runtime artifacts (never edit, never commit)

- `server/src/generated/webAssets.ts` — written by `build:binary` only, gitignored, deleted in its `finally`. Don't create by hand.
- `.orca-dag.config.json` (workspace root) — viewer config (per-node harness, default harness, concurrency, layout, last runId). Written by `config.ts` via tmp+rename. Orca tasks have no metadata field, so this file is the viewer's own store.
- `dist-npm/` — the staged npm package, rebuilt from scratch by `scripts/build-npm.mjs` (it `rm -rf`s the dir first). Never hand-edit; the `package.json` in there is generated.
- `dist/`, `web/dist/`, `node_modules/`, `*.tsbuildinfo` — all gitignored.

## Orca integration constraints (also in skill/SKILL.md)

- **`orca orchestration reset --tasks` has NO `--run` scope** — it wipes the *entire* local orchestration DB, every Run at once. To redo one DAG, create a new Run (`run-create`); do **not** reset. The viewer deliberately ships no reset route and no wipe-tasks control for exactly this reason (both removed; New Run is the only safe redraw path), so don't reintroduce either.
- **`task-update` only changes `--status`/`--result`** — no edit to spec/title/deps, no delete-single-task. "Changing a task" = rebuild the DAG.
- **Gates are Run-scoped, but the flag differs by direction**: `gate-list` (read) takes `--run <id>`; `gate-resolve` (mutation) takes NO `--run` — it resolves Run scope from the bound `--from <handle>` (plus a globally-unique `--id`). The viewer binds the coordinator terminal to the Run first via `run-use`, then resolves by `--from`.
- **`HARNESS_LAUNCH` in `orca.ts` only has `claude --dangerously-skip-permissions` verified.** Other harnesses need their own autonomous flag added and verified, and only matter on the legacy path (custom commands or `agent_unconfigured` from `worker-start`).
- **Unacked deliveries deadlock a mailbox** — every `check` replays the oldest unacknowledged Delivery until it is acked, and messages behind it stay invisible. A worker that answers mail but never acks goes permanently deaf while looking alive (observed live on 1.4.205, 2026-09-22: it armed its own inbox watcher, which the replaying old batch starved; unblocking required typing the ack recipe into its TUI). The coordinator loop in `coordinator.ts` processes and acks every delivery each pass, so it cannot hit this; hand-rolled worker loops must ack. Detail lives in `skill/SKILL.md` Boundaries.

## Conventions

- **Rich "why" comments** are the norm for anything touching Orca — the quirks are non-obvious and the comments are load-bearing. Match this style; don't strip context when editing.
- **All docs and user-facing strings are English** (the project is open source; translated 2026-08-11). Keep new UI text, server errors, and docs in English. `README_zh.md` is the Simplified Chinese mirror of `README.md` — update both when changing README content.
- TypeScript is `strict` in both packages; web also enforces `noUnusedLocals`/`noUnusedParameters`. ESM everywhere (`"type": "module"`, ES2022).
