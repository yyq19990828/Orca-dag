import { Fragment, memo, useEffect, useMemo, useState } from "react";
import { fetchAudiencePreview, replyToMessage, sendGroupMessage, sendTaskMessage } from "../api";
import { formatClock, formatDateTime, isUrgent, priorityLabel } from "../format";
import { t, useLang, useT } from "../i18n";
import { useDecisionDialog } from "./DecisionDialog";
import { DoodleSelect, type DoodleOption } from "./DoodleSelect";
import type {
  ActivityEvent,
  ActivitySnapshot,
  AudiencePreviewResponse,
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
  /** Durable evidence only: some row in this thread is explicitly unread. */
  unread: boolean;
  /** Any row in this thread carries a high/urgent Orca priority. */
  urgent: boolean;
}

interface TimelineCheckGroup {
  kind: "check";
  receipts: CoordinatorCheckReceipt[];
  at: number;
}

type TimelineItem =
  | { kind: "event"; event: ActivityEvent; at: number }
  | TimelineCheckGroup;

function messageBody(event: ActivityEvent): string {
  return event.summary;
}

/** Orca priorities a group send may carry; "normal" renders no chip at all. */
const GROUP_PRIORITIES = ["low", "normal", "high", "urgent"] as const;
type GroupPriority = (typeof GROUP_PRIORITIES)[number];

/**
 * A group bubble shows its requested priority whenever it is anything other
 * than the default "normal" — the priority is part of the send's metadata the
 * plan requires the outgoing row to retain.
 */
function groupPriorityChip(event: ActivityEvent): string | null {
  const normalized = event.priority?.trim().toLowerCase();
  if (!normalized || normalized === "normal") return null;
  return priorityLabel(event);
}

/**
 * Compact thread context (Phase 3): a reply bubble quotes the message Orca
 * threaded it to. The lookup is deliberately evidence-gated — without both a
 * `threadId` on the reply and the referenced row in this Run's history, no
 * relationship is claimed (parent rows can age out of the bounded inbox
 * window, which renders as no context, never as a guessed one).
 */
function replyContextOf(event: ActivityEvent, byId: Map<string, ActivityEvent>): ActivityEvent | null {
  if (!event.threadId) return null;
  const parent = byId.get(event.threadId);
  return parent && parent.id !== event.id ? parent : null;
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
  if (normalized === "input accepted") return t("chat.signal.promptAccepted");
  return normalized.charAt(0).toUpperCase() + normalized.slice(1);
}

function eventHeading(event: ActivityEvent): string {
  switch (event.kind) {
    case "dispatch_started": return event.taskId ? t("chat.heading.assignedStage") : t("chat.heading.runStarted");
    case "worker_done":
      return event.severity === "success"
        ? t("chat.heading.completed")
        : event.severity === "error" ? t("chat.heading.reportedFailure") : t("chat.heading.reportedOutcome");
    case "question": return t("chat.heading.question");
    case "escalation": return t("chat.heading.needsAttention");
    case "reply": return t("chat.heading.reply");
    case "heartbeat": return t("chat.heading.working");
    default: return event.title;
  }
}

function eventActor(event: ActivityEvent): string {
  if (event.direction === "coordinator_to_agent") return t("chat.actor.coordinator");
  const runtime = [event.actor.harness, event.actor.model].filter(Boolean).join(" · ");
  if (runtime) return runtime;
  return event.actor.role === "lead" ? t("chat.actor.lead") : t("chat.actor.agent");
}

function stageState(task: DagNode, presence: StagePresence | null, waiting: boolean): string {
  if (waiting) return t("chat.state.waitingReply");
  if (task.status === "dispatched" && presence?.liveness === "unverifiable") {
    // Phase 2: for the documented fleet capability gaps, an exact worker-show
    // observation proving the terminal live replaces the misleading generic
    // label with the qualified working state — the fleet verdict itself stays
    // unverifiable (both evidence layers remain visible in Worker Operations).
    if (presence.qualifiedWorking) return t("chat.state.workingTerminalLive");
    return t("chat.state.connectionUnknown");
  }
  if (task.status === "dispatched") return t("chat.state.running");
  return {
    pending: t("chat.state.pending"),
    ready: t("chat.state.ready"),
    completed: t("chat.state.completed"),
    failed: t("chat.state.failed"),
    blocked: t("chat.state.blocked"),
  }[task.status] ?? task.status;
}

/**
 * Coarse bucket for the runtime-summary pulse: the dot's colour — and whether
 * it pulses at all — must agree with the words beside it. A "Completed" row
 * keeps a settled green dot; only genuinely live states (run control active,
 * a running or replying stage) pulse. Values are styled in styles.css, where
 * the palette mirrors STATUS_META so canvas and chat never disagree.
 */
function summaryStateKey(task: DagNode, presence: StagePresence | null, waiting: boolean): string {
  if (waiting) return "waiting";
  if (task.status === "dispatched") {
    return presence?.liveness === "unverifiable" ? "unknown" : "running";
  }
  return task.status; // pending | ready | completed | failed | blocked
}

/** Connector words skipped when picking avatar initials ("Capability and Run
    Health" is CR, not CA). */
