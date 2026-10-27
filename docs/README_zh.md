# 文档导航

[English](README.md) | 简体中文 · [项目首页](../README_zh.md)

安装和第一次运行从项目首页开始；按当前任务选择教程，需要查询具体配置或边界时再看参考文档。

## 教程

| 我想要…… | 阅读 |
| --- | --- |
| 把需求拆成任务 DAG 并执行 | [规划并运行任务 DAG](tutorials/orchestration_zh.md) |
| 隔离工作、共用 lane 或集成 Stage 改动 | [隔离工作树](tutorials/worktree-isolation_zh.md) |
| 配置、监控、恢复、升级或卸载 viewer | [viewer 操作](tutorials/viewer-operations_zh.md) |

## 参考

| 主题 | 内容 |
| --- | --- |
| [兼容性与已验证版本](reference/compatibility_zh.md) | 浏览/执行门槛、启动路径要求及真实运行时验证记录 |
| [viewer 功能](reference/viewer-features_zh.md) | 画布、启动控制、消息、恢复、审计证据及界面语言 |
| [架构与边界](reference/architecture_zh.md) | Run/Task/Dispatch 归属、coordinator 安全、CLI/工作区解析及源码结构 |
| [HTTP API 与安全](reference/http-api_zh.md) | 回环访问、变更 token、就绪探测及完整路由清单 |

## 开发

- [开发与发布](development_zh.md)：源码环境、检查、显式真实 provider 验证、打包及 npm/GitHub 发布。
- [UI 布局设计](ui-layout_zh.md)：展示规则与布局验收场景。

生命周期操作仍以 Orca 为权威。命令语法应从已安装运行时的编排指南获取，worker 遵守自己的实时 preamble；本文档不会授予停止、重试或释放 unknown worker 的权限。
