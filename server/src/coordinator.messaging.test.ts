import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { answerInboxItem, acknowledgeStopEvent, sendTaskGuidance, coordinatorStatus, shouldPersistCoordinatorCheck, startCoordinator, stopCoordinator, withLifecycleMutation, type CoordinatorActivityNotice, type CoordinatorCheckReceipt } from "./coordinator";
import { runOrca } from "./orca";
import { ProviderSessionStore } from "./providerSessions";
import { RequestLedger } from "./requestLedger";
import { setupCoordinatorHarness } from "./testHelpers/coordinatorHarness";

const {
  workspace,
  calls,
  callsOf,
  ackCalls,
  mutateState,
  getState,
  baseOpts,
  coordinatorTerminal,
  settleViaWorkerDone,
  settleViaTaskStatus,
  injectMail,
  workerDoneMessage,
  waitFor,
  attempt,
  findAttempt,
  dispatchIdOf,
  startApp,
  singleTaskState,
} = setupCoordinatorHarness();

describe("heartbeat handling", () => {
  it("records heartbeats as liveness evidence and never as completion", async () => {
    const runId = "run_beat";
    const persistedChecks: CoordinatorCheckReceipt[] = [];
    await singleTaskState(runId);
    await startCoordinator(
      baseOpts(runId, {
        modelByTask: { task_aaa: "gpt-check" },
        effortByTask: { task_aaa: "max" },
        onCheck: async (receipt) => {
          persistedChecks.push(receipt);
        },
      }),
    );
    await waitFor(() => (calls("worker-start").length === 1 ? true : null), "worker to start");
    const dispatchId = await dispatchIdOf("task_aaa");
    await injectMail([
      {
        id: "msg_beat",
        run_id: runId,
        type: "heartbeat",
        from_handle: "term_worker",
        subject: "alive",
        body: "",
        payload: JSON.stringify({ taskId: "task_aaa", dispatchId, phase: "working" }),
        created_at: "2026-01-01T00:00:05Z",
      },
    ]);
    await waitFor(() => (attempt("task_aaa").lastHeartbeatAt === "2026-01-01T00:00:05Z" ? true : null), "heartbeat recorded");
    assert.equal(attempt("task_aaa").settled, false, "a heartbeat is not completion");
    assert.notEqual(coordinatorStatus().phase, "completed");
    const checkedAgent = await waitFor(
      () =>
        coordinatorStatus().checks
          .flatMap((receipt) => receipt.agents)
          .find((agent) => agent.taskId === "task_aaa" && agent.model === "gpt-check") ?? null,
      "runtime launch echo in a check receipt",
    );
    assert.equal(checkedAgent.agent, "claude");
    assert.equal(checkedAgent.effort, "max");
    await waitFor(
      () =>
        persistedChecks.some((receipt) => receipt.messageTypes.includes("heartbeat"))
          ? true
          : null,
      "heartbeat delivery check to persist",
    );
    const heartbeatCheck = persistedChecks.find((receipt) => receipt.messageTypes.includes("heartbeat"))!;
    const quietSame = {
      ...heartbeatCheck,
      checkedAt: heartbeatCheck.checkedAt + 1,
      messageCount: 0,
      messageTypes: [],
      deliveryId: null,
    };
    const quietPrevious = { ...quietSame, checkedAt: quietSame.checkedAt - 1 };
    assert.equal(
      shouldPersistCoordinatorCheck(quietSame, quietPrevious),
      false,
      "an identical empty check remains memory-only",
    );
    assert.equal(
      shouldPersistCoordinatorCheck(
        { ...quietSame, agents: quietSame.agents.map((agent) => ({ ...agent, detail: "new tool call" })) },
        quietPrevious,
      ),
      true,
      "an agent-state change is meaningful",
    );
    assert.equal(
      shouldPersistCoordinatorCheck({ ...quietSame, error: "connection lost" }, quietPrevious),
      true,
      "a new error is meaningful",
    );
    await stopCoordinator();
  });
});

