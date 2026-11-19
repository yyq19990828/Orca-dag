import { useId, useMemo } from "react";
import { ChevronDown } from "lucide-react";
import { formatClock, formatDateTime } from "../format";
import { t, useT } from "../i18n";
import type { CoordinatorCheckAgentSummary, CoordinatorCheckReceipt, DagNode } from "../types";
import { useScopedChatState } from "./useScopedChatState";

interface TimelineCheckGroup {
  receipts: CoordinatorCheckReceipt[];
}

function compactSignal(value: string | null | undefined): string | null {
  const normalized = value?.replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
  if (!normalized) return null;
  if (normalized === "input accepted") return t("chat.signal.promptAccepted");
  return normalized.charAt(0).toUpperCase() + normalized.slice(1);
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

/** Collapse only adjacent compatible checks; errors and distinct deliveries stay separate. */
function checkMergeKey(receipt: CoordinatorCheckReceipt, taskId: string | null): string | null {
  if (receipt.error) return null;
  const state = checkStateKey(receipt, taskId);
  if (receipt.messageCount === 0) return `quiet:${state}`;
  return receipt.deliveryId ? `delivery:${receipt.deliveryId}:${state}` : null;
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

function groupChecks(checks: CoordinatorCheckReceipt[], taskId: string | null): TimelineCheckGroup[] {
  const groups: TimelineCheckGroup[] = [];
  const ordered = [...checks].sort((a, b) => a.checkedAt - b.checkedAt);
  for (const receipt of ordered) {
    const previous = groups.at(-1);
    const previousReceipt = previous?.receipts.at(-1);
    const key = checkMergeKey(receipt, taskId);
    if (previous && previousReceipt && key && key === checkMergeKey(previousReceipt, taskId)) {
      previous.receipts.push(receipt);
    } else {
      groups.push({ receipts: [receipt] });
    }
  }
  return groups;
}

export function MailboxChecks({ checks, tasks, taskId, scope }: {
  checks: CoordinatorCheckReceipt[];
  tasks: DagNode[];
  taskId: string | null;
  scope: string;
}) {
  const t = useT();
  const id = useId();
  const [expandedChecks, setExpandedChecks] = useScopedChatState<Record<string, number>>(scope, {});
  const [limit, setLimit] = useScopedChatState(scope, 100);
  const groups = useMemo(() => groupChecks(checks, taskId), [checks, taskId]);
  const lastCheck = groups.at(-1)?.receipts.at(-1);
  const visible = groups.slice(-limit);

  function renderTimelineCheck(group: TimelineCheckGroup) {
    const receipt = group.receipts.at(-1)!;
    const firstReceipt = group.receipts[0];
    const checkKey = `${id}-check-${firstReceipt.checkedAt}-${firstReceipt.sequence}`;
    const visibleCount = expandedChecks[checkKey] ?? 0;
    const firstVisible = Math.max(0, group.receipts.length - visibleCount);
    const receiptDetail = (candidate: CoordinatorCheckReceipt) => {
      if (candidate.evidence) return candidate.evidence;
      const agent = taskId
        ? candidate.agents.find((item) => item.taskId === taskId) ?? null
        : null;
      return candidate.error ?? (taskId ? checkAgentLine(agent) : checkFleetLine(candidate.agents));
    };
    const agent = taskId
      ? receipt.agents.find((candidate) => candidate.taskId === taskId) ?? null
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
              <ChevronDown size={14} className="chat-checkpoint__chevron odag-chevron" data-open={visibleCount > 0 || undefined} aria-hidden="true" />
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
                const relevantAgents = taskId
                  ? item.agents.filter((candidate) => candidate.taskId === taskId)
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
                              <ChevronDown size={14} className="chat-checkpoint__chevron odag-chevron" aria-hidden="true" />
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

  return (
    <section className="mailbox-checks odag-scroll" aria-label={t("chat.checks.title")}>
      <header className="mailbox-checks__header">
        <p>{t("chat.checks.description")}</p>
        <span className="chat-runtime-summary__meta mono">
          {lastCheck
            ? t("chat.summary.lastCheck", { time: formatClock(new Date(lastCheck.checkedAt).toISOString()) })
            : t("chat.summary.noChecks")}
          {checks.length > 0 && t("chat.summary.totalChecks", { n: checks.length })}
        </span>
      </header>
      {groups.length === 0 ? <p className="mailbox-checks__empty">{t("chat.checks.empty")}</p> : (
        <div className="mailbox-checks__groups">
          {visible.length < groups.length && (
            <div className="chat__history-window">
              <span>{t("chat.checks.window", { shown: visible.length, total: groups.length })}</span>
              <button type="button" onClick={() => setLimit((count) => count + 100)}>{t("chat.checks.more")}</button>
            </div>
          )}
          {visible.map(renderTimelineCheck)}
        </div>
      )}
    </section>
  );
}
