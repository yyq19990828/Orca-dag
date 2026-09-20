# Phase 2 evidence — deterministic CLI + workspace resolution

Plan: `docs/plans/1789886261_orca-orchestration-hardening-and-modernization.md`, Phase 2.
Baseline: Phase 1 (loopback/token/validation) present in the same worktree, preserved.
Nothing committed or pushed (constraint).

## What changed

- `server/src/orca.ts` — one resolved `{ executable, prefixArgs }` + workspace identity per process:
  `initOrcaRuntime`/`getOrcaRuntime`; resolution order `ORCA_CLI_COMMAND` (shell-free argv parser,
  operators/redirections/`$()` rejected) → `orca-dev` when `ORCA_DEV_REPO_ROOT` → `orca-ide` on Linux
  outside a managed Orca terminal (`ORCA_TERMINAL_HANDLE` probe) → `orca`. Every CLI call spawns the
  resolved spec with `shell: false`, `cwd: <realpath'd WORKSPACE_DIR>`. Worktree selector defaults to
  the exact `path:<WORKSPACE_DIR>` (`ORCA_WORKTREE` still wins). Coordinator titles are now
  `orca-dag coordinator · <workspace-hash> · <instance-id>` (adhoc one-shots carry the same
  hash/instance + `adhoc-N`); same-workspace/different-instance terminals raise `coordinator_conflict`
  (never reused, never closed); legacy unscoped title also conflicts with an `uninstall` pointer.
  Coordinator terminals are created with a parked OSC-0 title command (`coordinatorTerminalCommand`)
  because an interactive shell overwrites `--title` immediately — verified live, see below.
  Readiness: `checkReadiness`/`evaluateReadiness` (execution floor 1.4.205, view-only band 1.4.160+
  with upgrade reason, missing-CLI reason), 30s cache.
- `server/src/index.ts` — `initOrcaRuntime()` right after subcommand dispatch (fatal, actionable
  message on bad `WORKSPACE_DIR`); resolution printed at startup; readiness verdict logged; help text
  updated. Uninstall keeps the raw (non-realpath'd) workspace for its config path.
- `server/src/app.ts` — `GET /api/readiness`; execution gate (503 `execution_disabled` with the
  readiness reason) on `POST /api/runs`, `POST /api/run`, gate resolve, `POST /api/reset`, applied
  AFTER token+validation so Phase 1 ordering is intact; `coordinator_conflict` → HTTP 409; readiness
  probe injectable for tests.
- `server/src/uninstall.ts` — reports each coordinator terminal's workspace (hash + directory from
  `worktreePath`) before closing; prefix discovery unchanged.
- `server/src/orca.test.ts` (new) — 40+ cases: argv parser (quoting, operators, substitutions),
  resolution order per platform/terminal, workspace realpath/hash/instance, selector rules, title
  grammar, version bands + numeric compare, and fake-`orca` spawning (prefix args + `--json` + cwd,
  A-to-B worktree placement, reuse-own / conflict-foreign / conflict-legacy / ignore-adhoc /
  ignore-other-workspace, readiness against scripted versions, missing CLI).
- Web: `types.ts` `OrcaReadiness`; `api.ts` `fetchReadiness`; `harness.ts` `useReadiness()` store;
  `ExecControls` Run button disabled + "View-only" + reason; `GatePanel` resolutions disabled with
  reason; `App` Clear-tasks disabled + amber `conn--warn` badge.
- Docs: `README.md`, `README_zh.md` (resolution section, prerequisites, switches, uninstall,
  readiness section, API table, code layout), `AGENTS.md` (env vars, resolution, titles/conflict,
  1.4.205 execution floor, test entry point).

## Acceptance evidence

- Executable-resolution branches, quoted paths, rejected operators, missing executables:
  `orca.test.ts` suites `parseCliCommand`, `resolveOrcaCommand`, `evaluateReadiness` — all pass.
- `WORKSPACE_DIR=/abs/B` from cwd A → coordinator created in B: unit-proven via fake-`orca` call log
  (`terminal create --worktree path:<B>`) in `orca.test.ts`; the real-Orca A→A run confirmed the
  `path:` selector is accepted by the runtime.
- Two viewers, different workspaces never share a coordinator; second viewer on the SAME workspace
  refused without fencing the first: unit-tested against the fake CLI (only `terminal list` runs —
  no create/close), and verified LIVE against Orca 1.4.205: process B got
  `coordinator_conflict … already coordinating this workspace … (term_5b4a19f7…)` while process A
  held `orca-dag coordinator · 6b824a8f · 8242dc29`.
- Linux outside Orca never runs `/usr/bin/orca` (GNOME screen reader v42): resolution shown live —
  outside → `orca-ide`, inside → `orca`.
- Title discovery on real Orca: bare-shell terminals lose their title instantly (observed: title
  became `~/桌面/Orca-dag`); the parked OSC-0 command keeps `orca-dag coordinator · …` stable and
  uninstall finds it: live `uninstall --dry-run` printed
  `would close Orca terminal "orca-dag coordinator · 6b824a8f · d4c7d8be" … — workspace 6b824a8f (/home/tyjt/桌面/Orca-dag)`.
  Same-process reuse confirmed live (`REUSED=true`, single terminal). All test terminals closed; no
  coordinator terminals left behind.
- Server typecheck: `npx tsc -p server/tsconfig.json --noEmit` clean.
- Tests: `npm test -w server` → 91/91 pass (21 suites; `app.test.ts`/`security.test.ts` from Phase 1
  unchanged and green).
- Web build: `npm run build -w web` (tsc -b + vite) clean.
- Package smoke (rebuilt final code): `npm pack dist-npm`, booted with Node on :8793 —
  `/api/health` (workspace + `path:` worktree), `/api/readiness` (orca 1.4.205, executionEnabled
  true), `/` 200, mutation without token 403. View-only boot (unresolvable `ORCA_CLI_COMMAND`) on
  :8792 — readiness honest (`version: null` + actionable reason), `POST /api/run` with valid token →
  503 `execution_disabled`, startup log explains view-only.
- Binary smoke: `TARGET=bun-linux-x64 npm run build:binary` → `dist/orca-dag` (101 MB) booted on
  :8794 — health/readiness/root/403 all pass.
- `git diff --check` clean; no stray smoke processes; nothing committed.

## Deviations / notes for review

- The plan's title scheme assumed `terminal list` preserves `--title`; on the live runtime a shell
  rewrites it at once. Resolution: coordinator (and adhoc) terminals are created with
  `--command 'printf <OSC-0 title> && exec sleep infinity'` — the coordinator is an identity pane
  that is never typed into, so parking it is behavior-neutral, and title-based reuse/conflict/
  uninstall discovery actually works. Documented in `coordinatorTerminalCommand`.
- Legacy (pre-Phase-2) unscoped coordinator terminals are treated as a conflict (unattributable to a
  workspace) with an `npx orca-dag uninstall` pointer, rather than silently adopted.
- Readiness gating is server-side (503) as well as UI-side, so view-only holds even for non-UI
  callers; `POST /api/run-stop` deliberately stays available (de-escalation is safe and keeps the
  Phase 1 smoke contract).
- Blockers: none.