describe("bidirectional coordinator chat", () => {
  it("records a Task assignment only after its worker start succeeds", async () => {
    const runId = "run_assignment";
    await singleTaskState(runId);
    await mutateState((state) => {
      state.tasks.task_aaa.spec = "Target: add the focused regression test. Constraints: keep scope narrow.";
    });
    const events: CoordinatorActivityNotice[] = [];
    await startCoordinator(
      baseOpts(runId, {
        onActivity: async (event) => {
          events.push(event);
        },
      }),
    );

    await waitFor(() => (events.length === 1 ? true : null), "assignment activity");
    assert.equal(events[0].kind, "dispatch_started");
    assert.equal(events[0].taskId, "task_aaa");
    assert.match(String(events[0].dispatchId), /^ctx_s/);
    assert.equal(events[0].title, "Assigned this stage");
    assert.match(String(events[0].detail), /focused regression test/);
  });

  it("sends proactive guidance to an active Dispatch and journals the confirmed enqueue", async () => {
    const { call } = await startApp();
    const runId = "run_guidance";
    await singleTaskState(runId);
    await startCoordinator(baseOpts(runId));
    await waitFor(() => (calls("worker-start").length === 1 ? true : null), "worker to start");
    const dispatchId = await dispatchIdOf("task_aaa");

    const sent = await call("POST", "/api/tasks/task_aaa/messages", {
      runId,
      body: "Please add the missing edge-case assertion.",
    });
    assert.equal(sent.status, 200);
    assert.equal(sent.json.dispatchId, dispatchId);
    assert.equal(calls("send").length, 1);
    const sendArgv = calls("send")[0].argv;
    assert.deepEqual(sendArgv.slice(sendArgv.indexOf("--to"), sendArgv.indexOf("--to") + 2), [
      "--to",
      `dispatch:${dispatchId}`,
    ]);
    assert.deepEqual(sendArgv.slice(sendArgv.indexOf("--task-id"), sendArgv.indexOf("--task-id") + 2), [
      "--task-id",
      "task_aaa",
    ]);

    const activity = await call("GET", `/api/activity?run=${runId}`);
    assert.equal(activity.status, 200);
    const events = (activity.json.events as Array<Record<string, unknown>>) ?? [];
    const guidance = events.find((event) => event.direction === "coordinator_to_agent" &&
      event.taskId === "task_aaa" && event.dispatchId === dispatchId &&
      event.summary === "Please add the missing edge-case assertion.");
    assert.ok(guidance, "confirmed outbound guidance must appear in activity");
    assert.equal(guidance.direction, "coordinator_to_agent");
    assert.equal(guidance.taskId, "task_aaa");

    const sendCount = calls("send").length;
    const wrongRun = await call("POST", "/api/tasks/task_aaa/messages", {
      runId: "run_someone_else",
      body: "This must not cross the Run boundary.",
    });
    assert.equal(wrongRun.status, 409);
    assert.equal(wrongRun.json.code, "not_running");
    assert.equal(calls("send").length, sendCount, "wrong-Run guidance is refused before send");

    await mutateState((state) => {
      const task = state.tasks.task_aaa;
      const dispatch = state.dispatches[task.dispatch_id];
      task.status = "completed";
      dispatch.status = "completed";
      dispatch.terminalState = "reclaimable";
    });
    const settled = await call("POST", "/api/tasks/task_aaa/messages", {
      runId,
      body: "This must not target a settled Dispatch.",
    });
    assert.equal(settled.status, 409);
    assert.equal(settled.json.code, "active_dispatch_required");
    assert.equal(calls("send").length, sendCount, "settled guidance is refused before send");

    await stopCoordinator();
    const refused = await call("POST", "/api/tasks/task_aaa/messages", {
      runId,
      body: "This must not be sent after the coordinator stops.",
    });
    assert.equal(refused.status, 409);
    assert.equal(refused.json.code, "not_running");
    assert.equal(calls("send").length, sendCount, "refusal happens before Orca send");
  });
});

