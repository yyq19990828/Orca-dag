import { memo, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { acknowledgeStopEvent, ApiError, decideWorkerPermission, releaseWorker, replyToMessage, retainWorker, sendTaskMessage } from "../api";
import { formatClock, formatDateTime, isUrgent, priorityLabel } from "../format";
import { t, useLang, useT } from "../i18n";
import { useDecisionDialog } from "./DecisionDialog";
import { useCoordinatorControl } from "./useCoordinatorControl";
import { DoodleSelect, type DoodleOption } from "./DoodleSelect";
import { useScopedChatState } from "./useScopedChatState";
import type {
  ActivityEvent,
  ActivitySnapshot,
  DagNode,
  StagePresence,
  TaskMessageReceipt,
} from "../types";
import { ToggleGroup, Popover, Tabs } from "radix-ui";
import { HarnessAvatar } from "./HarnessAvatar";
import { MailboxChecks } from "./MailboxChecks";

/** Keep keyboard submission and its visible hint identical for both scopes. */
function MessageComposer({
  value, onChange, onSend, disabled, sendDisabled, busy, label, placeholder, sendLabel, sendTitle,
}: {
  value: string;
  onChange: (value: string) => void;
  onSend: () => Promise<void>;
  disabled: boolean;
  sendDisabled: boolean;
  busy: boolean;
  label: string;
  placeholder: string;
  sendLabel: string;
  sendTitle: string;
}) {
  const t = useT();
  const hintId = useId();
  return (
    <form
      className="chat__compose-row"
      onSubmit={(event) => {
        event.preventDefault();
        if (!sendDisabled) void onSend();
      }}
    >
      <textarea
        rows={2}
        value={value}
        disabled={disabled}
        placeholder={placeholder}
        aria-label={label}
        aria-describedby={hintId}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          // Enter used to confirm an IME candidate must never enqueue mail.
          if (event.nativeEvent.isComposing || event.keyCode === 229 || event.repeat) return;
          if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
            event.preventDefault();
            if (!sendDisabled) void onSend();
          }
        }}
      />
      <div className="chat__compose-toolbar">
        <span id={hintId}>{t("chat.compose.shortcut")}</span>
        <button
          type="submit"
          className="btn btn--run"
          disabled={sendDisabled}
          aria-busy={busy}
          title={sendTitle}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 19V5m-7 7 7-7 7 7" /></svg>
          {busy ? t("chat.compose.sending") : sendLabel}
        </button>
      </div>
    </form>
  );
}

const COORDINATOR_THREAD = "__run_coordinator__";

interface Conversation {
  id: string;
  taskId: string | null;
  label: string;
  subtitle: string | null;
  harness: string | null;
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


function messageBody(event: ActivityEvent): string {
  return event.summary;
}


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
    case "stop_event": return t("chat.heading.stopEvent");
    case "reply": return t("chat.heading.reply");
    case "heartbeat": return t("chat.heading.working");
    default: return event.title;
  }
}

