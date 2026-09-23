# 教程：规划并运行 Orca 任务 DAG

[English](orchestration.md) | 简体中文

本教程以一个功能从需求到 Run 完成为例。编写时核对的 Orca CLI 版本是 1.4.209。**实际使用命令参数前，先加载本机 CLI 的指南：**`orca skills get orchestration`；如果[项目 skill](../../skill/SKILL.md)选用了其他可执行文件，就用那个文件运行 `skills get`。运行时指南和 `--help` 优先于本文示例。viewer 执行任务所需的最低 Orca 版本是 1.4.205。

## 核心对象，以及为什么需要 viewer

| 对象 | 含义 | 操作上的影响 |
| --- | --- | --- |
| Run | 持久的命名空间，也是 coordinator 的收件箱。 | “一个 Run 对应一个 DAG”是本项目的约定；Orca 不调度 Run。 |
| Task | 带有说明、状态、可选 `parent` 和 `deps` 的工作项。viewer 称其为 **Stage**。 | `deps` 决定何时就绪；`parent` 只表示层级，不规定执行顺序。 |
| Dispatch | Task 的一次权威执行尝试，ID 形如 `ctx_*`。 | 重试同一 Task 会创建新的 Dispatch；操作前要核对准确的那一次。 |
| Gate | 绑定到 Task 的决策门。 | 即使依赖已完成，Task 仍须等待门被解决。 |
| Delivery | coordinator 收件箱中的一批消息。 | coordinator 处理后必须确认；未确认的批次会反复出现，挡住后续消息。 |

Orca 提供这些记录和 worker 生命周期操作，但不决定下一个就绪 Task、工作区放置位置或并行度。viewer 的 coordinator 循环负责这些选择，再调用启动时确定的 Orca CLI。它将自己的终端绑定到 Run，取得修改权限；其他终端仍可读取 Run，竞争性的修改会被权限隔离。viewer 接管绑定前会要求确认。

## 完整示例：CSV 导出

先让规划 agent 定义 CSV 格式，再并行处理 API 和 UI：

```text
A  CSV 格式约定
├─ B  API 导出 ──┐
└─ C  UI 操作 ───┴─ D  集成后的验证
```

| Task | 依赖 | 工作范围和验收 |
| --- | --- | --- |
| A | 无 | 定义列、转义、编码和错误行为，给 B 与 C 一份共同的约定。 |
| B | A | 在归属的服务端文件实现导出接口，展示一份有代表性的 CSV 响应。 |
| C | A | 在归属的前端文件增加下载操作，展示预期请求及下载行为。 |
| D | B 和 C | 验证目标工作区中**已经集成**的改动能端到端工作，并报告结果。 |

每个 Task 的说明应独立完整。例如：

> **目标位置：**报表导出接口与 CSV 序列化代码。**改动：**实现约定的列与转义规则。**约束：**保留现有授权和分页契约。**归属：**只改本次 Dispatch 指定工作区中的服务端导出文件；不改 UI 文件，也不集成其他分支。**验收：**报告示例 CSV、完成的检查、变更文件和未提交内容。

可以这样向规划 agent 提需求：“使用 `orca-dag` skill 为 CSV 导出编写 PRD 和技术设计，新建包含 A–D 及上述依赖的 Run，核对存储后的任务图并返回 Run ID。执行交给 viewer。”skill 会在**目标项目**中编写规划文档，而不是恢复本仓库的历史计划文件。

## Orca 中的规划参数

下表对应当前 CLI。修改 Run 之前，仍应让 agent 从 `skills get orchestration` 和相应命令的 `--help` 获取准确语法。

| 操作 | 主要参数 | 要核对的内容 |
| --- | --- | --- |
| `run-create` | `--objective <text>`；在绑定的 Orca 终端之外调用时使用 `--from <handle>`；`--json` 获取回执。 | 保存返回的 `run_*` ID 和 coordinator 绑定。创建 Run 不会启动 worker。 |
| `task-create` | `--spec <text>`、可选的 `--task-title` 与 worker `--display-name`、`--deps <json_array>`、`--parent <task_id>`、`--run <run_id>`。 | `--deps` 接收 `["task_A"]` 这样的 JSON 文本，ID 必须属于同一 Run 中已创建的 Task；`--parent` 只是层级关系。 |
| `task-list` | `--run <run_id>`，可选 `--ready`、`--brief`、`--status`，以及 `--json`。 | 回读 ID、完整说明、状态和依赖箭头。`--brief` 将说明截到 160 字符，审核说明时不要使用。 |
| `gate-create` | `--task <task_id>`、`--question <text>`、`--options <json_array>`。 | 只对真正需要 coordinator 决定的事项建门，不用它回答 worker 的普通问题。 |
| `gate-list` / `gate-resolve` | 列表使用 `--run <run_id>`；从已绑定的 coordinator 通过 `--id <gate_id>` 和 `--resolution <choice>` 解决。 | 解决门时依据 Run 绑定，不传 `--run`；viewer 也提供门控按钮。 |

