import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ActivityJournal,
  buildActivitySnapshot,
  createViewerActivity,
} from "./activity";
import type { CoordinatorCheckReceipt, CoordinatorStatus } from "./coordinator";
import type { OrcaMessage, OrcaTask, OrcaWorkerRow } from "./orca";

const task = (runId = "run_a"): OrcaTask => ({
  id: "task_stage",
  run_id: runId,
  parent_id: null,
  created_by_terminal_handle: "term_creator",
  created_by_process_incarnation: "repo::/workspace@@pty:inc",
  spec: "Target: demonstrate readable activity.",
  status: "dispatched",
  deps: "[]",
  result: null,
  created_at: "2026-09-21T00:00:00Z",
  completed_at: null,
  task_title: "Inbox stage",
  display_name: "Friendly inbox agent",
  assignee_handle: "term_worker",
  dispatch_id: "ctx_stage",
});

const message = (overrides: Partial<OrcaMessage> = {}): OrcaMessage => ({
  id: "msg_1",
  run_id: "run_a",
  delivery_contract: "current_delivery",
  from_handle: "term_worker",
  to_handle: "run:run_a",
  subject: "alive",
  body: "",
  type: "heartbeat",
  priority: "normal",
  thread_id: null,
  payload: JSON.stringify({ taskId: "task_stage", dispatchId: "ctx_stage", phase: "implementing" }),
  created_at: "2026-09-21T00:00:01Z",
  delivered_at: null,
  ...overrides,
});

const worker = (): OrcaWorkerRow => ({
  dispatchId: "ctx_stage",
  taskId: "task_stage",
  runId: "run_a",
  workerState: "supervised",
  dispatchStatus: "dispatched",
  agentTerminalHandle: "term_worker",
  terminalState: "active",
  projection: {
    outcome: null,
    liveness: { verdict: "live", reason: null },
    stage: { worker: "ready", dispatch: "dispatched", detail: null, activity: "implementing" },
    nextAction: null,
    attention: null,
    launch: { agent: "codex", model: "gpt-demo", effort: null },
  },
});

const status = (runId = "run_a"): CoordinatorStatus =>
  ({
    running: true,
    phase: "awaiting_input",
    runId,
    coordinatorHandle: "term_coordinator",
    error: null,
    startedAt: 1,
    lastTick: 1,
    lastReconciledAt: 1,
    completedAt: null,
    attempts: [],
    busy: 1,
    maxConcurrency: 2,
    inbox: {
      pending: [
        {
          messageId: "msg_question",
          kind: "question",
          from: "dispatch:ctx_stage",
          subject: "Question",
          body: "Compact or detailed?",
          createdAt: "2026-09-21T00:00:03Z",
          taskId: "task_stage",
        },
      ],
      pendingDeliveryId: "delivery_1",
      recent: [],
      lastAckedDeliveryId: null,
    },
    cleanupDebt: [],
    lastStopReport: null,
    unownedDispatches: [],
    recovery: null,
    worktreeLanes: [],
    checks: [
      {
        sequence: 1,
        checkedAt: Date.parse("2026-09-21T00:00:04Z"),
        durationMs: 32,
        deliveryId: null,
        messageCount: 0,
        messageTypes: [],
        messages: [],
        replayed: false,
        timedOut: true,
        error: null,
        agents: [
          {
            taskId: "task_stage",
            dispatchId: "ctx_stage",
            liveness: "live",
            activity: "implementing",
            detail: "editing tests",
            attention: [],
            agent: "codex",
            model: "gpt-5.6-luna",
            effort: "max",
            outcome: null,
            observedAt: "2026-09-21T00:00:03Z",
          },
        ],
      },
    ],
  }) as CoordinatorStatus;

const checkReceipt = (overrides: Partial<CoordinatorCheckReceipt> = {}): CoordinatorCheckReceipt => ({
  ...status().checks[0],
  ...overrides,
});

