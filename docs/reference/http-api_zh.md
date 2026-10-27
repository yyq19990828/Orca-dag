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
4. **自定义 Harness 命令限制**：
   - 默认状态下，viewer 仅允许调度已知且经过适配的内置 harness（如 `claude`、`codex`、`opencode`、`gemini`、`grok`、`cursor`、`droid`、`kimi` 等）。
   - 任何未知的自定义命令（例如直接运行 `aider` 等）将被服务拒绝，并返回 `custom_commands_disabled` 错误。
   - 只有在启动 viewer 时显式声明环境变量 `ORCA_DAG_ALLOW_CUSTOM_COMMANDS=1`，方可解锁自定义命令。
5. **严密的基础校验与防注入**：
   - 所有输入的 Run ID、Task ID、Gate ID、harness 名称、`provider/model` 路径、并发上限数值等，在 HTTP 边界均经过严格的白名单和格式校验。
   - 后端调用 Orca CLI 时采用已解析的纯 argv 参数列表，执行选项强制设为 `shell: false`，杜绝任何 shell 命令注入风险。

## 就绪探测与只读模式

在尝试执行或调度 DAG 之前，前端通过 `GET /api/readiness` 探测底层环境状态：

- 接口响应格式为：`{ cli, workspace, worktree, version, executionEnabled, reason }`。
- **执行门槛（Orca ≥ 1.4.205）**：启动 Run、解决审批门、新建 Run 等修改类操作仅在 Orca 版本满足要求时开放。
- **只读降级（Orca 1.4.160–1.4.204）**：UI 界面上所有执行和决策按钮将自动置灰禁用（Run 按钮提示 "View-only"，Gate 按钮附带版本原因）。若外部脚本绕过界面直接发起变更请求，服务端将直接返回 HTTP `503 execution_disabled`。
- **只读操作不受影响**：无论是否具备执行能力，DAG 结构渲染、Run 列表查看、终端状态以及本地偏好读取等功能始终正常可用。
- **协调者冲突（HTTP 409）**：当另一个 viewer 实例已经绑定并正在协调当前工作区时，启动 coordinator 的请求将返回 `409 coordinator_conflict`，防止并发冲突。

## 完整路由清单与语义说明

所有 `POST` / `PUT` 路由均要求携带 `X-Orca-Dag-Token` 请求头；`GET` 路由在回环地址上开放。

