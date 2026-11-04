import { useState } from "react";
import { useT } from "../i18n";
import { STATUS_META, type DagResponse } from "../types";
import "./task-list.css";

export interface TaskListProps {
  dag: DagResponse;
  selectedId: string | null;
  onSelect: (id: string) => void;
}

/** A Run-scoped, read-only task index for narrow screens and keyboard users. */
export function TaskList({ dag, selectedId, onSelect }: TaskListProps) {
  const t = useT();
  const [filter, setFilter] = useState("");
  const query = filter.trim().toLocaleLowerCase();
  const nodes = dag.nodes.filter((node) => `${node.label} ${node.id}`.toLocaleLowerCase().includes(query));

  return (
    <section className="task-list" aria-label={t("taskList.aria")}>
      <label className="workbench-task-filter">{t("workbench.taskFilter")} <input value={filter} onChange={(event) => setFilter(event.target.value)} /></label>
      {nodes.length === 0 ? (
        <p className="task-list__empty">{t(query ? "workbench.noMatchingTasks" : "taskList.empty")}</p>
      ) : (
        <ul className="task-list__items">
          {nodes.map((node) => {
            const readiness = dag.readiness?.[node.id];
            const meta = STATUS_META[node.status];
            return (
              <li className="task-list__row" key={node.id}>
                <button
                  className="task-list__item"
                  type="button"
                  aria-pressed={selectedId === node.id}
                  onClick={() => onSelect(node.id)}
                >
                  <span className="task-list__heading">
                    <span className="task-list__name">{node.label}</span>
                    <span className="task-list__status" data-status={node.status}>
                      <span className="task-list__status-dot" style={{ backgroundColor: meta.color }} aria-hidden="true" />
                      {t(`status.${node.status}`)}
                    </span>
                  </span>
                  <code>{node.id}</code>
                  {readiness?.reasons.map((reason, index) => (
                    <span className="task-list__reason" key={`${readiness.codes[index] ?? "reason"}-${index}`}>
                      {reason}
                    </span>
                  ))}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
