import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import {
  findCodexSessionFile,
  parseCodexSessionJsonl,
  readBoundCodexSessionOutput,
} from "./codexSession";

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    rmSync(dir, { recursive: true, force: true });
  }
});

function dispatchPreamble(dispatchId: string, taskId = "task_probe", spec = "Inspect the assigned files."): string {
  const identity = `--task-id ${taskId} --dispatch-id ${dispatchId}`;
  return [
    "You are working inside Orca, a multi-agent IDE. You are a dispatched worker.",
    "Your coordinator's terminal handle is: coordinator_fixture",
    `Your task ID is: ${taskId}`,
    "",
    "=== CLI COMMANDS ===",
    "",
    "```sh",
    `  orca orchestration send --from worker_fixture --type escalation --subject "Blocked: <reason>" --body "<details>" ${identity}`,
    `  orca orchestration send --from worker_fixture --type worker_done --subject "<short status>" --body "<3-sentence summary: what you did, what you found, what's left>" ${identity} --outcome succeeded`,
    "```",
    "",
    "=== AFTER YOU SEND worker_done ===",
    "",
    "worker_done ends your turn for this task: return to an idle prompt.",
    "",
    "=== TASK ===",
    spec,
  ].join("\n");
}

function rolloutRows(...rows: unknown[]): string {
  return rows.map((row) => JSON.stringify(row)).join("\n") + "\n";
}

function userRecord(content: string | Array<Record<string, unknown>>) {
  return {
    type: "response_item",
    payload: {
      type: "message",
      role: "user",
      content: typeof content === "string" ? [{ type: "input_text", text: content }] : content,
    },
  };
}

function sampleRolloutJsonl(workspace: string, sessionId: string): string {
  const lines = [
    {
      timestamp: "2026-11-19T07:46:45.720Z",
      type: "session_meta",
      payload: { session_id: sessionId, id: sessionId, cwd: workspace },
    },
    {
      timestamp: "2026-11-19T07:46:48.836Z",
      type: "response_item",
      payload: {
        type: "message",
        id: "dev_1",
        role: "developer",
        content: [{ type: "input_text", text: "System instructions" }],
      },
    },
    {
      timestamp: "2026-11-19T07:46:48.838Z",
      type: "response_item",
      payload: {
        type: "message",
        id: "env_1",
        role: "user",
        content: [{ type: "input_text", text: "# AGENTS.md instructions for " + workspace }],
      },
    },
    {
      timestamp: "2026-11-19T07:46:48.841Z",
      type: "event_msg",
      payload: {
        type: "thread_settings_applied",
        thread_settings: { model: "gpt-6.2-astra" },
      },
    },
    // Attempt 1 (ctx_attempt_1)
    {
      timestamp: "2026-11-19T07:46:48.920Z",
      type: "response_item",
      payload: {
        type: "message",
        id: "u_1",
        role: "user",
        internal_chat_message_metadata_passthrough: { turn_id: "turn_1" },
        content: [
          {
            type: "input_text",
            text: dispatchPreamble("ctx_attempt_1"),
          },
        ],
      },
    },
    {
      type: "event_msg",
      payload: {
        type: "item_completed",
        turn_id: "turn_1",
        item: { type: "UserMessage", content: [{ type: "text", text: dispatchPreamble("ctx_attempt_1") }] },
      },
    },
    {
      timestamp: "2026-11-19T07:46:55.000Z",
      type: "response_item",
      payload: {
        type: "message",
        id: "a_1",
        role: "assistant",
        content: [{ type: "output_text", text: "Attempt 1 inspecting files." }],
      },
    },
    {
      timestamp: "2026-11-19T07:47:01.000Z",
      type: "response_item",
      payload: {
        type: "custom_tool_call",
        id: "tc_1",
        call_id: "call_1",
        name: "exec",
        status: "completed",
        input: "echo attempt1",
      },
    },
    {
      timestamp: "2026-11-19T07:47:01.200Z",
      type: "response_item",
      payload: {
        type: "custom_tool_call_output",
        id: "tco_1",
        call_id: "call_1",
        output: [{ type: "input_text", text: "attempt1\n" }],
      },
    },
    // Attempt 2 resumed into the SAME session (ctx_attempt_2)
    {
      timestamp: "2026-11-19T07:50:00.780Z",
      type: "response_item",
      payload: {
        type: "message",
        id: "u_2",
        role: "user",
        content: [
          {
            type: "input_text",
            text: dispatchPreamble("ctx_attempt_2"),
          },
        ],
      },
    },
    {
      type: "event_msg",
      payload: { type: "user_message", message: dispatchPreamble("ctx_attempt_2") },
    },
    {
      timestamp: "2026-11-19T07:50:10.000Z",
      type: "response_item",
      payload: {
        type: "message",
        id: "a_2",
        role: "assistant",
        content: [{ type: "output_text", text: "Resumed dispatch finishing up." }],
      },
    },
    {
      timestamp: "2026-11-19T07:50:12.000Z",
      type: "response_item",
      payload: {
        type: "custom_tool_call",
        id: "tc_2",
        call_id: "call_2",
        name: "exec",
        status: "completed",
        input: "orca orchestration send --type worker_done",
      },
    },
    {
      timestamp: "2026-11-19T07:50:12.500Z",
      type: "response_item",
      payload: {
        type: "custom_tool_call_output",
        id: "tco_2",
        call_id: "call_2",
        output: [
          { type: "input_text", text: "Script completed\nOutput:\n" },
          { type: "input_text", text: "{\"ok\":true}" },
        ],
      },
    },
  ];
  return rolloutRows(...lines);
}

