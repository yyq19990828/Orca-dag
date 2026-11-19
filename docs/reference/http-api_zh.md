# HTTP API 接口参考

[English](http-api.md) | 简体中文

> [返回文档索引](../README_zh.md) · [返回 README](../../README_zh.md)

本参考文档完整定义 orca-dag viewer 本地 HTTP API 的安全模型、就绪判定以及全部 API 路由清单与行为语义。

## 安全模型

viewer 作为一个具有直接控制 Orca 运行时能力的管理面进程，其默认安全策略是严格收紧的：

1. **仅监听本机回环地址**：HTTP 服务严格绑定在 `127.0.0.1`，绝不监听 `0.0.0.0` 或任何外网网卡。局域网内的其他设备无法发起网络访问，亦不提供任何远程直接监听模式。
2. **完全禁用 CORS 跨域资源共享**：API 响应中绝不返回任何 `Access-Control-*` 响应头，外部第三方网页无法通过脚本跨域读取任何响应内容（包括认证令牌）。
3. **单进程 Mutation Token 校验**：
   - 针对所有可能产生副作用的写操作路由（`/api` 下的所有 `POST` 和 `PUT` 请求），客户端必须在请求头中携带 `X-Orca-Dag-Token`。
   - 该 Token 是 viewer 进程每次启动时随机生成的 256 位安全随机字符串。
   - 同源的前端 SPA 应用在加载时通过 `GET /api/session` 获取并缓存该 Token；当服务端重启（Token 更换）后，客户端会自动重新拉取并透明重试一次请求。
   - 只读请求（`GET` 路由）不需要携带 Token。
   - 任何未携带或携带无效 Token 的写请求，在进入具体业务逻辑之前即被直接拒绝并返回 HTTP `403 Forbidden`。
