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

  return (
    <section className="task-list" aria-label={t("taskList.aria")}>
      {dag.nodes.length === 0 ? (
        <p className="task-list__empty">{t("taskList.empty")}</p>
      ) : (
        <ul className="task-list__items">
          {dag.nodes.map((node) => {
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
