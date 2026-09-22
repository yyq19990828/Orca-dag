# Quiet and Safer DAG Viewer — post-branch acceptance evidence

Governing documents: `docs/PRD.md` (approved P0 scope and acceptance criteria) and
`docs/TECH_SPEC.md`. This is the integration-phase record for the completed P0
branches (P0.1 reset removal, P0.2 header recomposition, P0.3 quiet motion,
P0.4 rendering/polling reduction) reconciled in the working tree.

**Evidence classes, kept separate:**

- **Automated** — `npm run check` (skill validation → typecheck → 341 server tests →
  web build) plus bundle/CLI probes on this machine.
- **Runtime** — read-only HTTP probes (`curl`) against the already-running dev
  server on `127.0.0.1:8787` (started before this task; never restarted, stopped
  or reconfigured by it — it serves the current tree through `tsx watch`, child
  reloaded 15:27, and the freshly built `web/dist` asset `index-DelT7rf-.js`).
- **Visual/behavioral** — agent-browser 0.27.0 (CDP, headless, session
  `orca-dag-acc`, closed at the end). Viewports set with `set viewport`
  (1440×900, 1024×768, 375×812). All geometry claims below are measured
  `getBoundingClientRect()`/`scrollWidth` values, not eyeballed pixels;
  screenshots are recorded artifacts in `/tmp/opencode/quiet-viewer/`
  (kept out of the repo per this project's convention — no generated files in Git).

**Headline result: `npm run check` green; all 10 PRD acceptance criteria pass or
are covered exactly as stated below; zero integration defects found — no code
changes were required by evidence, so none were made.**

---

## 1. PRD acceptance criteria → evidence

### AC1 — No `Clear tasks` control, no `resetTasks` call

- **Automated:** `resetTasks` is absent from `web/src/api.ts` (the helper was
  deleted); `grep -c "resetTasks\|api/reset" web/dist/assets/*.js` → **0**
  matches in the built bundle actually served.
- **Visual:** DOM scan of all `<button>` elements under default motion: the only
  element matching `/clear|reset/i` is an **Activity timeline row** naming the
  task *“Remove unsafe reset”* (hidden panel content, not a control). No reset
  button exists. The top bar renders brand / Run context (picker + New Run) /
  status only.

### AC2 — `POST /api/reset` returns 404; mutation-token protections unchanged

- **Automated:** `server/src/orca.test.ts` ~line 808: “answers POST /api/reset
  with the normal unknown-route 404 (reset removed)”.
- **Runtime:** `curl -X POST http://127.0.0.1:8787/api/reset` → **HTTP 404**
  on the live server. The route-registration site in `server/src/app.ts`
  (~1547) carries the why-comment (no `--run` scope ⇒ never exposed); every
  other POST/PUT still requires the `X-Orca-Dag-Token` session token
  (341-test suite green, including the token suites).

### AC3 — Header: no overlap or page-level horizontal overflow at 1440×900, 1024×768, 375×812

Measured with `getBoundingClientRect()`; overlap = pairwise intersection area of
the three header regions (px²); overflow = `document.documentElement.scrollWidth
> window.innerWidth`.

| Viewport | Layout observed | Region rects (x…right, y, h) | Pairwise overlap | scrollWidth vs viewport |
| --- | --- | --- | --- | --- |
| 1440×900 | single row, header h=65 | brand 22…533 y12 h39 · run 551…1132 y13.5 h36 · status 1150…1418 y18 h27 | 0 / 0 / 0 | 1440 = 1440 ✅ |
| 1024×768 | two rows, header h=111 | brand 22…533 y12 · run 22…329 y61 (own row) · status 734…1002 y18 (row 1, right) | 0 / 0 / 0 | 1024 = 1024 ✅ |
| 375×812 | stacked, header h=139 | brand 14…222 y10 · run 14…361 y56 · status 93…361 y100 | 0 / 0 / 0 | 375 = 375 ✅ |

- At 375 px the Run row spans the full padded width (x=14, right=361 of
  375−14), and the subtitle is `display: none` (the phone release valve) —
  both as designed in `styles.css`.
- The widest painted box is the React Flow viewport transform (right=817 at
  375 px) but it lives inside the clipped `.dag-canvas` pane and produces no
  document-level scrollbar (`scrollWidth` stays 375).
- Boundary note, recorded factually: the media query is
  `@media (max-width: 1024px)`, so the two-row layout is already active **at
  exactly 1024 px**. The PRD phrase is “below 1024 px”; the acceptance criterion
  (no overlap / no overflow at 1024×768) passes either way, and the inclusive
  boundary matches the shipped CSS as reviewed.
- Screenshots: `desktop-1440x900.png`, `tablet-1024x768.png`, `phone-375x812.png`.

### AC4 — After entrance feedback settles ≥2 s, no running animation targets inside `.dag-canvas`

- **Visual (default motion):** ≥2.5 s after load, `document.getAnimations()`
  returned **exactly 1** animation document-wide: `pulse` on
  `span.exec__pulse` — the one sanctioned persistent running indicator
  (PRD decision 3), which lives in the ExecControls toolbar **outside** the
  canvas. Animations with `playState === "running"` whose target is inside
  `.dag-canvas`: **0**. Finished/filling canvas one-shots present at the
  sampling instant: none lingering.
- The same audit was repeated after ≥3 poll cycles, after a node selection,
  and after a viewport change — always 0 running canvas animations.
- **Visual (reduced motion):** fresh load under
  `agent-browser set media reduced-motion` → `document.getAnimations()` = **0**
  document-wide (even `.exec__pulse` is suppressed by the
  `prefers-reduced-motion` block); all 6 nodes render final states (5 completed
  stamps, 6 static scribbles, statuses intact) — no hidden JS animation loop.
  Screenshot: `desktop-1440x900-reduced-motion.png`.

### AC5 — A stable DAG poll does not cause a React Flow commit

- **Code path:** `App.refresh` keeps the previous state object when the payload
  is byte-identical (`sameJson(prev, next) ? prev : next`), so a no-op poll
  changes no prop React Flow receives.
- **Browser proxy (bundle has no React instrumentation):** tagged all 6
  `.react-flow__node` DOM instances with a JS property, waited 7 s (≥3 poll
  ticks at the observed 2 s cadence), then re-read: same 6 instances (tags
  intact ⇒ no remount), **zero** `style.transform` changes, 0 running canvas
  animations (a remount would replay the `node-in` entrance and show up here).

### AC6 — Selecting a node / changing model or harness does not invoke `applyLayout`

- **Code path:** the layout memo in `DagView.tsx` is keyed on
  `[topologyKey, layout, reorgNonce]` where `topologyKey` covers only node ids
  and dependency edges; selection, lead, harness and worker rows decorate in a
  separate reconcile stage that merges onto the memoized positions.
- **Browser proxy (real CDP mouse):** dragged node “Quiet canvas motion” from
  `translate(20px, 344px)` to `translate(158.512px, 422.403px)`; then clicked
  node “Remove unsafe reset” to change selection. After selection: the dragged
  node **kept** the dragged transform (a re-layout would have cleared the drag
  set and snapped it back), all DOM instances persisted, and 0 canvas
  animations were running. Screenshot: `desktop-1440x900-selected.png`.
  (Model/harness re-picks flow through the identical decoration path as
  selection — same memo key — and additionally require an unlocked node; not
  exercised as a mutation from this deliberately read-only pass.)

### AC7 — `/api/run-status` has one periodic caller, not two

- **Runtime/behavioral:** a `PerformanceObserver` recorded every `/api/*`
  resource for **108.6 s** while visible. `/api/run-status`: **54 requests,
  median gap 2000 ms (min 1963, max 2037)** — exactly one per 2 s tick, with
  timestamps co-incident (same ms) with `/api/dag` and `/api/workers`, i.e.
  App’s single `refreshExecutionState` pass. A second poller would have shown
  ~108 requests or off-cycle interleave. Full cadence table in §3.
- **Code path:** `ExecControls` and `RecoveryPanel` receive the snapshot as a
  prop; ExecControls reconciles after Stop via an App callback (one-off), not
  by fetching.

### AC8 — A hidden page produces no periodic viewer API requests after in-flight requests settle

- **Method:** real browser visibility change — the viewer tab was backgrounded
  by opening and focusing a second tab (`about:blank`) in the same session, and
  re-focused afterwards; `visibilitychange` markers were logged page-side with
  `performance.now()`.
- **Result:** hidden for **16 905 ms**. `/api/*` requests in
  [hide + 2 s, re-visible] — i.e. after in-flight settle: **0**. The settling
  window itself was also empty: the last tick had already completed when the
  tab hid, so polls stopped instantly.
- **Resume path:** on re-visible, exactly one immediate refresh per active
  poller fired 234 ms later (one each of `/api/dag`, `/api/run-status`,
  `/api/workers`, `/api/runs`, `/api/run-health`), then the 2 s / 10 s / 5 s
  cadences resumed. The open SSE activity stream produced no new request while
  hidden (the client marks missed pushes dirty instead).

### AC9 — A dense graph mounts only visible React Flow nodes and edges after zooming into a subset

- **Mechanism proven on the available fixture:** with the whole graph fitted,
  6/6 task nodes and 6/6 edges mounted. Zooming in (Controls button, viewport
  `scale(2)`) left **4 of 6 nodes mounted** — exactly the four whose labels are
  on screen (“Optimize top bar”, “Reduce viewer polling”, “Quiet canvas
  motion”, “Reduce layout churn”); the two off-screen nodes were unmounted.
  Fitting again restored 6/6. `onlyRenderVisibleElements` is demonstrably
  culling off-screen DOM.
- **Fixture limitation (honest):** the only Run in this workspace is this PRD’s
  own Run — **6 tasks** — which is not “dense”. Edge culling could not be
  separated on it (all 6 dependency edges touch at least one mounted node at
  the tested zoom, and React Flow keeps edges whose endpoints are mounted).
  Building a genuinely dense fixture would mean creating a scratch Run/tasks in
  the local orchestration DB — a real mutation with no delete path (single-task
  delete does not exist and `reset` is forbidden) — so it was deliberately not
  done. The culling mechanism itself is evidenced above; the
  hundreds-of-nodes performance claim is **not** made.

### AC10 — `npm run check` passes

- Green on the integrated tree before any browser work and re-run green after
  the evidence document was written: skill validation → `tsc -p server` +
  `tsc -b web` → **341 tests, 0 failures** → `vite build`
  (`web/dist/assets/index-DelT7rf-.js`, 503.77 kB / 161.62 kB gzip).

---

## 2. Task-specific checks beyond the AC list

### Accessibility labels

Observed in the loaded DOM (default motion, 1440×900):

- **Task nodes (6/6):** `role="group"` + `aria-label` composed from live facts,
  e.g. *“Remove unsafe reset. Done. Harness opencode.”*,
  *“Viewer acceptance. Running. Harness opencode.”*
- **Connectivity pill:** `role="status"`, `tabIndex=0`,
  `aria-label="Connected to Orca 1.4.206 · orca (execution enabled)"`
  (same string as the hover `title` — one source, `connDetail` in `App.tsx`).
- **Communication center:** tablist `role="tablist"`
  `aria-label="Communication view"` with Activity/Operations/Chat
  `role="tab"` + `aria-selected`; close button
  `aria-label="Close communication center"`.
- **Resize handle:** `role="separator"`, `aria-label="Resize communication
  panel"`, `aria-orientation="vertical"`, `aria-valuemax="820"`, `tabIndex=0`
  (arrow-key resizable).
- **Run picker trigger:** `aria-haspopup="listbox"` + `aria-expanded`
  (DoodleSelect), listbox/option roles inside, search input labeled.
- **Toggles:** 9 buttons expose `aria-pressed` (Activity/Chat, Hide parent
  links, 3 layout segments, 4 activity filters).
- **Run-health popover** (opened by click, keyboard-reachable chip): panel
  `role="region"` `aria-label="Run ownership and health"`, within viewport
  (924…1264 of 1440), content *“Ownership: Viewer-owned ·
  term_10af3295-9550-454b-96ca-f69a97eb9e0b · generation 9 · Evidence: Tasks 6 ·
  Messages 20 · Workers 8 · Gates 1 (0 pending) · No warnings…”* — honest
  ownership facts from the Run record.

### Top-bar geometry

See the AC3 table — the three-region contract (brand / flexible Run context /
health+connectivity) holds at all three widths with zero pairwise overlap and
no page-level horizontal overflow; the ≤1024 px two-row and ≤620 px full-width
Run-row bands behave as specified in `styles.css`.

### Canvas animation absence after settling

See AC4 — 0 running animations targeting `.dag-canvas` in every sampled state
(settled load, mid-poll, post-selection, reduced motion); the document-wide
exception is the sanctioned toolbar `pulse`.

### One periodic `/api/run-status` caller + full cadence

108.6 s visible-window resource log (PerformanceObserver, 1440×900):

| Endpoint | Count | Median gap | Periodic? |
| --- | --- | --- | --- |
| `/api/dag` | 54 | 2000 ms | yes — App DAG poll |
| `/api/workers` | 54 | 2000 ms | yes — App execution poll |
| `/api/run-status` | 54 | 2000 ms | yes — **same tick as dag/workers; single owner (App)** |
| `/api/run-health` | 22 | 5000 ms | yes — RunHealthBadge |
| `/api/runs` | 13 | 10000 ms (after initial trio) | yes — RunPicker |
| `/api/session`, `/api/readiness` | 1 each | — | once per page load |
| `/api/config` | 2 | — | GET + one-shot localStorage→server migration write-back (`harness.ts`) |
| `/api/activity` | 1 | — | initial fetch; updates arrive over the SSE stream |
| `/api/audiences` | 1 | — | ChatPanel compose-preview prefetch, one-shot |

Every periodic row is gated by `usePageVisible()` (`web/src/visibility.ts`);
the Operations-tab panels were unmounted (tab inactive), which is why
`/api/requests` is absent entirely.

### Hidden-page polling suspension

See AC8 — 0 requests across a real 16.9 s hidden window; one immediate refresh
per poller on return, then cadence resumed.

---

## 3. Verification record (this phase)

```text
npm run check                          # green (skill check → typecheck → 341 tests → web build)
grep -c "resetTasks\|api/reset" web/dist/assets/*.js   # → 0
curl -X POST http://127.0.0.1:8787/api/reset           # → HTTP 404
curl http://127.0.0.1:8787/api/readiness               # → orca 1.4.206, executionEnabled (read-only)
curl "http://127.0.0.1:8787/api/dag?run=run_62eeda7162f3"  # → 6 nodes / 6 edges / 1 gate (read-only)
# agent-browser session `orca-dag-acc` (headless CDP):
#   set viewport 1440 900 | 1024 768 | 375 812   → geometry + screenshots
#   eval: getAnimations audit, aria audit, rect/overlap/scrollWidth audits
#   eval: PerformanceObserver → cadence table above
#   tab new about:blank → 16.9 s hidden → tab back → hidden-window request log
#   Controls zoom → mounted-node culling count; controls fit → restore
#   set media reduced-motion + reload → 0 animations, final states
#   mouse move/down/move/up (real CDP input) → node drag; click → selection
#   close   # session closed; only this session was created/closed by this task
```

Screenshots (kept outside the repo): `/tmp/opencode/quiet-viewer/` —
`desktop-1440x900.png`, `tablet-1024x768.png`, `phone-375x812.png`,
`desktop-1440x900-selected.png`, `desktop-1440x900-reduced-motion.png`.

Server discipline: the viewer used throughout was the **already-running**
`npm run dev:server` process (bind 127.0.0.1:8787, pid tree untouched, still
healthy at close-out). No port was taken, no process was killed, no Run was
started or stopped, no worker dispatched, no task status mutated, no reset
invoked, and no coordinator action was taken — every viewer interaction in this
document is a read or a pure client-side UI state change.

## 4. Integration reconciliation outcome

The four P0 branches compose coherently in the working tree; the specific
seams an integration pass exists to catch were checked and held:

- reset removal is complete on **all three** surfaces (UI control, `api.ts`
  helper, HTTP route + tests) with the why-comments preserved in `app.ts`,
  `README.md`/`README_zh.md` and `skill/SKILL.md`;
- the header bands in `styles.css` match the markup regions in `App.tsx`
  (brand → run → status order preserved at every width — tab order never
  changes, only `order`/wrapping);
- the motion budget has exactly one sanctioned indefinite animation
  (`.exec__pulse`, outside the canvas) and the reduced-motion block removes
  even that with final states intact;
- polling consolidation left **one** `/api/run-status` owner (App) with
  `ExecControls`/`RecoveryPanel` as prop consumers, and every periodic caller
  shares the one `usePageVisible()` source;
- layout is staged (topology-keyed memo → decoration reconcile) so selection,
  harness/model decoration and status polls cannot re-rank nodes, while
  `onlyRenderVisibleElements` culls off-screen DOM.

**No integration defect was proven by evidence; no fix was therefore made.**
The working tree remains exactly the branch integration as received, plus this
document.

## 5. Honest limitations

- **Dense-graph fixture unavailable** (AC9): the only Run in scope is this
  PRD’s 6-task Run. The culling mechanism is demonstrated on it; the
  large-graph performance behavior is not claimed, and building a scratch
  dense Run was rejected as an orchestration-DB mutation with no undo path.
- **AC5/AC6 rely on code-path plus DOM-proxy evidence** — the production bundle
  carries no React commit instrumentation; “no React Flow commit” is
  established by the memoized-state bail-out in `App.tsx`/`DagView.tsx` plus
  the observed absence of remounts, transform churn and re-triggered entrance
  animations across polls and selection.
- **Edge culling was not separable** from node culling on a 6-node graph.
- **Model/harness re-pick** was verified through the selection proxy (same
  memo key, same decoration stage), not by mutating a node’s harness picker.
- **Screenshots are recorded but not pixel-reviewed by the author** — every
  geometry/overlap/overflow claim in this document is a measured DOM value;
  the PNGs stand as corroborating artifacts for a human reviewer.
- **Viewer-owned Run state was observed, not created**: the already-running
  server’s coordinator loop was bound to this Run before the task began
  (popover: “Viewer-owned · generation 9”); this pass neither started nor
  stopped anything and treats that state as pre-existing input.
