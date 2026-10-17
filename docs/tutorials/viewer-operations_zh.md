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
| `--no-workspace-init` 或 `ORCA_DAG_NO_WORKSPACE_INIT=1` | 初始化 `.orca-dag/` 忽略规则 | 跳过向工作区 `.gitignore` 添加规划产物管理规则；规划前请自行确认 `.orca-dag/` 已被忽略。 |
| `ORCA_DAG_ALLOW_CUSTOM_COMMANDS=1` | 关闭 | 允许自定义 harness 命令。它们走兼容性本地路径，不能使用隔离放置。 |

CLI 自动选择顺序为：`ORCA_CLI_COMMAND` → 设置了 `ORCA_DEV_REPO_ROOT` 时的 `orca-dev` → Linux 且不在 Orca 终端内时的 `orca-ide` → `orca`。读取和修改都使用同一个已解析的 CLI。`GET /api/readiness` 分别报告 `cliVersion`、所选运行时的 `version` 与 `runtimeState`；较新的可执行文件不能证明目标正在运行或已升级。执行要求 CLI 1.4.205+，以及明确处于 ready 状态、稳定 appVersion 为 1.4.205+ 的运行时；状态未知、断连或启动中的运行时保持只读。Orca 1.4.160–1.4.204 仍可查看 Run。viewer 和 skill 可以通过 `npx orca-orchestration-launcher` 一起安装，也有独立发布的二进制文件。

启动时还会提示 `.orca-dag/<timestamp>/{PRD.md,TECH_SPEC.md}` 及默认 `.gitignore` 初始化是否成功。skill 为每个新计划创建独立的 UTC 时间戳目录，记录 Run id，并保留旧计划。这些忽略的文档不提交 Git，也不会自动复制到隔离工作树；Task spec 必须包含 worker 所需信息。旧版 `.orca/` 文档及其忽略管理块原样保留；新规划产物只使用 `.orca-dag/`。

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

Orca Task 没有 harness、模型、放置位置或画布布局字段。viewer 将这些选择保存在工作区的 `.orca-dag/config.json`；浏览器 localStorage 只用于一次迁移及写入镜像。此文件存储的是**意图**，不是运行时 ID。实际 Dispatch、工作树、执行主机和终端必须从 Orca 回执和实时读取中取得。

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

启动阶段被放弃的尝试，即使精确终端已经退出，也可能继续显示 `unverifiable / missing_status`，因为 agent 从未建立状态记录。显式恢复受阻 Stage（`POST /api/run` 携带 `resumeBlocked`）只在新鲜的 `worker-show` 观察证明该 Dispatch 所记录的精确终端已退出且断开连接，并且两次读取均明确报告客户端证据缺口（`missing_status` 或 `capability_unsupported`）时接受该退出证据；不会改写 fleet 判定。仍存活、仍连接、身份不符或仅失联的终端不符合条件。独立的 provider session 检查仍然保留：没有精确绑定的 provider 退出证据时，操作员必须通过 `allowUnknownProvider` 明确接受未知后台工作的风险。单独 Abandon 或关闭任意 pane 都不能授权替代执行。

### 失败的 worker-start 重试链

在 Orca 1.4.226 中，失败的 `worker-start` 会沿确切的 `--retry-of` 链累计。第三次启动失败会把 Dispatch 设为 `circuit_broken`；之后的启动会以 `task_not_startable` 拒绝。worker 成功就绪后再自报 `failed` 不会增加此计数。viewer 会暂停启动前失败的尝试，不会把 Orca 当前 Task 状态当成允许再次启动的证据；显式重试时会让 Orca 重新核验确切 Task 与 Dispatch。

结果未明的重试会保留自己的 request ID 和未结算槽位。Task 上一次 Dispatch 的指针或终态，不能用于识别或结算这个新请求。只有精确匹配当前新 Dispatch、且不是上一尝试的记录明确确认相同结果时，才接受基于 Task 的结算；否则应检查 Request audit，不得启动替代尝试。

