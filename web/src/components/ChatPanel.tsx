import { Fragment, useEffect, useMemo, useState } from "react";
import { replyToMessage, sendTaskMessage } from "../api";
import type {
  ActivityEvent,
  ActivitySnapshot,
  CoordinatorCheckAgentSummary,
  CoordinatorCheckReceipt,
  DagNode,
  StagePresence,
} from "../types";

const COORDINATOR_THREAD = "__run_coordinator__";

interface Conversation {
  id: string;
  taskId: string | null;
  label: string;
  subtitle: string | null;
  isLead: boolean;
  task: DagNode | null;
  presence: StagePresence | null;
  events: ActivityEvent[];
  pending: ActivityEvent[];
  latestAt: string;
}

interface TimelineCheckGroup {
  kind: "check";
  receipts: CoordinatorCheckReceipt[];
  at: number;
}

type TimelineItem =
  | { kind: "event"; event: ActivityEvent; at: number }
  | TimelineCheckGroup;

function clock(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function dayAndTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function messageBody(event: ActivityEvent): string {
  return event.summary;
}

function isAgentProgressSignal(event: ActivityEvent): boolean {
  return (
    event.direction === "agent_to_coordinator" &&
    (event.kind === "heartbeat" || event.kind === "status")
  );
}

function compactSignal(value: string | null | undefined): string | null {
  const normalized = value?.replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
  if (!normalized) return null;
  if (normalized === "input accepted") return "Prompt accepted, agent is working";
  return normalized.charAt(0).toUpperCase() + normalized.slice(1);
}

function eventHeading(event: ActivityEvent): string {
  switch (event.kind) {
    case "dispatch_started": return event.taskId ? "Assigned this stage" : "Run started";
    case "worker_done":
      return event.severity === "success" ? "Completed" : event.severity === "error" ? "Reported failure" : "Reported outcome";
    case "question": return "Question";
    case "escalation": return "Needs attention";
    case "reply": return "Reply";
    case "heartbeat": return "Working";
    default: return event.title;
  }
}

function eventActor(event: ActivityEvent): string {
  if (event.direction === "coordinator_to_agent") return "Coordinator";
  const runtime = [event.actor.harness, event.actor.model].filter(Boolean).join(" · ");
  if (runtime) return runtime;
  return event.actor.role === "lead" ? "Lead agent" : "Agent";
}

function stageState(task: DagNode, presence: StagePresence | null, waiting: boolean): string {
  if (waiting) return "Waiting for reply";
  if (task.status === "dispatched" && presence?.liveness === "unverifiable") return "Connection unknown";
  if (task.status === "dispatched") return "Running";
  return {
    pending: "Pending",
    ready: "Ready",
    completed: "Completed",
    failed: "Failed",
    blocked: "Blocked",
  }[task.status] ?? task.status;
}

function briefSummary(spec: string): string {
  const normalized = spec.replace(/\s+/g, " ").trim();
  if (!normalized) return "The coordinator assigned this stage without an additional brief.";
  const sentence = normalized.match(/^.*?[.!?](?:\s|$)/)?.[0]?.trim() ?? normalized;
  return sentence.length > 220 ? `${sentence.slice(0, 217).trimEnd()}...` : sentence;
}

function checkTitle(receipt: CoordinatorCheckReceipt): string {
  if (receipt.error) return "Check failed";
  if (receipt.messageCount > 0) {
    const types = receipt.messageTypes.map((type) => compactSignal(type) ?? type).join(", ");
    const action = receipt.source === "external_inferred" ? "Coordinator checked" : "Inbox check received";
    return `${action} ${receipt.messageCount} ${receipt.messageCount === 1 ? "message" : "messages"}${types ? ` · ${types}` : ""}`;
  }
  return receipt.timedOut ? "No new inbox messages" : "Inbox checked";
}

function checkAgentLine(agent: CoordinatorCheckAgentSummary | null): string {
  if (!agent) return "No active agent snapshot in this pass";
  const activity = compactSignal(agent.detail) ?? compactSignal(agent.activity);
  const signals = agent.attention.map((attention) => ({
    input: "Waiting for coordinator reply",
    unverifiable: "Connection not yet verified",
    root_completion: "Completion received",
  })[attention] ?? compactSignal(attention) ?? attention);
  const liveness = {
    live: "Live",
    unverifiable: "Connection unknown",
    exited: "Agent exited",
  }[agent.liveness];
  return [activity, ...signals, agent.outcome ? compactSignal(agent.outcome) : null, liveness]
    .filter(Boolean)
    .filter((value, index, values) => values.indexOf(value) === index)
    .join(" · ");
}

function checkFleetLine(agents: CoordinatorCheckAgentSummary[]): string {
  if (agents.length === 0) return "No active agent snapshot in this pass";
  const live = agents.filter((agent) => agent.liveness === "live").length;
  const waiting = agents.filter((agent) => agent.attention.includes("input")).length;
  const unknown = agents.filter((agent) => agent.attention.includes("unverifiable")).length;
  const completed = agents.filter((agent) => agent.attention.includes("root_completion")).length;
  const otherAttention = agents.filter((agent) =>
    agent.attention.some((attention) => !["input", "unverifiable", "root_completion"].includes(attention)),
  ).length;
  const activities = [...new Set(agents.map((agent) => compactSignal(agent.detail) ?? compactSignal(agent.activity)).filter(Boolean))];
  return [
    `${agents.length} ${agents.length === 1 ? "agent" : "agents"} · ${live} live`,
    waiting > 0 ? `${waiting} waiting for reply` : null,
    unknown > 0 ? `${unknown} connection unknown` : null,
    completed > 0 ? `${completed} completion received` : null,
    otherAttention > 0 ? `${otherAttention} need review` : null,
    activities.length > 0 ? activities.slice(0, 2).join(", ") : null,
  ].filter(Boolean).join(" · ");
}

function checkStateKey(receipt: CoordinatorCheckReceipt, taskId: string | null): string {
  const agents = taskId
    ? receipt.agents.filter((agent) => agent.taskId === taskId)
    : receipt.agents;
  return agents
    .map((agent) => [
      agent.taskId,
      agent.liveness,
      agent.activity,
      agent.detail,
      agent.attention.join(","),
      agent.outcome,
    ].join(":"))
    .join("|");
}

/**
 * Empty inbox passes are useful evidence, but rendering every 2-3 second poll
 * as a separate row overwhelms the actual conversation. Collapse only
 * adjacent passes whose agent snapshot is identical; state changes and new
 * deliveries remain individual timeline moments.
 */
function checkMergeKey(receipt: CoordinatorCheckReceipt, taskId: string | null): string | null {
  if (receipt.error) return null;
  const state = checkStateKey(receipt, taskId);
  if (receipt.messageCount === 0) return `quiet:${state}`;
  return receipt.deliveryId ? `delivery:${receipt.deliveryId}:${state}` : null;
}

function buildTimeline(
  events: ActivityEvent[],
  checks: CoordinatorCheckReceipt[],
  taskId: string | null,
): TimelineItem[] {
  const raw: TimelineItem[] = [
    ...events.map((event): TimelineItem => ({
      kind: "event",
      event,
      at: Number.isNaN(Date.parse(event.createdAt)) ? 0 : Date.parse(event.createdAt),
    })),
    ...checks.map((receipt): TimelineItem => ({ kind: "check", receipts: [receipt], at: receipt.checkedAt })),
  ].sort((a, b) => a.at - b.at || (a.kind === "event" ? -1 : 1));

  const timeline: TimelineItem[] = [];
  for (const item of raw) {
    if (item.kind === "event") {
      timeline.push(item);
      continue;
    }
    const previous = timeline.at(-1);
    const currentReceipt = item.receipts[0];
    const previousReceipt = previous?.kind === "check" ? previous.receipts.at(-1) : null;
    const currentKey = checkMergeKey(currentReceipt, taskId);
    if (
      previous?.kind === "check" &&
      previousReceipt &&
      currentKey &&
      currentKey === checkMergeKey(previousReceipt, taskId)
    ) {
      previous.receipts.push(currentReceipt);
      previous.at = currentReceipt.checkedAt;
      continue;
    }
    timeline.push(item);
  }
  return timeline;
}

function checkGroupTitle(receipts: CoordinatorCheckReceipt[]): string {
  const latest = receipts.at(-1)!;
  if (receipts.length === 1) return checkTitle(latest);
  if (latest.messageCount === 0) return `Inbox checked ${receipts.length} times · no new messages`;
  return `${checkTitle(latest)} · observed ${receipts.length} times`;
}

function checkSourceLabel(receipt: CoordinatorCheckReceipt): string {
  return receipt.source === "external_inferred"
    ? "External coordinator activity reconstructed from Orca records"
    : "Viewer coordinator inbox check";
}

function checkInboxResult(receipt: CoordinatorCheckReceipt): string {
  if (receipt.error) return `Failed: ${receipt.error}`;
  if (receipt.messageCount === 0) {
    return receipt.timedOut ? "No message arrived before the wait ended" : "No new messages";
  }
  const types = receipt.messageTypes
    .map((type) => compactSignal(type) ?? type)
    .filter((type, index, values) => values.indexOf(type) === index);
  return `${receipt.messageCount} ${receipt.messageCount === 1 ? "message" : "messages"}${types.length > 0 ? `: ${types.join(", ")}` : ""}`;
}

function checkDurationLabel(receipt: CoordinatorCheckReceipt): string {
  if (receipt.source === "external_inferred") return "Not exposed by Orca";
  if (receipt.durationMs < 1_000) return `${receipt.durationMs} ms`;
  return `${(receipt.durationMs / 1_000).toFixed(1)} s`;
}

function checkDeliveryLabel(receipt: CoordinatorCheckReceipt): string {
  if (receipt.source === "external_inferred") return "Not exposed by Orca";
  return receipt.deliveryId ?? "No delivery";
}

/**
 * Chat is a conversation projection of the same Run-scoped Activity stream.
 * It deliberately does not invent a second message transport: grouping the
 * normalized events by task preserves one source of truth while presenting
 * coordinator/worker exchanges in the familiar inbox + conversation shape.
 */
export function ChatPanel({
  runId,
  snapshot,
  tasks,
  leadTaskId,
  onSelectTask,
  onResolved,
  coordinatorActive,
  disabled = false,
  disabledReason,
}: {
  runId: string;
  snapshot: ActivitySnapshot;
  tasks: DagNode[];
  leadTaskId: string | null;
  onSelectTask: (taskId: string) => void;
  onResolved: () => void;
  coordinatorActive: boolean;
  disabled?: boolean;
  disabledReason?: string | null;
}) {
  const conversations = useMemo(() => {
    const grouped = new Map<string, ActivityEvent[]>();
    const taskMap = new Map(tasks.map((task) => [task.id, task]));
    const presenceMap = new Map(snapshot.presence.map((presence) => [presence.taskId, presence]));
    // A worker-start sends the Task spec as the worker's initial brief, but
    // Orca's coordinator mailbox only retains worker-to-coordinator messages.
    // Seed each Task thread from the DAG so that this real outbound half of
    // the exchange remains visible without pretending it was a mailbox row.
    for (const task of tasks) grouped.set(task.id, []);
    for (const event of snapshot.events) {
      const id = event.taskId ?? COORDINATOR_THREAD;
      const current = grouped.get(id) ?? [];
      current.push(event);
      grouped.set(id, current);
    }

    return [...grouped.entries()]
      .map(([id, events]): Conversation => {
        const sorted = [...events].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
        const workerEvent = [...sorted]
          .reverse()
          .find((event) => event.actor.role === "worker" || event.actor.role === "lead");
        const taskId = id === COORDINATOR_THREAD ? null : id;
        const task = taskId ? taskMap.get(taskId) ?? null : null;
        const presence = taskId ? presenceMap.get(taskId) ?? null : null;
        const harness = presence?.agent ?? workerEvent?.actor.harness ?? null;
        const model = presence?.model ?? workerEvent?.actor.model ?? null;
        const effort = presence?.effort ?? null;
        return {
          id,
          taskId,
          label: taskId ? workerEvent?.actor.label || task?.label || `Stage ${taskId}` : "Run control",
          subtitle: [harness, model, effort].filter(Boolean).join(" · ") || null,
          isLead: Boolean(taskId && taskId === leadTaskId),
          task,
          presence,
          events: sorted,
          pending: sorted.filter((event) => event.actionable?.kind === "reply"),
          latestAt: sorted.at(-1)?.createdAt ?? task?.createdAt ?? "",
        };
      })
      .sort((a, b) => {
        // Run control is infrastructure, not another worker conversation. Keep
        // it in a stable system slot so Agent traffic can reorder by recency
        // without making the control plane look like a peer Agent.
        const aIsSystem = a.id === COORDINATOR_THREAD;
        const bIsSystem = b.id === COORDINATOR_THREAD;
        if (aIsSystem !== bIsSystem) return aIsSystem ? -1 : 1;
        return b.latestAt.localeCompare(a.latestAt);
      });
  }, [leadTaskId, snapshot.events, snapshot.presence, tasks]);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setSelectedId(null);
    setDraft("");
    setError(null);
  }, [runId]);

  useEffect(() => {
    if (selectedId && conversations.some((conversation) => conversation.id === selectedId)) return;
    const next = conversations.find((conversation) => conversation.pending.length > 0) ?? conversations[0];
    setSelectedId(next?.id ?? null);
  }, [conversations, selectedId]);

  const selected = conversations.find((conversation) => conversation.id === selectedId) ?? null;
  const replyTarget = selected?.pending.at(-1) ?? null;
  const progressEvent = selected
    ? [...selected.events].reverse().find(isAgentProgressSignal) ?? null
    : null;
  const outcomeEvent = selected
    ? [...selected.events].reverse().find((event) => event.kind === "worker_done") ?? null
    : null;
  const visibleEvents = selected?.events.filter((event) => !isAgentProgressSignal(event)) ?? [];
  const selectedChecks = selected
    ? snapshot.checks.filter(
        (receipt) => !selected.taskId || receipt.agents.some((agent) => agent.taskId === selected.taskId),
      )
    : [];
  const timeline = buildTimeline(visibleEvents, selectedChecks, selected?.taskId ?? null);
  const lastCheck = selectedChecks.at(-1) ?? null;
  const presenceSummary = selected?.task
    ? replyTarget?.summary ??
      outcomeEvent?.summary ??
      progressEvent?.summary ??
      compactSignal(selected.presence?.detail) ??
      compactSignal(selected.presence?.activity) ??
      "No recent agent update"
    : null;
  const activeDispatch =
    coordinatorActive && selected?.task?.status === "dispatched" && selected.task.dispatchId
      ? selected.task.dispatchId
      : null;
  const hasRecordedAssignment = Boolean(
    selected?.events.some(
      (event) => event.kind === "dispatch_started" && event.direction === "coordinator_to_agent",
    ),
  );

  function renderTimelineCheck(group: TimelineCheckGroup) {
    const receipt = group.receipts.at(-1)!;
    const receiptDetail = (candidate: CoordinatorCheckReceipt) => {
      if (candidate.evidence) return candidate.evidence;
      const agent = selected?.taskId
        ? candidate.agents.find((item) => item.taskId === selected.taskId) ?? null
        : null;
      return candidate.error ?? (selected?.taskId ? checkAgentLine(agent) : checkFleetLine(candidate.agents));
    };
    const agent = selected?.taskId
      ? receipt.agents.find((candidate) => candidate.taskId === selected.taskId) ?? null
      : null;
    const detail = receiptDetail(receipt);
    const important = Boolean(receipt.error || receipt.messageCount > 0 || agent?.attention.length);
    const detailsLabel = group.receipts.length > 1
      ? `${group.receipts.length} checks · Details`
      : "Details";
    return (
      <div
        key={`check:${group.receipts[0].checkedAt}:${receipt.checkedAt}`}
        className={`chat-checkpoint${important ? " chat-checkpoint--important" : ""}${receipt.error ? " chat-checkpoint--error" : ""}`}
        aria-label="Coordinator check"
      >
        <span className="chat-checkpoint__rail" aria-hidden="true">
          <span className="chat-checkpoint__dot" />
        </span>
        <div className="chat-checkpoint__copy">
          <div className="chat-checkpoint__head">
            <strong>{checkGroupTitle(group.receipts)}</strong>
            <time dateTime={new Date(receipt.checkedAt).toISOString()}>{clock(new Date(receipt.checkedAt).toISOString())}</time>
          </div>
          {important && detail && <span className="chat-checkpoint__summary">{detail}</span>}
          <details className="chat-checkpoint__details">
            <summary>
              <span>{detailsLabel}</span>
              <span className="chat-checkpoint__chevron" aria-hidden="true">›</span>
            </summary>
            <div className="chat-checkpoint__log">
              {group.receipts.map((item, index) => {
                const relevantAgents = selected?.taskId
                  ? item.agents.filter((candidate) => candidate.taskId === selected.taskId)
                  : item.agents;
                const itemIso = new Date(item.checkedAt).toISOString();
                return (
                  <article className="chat-checkpoint__receipt" key={`${item.checkedAt}:${item.sequence}`}>
                    <header>
                      <span>{group.receipts.length > 1 ? `Check ${index + 1} of ${group.receipts.length}` : "Check record"}</span>
                      <time dateTime={itemIso}>{dayAndTime(itemIso)}</time>
                    </header>
                    <dl className="chat-checkpoint__facts">
                      <div>
                        <dt>Source</dt>
                        <dd>{checkSourceLabel(item)}</dd>
                      </div>
                      <div>
                        <dt>Inbox result</dt>
                        <dd>{checkInboxResult(item)}</dd>
                      </div>
                      <div>
                        <dt>Wait duration</dt>
                        <dd>{checkDurationLabel(item)}</dd>
                      </div>
                      <div>
                        <dt>Delivery</dt>
                        <dd title={checkDeliveryLabel(item)}>{checkDeliveryLabel(item)}</dd>
                      </div>
                      {item.replayed && (
                        <div>
                          <dt>Replay</dt>
                          <dd>Previously observed delivery</dd>
                        </div>
                      )}
                    </dl>
                    {item.evidence && (
                      <p className="chat-checkpoint__evidence">
                        <strong>Why this check appears</strong>
                        <span>{item.evidence}</span>
                      </p>
                    )}
                    <div className="chat-checkpoint__agents">
                      <strong>Agent snapshot</strong>
                      {relevantAgents.length > 0 ? relevantAgents.map((candidate) => {
                        const stage = tasks.find((task) => task.id === candidate.taskId);
                        const agentName = candidate.agent === "unknown agent" ? null : candidate.agent;
                        const runtime = [agentName, candidate.model, candidate.effort].filter(Boolean).join(" · ");
                        return (
                          <div className="chat-checkpoint__agent" key={`${item.sequence}:${candidate.taskId}`}>
                            <span>{stage?.label ?? candidate.taskId}</span>
                            <small>{runtime || "Runtime not recorded"}</small>
                            <p>{checkAgentLine(candidate)}</p>
                          </div>
                        );
                      }) : (
                        <p className="chat-checkpoint__empty">No agent state was attached to this check.</p>
                      )}
                    </div>
                  </article>
                );
              })}
            </div>
          </details>
        </div>
      </div>
    );
  }

  async function sendMessage() {
    const body = draft.trim();
    const targetId = replyTarget?.actionable?.targetId;
    const taskId = selected?.taskId;
    if (!body || !runId || disabled || busy || (!targetId && (!taskId || !activeDispatch))) return;
    setBusy(true);
    setError(null);
    try {
      if (targetId) await replyToMessage(targetId, body, runId);
      else await sendTaskMessage(taskId!, body, runId);
      setDraft("");
      onResolved();
    } catch (err) {
      setError(String((err as Error).message ?? err));
    } finally {
      setBusy(false);
    }
  }

  if (!runId) {
    return <div className="chat__empty">Pick a Run to open its conversations.</div>;
  }

  if (conversations.length === 0) {
    return (
      <div className="chat__empty">
        Conversations appear here when the coordinator dispatches work or an agent sends an update.
      </div>
    );
  }

  return (
    <section className="chat" aria-label="Coordinator conversations">
      <nav className="chat__threads" aria-label="Conversations">
        <div className="chat__threads-title">
          <span>Conversations</span>
          <span>{conversations.length}</span>
        </div>
        <div className="chat__thread-list">
          {conversations.map((conversation, index) => {
            const latest = conversation.events.at(-1);
            const isSystem = conversation.id === COORDINATOR_THREAD;
            return (
              <Fragment key={conversation.id}>
                {index > 0 && conversations[index - 1]?.id === COORDINATOR_THREAD && (
                  <div className="chat-thread__section">Agent conversations</div>
                )}
                <button
                  type="button"
                  className={`chat-thread${isSystem ? " chat-thread--system" : ""}${selected?.id === conversation.id ? " chat-thread--active" : ""}`}
                  aria-current={selected?.id === conversation.id ? "true" : undefined}
                  onClick={() => {
                    setSelectedId(conversation.id);
                    setDraft("");
                    setError(null);
                  }}
                >
                  <span
                    className={`chat-thread__avatar${conversation.isLead ? " chat-thread__avatar--lead" : ""}${isSystem ? " chat-thread__avatar--system" : ""}`}
                    aria-hidden="true"
                  >
                    {conversation.taskId ? (conversation.isLead ? "★" : "S") : "R"}
                  </span>
                  <span className="chat-thread__copy">
                    <span className="chat-thread__topline">
                      <strong>{conversation.label}</strong>
                      {isSystem && <span className="chat-thread__system-label">System</span>}
                      <time dateTime={conversation.latestAt}>{clock(conversation.latestAt)}</time>
                    </span>
                    <span className="chat-thread__preview">
                      {latest
                        ? messageBody(latest)
                        : compactSignal(conversation.presence?.detail) ??
                          compactSignal(conversation.presence?.activity) ??
                          (conversation.task ? "Coordinator assigned the stage brief" : "No messages")}
                    </span>
                  </span>
                  {conversation.pending.length > 0 && (
                    <span className="chat-thread__badge" aria-label={`${conversation.pending.length} replies needed`}>
                      {conversation.pending.length}
                    </span>
                  )}
                </button>
              </Fragment>
            );
          })}
        </div>
      </nav>

      <div className="chat__conversation">
        {selected && (
          <>
            <header className="chat__conversation-head">
              <div>
                <div className="chat__conversation-title">
                  <strong>{selected.label}</strong>
                  {selected.isLead && <span>★ Lead stage</span>}
                  {!selected.taskId && <span className="chat__conversation-system">System</span>}
                </div>
                <p>{selected.subtitle || (selected.taskId ? selected.taskId : "Scheduling, inbox checks, and system events")}</p>
              </div>
              {selected.taskId && (
                <button type="button" onClick={() => onSelectTask(selected.taskId!)}>
                  Open stage
                </button>
              )}
            </header>

            <div className="chat__messages" aria-live="polite">
              {selected.task && !hasRecordedAssignment && (
                <article className="chat-message chat-message--outgoing chat-message--brief">
                  <div className="chat-message__meta">
                    <strong>Coordinator</strong>
                    <time dateTime={selected.task.createdAt}>{dayAndTime(selected.task.createdAt)}</time>
                  </div>
                  <h3>Assigned this stage</h3>
                  <small>Recovered from Task history</small>
                  <p>{briefSummary(selected.task.spec)}</p>
                  {selected.task.spec.trim() && selected.task.spec.trim() !== briefSummary(selected.task.spec) && (
                    <details className="chat-message__details">
                      <summary>Full task brief</summary>
                      <p>{selected.task.spec}</p>
                    </details>
                  )}
                </article>
              )}
              {timeline.map((item) => {
                if (item.kind === "check") return renderTimelineCheck(item);
                const event = item.event;
                const system = event.direction === "system" || event.actor.role === "system";
                const outgoing = event.direction === "coordinator_to_agent";
                return system ? (
                  <div key={event.id} className={`chat-message chat-message--system chat-message--${event.severity}`}>
                    <span>{event.title}</span>
                    <p>{messageBody(event)}</p>
                    <time dateTime={event.createdAt}>{dayAndTime(event.createdAt)}</time>
                  </div>
                ) : (
                  <article
                    key={event.id}
                    className={`chat-message ${outgoing ? "chat-message--outgoing" : "chat-message--incoming"} chat-message--${event.kind} chat-message--${event.severity}`}
                  >
                    <div className="chat-message__meta">
                      <strong>{eventActor(event)}</strong>
                      <time dateTime={event.createdAt}>{dayAndTime(event.createdAt)}</time>
                    </div>
                    <h3>{eventHeading(event)}</h3>
                    <p>{messageBody(event)}</p>
                    {event.groupedCount > 1 && <small>{event.groupedCount} similar updates grouped</small>}
                    {event.actionable?.kind === "reply" && <span className="chat-message__waiting">Waiting for reply</span>}
                    {event.detail?.trim() && event.detail.trim() !== event.summary.trim() && (
                      <details className="chat-message__details">
                        <summary>{event.kind === "dispatch_started" ? "Full task brief" : "Full report"}</summary>
                        <p>{event.detail}</p>
                      </details>
                    )}
                  </article>
                );
              })}

              <section
                className="chat-runtime-summary"
                data-active={coordinatorActive ? "true" : "false"}
                aria-label="Run status summary"
              >
                <span className="chat-runtime-summary__pulse" aria-hidden="true" />
                <strong>
                  {selected.task
                    ? stageState(selected.task, selected.presence, selected.pending.length > 0)
                    : coordinatorActive ? "Run control active" : "Run control stopped"}
                </strong>
                <span className="chat-runtime-summary__detail">
                  {selected.task
                    ? presenceSummary
                    : coordinatorActive ? "Scheduling stages and checking the Run inbox" : "Run-level activity only"}
                </span>
                <span className="chat-runtime-summary__meta">
                  {lastCheck ? `Last check ${clock(new Date(lastCheck.checkedAt).toISOString())}` : "No checks yet"}
                  {selectedChecks.length > 0 && ` · ${selectedChecks.length} total`}
                </span>
              </section>
            </div>

            <footer className="chat__composer">
              {error && <div className="chat__error" role="status">⚠ {error}</div>}
              {replyTarget || activeDispatch ? (
                <div className="chat__compose-row">
                  <textarea
                    rows={2}
                    value={draft}
                    disabled={disabled || busy}
                    placeholder={
                      disabled
                        ? "Execution unavailable"
                        : replyTarget
                          ? `Reply to ${selected.label}`
                          : `Send guidance to ${selected.label}`
                    }
                    aria-label={replyTarget ? `Reply to ${selected.label}` : `Send guidance to ${selected.label}`}
                    onChange={(event) => setDraft(event.target.value)}
                    onKeyDown={(event) => {
                      if ((event.metaKey || event.ctrlKey) && event.key === "Enter") void sendMessage();
                    }}
                  />
                  <button
                    type="button"
                    className="btn btn--ok"
                    disabled={disabled || busy || !draft.trim()}
                    title={
                      disabled
                        ? disabledReason ?? "Execution is unavailable"
                        : `${replyTarget ? "Send reply" : "Send guidance"} (Ctrl or Command + Enter)`
                    }
                    onClick={() => void sendMessage()}
                  >
                    {busy ? "Sending…" : "Send"}
                  </button>
                </div>
              ) : (
                <p className="chat__composer-idle">
                  {selected.task
                    ? selected.task.status === "dispatched" && !coordinatorActive
                      ? "Start this Run's coordinator to send guidance to its active Dispatch."
                      : "This stage has no active Dispatch. Its conversation is read-only."
                    : "Select an active stage to send coordinator guidance."}
                </p>
              )}
            </footer>
          </>
        )}
      </div>
    </section>
  );
}