describe("questions hold the Delivery open", () => {
  it("surfaces a question, replies via the API, then acknowledges the Delivery exactly once", async () => {
    const { call } = await startApp();
    const runId = "run_ask";
    await singleTaskState(runId);
    await startCoordinator(baseOpts(runId));
    await waitFor(() => (calls("worker-start").length === 1 ? true : null), "worker to start");
    const dispatchId = await dispatchIdOf("task_aaa");

    // One FIFO batch carrying BOTH the settlement and a question. The task and
    // Dispatch flip in the same locked write, exactly like the runtime's own
    // settlement write that accompanies an accepted worker_done.
    const deliveryId = await mutateState((s) => {
      const task = s.tasks.task_aaa;
      const dispatch = s.dispatches[task.dispatch_id];
      task.status = "completed";
      dispatch.status = "completed";
      dispatch.terminalState = "reclaimable";
      s.archives ??= {};
      s.archives[task.dispatch_id] = "output";
      s.seq ??= {};
      s.seq.delivery = (s.seq.delivery ?? 0) + 1;
      const id = `delivery_q${s.seq.delivery}`;
      const handle = coordinatorTerminal(s).handle;
      s.mailboxes ??= {};
      s.mailboxes[handle] = [
        {
          deliveryId: id,
          messages: [
            workerDoneMessage("task_aaa", task.dispatch_id, "succeeded", "msg_done_q"),
            {
              id: "msg_question",
              run_id: runId,
              type: "question",
              from_handle: `dispatch:${dispatchId}`,
              to_handle: null,
              subject: "Which database?",
              body: "postgres or sqlite?",
              priority: "high",
              thread_id: null,
              payload: JSON.stringify({ taskId: "task_aaa", dispatchId: task.dispatch_id }),
              created_at: "2026-01-01T00:00:06Z",
              delivered_at: "2026-01-01T00:00:06Z",
            },
          ],
        },
      ];
      return id;
    });

    // Settlement + release processed; the question is surfaced; no ack yet.
    await waitFor(() => (attempt("task_aaa").terminalDecision === "released" ? true : null), "settlement in the batch to process");
    await waitFor(() => (coordinatorStatus().inbox.pending.some((i) => i.messageId === "msg_question") ? true : null), "question to surface");
    assert.equal(ackCalls(deliveryId).length, 0, "no ack while the question is open");
    // The phase flips in the reconcile that closes the pass which surfaced the
    // question — wait for it rather than racing the same tick.
    await waitFor(() => (coordinatorStatus().phase === "awaiting_input" ? true : null), "awaiting_input while the question is open");

    // The compatibility Inbox view is explicitly Run-scoped, just like the
    // Activity surface that replaces it in the web client.
    const inbox = await call("GET", `/api/inbox?run=${runId}`);
    assert.equal(inbox.status, 200);
    assert.equal((inbox.json.inbox as any).pending.length, 1);

    // Reply over HTTP — routed through the live coordinator, which acks.
    const reply = await call("POST", "/api/messages/msg_question/reply", { runId, body: "sqlite is fine" });
    assert.equal(reply.status, 200);
    await waitFor(() => (coordinatorStatus().inbox.pending.length === 0 ? true : null), "question cleared");

    assert.equal(calls("reply").length, 1);
    assert.deepEqual(calls("reply")[0].argv.slice(2, 7), ["--id", "msg_question", "--body", "sqlite is fine", "--from"]);
    const activity = await call("GET", `/api/activity?run=${runId}`);
    assert.equal(activity.status, 200);
    const events = (activity.json.events as Array<Record<string, unknown>>) ?? [];
    const replyEvent = events.find((event) => event.title === "Coordinator replied to a worker");
    assert.ok(replyEvent, "the successful reply must be journaled");
    assert.equal(replyEvent.taskId, "task_aaa");
    assert.equal(replyEvent.dispatchId, dispatchId);
    await waitFor(() => (ackCalls(deliveryId).length > 0 ? true : null), "delivery ack after reply");
    assert.equal(ackCalls(deliveryId).length, 1, "acked exactly once");
    await waitFor(() => (coordinatorStatus().phase === "completed" ? true : null), "completion after reply");
  });

  it("keeps the next FIFO question after a reply retires the current Delivery", async () => {
    const { call } = await startApp();
    const runId = "run_stale_reply_delivery";
    await singleTaskState(runId);
    await startCoordinator(baseOpts(runId));
    await waitFor(() => calls("worker-start").length === 1 ? true : null, "worker to start");
    const dispatchId = await dispatchIdOf("task_aaa");

    const firstDeliveryId = await injectMail([{
      id: "msg_stale_first",
      run_id: runId,
      type: "question",
      from_handle: `dispatch:${dispatchId}`,
      to_handle: null,
      subject: "First question",
      body: "First answer?",
      priority: "normal",
      thread_id: null,
      payload: JSON.stringify({ taskId: "task_aaa", dispatchId }),
      created_at: "2026-10-17T00:00:01Z",
      delivered_at: "2026-10-17T00:00:01Z",
    }]);
    await waitFor(
      () => coordinatorStatus().inbox.pending.some((item) => item.messageId === "msg_stale_first") ? true : null,
      "first question",
    );
    const secondDeliveryId = await injectMail([{
      id: "msg_stale_second",
      run_id: runId,
      type: "question",
      from_handle: `dispatch:${dispatchId}`,
      to_handle: null,
      subject: "Second question",
      body: "Second answer?",
      priority: "normal",
      thread_id: null,
      payload: JSON.stringify({ taskId: "task_aaa", dispatchId }),
      created_at: "2026-10-17T00:00:02Z",
      delivered_at: "2026-10-17T00:00:02Z",
    }]);
    await settleViaTaskStatus("task_aaa", "succeeded");
    await waitFor(() => attempt("task_aaa").terminalDecision === "released" ? true : null, "worker cleanup");

    const firstReply = await call("POST", "/api/messages/msg_stale_first/reply", { runId, body: "first answer" });
    assert.equal(firstReply.status, 200);
    await waitFor(
      () => coordinatorStatus().inbox.pending.some((item) => item.messageId === "msg_stale_second") ? true : null,
      "question returned after stale_delivery",
    );
    assert.equal(ackCalls(firstDeliveryId).length, 1, "the retired first batch has one stale ack attempt");
    assert.equal(ackCalls(secondDeliveryId).length, 0, "the next question remains unacknowledged");
    assert.equal(coordinatorStatus().phase, "awaiting_input", "completion waits for the next FIFO question");

    const secondReply = await call("POST", "/api/messages/msg_stale_second/reply", { runId, body: "second answer" });
    assert.equal(secondReply.status, 200);
    await waitFor(() => ackCalls(secondDeliveryId).length === 1 ? true : null, "second stale ack attempt");
    await waitFor(() => coordinatorStatus().phase === "completed" ? true : null, "completion after both replies");
  });

  it("acks an invalid-only FIFO batch and processes the next question before completion", async () => {
    const runId = "run_fifo_invalid_then_question";
    await singleTaskState(runId);
    await startCoordinator(baseOpts(runId));
    await waitFor(() => (calls("worker-start").length === 1 ? true : null), "worker to start");
    const dispatchId = await dispatchIdOf("task_aaa");

    const [invalidDeliveryId, questionDeliveryId] = await mutateState((state) => {
      const task = state.tasks.task_aaa;
      const dispatch = state.dispatches[task.dispatch_id];
      task.status = "completed";
      dispatch.status = "completed";
      dispatch.terminalState = "reclaimable";
      state.archives ??= {};
      state.archives[task.dispatch_id] = "output";
      state.seq ??= {};
      state.seq.delivery = (state.seq.delivery ?? 0) + 1;
      const invalidId = `delivery_invalid${state.seq.delivery}`;
      const questionId = `delivery_question${state.seq.delivery}`;
      const handle = coordinatorTerminal(state).handle;
      state.mailboxes ??= {};
      state.mailboxes[handle] = [
        {
          deliveryId: invalidId,
          messages: [{
            ...workerDoneMessage("unknown_task", "ctx_unknown", "succeeded", "msg_invalid_only"),
            run_id: runId,
          }],
        },
        {
          deliveryId: questionId,
          messages: [{
            id: "msg_after_invalid",
            run_id: runId,
            type: "question",
            from_handle: "term_worker",
            to_handle: null,
            subject: "Question after an ignored report",
            body: "Should I keep the existing API?",
            priority: "normal",
            thread_id: null,
            payload: JSON.stringify({ taskId: "task_aaa", dispatchId }),
            created_at: "2026-10-17T00:00:00Z",
            delivered_at: "2026-10-17T00:00:00Z",
          }],
        },
      ];
      return [invalidId, questionId];
    });

    await waitFor(
      () => coordinatorStatus().inbox.pending.some((item) => item.messageId === "msg_after_invalid") ? true : null,
      "question returned by acknowledging the invalid batch",
    );
    await waitFor(() => attempt("task_aaa").terminalDecision === "released" ? true : null, "completed worker cleanup");
    await waitFor(() => coordinatorStatus().phase === "awaiting_input" ? true : null, "question to hold completion");
    assert.equal(ackCalls(invalidDeliveryId).length, 1, "the fully processed invalid batch is acked once");
    assert.equal(ackCalls(questionDeliveryId).length, 0, "the returned question batch stays open");
    assert.equal(coordinatorStatus().phase, "awaiting_input", "the returned question prevents completion");
    assert.equal(coordinatorStatus().running, true, "the coordinator remains bound while input is owed");
    await stopCoordinator();
  });


  it("refuses guidance when Orca marks the active Dispatch unverifiable", async () => {
    const { call } = await startApp();
    const runId = "run_guidance_unverifiable";
    await singleTaskState(runId);
    await startCoordinator(baseOpts(runId));
    await waitFor(() => (calls("worker-start").length === 1 ? true : null), "worker to start");
    const dispatchId = await dispatchIdOf("task_aaa");
    await mutateState((state) => {
      state.livenessOverride ??= {};
      state.livenessOverride[dispatchId] = "unverifiable";
    });

    const before = calls("send").length;
    const refused = await call("POST", "/api/tasks/task_aaa/messages", {
      runId,
      body: "Do not send this while the worker is unverifiable.",
    });
    assert.equal(refused.status, 409);
    assert.equal(refused.json.code, "active_dispatch_required");
    assert.equal(calls("send").length, before, "unverifiable Dispatches are refused before send");
    await stopCoordinator();
  });

  it("allows capability-gap guidance only for an exact live worker observation", async () => {
    const runId = "run_guidance_capability_gap";
    await singleTaskState(runId);
    await startCoordinator(baseOpts(runId));
    const dispatchId = await dispatchIdOf("task_aaa");
    await mutateState(s => {
      s.livenessOverride = { [dispatchId]: "unverifiable" };
      s.livenessReason = { [dispatchId]: "missing_status" };
    });
    const receipt = await sendTaskGuidance({ runId, taskId: "task_aaa", subject: "Guidance", body: "Continue" });
    assert.equal(receipt.kind, "enqueued");
    await mutateState(s => {
      s.workerShow = { [dispatchId]: {
        dispatch: { id: dispatchId, runId, task_id: "task_aaa", status: "dispatched" },
        observation: { status: "live", exactWorker: false },
      } };
    });
    await assert.rejects(sendTaskGuidance({ runId, taskId: "task_aaa", subject: "Guidance", body: "Again" }),
      { code: "active_dispatch_required" });
    assert.equal(calls("send").length, 1);
    await stopCoordinator();
  });

  it("refuses guidance after an external coordinator fences the viewer", async () => {
    const runId = "run_guidance_fenced";
    await singleTaskState(runId);
    await startCoordinator(baseOpts(runId));
    await dispatchIdOf("task_aaa");
    await mutateState(s => { s.runs[runId].coordinator_handle = "term_external"; });
    await assert.rejects(sendTaskGuidance({ runId, taskId: "task_aaa", subject: "Guidance", body: "Continue" }),
      { code: "coordinator_control_required" });
    assert.equal(calls("send").length, 0);
    await stopCoordinator();
  });

  it("surfaces escalations the same way and blocks completion until answered", async () => {
    const runId = "run_esc";
    await singleTaskState(runId);
    await startCoordinator(baseOpts(runId));
    await waitFor(() => (calls("worker-start").length === 1 ? true : null), "worker to start");

    await injectMail([
      {
        id: "msg_esc",
        run_id: runId,
        type: "escalation",
        from_handle: "term_worker",
        to_handle: null,
        subject: "Cannot access the registry",
        body: "push denied",
        priority: "urgent",
        thread_id: null,
        payload: JSON.stringify({ taskId: "task_aaa", dispatchId: attempt("task_aaa").dispatchId }),
        created_at: "2026-01-01T00:00:07Z",
        delivered_at: "2026-01-01T00:00:07Z",
      },
    ]);
    await waitFor(() => (coordinatorStatus().inbox.pending[0]?.kind === "escalation" ? true : null), "escalation surfaced");
    // The phase flips in the same iteration's boundary check — poll it rather
    // than assert against a mid-iteration snapshot.
    await waitFor(() => (coordinatorStatus().phase === "awaiting_input" ? true : null), "awaiting_input phase");
    await stopCoordinator();
  });
  it("resolves stop events by exact steering without clearing a real question", async () => {
    const runId = "run_stop_event";
    await singleTaskState(runId);
    await startCoordinator(baseOpts(runId, { maxConcurrency: 3 }));
    const dispatchId = await dispatchIdOf("task_aaa");
    const event = { ...workerDoneMessage("task_aaa", dispatchId, "succeeded", "msg_stop_event"),
      run_id: runId, type: "escalation", payload: JSON.stringify({ dispatchId, stopReason: "finished" }) };
    const question = { ...workerDoneMessage("task_aaa", dispatchId, "succeeded", "msg_real_question"),
      run_id: runId, type: "question", payload: JSON.stringify({ taskId: "task_aaa", dispatchId }) };
    await injectMail([event, question]);
    await waitFor(() => coordinatorStatus().inbox.pending.length === 2 ? true : null, "stop and question");
    assert.equal(coordinatorStatus().inbox.pending.find(item => item.messageId === event.id)?.kind, "stop_event");
    await assert.rejects(answerInboxItem(event.id, "yes"), { code: "stop_event_not_question" });
    await sendTaskGuidance({ runId, taskId: "task_aaa", subject: "Continue", body: "Please continue." });
    await waitFor(() => !coordinatorStatus().inbox.pending.some(item => item.messageId === event.id) ? true : null, "stop event resolution");
    assert.ok(coordinatorStatus().inbox.pending.some(item => item.messageId === question.id));
    const checkpoints = await new ProviderSessionStore(workspace).listMailboxChecks(runId);
    assert.ok(checkpoints.some(row => row.resolvedStopEvents?.[event.id]?.dispatchId === dispatchId));
    await stopCoordinator();
  });
  it("keeps the original event pending after a confirmed redirect to a child Run inbox", async () => {
    const runId = "run_stop_redirect";
    await singleTaskState(runId);
    await startCoordinator(baseOpts(runId));
    const dispatchId = await dispatchIdOf("task_aaa");
    const event = { ...workerDoneMessage("task_aaa", dispatchId, "succeeded", "msg_stop_redirect"),
      type: "escalation", payload: JSON.stringify({ dispatchId, stopReason: "needs-input" }) };
    await injectMail([event]);
    await waitFor(() => coordinatorStatus().inbox.pending.some(item => item.messageId === event.id), "original stop event");
    const requestId = "req_child_redirect";
    const timestamp = new Date().toISOString();
    const store = new ProviderSessionStore(workspace);
    await mutateState(s => {
      s.requests[requestId] = { state: "completed", method: "orchestration.send",
        outcome: { mutation: { requestId }, message: { run_id: "run_child", to_handle: "run:run_child" },
          warnings: [{ code: "recipient_run_bound_redirect", recipient: `dispatch:${dispatchId}` }] } };
    });
    await store.recordGuidanceSend({
      requestId, runId, requestedTaskId: "task_aaa", requestedDispatchId: dispatchId, from: coordinatorTerminal(getState()).handle,
      state: "prepared", receipt: null, creationProven: false, createdAt: timestamp, updatedAt: timestamp, error: null,
    });
    const observed = coordinatorStatus().lastReconciledAt;
    await waitFor(() => callsOf("request-show", "--request", requestId).length > 0 && coordinatorStatus().lastReconciledAt > observed,
      "native redirect reconciliation");
    assert.equal((await store.listGuidanceSends(runId))[0].receipt?.kind, "recipient_run_bound_redirect");
    assert.ok(coordinatorStatus().inbox.pending.some(item => item.messageId === event.id));
    assert.ok((await store.listMailboxChecks(runId)).every(row => !row.resolvedStopEvents?.[event.id]));
  });

  it("recovers only the exact native permission decision and persists it before clearing the message", async () => {
    const runId = "run_permission_decision";
    await singleTaskState(runId);
    await startCoordinator(baseOpts(runId));
    const dispatchId = await dispatchIdOf("task_aaa");
    const promptId = "approval_next";
    const event = { ...workerDoneMessage("task_aaa", dispatchId, "succeeded", "msg_permission"),
      type: "escalation", payload: JSON.stringify({ taskId: "task_aaa", dispatchId,
        approval: { approvalId: promptId, state: "open", worker: { dispatchId }, allowedActions: ["allow", "deny"] } }) };
    const unrelated = { ...event, id: "msg_unrelated_permission", from_handle: "dispatch:ctx_unrelated" };
    await injectMail([event, unrelated]);
    await waitFor(() => coordinatorStatus().inbox.pending.filter(item => item.permissionPrompt?.id === promptId).length === 2,
      "pending permission escalations");
    const requestId = "req_permission";
    await new RequestLedger(workspace).record({
      requestId, operation: "worker-approve", runId, taskId: "task_aaa", dispatchId, target: promptId,
    });
    await mutateState(s => {
      s.requests[requestId] = { state: "completed", method: "orchestration.approvalAnswer",
        outcome: { approvalId: promptId, dispatchId, decision: "allow", mutation: { requestId } } };
    });
    await waitFor(() => !coordinatorStatus().inbox.pending.some(item => item.messageId === event.id) ? true : null,
      "exact accepted native decision");
    const rows = await new ProviderSessionStore(workspace).listMailboxChecks(runId);
    assert.deepEqual(rows.find(row => row.resolvedPermissionPrompts?.[event.id])?.resolvedPermissionPrompts?.[event.id],
      { dispatchId, promptId, decision: "approve", requestId });
    assert.ok(coordinatorStatus().inbox.pending.some(item => item.messageId === unrelated.id));
    assert.equal(calls("reply").length, 0);
  });

  it("resolves a stop event on authoritative later settlement without answering a question", async () => {
    const runId = "run_stop_settlement";
    await singleTaskState(runId);
    await startCoordinator(baseOpts(runId));
    const dispatchId = await dispatchIdOf("task_aaa");
    const event = { ...workerDoneMessage("task_aaa", dispatchId, "succeeded", "msg_stopped"),
      run_id: runId, type: "escalation", payload: JSON.stringify({ dispatchId, stopReason: "errored" }) };
    const question = { ...workerDoneMessage("task_aaa", dispatchId, "succeeded", "msg_still_question"),
      run_id: runId, type: "question", payload: JSON.stringify({ taskId: "task_aaa", dispatchId }) };
    await injectMail([event, question]);
    await waitFor(() => coordinatorStatus().inbox.pending.length === 2 ? true : null, "both inputs visible");
    await settleViaWorkerDone("task_aaa", "failed", "msg_later_done");
    await waitFor(() => attempt("task_aaa").outcome === "failed" &&
      !coordinatorStatus().inbox.pending.some(item => item.messageId === event.id) ? true : null, "settlement and stop resolution");
    assert.ok(coordinatorStatus().inbox.pending.some(item => item.messageId === question.id));
    assert.equal(attempt("task_aaa").outcome, "failed");
    await stopCoordinator();
  });
  it("records an explicit stop-event decision without settling its Dispatch", async () => {
    const runId = "run_stop_decision";
    await singleTaskState(runId);
    await startCoordinator(baseOpts(runId));
    const dispatchId = await dispatchIdOf("task_aaa");
    const event = { ...workerDoneMessage("task_aaa", dispatchId, "succeeded", "msg_decision"),
      run_id: runId, type: "escalation", payload: JSON.stringify({ dispatchId, stopReason: "needs-input" }) };
    await injectMail([event]);
    await waitFor(() => coordinatorStatus().inbox.pending.some(item => item.messageId === event.id) ? true : null, "stop decision");
    await assert.rejects(acknowledgeStopEvent(runId, event.id, "ctx_other"), { code: "stop_event_not_found" });
    await acknowledgeStopEvent(runId, event.id, dispatchId);
    assert.equal(attempt("task_aaa").settled, false);
    const rows = await new ProviderSessionStore(workspace).listMailboxChecks(runId);
    assert.ok(rows.some(row => row.resolvedStopEvents?.[event.id]?.evidence === "operator_acknowledged"));
    await stopCoordinator();
  });
  it("acknowledges a stop event without waiting on the lifecycle lock", async () => {
    const runId = "run_mailbox_lock_order";
    await singleTaskState(runId);
    await startCoordinator(baseOpts(runId));
    const dispatchId = await dispatchIdOf("task_aaa");
    const event = { ...workerDoneMessage("task_aaa", dispatchId, "succeeded", "msg_lock_stop"),
      run_id: runId, type: "escalation", payload: JSON.stringify({ dispatchId, stopReason: "errored" }) };
    await injectMail([event]);
    await waitFor(() => coordinatorStatus().inbox.pending.some(item => item.messageId === event.id) ? true : null, "stop event");
    let enter!: () => void;
    let release!: () => void;
    const entered = new Promise<void>(resolve => { enter = resolve; });
    const held = new Promise<void>(resolve => { release = resolve; });
    const lock = withLifecycleMutation(async () => { enter(); await held; });
    await entered;
    let acknowledged = false;
    const decision = acknowledgeStopEvent(runId, event.id, dispatchId).then(() => { acknowledged = true; });
    try {
      await waitFor(() => acknowledged ? true : null, "mailbox decision independent of lifecycle lock");
    } finally {
      release();
      await lock;
      await decision;
    }
    await stopCoordinator();
  });

  it("refuses mailbox decisions after its Run binding is fenced", async () => {
    const runId = "run_mailbox_fenced";
    await singleTaskState(runId);
    await startCoordinator(baseOpts(runId));
    const dispatchId = await dispatchIdOf("task_aaa");
    const event = { ...workerDoneMessage("task_aaa", dispatchId, "succeeded", "msg_fenced_stop"),
      run_id: runId, type: "escalation", payload: JSON.stringify({ dispatchId, stopReason: "finished" }) };
    const question = { ...workerDoneMessage("task_aaa", dispatchId, "succeeded", "msg_fenced_question"),
      run_id: runId, type: "question", payload: null };
    await injectMail([event, question]);
    await waitFor(() => coordinatorStatus().inbox.pending.length === 2 ? true : null, "mailbox inputs");
    await mutateState(s => { s.runs[runId].coordinator_handle = "term_external"; });
    await assert.rejects(answerInboxItem(question.id, "yes"), { code: "coordinator_control_required" });
    await assert.rejects(acknowledgeStopEvent(runId, event.id, dispatchId), { code: "coordinator_control_required" });
    assert.equal(calls("reply").length, 0);
    assert.equal(coordinatorStatus().inbox.pending.length, 2);
    await stopCoordinator();
  });
});