Stop/Run 和重启 viewer 都不会重置该链。重试须沿用同一 Task、Run 和确切的上一 Dispatch；还要重新指定目标放置位置，因为 `--retry-of` 不继承它。不要新建 Task 或 Run 来绕过熔断。标准恢复会在归属证据允许时请求 Orca 释放旧的、归 viewer 所有的失败终端；`user_takeover`、显式选择的终端或结构化/外部会话继续遵守原有 retain/release 保护，绝不强制关闭。释放后仍可通过确切 Dispatch 读取归档输出。

若 Codex 在 TUI 初始化时因 `account/read ... workspace routing discovery timed out` 退出并留下未发送草稿，应检查原 Dispatch 和终端，不要补发 Enter。`codex login status` 有效不代表账号/workspace 初始化已成功。先撤销失败尝试的执行权限；关闭用户拥有的终端前须获得许可；仅在满足上述退出证据和 provider 风险门后，对同一个 Task 显式恢复，并保留原启动参数和 `--retry-of` 关系。

### 分开读取监督、终端 ownership 与实际启动参数

Workers 分层展示证据，任何一层都不能替另一层授予权限：

| 字段 | 含义 |
| --- | --- |
| `workerState` / worker 记录 | 保留原始生命周期（如 `starting`、`ready`、`start_unknown`、`succeeded`），不是 `projection.role: worker`。已知 worker 生命周期表示存在受监督记录；`unsupervised` 只是跟踪 Dispatch，未知值仍按未知处理。 |
| 存活 / 确切观察 | Orca 当前是否能观察 worker 或其精确终端。仅凭终端存活，不能证明 agent 正在执行、Task 已落定或拥有进程控制权。 |
| `ownershipState` / `releaseState` / `retainedReason` | 终端归属和清理记账，独立于生命周期。在线且有受监督记录的 Codex，仍可能是 `user_owned / retained / user_takeover`。 |
| 请求 / 实际启动参数 | 意图与 Orca 的实际生效回显分开展示，包含 model 和 effort。结构化 `launch.effective` 优先；缺少、部分缺失或显式 null 的字段，绝不用请求值填补。重启后通过持久化的 `worker.startOptions` 恢复这一区分。 |

