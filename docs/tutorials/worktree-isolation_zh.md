# 教程：隔离工作树中的 Stage 行为

[English](worktree-isolation.md) | 简体中文

viewer 中的 **Stage** 对应 Orca Task，不是 Git 的暂存区。每个 Git 工作树都有自己的工作文件和 index：在 worker 工作树执行 `git add`，不会把文件暂存到 coordinator 工作树；在一个分支提交，也不会让另一个分支自动获得改动。工作树共享仓库历史与引用，所以要明确选择起点分支和目标分支。

## 根据任务选择放置位置，而不是根据终端选择

新建 agent 终端不等于新建 Git 工作树。应在 Stage 第一次 Dispatch 前选择放置方式：

| 放置方式 | 适用情况和效果 | 参数 |
| --- | --- | --- |
| `current` | 使用 coordinator 工作区；未设置放置方式时的默认值。 | 不接受创建字段，也不重跑 setup。 |
| `existing` | 使用 Orca 发现的 Git 工作树或已注册的文件夹工作区。 | 选择**完整、精确**的 `selector`；不要从路径或分支名猜测。 |
| `new-child` | 启动 worker 时，为当前工作区所属仓库创建堆叠子工作树。 | 使用下方创建字段；不能覆盖仓库选择。 |
| `new-top-level` | 启动 worker 时，从选定仓库创建独立工作树。 | 精确的 Orca `repo` 选择器及创建字段。 |

viewer 将这些选择映射到 Orca 受监督的 `worker-start`。Orca 回执会分别报告请求和实际放置位置，并记录工作树创建、setup、Dispatch 和终端的效果。创建失败不会回退到 `current`。创建还是复用终端，与工作区放置是两个独立决定。

直接使用 CLI 的操作者需要了解当前 `worker-start` 的以下参数；正常执行 DAG 时，viewer 会根据 Stage 设置填入这些参数：

| 参数 | 含义 |
| --- | --- |
| `--task` / `--agent` | 已创建的 Task ID 和选定的 agent；改用 `--spec` 会创建新 Task。 |
| `--worktree` | `current`、`new-child`、`new-top-level`，或 Orca 返回的精确 Existing 选择器。 |
| `--on` / `--repo` | `--on` 指定已保存的执行服务器；在该服务器创建新顶层工作树时必须提供 `--repo`。Run 仍归 coordinator 服务器所有。 |
| `--model` / `--effort` | 支持该功能的 agent 的启动选择；effort 依赖模型。复用 `--terminal` 时不能同时传这两项。 |
| `--retry-of` | 被重试的精确 Dispatch，须有明确的失败或停止证据。它要求 `--task`，且**不会继承放置位置**；必须再次指定目标工作区和 agent。 |

手动驱动 worker 前，应在选定的 CLI 上查看 `orca skills get orchestration` 和 `worker-start --help`。正常执行 DAG 时，viewer 会处理权限、放置与恢复回执。

### 创建字段及限制

只有 `new-child` 和 `new-top-level` 可使用以下字段。viewer 在 HTTP 入口校验一次，Orca 适配层在启动前再校验一次。

| 字段 | 含义与规则 |
| --- | --- |
| `name` | 1–64 个字符的单个标记：首字符为 ASCII 字母或数字，其后可用字母、数字、`.`、`_`、`-`。本地可省略，viewer 会根据 Run 与 Task/lane ID 推导有界名称；远端 `new-top-level` 必须显式填写。 |
| `setup` | 新工作树的仓库 setup hook 策略：`run`（默认）、`skip` 或 `inherit`。Current 和 Existing 不重跑 setup。`run` 是让 hook 与 agent 同时运行，还是等 hook 成功后再传入任务，由 Orca 的仓库启动策略决定。 |
| `baseBranch` | 可选的起点引用，最多 128 字符。允许字母、数字、`.`、`_`、`/`、`-`；拒绝 `..`、末尾 `/` 或 `.`、开头 `-` 和空白字符。 |
| `displayName` / `comment` | 可选 Orca 元数据，最长分别为 120 / 500 字符；它们不决定 Git 分支或工作区身份。 |
| `repo` | `new-top-level` 必填，须选择执行服务器上 Orca 发现的精确仓库；`new-child` 不接受。 |

使用**已保存的远端环境**时，Run 仍归 viewer 所在的 Orca 服务器所有，只有 worker 在远端启动。远端只允许精确的 Existing 工作区，或带精确 `repo` 和显式 `name` 的 `new-top-level`；`current`、`new-child` 在远端含义不明，会被拒绝。后续消息、读取、停止和清理由 **Dispatch ID** 定位，不靠猜测远端终端句柄。远端断连时状态是 `unverifiable`，不能当成已退出。

OpenCode 和自定义命令走 viewer 的兼容性本地启动路径，无法拥有非 Current 放置或 lane；viewer 会在创建 Dispatch 前拒绝这些组合。

