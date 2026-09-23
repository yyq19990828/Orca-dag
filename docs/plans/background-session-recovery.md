# Background session recovery

## Goal

After the viewer restarts or a Run stops, preserve each Stage's exact Orca
Dispatch identity and, where available, its exact Claude, Codex, or OpenCode
session identity. Rejoin a live attempt without placing a duplicate worker.
Terminal closure alone never decides whether a background agent has exited.

## Evidence and authority

Orca owns Run, Task, Dispatch, coordinator binding, and settlement. A harness
session is a separate execution identity. A session binding is usable only when
it names the same Run, Task, Dispatch, harness, workspace, and execution host.
The viewer stores the binding durably beside its workspace config. Provider
status is observational: `active`, `idle`, `exited`, `unknown`, or
`unavailable`. None of those statuses settles an Orca Task by itself.

`worker-list --include-remote` and Task records are read before any recovery
decision. A remote host that cannot be queried is `unavailable`, never
`exited`. A command or message accepted for delivery proves enqueue only; it
does not prove that the agent read it or resumed work.

## Recovery decisions

| Orca / provider evidence | Decision |
| --- | --- |
| Active supervised Dispatch | Adopt its existing Dispatch and account for its slot. |
| Active legacy Dispatch with an exact, active session | Hold the original Dispatch; show the provider observation; do not place another worker. |
| Session idle while Task is still dispatched | Surface the mismatch for review. A future reconciliation message must target the exact Dispatch, use one durable request ID, and verify a response before any retry. |
| Worker is waiting on a question or permission | Surface the request; do not send a generic activation. |
| Session or remote host cannot be verified | Hold the Stage and its concurrency slot. |
| Dispatch was stopped but the provider session is active or unknown | Treat it as detached work; block replacement until the old attempt is positively settled or deliberately handed off. |
| Provider exited and Orca positively settled the old attempt | A user may start a new Dispatch with `--retry-of`; resuming a provider session requires the exact recorded session ID and a verified harness route. |

No recovery path broadcasts an activation message. In particular, a lost
terminal, an idle provider, or a timed-out status query is not permission to
create a second Dispatch.

## Implementation slices

1. Add a workspace-local, atomic binding store and conservative read-only
   provider probes. Validate IDs and host/workspace before querying.
2. Reconcile those observations with Orca's startup and periodic fleet reads.
   Expose both authorities separately in coordinator status and keep unknown
   attempts in the concurrency budget.
3. Add token-guarded binding and on-demand probe routes. Verify that the
   supplied Dispatch belongs to the requested Run and Task before writing.
4. Show the binding, provider status, and Orca Dispatch status in Recovery.
   Refresh probes on demand, and explain why an enqueued message is not a
   completion or liveness signal.

## Current identity paths and remaining boundary

The viewer now captures provider-issued IDs when identity is unique:
OpenCode uses a Dispatch-specific title set by this viewer; Codex's App Server
thread list must contain both exact Task and Dispatch IDs in its original
preamble and the exact workspace; Claude's agent-list PID must carry the exact
Orca worker terminal handle in its process environment. Each capture is
checked against Orca's Run/Task/Dispatch/host/workspace record. Failure or
ambiguity leaves the manual exact-ID binding available. The viewer never
chooses the "most recent" session.

The shared Codex App Server can report `active` or `idle` for a loaded exact
thread. `notLoaded` is `unknown`: another process may own the work, and no
provider exit has been proven. A future resume path must settle or fence the
previous Dispatch first and verify that a resumed session is attached to the
*new* Dispatch's authority; reopening a provider conversation alone does not
do so. The installed Orca 1.4.207 preamble currently omits the documented
`--dispatch-capability` argument, so a Codex worker may be unable to send
`worker_done`; session discovery does not repair that Orca runtime contract.

## Review criteria

- Restarting the viewer adopts a live supervised Dispatch without duplicate
  placement; background/remote unknowns remain visible and consume capacity.
- A binding cannot cross Run, Task, Dispatch, workspace, or host boundaries.
- Provider probe failures stay `unknown` or `unavailable`; terminal closure is
  never translated into provider exit.
- The UI shows Orca and provider evidence separately and offers no automatic
  activation or replay based only on message enqueue.