describe("human-readable activity projection", () => {
  it("strictly scopes messages, tasks, workers, status and journal rows to one Run", () => {
    const snapshot = buildActivitySnapshot({
      runId: "run_a",
      tasks: [task(), task("run_other")],
      workers: [worker(), { ...worker(), runId: "run_other" }],
      messages: [message(), message({ id: "msg_foreign", run_id: "run_other" })],
      status: status("run_other"),
      journal: [
        createViewerActivity({ runId: "run_a", kind: "reply", title: "Reply", summary: "Compact" }),
        createViewerActivity({ runId: "run_other", kind: "reply", title: "Foreign", summary: "No" }),
      ],
      now: 1,
    });
    assert.equal(snapshot.runId, "run_a");
    assert.equal(snapshot.pendingCount, 0);
    assert.deepEqual(snapshot.checks, [], "foreign coordinator checks must not leak across Runs");
    assert.ok(snapshot.events.every((event) => event.runId === "run_a"));
    assert.deepEqual(snapshot.presence.map((presence) => presence.taskId), ["task_stage"]);
    assert.deepEqual(
      new Set(snapshot.events.map((event) => event.id)),
      new Set(["msg_1", snapshot.events.find((event) => event.kind === "reply")!.id]),
    );
  });

  it("uses friendly Task identity and effective runtime launch facts", () => {
    const snapshot = buildActivitySnapshot({
      runId: "run_a",
      tasks: [task()],
      workers: [worker()],
      messages: [
        message({
          id: "msg_question",
          type: "question",
          subject: "Question",
          body: "Compact or detailed?",
          created_at: "2026-09-21T00:00:03Z",
        }),
      ],
      status: status(),
      leadTaskId: "task_stage",
    });
    const event = snapshot.events[0];
    assert.equal(event.title, "Friendly inbox agent asks");
    assert.equal(event.actor.role, "lead");
    assert.equal(event.actor.harness, "codex");
    assert.equal(event.actor.model, "gpt-demo");
    assert.deepEqual(event.actionable, { kind: "reply", targetId: "msg_question" });
    assert.equal(snapshot.checks.length, 1);
    assert.equal(snapshot.checks[0].agents[0].detail, "editing tests");
  });

  it("projects compact fleet presence and prefers runtime provider facts when launch echo is absent", () => {
    const observed = worker();
    observed.projection = {
      ...observed.projection!,
      liveness: { verdict: "live", reason: null },
      stage: { worker: "ready", dispatch: "dispatched", detail: "tool_call", activity: "working" },
      launch: null,
      provider: { id: "codex", model: "gpt-5.6-luna" },
      attention: { categories: ["question"], requiresAction: true },
    };
    const snapshot = buildActivitySnapshot({
      runId: "run_a",
      tasks: [task()],
      workers: [observed],
      messages: [],
    });
    assert.deepEqual(snapshot.presence, [
      {
        taskId: "task_stage",
        dispatchId: "ctx_stage",
        liveness: "live",
        livenessReason: null,
        qualifiedWorking: false,
        activity: "working",
        detail: "tool_call",
        outcome: null,
        attention: ["question"],
        agent: "codex",
        model: "gpt-5.6-luna",
        effort: null,
        observedAt: null,
      },
    ]);
  });

  it("uses live coordinator check facts when the fleet row has not echoed them", () => {
    const live = status();
    live.attempts = [
      {
        taskId: "task_stage",
        dispatchId: "ctx_stage",
        liveness: "live",
        lastHeartbeatAt: "2026-09-21T00:00:04Z",
        stage: { worker: "ready", dispatch: "dispatched", detail: "editing tests", activity: "working" },
        attention: { categories: [], requiresAction: false },
        outcome: null,
        effective: {
          agent: "codex",
          model: "gpt-5.6-luna",
          effort: "max",
          worktree: null,
          terminal: null,
          on: null,
        },
      },
    ] as unknown as CoordinatorStatus["attempts"];
    const observed = worker();
    observed.projection = {
      ...observed.projection!,
      liveness: null,
      stage: null,
      launch: null,
      provider: null,
      attention: null,
    };

    const snapshot = buildActivitySnapshot({
      runId: "run_a",
      tasks: [task()],
      workers: [observed],
      messages: [],
      status: live,
    });

    assert.deepEqual(snapshot.presence[0], {
      taskId: "task_stage",
      dispatchId: "ctx_stage",
      liveness: "live",
      livenessReason: null,
      qualifiedWorking: false,
      activity: "working",
      detail: "editing tests",
      outcome: null,
      attention: [],
      agent: "codex",
      model: "gpt-5.6-luna",
      effort: "max",
      observedAt: "2026-09-21T00:00:04Z",
    });
  });

  it("fills a missing Dispatch id from the scoped fleet row", () => {
    const snapshot = buildActivitySnapshot({
      runId: "run_a",
      tasks: [task()],
      workers: [worker()],
      messages: [
        message({
          id: "msg_without_ids",
          payload: JSON.stringify({ phase: "implementing" }),
        }),
      ],
    });
    assert.equal(snapshot.events[0].taskId, "task_stage");
    assert.equal(snapshot.events[0].dispatchId, "ctx_stage");
  });

  it("renders direct Orca coordinator messages as outgoing bubbles and removes optimistic duplicates", () => {
    const directGuidance = message({
      id: "msg_guidance",
      from_handle: "term_coordinator",
      to_handle: "dispatch:ctx_stage",
      type: "status",
      subject: "Coordinator guidance",
      body: "Please run the focused regression test.",
      payload: null,
      created_at: "2026-09-21T00:00:05Z",
    });
    const directReply = message({
      id: "msg_reply",
      from_handle: "run:run_a",
      to_handle: "dispatch:ctx_stage",
      type: "status",
      subject: "Re: Question",
      body: "Keep the output compact.",
      thread_id: "msg_question",
      payload: null,
      created_at: "2026-09-21T00:00:07Z",
    });
    const optimisticGuidance = {
      ...createViewerActivity({
        runId: "run_a",
        taskId: "task_stage",
        dispatchId: "ctx_stage",
        kind: "status",
        title: "Coordinator sent guidance",
        summary: "Please run the focused regression test.",
      }),
      createdAt: "2026-09-21T00:00:06Z",
    };
    const optimisticReply = {
      ...createViewerActivity({
        runId: "run_a",
        taskId: "task_stage",
        dispatchId: "ctx_stage",
        kind: "reply",
        title: "Coordinator replied to a worker",
        summary: "Keep the output compact.",
      }),
      createdAt: "2026-09-21T00:00:08Z",
    };

    const snapshot = buildActivitySnapshot({
      runId: "run_a",
      tasks: [task()],
      workers: [worker()],
      messages: [directReply, directGuidance],
      journal: [optimisticGuidance, optimisticReply],
    });

    assert.equal(snapshot.events.length, 2);
    assert.deepEqual(new Set(snapshot.events.map((event) => event.id)), new Set(["msg_guidance", "msg_reply"]));
    assert.ok(snapshot.events.every((event) => event.direction === "coordinator_to_agent"));
    assert.ok(snapshot.events.every((event) => event.actor.role === "coordinator"));
    assert.ok(snapshot.events.every((event) => event.taskId === "task_stage"));
    assert.ok(snapshot.events.every((event) => event.dispatchId === "ctx_stage"));
    assert.ok(snapshot.events.every((event) => event.technical.provenance === "orca_message"));
    const guidance = snapshot.events.find((event) => event.id === "msg_guidance")!;
    assert.equal(guidance.kind, "status");
    assert.equal(guidance.title, "Coordinator sent guidance");
    assert.equal(guidance.summary, "Please run the focused regression test.");
    const reply = snapshot.events.find((event) => event.id === "msg_reply")!;
    assert.equal(reply.kind, "reply");
    assert.equal(reply.title, "Coordinator replied to a worker");
    assert.equal(reply.summary, "Keep the output compact.");
  });

  it("merges persisted meaningful checks with live receipts without duplicating the overlap", () => {
    const persisted = checkReceipt({ sequence: 7, checkedAt: 7_000, messageCount: 1, messageTypes: ["status"] });
    const earlier = checkReceipt({ sequence: 6, checkedAt: 6_000, messageCount: 0, messageTypes: [] });
    const live = status();
    live.checks = [
      { ...persisted, agents: persisted.agents.map((agent) => ({ ...agent, attention: [...agent.attention] })) },
      checkReceipt({ sequence: 8, checkedAt: 8_000, error: "connection lost" }),
    ];

    const snapshot = buildActivitySnapshot({
      runId: "run_a",
      tasks: [task()],
      workers: [worker()],
      messages: [],
      status: live,
      persistedChecks: [earlier, persisted],
    });

    assert.deepEqual(snapshot.checks.map((receipt) => receipt.checkedAt), [6_000, 7_000, 8_000]);
    assert.equal(snapshot.checks.filter((receipt) => receipt.checkedAt === 7_000).length, 1);
  });

  it("reconstructs externally-consumed checks only from durable read and action evidence", () => {
    const reply = (id: string, questionId: string, at: string): OrcaMessage =>
      message({
        id,
        from_handle: "run:run_a",
        to_handle: "dispatch:ctx_stage",
        type: "status",
        subject: "Re: Question",
        body: "Accepted",
        thread_id: questionId,
        payload: null,
        created_at: at,
        read: 1,
      });
    const settled = worker();
    settled.workerState = "succeeded";
    settled.dispatchStatus = "completed";
    settled.terminalState = "released";
    settled.projection = {
      ...settled.projection!,
      outcome: "succeeded",
      liveness: { verdict: "exited", reason: null },
    };
    const messages: OrcaMessage[] = [
      message({ id: "q1", type: "question", subject: "Question", created_at: "2026-09-21T00:00:01Z", read: 1 }),
      reply("r1", "q1", "2026-09-21T00:00:02Z"),
      message({ id: "s1", type: "status", subject: "Round 1 acknowledged", created_at: "2026-09-21T00:00:03Z", read: 1 }),
      message({ id: "q2", type: "question", subject: "Question", created_at: "2026-09-21T00:00:04Z", read: 1 }),
      reply("r2", "q2", "2026-09-21T00:00:05Z"),
      message({ id: "s2", type: "status", subject: "Round 2 acknowledged", created_at: "2026-09-21T00:00:06Z", read: 1 }),
      message({ id: "q3", type: "question", subject: "Question", created_at: "2026-09-21T00:00:07Z", read: 1 }),
      reply("r3", "q3", "2026-09-21T00:00:08Z"),
      message({ id: "s3", type: "status", subject: "Round 3 acknowledged", created_at: "2026-09-21T00:00:09Z", read: 1 }),
      message({
        id: "done",
        type: "worker_done",
        subject: "Complete",
        payload: JSON.stringify({ taskId: "task_stage", dispatchId: "ctx_stage", outcome: "succeeded" }),
        created_at: "2026-09-21T00:00:10Z",
        read: 1,
      }),
    ];

    const snapshot = buildActivitySnapshot({
      runId: "run_a",
      tasks: [task()],
      workers: [settled],
      messages,
    });

    assert.deepEqual(snapshot.checks.map((receipt) => receipt.messageCount), [1, 2, 2, 2]);
    assert.ok(snapshot.checks.every((receipt) => receipt.source === "external_inferred"));
    assert.deepEqual(snapshot.checks.at(-1)?.messageTypes, ["status", "worker_done"]);
    assert.match(snapshot.checks[0].evidence ?? "", /durable reply/i);
    assert.match(snapshot.checks.at(-1)?.evidence ?? "", /settled worker/i);
    // The digest must be expandable: every receipt carries its rows, oldest
    // first, so the UI can list the messages behind "N messages" instead of
    // only the count.
    for (const receipt of snapshot.checks) {
      assert.equal(receipt.messages?.length, receipt.messageCount);
    }
    assert.deepEqual(
      snapshot.checks.at(-1)?.messages.map((row) => [row.id, row.type, row.subject]),
      [
        ["s3", "status", "Round 3 acknowledged"],
        ["done", "worker_done", "Complete"],
      ],
    );
  });

  it("does not fabricate external checks from unread messages and prefers nearby native receipts", () => {
    const question = message({
      id: "q1",
      type: "question",
      subject: "Question",
      created_at: "2026-09-21T00:00:01Z",
      read: 1,
    });
    const reply = message({
      id: "r1",
      from_handle: "run:run_a",
      to_handle: "dispatch:ctx_stage",
      type: "status",
      subject: "Re: Question",
      body: "Accepted",
      thread_id: "q1",
      payload: null,
      created_at: "2026-09-21T00:00:02Z",
      read: 1,
    });
    const native = checkReceipt({
      checkedAt: Date.parse("2026-09-21T00:00:01.500Z"),
      messageCount: 1,
      messageTypes: ["question"],
      source: "viewer_loop",
    });
    const withNative = buildActivitySnapshot({
      runId: "run_a",
      tasks: [task()],
      workers: [worker()],
      messages: [question, reply],
      persistedChecks: [native],
    });
    assert.equal(withNative.checks.length, 1);
    assert.equal(withNative.checks[0].source, "viewer_loop");

    const unread = buildActivitySnapshot({
      runId: "run_a",
      tasks: [task()],
      workers: [worker()],
      messages: [{ ...question, read: 0 }, reply],
    });
    assert.deepEqual(unread.checks, []);
  });

  it("coalesces adjacent same-phase heartbeats without hiding outcomes", () => {
    const snapshot = buildActivitySnapshot({
      runId: "run_a",
      tasks: [task()],
      workers: [worker()],
      messages: [
        message({ id: "hb_1", created_at: "2026-09-21T00:00:01Z" }),
        message({ id: "hb_2", created_at: "2026-09-21T00:00:02Z" }),
        message({
          id: "done_1",
          type: "worker_done",
          subject: "Demo complete",
          body: "The structured interaction finished. Verification passed.",
          payload: JSON.stringify({ taskId: "task_stage", dispatchId: "ctx_stage", outcome: "succeeded" }),
          created_at: "2026-09-21T00:00:03Z",
        }),
      ],
    });
    assert.equal(snapshot.events.length, 2);
    const heartbeat = snapshot.events.find((event) => event.kind === "heartbeat")!;
    assert.equal(heartbeat.groupedCount, 2);
    assert.equal(snapshot.events[0].kind, "worker_done");
    assert.equal(snapshot.events[0].severity, "success");
  });

  it("renders rejected lifecycle reports as warnings, never successful outcomes", () => {
    const snapshot = buildActivitySnapshot({
      runId: "run_a",
      tasks: [task()],
      workers: [worker()],
      messages: [
        message({
          type: "worker_done",
          subject: "Rejected worker_done: stale attempt",
          body: "Orca rejected this worker_done.",
          payload: JSON.stringify({
            taskId: "task_stage",
            dispatchId: "ctx_stage",
            outcome: "succeeded",
            _orcaLifecycleRejection: { code: "inactive_dispatch", reason: "Attempt is already settled." },
          }),
        }),
      ],
    });
    assert.equal(snapshot.events[0].kind, "unknown");
    assert.equal(snapshot.events[0].severity, "warning");
    assert.match(snapshot.events[0].title, /rejected/i);
  });

  it("keeps malformed presentation fields readable and resolves identity from the worker terminal", () => {
    const malformed = {
      ...message(),
      id: "msg_malformed",
      payload: "{not-json",
      subject: null,
      body: { unexpected: true },
      type: 42,
      created_at: "not-a-date",
    } as unknown as OrcaMessage;

    const snapshot = buildActivitySnapshot({
      runId: "run_a",
      tasks: [task()],
      workers: [worker()],
      messages: [malformed],
    });
    assert.equal(snapshot.events[0].kind, "unknown");
    assert.equal(snapshot.events[0].severity, "info");
    assert.equal(snapshot.events[0].actor.label, "Friendly inbox agent");
    assert.equal(snapshot.events[0].actor.harness, "codex");
    assert.equal(snapshot.events[0].createdAt, "1970-01-01T00:00:00.000Z");
  });

  it("carries thread_id, priority and tri-state read evidence through normalization", () => {
    const question = message({
      id: "q1",
      type: "question",
      subject: "Question",
      body: "Ship now or after review?",
      priority: "urgent",
      thread_id: null,
      read: 0,
      created_at: "2026-09-21T00:00:01Z",
    });
    const reply = message({
      id: "r1",
      from_handle: "run:run_a",
      to_handle: "dispatch:ctx_stage",
      type: "status",
      subject: "Re: Question",
      body: "After review.",
      priority: "normal",
      thread_id: "q1",
      payload: null,
      created_at: "2026-09-21T00:00:02Z",
      // read marker absent on this row on purpose (older runtime)
    });
    const { read: _omitted, ...replyWithoutMarker } = reply;
    const ack = message({
      id: "ack1",
      type: "status",
      subject: "Round acknowledged",
      body: "Understood.",
      priority: "normal",
      thread_id: "q1",
      read: 1,
      created_at: "2026-09-21T00:00:03Z",
    });

    const snapshot = buildActivitySnapshot({
      runId: "run_a",
      tasks: [task()],
      workers: [worker()],
      messages: [question, replyWithoutMarker as OrcaMessage, ack],
    });
    const byId = new Map(snapshot.events.map((event) => [event.id, event]));

    const questionEvent = byId.get("q1")!;
    assert.equal(questionEvent.priority, "urgent");
    assert.equal(questionEvent.read, false, "an explicit unread marker is evidence, keep it");
    assert.equal(questionEvent.threadId, null);

    const replyEvent = byId.get("r1")!;
    assert.equal(replyEvent.threadId, "q1", "the durable reply keeps Orca's own thread id");
    assert.equal(replyEvent.read, null, "an absent read marker is UNKNOWN, never unread");
    assert.equal(replyEvent.priority, "normal");
    assert.equal(replyEvent.direction, "coordinator_to_agent");

    const ackEvent = byId.get("ack1")!;
    assert.equal(ackEvent.threadId, "q1");
    assert.equal(ackEvent.read, true);
  });

  it("treats malformed thread and priority fields as absent rather than guessing", () => {
    const broken = {
      ...message(),
      id: "msg_broken_meta",
      thread_id: 42,
      priority: 7,
      read: "yes",
    } as unknown as OrcaMessage;
    const snapshot = buildActivitySnapshot({
      runId: "run_a",
      tasks: [task()],
      workers: [worker()],
      messages: [broken],
    });
    const event = snapshot.events[0];
    assert.equal(event.threadId, null);
    assert.equal(event.priority, null);
    assert.equal(event.read, null);
  });

  it("reports the global inbox window with saturation before Run filtering", () => {
    const base = { runId: "run_a", tasks: [task()], workers: [worker()] };
    const notSaturated = buildActivitySnapshot({
      ...base,
      messages: [message()],
      inboxWindow: { limit: 100, observed: 40, saturated: false },
    });
    assert.deepEqual(notSaturated.inboxWindow, { limit: 100, observed: 40, saturated: false });

    // Saturation is global evidence: foreign rows filled the window even
    // though this Run only has one row — and foreign rows still never leak.
    const saturated = buildActivitySnapshot({
      ...base,
      messages: [message(), message({ id: "msg_foreign", run_id: "run_other" })],
      inboxWindow: { limit: 2, observed: 2, saturated: true },
    });
    assert.equal(saturated.inboxWindow?.saturated, true);
    assert.equal(saturated.events.length, 1);
    assert.ok(saturated.events.every((event) => event.runId === "run_a"));

    // A failed history read passes no window at all: completeness is unknown.
    const unknownWindow = buildActivitySnapshot({ ...base, messages: [] });
    assert.equal(unknownWindow.inboxWindow, null);
  });

  it("labels provenance across durable rows, journal rows and inferred checks", () => {
    const journal = createViewerActivity({
      runId: "run_a",
      kind: "reply",
      title: "Coordinator replied to a worker",
      summary: "Accepted.",
      taskId: "task_stage",
      dispatchId: "ctx_stage",
      threadId: "q1",
    });
    const settled = worker();
    settled.workerState = "succeeded";
    settled.dispatchStatus = "completed";
    settled.terminalState = "released";
    settled.projection = {
      ...settled.projection!,
      outcome: "succeeded",
      liveness: { verdict: "exited", reason: null },
    };
    const durableQuestion = message({
      id: "q1",
      type: "question",
      subject: "Question",
      created_at: "2026-09-21T00:00:01Z",
      read: 1,
    });
    const durableDone = message({
      id: "done1",
      type: "worker_done",
      subject: "Complete",
      payload: JSON.stringify({ taskId: "task_stage", dispatchId: "ctx_stage", outcome: "succeeded" }),
      created_at: "2026-09-21T00:00:02Z",
      read: 1,
    });
    const snapshot = buildActivitySnapshot({
      runId: "run_a",
      tasks: [task()],
      workers: [settled],
      messages: [durableQuestion, durableDone],
      journal: [journal],
    });
    const byId = new Map(snapshot.events.map((event) => [event.id, event]));
    assert.equal(byId.get("q1")?.technical.provenance, "orca_message");
    assert.equal(byId.get("done1")?.technical.provenance, "orca_message");
    const journalRow = [...byId.values()].find((event) => event.technical.provenance === "viewer_journal")!;
    assert.ok(journalRow, "the journal row survives dedupe (durable reply not in yet)");
    assert.equal(journalRow.threadId, "q1");
    assert.equal(journalRow.read, null, "journal rows carry no read evidence");
    assert.equal(journalRow.priority, null);

    // The settled worker + read batch reconstruct ONE check, and it says so:
    // never presented as a native viewer-loop receipt.
    assert.equal(snapshot.checks.length, 1);
    assert.equal(snapshot.checks[0].source, "external_inferred");
    assert.match(snapshot.checks[0].evidence ?? "", /Inferred from Orca's read marker/i);
    assert.equal(snapshot.checks[0].durationMs, 0);
    assert.match(snapshot.checks[0].deliveryId ?? "", /^inferred:/);
  });
});

describe("viewer activity journal", () => {
  it("preserves a real coordinator assignment as a Task-scoped outgoing row", () => {
    const event = createViewerActivity({
      runId: "run_a",
      taskId: "task_stage",
      dispatchId: "ctx_stage",
      kind: "dispatch_started",
      title: "Assigned this stage",
      summary: "Target: demonstrate readable activity.",
      detail: "Target: demonstrate readable activity. Constraints: keep the full brief available.",
    });
    assert.equal(event.direction, "coordinator_to_agent");
    assert.equal(event.actor.role, "coordinator");
    assert.equal(event.taskId, "task_stage");
    assert.equal(event.dispatchId, "ctx_stage");
    assert.match(event.detail ?? "", /full brief/);
  });

  it("keeps viewer-originated records strictly Run-scoped", async () => {
    const dir = await mkdtemp(join(tmpdir(), "orca-dag-activity-"));
    try {
      const journal = new ActivityJournal(dir);
      await journal.append(createViewerActivity({ runId: "run_a", kind: "reply", title: "Reply", summary: "A" }));
      await journal.append(createViewerActivity({ runId: "run_b", kind: "reply", title: "Reply", summary: "B" }));
      await journal.appendCheck("run_a", checkReceipt({ checkedAt: 1_000 }));
      await journal.appendCheck("run_b", checkReceipt({ checkedAt: 2_000 }));
      const history = await journal.listHistory("run_a");
      assert.equal(history.events.length, 1);
      assert.equal(history.events[0].summary, "A");
      assert.deepEqual(history.checks.map((receipt) => receipt.checkedAt), [1_000]);
      assert.deepEqual(await journal.list("run_a"), history.events, "legacy event-only reads stay compatible");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("hydrates pre-Phase-3 journal rows with explicit unknown conversation metadata", async () => {
    const dir = await mkdtemp(join(tmpdir(), "orca-dag-activity-legacy-"));
    try {
      // A row written by an older viewer: no threadId/priority/read fields.
      const legacy = {
        id: "viewer:legacy:row",
        runId: "run_a",
        taskId: "task_stage",
        dispatchId: "ctx_stage",
        direction: "coordinator_to_agent",
        actor: { role: "coordinator", label: "Coordinator", harness: null, model: null },
        kind: "reply",
        severity: "info",
        title: "Coordinator replied to a worker",
        summary: "Accepted.",
        detail: null,
        createdAt: "2026-09-21T00:00:00Z",
        groupedCount: 1,
        actionable: null,
        technical: { provenance: "viewer_journal" },
      };
      const journal = new ActivityJournal(dir);
      const { appendFile } = await import("node:fs/promises");
      await appendFile(journal.path, `${JSON.stringify(legacy)}\n`, "utf8");
      const [event] = await journal.list("run_a");
      assert.equal(event.threadId, null);
      assert.equal(event.priority, null);
      assert.equal(event.read, null, "absent fields hydrate to unknown, never unread");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("serializes concurrent appends so parallel assignments remain durable rows", async () => {
    const dir = await mkdtemp(join(tmpdir(), "orca-dag-activity-concurrent-"));
    try {
      const journal = new ActivityJournal(dir);
      await Promise.all(
        Array.from({ length: 64 }, (_, index) =>
          journal.append(
            createViewerActivity({
              runId: "run_parallel",
              kind: "dispatch_started",
              title: "Assigned this stage",
              summary: `Task ${index}`,
            }),
          ),
        ),
      );
      const rows = await journal.list("run_parallel");
      assert.equal(rows.length, 64);
      assert.equal(new Set(rows.map((row) => row.id)).size, 64);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
