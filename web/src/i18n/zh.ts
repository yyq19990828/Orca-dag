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
  "priority.urgent": "紧急",
  "priority.low": "低优先级",
  "priority.normal": "普通优先级",
  "priority.high": "高优先级",
  "layout.label.layered-lr": "横向",
  "layout.label.layered-tb": "纵向",
  "layout.label.force": "力导",
  "layout.title.layered-lr": "分层布局，从左到右（Sugiyama / dagre）",
  "layout.title.layered-tb": "分层布局，从上到下（Sugiyama / dagre）",
  "layout.title.force": "力导向布局（Fruchterman–Reingold）",
};
export default zh;
export { zh };
