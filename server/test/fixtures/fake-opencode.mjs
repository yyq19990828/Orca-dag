#!/usr/bin/env node
// V2 API double. Never read real provider configuration or call a network.
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
const args = process.argv.slice(2);
const file = process.env.FAKE_OPENCODE_STATE;
const state = JSON.parse(readFileSync(file, "utf8"));
appendFileSync(process.env.FAKE_OPENCODE_LOG, JSON.stringify({ argv: args, at: Date.now() }) + "\n");
if (state.unavailable) { process.stderr.write("private credential must not leak"); process.exit(1); }
const [command, method, path] = args;
if (command !== "api") process.exit(1);
const reply = data => { console.log(JSON.stringify(data)); process.exit(0); };
if (path.startsWith("/api/model")) reply({ data: [{ id: "model", providerID: "provider", enabled: true, variants: [{ id: "high" }, { id: "low" }] }] });
if (path === "/api/session" && method === "POST") {
  const body = JSON.parse(args[args.indexOf("--data") + 1]);
  // The preparation must already be durable before this effect.
  const journal = JSON.parse(readFileSync(process.env.FAKE_OPENCODE_JOURNAL, "utf8"));
  if (!journal.openCodeLaunches?.some(row => row.sessionId === body.id)) process.exit(2);
  state.sessions ??= {};
  state.sessions[body.id] = body;
  writeFileSync(file, JSON.stringify(state));
  if (state.createResponseLost) process.exit(1);
  reply({ data: body });
}
const sessionId = path.split("/")[3]?.split("?")[0];
const session = state.sessions?.[sessionId];
if (path === "/api/session/active") {
  if (state.invalidActive) reply({ data: [] });
  reply({ data: state.active ? Object.fromEntries(Object.keys(state.sessions ?? {}).map(id => [id, { type: "running" }])) : {} });
}
if (!session) process.exit(3);
if (path.includes("/interrupt")) {
  appendFileSync(process.env.FAKE_ORCA_LOG, JSON.stringify({ argv: ["opencode-api", "interrupt"] }) + "\n");
  state.active = false; state.outcome = "interrupted";
  writeFileSync(file, JSON.stringify(state)); reply({ interrupted: true });
}
if (path.includes("/message")) {
  const orca = JSON.parse(readFileSync(process.env.FAKE_ORCA_STATE));
  const terminal = orca.terminals?.find(t => t.command?.includes(sessionId));
  const dispatch = Object.values(orca.dispatches ?? {}).find(d => d.agentTerminal === terminal?.handle);
  const messages = dispatch && !state.noInput ? [
    { id: "msg_user", type: "user", text: `${dispatch.task_id} ${dispatch.id}` },
    ...(!state.noAssistant ? [{ id: "msg_assistant", type: "assistant", model: session.model,
      content: [{ type: "text", text: state.longOutput ? "x".repeat(17_000) : "verified worker output\nsecond line" },
        { type: "reasoning", text: "private reasoning" }, { type: "tool", state: { input: { secret: "do not store" } } }] }] : []),
    ...(state.userOwned ? [{ id: "msg_owned", type: "user", text: "new user work" }] : []),
  ] : [];
  if (state.loopCursor) reply({ data: messages, cursor: { next: "same_cursor" } });
  reply({ data: messages, cursor: { next: null, previous: null } });
}
reply({ data: { ...session, model: { id: session.model.id, providerID: session.model.providerID,
  ...(session.model.variant ? { variant: session.model.variant } : {}) },
  location: state.wrongWorkspace ? { directory: "/" } : session.location, outcome: state.outcome ?? "succeeded" } });
