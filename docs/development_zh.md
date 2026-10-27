# 开发者指南

[English](development.md) | 简体中文

> [返回文档索引](README_zh.md) · [返回 README](../README_zh.md)

本指南面向参与 orca-dag 开发、测试、构建和发布的维护者与贡献者。关于系统的分层架构、调度逻辑及代码目录职责，请参阅[架构与设计规范](reference/architecture_zh.md)。

## 本地开发与检查命令

克隆仓库后，首先安装依赖：

```bash
npm install
```

常用开发与质量保证命令如下：

```bash
npm run dev            # 启动本地开发环境：前端 Vite (5173) + 后端 Express (8787)，Vite 自动反向代理 /api
npm run check          # 全量校验：skill 规范核验 + TypeScript 类型检查 + 单元测试 + Web 生产构建 (CI 必跑)
npm run test           # 运行服务端与调度逻辑单元测试
npm run build:npm      # 构建可发布的 npm 包并输出至 dist-npm/ (仅需要 Node.js 环境)
npm run build:binary   # 构建单文件便携独立二进制至 dist/orca-dag (已内嵌前端，需要 Bun 环境，约 100MB)
npm run release 1.0.0  # 发版入口：校验代码、生成 git tag 并推送到 GitHub，触发 CI 自动化发布
```

## 真实 Provider 运行验证（verify:live）

在本地源码工作区中，开发者可以对运行中的本地 viewer 执行端到端的真实 Codex DAG 验收测试：

```bash
npm run verify:live -- http://127.0.0.1:8787
```

### 关键约束与安全警告

- **仅限源码、显式运行**：`verify:live` 不属于 `npm run check` 或默认 CI；需要对空闲的本地 viewer 主动执行。
- **产生真实费用**：测试会动态创建一个全新的 Run，并在当前工作区内启动 3 个真实的 Codex Task。任务 A 与 B 分别独立写入输入文件，任务 C 在依赖满足后读取计算并验证结果数值 `51`。**该过程会直接消耗所配置 AI 模型服务商的真实 Token 配额**。
- **无侵入旁路观察**：所有 worker 的启动、派发与结算完全由 viewer 自带的 coordinator 正常调度驱动；测试脚本仅作为旁路客户端观察执行状态，绝不在 worker 内部植入等待测试标记的侵入式代码。
- **状态不明时坚决不盲动**：若启动结果呈现为 `unknown`，验证器持续保持观察，绝不擅自重试或盲目取消。
- **超时与证据留存**：观察超时上限为 15 分钟；若超时仍未落定，验证器保留正在运行的 worker 并如实返回 `unverifiable`，绝不虚假冒充通过。验证产生的完整证据保存在 `.orca-dag/<timestamp>-verification-*/` 目录下；测试完成后自动还原原工作区并发设置，并保持该测试 Run 处于选中状态。

## 独立二进制打包与交叉编译

项目支持借助 Bun 的编译能力将 Express 服务端、静态前端资以及 skill 提示词一并打包为零依赖的单文件便携可执行二进制文件：

```bash
# 构建当前平台架构的二进制
npm run build:binary

# 交叉编译至指定平台架构 (例如 Linux x64)
TARGET=bun-linux-x64 npm run build:binary

# 批量编译全平台二进制并生成校验和清单 (GitHub Actions Release 工作流所用脚本)
bash scripts/build-all-binaries.sh
```

生成的二进制输出至 `dist/orca-dag`（跨平台发布产物归档于 `dist/orca-dag-<platform>-<arch>.tar.gz`），运行机器无需预装 Node.js 或 Bun，仅需系统 PATH 中存在 `orca` CLI 即可独立运行。

## 发布流程与 npm Trusted Publishing (OIDC)

本项目 npm 发布采用 **Trusted Publishing (基于 OIDC 的免密钥凭据交换)**，在 GitHub 仓库中无需配置高风险的 `NPM_TOKEN` Secret。

由于 npm 官方要求“必须先有包存在，才能配置 Trusted Publisher”，因此**仅在首次建立包时**需要执行一次手动的 Bootstrap 初始化流程：

### 1. 首次发版 Bootstrap（仅执行一次）

1. 本地终端登录具备发包权限且已开启双因素认证（2FA）的 npm 账号：
   ```bash
   npm login
   ```
2. 使用 `bootstrap` 标签发布一个初始的预发布包完成占位：
   ```bash
   PKG_VERSION=1.0.0-oidc-bootstrap.0 npm run build:npm
   npm publish ./dist-npm --access public --tag bootstrap
   ```
   > ⚠️ **注意**：首次发布后，npm 会将 `latest` 标签暂时指向该预发布版本（即使加了 `--tag bootstrap`）；在后续发布首个正式版本（如 `1.0.0`）时，`latest` 会被自动更正为正式版。
3. 在 npmjs.com 后台建立 Trusted Publisher 信任关联：
   - 打开 **orca-orchestration-launcher → Settings → Trusted publishing → GitHub Actions**；
   - 填写 Organization/User: `yyq19990828`；
   - 填写 Repository: `Orca-dag`；
   - 填写 Workflow filename: `release.yml`；
   - Environment 留空；
   - 权限勾选允许 **npm publish**。
   - *（可选命令行方式）*：使用 npm ≥ 11.15.0 执行：
     ```bash
     npm trust github orca-orchestration-launcher --repo yyq19990828/Orca-dag --file release.yml --allow-publish
     npm trust list orca-orchestration-launcher
     ```
4. 确保包含了 OIDC 权限声明（`id-token: write`）的 `.github/workflows/release.yml` 已经合并推送到 GitHub `main` 主分支。

### 2. 标准正式发版流程

完成首次配置后，后续所有日常发布均遵循标准自动化流程：

```bash
# 执行本地发布脚本，例如发布 1.0.0
npm run release 1.0.0
```

发布前先运行 `npm run check`，并将审核后的源码推送到 `main`。发布脚本随后：
1. 要求工作区干净、位于 `main` 且与 `origin/main` 一致，版本格式有效、标签未使用；
2. 校验 skill、检查服务端 TypeScript，并构建 npm 发布包（包含 Web 构建）；
3. 创建带注释的 `v<version>` 标签并推送；不会替你提交或推送尚未发布的源码。

GitHub Actions 随后通过 OIDC 发布 npm 包，并将各平台二进制附加到 GitHub Release。正式版以标签为版本依据，`PKG_VERSION` 提供发布包元数据，无需另提交仓库版本号变更。npm job 使用 Node 24、npm ≥ 11.5.1 及 `id-token: write`。

### 3. npm 发布失败的恢复

如果 npm 在实际发布前拒绝 OIDC 认证，修正 Trusted Publisher 映射后重跑失败 job：

```bash
gh run rerun <run-id> --failed
```

重跑会检出同一标签，发布的仍是标签对应源码。不要仅因认证失败而另发一个版本。
