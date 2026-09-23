// English dictionary — the source of truth for keys. zh must define exactly
// these keys (typed Record<TranslationKey, string> in zh.ts; tsc enforces it).
const en = {
  "topbar.title": "Orca DAG Viewer",
  "topbar.orcaConnected": "Orca connected",
  "topbar.viewOnly": "View-only",
  "topbar.fetchFailed": "Fetch failed",
  "topbar.noStages": "No stages",
  "topbar.doneOf": "{done}/{total} done",
  "topbar.failedCount": "⚠ {n} failed",
  "status.pending": "Pending",
  "status.ready": "Ready",
  "status.dispatched": "Running",
  "status.completed": "Done",
  "status.failed": "Failed",
  "status.blocked": "Blocked",
} as const;
export default en;
export { en };