describe("ordinary approval gates hold completion", () => {
  it("serializes a gate admission with coordinator start before dispatch", async () => {
    const runId = "run_gate_start_race";
    await singleTaskState(runId);
    let enter!: () => void;
    let resume!: () => void;
    const entered = new Promise<void>(resolve => { enter = resolve; });
    const continueGate = new Promise<void>(resolve => { resume = resolve; });
    const admission = withLifecycleMutation(async () => {
      enter();
      await continueGate;
      await runOrca(["orchestration", "gate-create", "--task", "task_aaa", "--question", "Approve?",
        "--options", JSON.stringify(["approved", "rejected"]), "--from", "term_gate"]);
    });
    await entered;
    const start = startCoordinator(baseOpts(runId));
    await Promise.resolve();
    assert.equal(coordinatorStatus().running, false, "start must wait for in-flight gate admission");
    assert.equal(calls("worker-start").length, 0);
    resume();
    await admission;
    await start;
    await waitFor(() => coordinatorStatus().phase === "awaiting_input" ? true : null, "gate holds the Run");
    assert.equal(calls("gate-create").length, 1);
    assert.equal(calls("worker-start").length, 0, "the newly gated Task cannot race into dispatch");
    await stopCoordinator();
  });

  for (const [resolution, status] of [
    ["approve", "blocked"], ["approve", "ready"],
    ["approved", "blocked"], ["approved", "ready"],
  ]) {
    it(`holds a ${status} Task until every approval resolves to ${resolution}, then starts it`, async () => {
      const runId = `run_ordinary_gate_${status}_${resolution}`;
      await singleTaskState(runId);
      await mutateState((state) => {
        state.tasks.task_aaa.status = status;
        state.gates = [
          {
            id: "gate_already_approved", task_id: "task_aaa",
            question: "First approval", options: ["approved", "rejected"],
            status: "resolved", resolution: "approved",
          },
          {
            id: "gate_ordinary", task_id: "task_aaa",
            question: "Approve this stage?", options: [resolution, "rejected"],
            status: "pending", resolution: null,
          },
        ];
      });

      await startCoordinator(baseOpts(runId));
      await waitFor(() => coordinatorStatus().phase === "awaiting_input" ? true : null, "pending approval gate");
      assert.equal(calls("worker-start").length, 0, "a gated Task is not launched through its gate");
      assert.equal(coordinatorStatus().running, true, "the coordinator remains open for the decision");

      await mutateState((state) => {
        state.gates[1].status = "resolved";
        state.gates[1].resolution = resolution;
      });
      await waitFor(() => calls("worker-start").length === 1 ? true : null, "approved Task to start");
      await settleViaWorkerDone("task_aaa", "succeeded", "msg_ordinary_gate_done");
      await waitFor(() => coordinatorStatus().phase === "completed" ? true : null, "approved Run to complete");
    });
  }

  it("holds a gate-promoted ready descendant through dispatch and terminal reuse until its dependencies complete", async () => {
    const runId = "run_gate_ready_dependencies";
    await mutateState((state) => {
      // gate-resolve can promote this row without checking dependencies.
      // Keep it first so a raw-ready-only scheduler would select it first.
      state.tasks = {
        task_join: { id: "task_join", run_id: runId, status: "ready", deps: '["task_aaa","task_bbb"]' },
        task_aaa: { id: "task_aaa", run_id: runId, status: "pending", deps: "[]" },
        task_bbb: { id: "task_bbb", run_id: runId, status: "pending", deps: "[]" },
      };
      state.runs = { [runId]: { id: runId, objective: "gate cannot bypass dependencies", legacy: 0 } };
      state.gates = [{
        id: "gate_join", task_id: "task_join", question: "Approve final review?",
        options: ["approve", "reject"], status: "resolved", resolution: "approve",
      }];
    });

    await startCoordinator(baseOpts(runId));
    await dispatchIdOf("task_aaa");
    await dispatchIdOf("task_bbb");
    assert.equal(calls("worker-start").length, 2, "only the two roots are admitted");
    assert.equal(callsOf("worker-start", "--task", "task_join").length, 0);

    await settleViaWorkerDone("task_aaa", "succeeded", "msg_gate_root_a");
    await waitFor(() => ["released", "retained", "closed"].includes(attempt("task_aaa").terminalDecision)
      ? true : null, "settled root ownership while the other dependency is active");
    assert.equal(callsOf("worker-start", "--task", "task_join").length, 0,
      "a settled terminal cannot be reused to bypass the still-active dependency");
    assert.equal(findAttempt("task_join"), undefined);

    await settleViaWorkerDone("task_bbb", "succeeded", "msg_gate_root_b");
    await dispatchIdOf("task_join");
    assert.equal(callsOf("worker-start", "--task", "task_join").length, 1);
    await settleViaWorkerDone("task_join", "succeeded", "msg_gate_join_done");
    await waitFor(() => coordinatorStatus().phase === "completed" ? true : null, "dependency-ordered Run to complete");
  });

  it("keeps a Run-scoped pending gate open even without a blocked Task", async () => {
    const runId = "run_gate_without_task";
    await mutateState((state) => {
      state.tasks = {};
      state.runs = { [runId]: { id: runId, objective: "approval only", legacy: 0 } };
      state.gates = [{
        id: "gate_run", task_id: null, question: "Approve the Run?",
        options: ["approved", "rejected"], status: "pending", resolution: null,
      }];
    });
    await startCoordinator(baseOpts(runId));
    await waitFor(() => coordinatorStatus().phase === "awaiting_input" ? true : null, "Run-scoped approval");
    assert.equal(coordinatorStatus().running, true);
    assert.equal(calls("worker-start").length, 0);
    await mutateState((state) => {
      state.gates[0].status = "resolved";
      state.gates[0].resolution = "approved";
    });
    await waitFor(() => coordinatorStatus().phase === "completed" ? true : null, "resolved approval-only Run");
  });
});


