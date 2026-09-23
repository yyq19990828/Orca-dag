import { useT, type TranslationKey } from "../i18n";

const FIELD_LABELS: Record<string, TranslationKey> = {
  summary: "data.summary", decision: "data.decision", status: "data.status",
  outcome: "record.outcome", reason: "data.reason", detail: "data.detail",
  message: "data.message", filesModified: "data.files", files: "data.files",
  tests: "data.tests", validation: "data.validation", environment: "data.environment",
  nextSteps: "data.nextSteps", warnings: "data.warnings", blockers: "data.blockers",
};

/** Presentation only: no schema guessing, HTML interpretation, or status inference.
 * Unknown keys and values remain verbatim. Nested collections expand in place;
 * the caller retains the original JSON separately for exact diagnosis. */
export function StructuredData({ value }: { value: unknown }) {
  const t = useT();
  if (value === null || value === undefined) return <span>{t("data.notProvided")}</span>;
  if (typeof value === "boolean") return <span>{t(value ? "data.yes" : "data.no")}</span>;
  if (typeof value !== "object") return <span className="structured-data__text">{String(value) || t("data.emptyText")}</span>;
  const entries = Object.entries(value);
  if (!entries.length) return <span>{t("data.empty")}</span>;
  if (Array.isArray(value)) {
    return <ol className="structured-data__list">{value.map((item, index) => <li key={index}><StructuredData value={item} /></li>)}</ol>;
  }
  return (
    <dl className="record-facts structured-data">
      {entries.map(([key, item]) => (
        <div className="structured-data__field" key={key}>
          <dt title={key}>{Object.hasOwn(FIELD_LABELS, key) ? t(FIELD_LABELS[key]) : key}</dt>
          <dd>{item !== null && typeof item === "object" ? (
            <details>
              <summary>{t("data.entries", { n: Object.keys(item).length })}</summary>
              <StructuredData value={item} />
            </details>
          ) : <StructuredData value={item} />}</dd>
        </div>
      ))}
    </dl>
  );
}