| 方法 | 路由路径 | 参数与请求体说明 | 功能语义与行为规范 |
|---|---|---|---|
| `GET` | `/api/session` | 无 | 获取当前进程的 mutation token 以及自定义命令启用状态（响应头包含 `Cache-Control: no-store`）。 |
| `GET` | `/api/readiness` | 无 | 获取解析出的 CLI 路径、工作区信息、Orca 版本以及是否允许执行；若不可执行，附带可操作的原因说明。 |
| `GET` | `/api/capabilities` | 无 | 获取 Orca 运行时能力矩阵：包含版本信息及各项编排能力的状态（`supported / alias / absent`）；未知能力保持列出但关闭。 |
| `GET` | `/api/run-health?run=<id>` | `run` (查询参数): Run ID | 评估指定 Run 的健康与归属状态：返回状态（`viewer-owned / external / unbound / inconsistent`）、coordinator 句柄、按来源划分的任务计数与警告。 |
| `GET` | `/api/dag?run=<id>` | `run`: Run ID | 获取指定 Run 的完整 DAG 结构，包括 `{ runId, nodes, edges, hierarchy, gates, readyWave, readiness, generatedAt }`。 |
| `GET` | `/api/runs` | 无 | 列出精确归属于当前工作区的 Run 列表（基于任务创建者的 worktree 身份过滤，排除其他工作区的不相关 Run）。 |
| `GET` | `/api/runs/page?cursor=` | `cursor` (可选): 不透明游标 | 分页读取原始 `run-list` 注册表；透传游标，每行携带轻量级本地归属证据。 |
| `GET` | `/api/runs/:runId` | `:runId` (路径参数): Run ID | 通过 `run-show` 精确查找单个 Run 及其工作区归属证据；仅在 Orca 确认不存在时返回 `run_not_found`，外来工作区 ID 按不存在处理。 |
| `POST` | `/api/runs` | `{ objective?: string }` | 在当前工作区创建一个新的空 Run（通过一次性临时 coordinator 终端完成创建，避免占用主循环）。 |
| `GET` | `/api/terminals` | 无 | 列出当前 Orca 运行时的所有终端实例。 |
| `POST` | `/api/run` | `{ runId, harnessByTask?, modelByTask?, effortByTask?, retainByTask?, environmentByTask?, placementByTask?, worktreeLanes?, laneByTask?, defaultHarness?, maxConcurrency? }` | 启动自驱动 coordinator 循环开始调度指定的 Run。若当前环境只读则返回 503，若已在协调则返回 409。 |
| `POST` | `/api/run-stop` | 无 | 停止当前正在运行的 coordinator 调度循环，并安全回收/结算所有已派发的活跃 worker。 |
| `GET` | `/api/run-status` | 无 | 获取 coordinator 的实时调度状态：`{ running, busy, attempts, inbox, cleanupDebt, recovery, … }`。 |
| `GET` | `/api/worktree-lanes?run=<id>` | `run`: Run ID | 获取指定 Run 的 workspace lane 规划以及每条 lane 由 Orca 推导的运行时身份（包含状态、精确选择器、worktree ID、路径、分支、HEAD 和来源）。 |
| `POST` | `/api/worktree-lanes/:laneId/open-changed` | `:laneId`: Lane 标识符 | 在 Orca 编辑器中打开指定 lane 本地工作区的改动文件和 diff（工作区身份不可验证时禁用）。 |
| `POST` | `/api/worktree-lanes/:laneId/remove` | `:laneId`: Lane 标识符 | 调用 `orca worktree rm` 显式移除已验证且已落定的 lane 工作区；需要归属落定与显式确认，归档钩子失败原样暴露，绝不自动豁免。 |
| `GET` | `/api/worktrees` | 无 | 获取 Orca 发现的本地工作区列表（`worktree list`）；作为精确已有放置（existing placement）的选择器来源，绝不通过文件系统猜测。 |
| `GET` | `/api/worktrees/:worktreeId` | `:worktreeId`: Worktree 标识符 | 通过 `worktree show` 读取单个工作区的持久身份；仅在 Orca 明确不存在时返回 404，传输错误如实向上传播。 |
| `GET` | `/api/repos` | 无 | 获取 Orca 发现的本地注册仓库列表（`repo list`）；作为新建顶层工作树（new top-level）的选择器来源。 |
| `GET` | `/api/inbox?run=<id>` | `run`: Run ID | 兼容接口：获取指定 Run 的待处理提问、升级项及未处理的清理债务。 |
| `GET` | `/api/activity?run=<id>&after=&limit=` | `run`: Run ID, `after`: 游标, `limit`: 分页条数 | 获取严格归属于指定 Run 的可读 Activity 列表、每阶段 fleet 运行态以及有界的 coordinator check receipt。 |
| `GET` | `/api/activity/stream?run=<id>` | `run`: Run ID | 获取指定 Run 的实时 SSE (Server-Sent Events) 快照流；前端在连接异常时自动回退为有界轮询。 |
| `POST` | `/api/messages/:id/reply` | `{ body: string, runId: string }`, `:id`: 消息 ID | 回复 worker 提出的升级提问；发送成功代表 Orca 已将消息持久化入队。 |
| `GET` | `/api/audiences?run=<id>` | `run`: Run ID | 获取当前 Run 的群发受众预览（包含 `@all` 及已发现的有效 worktree），携带当前 coordinator 活跃状态与发现错误。 |
| `POST` | `/api/messages/group` | `{ runId, audience, body, subject?, type?, priority? }` | 向白名单受众发起广播通知。禁止发送生命周期消息（报 `forbidden_group_type`），未发现受众报 `unknown_audience`，非活跃协调者报 409。 |
| `POST` | `/api/gates/:id/resolve` | `{ resolution: "approved" \| "rejected" \| "integrated", runId: string }` | 解决指定的审批门或跨 lane 集成门决策。 |
| `GET` | `/api/workers?run=<id>` | `run`: Run ID | 获取指定 Run 完整、包含远程记录的 worker 历史列表（存活状态、终端信息、投影数据），作为启动偏好锁定的持久化证据。 |
| `GET` | `/api/workers/:dispatchId?run=<id>` | `:dispatchId`: Dispatch ID, `run`: Run ID | 获取单个 worker 的持久化记录与 `worker-show` 证据（Dispatch/Worker 详情、PTY 事实、等待人工输入的 agentWait 证据）。 |
| `GET` | `/api/session-bindings?run=<id>` | `run`: Run ID | 列出当前工作区下指定 Run 已绑定的精确 provider session 映射列表（不向 provider 发起探测）。 |
| `PUT` | `/api/session-bindings/:dispatchId` | `{ runId, taskId, harness, sessionId }` | 重新校验 worker 与执行位置后，绑定已知的 provider session ID 并写入 `.orca-dag/sessions.json`。 |
| `POST` | `/api/session-bindings/:dispatchId/probe` | `{ runId: string }` | 按需向 provider 探测该 Dispatch 已绑定的 session 状态；结果仅为观测数据，绝不作为 Task 结算依据。 |
| `POST` | `/api/workers/:dispatchId/resolve-blocked` | `{ runId, result, acknowledgeUnknownProvider: true }` | 将人工核对结果写入已退出 worker 对应的受阻任务，使任务落定；原 Dispatch 保持失败状态。 |
| `GET` | `/api/workers/:dispatchId/output` | `source`: auto/terminal/transcript, `cursor`, `limit` (1–200) | 分页获取指定 worker 的有界输出日志，标记日志来源（终端归档或精确 transcript）。 |
| `POST` | `/api/workers/:dispatchId/stop` | `:dispatchId`: Dispatch ID | 停止一个经正面证实存活的 Dispatch。操作前重新读取 `worker-show` 并记录请求 ID；若通信丢失返回 `502 response_lost` 与请求 ID。 |
| `POST` | `/api/workers/:dispatchId/abandon` | `:dispatchId`: Dispatch ID | 针对已退出或结果未知的尝试调用 `worker-abandon` 隔离编排权限；若 Orca 能证明 worker 仍存活则以 `abandon_refused` 拒绝。 |
| `POST` | `/api/workers/:dispatchId/focus` | `:dispatchId`: Dispatch ID | 聚焦到本地 worker 所在的终端（`terminal switch`）；必须具备新鲜的 `agentWait` 证据，否则禁用。 |
| `GET` | `/api/requests?run=<id>` | `run`: Run ID | 获取当前工作区已记录的变更请求审计列表，按 Run 划分作用域。 |
| `GET` | `/api/requests/:requestId?run=<id>` | `:requestId`: 请求 ID | 查询单条请求的账本记录，并向 Orca 发起实时的只读 `request-show` 探测：返回 `{ state, interpretation, outcome }`。 |
| `POST` | `/api/workers/:id/release` | `:id`: Worker/Dispatch ID | 对已落定的 worker 显式执行终端释放。 |
| `POST` | `/api/workers/:id/retain` | `:id`: Worker/Dispatch ID | 显式将已落定的 worker 终端置为保留状态，供人工排错。 |
| `POST` | `/api/workers/:id/retry` | `:id`: Worker/Dispatch ID | 针对明确失败的尝试重新发起调度（继承原 harness、模型、effort 和放置参数）。 |
| `POST` | `/api/files/open` | `{ path, worktree? }` | 在 Orca 编辑器中打开指定工作区下的文件进行审阅（仅限本地）。 |
| `POST` | `/api/files/diff` | `{ path, worktree? }` | 在 Orca 编辑器中查看指定文件的 diff 差异对比。 |
| `POST` | `/api/files/open-changed` | `{ worktree }` | 在 Orca 编辑器中打开指定工作区的所有已变动文件。 |
| `POST` | `/api/worktrees/remove` | `{ worktreeSelector, confirmed: true }` | 使用精确选择器调用 `orca worktree rm` 移除工作树；必须提供已落定证据，否则以 `removal_evidence_required` 拒绝。 |
| `GET` | `/api/models/:harness` | `:harness`: Harness 名称 | 获取指定 harness 支持的模型列表（当前由 OpenCode 提供枚举能力）。 |
| `GET` | `/api/environments` | 无 | 获取已保存的远程连接环境列表（`environment list`），包含对端通告的能力集。 |
| `GET` | `/api/environments/:envId/worktrees?repo=` | `:envId`: 环境标识符, `repo`: 仓库路径 | 获取远程环境上的精确工作区选择器（格式为 `id:<repoId>::<path>`）。 |
| `GET` | `/api/environments/:envId/repos` | `:envId`: 环境标识符 | 获取远程环境上已注册的仓库列表（用于新建顶层工作树）。 |
| `GET` | `/api/environments/:envId/projects` | `:envId`: 环境标识符 | 获取远程环境上可见的项目分组列表。 |
| `GET` | `/api/config` | 无 | 读取当前工作区的偏好配置（`.orca-dag/config.json`）。 |
| `PUT` | `/api/config` | 合并配置对象 | 合并并更新当前工作区的偏好配置。 |
| `GET` | `/api/health` | 无 | 基础服务健康检查接口，返回工作区物理路径。 |