修改类命令可用 `--retry-request <id>` 恢复“请求结果丢失”的**同一次**操作；它不是通用的重试开关。重放前先用 `request-show` 及受影响的记录确认状态。worker 的阻塞性提问使用 Orca 的 `ask`/`reply` 流程，不应为此创建 Gate；具体消息参数见运行时指南。

按依赖顺序创建 Task，先记下每个返回的 ID，再把它放进后续 Task 的 `--deps` 数组。每创建一批就回读 Task 列表。已创建 Task 的说明、标题和依赖不能修改，也不能只删除一个 Task；图有误时应新建 Run 重绘。**不要**用 `orchestration reset --tasks` 重绘单个 DAG：它会清空本机编排数据库中的所有 Task。

### 会遇到的 worker 与收件箱参数

正常运行 Run 时由 viewer 处理这些生命周期操作。阅读回执或明确要从 CLI 协调时，需要理解下列参数：

| 操作 | 主要参数 | 规则 |
| --- | --- | --- |
| `worker-start` | `--task <task_id>`、`--agent <agent>`、放置参数 `--worktree`，可选 `--model` 和 `--effort`。 | 启动一次受监督 Dispatch；改用 `--spec` 会新建 Task。启动失败的回执会列出失败阶段和残留资源。 |
| `send` 加 `--type worker_done` | 精确的 `--task-id`、`--dispatch-id`、`--outcome succeeded\|failed`；有真实值时可加 `--files-modified`、`--report-path`。 | 只有当前已派遣的 worker 能让自己的 Task 落定。它发送一次后，应停止使用这组 ID 工作。 |
| `check` | 在调用方 Orca 终端之外使用 `--terminal <handle>`；另有 `--wait`、`--types`、`--timeout-ms`、`--ack <delivery_id>`。 | `--types` 只改变等待的唤醒条件，不筛掉返回的消息。先处理最旧批次的全部消息，再确认它。`check` **不用** `--from`。 |
| `reply` / `send` | 回复时使用 `--id <message_id>` 和 `--body`；定向指导发到 `dispatch:<id>`。 | 发送成功只证明持久化入队，不证明 worker 已读。worker 提问用 `ask`/`reply`，不建决策门。 |
| `worker-list`、`worker-show`、`worker-read` | 用 `--run` 限定 worker 列表；远端加 `--include-remote`；用 `--dispatch` 检查单次尝试。 | worker 存活状态与终端存活状态是两回事。`unverifiable` 代表证据不足，不代表已退出。 |

coordinator 先启动可独立执行的就绪波次，处理提问和完成消息，为每个已落定 worker 决定复用、保留或释放，确认 Delivery，然后检查新就绪的 Task。等待超时只是一个检查点。若从 CLI 直接协调，须完整遵循运行时指南的完成对账和恢复规则；viewer 会自动执行这套循环。

## 在 viewer 中配置并执行

从 Orca 管理的项目根目录启动 `npx orca-orchestration-launcher`，启动参数见[viewer 操作教程](viewer-operations_zh.md#启动参数)。选择返回的 Run ID，核对 DAG，设置默认 harness 和 **Max parallel**，再按需覆盖单个 Stage 的启动选择。这些选择保存在 viewer 的工作区配置里，不属于 Orca Task 字段。

点击 **Run with Orca** 后，viewer 绑定自己的 coordinator 终端，对启动选择取快照，并循环启动就绪 Task，数量不超过并行上限。依赖、门、工作区 lane 和空闲 worker 槽位都可能让实际并行数更低。有效的 `worker_done` 会让 Task 和 Dispatch 落定；coordinator 会复用、明确保留或释放终端，并处理及确认每一批收件箱 Delivery。Task 已落定，不代表终端已清理完成。

如果 B 和 C 属于不同的**工作区 lane**，D 还要等待自动创建的集成门。仅使用不同的单 Stage 工作树、却没有分配 lane，不会触发这个自动门；此时要在计划中显式安排集成检查点。[工作树隔离教程](worktree-isolation_zh.md)解释了为什么依赖完成不会搬运代码，以及何时可以解决为 `integrated`。

## 观察结果与修改计划

用 Scheduler 卡片查看就绪原因，用 Chat 处理提问和持久化消息，用 Activity 查看 coordinator 行为，用 Workers 查看每个 Dispatch 的存活状态和终端归属。“已发送”只证明入队，不证明对方已读；超时或远端断连也不能证明 worker 已退出。恢复步骤见[viewer 操作教程](viewer-operations_zh.md#处理受阻或状态不明的-stage)。

结束前检查每个 Task 的结果、变更文件、集成证据和未清理的 worker 归属。要修改 Task 或依赖边，应让 agent **新建 Run**，保留旧 Run 作为历史。规划、执行、集成分支和批准门槛是不同步骤，各有归属。
