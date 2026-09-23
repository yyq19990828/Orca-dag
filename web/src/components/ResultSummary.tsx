import { formatDateTime } from "../format";
import { useT } from "../i18n";
import { StructuredData } from "./StructuredData";

export function ResultSummary({ raw }: { raw: string }) {
  const t = useT();
  let value: unknown;
  try { value = JSON.parse(raw); } catch { return <p className="node-panel__result-text">{raw}</p>; }
  const report = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
  // Reports arrive from agents, not a validated form. Read known string fields
  // defensively; other JSON shapes still deserve a readable result of their own.
  const text = (key: string) => typeof report?.[key] === "string" ? (report[key] as string).trim() : "";
  const body = text("body");
  const subject = text("subject");
  const outcome = text("outcome") || "reported";
  const completedAt = text("completedAt");
  const files = Array.isArray(report?.filesModified) ? report.filesModified.filter((file): file is string => typeof file === "string") : [];
  const isReport = Boolean(body || subject);
  const knownOutcome = outcome === "succeeded" || outcome === "failed" || outcome === "reported";
  return (
    <section className="node-result" data-outcome={outcome} aria-label={t("report.resultAria")}>
      {isReport ? <>
        <div className="node-result__head">
          <span className="node-result__outcome">{knownOutcome ? t(`report.outcome.${outcome}`) : outcome}</span>
          {completedAt && !Number.isNaN(Date.parse(completedAt)) && <time dateTime={completedAt}>{formatDateTime(completedAt)}</time>}
        </div>
        <strong>{subject || t("report.workerReport")}</strong>
        {body && <p className="node-result__body">{body.length > 420 ? `${body.slice(0, 420)}…` : body}</p>}
        {body.length > 420 && <details><summary>{t("report.fullBody")}</summary><p className="node-result__body">{body}</p></details>}
        {files.length > 0 && <div className="node-result__files">
          <span>{t(files.length === 1 ? "report.filesModifiedOne" : "report.filesModifiedMany", { n: files.length })}</span>
          <ul>{files.map((file, index) => <li key={index}><code>{file}</code></li>)}</ul>
        </div>}
        {text("reportPath") && <p>{t("report.reportLabel")} <code>{text("reportPath")}</code></p>}
        <details className="node-result__details">
          <summary>{t("report.details")}</summary>
          <StructuredData value={Object.fromEntries(Object.entries(report!).filter(([key]) => !["body", "subject", "filesModified", "reportPath"].includes(key)))} />
        </details>
      </> : <StructuredData value={value} />}
      <details className="node-result__details">
        <summary>{t("report.raw")}</summary>
        <pre>{raw}</pre>
      </details>
    </section>
  );
}