const AVATAR_STOP_WORDS = new Set([
  "a", "an", "and", "for", "in", "of", "on", "or", "the", "to", "with",
]);

/**
 * Stage initials for the thread avatar. The old constant "S" made every stage
 * look identical in the list; two letters picked from the label's first two
 * meaningful words keep each row recognizable at a glance ("Integration and
 * Acceptance" → IA, "DAG Hierarchy and Ready Waves" → DH). Falls back to the
 * first letter (or "S" for an empty label).
 */
function initialsOf(label: string): string {
  const words = label
    .split(/\s+/)
    .map((word) => word.trim())
    .filter((word) => word && !AVATAR_STOP_WORDS.has(word.toLowerCase()));
  const picks = (words.length >= 2 ? words.slice(0, 2) : words.slice(0, 1)).map(
    (word) => [...word][0]?.toUpperCase() ?? "",
  );
  return picks.join("") || "S";
}

function briefSummary(spec: string): string {
  const normalized = spec.replace(/\s+/g, " ").trim();
  if (!normalized) return t("chat.brief.empty");
  const sentence = normalized.match(/^.*?[.!?](?:\s|$)/)?.[0]?.trim() ?? normalized;
  return sentence.length > 220 ? `${sentence.slice(0, 217).trimEnd()}...` : sentence;
}

function checkTitle(receipt: CoordinatorCheckReceipt): string {
  if (receipt.error) return t("chat.check.failed");
  if (receipt.messageCount > 0) {
    const types = receipt.messageTypes.map((type) => compactSignal(type) ?? type).join(", ");
    const action = receipt.source === "external_inferred"
      ? t("chat.check.externalAction")
      : t("chat.check.inboxAction");
    const count = receipt.messageCount === 1
      ? t("chat.check.countOne", { n: receipt.messageCount })
      : t("chat.check.countMany", { n: receipt.messageCount });
    return `${action} ${count}${types ? t("chat.check.typesSuffix", { types }) : ""}`;
  }
  return receipt.timedOut ? t("chat.check.noneTimedOut") : t("chat.check.inboxChecked");
}

function checkAgentLine(agent: CoordinatorCheckAgentSummary | null): string {
  if (!agent) return t("chat.check.noAgents");
  const activity = compactSignal(agent.detail) ?? compactSignal(agent.activity);
  const signals = agent.attention.map((attention) => ({
    input: t("chat.check.attentionInput"),
    unverifiable: t("chat.check.attentionUnverifiable"),
    root_completion: t("chat.check.attentionCompletion"),
  })[attention] ?? compactSignal(attention) ?? attention);
  const liveness = {
    live: t("chat.check.livenessLive"),
    unverifiable: t("chat.state.connectionUnknown"),
    exited: t("chat.check.livenessExited"),
  }[agent.liveness];
  return [activity, ...signals, agent.outcome ? compactSignal(agent.outcome) : null, liveness]
    .filter(Boolean)
    .filter((value, index, values) => values.indexOf(value) === index)
    .join(" · ");
}

