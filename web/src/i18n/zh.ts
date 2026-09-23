import type { Dict } from "../i18n";
// Simplified Chinese. Type error here = key missing/extra vs en — fix the
// dictionary, never silence the compiler.
const zh: Dict = {
  "topbar.title": "Orca DAG Viewer",
  "topbar.orcaConnected": "Orca 已连接",
  "topbar.viewOnly": "仅浏览",
  "topbar.fetchFailed": "获取失败",
  "topbar.noStages": "暂无阶段",
  "topbar.doneOf": "{done}/{total} 已完成",
  "topbar.failedCount": "⚠ {n} 个失败",
  "status.pending": "待命",
  "status.ready": "就绪",
  "status.dispatched": "运行中",
  "status.completed": "已完成",
  "status.failed": "失败",
  "status.blocked": "受阻",
};
export default zh;
export { zh };