## 给隔离的 Stage 划清工作边界

隔离 worker 需要一份独立完整、写明工作区边界的说明。例如：

> **目标位置：**API 导出文件。**改动：**实现 CSV 接口。**约束：**保留授权和已约定的 CSV 格式。**归属：**只在 Orca 为本次 Dispatch 指定的工作区工作；不改其他 Stage 的工作树，也不集成分支。**验收：**报告分支与 HEAD、变更文件、已暂存和未暂存的改动、验证结果及阻塞问题。仅在 Task 明确要求时提交。

依赖只规定顺序，不传递代码。下游 Stage 要使用另一工作树的成果前，必须分别处理以下状态：

| 来源工作树的状态 | 另一工作树会得到什么 |
| --- | --- |
| 未暂存或未跟踪文件 | 不会自动得到；需要有意识地保留或转移。 |
| 经 `git add` 暂存的文件 | 仍不会自动得到；index 属于来源工作树。 |
| 来源分支上的提交 | 提交存在于共享仓库，但目标分支/工作树不会自动包含它。 |

按照项目既有 Git 流程，只集成需要的改动。宣布目标工作区可用之前，应**分别在来源和目标工作树中**核对 `git status --short`、暂存与未暂存差异、分支和 HEAD。viewer 自身不会合并、变基、cherry-pick、提交、推送或删除分支。

## 用 lane 复用一个工作区

**工作区 lane** 是一条依赖有序的 Task 链，共用一个非 Current 的本地工作区。例如：

```text
api lane：API 实现 → API 审核
ui lane： UI 实现
Current： 集成后的验证 ← API 审核 + UI 实现
```

第一个成员打开或创建 lane 的工作区；后续成员、重试以及 viewer 重启后，都复用 **Orca 返回的精确选择器**。存储的 lane 起点只是启动意图；实际工作树 ID、路径、分支、HEAD 和 Dispatch 必须来自 Orca 证据。lane 不能以 `current` 为起点；成员也不能另设直接放置位置或已保存的远端环境。

viewer 保存的配置里，一个 lane ID 对应一个起点放置设置，Task ID 再映射到该 lane。例如：

```json
{
  "worktreeLanes": { "api": { "placement": { "kind": "new-child", "setup": "run" } } },
  "laneByTask": { "task_api": "api", "task_api_review": "api" }
}
```

这两个 Task 之间仍须有依赖路径；仅把它们都分配到 `api`，不会自动创建依赖。

同一 lane 的任意两个 Task 之间，必须有一个方向上的依赖路径。coordinator 终端绑定 Run **之前**就会检查这一点：无序的任务会被拒绝，不会暗中串行化。一个 lane 同时只容纳一个未落定的 Dispatch；不同 lane 可在 Max parallel 上限内并行。如果无法恢复 lane 的精确身份，其状态会变为 `unverifiable`，不会重建工作区或移到 Current。

Workspace lanes 面板可能显示 `planned`、`creating`、`active`、`integration_required`、`settled`、`unverifiable`、`removal_blocked`、`removed`。遇到警告或 `unverifiable`，应查看 Orca 的工作树和 worker 证据，而不是猜测路径。

## 理解并解决集成门

如果一个 Task 的 lane 与某个**直接依赖**的 lane 不同，它就是跨 lane 汇合。此时 Current 也算一个独立工作区：Current 中的集成验证 Task 依赖 api lane，同样是跨工作区。coordinator 会为该 Task 建立一个 Orca 集成门，并暂停它，直到人工选择 `integrated`。

这个自动检查依据的是 **lane 归属**，不是每个 Stage 实际放置的路径。两个独立 Stage 即使放在不同工作树，只要没有使用 lane，汇合时也可能不会自动创建集成门。执行前应将分支纳入 lane，或在计划的 DAG 中显式添加决策门。

先在 Orca 中检查各来源 lane 的变更文件和差异；选定目标工作区，按项目 Git 流程集成所需改动，并验证目标已包含这些改动。之后在 Operational details 将门解决为 `integrated`。这个值记录的是**人的确认**，Orca-dag 不验证是否真的发生合并。普通审批门和自动创建的集成门含义不同。

## 审核和移除工作树

通过 **Workspace lanes → Changed files / Diff** 在 Orca 中打开经过证实的精确工作区。来源工作树还有未处理的文件或提交时，不要丢弃它。移除可移除的 Git 工作树前，viewer 要求 lane 归属已落定，并要求输入确认文本，随后才调用 `orca worktree rm`。活跃、保留、待释放或无法核实的 worker 都会阻止移除。归档 hook 失败时仍视为拒绝；viewer 不会自动豁免，也不强删目录。只释放已落定 worker 的终端，不足以证明工作树可以移除。