function checkFleetLine(agents: CoordinatorCheckAgentSummary[]): string {
  if (agents.length === 0) return t("chat.check.noAgents");
  const live = agents.filter((agent) => agent.liveness === "live").length;
  const waiting = agents.filter((agent) => agent.attention.includes("input")).length;
  const unknown = agents.filter((agent) => agent.attention.includes("unverifiable")).length;
  const completed = agents.filter((agent) => agent.attention.includes("root_completion")).length;
  const otherAttention = agents.filter((agent) =>
    agent.attention.some((attention) => !["input", "unverifiable", "root_completion"].includes(attention)),
  ).length;
  const activities = [...new Set(agents.map((agent) => compactSignal(agent.detail) ?? compactSignal(agent.activity)).filter(Boolean))];
  return [
    `${agents.length === 1
      ? t("chat.check.fleetAgentOne", { n: agents.length })
      : t("chat.check.fleetAgentMany", { n: agents.length })} · ${t("chat.check.fleetLive", { n: live })}`,
    waiting > 0 ? t("chat.check.fleetWaiting", { n: waiting }) : null,
    unknown > 0 ? t("chat.check.fleetUnknown", { n: unknown }) : null,
    completed > 0 ? t("chat.check.fleetCompletion", { n: completed }) : null,
    otherAttention > 0 ? t("chat.check.fleetReview", { n: otherAttention }) : null,
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
  if (latest.messageCount === 0) return t("chat.check.repeatQuiet", { n: receipts.length });
  return t("chat.check.repeat", { title: checkTitle(latest), n: receipts.length });
}

function checkSourceLabel(receipt: CoordinatorCheckReceipt): string {
  return receipt.source === "external_inferred"
    ? t("chat.check.sourceExternal")
    : t("chat.check.sourceViewer");
}

function checkInboxResult(receipt: CoordinatorCheckReceipt): string {
  if (receipt.error) return t("chat.check.resultFailed", { error: receipt.error });
  if (receipt.messageCount === 0) {
    return receipt.timedOut ? t("chat.check.resultNoArrival") : t("chat.check.resultNoNew");
  }
  const types = receipt.messageTypes
    .map((type) => compactSignal(type) ?? type)
    .filter((type, index, values) => values.indexOf(type) === index);
  const count = receipt.messageCount === 1
    ? t("chat.check.countOne", { n: receipt.messageCount })
    : t("chat.check.countMany", { n: receipt.messageCount });
  return `${count}${types.length > 0 ? t("chat.check.resultTypes", { types: types.join(", ") }) : ""}`;
}

function checkDurationLabel(receipt: CoordinatorCheckReceipt): string {
  if (receipt.source === "external_inferred") return t("chat.check.notExposed");
  if (receipt.durationMs < 1_000) return `${receipt.durationMs} ms`;
  return `${(receipt.durationMs / 1_000).toFixed(1)} s`;
}

function checkDeliveryLabel(receipt: CoordinatorCheckReceipt): string {
  if (receipt.source === "external_inferred") return t("chat.check.notExposed");
  return receipt.deliveryId ?? t("chat.check.noDelivery");
}

/**
 * Chat is a conversation projection of the same Run-scoped Activity stream.
 * It deliberately does not invent a second message transport: grouping the
 * normalized events by task preserves one source of truth while presenting
 * coordinator/worker exchanges in the familiar inbox + conversation shape.
 */
export const ChatPanel = memo(function ChatPanel({
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
  // Priority chips and message timestamps come from the shared formatters in
  // format.ts, which read the language non-reactively (no hooks there by
  // design) — so this memo()'d panel subscribes itself and re-renders its
  // whole timeline when the UI language changes. `lang` also feeds the memos
  // below: they build translated fallbacks (a thread's "Run control" label),
  // and a memo keyed only on data would keep the pre-switch wording.
  const t = useT();
  const lang = useLang();
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
          label: taskId
            ? workerEvent?.actor.label || task?.label || t("chat.thread.stageFallback", { id: taskId })
            : t("chat.thread.runControl"),
          subtitle: [harness, model, effort].filter(Boolean).join(" · ") || null,
          isLead: Boolean(taskId && taskId === leadTaskId),
          task,
          presence,
          events: sorted,
          pending: sorted.filter((event) => event.actionable?.kind === "reply"),
          latestAt: sorted.at(-1)?.createdAt ?? task?.createdAt ?? "",
          unread: sorted.some((event) => event.read === false),
          urgent: sorted.some((event) => isUrgent(event)),
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
  }, [lang, leadTaskId, snapshot.events, snapshot.presence, tasks]);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  // Quiet Runs can accumulate hundreds of checks in one digest. Keep their
  // evidence out of the DOM until the user opens Details, then reveal it in
  // bounded pages so tab changes never style thousands of hidden elements.
  const [expandedChecks, setExpandedChecks] = useState<Record<string, number>>({});
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // --- Phase 6: Run-control group composer -----------------------------------
  //
  // The audience list comes from the server's preview endpoint, which only
  // ever offers allowlisted addresses (@all, @idle, active harness groups,
  // exact discovered @worktree:<id>). The composer never lets a recipient
  // string be typed — choosing is the only way to address a group.
  const dialog = useDecisionDialog();
  const [preview, setPreview] = useState<AudiencePreviewResponse | null>(null);
  const [audience, setAudience] = useState("");
  const [groupSubject, setGroupSubject] = useState("");
  const [groupType, setGroupType] = useState<"status" | "question">("status");
  const [groupPriority, setGroupPriority] = useState<GroupPriority>("normal");
  const [groupDraft, setGroupDraft] = useState("");
  const [groupBusy, setGroupBusy] = useState(false);
  const [groupError, setGroupError] = useState<string | null>(null);
  const [previewNonce, setPreviewNonce] = useState(0);
  const [previewFailed, setPreviewFailed] = useState(false);

  useEffect(() => {
    setSelectedId(null);
    setExpandedChecks({});
    setDraft("");
    setError(null);
  }, [runId]);

  useEffect(() => {
    if (selectedId && conversations.some((conversation) => conversation.id === selectedId)) return;
    const next = conversations.find((conversation) => conversation.pending.length > 0) ?? conversations[0];
    setSelectedId(next?.id ?? null);
  }, [conversations, selectedId]);

  const selected = conversations.find((conversation) => conversation.id === selectedId) ?? null;

  // Refresh the audience preview when Run control opens, when coordination
  // flips, and after every send (worker facts may have changed). Estimates
  // are derived server-side from the same worker facts the rest of the
  // viewer renders; a failed read leaves the composer without options rather
  // than inventing any.
  const isRunControl = selected?.taskId === null;
  useEffect(() => {
    if (!runId || !isRunControl || !coordinatorActive) {
      setPreview(null);
      setPreviewFailed(false);
      return;
    }
    let cancelled = false;
    fetchAudiencePreview(runId)
      .then((next) => {
        if (!cancelled) {
          setPreview(next);
          setPreviewFailed(false);
        }
      })
      .catch(() => {
        // A failed discovery read must look failed, not eternally loading —
        // the composer stays empty rather than pretending audiences exist.
        if (!cancelled) {
          setPreview(null);
          setPreviewFailed(true);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [runId, isRunControl, coordinatorActive, previewNonce]);

  const audienceOptions: DoodleOption[] = useMemo(
    () =>
      (preview?.audiences ?? []).map((option) => ({
        value: option.address,
        label: option.label,
        hint: option.estimatedRecipients.length === 1
          ? t("chat.group.recipientsOne", { n: option.estimatedRecipients.length })
          : t("chat.group.recipientsMany", { n: option.estimatedRecipients.length }),
      })),
    [lang, preview],
  );

  // Keep the selection inside the offered set; default to the broadest group.
  useEffect(() => {
    if (audience && audienceOptions.some((option) => option.value === audience)) return;
    setAudience(audienceOptions[0]?.value ?? "");
  }, [audience, audienceOptions]);

  const selectedAudience = preview?.audiences.find((option) => option.address === audience) ?? null;

  async function sendGroup() {
    const body = groupDraft.trim();
    if (!body || !runId || disabled || groupBusy || !audience) return;
    const estimated = selectedAudience?.estimatedRecipients.length ?? 0;
    // In-app confirmation for every multi-recipient send. Group addresses are
    // multi-recipient by construction; the copy states the enqueue-only
    // guarantee and the estimate caveat verbatim.
    const confirmed = await dialog.confirm({
      title: t("chat.confirm.title"),
      message: estimated === 1
        ? t("chat.confirm.messageOne", { n: estimated, audience })
        : t("chat.confirm.messageMany", { n: estimated, audience }),
      confirmLabel: t("chat.group.sendTo", { audience }),
      cancelLabel: t("dialog.cancel"),
    });
    if (!confirmed) return;
    setGroupBusy(true);
    setGroupError(null);
    try {
      await sendGroupMessage({
        runId,
        audience,
        subject: groupSubject.trim() || undefined,
        body,
        type: groupType,
        priority: groupPriority === "normal" ? null : groupPriority,
      });
      setGroupDraft("");
      setGroupSubject("");
      setPreviewNonce((nonce) => nonce + 1);
      onResolved();
    } catch (err) {
      setGroupError(String((err as Error).message ?? err));
    } finally {
      setGroupBusy(false);
    }
  }

  // Phase 3 history completeness: a saturated global window means rows older
  // than the window may be missing for EVERY Run — including one with only a
  // handful of messages. A failed history read leaves inboxWindow null and
  // renders no claim at all (absence is unknown, not incomplete).
  const historyWarning = snapshot.inboxWindow?.saturated
    ? t("chat.history.warning", {
        observed: snapshot.inboxWindow.observed,
        limit: snapshot.inboxWindow.limit,
      })
    : null;
  const contextById = new Map((selected?.events ?? []).map((event) => [event.id, event]));
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
      t("chat.summary.noUpdate")
    : null;
  const activeDispatch =
    coordinatorActive && selected?.task?.status === "dispatched" && selected.task.dispatchId
      ? selected.task.dispatchId
      : null;
  // Shared by the runtime summary's data-state and its label; extracting keeps
  // the pill's title attribute (full text on hover) from drifting from what's
  // rendered.
  const summaryState = selected?.task
    ? summaryStateKey(selected.task, selected.presence, selected.pending.length > 0)
    : coordinatorActive ? "run-active" : "run-stopped";
  const summaryLabel = selected?.task
    ? stageState(selected.task, selected.presence, selected.pending.length > 0)
    : coordinatorActive ? t("chat.summary.runActive") : t("chat.summary.runStopped");
  const hasRecordedAssignment = Boolean(
    selected?.events.some(
      (event) => event.kind === "dispatch_started" && event.direction === "coordinator_to_agent",
    ),
  );

  function renderTimelineCheck(group: TimelineCheckGroup) {
    const receipt = group.receipts.at(-1)!;
    const firstReceipt = group.receipts[0];
    const checkKey = `check:${selected?.id ?? ""}:${firstReceipt.checkedAt}:${firstReceipt.sequence}`;
    const visibleCount = expandedChecks[checkKey] ?? 0;
    const firstVisible = Math.max(0, group.receipts.length - visibleCount);
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
      ? t("chat.check.detailsMany", { n: group.receipts.length })
      : t("chat.check.detailsOne");
    return (
      <div className="chat-checkpoint-group" key={checkKey}>
        <div
          className={`chat-checkpoint chat-checkpoint--digest${important ? " chat-checkpoint--important" : ""}${receipt.error ? " chat-checkpoint--error" : ""}`}
          aria-label={t("chat.check.listAria")}
        >
          <span className="chat-checkpoint__rail" aria-hidden="true">
            {visibleCount === 0 && <span className="chat-checkpoint__dot" />}
          </span>
          <div className="chat-checkpoint__copy">
            <div className="chat-checkpoint__head">
              <strong>{checkGroupTitle(group.receipts)}</strong>
              <time dateTime={new Date(receipt.checkedAt).toISOString()}>{formatClock(new Date(receipt.checkedAt).toISOString())}</time>
            </div>
            {important && detail && <span className="chat-checkpoint__summary">{detail}</span>}
            <button
              type="button"
              className="chat-checkpoint__toggle"
              aria-expanded={visibleCount > 0}
              aria-controls={visibleCount > 0 ? `${checkKey}-entries` : undefined}
              onClick={() => setExpandedChecks((current) => {
                const next = { ...current };
                if (current[checkKey]) delete next[checkKey];
                else next[checkKey] = 5;
                return next;
              })}
            >
              <span className="chat-checkpoint__chevron" aria-hidden="true">›</span>
              {visibleCount > 0 ? t("chat.check.hide", { label: detailsLabel }) : t("chat.check.expand", { label: detailsLabel })}
            </button>
          </div>
        </div>
        {visibleCount > 0 && <div className="chat-checkpoint__entries" id={`${checkKey}-entries`}>
              {firstVisible > 0 && (
                <button
                  type="button"
                  className="chat-checkpoint__older"
                  onClick={() => setExpandedChecks((current) => ({
                    ...current,
                    [checkKey]: Math.min(group.receipts.length, (current[checkKey] ?? 5) + 5),
                  }))}
                >
                  {t("chat.check.showOlder", { n: Math.min(5, firstVisible), remaining: firstVisible })}
                </button>
              )}
              {group.receipts.slice(firstVisible).map((item, index) => {
                const relevantAgents = selected?.taskId
                  ? item.agents.filter((candidate) => candidate.taskId === selected.taskId)
                  : item.agents;
                const itemIso = new Date(item.checkedAt).toISOString();
                const itemDetail = receiptDetail(item);
                return (
                  <article className={`chat-checkpoint chat-checkpoint--entry${item.error ? " chat-checkpoint--error" : ""}`} key={`${item.checkedAt}:${item.sequence}`} aria-label={t("chat.check.entryAria")}>
                    <span className="chat-checkpoint__rail" aria-hidden="true">
                      <span className="chat-checkpoint__dot" />
                    </span>
                    <div className="chat-checkpoint__copy chat-checkpoint__receipt">
                      <header>
                        <span>{group.receipts.length > 1
                          ? t("chat.check.recordOf", { index: firstVisible + index + 1, total: group.receipts.length })
                          : t("chat.check.record")}</span>
                        <time dateTime={itemIso}>{formatDateTime(itemIso)}</time>
                      </header>
                      {itemDetail && <span className="chat-checkpoint__summary" title={itemDetail}>{itemDetail}</span>}
                      <details className="chat-checkpoint__receipt-details">
                        <summary>{t("chat.check.evidence")}</summary>
                        <dl className="chat-checkpoint__facts">
                          <div>
                            <dt>{t("chat.check.fieldSource")}</dt>
                            <dd>{checkSourceLabel(item)}</dd>
                          </div>
                          <div>
                            <dt>{t("chat.check.fieldInboxResult")}</dt>
                            <dd>{checkInboxResult(item)}</dd>
                          </div>
                          <div>
                            <dt>{t("chat.check.fieldWait")}</dt>
                            <dd>{checkDurationLabel(item)}</dd>
                          </div>
                          <div>
                            <dt>{t("chat.check.fieldDelivery")}</dt>
                            <dd title={checkDeliveryLabel(item)}>{checkDeliveryLabel(item)}</dd>
                          </div>
                          {item.replayed && (
                            <div>
                              <dt>{t("chat.check.fieldReplay")}</dt>
                              <dd>{t("chat.check.replayValue")}</dd>
                            </div>
                          )}
                        </dl>
                        {/* A receipt's messages are evidence behind its digest.
                            Older receipts may have no retained rows. */}
                        {(item.messages?.length ?? 0) > 0 && (
                          <details className="chat-checkpoint__messages">
                            <summary>
                              <span>{item.messages!.length === 1
                                ? t("chat.check.countOne", { n: item.messages!.length })
                                : t("chat.check.countMany", { n: item.messages!.length })}</span>
                              <span className="chat-checkpoint__chevron" aria-hidden="true">›</span>
                            </summary>
                            <ul>
                              {item.messages!.map((message) => {
                                const iso = new Date(message.createdAt).toISOString();
                                return (
                                  <li key={message.id}>
                                    <span className="chat-checkpoint__message-type">
                                      {compactSignal(message.type) ?? message.type}
                                    </span>
                                    <span className="chat-checkpoint__message-subject" title={message.subject}>
                                      {message.subject || t("chat.check.noSubject")}
                                    </span>
                                    <time dateTime={iso}>{formatClock(iso)}</time>
                                  </li>
                                );
                              })}
                            </ul>
                          </details>
                        )}
                        {item.evidence && (
                          <p className="chat-checkpoint__evidence">
                            <strong>{t("chat.check.whyShown")}</strong>
                            <span>{item.evidence}</span>
                          </p>
                        )}
                        <div className="chat-checkpoint__agents">
                          <strong>{t("chat.check.agents")}</strong>
                          {relevantAgents.length > 0 ? relevantAgents.map((candidate) => {
                            const stage = tasks.find((task) => task.id === candidate.taskId);
                            const agentName = candidate.agent === "unknown agent" ? null : candidate.agent;
                            const runtime = [agentName, candidate.model, candidate.effort].filter(Boolean).join(" · ");
                            return (
                              <div className="chat-checkpoint__agent" key={`${item.sequence}:${candidate.taskId}`}>
                                <span>{stage?.label ?? candidate.taskId}</span>
                                <small>{runtime || t("chat.check.runtimeNotRecorded")}</small>
                                <p>{checkAgentLine(candidate)}</p>
                              </div>
                            );
                          }) : (
                            <p className="chat-checkpoint__empty">{t("chat.check.noAgentState")}</p>
                          )}
                        </div>
                      </details>
                    </div>
                  </article>
                );
              })}
        </div>}
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
    return <div className="chat__empty">{t("chat.empty.pickRun")}</div>;
  }

  if (conversations.length === 0) {
    return (
      <div className="chat__empty">
        {historyWarning && (
          <div className="chat-history-warning" role="status">
            <strong>{t("chat.history.incomplete")}</strong>
            <span>{historyWarning}</span>
          </div>
        )}
        {t("chat.empty.noConversations")}
      </div>
    );
  }

  return (
    <section className="chat" aria-label={t("chat.aria.section")}>
      <nav className="chat__threads" aria-label={t("chat.aria.threadList")}>
        <div className="chat__threads-title">
          <span>{t("chat.threads.title")}</span>
          <span>{conversations.length}</span>
        </div>
        <div className="chat__thread-list">
          {conversations.map((conversation, index) => {
            const latest = conversation.events.at(-1);
            const isSystem = conversation.id === COORDINATOR_THREAD;
            // Same state bucket the runtime-summary pulse uses, so the list,
            // the conversation body, and the DAG canvas all tell one story.
            // Only the Run-control thread carries run-level state; a taskless
            // agent thread (dangling Task) simply shows no state.
            const threadState = isSystem
              ? coordinatorActive ? "run-active" : "run-stopped"
              : conversation.task
                ? summaryStateKey(conversation.task, conversation.presence, conversation.pending.length > 0)
                : null;
            const initials = conversation.taskId && !conversation.isLead ? initialsOf(conversation.label) : null;
            return (
              <Fragment key={conversation.id}>
                {index > 0 && conversations[index - 1]?.id === COORDINATOR_THREAD && (
                  <div className="chat-thread__section">{t("chat.threads.agentsSection")}</div>
                )}
                <button
                  type="button"
                  className={`chat-thread${isSystem ? " chat-thread--system" : ""}${selected?.id === conversation.id ? " chat-thread--active" : ""}`}
                  data-state={threadState}
                  aria-current={selected?.id === conversation.id ? "true" : undefined}
                  onClick={() => {
                    setSelectedId(conversation.id);
                    setDraft("");
                    setError(null);
                  }}
                >
                  <span
                    className={`chat-thread__avatar${conversation.isLead ? " chat-thread__avatar--lead" : ""}${isSystem ? " chat-thread__avatar--system" : ""}${initials && initials.length > 1 ? " chat-thread__avatar--pair" : ""}`}
                    aria-hidden="true"
                  >
                    {conversation.taskId ? (conversation.isLead ? "★" : initials!) : "R"}
                  </span>
                  <span className="chat-thread__copy">
                    <span className="chat-thread__topline">
                      <strong>{conversation.label}</strong>
                      {isSystem && <span className="chat-thread__system-label">{t("chat.thread.system")}</span>}
                      {conversation.unread && (
                        <span
                          className="chat-thread__unread"
                          role="img"
                          aria-label={t("chat.thread.unreadAria")}
                          title={t("chat.thread.unreadAria")}
                        />
                      )}
                      <time dateTime={conversation.latestAt}>{formatClock(conversation.latestAt)}</time>
                    </span>
                    <span className="chat-thread__preview">
                      {latest
                        ? messageBody(latest)
                        : compactSignal(conversation.presence?.detail) ??
                          compactSignal(conversation.presence?.activity) ??
                          (conversation.task ? t("chat.thread.previewAssigned") : t("chat.thread.noMessages"))}
                    </span>
                  </span>
                  {conversation.urgent && (
                    <span className="chat-thread__urgent" aria-label={t("chat.thread.urgentAria")} title={t("chat.thread.urgentAria")}>
                      !
                    </span>
                  )}
                  {conversation.pending.length > 0 && (
                    <span className="chat-thread__badge" aria-label={t("chat.thread.repliesNeeded", { n: conversation.pending.length })}>
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
                  {selected.isLead && <span>{t("chat.leadStage")}</span>}
                  {!selected.taskId && <span className="chat__conversation-system">{t("chat.thread.system")}</span>}
                </div>
                <p>{selected.subtitle || (selected.taskId ? selected.taskId : t("chat.systemSubtitle"))}</p>
              </div>
              {selected.taskId && (
                <button type="button" onClick={() => onSelectTask(selected.taskId!)}>
                  {t("chat.openStage")}
                </button>
              )}
            </header>

            <div className="chat__messages" aria-live="polite">
              {historyWarning && (
                <div className="chat-history-warning" role="status">
                  <strong aria-hidden="true">⚠</strong>
                  <span>
                    <strong>{t("chat.history.incomplete")}</strong> {historyWarning}
                  </span>
                </div>
              )}
              {selected.task && !hasRecordedAssignment && (
                <article className="chat-message chat-message--outgoing chat-message--brief">
                  <div className="chat-message__meta">
                    <strong>{t("chat.actor.coordinator")}</strong>
                    <time dateTime={selected.task.createdAt}>{formatDateTime(selected.task.createdAt)}</time>
                  </div>
                  <h3>{t("chat.heading.assignedStage")}</h3>
                  <small>{t("chat.brief.recovered")}</small>
                  <p>{briefSummary(selected.task.spec)}</p>
                  {selected.task.spec.trim() && selected.task.spec.trim() !== briefSummary(selected.task.spec) && (
                    <details className="chat-message__details">
                      <summary>{t("chat.brief.full")}</summary>
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
                // Phase 6: an audience turns the bubble into a distinct group
                // send — different border treatment, an audience chip, the
                // requested priority, and the enqueue-only provenance note.
                const groupChip = event.audience ? groupPriorityChip(event) : null;
                const priorityChip = isUrgent(event) ? priorityLabel(event) : groupChip;
                return system ? (
                  <div key={event.id} className={`chat-message chat-message--system chat-message--${event.severity}`}>
                    <span>{event.title}</span>
                    <p>{messageBody(event)}</p>
                    <time dateTime={event.createdAt}>{formatDateTime(event.createdAt)}</time>
                  </div>
                ) : (
                  <article
                    key={event.id}
                    className={`chat-message ${outgoing ? "chat-message--outgoing" : "chat-message--incoming"} chat-message--${event.kind} chat-message--${event.severity}${isUrgent(event) ? " chat-message--urgent" : ""}${event.audience ? " chat-message--group" : ""}`}
                  >
                    <div className="chat-message__meta">
                      <strong>{eventActor(event)}</strong>
                      {/* Provenance stays visible: a locally journaled row is
                          this viewer's own record, superseded by the
                          authoritative Orca message once it lands. */}
                      {event.technical.provenance === "viewer_journal" && (
                        <span className="chat-message__provenance" title={t("chat.message.provenanceTitle")}>
                          {t("chat.message.provenance")}
                        </span>
                      )}
                      {event.audience && (
                        <span
                          className="chat-message__audience"
                          title={t("chat.message.audienceTitle")}
                        >
                          {t("chat.message.audienceTo", { audience: event.audience })}
                        </span>
                      )}
                      {priorityChip && (
                        <span className="chat-message__priority" title={t("priority.orcaTitle", { priority: event.priority ?? "" })}>
                          {priorityChip}
                        </span>
                      )}
                      {/* Tri-state read evidence: only an explicit unread
                          marker renders "Unread" — an absent marker stays
                          unknown and renders nothing at all. */}
                      {event.read === false && (
                        <span
                          className="chat-message__read"
                          title={t("chat.message.unreadTitle")}
                        >
                          {t("chat.message.unread")}
                        </span>
                      )}
                      <time dateTime={event.createdAt}>{formatDateTime(event.createdAt)}</time>
                    </div>
                    {(() => {
                      const parent = replyContextOf(event, contextById);
                      return parent ? (
                        <div className="chat-message__reply-context" title={t("chat.message.replyContextTitle", { title: parent.title })}>
                          <span aria-hidden="true">↩</span> {t("chat.message.replyContext", { title: parent.title, summary: parent.summary })}
                        </div>
                      ) : null;
                    })()}
                    <h3>{event.audience ? event.title : eventHeading(event)}</h3>
                    <p>{messageBody(event)}</p>
                    {event.audience && (
                      <small
                        className="chat-message__enqueue"
                        title={t("chat.message.enqueuedTitle")}
                      >
                        {t("chat.message.enqueued")}
                      </small>
                    )}
                    {event.groupedCount > 1 && <small>{t("chat.message.grouped", { n: event.groupedCount })}</small>}
                    {event.actionable?.kind === "reply" && <span className="chat-message__waiting">{t("chat.state.waitingReply")}</span>}
                    {event.detail?.trim() && event.detail.trim() !== event.summary.trim() && (
                      <details className="chat-message__details">
                        <summary>{event.kind === "dispatch_started" ? t("chat.brief.full") : t("chat.report.full")}</summary>
                        <p>{event.detail}</p>
                      </details>
                    )}
                  </article>
                );
              })}

              <section
                className="chat-runtime-summary"
                data-state={summaryState}
                aria-label={t("chat.summary.aria")}
              >
                <span className="chat-runtime-summary__pulse" aria-hidden="true" />
                <strong title={summaryLabel}>{summaryLabel}</strong>
                <span className="chat-runtime-summary__detail">
                  {selected.task
                    ? presenceSummary
                    : coordinatorActive ? t("chat.summary.scheduling") : t("chat.summary.runLevelOnly")}
                </span>
                <span className="chat-runtime-summary__meta">
                  {lastCheck
                    ? t("chat.summary.lastCheck", { time: formatClock(new Date(lastCheck.checkedAt).toISOString()) })
                    : t("chat.summary.noChecks")}
                  {selectedChecks.length > 0 && t("chat.summary.totalChecks", { n: selectedChecks.length })}
                </span>
              </section>
            </div>

            <footer className="chat__composer">
              {error && <div className="chat__error" role="status">⚠ {error}</div>}
              {groupError && <div className="chat__error" role="status">⚠ {groupError}</div>}
              {isRunControl && coordinatorActive && !disabled && (
                <div className="chat__group-composer">
                  <div className="chat__group-controls">
                    <label className="chat__group-field">
                      <span>{t("chat.group.audience")}</span>
                      <DoodleSelect
                        value={audience}
                        onChange={setAudience}
                        options={audienceOptions}
                        size="sm"
                        placeholder={preview ? t("chat.group.selectAudience") : t("chat.group.audiencesUnavailable")}
                        loading={!preview && !previewFailed}
                        emptyText={previewFailed ? t("chat.group.discoveryFailed") : t("chat.group.noneDiscovered")}
                        title={t("chat.group.audienceTitle")}
                      />
                    </label>
                    <label className="chat__group-field">
                      <span>{t("chat.group.type")}</span>
                      <DoodleSelect
                        value={groupType}
                        onChange={(value) => setGroupType(value === "question" ? "question" : "status")}
                        options={[
                          { value: "status", label: t("chat.group.typeStatus") },
                          { value: "question", label: t("chat.group.typeQuestion") },
                        ]}
                        size="sm"
                        title={t("chat.group.typeTitle")}
                      />
                    </label>
                    <label className="chat__group-field">
                      <span>{t("chat.group.priority")}</span>
                      <DoodleSelect
                        value={groupPriority}
                        onChange={(value) =>
                          setGroupPriority(
                            (GROUP_PRIORITIES as readonly string[]).includes(value)
                              ? (value as GroupPriority)
                              : "normal",
                          )
                        }
                        options={GROUP_PRIORITIES.map((priority) => ({
                          value: priority,
                          // Same mapping the priority chips use, so the dropdown
                          // and a sent bubble can never disagree about a level.
                          label: priorityLabel({ priority }),
                        }))}
                        size="sm"
                      />
                    </label>
                  </div>
                  {selectedAudience && (
                    <p className="chat__group-estimate">
                      <strong>{t("chat.group.estimated", { n: selectedAudience.estimatedRecipients.length })}</strong>{" "}
                      {selectedAudience.estimatedRecipients.length === 0
                        ? t("chat.group.estimatedNone")
                        : selectedAudience.estimatedRecipients
                            .slice(0, 6)
                            .map((candidate) => tasks.find((task) => task.id === candidate.taskId)?.label ?? candidate.taskId)
                            .join(", ") + (selectedAudience.estimatedRecipients.length > 6
                              ? t("chat.group.estimatedMore", { n: selectedAudience.estimatedRecipients.length - 6 })
                              : "")}
                      {t("chat.group.estimatedTail")}
                    </p>
                  )}
                  <input
                    className="chat__group-subject"
                    value={groupSubject}
                    disabled={groupBusy}
                    placeholder={t("chat.group.subjectPlaceholder")}
                    aria-label={t("chat.group.subjectAria")}
                    onChange={(event) => setGroupSubject(event.target.value)}
                  />
                  <div className="chat__compose-row">
                    <textarea
                      rows={2}
                      value={groupDraft}
                      disabled={groupBusy}
                      placeholder={t("chat.group.messagePlaceholder", { audience: audience || t("chat.group.theGroup") })}
                      aria-label={t("chat.group.sendAria", { audience: audience || t("chat.group.selectedAudience") })}
                      onChange={(event) => setGroupDraft(event.target.value)}
                      onKeyDown={(event) => {
                        if ((event.metaKey || event.ctrlKey) && event.key === "Enter") void sendGroup();
                      }}
                    />
                    <button
                      type="button"
                      className="btn btn--ok"
                      disabled={groupBusy || !groupDraft.trim() || !audience}
                      title={t("chat.group.sendTitle", { audience: audience || t("chat.group.anAudience") })}
                      onClick={() => void sendGroup()}
                    >
                      {groupBusy ? t("chat.compose.sending") : audience ? t("chat.group.sendTo", { audience }) : t("chat.compose.send")}
                    </button>
                  </div>
                  <p className="chat__group-note">{t("chat.group.note")}</p>
                </div>
              )}
              {replyTarget || activeDispatch ? (
                <div className="chat__compose-row">
                  <textarea
                    rows={2}
                    value={draft}
                    disabled={disabled || busy}
                    placeholder={
                      disabled
                        ? t("chat.compose.executionUnavailable")
                        : replyTarget
                          ? t("chat.compose.replyTo", { label: selected.label })
                          : t("chat.compose.guidanceTo", { label: selected.label })
                    }
                    aria-label={replyTarget
                      ? t("chat.compose.replyTo", { label: selected.label })
                      : t("chat.compose.guidanceTo", { label: selected.label })}
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
                        ? disabledReason ?? t("chat.compose.executionIsUnavailable")
                        : replyTarget ? t("chat.compose.sendReplyTitle") : t("chat.compose.sendGuidanceTitle")
                    }
                    onClick={() => void sendMessage()}
                  >
                    {busy ? t("chat.compose.sending") : t("chat.compose.send")}
                  </button>
                </div>
              ) : (
                <p className="chat__composer-idle">
                  {selected.task
                    ? selected.task.status === "dispatched" && !coordinatorActive
                      ? t("chat.compose.idleStartCoordinator")
                      : t("chat.compose.idleNoDispatch")
                    : t("chat.compose.idlePickStage")}
                </p>
              )}
            </footer>
          </>
        )}
      </div>
    </section>
  );
});
