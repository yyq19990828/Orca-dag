import assert from "node:assert/strict";
import test from "node:test";
import { liveVerificationProgress } from "./verifyLive";

test("an unknown start waits for late settlement and terminal ownership", () => {
  const tasks = [
    { id: "a", status: "dispatched" as const },
    { id: "b", status: "completed" as const },
    { id: "c", status: "pending" as const },
  ];
  const status = {
    runId: "run", running: true, phase: "awaiting_input",
    attempts: [
      { taskId: "a", dispatchId: "ctx_a", settled: false, outcome: null as string | null, terminalDecision: "pending", startedAt: 1 },
      { taskId: "b", dispatchId: "ctx_b", settled: true, outcome: "succeeded", terminalDecision: "released", startedAt: 1 },
    ],
    cleanupDebt: [], inbox: { pending: [], pendingDeliveryId: null },
  };
  assert.equal(liveVerificationProgress(status, tasks), "waiting");
  // Task completion may arrive before the coordinator consumes its Delivery;
  // observation must still wait for local settlement and a resource decision.
  const completed = tasks.map(task => ({ ...task, status: "completed" as const }));
  assert.equal(liveVerificationProgress(status, completed), "waiting");
  status.attempts[0] = { ...status.attempts[0], settled: true, outcome: "succeeded", terminalDecision: "retained" };
  status.attempts.push({ taskId: "c", dispatchId: "ctx_c", settled: true, outcome: "succeeded", terminalDecision: "released", startedAt: 2 });
  status.phase = "completed";
  status.running = false;
  assert.equal(liveVerificationProgress(status, completed), "passed");
});

test("a completed coordinator loop cannot certify an unexecuted dependent Task", () => {
  const status = {
    runId: "run", running: false, phase: "completed",
    attempts: ["a", "b"].map(taskId => ({
      taskId, dispatchId: `ctx_${taskId}`, settled: true,
      outcome: "succeeded", terminalDecision: "released", startedAt: 1,
    })),
    cleanupDebt: [], inbox: { pending: [], pendingDeliveryId: null },
  };
  assert.equal(liveVerificationProgress(status, [
    { id: "a", status: "completed" }, { id: "b", status: "completed" }, { id: "c", status: "pending" },
  ]), "failed");
});