4. **已验证 Harness 与未验证 Harness 明确拒绝**：
   - 内置选项为 `claude`、`codex`、`opencode`、`omp`、`antigravity`，须遵守各自[有记录的执行范围](compatibility_zh.md)。
   - **OMP / Antigravity 原生边界**：Current 或精确 Existing 放置要求运行时与解析后的 CLI 均须 ≥ 1.4.245。创建新建 Git 工作树（`new-child`、`new-top-level`）或任何工作区 Lane 则要求运行时与解析后的 CLI 均 ≥ 1.4.246。仅限本地 Linux；远程环境、macOS 与 Windows 均被拒绝。新建 child 放置必须具有明确正向识别的本地被托管 Git 父工作区；新建 top-level 放置要求精确的仓库标识符（`id:...` 或绝对路径 `path:/...`）指向已验证的本地 Git 仓库（拒绝模糊名称、普通目录、异构主机仓库且不自动 git-init）。协调者准入与计划预览会评估 Lane 的种子放置，若运行时或 CLI 低于 1.4.246 则在发起任何变更前直接拒绝（返回 `503 execution_disabled` 或校验拦截）。工作区 Lane 仅共享工作区：首个 Task 创建或接纳工作区，后续依赖有序 Task 复用精确 Existing；每个 Task 均分配全新的原生 agent 会话与 Dispatch（绝不进行通用终端复用、禁止 `--terminal` 或 `--surface` 覆盖，拒绝后绝不回退）。所有非空 effort 依然全部拒绝（包括同时指定模型）。模型文本是完整原生 selector，不要求 OpenCode 的 `provider/model[#variant]` 语法；未覆盖时省略 `--model`。原生 `worker-start --agent` 遵循 Orca 的 Chat/Terminal 偏好，viewer 不检查或覆盖；Native Chat 不作为拒绝条件，但有明确的 [fleet 状态局限与验证边界](../tutorials/viewer-operations_zh.md#已知局限)。当解析后的 CLI ≥ 1.4.246 时，`runOrca` 会根据缓存的就绪探针为编排命令追加 `--full` 参数，防止 1.4.246 默认的精简 JSON 导致数据缺失；CLI 1.4.245 拒绝 `--full`，因此在调用前完成版本判断，遇到不确定响应绝不重试变更（已通过单次请求 `POST /api/runs` 成功创建 `run_2a67b90e6a94` 验证且无 500 报错）。原生回执与英文诊断保持原文。
   - 未经验证的 harness（`gemini`、`grok`、`cursor`、`droid`、`kimi`）缺乏具体的 supervised worker 运行验证，不可用于 viewer 调度启动。任何在调度启动（`POST /api/run`）或重试（`POST /api/workers/:id/retry`）中使用这 5 个 harness 的请求均被前置拦截并返回 HTTP 400 `unverified_harness` 拒绝，绝不进行静默替换或自动迁移；历史已落定的 worker 数据与账本记录在读取接口（如 `GET /api/workers`）中保持只读可查。
5. **自定义 Harness 命令限制**：
   - 任意用户自定义命令属于实验性逃生通道，不构成已验证支持承诺；默认状态下会被服务端拒绝并返回 HTTP 400 `custom_commands_disabled` 错误。
   - 只有在启动 viewer 时显式声明环境变量 `ORCA_DAG_ALLOW_CUSTOM_COMMANDS=1` 方可解锁自定义命令，且仅走本地兼容路径、不支持隔离放置。
   - 即使开启了 `ORCA_DAG_ALLOW_CUSTOM_COMMANDS=1`，上述 5 个未验证 bare ID（`gemini`、`grok`、`cursor`、`droid`、`kimi`）依然被直接拒绝并返回 `unverified_harness`，严禁将其作为 bare ID 绕过验证机制。
6. **严密的基础校验与防注入**：
   - 所有输入的 Run ID、Task ID、Gate ID、harness 名称、`provider/model` 路径、并发上限数值等，在 HTTP 边界均经过严格的白名单和格式校验。
   - 后端调用 Orca CLI 时采用已解析的纯 argv 参数列表，执行选项强制设为 `shell: false`，杜绝任何 shell 命令注入风险。

## 就绪探测与只读模式

在尝试执行或调度 DAG 之前，前端通过 `GET /api/readiness` 探测底层环境状态：

- 响应包含 `{ cli, workspace, worktree, cliVersion, version, runtimeState, executionEnabled, reason }`；`cliVersion` 是可执行文件版本，`version` 与 `runtimeState` 来自所选运行时。
- **执行门槛**：CLI ≥ 1.4.205，且目标运行时明确处于 `ready`、稳定 appVersion ≥ 1.4.205。未知、断连或启动中的运行时保持只读，不能仅凭新 CLI 开放执行。
- 重新连接目标运行时后刷新页面；执行路由也会独立重新核验短暂缓存的服务端探测。
- **只读降级（Orca 1.4.160–1.4.204）**：UI 界面上所有执行和决策按钮将自动置灰禁用（Run 按钮提示 "View-only"，Gate 按钮附带版本原因）。若外部脚本绕过界面直接发起变更请求，服务端将直接返回 HTTP `503 execution_disabled`。
- **只读操作不受影响**：无论是否具备执行能力，DAG 结构渲染、Run 列表查看、终端状态以及本地偏好读取等功能始终正常可用。
- **协调者冲突（HTTP 409）**：当另一个 viewer 实例已经绑定并正在协调当前工作区时，启动 coordinator 的请求将返回 `409 coordinator_conflict`，防止并发冲突。

## 完整路由清单与语义说明

所有 `POST` / `PUT` 路由均要求携带 `X-Orca-Dag-Token` 请求头；`GET` 路由在回环地址上开放。

| 方法 | 路由路径 | 参数与请求体说明 | 功能语义与行为规范 |
|---|---|---|---|
| `GET` | `/api/session` | 无 | 获取当前进程的 mutation token 以及自定义命令启用状态（响应头包含 `Cache-Control: no-store`）。 |
| `GET` | `/api/readiness` | 无 | 获取 CLI 及其构建版本、目标运行时版本/状态、工作区信息及执行权限；不可执行时附上恢复原因。 |
| `GET` | `/api/capabilities` | 无 | 返回运行时就绪状态、原始能力声明、识别后的编排支持状态（含 1.4.263 的 `orchestration.worker-stop-helpers.v1`、`orchestration.peer-mail.v1`、`orchestration.remote-owned-workers.v1`），以及原生伴生插件 `plugin` 连接状态。 |
| `GET` | `/api/accounts` | 无 | 只读查询各 harness 的订阅/登录状态与配额使用率，供启动前预检提示。 |
| `POST` | `/api/open-tab` | `{ hash?: string }` | 在 Orca 中打开或复用完整 **Orchestration Panel** 工作台标签页；若已有标签页指向已关闭端口，则自动探测 `/api/health` 并原地 `orca goto` 复活。 |
| `GET` | `/api/run-health?run=<id>` | `run` (查询参数): Run ID | 返回归属状态（`viewer_coordinator / viewer_coordinator_other_run / external_coordinator / unbound / unverifiable`）、coordinator 句柄、按来源划分的计数、警告与可空的 `health.removedWork` 摘要。 |
| `GET` | `/api/dag?run=<id>` | `run`: Run ID | 获取指定 Run 的完整 DAG 结构，包括 `{ runId, nodes, edges, hierarchy, gates, readyWave, readiness, generatedAt }`。 |
| `GET` | `/api/runs` | 无 | 列出任务创建者身份严格匹配当前工作区（携带 `::${workspaceDir}@@` 标记）的 Run 列表，外加当前/已配置的空 Run。 |
| `GET` | `/api/runs/page?cursor=&limit=` | `cursor` (可选), `limit` (可选 1..100，默认 100) | 分页读取并根据工作区归属证据过滤后的 Run 注册表；透传不透明游标，首屏刷新保留遍历游标，候选页过滤后可能为空但游标非空。 |
| `GET` | `/api/runs/:runId` | `:runId` (路径参数): Run ID | 通过 `run-show` 精确查找单个 Run，返回 `{ run, workspace: { owned, evidence } }`；外来 Run 仍可见，但如实标记 `workspace.owned: false`。仅在 Orca 确认不存在时返回 `run_not_found`。 |
| `GET` | `/api/runs/:runId/removed-work?cursor=` | `:runId`: Run ID, `cursor`: 不透明游标 | 按需分页拉取 Run 的已移除工作历史账本（`{ page: { entries, page: { hasMore, nextCursor } } }`）。单页上限为官方 200 行；不透明游标（1–2048 字符），校验游标推进（游标停滞返回 502，非法游标返回 400）；条目携带历史移除时活跃标记 `activeAtRemoval`，未知 kind 标记 `unreadable: true`；只读不可变，无重置接口。 |
| `POST` | `/api/runs` | `{ objective?: string }` | 在当前工作区创建一个新的空 Run（通过一次性临时 coordinator 终端完成创建，避免占用主循环）。 |

### 一次性变更权限与 Coordinator 显式控制

对未处于当前 viewer 活跃调度下的 Run 发起一次性变更（回复提问、解决门、创建审批门、落定受阻 worker）时，必须提供与当前 Run 绑定匹配的显式确认信息：

```json
{
  "coordinatorControl": {
    "confirmed": true,
    "coordinatorHandle": "term_coord_1",
    "consumerGeneration": 1
  }
}
```

缺少该字段或绑定凭据不匹配时，服务以 HTTP 409 `coordinator_control_required` 拒绝，绝不擅自抢占或静默绑定临时终端。
| `GET` | `/api/terminals` | 无 | 列出当前 Orca 运行时的所有终端实例。 |
| `POST` | `/api/run` | `{ runId, harnessByTask?, modelByTask?, effortByTask?, retainByTask?, environmentByTask?, placementByTask?, worktreeLanes?, laneByTask?, defaultHarness?, maxConcurrency? }` | 启动自驱动 coordinator 循环开始调度指定的 Run。若当前环境只读则返回 503，若已在协调则返回 409。 |
| `POST` | `/api/run-stop` | 无 | 停止当前正在运行的 coordinator 调度循环，并安全回收/结算所有已派发的活跃 worker。 |
| `GET` | `/api/run-status` | 无 | 获取 coordinator 的实时调度状态：`{ running, busy, attempts, inbox, cleanupDebt, recovery, … }`。 |
| `GET` | `/api/worktree-lanes?run=<id>` | `run`: Run ID | 获取指定 Run 的 workspace lane 规划以及每条 lane 由 Orca 推导的运行时身份（包含状态、精确选择器、worktree ID、路径、分支、HEAD 和来源）。 |
| `POST` | `/api/worktree-lanes/:laneId/open-changed` | `:laneId`: Lane 标识符 | 在 Orca 编辑器中打开指定 lane 本地工作区的改动文件和 diff（工作区身份不可验证时禁用）。 |
| `POST` | `/api/worktree-lanes/:laneId/remove` | `:laneId`: Lane 标识符 | 调用 `orca worktree rm` 显式移除已验证且已落定的 lane 工作区；需要归属落定与显式确认，归档钩子失败原样暴露，绝不自动豁免。 |
| `GET` | `/api/worktrees` | 无 | 获取 Orca 发现的本地工作区列表（`worktree list`）；与限定 Run 的 `GET /api/workers?run=<id>` 共同构成按需清理候选清单审查数据源。 |
| `GET` | `/api/worktrees/:worktreeId` | `:worktreeId`: Worktree 标识符 | 通过 `worktree show` 读取单个工作区的持久身份；仅在 Orca 明确不存在时返回 404，传输错误如实向上传播。 |
| `GET` | `/api/repos` | 无 | 获取 Orca 发现的本地注册仓库列表（`repo list`）；作为新建顶层工作树（new top-level）的选择器来源。 |
| `GET` | `/api/inbox?run=<id>` | `run`: Run ID | 获取指定 Run 的待处理提问、升级项、stop 事件及未处理的清理债务。条目明确区分 `kind: "question"`（可回复）与 `kind: "stop_event"`（包含 `stopReason` 如 `finished`, `errored`, `needs-input`, `exited`，属于事件，由精确 Dispatch 引导、操作员决断或权威结算解决，不能通过伪造回复或合成成功结算）。 |
| `GET` | `/api/activity?run=<id>&after=&limit=` | `run`: Run ID, `after`: 游标, `limit`: 分页条数 | 获取严格归属于指定 Run 的可读 Activity 列表、每阶段 fleet 运行态以及有界的 coordinator check receipt。 |
| `GET` | `/api/activity/stream?run=<id>` | `run`: Run ID | 获取指定 Run 的实时 SSE (Server-Sent Events) 快照流；页面隐藏时（`document.visibilityState === 'hidden'`）自动暂停连接，重新可见时刷新重连，保留轨道收起期间的未读计数。 |
| `POST` | `/api/messages/:id/reply` | `{ body: string, runId: string, coordinatorControl? }`, `:id`: 消息 ID | 使用持久化操作员消息助手（`operatorMessages.ts`）在 `sessions.json` 记录 checkpoint 后回复；合并输入提问（`[orca-dag:merge-inputs-v3]`，本地契约标记）返回 StageGit 不可变提交 SHA。未在当前活跃调度下时需要 `coordinatorControl`。 |
| `POST` | `/api/messages/:id/acknowledge-stop-event` | `{ runId, dispatchId }` | 记录操作员对指定 live Run/Dispatch 停止事件的确认，不合成 Task 成功。 |
| `POST` | `/api/tasks/:taskId/messages` | `{ runId, body, subject?, threadId? }` | 由当前 viewer 的活跃 coordinator 向经验证的活动 Task Dispatch 发送指导。返回带类型的 `TaskMessageReceipt`（`ok: true, kind: "enqueued" | "follow_up" | "recipient_run_bound_redirect", runId, taskId, dispatchId, requestedTaskId, requestedDispatchId, followUpOf, requestId, destinationRunId`）。正面证实的嵌套 coordinator 重定向明确区分源 Task/Dispatch 与实际目标 Run，不篡夺子所有权，不凭空生成 worker。 |
| `GET` | `/api/audiences?run=<id>` | `run`: Run ID | 获取当前 Run 的群发受众预览（包含 `@all` 及已发现的有效 worktree），携带当前 coordinator 活跃状态与发现错误。 |
| `POST` | `/api/messages/group` | `{ runId, audience, body, subject?, type?, priority?, coordinatorControl? }` | 向白名单受众发起广播通知。禁止发送生命周期消息（报 `forbidden_group_type`），处理 `recipient_run_bound_redirect` 告警；未在当前活跃调度下时需要 `coordinatorControl`。 |
| `POST` | `/api/gates` | `{ runId, taskId, question, coordinatorControl? }` | 为同 Run 尚未派发的任务创建规范审批门（`--options '["approved","rejected"]'`）。受 coordinator 生命周期锁（`withLifecycleMutation`）与请求审计保护。任务已派发、已有门或主机观测不完整时以 `gate_not_eligible` 拒绝。未在当前活跃调度下时需要 `coordinatorControl`。 |
| `POST` | `/api/gates/:id/resolve` | `{ resolution: "approved" \| "rejected" \| "integrated", runId: string, coordinatorControl? }` | 解决指定的审批门或跨 lane 集成门决策。未在当前活跃调度下时需要 `coordinatorControl`。 |
| `GET` | `/api/workers?run=<id>` | `run`: Run ID | 获取指定 Run 的有类型 `WorkerInventory`（`{ workers: OrcaWorkerRow[], partialHostErrors: unknown[] }`）。跨页汇总保留 `partialHostErrors`；远端主机缺失代表证据不全，绝不误判为已退出或借此清除债务。 |
| `GET` | `/api/workers/:dispatchId?run=<id>` | `:dispatchId`: Dispatch ID, `run`: Run ID | 获取单个 worker 的持久化记录与 `worker-show` 证据（Dispatch/Worker 详情、PTY 事实、等待人工输入的 agentWait 证据）。 |
| `GET` | `/api/session-bindings?run=<id>` | `run`: Run ID | 列出当前工作区下指定 Run 已绑定的精确 provider session 映射列表（不向 provider 发起探测）。 |
| `PUT` | `/api/session-bindings/:dispatchId` | `{ runId, taskId, harness, sessionId }` | 重新校验 worker 与执行位置后，绑定已知的 provider session ID 并写入 `.orca-dag/sessions.json`。 |
| `POST` | `/api/session-bindings/:dispatchId/probe` | `{ runId: string }` | 按需向 provider 探测该 Dispatch 已绑定的 session 状态；结果仅为观测数据，绝不作为 Task 结算依据。 |
| `POST` | `/api/workers/:dispatchId/resolve-blocked` | `{ runId, result, acknowledgeUnknownProvider: true, coordinatorControl? }` | 将人工核对结果写入已退出 worker 对应的受阻任务，使任务落定；原 Dispatch 保持失败状态。未在当前活跃调度下时需要 `coordinatorControl`。 |
| `GET` | `/api/workers/:dispatchId/output?run=<id>` | `?run=<id>&source=auto/terminal/transcript&cursor=&limit=` | 分页获取指定 worker 的有界输出日志（限制 1–200），必须显式提供 `run` 作用域。 |
| `GET` | `/api/workers/:dispatchId/output/stream?run=<id>` | `run`: Run ID | 服务端统一 `OutputTailManager` SSE 流（`init`、`delta`、`liveTool`、`status`、`drained`），复用单条上游 `worker-read` 轮询并由伴生插件 Hook 提前唤醒。 |
| `GET` | `/api/workers/:dispatchId/resume-preview?run=<id>` | `run`: Run ID | 预检已退出本机已验证 worker 的 L1 原生会话恢复资格（结合 `sessions.json` 绑定与插件 `workspace.list`/`agent.listSessions` 发现）。 |
| `POST` | `/api/workers/:dispatchId/resume` | `{ runId, sessionId?, coordinatorControl? }` | 通过伴生插件调用 Orca 原生 `agent.resume` 并经 `worker-start --terminal --retry-of` 绑定新 Dispatch，全流程写入 `sessions.json` `resumeAttempts`。 |
| `POST` | `/api/workers/:dispatchId/permission` | `{ runId, promptId, decision: "approve"\|"deny", reason?, coordinatorControl? }` | 在 Orca ≥ 1.4.263 上对挂起的 Worker 权限弹窗进行单次放行或拒绝（`orchestration approve` / `deny`）。 |
| `POST` | `/api/workers/:dispatchId/stop` | `:dispatchId`: Dispatch ID | 停止一个经正面证实存活的 Dispatch。操作前重新读取 `worker-show` 并记录请求 ID；若通信丢失返回 `502 response_lost` 与请求 ID。 |
| `POST` | `/api/workers/:dispatchId/abandon` | `:dispatchId`: Dispatch ID | 针对已退出或结果未知的尝试调用 `worker-abandon` 隔离编排权限；若 Orca 能证明 worker 仍存活则以 `abandon_refused` 拒绝。 |
| `POST` | `/api/workers/:dispatchId/focus` | `:dispatchId`: Dispatch ID | 聚焦到本地 worker 所在的终端（`terminal switch`）；必须具备新鲜的 `agentWait` 证据，否则禁用。 |
| `GET` | `/api/requests?run=<id>` | `run`: Run ID | 获取当前工作区已记录的变更请求审计列表，按 Run 划分作用域。 |
| `GET` | `/api/requests/:requestId?run=<id>` | `:requestId`: 请求 ID | 查询单条请求的账本记录，并向 Orca 发起实时的只读 `request-show` 探测：返回 `{ state, interpretation, outcome }`。 |
| `POST` | `/api/workers/:id/release` | `{ runId }`, `:id`: Worker/Dispatch ID | 对已落定的 worker 显式执行终端释放。请求体必须提供 `runId`。 |
| `POST` | `/api/workers/:id/retain` | `{ runId }`, `:id`: Worker/Dispatch ID | 显式将已落定的 worker 终端置为保留状态，供人工排错。请求体必须提供 `runId`。 |
| `POST` | `/api/workers/:id/retry` | `:id`: Worker/Dispatch ID | 针对明确失败的尝试重新发起调度（继承原 harness、模型、effort 和放置参数）。 |
| `POST` | `/api/files/open` | `{ path, worktree? }` | 在 Orca 编辑器中打开指定工作区下的文件进行审阅（仅限本地）。 |
| `POST` | `/api/files/diff` | `{ path, worktree? }` | 在 Orca 编辑器中查看指定文件的 diff 差异对比。 |
| `POST` | `/api/files/open-changed` | `{ worktree }` | 在 Orca 编辑器中打开指定工作区的所有已变动文件。 |
| `POST` | `/api/worktrees/remove` | `{ worktree, deleteBranch?: boolean, runHooks?: boolean, force?: boolean, allowFailedArchiveHook?: boolean, evidenceRequestId?: string, runId?: string }` | 调用 `orca worktree rm --worktree <worktree>` 移除工作树。传入 `deleteBranch: true` 时原生安全删除已合并分支，未合并分支如实保留；返回 `{ ok: true, requestId, receipt: { worktree, archiveHookOverride, preservedBranch, raw } }`。必须提供已落定证据，核查全局完整 fleet 列表（`listWorkers(undefined, { includeRemote: true })`）以保护未在终端列表中的其他 Run Chat，且受主工作区与活跃工作区保护。 |
| `GET` | `/api/models/:harness` | `:harness`: Harness 名称 | 本地工作区范围（`scope: "local-workspace"`）的模型建议性发现接口。返回 `{ harness, status, models, diagnostic, scope }`。OpenCode 校验正则支持首斜杠后带命名空间的格式：`^[A-Za-z0-9._-]{1,128}/[A-Za-z0-9][A-Za-z0-9._:/-]{0,511}(?:#[A-Za-z0-9._-]{1,128})?$`。 |
| `GET` | `/api/environments` | 无 | 获取已保存的远程连接环境列表（`environment list`），包含对端通告的能力集。 |
| `GET` | `/api/environments/:envId/worktrees?repo=` | `:envId`: 环境标识符, `repo`: 仓库路径 | 获取远程环境上的精确工作区选择器（格式为 `id:<repoId>::<path>`）。 |
| `GET` | `/api/environments/:envId/repos` | `:envId`: 环境标识符 | 获取远程环境上已注册的仓库列表（用于新建顶层工作树）。 |
| `GET` | `/api/environments/:envId/projects` | `:envId`: 环境标识符 | 获取远程环境上可见的项目分组列表。 |
| `GET` | `/api/config` | 无 | 读取当前工作区的偏好配置（`.orca-dag/config.json`）。 |
| `PUT` | `/api/config` | 合并配置对象 | 合并并更新当前工作区的偏好配置。 |
| `GET` | `/api/health` | 无 | 基础服务健康检查接口，返回 `{ ok, workspace, worktree }`。 |

### 原生伴生插件桥接路由（`/api/plugin/*`）

以下路由仅接受存于 `0o600` `<workspace>/.orca-dag/endpoint.json` 中的独立进程级令牌 `x-orca-plugin-token`（浏览器 SPA 与侧边栏代理禁止访问 `/api/plugin/*`）：

| 方法 | 路由路径 | 参数与请求体说明 | 功能语义与行为规范 |
|---|---|---|---|
| `POST` | `/api/plugin/hello` | `{ pluginId, version, hostApiMinor, grantedCapabilities, workspacePath, workspaceId }` | 注册运行中的 `orchestration-panel` 伴生插件并刷新连接心跳。 |
| `POST` | `/api/plugin/events` | `{ events: [...] }` | 接收有界批量的 `agent.status.changed`、只读 `agent.tool.after`（仅存内存环形缓冲，绝不落盘 `activity.jsonl`）与 `agent.prompt.before`，并唤醒 `OutputTailManager`。 |
| `GET` | `/api/plugin/inbox` | 无 | 长轮询待执行的 viewer → plugin 指令（`workspace.list`、`agent.listSessions`、`agent.resume`、`notification.show`、`statusBar.update`）。 |
| `POST` | `/api/plugin/receipts/:commandId` | `{ ok, result?, error? }` | 回传对应指令 ID 的执行结果或错误回执。 |

### 指导消息投递、恢复与后续任务生命周期

`POST /api/tasks/:taskId/messages` 严格校验当前 viewer 是否拥有该 `runId` 的活跃 coordinator、目标任务是否存在活跃 Dispatch，以及 fleet 并发配额（包含可见 helper 与未决不确定性）是否允许发送：
- **带类型的回执与身份区分**：接口返回 `{ ok: true, ...receipt }`，显式区分请求的 ID（`requestedTaskId`, `requestedDispatchId`）与实际返回的 ID（`taskId`, `dispatchId`）。`kind: "enqueued"` 表示投递到原 Dispatch，无新任务；`kind: "follow_up"` 表示创建或路由了后续工作（`followUpOf` 记录父级谱系）。
- **持久化落盘与不可变启动证据**：调用原生 Orca 前，coordinator 先将包含请求身份及请求目标身份的 `guidanceSends` checkpoint 写入 `.orca-dag/sessions.json`。接受原生回执后才记录 `creationProven` 与清洗后的不可变 `startEvidence`（`status`, `launchMode`）；缺失的证据不会被补造。
- **调和 vs 新投递（`guidance_reconciled`）**：若同一目标的先前指导处于未确认状态（`prepared` 或 `unknown`），后续调用会先通过 `request-show` 进行只读恢复（`recoverTaskGuidance`），不发送新内容。若先前操作成功恢复，则抛出 `guidance_reconciled`（“Previous guidance request was reconciled; submit the new guidance again”），表明先前操作已解决，调用方须重新提交新内容，不能将旧回执误判为新投递。先前请求若仍未解决则抛出 `guidance_unknown`；未决指导占用 fleet 并发配额并阻止盲目重发。
- **Stop 归属与配额债务**：coordinator 仅追踪证实由 viewer 创建的后续根任务（`creationProven: true`）或完全匹配的账本根任务。`POST /api/run-stop` 尝试清理全部归属已证实的根任务，包括后续任务，返回 `{ ok: true, clean, results }`。未决发送或未知清理结果使 `clean: false`；每项结果明确给出 `target`、`kind`、`result` 与 `detail`。

### 输出与启动模式证据

输出响应为 `{ output: ... }`。原生输出回执包含可选证据 `fallbackReason`、`sourceExact`、`archived`、`provider` 与 `sourceIdentity`。缺失或 null 表示未知，并非 false；显式 `false` 具有实际语义并完整保留。这些字段描述返回的来源，不证明完整历史、Task 落定或清理权限。`sourceChanged` 表示来源重置；分页仍有界。Orca 提供时，原生启动回执还可包含 `launchMode`（`mode`、`preferred`、`reason`、`detail`），作为界面证据如实透传，不脑补确定性。启动回执亦上报 `keepOpen` 保留状态（`retained`、`already_released`、`release_pending`、`no_owned_resource`、`unknown`）；启动被接受后即使后续保留异常也不会回退启动或意外释放。

### 关键状态恢复与热降级防线

`.orca-dag/sessions.json` 除了 provider session 绑定外，还持久化关键恢复账本：
- `mailboxChecks`：消费式 check 与旧版 ACK 的持久 checkpoint，记录 `requestId`、`delivery`、`processedMessageIds`、`pendingQuestionIds` 以及每题的 `replyRequests`。进程重启后，未完成的提问与流转批次会在新 check 之前恢复。
- `guidanceSends`：coordinator 指导消息的持久 checkpoint，跟踪 `requestId`、`state`（`prepared`、`unknown`、`enqueued`、`follow_up`、`refused`）、`receipt`、`creationProven` 及清洗后的 `startEvidence`。
- `operatorMessages`：非活跃 coordinator 提问回复与群发消息的持久 checkpoint 清单，在调用 Orca CLI 前落盘，通过只读 `request-show` 调和未知结果，防止盲目重复重发。
这些账本是**故障恢复依据**，而非普通滚动审计日志。不支持新字段的旧版读取器会直接报错（`session binding store contains unknown fields`），因此包含未结算关键账本的 `sessions.json` 无法安全热降级至旧版读取器。
### Run 健康度与已移除工作账本

`GET /api/run-health` 返回聚合的健康与归属数据，`GET /api/runs/:runId/removed-work` 支持按需分页加载已移除条目：

```json
{
  "health": {
    "runId": "run_01j7...",
    "ownership": "viewer_coordinator",
    "ownershipDetail": "...",
    "coordinatorHandle": "term_coord_1",
    "consumerGeneration": 1,
    "counts": { "tasks": 4, "messages": 1, "workers": 2, "gates": 0, "pendingGates": 0 },
    "evidenceComplete": true,
    "removedWork": {
      "coverage": "complete",
      "recordedSince": "2026-10-29T00:00:00Z",
      "tasks": 2,
      "dispatches": 2,
      "workers": 1,
      "terminals": 1,
      "activeWorkersAtRemoval": 0,
      "lastRemovedAt": "2026-10-29T01:00:00Z"
    },
    "warnings": []
  }
}
```

```json
{
  "page": {
    "entries": [
      {
        "seq": 1,
        "id": "worker_01j7...",
        "kind": "worker",
        "removedAt": "2026-10-29T01:00:00Z",
        "activeAtRemoval": false
      }
    ],
    "page": {
      "hasMore": false,
      "nextCursor": null
    }
  }
}
```

- **可空 `removedWork` 摘要**：内部 `showRun` 适配器保留 `{ run, removedWork }`；HTTP 客户端通过 `health.removedWork` 读取摘要。旧宿主缺少字段、可选账本读取失败或摘要格式错误时为 `null`，绝不把缺失证据补成 0。
- **按需作用域分页**：已移除工作明细不在初次健康检查时全量加载，仅在界面显式展开时按需拉取，单页受 Orca 官方 200 行上限约束。
- **不透明游标校验**：游标参数必须为 1–2048 字符的字符串；非法游标返回 HTTP `400 invalid_cursor`。当 `page.hasMore` 为 `true` 但 `nextCursor` 未能推进行进（为 `null` 或与当前游标相同）时，服务端返回 HTTP `502 invalid_page_cursor`。
- **历史活动 vs 存活 Fleet**：worker 条目的 `activeAtRemoval: true` 表示移除跟踪时它可能仍在运行；这既不是历史进程存活证明，也不是当前存活判决。
- **前向兼容与 Kind 弹性**：支持已知标准 kind（`task`, `dispatch`, `worker`, `terminal`, `remote_worker`, `federated_worker`）；未来或未知 kind 会被标记为 `unreadable: true` 并在界面安全降级展示，不阻断渲染。
- **只读账本与无重置**：已移除工作历史为只读审计事实，viewer 不提供重置按钮或任何修改/清空端点。

### 本地模型建议性发现接口

```json
// 发现成功 / 填充目录 (本地工作区)
{
  "harness": "opencode",
  "status": "available",
  "models": [
    "anthropic/claude-3-5-sonnet-20241022",
    "deepseek/deepseek-chat"
  ],
  "diagnostic": null,
  "scope": "local-workspace"
}
```

```json
// 发现失败 (受控英文诊断)
{
  "harness": "opencode",
  "status": "unavailable",
  "models": [],
  "diagnostic": "OpenCode model discovery timed out after 20 seconds",
  "scope": "local-workspace"
}
```

- **作用域限制**：严格限定于本地 viewer 工作区（`scope: "local-workspace"`，执行 `opencode models`），绝不探测远程执行环境或非当前 worktree。
- **状态与诊断分类**：
  - `status: "available"`：`models` 为匹配 `^[A-Za-z0-9._-]+/[A-Za-z0-9._-]+(?:#[A-Za-z0-9._-]{1,64})?$` 的模型标识数组。若查询成功但目录为空，返回 `{ status: "available", models: [], diagnostic: null }`。非 OpenCode harness 直接返回 `status: "available"`、空 `models` 及 `diagnostic: null`。
  - `status: "unavailable"`：发现执行失败（CLI 缺失 → `"OpenCode CLI was not found"`；20 秒超时 → `"OpenCode model discovery timed out after 20 seconds"`；退出码 → `"OpenCode model command failed (exit code <N>)"`；常规失败 → `"OpenCode model discovery failed"`）。`models` 为空列表；绝不向客户端泄露 stderr 或底层异常堆栈。
- **建议性语义**：模型目录发现仅作为本地工作区配置的输入参考。发现失败或目录为空均不妨碍手动填写合法模型，目录中的模型亦不代表远端宿主必定就绪。