function eventActor(event: ActivityEvent, task: DagNode | undefined): string {
  if (event.direction === "coordinator_to_agent") return t("chat.actor.coordinator");
  // A harness identifies the tool, not which Task is speaking. Keep the
  // message's exact Task identity even after its DAG row ages out of history.
  if (event.taskId) return task?.label || event.actor.label || event.taskId;
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


function briefSummary(spec: string): string {
  const normalized = spec.replace(/\s+/g, " ").trim();
  if (!normalized) return t("chat.brief.empty");
  const sentence = normalized.match(/^.*?[.!?](?:\s|$)/)?.[0]?.trim() ?? normalized;
  return sentence.length > 220 ? `${sentence.slice(0, 217).trimEnd()}...` : sentence;
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
  taskSelection,
  groupSelection = null,
  renderSession,
  renderTask,
  renderConfig,
  onCloseInspector,
  leadTaskId,
  onSelectTask,
  onSelectWorker,
  onResolved,
  coordinatorActive,
  active = true,
  disabled = false,
  disabledReason,
  embeddedMessagesOnly = false,
}: {
  runId: string;
  snapshot: ActivitySnapshot;
  tasks: DagNode[];
  /** Each new object is an explicit navigation request, even for the same node. */
  taskSelection: { taskId: string } | null;
  /** Explicit navigation into the Run Group Chat thread from the IDE Inspector. */
  groupSelection?: { nonce: number } | null;
  renderSession?: (task: DagNode, sessionActive: boolean) => ReactNode;
  renderTask: (task: DagNode) => ReactNode;
  renderConfig?: (task: DagNode) => ReactNode;
  onCloseInspector?: () => void;
  leadTaskId: string | null;
  onSelectTask: (taskId: string | null) => void;
  onSelectWorker: (dispatchId: string) => void;
  onResolved: () => void;
  coordinatorActive: boolean;
  active?: boolean;
  disabled?: boolean;
  disabledReason?: string | null;
  /** Render only the selected task's message timeline & composer (used by the compact Orca sidebar). */
  embeddedMessagesOnly?: boolean;
}) {
  // Priority chips and message timestamps come from the shared formatters in
  // format.ts, which read the language non-reactively (no hooks there by
  // design) — so this memo()'d panel subscribes itself and re-renders its
  // whole timeline when the UI language changes. `lang` also feeds the memos
  // below: they build translated fallbacks (including the Run group label),
  // and a memo keyed only on data would keep the pre-switch wording.
  const t = useT();
  const lang = useLang();
  const taskMap = useMemo(() => new Map(tasks.map((task) => [task.id, task])), [tasks]);
  const conversations = useMemo(() => {
    const grouped = new Map<string, ActivityEvent[]>();
    const presenceMap = new Map(snapshot.presence.map((presence) => [presence.taskId, presence]));
    // A worker-start sends the Task spec as the worker's initial brief, but
    // Orca's coordinator mailbox only retains worker-to-coordinator messages.
    // Seed each Task thread from the DAG so that this real outbound half of
    // the exchange remains visible without pretending it was a mailbox row.
    // Group and private views project the very same retained events. No
    // second transcript, synthetic delivery, or separate room transport.
    grouped.set(COORDINATOR_THREAD, snapshot.events);
    for (const task of tasks) grouped.set(task.id, []);
    for (const event of snapshot.events) {
      if (!event.taskId) continue;
      const id = event.taskId;
      const current = grouped.get(id) ?? [];
      current.push(event);
      grouped.set(id, current);
    }
    // A missing/loading node must keep its requested identity instead of
    // falling through to another conversation with a different recipient.
    if (taskSelection && !grouped.has(taskSelection.taskId)) grouped.set(taskSelection.taskId, []);

    return [...grouped.entries()]
      .map(([id, events]): Conversation => {
        const sorted = [...events].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
        const workerEvent = id === COORDINATOR_THREAD ? undefined : [...sorted]
          .reverse()
          .find((event) => event.actor.role === "worker" || event.actor.role === "lead");
        const taskId = id === COORDINATOR_THREAD ? null : id;
        const task = taskId ? taskMap.get(taskId) ?? null : null;
        const presence = taskId ? presenceMap.get(taskId) ?? null : null;
        const dispatchId = presence?.dispatchId ?? task?.dispatchId ?? workerEvent?.dispatchId;
        let harness = presence?.agent ?? null;
        // Settlement rows can omit the brand. Recover it only from the same
        // Dispatch's worker evidence, never a previous attempt or saved plan.
        for (let index = sorted.length - 1; !harness && index >= 0; index--) {
          const event = sorted[index];
          if (event.dispatchId === dispatchId && (event.actor.role === "worker" || event.actor.role === "lead")) {
            harness = event.actor.harness;
          }
        }
        const model = presence?.model ?? workerEvent?.actor.model ?? null;
        const effort = presence?.effort ?? null;
        return {
          id,
          taskId,
          label: taskId
            ? workerEvent?.actor.label || task?.label || t("chat.thread.stageFallback", { id: taskId })
            : t("chat.group.conversation"),
          subtitle: [harness, model, effort].filter(Boolean).join(" · ") || null,
          harness,
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
      .sort((a, b) => b.latestAt.localeCompare(a.latestAt));
  }, [lang, leadTaskId, snapshot.events, snapshot.presence, taskMap, tasks, taskSelection?.taskId]);

  const [chatView, setChatView] = useScopedChatState<"private" | "group">(runId, "private");
  const [privateSelectedId, setPrivateSelectedId] = useScopedChatState<string | null>(runId, null);
  const [groupSelectedId, setGroupSelectedId] = useScopedChatState<string | null>(runId, null);
  const selectedId = chatView === "private" ? privateSelectedId : groupSelectedId;
  const setSelectedId = chatView === "private" ? setPrivateSelectedId : setGroupSelectedId;
  const [groupTargetId, setGroupTargetId] = useScopedChatState(runId, "");
  const [mobileConversationOpen, setMobileConversationOpen] = useScopedChatState(runId, false);
  const [threadView, setThreadView] = useScopedChatState<"messages" | "session" | "task" | "config" | "checks">(runId, "messages");
  const chatContainerRef = useRef<HTMLDivElement>(null);
  const sidebarRef = useRef<HTMLElement>(null);
  const conversationHeadingRef = useRef<HTMLHeadingElement>(null);
  const taskTabRef = useRef<HTMLButtonElement>(null);
  const returnToListFocus = useRef(false);
  const [compact, setCompact] = useState(false);
  useLayoutEffect(() => {
    const container = chatContainerRef.current;
    if (!container) return;
    const update = () => setCompact(container.clientWidth <= 640);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(container);
    return () => observer.disconnect();
  }, [Boolean(runId)]);
  useLayoutEffect(() => {
    if (!active || !taskSelection) return;
    setPrivateSelectedId(taskSelection.taskId);
    setChatView("private");
    setThreadView("messages");
    setMobileConversationOpen(true);
    const frame = window.requestAnimationFrame(() => conversationHeadingRef.current?.focus({ preventScroll: true }));
    return () => window.cancelAnimationFrame(frame);
  }, [active, taskSelection, setPrivateSelectedId, setChatView, setThreadView, setMobileConversationOpen]);
  useLayoutEffect(() => {
    if (!active || !groupSelection) return;
    setGroupSelectedId(COORDINATOR_THREAD);
    setChatView("group");
    setThreadView("messages");
    setMobileConversationOpen(true);
  }, [active, groupSelection, setGroupSelectedId, setChatView, setThreadView, setMobileConversationOpen]);
  const selected = conversations.find((conversation) => conversation.id === selectedId) ?? null;
  const effectiveThreadView = embeddedMessagesOnly
    ? "messages"
    : selected?.taskId && threadView === "checks"
      ? "messages"
      : !selected?.taskId && (threadView === "session" || threadView === "task" || threadView === "config")
        ? "messages"
        : threadView;
  const timelineActive = active && (embeddedMessagesOnly || !compact || mobileConversationOpen) && effectiveThreadView === "messages";
  const sessionActive = active && !embeddedMessagesOnly && (!compact || mobileConversationOpen) && effectiveThreadView === "session";
  const [threadQuery, setThreadQuery] = useScopedChatState(runId, "");
  const query = threadQuery.trim().toLocaleLowerCase();
  const filteredConversations = conversations.filter((conversation) =>
    chatView === "group" ? conversation.taskId === null
      : conversation.taskId !== null && (!query || [conversation.label, conversation.taskId, conversation.subtitle]
        .some((value) => value?.toLocaleLowerCase().includes(query))));
  // Never infer an @recipient from the latest speaker or the last private
  // conversation. Missing/stale selections remain unsendable, not redirected.
  const composeTarget = chatView === "group"
    ? conversations.find((conversation) => conversation.taskId === groupTargetId) ?? null
    : selected;
  const replyTarget = composeTarget?.pending.at(-1) ?? null;
  const composeScope = JSON.stringify([runId, composeTarget?.id ?? null]);
  const recipientOptions: DoodleOption[] = useMemo(() => conversations
    .filter((conversation) => conversation.taskId !== null)
    .map((conversation) => ({
      value: conversation.id,
      label: `@${conversation.label}`,
      hint: `${conversation.id} · ${conversation.task
        ? stageState(conversation.task, conversation.presence, conversation.pending.length > 0)
        : t("chat.thread.stateUnavailable")}${!conversation.pending.length && !coordinatorActive && conversation.task?.status === "dispatched"
        ? ` · ${t("chat.compose.idleStartCoordinator")}` : ""}`,
      disabled: !conversation.pending.length &&
        !(coordinatorActive && conversation.task?.status === "dispatched" && conversation.task.dispatchId),
    })), [conversations, coordinatorActive, lang]);
  const conversationScope = JSON.stringify([runId, selected?.id ?? null]);
  // Mount Task controls on first use, then retain their drafts, disclosures
  // and in-flight receipts while switching sibling tabs in this conversation.
  const [taskVisited, setTaskVisited] = useScopedChatState(conversationScope, false);
  const [sessionVisited, setSessionVisited] = useScopedChatState(`${conversationScope}:session`, false);
  const [configVisited, setConfigVisited] = useScopedChatState(`${conversationScope}:config`, false);
  useEffect(() => {
    const activeTab = chatContainerRef.current?.querySelector<HTMLElement>(
      '.chat__view-tabs [role="tab"][aria-selected="true"]',
    );
    activeTab?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [effectiveThreadView]);
  useLayoutEffect(() => {
    if (!active || !compact) return;
    if (mobileConversationOpen) conversationHeadingRef.current?.focus({ preventScroll: true });
    else if (returnToListFocus.current) {
      const sidebar = sidebarRef.current;
      (sidebar?.querySelector<HTMLButtonElement>('.chat__thread[aria-pressed="true"]')
        ?? sidebar?.querySelector<HTMLInputElement>("input"))?.focus({ preventScroll: true });
      returnToListFocus.current = false;
    }
  }, [active, compact, mobileConversationOpen, conversationScope]);

  function openConversation(id: string) {
    if (chatView === "private") {
      onSelectTask(id);
      return;
    }
    setSelectedId(id);
    setThreadView("messages");
    setMobileConversationOpen(true);
  }

  function openTaskDetails() {
    if (!selected?.taskId) return;
    setTaskVisited(true);
    setThreadView("task");
  }

  function backToConversations() {
    returnToListFocus.current = true;
    setMobileConversationOpen(false);
    setThreadView("messages");
  }

  // A new question or Dispatch is a new recipient. Retain the earlier draft
  // separately instead of silently forwarding it to the replacement worker.
  const draftScope = JSON.stringify([runId, chatView, composeTarget?.id ?? null,
    replyTarget?.actionable?.targetId ?? composeTarget?.task?.dispatchId ?? null]);
  const [draft, setDraft] = useScopedChatState(draftScope, "");
  // Busy/uncertain delivery is shared across both views of the same Task;
  // switching to private chat cannot bypass an in-flight or unknown send.
  const [busy, setBusy] = useScopedChatState(composeScope, false);
  const [error, setError] = useScopedChatState<string | null>(composeScope, null);
  const [messageReceipt, setMessageReceipt] = useScopedChatState<TaskMessageReceipt | null>(composeScope, null);
  const [operatorReceipt, setOperatorReceipt] = useScopedChatState<{ runId: string; value: string } | null>(composeScope, null);
  const [actionBusy, setActionBusy] = useScopedChatState(conversationScope, false);
  const [actionError, setActionError] = useScopedChatState<string | null>(conversationScope, null);
  const [uncertainMessages, setUncertainMessages] = useScopedChatState<Record<string, boolean>>(runId, {});
  const [timelineLimit, setTimelineLimit] = useScopedChatState(conversationScope, 100);
  const messagesRef = useRef<HTMLDivElement>(null);
  const messageContentRef = useRef<HTMLDivElement>(null);
  const scrollByConversation = useRef(new Map<string, { top: number; follow: boolean }>());
  const [awayFromLatest, setAwayFromLatest] = useState(false);
  useLayoutEffect(() => {
    const element = messagesRef.current;
    const content = messageContentRef.current;
    if (!timelineActive || !element || !content) return;
    const saved = scrollByConversation.current.get(conversationScope);
    element.scrollTop = saved?.follow === false ? saved.top : element.scrollHeight;
    const update = () => {
      // Reading history is a local viewport choice, not an Orca read receipt.
      // Only follow growth when the operator was already at the end.
      if (scrollByConversation.current.get(conversationScope)?.follow !== false) {
        element.scrollTop = element.scrollHeight;
      }
      setAwayFromLatest(element.scrollHeight - element.clientHeight - element.scrollTop > 48);
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(content);
    observer.observe(element);
    return () => observer.disconnect();
  }, [timelineActive, conversationScope, Boolean(selected)]);

  function jumpToLatest() {
    const element = messagesRef.current;
    if (!element) return;
    scrollByConversation.current.set(conversationScope, { top: element.scrollHeight, follow: true });
    element.scrollTop = element.scrollHeight;
    setAwayFromLatest(false);
    element.focus({ preventScroll: true });
  }

  const dialog = useDecisionDialog();
  const withControl = useCoordinatorControl();


  useEffect(() => {
    // The layout effect above owns explicit navigation. A passive fallback
    // from the previous render must not overwrite it when its placeholder
    // conversation disappears (missing Task A -> real Task B).
    if (active && taskSelection) return;
    const inView = conversations.filter((conversation) =>
      (chatView === "group") === (conversation.taskId === null));
    if (selectedId && inView.some((conversation) => conversation.id === selectedId)) return;
    // Group is a list too: choosing the tab must not open or address a
    // conversation. Keep its selection separate from the last private Task.
    const next = chatView === "private"
      ? inView.find((conversation) => conversation.pending.length > 0) ?? inView[0]
      : null;
    if (selectedId !== (next?.id ?? null)) setSelectedId(next?.id ?? null);
  }, [active, taskSelection, chatView, conversations, selectedId, setSelectedId]);



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
  const progressEvent = selected
    ? [...selected.events].reverse().find(isAgentProgressSignal) ?? null
    : null;
  const outcomeEvent = selected
    ? [...selected.events].reverse().find((event) => event.kind === "worker_done") ?? null
    : null;
  // Real mailbox status messages are chat content. Synthetic progress and
  // heartbeats remain in the runtime summary, not repeated chat bubbles.
  const visibleEvents = selected?.events.filter((event) => !isAgentProgressSignal(event) ||
    (event.kind === "status" && event.technical.provenance === "orca_message")) ?? [];
  // Keep unresolved actions visible even when their message predates the
  // reading window. Older history remains available explicitly, not mounted
  // forever in every hidden conversation.
  const timelineStart = Math.max(0, visibleEvents.length - timelineLimit);
  const visibleTimeline = visibleEvents.filter((event, index) =>
    index >= timelineStart || Boolean(event.actionable));
  useLayoutEffect(() => {
    const element = messagesRef.current;
    if (!timelineActive || !element) return;
    // A bounded timeline can replace its oldest row without changing height.
    // Follow before browser scroll anchoring runs; ResizeObserver alone would
    // miss that update and mistake the resulting offset for a user scroll.
    if (scrollByConversation.current.get(conversationScope)?.follow !== false) {
      element.scrollTop = element.scrollHeight;
    }
    setAwayFromLatest(element.scrollHeight - element.clientHeight - element.scrollTop > 48);
  }, [timelineActive, conversationScope, selected?.events, timelineLimit]);

  const presenceSummary = selected?.task
    ? selected.pending.at(-1)?.summary ??
      outcomeEvent?.summary ??
      progressEvent?.summary ??
      compactSignal(selected.presence?.detail) ??
      compactSignal(selected.presence?.activity) ??
      t("chat.summary.noUpdate")
    : null;
  const activeDispatch =
    coordinatorActive && composeTarget?.task?.status === "dispatched" && composeTarget.task.dispatchId
      ? composeTarget.task.dispatchId
      : null;
  const uncertainKey = composeTarget?.taskId ? `${runId}:${composeTarget.taskId}` : null;
  const messageUncertain = uncertainKey !== null && Boolean(uncertainMessages[uncertainKey]);
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


  async function decidePrompt(event: ActivityEvent, decision: "approve" | "deny") {
    if (!event.dispatchId || !event.permissionPrompt || disabled || busy || actionBusy) return;
    const reason = await dialog.prompt({
      title: decision === "approve" ? t("permission.allowOnce") : t("permission.deny"),
      message: `${t("permission.badge")}: ${event.permissionPrompt.id}`,
      fieldLabel: t("permission.reasonPlaceholder"),
      initialValue: decision === "approve" ? t("permission.approveDefaultReason") : "",
      required: true,
      confirmLabel: decision === "approve" ? t("permission.allowOnce") : t("permission.deny"),
    });
    if (!reason?.trim()) return;
    setActionBusy(true);
    setActionError(null);
    try {
      const receipt = await withControl(runId, (control) =>
        decideWorkerPermission(runId, event.dispatchId!, event.permissionPrompt!.id, decision, reason.trim(), control),
      );
      setOperatorReceipt({ runId, value: JSON.stringify(receipt) });
      onResolved();
    } catch (error) {
      setActionError(String((error as Error).message ?? error));
    } finally {
      setActionBusy(false);
    }
  }

  async function acknowledge(event: ActivityEvent) {
    if (!event.dispatchId || disabled || busy || actionBusy) return;
    const confirmed = await dialog.confirm({
      title: t("inbox.ackStopTitle"),
      message: t("inbox.ackStopMessage", { dispatch: event.dispatchId, reason: String((event.technical.payload as { stopReason?: unknown } | undefined)?.stopReason ?? t("worker.unknown")) }),
      confirmLabel: t("inbox.ackStop"),
    });
    if (!confirmed) return;
    setActionBusy(true);
    setActionError(null);
    try {
      await acknowledgeStopEvent(runId, event.id, event.dispatchId);
      onResolved();
    } catch (error) {
      setActionError(String((error as Error).message ?? error));
    } finally { setActionBusy(false); }
  }

  async function decideCleanup(event: ActivityEvent, action: "release" | "retain") {
    const targetId = event.actionable?.targetId;
    if (!targetId || disabled || busy || actionBusy) return;
    setActionBusy(true);
    setActionError(null);
    try {
      const receipt = action === "release"
        ? await releaseWorker(runId, targetId)
        : await retainWorker(runId, targetId);
      setOperatorReceipt({ runId, value: JSON.stringify(receipt) });
      onResolved();
    } catch (error) {
      setActionError(String((error as Error).message ?? error));
    } finally {
      setActionBusy(false);
    }
  }

  function renderCleanupActions(event: ActivityEvent) {
    if (event.actionable?.kind !== "release" && event.actionable?.kind !== "retain") return null;
    const targetId = event.actionable.targetId;
    return (
      <div className="chat-message__actions">
        {event.actionable.kind === "release" && (
          <button
            type="button"
            className="btn btn--gate"
            disabled={disabled || busy || actionBusy}
            aria-label={`${t("activity.release")} ${targetId}`}
            onClick={() => void decideCleanup(event, "release")}
          >
            {t("activity.release")}
          </button>
        )}
        <button
          type="button"
          className="btn"
          disabled={disabled || busy || actionBusy}
          aria-label={`${t("activity.retain")} ${targetId}`}
          onClick={() => void decideCleanup(event, "retain")}
        >
          {t("activity.retain")}
        </button>
        <button
          type="button"
          className="btn"
          disabled={actionBusy}
          aria-label={`${t("attention.reviewWorker")} ${targetId}`}
          onClick={() => onSelectWorker(targetId)}
        >
          {t("attention.reviewWorker")}
        </button>
      </div>
    );
  }

  async function sendMessage() {
    const body = draft.trim();
    const targetId = replyTarget?.actionable?.targetId;
    const taskId = composeTarget?.taskId;
    if (!body || !runId || disabled || busy || actionBusy || (!targetId && (!taskId || !activeDispatch || messageUncertain))) return;
    setBusy(true);
    setError(null);
    setMessageReceipt(null);
    try {
      if (targetId) {
        const receipt = await withControl(runId, (control) => replyToMessage(targetId, body, runId, control));
        setOperatorReceipt({ runId, value: JSON.stringify(receipt) });
      }
      else setMessageReceipt(await sendTaskMessage(taskId!, body, runId));
      setDraft("");
      onResolved();
    } catch (err) {
      const reconciled = err instanceof ApiError && err.code === "guidance_reconciled";
      const diagnostic = String((err as Error).message ?? err);
      setError(reconciled ? `${t("chat.message.reconciled")}\n${diagnostic}` : diagnostic);
      // This local guard runs before the native send and checkpoint; a stale
      // active-stage view is a definite refusal, not an ambiguous delivery.
      const refusedBeforeSend = err instanceof ApiError && err.code === "active_dispatch_required";
      if (!targetId && taskId && !reconciled && !refusedBeforeSend) {
        setUncertainMessages((current) => ({ ...current, [`${runId}:${taskId}`]: true }));
      }
    } finally {
      setBusy(false);
    }
  }

  if (!runId) {
    return <div className="chat__empty">{t("chat.empty.pickRun")}</div>;
  }


  return (
    <div className="chat-container" ref={chatContainerRef}>
    <section className="chat" data-mobile-view={embeddedMessagesOnly || mobileConversationOpen ? "conversation" : "list"} aria-label={t("chat.aria.section")}>
      {!embeddedMessagesOnly && (
      <aside className="chat__sidebar" ref={sidebarRef} aria-label={t("chat.aria.threadList")}>
        <h2>{t("chat.sidebar.title")}</h2>
        <ToggleGroup.Root
          className="chat__switch"
          role="radiogroup"
          type="single"
          value={chatView}
          onValueChange={(value) => {
            if (value !== "private" && value !== "group") return;
            setChatView(value);
            if (value === "group") onSelectTask(null);
            setThreadView("messages");
            setMobileConversationOpen(false);
          }}
          aria-label={t("chat.sidebar.view")}
        >
          <ToggleGroup.Item value="private">{t("chat.sidebar.private")}</ToggleGroup.Item>
          <ToggleGroup.Item value="group">{t("chat.sidebar.group")}</ToggleGroup.Item>
        </ToggleGroup.Root>
            <div className="chat__thread-browser">
              {chatView === "private" && <input type="search" className="chat__thread-search" value={threadQuery} onChange={(event) => setThreadQuery(event.target.value)} placeholder={t("chat.sidebar.search")} aria-label={t("chat.sidebar.search")} />}
              <div className="chat__thread-list">
                {filteredConversations.map((conversation) => (
                  <button
                    type="button"
                    className="chat__thread"
                    key={conversation.id}
                    aria-pressed={selectedId === conversation.id}
                    title={[conversation.label, conversation.taskId, conversation.subtitle].filter(Boolean).join("\n")}
                    onClick={() => openConversation(conversation.id)}
                  >
                    <HarnessAvatar harness={conversation.harness} kind={conversation.taskId ? "agent" : "system"} size={36} />
                    <span className="chat__thread-copy">
                    <span className="chat__thread-name">
                      <strong>{conversation.label}</strong>
                      {conversation.events.length > 0 && <time dateTime={conversation.latestAt} title={formatDateTime(conversation.latestAt)}>{formatClock(conversation.latestAt)}</time>}
                    </span>
                    {conversation.taskId && <span className="chat__thread-status">{conversation.task
                      ? stageState(conversation.task, conversation.presence, conversation.pending.length > 0)
                      : t("chat.thread.stateUnavailable")}</span>}
                    <span className="chat__thread-preview">{conversation.events.at(-1)?.summary ??
                      t(conversation.taskId ? "chat.thread.previewAssigned" : "chat.sidebar.groupNote")}</span>
                    {(conversation.urgent || conversation.unread || conversation.pending.length > 0) && (
                      <span className="chat__thread-badges">
                        {conversation.urgent && <span className="chat__thread-urgent">{t("chat.thread.urgentAria")}</span>}
                        {conversation.unread && <span title={t("chat.message.unreadTitle")}>{t("chat.message.unread")}</span>}
                        {conversation.pending.length > 0 && <span>{t("chat.thread.repliesNeeded", { n: conversation.pending.length })}</span>}
                      </span>
                    )}
                    </span>
                  </button>
                ))}
                {filteredConversations.length === 0 && <p className="chat__sidebar-note" role="status">{t(query ? "chat.sidebar.noMatches" : "chat.sidebar.emptyPrivate")}</p>}
              </div>
            </div>
      </aside>
      )}

      <Tabs.Root className="chat__conversation" value={effectiveThreadView} onValueChange={(value) => {
        if (value === "task") openTaskDetails();
        else if (value === "session") {
          if (!selected?.taskId) return;
          setSessionVisited(true);
          setThreadView("session");
        }
        else if (value === "config") {
          if (!selected?.taskId) return;
          setConfigVisited(true);
          setThreadView("config");
        }
        else if (value === "checks") {
          if (selected?.taskId) return;
          setThreadView("checks");
        }
        else if (value === "messages") setThreadView("messages");
      }}>
        {!selected && <p className="chat__choose-conversation">{t("chat.chooseConversation")}</p>}
        {selected && (
          <>
            {!embeddedMessagesOnly && (
            <header className="chat__conversation-head">
              {!onCloseInspector && (
                <button type="button" className="chat__back" onClick={backToConversations} aria-label={t("chat.backToList")}>
                  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m15 18-6-6 6-6" /></svg>
                </button>
              )}
              <HarnessAvatar harness={selected.harness} kind={selected.taskId ? "agent" : "system"} size={24} />
              <div className="chat__conversation-info">
                <div className="chat__conversation-title">
                  <h2 ref={conversationHeadingRef} tabIndex={-1}>{selected.label}</h2>
                  {chatView === "private" && selected.isLead && <span className="odag-console-tag">{t("chat.leadStage")}</span>}
                </div>
                {chatView === "group" ? <p>{t("chat.sidebar.groupNote")}</p>
                  : selected.subtitle && selected.subtitle !== selected.label && selected.subtitle !== selected.taskId
                    ? <p className="chat__conversation-model">{selected.subtitle}</p>
                    : null}
              </div>
              <div className="chat__conversation-actions">
                {selected.taskId && (
                  <Popover.Root key={conversationScope}>
                    <Popover.Trigger asChild>
                      <button type="button" className="odag-btn odag-btn--ghost odag-btn--icon odag-btn--icon-md chat__identity-button" aria-label={t("chat.recipient.details")} title={t("chat.recipient.details")}>
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9" /><path d="M12 11v6m0-10v.01" /></svg>
                      </button>
                    </Popover.Trigger>
                    <Popover.Portal>
                      <Popover.Content className="chat-recipient-popover" sideOffset={8} collisionPadding={12} aria-label={t("chat.recipient.details")} onEscapeKeyDown={(event) => event.stopPropagation()}>
                        <strong>{selected.label}</strong>
                        {selected.subtitle && <p>{selected.subtitle}</p>}
                        <dl>
                          <dt>{t("record.task")}</dt><dd><code>{selected.taskId}</code></dd>
                          {selected.task?.dispatchId && <><dt>{t("record.dispatch")}</dt><dd><code>{selected.task.dispatchId}</code></dd></>}
                          {replyTarget?.dispatchId && replyTarget.dispatchId !== selected.task?.dispatchId && <><dt>{t("record.dispatch")}</dt><dd><code>{replyTarget.dispatchId}</code></dd></>}
                        </dl>
                        <Popover.Close asChild>
                          <button type="button" className="odag-btn" onClick={() => {
                            openTaskDetails();
                            window.requestAnimationFrame(() => taskTabRef.current?.focus());
                          }}>{t("chat.openStage")}</button>
                        </Popover.Close>
                      </Popover.Content>
                    </Popover.Portal>
                  </Popover.Root>
                )}
                {onCloseInspector && (
                  <button
                    type="button"
                    className="odag-btn odag-btn--ghost odag-btn--icon odag-btn--icon-md"
                    onClick={onCloseInspector}
                    aria-label={t("ide.inspector.close")}
                    title={t("ide.inspector.close")}
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12" /></svg>
                  </button>
                )}
              </div>
            </header>
            )}
            {!embeddedMessagesOnly && (
            <Tabs.List className="chat__view-tabs odag-tablist" aria-label={t("chat.view.label")}>
              <Tabs.Trigger className="odag-tab" value="messages">{t("chat.view.messages")}</Tabs.Trigger>
              {selected.taskId && renderSession && <Tabs.Trigger className="odag-tab" value="session">{t("ide.inspector.tabSession")}</Tabs.Trigger>}
              {selected.taskId && <Tabs.Trigger className="odag-tab" value="task" ref={taskTabRef}>{t("chat.view.task")}</Tabs.Trigger>}
              {selected.taskId && renderConfig && <Tabs.Trigger className="odag-tab" value="config">{t("ide.inspector.tabConfig")}</Tabs.Trigger>}
              {!selected.taskId && (
                <Tabs.Trigger className="odag-tab" value="checks">
                  <span>{t("chat.checks.title")}</span>
                  <span className="odag-count">{snapshot.checks.length}</span>
                </Tabs.Trigger>
              )}
            </Tabs.List>
            )}
            <Tabs.Content className="chat__view chat__view--messages" value="messages" forceMount hidden={effectiveThreadView !== "messages"}>

            <div className="chat__timeline">
            <div className="chat__messages" role="region" aria-label={t("chat.timeline.label")} aria-live="polite" tabIndex={0} ref={messagesRef} onScroll={(event) => {
              if (!timelineActive) return;
              const element = event.currentTarget;
              const follow = element.scrollHeight - element.clientHeight - element.scrollTop <= 48;
              scrollByConversation.current.set(conversationScope, { top: element.scrollTop, follow });
              setAwayFromLatest(!follow);
            }}>
              <div className="chat__message-content" ref={messageContentRef}>
              {visibleTimeline.length < visibleEvents.length && (
                <div className="chat__history-window">
                  <span>{t("workbench.chat.window", { shown: visibleTimeline.length, total: visibleEvents.length })}</span>
                  <button type="button" onClick={() => setTimelineLimit((count) => count + 100)}>{t("workbench.chat.more")}</button>
                </div>
              )}
              {historyWarning && (
                <div className="chat-history-warning" role="status">
                  <strong aria-hidden="true">⚠</strong>
                  <span>
                    <strong>{t("chat.history.incomplete")}</strong> {historyWarning}
                  </span>
                </div>
              )}
              {selected.task && !hasRecordedAssignment && (
                <div className="chat-message-row chat-message-row--outgoing">
                <HarnessAvatar kind="operator" size={24} />
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
                </div>
              )}
              {visibleTimeline.map((event) => {
                const system = event.direction === "system" || event.actor.role === "system";
                const outgoing = event.direction === "coordinator_to_agent";
                const actor = eventActor(event, event.taskId ? taskMap.get(event.taskId) : undefined);
                const runtime = outgoing ? "" : [event.actor.harness, event.actor.model].filter(Boolean).join(" · ");
                const senderTaskId = !outgoing && event.taskId !== actor ? event.taskId : null;
                // Phase 6: an audience turns the bubble into a distinct group
                // send — different border treatment, an audience chip, the
                // requested priority, and the enqueue-only provenance note.
                const groupChip = event.audience ? groupPriorityChip(event) : null;
                const priorityChip = isUrgent(event) ? priorityLabel(event) : groupChip;
                return system ? (
                  <div key={event.id} className={`chat-message chat-message--system chat-message--${event.severity}`}>
                    <span>{event.title}</span>
                    <p>{messageBody(event)}</p>
                    {renderCleanupActions(event)}
                    <time dateTime={event.createdAt}>{formatDateTime(event.createdAt)}</time>
                  </div>
                ) : (
                  <div className={`chat-message-row${outgoing ? " chat-message-row--outgoing" : ""}`} key={event.id}>
                    {chatView === "group" && !outgoing && event.taskId
                      ? <button type="button" className="chat-message-avatar" onClick={() => onSelectTask(event.taskId!)} aria-label={t("chat.avatar.openPrivate", { label: taskMap.get(event.taskId)?.label ?? event.taskId })}>
                          <HarnessAvatar harness={event.actor.harness} size={24} />
                        </button>
                      : <HarnessAvatar harness={event.actor.harness} kind={outgoing ? "operator" : "agent"} size={24} />}
                    <article
                      className={`chat-message ${outgoing ? "chat-message--outgoing" : "chat-message--incoming"} chat-message--${event.kind} chat-message--${event.severity}${isUrgent(event) ? " chat-message--urgent" : ""}${event.audience ? " chat-message--group" : ""}`}
                    >
                    <div className="chat-message__meta">
                      <div className="chat-message__sender">
                        <strong>{actor}</strong>
                        {(senderTaskId || (runtime && runtime !== actor)) && (
                          <span className="chat-message__sender-details">
                            {senderTaskId && <code title={t("record.task")}>{senderTaskId}</code>}
                            {runtime && runtime !== actor && <span>{runtime}</span>}
                          </span>
                        )}
                      </div>
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
                    {chatView === "group" && event.taskId && (
                      <span className="chat-message__mention">
                        {outgoing ? `@${taskMap.get(event.taskId)?.label ?? event.taskId}` : t("chat.mention.coordinator")}
                      </span>
                    )}
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
                    {event.permissionPrompt && event.dispatchId && (
                      <div className="inbox__meta" style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                        <span className="odag-console-tag">{t("permission.badge")}</span>
                        <code>{event.permissionPrompt.id}</code>
                        <button
                          type="button"
                          className="btn btn--gate"
                          disabled={disabled || busy || actionBusy || event.permissionPrompt.allowSupported === false}
                          title={event.permissionPrompt.allowSupported === false ? t("permission.allowDisabledTitle") : undefined}
                          onClick={() => void decidePrompt(event, "approve")}
                        >
                          {t("permission.allowOnce")}
                        </button>
                        <button
                          type="button"
                          className="btn"
                          disabled={disabled || busy || actionBusy}
                          onClick={() => void decidePrompt(event, "deny")}
                        >
                          {t("permission.deny")}
                        </button>
                      </div>
                    )}
                    {event.kind === "stop_event" && (
                      <div className="inbox__meta">
                        {t("inbox.stopEvent", { reason: String((event.technical.payload as { stopReason?: unknown } | undefined)?.stopReason ?? t("worker.unknown")) })}
                        {event.actionable?.kind === "acknowledge_stop" && event.dispatchId && (
                          <button type="button" className="btn btn--gate" disabled={disabled || busy || actionBusy} onClick={() => void acknowledge(event)}>{t("inbox.ackStop")}</button>
                        )}
                      </div>
                    )}
                    {renderCleanupActions(event)}
                    {event.detail?.trim() && event.detail.trim() !== event.summary.trim() && (
                      <details className="chat-message__details">
                        <summary>{event.kind === "dispatch_started" ? t("chat.brief.full") : t("chat.report.full")}</summary>
                        <p>{event.detail}</p>
                      </details>
                    )}
                  </article>
                  </div>
                );
              })}

              <section
                className="chat-runtime-summary"
                data-state={summaryState}
                aria-label={t("chat.summary.aria")}
              >
                <div className="chat-runtime-summary__status">
                  <span className="chat-runtime-summary__pulse" aria-hidden="true" />
                  <strong title={summaryLabel}>{summaryLabel}</strong>
                </div>
                <span className="chat-runtime-summary__detail">
                  {selected.task
                    ? presenceSummary
                    : coordinatorActive ? t("chat.summary.scheduling") : t("chat.summary.runLevelOnly")}
                </span>
              </section>
              </div>
            </div>
              {awayFromLatest && <button type="button" className="chat__jump-latest" onClick={jumpToLatest}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 5v14m-7-7 7 7 7-7" /></svg>
                {t("chat.timeline.latest")}
              </button>}
            </div>

            <footer className="chat__composer">
              {error && <div className="chat__error" role="status">{error}</div>}
              {actionError && <div className="chat__error" role="status">{actionError}</div>}
              {messageUncertain && <div className="inbox__meta" role="status">{t("chat.message.sendUncertain")}</div>}
              {operatorReceipt?.runId === runId && <div role="status" className="chat__receipt">
                <details key={operatorReceipt.value}><summary>{t("chat.message.operatorReceipt")}</summary><pre>{operatorReceipt.value}</pre></details>
              </div>}
              {messageReceipt && messageReceipt.runId === runId && messageReceipt.requestedTaskId === composeTarget?.taskId && (
                <div className="chat__receipt" role="status" data-testid="task-message-receipt">
                  <strong>{t(messageReceipt.kind === "follow_up" ? "chat.message.followUp" : messageReceipt.kind === "recipient_run_bound_redirect" ? "chat.message.redirect" : "chat.message.taskEnqueued")}</strong>
                  <details key={messageReceipt.requestId ?? messageReceipt.dispatchId}>
                    <summary>{t("chat.message.receiptDetails")}</summary>
                  <dl className="record-facts">
                    <dt>{t("record.task")}</dt><dd><code>{messageReceipt.taskId}</code></dd>
                    <dt>{t("record.dispatch")}</dt><dd><code>{messageReceipt.dispatchId}</code></dd>
                    <dt>{t("chat.message.requestedTask")}</dt><dd><code>{messageReceipt.requestedTaskId}</code></dd>
                    <dt>{t("chat.message.requestedDispatch")}</dt><dd><code>{messageReceipt.requestedDispatchId}</code></dd>
                    {messageReceipt.followUpOf && <><dt>{t("chat.message.followUpOf")}</dt><dd><code>{messageReceipt.followUpOf}</code></dd></>}
                    {messageReceipt.destinationRunId && <><dt>{t("chat.message.destinationRun")}</dt><dd><code>{messageReceipt.destinationRunId}</code></dd></>}
                    {messageReceipt.requestId && <><dt>{t("record.request")}</dt><dd><code>{messageReceipt.requestId}</code></dd></>}
                  </dl>
                  </details>
                  <span className="inbox__meta">{t("chat.message.taskReceiptNote")}</span>
                  {messageReceipt.kind === "follow_up" && (
                    <div className="gate__actions">
                      <button type="button" onClick={() => onSelectTask(messageReceipt.taskId)}>{t("chat.message.openActualTask")}</button>
                      <button type="button" onClick={() => onSelectWorker(messageReceipt.dispatchId)}>{t("chat.message.openActualDispatch")}</button>
                    </div>
                  )}
                </div>
              )}
              {chatView === "group" && (
                <label className="chat__mention-target">
                  <span>{t("chat.group.recipient")}</span>
                  <DoodleSelect
                    value={groupTargetId}
                    onChange={setGroupTargetId}
                    options={recipientOptions}
                    disabled={disabled || busy || actionBusy}
                    ariaLabel={t("chat.group.recipient")}
                    placeholder={t("chat.group.selectTask")}
                    emptyText={t("chat.sidebar.emptyPrivate")}
                    size="sm"
                  />
                  {groupTargetId && !composeTarget && <span role="status">{t("chat.group.targetUnavailable")}</span>}
                </label>
              )}
              {replyTarget || activeDispatch ? (
                <MessageComposer
                  value={draft}
                  onChange={setDraft}
                  onSend={sendMessage}
                  disabled={disabled || busy || actionBusy}
                  sendDisabled={disabled || busy || actionBusy || !draft.trim() || (!replyTarget && messageUncertain)}
                  busy={busy}
                  label={replyTarget ? t("chat.compose.replyTo", { label: composeTarget!.label }) : t("chat.compose.guidanceTo", { label: composeTarget!.label })}
                  placeholder={disabled ? t("chat.compose.executionUnavailable") : replyTarget
                    ? t("chat.compose.replyTo", { label: composeTarget!.label })
                    : t("chat.compose.guidanceTo", { label: composeTarget!.label })}
                  sendLabel={t("chat.compose.send")}
                  sendTitle={disabled ? disabledReason ?? t("chat.compose.executionIsUnavailable")
                    : !replyTarget && messageUncertain ? t("chat.message.sendUncertain")
                    : replyTarget ? t("chat.compose.sendReplyTitle") : t("chat.compose.sendGuidanceTitle")}
                />
              ) : (
                <p className="chat__composer-idle">
                  {disabled ? disabledReason ?? t("chat.compose.executionIsUnavailable")
                    : composeTarget?.task
                      ? composeTarget.task.status === "dispatched" && !coordinatorActive
                        ? t("chat.compose.idleStartCoordinator")
                        : t("chat.compose.idleNoDispatch")
                      : chatView === "group" ? t("chat.group.selectTask") : t("chat.compose.idlePickStage")}
                </p>
              )}
            </footer>
            </Tabs.Content>
            {selected.taskId && renderSession && <Tabs.Content className="chat__view chat__view--session" value="session" forceMount hidden={effectiveThreadView !== "session"}>
              {selected.task
                ? sessionVisited && renderSession(selected.task, sessionActive)
                : <p role="status" className="chat__task">{t("workbench.taskUnavailable")} <code>{selected.taskId}</code></p>}
            </Tabs.Content>}
            {selected.taskId && <Tabs.Content className="chat__view chat__view--task" value="task" forceMount hidden={effectiveThreadView !== "task"}>
              <div className="chat__task">
                {selected.task
                  ? taskVisited && renderTask(selected.task)
                  : <p role="status">{t("workbench.taskUnavailable")} <code>{selected.taskId}</code></p>}
              </div>
            </Tabs.Content>}
            {selected.taskId && renderConfig && <Tabs.Content className="chat__view chat__view--task" value="config" forceMount hidden={effectiveThreadView !== "config"}>
              <div className="chat__task">
                {selected.task
                  ? configVisited && renderConfig(selected.task)
                  : <p role="status">{t("workbench.taskUnavailable")} <code>{selected.taskId}</code></p>}
              </div>
            </Tabs.Content>}
            {!selected.taskId && (
              <Tabs.Content className="chat__view" value="checks" forceMount hidden={effectiveThreadView !== "checks"}>
                <MailboxChecks checks={snapshot.checks} tasks={tasks} taskId={null} scope={conversationScope} />
              </Tabs.Content>
            )}
          </>
        )}
      </Tabs.Root>
    </section>
    </div>
  );
});
