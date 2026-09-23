# 教程：操作 orca-dag viewer

[English](viewer-operations.md) | 简体中文

本教程覆盖启动、配置、监控、恢复和 viewer 的 API 边界。完整任务图示例见[编排教程](orchestration_zh.md)，工作区规则见[隔离教程](worktree-isolation_zh.md)。[中文 README](../../README_zh.md)保留完整的功能和接口清单。

viewer 作为独立进程运行，是因为 Orca 有意不内置调度器，而 Orca 插件面板也无法请求本 viewer 的 HTTP API。应用在本机回环地址提供 API 和 SPA，并可把界面打开到普通 Orca 浏览器标签。viewer 的 coordinator 调度 Task；Run、Dispatch、worker 和工作树的权威状态仍由 Orca 管理。

## 启动参数

从 **Orca 管理的工作区根目录**启动。viewer 只在进程启动时解析一次 CLI 和工作区；默认工作树选择器是该目录的真实路径。如果从子目录启动，创建终端时可能因路径没有注册而得到 `selector_not_found`。

```bash
cd /path/to/orca-managed/project
npx orca-orchestration-launcher
```

如果从 Orca 管理的终端中启动，应清除继承的 Orca 身份，让 viewer 新建的 coordinator 终端正常绑定 Run：

```bash
env -u ORCA_TERMINAL_HANDLE -u ORCA_TAB_ID -u ORCA_WORKSPACE_ID -u ORCA_WORKTREE_ID \
  WORKSPACE_DIR="$PWD" npx orca-orchestration-launcher
```

| 设置 | 默认值 | 作用 |
| --- | --- | --- |
| `PORT` | `8787` | 本机回环地址的 HTTP 监听端口；Vite 开发界面使用 `:5173` 并代理 `/api`。 |
| `NO_OPEN=1` | 关闭 | 不自动打开浏览器。 |
| `WORKSPACE_DIR` | 进程当前目录 | 必须存在；解析成真实路径，作为所有 Orca 调用的 cwd 和默认 `path:` 工作区选择器。 |
| `ORCA_WORKTREE` | `path:<WORKSPACE_DIR>` | coordinator 与 Current worker 的显式 Orca 选择器，可覆盖路径默认值。 |
| `ORCA_CLI_COMMAND` | 自动选择 CLI | 指定准确的可执行文件及带引号的 argv；**不经 shell** 解析。管道、重定向、命令替换及未引用的 `$` 会被拒绝。 |
| `--no-skill` 或 `ORCA_DAG_NO_SKILL=1` | 安装 skill | 跳过将随包提供的 `orca-dag` skill 尽力安装到已有 agent 目录。 |
| `ORCA_DAG_ALLOW_CUSTOM_COMMANDS=1` | 关闭 | 允许自定义 harness 命令。它们走兼容性本地路径，不能使用隔离放置。 |

CLI 自动选择顺序为：`ORCA_CLI_COMMAND` → 设置了 `ORCA_DEV_REPO_ROOT` 时的 `orca-dev` → Linux 且不在 Orca 终端内时的 `orca-ide` → `orca`。读取和修改都使用同一个已解析的 CLI。`GET /api/readiness` 会显示 CLI、工作区、版本及不能执行的原因。Orca 1.4.160–1.4.204 可以查看 Run；执行需要 1.4.205 或更新版本。viewer 和 skill 可以通过 `npx orca-orchestration-launcher` 一起安装，也有独立发布的二进制文件。

## 点击 Run 之前先看懂界面

| 区域 | 展示的信息 | 可执行的操作 |
| --- | --- | --- |
| Run 选择器与健康徽标 | 当前工作区的 Run 历史；coordinator 状态为 `viewer-owned`、`external`、`unbound` 或 `inconsistent`。 | 选择或新建 Run、分页加载旧 Run，或按精确 Run ID 查找。 |
| DAG 与 Stage 卡片 | Task 说明、依赖箭头、单独的父子连线、状态、结果和 worker 实际工作区。 | 选中 Stage，在设置锁定前选择其启动参数。 |
| Scheduler | 就绪波次、可用容量及每个等待中的 Stage 的原因。 | 区分依赖未满足、决策门、无空闲槽位或状态未知。 |
| Chat / Activity | 派工、回复、持久化发送、coordinator 检查和事件时间线。 | 回答问题，或向 Orca 已确认活跃的 Dispatch 发送指导。 |
| Operational details | Workers、决策门、工作区 lane、Recovery、能力和 Request audit。 | 重试、停止、放弃、集成或移除之前先查看证据。 |