ownership 区域对照最初、当前 owner 的 Dispatch ID，以及 worker 和资源的终端 handle。诊断回执保留 endpoint 身份、释放错误及释放/恢复时间。owner 或 handle 不符，不能授权夺回终端。Orca 公开的 custody 回执**没有**提供是哪次输入、哪个操作者触发了 `user_takeover`，也没有专门的接管时间戳；没有额外证据，不能归因于键盘用户或 viewer。参见 [1.4.226 ownership 实现](https://github.com/stablyai/orca/blob/v1.4.226/src/main/runtime/orchestration/db/worker-terminal/worker-terminal-user-takeover.ts)与[资源回执](https://github.com/stablyai/orca/blob/v1.4.226/src/main/runtime/rpc/methods/orchestration/worker/worker-terminal-resource-presentation.ts)。

worker 保持展开时，fleet 轮询仍会更新 ownership。若 fleet 与详情的 custody 读取不一致，原生 Stop 保持禁用，须重新展开该 worker 刷新精确详情；旧的 `owned` 快照不能掩盖新观察到的 ownership 转移。

恢复时，`pending` 和 `dispatched` 都占用并发与 lane 槽位，包括 Task 为 blocked、worker 为 `start_unknown` 的情况。只使用精确 Task 指针或唯一的 Task/Run 历史关联；有歧义就保留占位，不猜最新 worker。每个状态不明的活跃 Dispatch 单独占一个槽。即使 Orca 已清空 `task.dispatch_id`，已落定的 worker 生命周期记录仍可恢复清理。

原生 **Stop worker** 要求生命周期允许，并有正面的存活证据及匹配的 `owned` 终端。`user_owned`、ownership 已转移、缺少 custody 或 handle 不符，都不能授权强行关闭。API 预选模型的 OpenCode 适配器继续使用由服务端选择的 provider 专用 Stop，并独立核实执行和身份。原生 `stop_unknown` 或未知回执，在 Stop 报告、请求审计和清理债务中仍保留为未知；已知终端 handle 不能代替已确认的 Stop。

一次 Orca 1.4.226 只读验收在 API 和中英文 Workers 界面同时确认了 `ready`、有受监督 worker 记录、`user_owned / retained / user_takeover`，以及实际生效的 `codex / gpt-6-luna / max`。这证明解析和诊断有效，不证明终端 ownership 已归还或进程已成功停止。

## 审核、持久化与清理

使用 Workspace lanes 的 **Changed files / Diff** 或文件审核操作，在 Orca 中打开精确的本地工作区。只有目标工作区已经包含预期代码，才解决集成门。lane 已落定，且改动和 worker 归属都已处理后，才能在明确确认下通过 `orca worktree rm` 移除工作树。

5 个状态文件都在 `.orca-dag/` 内：`config.json` 保存偏好，`activity.jsonl` 保存有界的解释性活动记录，`requests.jsonl` 保存可审计的修改请求 ID，`sessions.json` 保存精确的提供方会话绑定，`launches.jsonl` 保存历史派工身份。它们都不能代替 Orca 权威的 Run/Task/Dispatch 记录。升级前请停止旧 viewer：启动时将根目录旧 `.orca-dag.*` 文件迁入，绝不覆盖目标，并打印结果。发生冲突时保留两份文件、使用新位置，需人工核对。无法写入迁移时，旧普通文件仍可读取，新写入绝不回退到根目录；不会顺着符号链接读写目录或文件。

`orca-dag uninstall` 会移除已安装的 skill、残留的 viewer coordinator 终端，以及所选工作区中自己写入且未被修改的 `.orca-dag/` 和旧版 `.orca/` 忽略管理块；用户自写规则会保留。加 `--purge` 只删除新旧位置已知的 viewer 状态文件和已提交 Stage 的 Git 证据，**永远不删除共享目录、时间戳规划目录或其他用户文件**。普通卸载与 `--dry-run` 都不会迁移状态。卸载后如需继续忽略保留的文件，请自行添加相应的忽略规则。它不会删除 Orca Run/Task 历史，也不会替你集成或发布分支。

## 已知局限

viewer 的 `opencode` 选择运行的就是 OpenCode 2。在运行中的 Orca ≥ 1.4.220 且未设置逐节点模型时，Task 使用原生 `worker-start --agent opencode2`。在 OpenCode 2.0.22 上，这条路径已送达只读 Task，并在隔离工作树中自主写入、读回一个文件；Orca 接受 `worker_done`、报告 `agent_status` 并释放终端。选择模型或使用旧版、版本未知的 Orca 时，保留下文的一次性路径。原生启动失败后绝不再启动第二个 worker。当前 `worker-read --source auto` 对 OpenCode 2 会回退到终端输出，无法得到精确的 provider transcript。

后续运行时发现可继续加在这里，写清受影响的启动路径、可观察的现象和已验证的处理方式。Codex TUI 可见、Task 已完成与 Orca 的 worker 存活状态是不同的证据。

### Orca 1.4.229 兼容边界

[Orca 1.4.229](https://github.com/stablyai/orca/releases/tag/v1.4.229) 扩大了原生聊天 worker 的范围，但不能据此认定 viewer 单独使用的 `opencode2` 路径已支持原生模型选择。现有 OpenCode 模型适配器，以及 Codex 创建工作区后验证基准再启动的顺序保持不变。

- **原生拒绝不代表可以降级。** 不支持的 model/effort、无效参数或已知 agent 的 launcher 被禁用时，保留原尝试及回执并停车，绝不启动第二个 legacy worker。显式启用的自定义命令会在任何原生启动之前选择本地 legacy 路径。
- **所有已处理 FIFO 批次都按归属约束确认**，包括只有被拒绝或重复报告的批次。ack 返回的下一批消息也会在 Run 完成前处理；未回答问题和未落定的终端归属仍阻止确认。
- **未决 gate 会阻止完成**，包括没有关联阻塞 Task 的 Run 级 gate。同一 Task 的全部审批都必须明确通过后才会放行。Orca 可能在仅通过一个审批后就报告 `ready`；只要还有未决 gate，该 Task 就不能进入就绪波，其原因仍列入等待清单，且没有其他活动工作时 Run 保持等待输入。
- **Orca 可以纠正暂定启动失败。** Orca 接受精确同一 Run/Task/Dispatch 的迟到成功后，viewer 更新尝试结果，同时保留原启动回执和已执行的 release/retain 决策。旧报告、被拒绝报告或其他 Dispatch 都不能清除失败。

本机 Orca 1.4.229 的只读 smoke 确认了 runtime readiness 与能力发现；所选环境不可达时保持只读，新建 Run 返回 `503 execution_disabled`。构建后页面的浏览器 smoke 还确认：该状态下执行和 **New Run** 均被禁用，而精确 ID 输入仍可编辑。原生拒绝、FIFO 消息、gate 推进和迟到纠正则使用隔离 CLI fixture 运行真实 coordinator 验证，没有启动真实付费 agent；这不代表全部 agent 都通过了 1.4.229 端到端验收。

**真实 agent 认证（2026-10-17）。** Run `run_e78451d88bc7` 在 Orca 1.4.229 上，通过默认的显式模型 one-shot 适配器，使用 OpenCode 2.0.28 和 `deepseek/deepseek-flash` 完成两个依赖任务。两个 OpenCode 会话导出均记录 provider `deepseek`、model `deepseek-flash`，并以 `idle / succeeded` 事件结束；模型使用情况不只是根据请求 argv 推断。

构建后的 viewer 完成了 worker 的阻塞 ask/reply 和第二次审批。第一个 gate 已通过、另一个仍未决时，依赖任务没有被放行。在该检查点暂停并恢复同一 Run，也没有重新启动已完成的生产任务。两个 Dispatch 均经已接受的 `worker_done` 完成；独立重算的 JSON 产物与输入 nonce、整数计算结果、回复 token 和 SHA-256 一致。最终没有未确认 Delivery、清理债务、待回收 worker 或仍存在的实验自有终端。Orca 的跟踪记录仍报告 `terminalState: retained`，而 viewer 对实际 pane 的处置是 `closed`；这不代表原生 `worker-release` 回执。

工作区本地证据保留在 `.orca-dag/e2e-20261017T162611Z-b1d3a6/certificate.json`。本次只认证本地 POSIX 当前工作区的显式模型 one-shot 路径，不代表原生 `opencode2` 模型选择、实验性 API 预选 TUI、远程/Windows 放置或其他 agent 已通过认证。无 Task 绑定的 Run 级 gate，以及原生拒绝、无效/重复报告批次和暂定启动失败后迟到纠正等故障场景，仍由隔离 fixture 验证。


### Orca 1.4.222 兼容边界

[Orca 1.4.222](https://github.com/stablyai/orca/releases/tag/v1.4.222) 会等到 OpenCode 确实能够提交 worker 的 Task，而不只是等输入框出现。这同时适用于原生 `opencode` 和 `opencode2` 启动；viewer 在节点未指定模型时已经使用后者。就绪检测和提交交给 Orca，viewer 不追加 Enter 重试。远程 worker 需要执行主机更新才能使用这项等待逻辑；只更新 Run 所在的主机不能证明它已经生效。

新版原生模型覆盖是另一份契约。在该发布标签的源码中，[`opencode` 模型预检](https://github.com/stablyai/orca/blob/v1.4.222/src/main/opencode/opencode-model-startup-plan.ts) 只接受经过验证的 OpenCode 2.0.16，或[精确的旧版 1.18.30、1.18.32](https://github.com/stablyai/orca/blob/v1.4.222/src/main/opencode/opencode-model-version-policy.ts)，并在执行主机检查模型是否可用。它没有为 `opencode2` 增加启动模型目录。因此，通用的 `orchestration.worker-launch-preferences.v1` 声明不足以开启 viewer 原生分支的模型选择。OpenCode 模型覆盖还要求当前或已有工作区，不能创建新工作树，也不支持 effort 或复用已有终端。viewer 继续让选定模型走现有一次性路径，并保留该路径的放置限制。

coordinator 回归套件覆盖 1.4.220 和 1.4.222：原生完成与释放、原生拒绝后不启动第二个 worker，以及即使声明了模型能力也保留指定模型的兼容路径。较新的 CLI 连接到旧版、预发布或版本未知的运行中应用时，仍走兼容路径。这些模拟 CLI 测试证明路由和生命周期记账，不证明真实 prompt 已提交；运行时验收必须观察到 Task 执行、获接受的 `worker_done` 和终端释放。

若 Orca 拒绝启动并报告 `Agent launcher opencode2 is disabled or unavailable`，检查执行主机上的 **设置 → 智能体 → OpenCode 2**。PATH 上安装了命令并不会自动启用 Orca launcher。启用后 Stop，再 Run，或明确重试失败的 Task。viewer 会保留原始拒绝和请求 ID、补充这条恢复提示，并停住 Task，不启动替代 worker。后续“未创建资源”的清理结论也不再覆盖启动原因。

2026-10-08，Orca 1.4.222 上首次真实只读验收在创建 Dispatch 前被拒绝，原因是当前 profile 禁用了 `opencode2`；PATH 上的两个命令当时已经报告 OpenCode 2.0.15。用户启用 OpenCode 2 后，同一 viewer coordinator 路径通过验收：Run `run_293bfeda1764`、Task `task_eeae01b16f77`、Dispatch `ctx_ff7d6ff78bf4`。worker 阅读 README.md 并发送 `ORCA-14222-E2E-OK`；Orca 记录了获接受的消息 `msg_eeb2e81dec48`、Task `completed` 和 worker `succeeded`。coordinator 通过 `worker_done` 结算、进入 `completed`，并释放 worker 终端。按 Dispatch 查询的 `worker-show` 确认终端资源为 `released`，没有后续动作。所有测试 coordinator 终端已关闭，没有新增终端残留，原有终端均保留。这次验收覆盖本地当前工作树、未指定模型的只读路径；worker 输出仍是有裁剪的终端归档，不是精确的 provider transcript。

### Codex 原生启动与兼容路径

在 Orca 1.4.209、Codex 0.156.1 上，未显式传入 `--enable hooks` 的 Codex TUI 可以执行注入的 Task 并发送 `worker_done`，但 `worker-list` 仍显示 `unverifiable / missing_status`。同一 Run 的 GPT-6 Luna 对照测试中，用 `codex --enable hooks ...` 新启动的 TUI 在任务运行时显示 `live`，来源为 `agent_status`；本机的 `codex features list` 原本就显示 `hooks` 已启用。复用的 Codex app-server 缺少 Orca pane 环境变量是可能的原因，但尚未直接捕获钩子子进程的环境。

Orca 1.4.217 修复了 Codex 就绪检测，并默认隔离每个新终端的后台服务。在 Codex 0.159.2 上的本机只读测试已确认：原生 `worker-start --agent codex` 能观察到回合开始、`live / agent_status`、精确 transcript 和已接受的 `worker_done`。因此，当 `status.runtime.appVersion` 至少为 1.4.217 时，viewer 对当前或已有 POSIX 工作区使用原生启动，直接传入模型与 effort。路径选择依据运行中的应用版本，不能只看较新的 CLI 版本。已有终端需要重新打开，才能获得 Orca 的隔离改动。参见 [1.4.217 发布说明](https://github.com/stablyai/orca/releases/tag/v1.4.217)。

旧版或版本未知的运行时继续使用显式 `--enable hooks` 的预启动后绑定兼容路径。本地新建 POSIX 工作树也保留此路径，使创建及已提交 Stage 模式下的基准 SHA 校验在 worker 启动前完成；原生组合创建尚未在这里完成验收。兼容路径要求连续两帧稳定的空输入框，并拒绝 `model: loading`，但不再要求 `model:` 页脚：Codex 0.159.2 显示的是 `GPT-…`。远程和 Windows Codex 保留原生启动。原生启动失败会记录下来，不自动再启动一个兼容 worker。

在旧版运行时手动启动会话时，应在 Orca 管理的终端中新启动 `codex --enable hooks`；恢复会话可用 `codex --enable hooks resume`。在 Dispatch 运行期间，用 `worker-list` 检查 `liveness.source: agent_status`。仅凭 `missing_status` 不能判断进程已退出，也不能据此重试。`worker-release` 可能保留被归为 `user_takeover` 的终端；终端归属判定与进度、完成监督是否成功是不同的结果。

### OpenCode 的跟踪 Dispatch 没有 fleet 存活证据

对下述显式启用的完整 TUI 适配器，Stop 会确认 API execution 退出后，通过 `worker-abandon` 只做 Orca 取消记账，而非使用不拥有 external 进程的原生 `worker-stop`。随后再次读取落定。如果撤销权限后 release 返回 `retained / identity_unproven`，终端会保留供检查，不强行关闭或伪称原生进程终止。

**实验性替代路径：** `ORCA_DAG_OPENCODE_TUI=1` 会让显式 OpenCode 模型在运行中的 Orca ≥ 1.4.222 上使用 API 预选模型完整 TUI。首版仅支持本机 POSIX 当前/已有、非 lane 工作区；拒绝或回执未知后不回退。Dispatch 属于 supervised，但预建进程对 Orca 仍是 external。准备记录与 session/terminal 身份持久化到 `.orca-dag/sessions.json`；API assistant turn 证明执行，不替代 Task 落定。Orca model/effort 回显仍可能为空。

完整 TUI 准备使用请求独立的 `OPENCODE_TUI_CHANNEL`，避免共享 tab 恢复选中旧会话。它只隔离 TUI 持久化，不改变后端服务发现，也不重写 OpenCode 全局配置。绑定前，viewer 先等待会话生成的精确 `OC | odag:<request>` 标题，再检查 TUI idle；启动 shell 的空闲不算就绪。OpenCode V2 可能把未指定的模型 variant 回显为 `default`：这两种形式等价，但 provider、模型 ID 和显式选择的 variant 仍必须精确匹配。

Output 将有限 assistant 文本标为 `opencode-api` 来源，关闭终端后仍可读取，不复制工具输入或推理。默认清理要求有效落定、明确 external release、精确终端身份和 provider execution 退出；retain 或后续用户输入会保留终端。Stop 先中断精确共享服务会话，再做 Orca 编排记账；服务失败、身份变化或退出未知都不算成功。即使关闭开关，未知准备记录仍会阻止重新派工：应检查保存的 request/session/terminal 与请求审计，不是再次启动。首版仍禁用自动复用、新工作区、lane、远程与 Windows；未设置开关时，下述默认一次性路径不变。

在一次性兼容路径上，viewer 用 `opencode run --auto` 启动 OpenCode，并创建 Orca Dispatch 记录任务。这条路径标记为 `unsupervised`，没有受监督的 worker 资源，也没有 `agent_status` fleet 证据。在 Orca 1.4.209 的并行只读对照中，OpenCode 通过 `worker_done` 完成了 Task，但运行时的 `worker-list` 显示 `unverifiable / missing_status`，落定后变为 `unverifiable / unsupervised_settled`。运行期间，`worker-show` 另外观察到精确的 OpenCode 终端仍然存活。这些 fleet 值符合 viewer 当前 OpenCode 启动路径的设计，不能单独证明 OpenCode 钩子损坏。对此路径应核对 Task/Dispatch 的结果与精确终端观察，也不能把 `unverifiable` 当作进程已退出的证据。

在 Orca 1.4.209、OpenCode 2.0.15 上直接执行只读 `worker-start --agent opencode` 测试，任务正文仍未送达：回执显示 `input_accepted`，但 OpenCode TUI 始终停在空白初始输入框，没有 agent 回合或 `worker_done`。测试 Dispatch 已隔离，精确终端已关闭，Task 已标记失败。因此 viewer 仍保留一次性兼容路径；不能只凭 `input_accepted` 判断任务已经送达。

在上述版本中，先在 Orca 终端启动并等候 `opencode mini` 就绪，再通过 `worker-start --terminal <handle>` 绑定，**可以**送达只读 Task，并通过 `worker_done` 完成。此时 Dispatch 是受监督的，但 `worker-list` 仍显示 `unverifiable / missing_status`。`mini` 是交互界面，`opencode run` 才是一次性 CLI 模式；OpenCode 2.0.15 的 `mini --help` 没有 `--auto` 选项。尚未验证 mini 在自动编辑时的权限行为，所以这次实验还不足以替换 viewer 的 `opencode run --auto` 路径。
