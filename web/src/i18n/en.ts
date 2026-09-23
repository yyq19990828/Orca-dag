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
  "priority.urgent": "Urgent",
  "priority.low": "Low priority",
  "priority.normal": "Normal priority",
  "priority.high": "High priority",
  "layout.label.layered-lr": "Horiz.",
  "layout.label.layered-tb": "Vert.",
  "layout.label.force": "Force",
  "layout.title.layered-lr": "Layered, left to right (Sugiyama / dagre)",
  "layout.title.layered-tb": "Layered, top to bottom (Sugiyama / dagre)",
  "layout.title.force": "Force-directed (Fruchterman–Reingold)",
} as const;
export default en;
export { en };