DAG 每两秒刷新一次。拖动节点只改变画布位置；布局可选横向/纵向分层或力导向。可选的 **Lead Stage** 只在图中标记语义上的主 agent 阶段，不授予 Orca coordinator 权限。界面支持英文和简体中文，语言选择按浏览器保存。

## 启动选择及其设计逻辑

Orca Task 没有 harness、模型、放置位置或画布布局字段。viewer 将这些选择保存在工作区的 `.orca-dag.config.json`；浏览器 localStorage 只用于一次迁移及写入镜像。此文件存储的是**意图**，不是运行时 ID。实际 Dispatch、工作树、执行主机和终端必须从 Orca 回执和实时读取中取得。

| 设置 | 默认值或允许值 | 效果和限制 |
| --- | --- | --- |
| 默认 harness | `claude` | Stage 没有单独覆盖时使用。已知选项包括 Claude、Codex、OpenCode、Gemini、Grok、Cursor、Droid、Kimi。 |
| Stage harness | 继承默认值 | 选择启动适配器；自定义命令需要 `ORCA_DAG_ALLOW_CUSTOM_COMMANDS=1`。 |
| Stage 模型 | agent 默认值 | OpenCode 列举 `provider/model` ID（可带 `#variant`）；Claude、Codex 和 Cursor 可填写模型名。其他 harness 不显示模型选择器。 |
| Stage effort | 不设置 | Claude、Codex、Cursor 的界面选项是 `low`、`medium`、`high`；同一个 Stage 必须已设置模型，远端还须通告相应能力。 |
| Max parallel | `4`，整数 `1`–`16` | 限制同时启动的 worker 数；DAG 依赖和 lane 可能使实际并行数更低。 |
| Stage 环境/放置 | 本地 / Current | 已保存的远端环境需要精确 Existing 工作区或显式命名的新顶层工作树。见[放置参数](worktree-isolation_zh.md#创建字段及限制)。 |
| 工作区 lane | 无 | 让一串依赖有序的 Task 复用一个非 Current 本地工作区。 |
| Retain for debugging | 关闭 | 保留已落定 worker 的终端，而不按默认行为释放。 |
| 布局 / Lead Stage | 已保存布局 / 无 | 只影响 viewer 呈现，不改变 Task 就绪或 coordinator 绑定。 |

点击 Run 后，这些设置会被快照。coordinator 运行期间，即使 Stage 尚未启动，也会锁定到这份快照。Stage 第一次产生 Dispatch 后，启动设置在 viewer 重启后仍锁定；安全重试会使用原有 harness、模型、effort 和放置位置。如果读取 worker 历史失败，界面也会保持锁定，不能假定从未执行。

一次常规的界面操作顺序是：选定 Run 并查看健康徽标；打开各 Stage，选择 harness 与放置位置；只给依赖有序的任务链分配 lane；设置 Max parallel；核对 Scheduler 的就绪波次和预检警告；点击 **Run with Orca** 并确认 coordinator 交接。执行期间用 Chat 和 Activity 了解进展，需要准确的 worker 或工作区证据才能处理的决定则到 Operational details 查看。

## 点击 Run 后发生什么

viewer 创建与工作区对应的 Orca 终端，并绑定为 Run 的 coordinator。原 coordinator 会被权限隔离；带 Run 作用域的普通读取仍可进行。每一轮，viewer 找出就绪 Task，遵守依赖、门、lane 和 Max parallel，然后让 Orca 启动受监督 worker。`worker_done` 让 Task 落定；viewer 处理并确认收件箱 Delivery，再复用、明确保留或释放每个已落定终端。跨 lane 的汇合要等人确认 `integrated`；viewer 不会合并 Git 分支。

新建 Run、解决 Gate 等单次界面修改会使用单独的临时 coordinator 终端，不借用正在运行的循环终端，否则会把它隔离。第二个指向**同一工作区**的 viewer 会报告 `coordinator_conflict`，而不会接管或关闭第一个 viewer 的终端；不同工作区的 coordinator 身份互不相同。

### 消息、会话与审计证据

Chat 可向一个经 Orca 证实仍活跃的 `dispatch:<id>` 发送指导。群发编辑器只提供 `@all` 或新发现的工作树受众，先预览接收者，再由此 Run 的活跃 viewer coordinator 确认发送。`worker_done` 等生命周期消息不能群发。发送成功只表示 Orca 已持久化入队，不表示 agent 已阅读或接受。

Recovery 能在身份唯一时绑定 Claude、Codex 或 OpenCode 的精确提供方会话，也可由操作者手动提供准确 ID。提供方探测可能返回 `active`、`idle`、`exited`、`unknown` 或 `unavailable`；它只是 Orca Dispatch 状态旁边的一项观察，不能代替落定。未知或断连的尝试继续占用并行槽位。Request audit 会在 CLI 调用前记录 viewer 修改请求的 ID，再通过 `request-show` 区分 `completed`、`pending`、`absent` 和 `unknown`，不会重放操作。

viewer 也通过本地 HTTP API 提供同一套控制。`GET` 是回环地址上的读取；修改类 `POST`/`PUT` 需要同源客户端从 `GET /api/session` 取得的每进程 `X-Orca-Dag-Token`，服务端仍会重新检查版本就绪和输入。核心启动请求体例如：

```json
{
  "runId": "run_example",
  "defaultHarness": "claude",
  "maxConcurrency": 2,
  "harnessByTask": { "task_api": "codex" },
  "modelByTask": { "task_api": "example-model" },
  "placementByTask": { "task_api": { "kind": "new-child", "setup": "run" } }
}
```

`POST /api/run` 还接受 `effortByTask`、`environmentByTask`、`worktreeLanes`、`laneByTask` 和 `retainByTask`。这些 map 使用精确 Task ID 作键。界面从已保存设置构造请求，在启动前验证整个计划；输入无效时显示错误，不创建 worker。`PUT /api/config` 只更新已保存的偏好，不授予 Orca 生命周期权限。其他路由及请求说明见[HTTP API 表](../../README_zh.md#http-接口)。

## 处理受阻或状态不明的 Stage

| 观察结果 | 查看什么 | 下一步 |
| --- | --- | --- |
| Stage 等待中 | Scheduler 原因及 Task 的依赖/门。 | 等待前置任务，解决真正的审批门，或先集成 lane 再选择 `integrated`。 |
| worker 等待输入 | Workers 中的 `agentWait` 和精确的本地终端。 | 只有 Orca 明确报告该等待时才使用 **Focus**。 |
| worker 就绪前启动失败 | 失败阶段、提示和残留资源。 | 清除信任、更新或权限提示，再明确执行 Stop 与 Run；Stage 会被搁置，不自动重试。 |
| Dispatch 失败或停止 | 精确的 worker 记录、Task 状态和原启动参数。 | 使用基于证据开放的重试控件；它会保留原启动选择。 |
| 远端断连或存活状态 `unverifiable` | 包含远端的 worker 历史和 Recovery 观察。 | 继续保留原尝试的占位；缺少信息不能授权停止、重试或替换。 |
| 修改请求响应丢失 | Request audit ID、`request-show` 回执及 Task/worker 状态。 | `completed` 表示已生效；`pending` 要用同一请求身份；仅凭 `absent` 无法得出结论。不要盲目重放。 |

**Stop Run** 停止 viewer coordinator，并按 Dispatch 报告清理结果，包括未知结果。**Stop worker** 只针对一个经证实的 Dispatch。**Abandon** 只隔离编排权限，不声称进程或文件已停止。Task 完成后终端仍可能存活，因此释放或移除工作树前须核对归属。Recovery 面板把提供方会话观察与 Orca Task/Dispatch 权限分开显示。

## 审核、持久化与清理

使用 Workspace lanes 的 **Changed files / Diff** 或文件审核操作，在 Orca 中打开精确的本地工作区。只有目标工作区已经包含预期代码，才解决集成门。lane 已落定，且改动和 worker 归属都已处理后，才能在明确确认下通过 `orca worktree rm` 移除工作树。

几个工作区文件各有用途：`.orca-dag.config.json` 保存偏好，`.orca-dag.activity.jsonl` 保存有界的解释性活动记录，`.orca-dag.requests.jsonl` 保存可审计的修改请求 ID，`.orca-dag.sessions.json` 保存精确的提供方会话绑定。它们都不能代替 Orca 权威的 Run/Task/Dispatch 记录。`orca-dag uninstall` 会移除已安装的 skill 和残留的 viewer coordinator 终端；加 `--purge` 还会移除工作区配置和 Activity 文件。它不会替你集成或发布分支。