describe("codexSession local fallback parser and reader", () => {
  it("scopes each Dispatch strictly to its own turns within a resumed Codex session", () => {
    const workspace = "/tmp/workspace-a";
    const sessionId = "01a1f2c5-9cb1-7d32-ac1b-7a3c4a996aa6";
    const raw = sampleRolloutJsonl(workspace, sessionId);

    const first = parseCodexSessionJsonl(raw, {
      dispatchId: "ctx_attempt_1",
      taskId: "task_probe",
      sessionId,
      workspace,
    });
    assert.ok(first);
    assert.equal(first.structured.length, 4);
    assert.equal(first.structured[0].message.role, "user");
    assert.equal(first.structured[1].message.model, "gpt-6.2-astra");
    assert.equal(first.structured[2].message.blocks[0].type, "tool-call");
    assert.equal(first.structured[3].message.blocks[0].type, "tool-result");
    assert.equal(first.lines.join("\n").includes("Resumed dispatch finishing up"), false);

    const second = parseCodexSessionJsonl(raw, {
      dispatchId: "ctx_attempt_2",
      taskId: "task_probe",
      sessionId,
      workspace,
    });
    assert.ok(second);
    assert.equal(second.structured.length, 4);
    assert.match(second.lines.join("\n"), /Resumed dispatch finishing up/);
    assert.equal(second.lines.join("\n").includes("Attempt 1 inspecting files"), false);
  });

  it("keeps the original assistant and tool output without opening a later UI prompt", () => {
    const opts = {
      dispatchId: "ctx_attempt_2",
      taskId: "task_probe",
      sessionId: "01a1f2c5-9cb1-7d32-ac1b-7a3c4a996aa6",
      workspace: "/tmp/workspace-a",
    };
    const raw = sampleRolloutJsonl(opts.workspace, opts.sessionId);
    const unrelatedOutput = rolloutRows(
      { type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "Private user answer." }] } },
      { type: "response_item", payload: { type: "function_call", name: "search", arguments: "Private search." } },
      { type: "response_item", payload: { type: "function_call_output", output: "Private result." } },
    );
    const laterPrompts = [
      userRecord("Private question about an unrelated workspace."),
      userRecord("Private question that happens to mention task_probe and ctx_attempt_2."),
      userRecord("# AGENTS.md instructions for my private workspace"),
      userRecord([{ type: "input_image", image_url: "data:image/png;base64,AA==" }]),
      { type: "event_msg", payload: { type: "user_message", message: "Private question in a provider event." } },
      { type: "event_msg", payload: { type: "task_started", turn_id: "unproven_turn" } },
    ];
    for (const later of laterPrompts) {
      const parsed = parseCodexSessionJsonl(raw + rolloutRows(later) + unrelatedOutput, opts);
      assert.ok(parsed);
      assert.equal(parsed.scopeEnded, true);
      assert.deepEqual(parsed.structured.map(({ message }) => message.id), ["u_2", "a_2", "tc_2", "tco_2"]);
      assert.doesNotMatch(parsed.lines.join("\n"), /Private/i);
    }
  });

  it("requires one exact generated Task and Dispatch preamble", () => {
    const opts = {
      dispatchId: "ctx_attempt_2",
      taskId: "task_probe",
      sessionId: "01a1f2c5-9cb1-7d32-ac1b-7a3c4a996aa6",
      workspace: "/tmp/workspace-a",
    };
    const raw = sampleRolloutJsonl(opts.workspace, opts.sessionId);
    const meta = raw.slice(0, raw.indexOf("\n") + 1);
    const valid = dispatchPreamble(opts.dispatchId);
    for (const prompt of [
      "Please continue task_probe.",
      "I have a question about task_probe and ctx_attempt_2.",
      "Earlier you received this brief:\n" + valid,
      dispatchPreamble("ctx_attempt_1", opts.taskId, "The previous Dispatch was ctx_attempt_2."),
      dispatchPreamble(opts.dispatchId, "task_other", "For context this relates to task_probe."),
      valid.replace("--dispatch-id ctx_attempt_2 --outcome", "--dispatch-id ctx_attempt_1 --outcome"),
    ]) {
      assert.equal(parseCodexSessionJsonl(meta + rolloutRows(userRecord(prompt)), opts), null);
    }
    assert.equal(parseCodexSessionJsonl(raw + rolloutRows(userRecord(valid)), opts), null);
  });

  it("refuses mismatched session_meta, workspace, or unrelated Dispatch", () => {
    const workspace = "/tmp/workspace-a";
    const sessionId = "01a1f2c5-9cb1-7d32-ac1b-7a3c4a996aa6";
    const raw = sampleRolloutJsonl(workspace, sessionId);

    assert.equal(
      parseCodexSessionJsonl(raw, {
        dispatchId: "ctx_attempt_2",
        taskId: "task_probe",
        sessionId: "01a1f2c5-9cb1-7d32-ac1b-000000000000",
        workspace,
      }),
      null,
    );
    assert.equal(
      parseCodexSessionJsonl(raw, {
        dispatchId: "ctx_attempt_2",
        taskId: "task_probe",
        sessionId,
        workspace: "/tmp/other-workspace",
      }),
      null,
    );
    assert.equal(
      parseCodexSessionJsonl(raw, {
        dispatchId: "ctx_foreign",
        taskId: "task_probe",
        sessionId,
        workspace,
      }),
      null,
    );

    const opts = { dispatchId: "ctx_attempt_2", taskId: "task_probe", sessionId, workspace };
    const conflictingMeta = rolloutRows({
      type: "session_meta",
      payload: { id: "01a1f2c5-9cb1-7d32-ac1b-000000000000", session_id: sessionId, cwd: workspace },
    });
    assert.equal(parseCodexSessionJsonl(conflictingMeta + raw.slice(raw.indexOf("\n") + 1), opts), null);
    assert.equal(parseCodexSessionJsonl(raw + conflictingMeta, opts), null);
    assert.equal(parseCodexSessionJsonl(raw.slice(0, raw.indexOf("\n") + 1) + raw, opts), null);
  });

  it("does not skip an unknown complete record as though it were a partial write", () => {
    const opts = {
      dispatchId: "ctx_attempt_2",
      taskId: "task_probe",
      sessionId: "01a1f2c5-9cb1-7d32-ac1b-7a3c4a996aa6",
      workspace: "/tmp/workspace-a",
    };
    const raw = sampleRolloutJsonl(opts.workspace, opts.sessionId);
    const unfinished = '{"type": "response_item",';
    const parsed = parseCodexSessionJsonl(raw + unfinished, opts);
    assert.ok(parsed);
    assert.equal(parsed.clipped, true);
    assert.equal(parseCodexSessionJsonl(raw + unfinished + "\n", opts), null);
  });

  it("reads paginated output from CODEX_HOME/sessions and skips symlinks", async () => {
    const root = makeTempDir("odag-codex-");
    const workspace = join(root, "repo");
    const codexHome = join(root, "codex");
    const dayDir = join(codexHome, "sessions", "2026", "11", "19");
    mkdirSync(workspace, { recursive: true });
    mkdirSync(dayDir, { recursive: true });

    const sessionId = "01a1f2c5-9cb1-7d32-ac1b-7a3c4a996aa6";
    const filePath = join(dayDir, `rollout-2026-11-19T15-46-39-${sessionId}.jsonl`);
    writeFileSync(filePath, sampleRolloutJsonl(workspace, sessionId));

    // Symlinked session outside sessions/ must be ignored.
    const symlinkTarget = join(root, "escape.jsonl");
    writeFileSync(symlinkTarget, sampleRolloutJsonl(workspace, "01a1f2c5-9cb1-7d32-ac1b-111111111111"));
    symlinkSync(symlinkTarget, join(dayDir, "rollout-2026-11-19T15-46-39-01a1f2c5-9cb1-7d32-ac1b-111111111111.jsonl"));
    assert.equal(await findCodexSessionFile("01a1f2c5-9cb1-7d32-ac1b-111111111111", codexHome), null);

    const page1 = await readBoundCodexSessionOutput({
      dispatchId: "ctx_attempt_2",
      taskId: "task_probe",
      sessionId,
      workspace,
      limit: 2,
      codexHome,
      status: { worker: "succeeded", terminal: "exited", liveness: "exited" },
    });
    assert.ok(page1);
    assert.equal(page1.source, "codex-session");
    assert.equal(page1.provider, "codex");
    assert.equal(page1.clipped, true);
    assert.equal(page1.contentComplete, false);
    assert.ok(page1.cursor?.startsWith(`codex1:ctx_attempt_2:${sessionId}:2:`));

    const page2 = await readBoundCodexSessionOutput({
      dispatchId: "ctx_attempt_2",
      taskId: "task_probe",
      sessionId,
      workspace,
      cursor: page1.cursor!,
      limit: 100,
      codexHome,
      status: { worker: "succeeded", terminal: "exited", liveness: "exited" },
    });
    assert.ok(page2);
    assert.equal(page2.sourceChanged, false);
    assert.equal(page2.clipped, false);
    assert.equal(page2.contentComplete, true);
    assert.ok((page2.messages?.length ?? 0) >= 2);
    assert.equal(page2.status?.liveness, "exited");

    appendFileSync(filePath, rolloutRows(
      userRecord("Personal question after the worker finished."),
      { type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "Personal answer." }] } },
    ));
    const afterUserPrompt = await readBoundCodexSessionOutput({
      dispatchId: "ctx_attempt_2",
      taskId: "task_probe",
      sessionId,
      workspace,
      cursor: page2.cursor!,
      codexHome,
      status: { worker: "succeeded", terminal: "exited", liveness: "exited" },
    });
    assert.ok(afterUserPrompt);
    assert.equal(afterUserPrompt.sourceChanged, false);
    assert.equal(afterUserPrompt.contentComplete, false);
    assert.deepEqual(afterUserPrompt.lines, []);
    assert.deepEqual(afterUserPrompt.messages, []);

    writeFileSync(join(codexHome, "sessions", `${sessionId}.jsonl`), sampleRolloutJsonl(workspace, sessionId));
    assert.equal(await findCodexSessionFile(sessionId, codexHome), null);
  });
});
