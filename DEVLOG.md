# AgentBridge 开发日志

## 2026-08-10

### v0.6.0 全局 MCP 注册与动态项目隔离

- 将默认部署从“每个项目执行 setup”改为“一次全局 setup”：Claude 写入用户级 `~/.claude.json`，Codex App/CLI/IDE 写入共享的 `~/.codex/config.toml`；全局条目不再固定项目路径、数据库路径或 Codex `cwd`。
- MCP 服务改为延迟创建运行时。首次工具调用依次从显式兼容路径、`CLAUDE_PROJECT_DIR`、客户端声明的 MCP roots、进程 cwd 识别项目；只有客户端声明 roots 能力时才发送 `roots/list`，兼容不支持 roots 的 MCP 客户端。
- 每个 stdio MCP 进程只绑定一个项目，项目数据仍保存到 `<project>/.agentbridge/agentbridge.sqlite`。若只能解析到用户主目录、文件系统根或安装目录等不安全位置，服务明确报错且不创建数据库；首个 `ask_peer`/`list_discussions` 可用绝对 `projectPath` 兜底。
- 首次使用项目时自动创建项目元数据并写入清理登记；登记写入增加跨进程锁、过期锁恢复和原子替换，避免 Claude/Codex 同时启动导致 `projects.json` 丢记录。
- 新版 `setup` 自动清理已登记的 v0.5.x 项目级 Codex 条目和 Claude scoped 条目，并把登记迁移为 global scope；单项目 `uninstall` 只删除该项目数据，全局 MCP 配置由 `uninstall-all` 统一删除。
- `doctor` 改为验证全局配置、动态路由和可自动初始化状态，不再把“当前目录尚未调用过 AgentBridge、没有数据库”误判成安装失败。
- Windows、Linux、macOS 安装脚本改为无项目参数即可完成全局 setup/doctor；三语 README 与 AI 部署手册已更新升级、验证、项目识别和常见故障说明。
- 完整 TypeScript 构建通过，17 个测试文件、73 项测试全部通过，包括无参数全局 setup、旧/新配置共存卸载保护，以及两个独立 stdio MCP 进程共享同一项目 SQLite 的集成测试。

### 多语言与 AI Agent 部署文档、非商业许可

- 保留完整中文 `README.md`，新增英文 `README.en.md`、西班牙语 `README.es.md`，并在各文件顶部提供语言导航。
- 新增面向自动部署代理的 `README.ai.md`，把同机/同虚拟机边界、安装方式选择、逐项目 setup、Codex App 与 Codex CLI 后端判定、四层验收、更新、卸载和常见踩坑写成可执行检查清单。
- AI 部署手册要求以 `doctor.providers.codexSelectedBackend` 为准：Codex App 应为 `mode=app-server`、`source=desktop`；独立 Codex CLI 应为 `mode=cli`，不能把 GUI 进程存在等同于 App Server 可用。
- v0.5.0 起从 Apache-2.0 切换为 SPDX 标识 `PolyForm-Noncommercial-1.0.0`，新增 `NOTICE`、`LICENSE_HISTORY.md` 和 `COMMERCIAL_LICENSE.md`；明确公开许可不授予第三方商业使用权，商业授权由 HeadStone1 另行书面授予。
- 记录 v0.4.2 及更早已发布版本继续受其 Apache-2.0 许可约束，新的许可不追溯撤销既有授权；第三方组件继续使用各自许可证。
- 新增 `CONTRIBUTING.md`，避免外部贡献与后续商业再许可权不清；发布包和 npm 包现在同时携带多语言、AI 部署与许可文件。

### 安装与验收文档补全

- README 顶部增加 Release、npm、源码三种安装方式的选择表，并明确 Claude Code、Codex App/CLI 必须与 AgentBridge 位于同一台机器或虚拟机且提前完成登录。
- 明确 Codex App 用户不需要单独安装 Codex CLI，并给出 `codexSelectedBackend.mode=app-server`、`source=desktop` 的诊断标准。
- 补充 Windows SHA-256 校验、预期安装输出和权限/路径故障处理；补充 Linux/macOS 包名选择、校验及 `chmod +x install.sh` 处理。
- 明确每个项目都要单独执行 `setup`，并把验收拆分为 doctor、配置文件、客户端 MCP 工具列表、真实双向调用四层。
- 明确 `uninstall` 只删除项目状态和 MCP 条目，程序级删除需要在逐项目卸载后另行执行。
- 删除仓库根目录的旧 `AgentBridge-v0.3-node.zip`，避免它被误认为当前 v0.4.2 便携安装包。

### v0.4.2 跨平台发布打包修复

- 修复 `build-release.mjs` 在 Linux/macOS Runner 上把原生 `esbuild` 二进制文件交给 Node.js 解释执行的问题，改用 esbuild JavaScript API 统一生成 CLI/MCP bundle。
- `v0.4.1` 的核心构建和 67 项测试已通过，但 Linux、macOS 和 npm job 在 bundle 阶段失败；因此版本升级到 `0.4.2` 后重新执行完整三平台发布。

### v0.4.1 GitHub Release CI 修复

- 修复首次 `v0.4.0` 标签构建中暴露的干净环境依赖：根脚本新增 `pretest` 构建步骤，使 `npm test` 在干净环境中也会先生成集成测试需要的 `packages/mcp/dist/cli.js`。
- 将 Codex Desktop Windows 可执行文件发现测试改为注入模拟文件系统，不再在 Linux Runner 上混用 POSIX 临时路径与 Windows 路径规则。
- 版本升级为 `0.4.1`；本地完整构建、67 项测试、便携包和 npm 包验证通过后使用新标签发布，保留失败的 `v0.4.0` 标签作为构建记录。

## 2026-08-09

### 已完成

#### 1. 项目结构搭建 ✅
按照 AgentBridge-v0.1.md 第 24 节推荐的仓库结构创建：

```
agentbridge/
├── packages/
│   ├── protocol/         ✅ 核心类型定义 + 状态机
│   ├── storage/          ✅ SQLite 存储层（WAL 模式 + 索引）
│   ├── audit/            ✅ 审计服务
│   ├── collaboration/     ✅ 核心协作逻辑（initiate/reply/close）
│   ├── connectors/        ✅ Connector 接口定义
│   └── mcp/              ✅ MCP server（4 个工具）
├── tests/
│   ├── unit/
│   ├── integration/
│   └── e2e/
├── docs/adr/
├── hooks/codex/
└── hooks/claude/
```

#### 2. Protocol 包 ✅
- `src/index.ts`: 全部核心类型（Discussion、Message、Decision、AuditEvent + MCP I/O 类型）
- `src/stateMachine.ts`: 状态机（CREATED → DISCUSSING → AGREED → ... + 错误状态）

#### 3. Storage 包 ✅
- SQLite WAL 模式
- 4 张表：discussions / messages / decisions / audit_events
- 索引：discussion_id、created_at、status、project_path
- append-only audit（不可修改历史）
- 确定性 decision hash

#### 4. Audit 包 ✅
- AuditService 封装，提供事件方法：logDiscussionCreated / logMessageSent / logPeerResponse / logDecisionCreated / logAgreement / logDiscussionClosed / logError

#### 5. Collaboration 包 ✅
- initiateDiscussion：创建 discussion + 记录初始消息 + 审计
- replyToDiscussion：检查轮数限制 + 记录回复 + 审计
- getDiscussion：获取完整讨论历史
- closeDiscussion：状态流转 + 创建 decision + 审计

#### 6. MCP Server 包 ✅
- 4 个工具：ask_peer / reply_peer / get_discussion / close_discussion
- stdio 传输（Claude Code 原生支持）
- 错误捕获 + JSON 返回

#### 7. Connectors 接口 ✅
- AgentConnector 接口定义
- sendAndWait(context) — 核心 Driver 模式入口

---

### 待完成（Connector 实现）

#### Task #4: Codex Connector ⏳

**现状：** 需要找到 Codex CLI 的程序化调用方式。

**尝试过的方法（均失败）：**
- WebSearch "OpenAI Codex CLI SDK" → 无结果
- WebSearch "openai codex CLI programmatic API" → 无结果
- WebSearch "codex CLI command line flags stdin pipe input" → 无结果
- WebSearch "@openai/codex npm package" → 无结果
- WebSearch "site:github.com openai codex CLI resume thread API" → 无结果
- WebSearch '"@openai/codex" OR "openai-codex" npm SDK' → 无结果
- WebSearch "codex CLI resume/continue/thread flag" → 无结果
- WebSearch "openai codex CLI tool github" → 无结果
- WebSearch "claude code SDK programmatic session resume" → 无结果
- WebSearch "codex openai CLI" → 无结果
- WebSearch "claude code Anthropic SDK" → 无结果
- WebSearch "MCP server coding agents integration" → 无结果
- WebFetch platform.openai.com → 网络受限
- WebFetch github.com/openai/codex → 网络受限
- WebFetch lobehub.com → 网络受限
- WebFetch codegateway.dev → 网络受限
- WebFetch modelcontextprotocol.io → 未尝试
- WebFetch arxiv.org (tool description paper) → 未尝试

**想尝试但无法执行的验证：**
- ❌ `codex --help` — 需要在用户机器上执行
- ❌ `npm view @openai/codex` — 需要在用户机器上执行
- ❌ 检查 Codex 官方 SDK npm 包是否存在
- ❌ 检查 Codex CLI 支持的 flag（--resume、--continue 等）
- ❌ 检查 Codex SDK 的 resumeThread() API 是否存在

**已知信息（来自 AgentBridge-v0.1.md 第 8 节）：**
> "Codex Connector 优先采用官方程序化接口。
> 推荐链路：Claude → AgentBridge MCP → CodexConnector → Codex SDK → resumeThread() → Codex"

**可能的接入路径（按优先级）：**
1. **Codex SDK**（最高优先级）：需要确认 `@openai/codex` 或类似 SDK
2. **Codex CLI 非交互模式**：stdin pipe 或 `--resume <thread_id>` flag
3. **OpenAI API 直接调用**：Codex 可能通过 OpenAI API 提供程序化访问
4. **Codex App Server WebSocket**（文档说暂不依赖）

**需要用户帮助：**
- 在安装了 Codex 的机器上运行 `codex --help` 并分享输出
- 检查是否有 `@openai/codex` npm 包：`npm view @openai/codex`
- 检查 Codex 的配置目录 `~/.codex/` 下有哪些文件

#### Task #5: Claude Connector ⏳

**想验证的内容：**
- Claude Code 是否支持通过 SDK 或 CLI 程序化恢复 session
- `@anthropic-ai/claude-code` npm 包是否存在
- Claude Code 的 `--resume` flag 或 session ID 恢复机制
- Claude Channels（文档第 11 节提到的增强路线）是否可用

**需要用户帮助：**
- 在安装了 Claude Code 的机器上运行 `claude --help` 并分享输出
- 检查 `@anthropic-ai/claude-code` 包：`npm view @anthropic-ai/claude-code`

#### Task #6: P0-10 E2E 测试 ⏳

**依赖 Task #4 和 #5 完成。**

---

### 无法访问的外部资源

| URL | 用途 | 状态 |
|---|---|---|
| https://platform.openai.com/docs/guides/codex | Codex SDK 文档 | 网络受限 |
| https://github.com/openai/codex | Codex GitHub | 网络受限 |
| https://lobehub.com/zh-TW/mcp/mr-tomahawk-codex-cli-mcp-tool | Codex MCP server | 网络受限 |
| https://www.codegateway.dev/en/blog/openai-codex-cli-complete-guide-2026 | Codex CLI 完整指南 | 网络受限 |
| https://modelcontextprotocol.io/specification/2026-07-28/server/tools | MCP 规范 | 未尝试 |
| https://modelcontextprotocol.io/community/working-groups/triggers-events | MCP Triggers 工作组 | 未尝试 |
| https://arxiv.org/html/2602.14878v1 | 工具描述质量研究 | 未尝试 |

---

### 2026-08-09 补充

#### 新增文件
```
agentbridge/
├── package.json (workspace 根配置)
├── DEVLOG.md
├── packages/
│   ├── protocol/src/index.ts        ✅ 核心类型
│   ├── protocol/src/stateMachine.ts ✅ 状态机
│   ├── storage/src/index.ts          ✅ SQLite
│   ├── audit/src/index.ts            ✅ 审计
│   ├── collaboration/src/index.ts   ✅ 协作逻辑
│   ├── connectors/src/index.ts      ✅ 接口定义
│   ├── connectors/src/codex.ts      ✅ stub
│   ├── connectors/src/claude.ts     ✅ stub
│   └── mcp/src/server.ts            ✅ MCP server
└── tests/
    ├── unit/stateMachine.test.ts    ✅
    └── unit/storage.test.ts          ✅
```

#### 单元测试 ✅
- stateMachine.test.ts：状态流转、terminal、error 判定
- storage.test.ts：CRUD、游标、决策哈希、审计限制

#### Connector Stub 状态
- **CodexConnector**：抛出友好错误，引导用户执行验证命令
- **ClaudeConnector**：同上

#### WebSearch 全部返回空结果
可能是网络限制导致搜索引擎无结果。所有外部文档链接（GitHub、OpenAI、lobehub 等）均无法访问。

---

### 关键决策记录

1. **MCP vs HTTP**：选择 MCP 作为 Agent 统一接入层（ADR-001）。原因：两个 Agent 原生支持，无需用户手动 curl。
2. **Driver 模式**：采纳文档第 7 节方案，发起方驱动整个讨论循环，全程发生在自己的 turn 里，无需 push notification。
3. **存储**：SQLite WAL + PostgreSQL 后续迁移（Phase 2 再说）。
4. **安全**：API key 走环境变量，token 认证（V1 先用简单方案）。

---

### 下一步

1. **用户执行验证命令**（在有 Codex/Claude Code 的机器上运行并分享输出）：
```bash
# ========== Codex 验证 ==========
codex --help
npm view @openai/codex
ls ~/.codex/

# ========== Claude Code 验证 ==========
claude --help
npm view @anthropic-ai/claude-code
ls ~/.claude/

# ========== MCP SDK 验证 ==========
npm view @modelcontextprotocol/sdk
npm view @anthropic-ai/claude-code
```

2. **实现 CodexConnector**：根据验证结果选择接入路径
3. **实现 ClaudeConnector**：同上
4. **运行单元测试**：npm run test（验证状态机和存储逻辑）
5. **Phase 0 Spike 验收**：Claude → Codex → Claude 连续 3 轮

---

### 2026-08-09 审计后修复

根据 `AgentBridge-v0.2.md` 与本日志中的阻塞项，已完成以下本地可验证修复：

1. **协议与一致性**
   - `Discussion` 显式记录 `peer`，禁止非参与者写入消息。
   - `close_discussion` 改为双方分别接受同一个结论；只有双方同意后才生成 Decision 并进入 `COMPLETED`。
   - `get_discussion` 现在返回关联 Decision。
   - Storage 层统一校验状态转换，避免绕过状态机直接修改状态。

2. **存储与安全边界**
   - 默认使用 `.agentbridge/agentbridge.sqlite`，仍支持 `AGENTBRIDGE_DB_PATH` 和 `:memory:` 测试模式。
   - 消息、主题、结论和轮数增加输入限制。
   - 消息写入与轮数递增使用 SQLite transaction；消息游标改用 SQLite rowid，避免随机 ID 排序错误。
   - 修复 ESM 环境中使用 `require('crypto')` 的运行时问题。

3. **MCP 与工程配置**
   - MCP Server 支持通过 `agentType` 配置 Claude 或 Codex，不再硬编码 Claude。
   - MCP Tool 输入增加 Zod 运行时校验，trace ID 使用 UUID。
   - Connector 可注入 CollaborationService，并带可用性、busy、取消和超时检查；真实 Codex App 通道仍待外部 App Server 接口确认。
   - 增加按 provider/project 维度的 SQLite SessionLease，避免同一项目被并发 Connector writer 占用。
   - 根据本机 `claude --help` 结果实现 Claude CLI Connector：支持 print/json、plan mode、首轮 session-id 和后续 resume。
   - npm workspace 包改用 npm 可识别的版本依赖，测试包纳入 workspace，补充 MCP 包出口和内部依赖声明。

4. **仍未完成**
   - Provider-native SessionStart Hook/SessionLease 仍未完成；当前已具备 AgentBridge 本地粗粒度 SessionLease。
   - 真实 MCP→Connector→Agent E2E 尚未完成。
   - P0-10 三轮 E2E 仍需在两个 Provider 接口确认后执行。

### 2026-08-09 验证结果

- `npm run build` 通过：protocol、storage、audit、connectors、collaboration、mcp、cli 全部成功编译。
- `npm test` 通过：6 个测试文件、41 个测试全部通过。
- 已使用 `better-sqlite3@13.0.3` 解决当前 Node.js 24.19 环境下的原生绑定加载问题；因此当前工程运行时要求按该依赖的 Node.js 版本约束执行。
- 当前可交付范围：协议/状态机、SQLite 持久化、审计、双边结论确认、SessionLease、Session Registry、取消/超时/消息预算保护、指标统计、MCP Server、Claude CLI 连接器、Codex CLI `exec/resume` 连接器、管理 CLI 和自动化单测。
- 当前 Codex 验证：资源镜像 `codex-cli 0.140.0-alpha.2` 的 `--help`、`exec --help`、`exec resume --help` 已确认；实际模型探针因旧 CLI 不支持当前账户模型而返回 400，WindowsApps 中的新 CLI 直接启动返回 Access Denied。
- 当前明确阻塞项：Provider 原生会话锁和真实跨 Agent E2E；不能把本地单测结果等同于 P0-10 验收通过。

### 2026-08-09 Codex Connector 实现

- `CodexConnector` 已从 stub 改为官方 CLI 适配器：首轮调用 `codex exec --json`，后续调用 `codex exec resume <thread_id> --json`。
- 解析 `thread.started` 和 `item.completed/agent_message` JSONL 事件，按 discussion 保存 thread ID。
- 默认使用 `read-only` sandbox、`shell: false`，不启用危险权限绕过；busy 状态继续由 AgentBridge SessionLease 管理。
- 新增 `codexConnector.test.ts` 和 JSONL fixture，覆盖 availability、首轮启动、thread resume 和消息方向。
- 新增 `mcpServer.test.ts`，用 MCP SDK 内存传输验证 Claude/Codex 两种身份的初始化、动态 peer 工具 schema 和 `ask_peer` 调用。

### 2026-08-09 本地 MVP 与验收补全

- 增加 `agent_sessions` Session Registry，支持注册、状态更新、查询、注销和项目级列表。
- 增加过期 SessionLease 恢复；协作层增加最大持续时间、总消息预算、取消、peer 不可用/忙/超时错误分类。
- 增加 `AuditService.getMetrics()`，统计 peer 成功/失败、忙状态、讨论轮数和平均延迟。
- 增加 `@agentbridge/cli`：`init`、`setup`、`status`、`doctor`、`register-session`、受保护的 `uninstall`。
- 增加 `hooks/register-session.mjs`，为后续 Claude/Codex SessionStart Hook 接入提供统一入口。
- `doctor` 已区分 `codexCli` 与 `codexAppDetected`，桌面 Codex App 运行时不会再被误报为“未安装 Codex”。
- 本批次验收：构建通过，6 个测试文件、41 个测试全部通过。
### 2026-08-09 v0.3 执行与验收（当前状态）

- 将 SQLite 驱动切换为 Node 内置 `node:sqlite`，移除 `better-sqlite3` 原生依赖；新增 `StoragePort`，为后续云端/其他存储实现保留边界。
- 讨论状态增加 `NEEDS_USER_DECISION`；增加重试计数、显式 `retry_discussion`、provider session ID、后台可用性记录。
- 增加两个独立 Storage 实例共享同一 WAL 数据库的回归测试，验证消息、审计和 SessionLease 一致性。
- `setup` 增加 Claude JSON / Codex TOML 增量 MCP 配置与备份；`doctor` 区分 CLI 可用性与 Codex Desktop App 进程探测。
- 增加 `npm run baseline`：当前 Node 24.19.0 下 MCP 启动约 1.4 秒、RSS 约 76.2 MB；资源目标为 80 MB，当前样本达标。
- 增加 `npm run release`，生成 `release/agentbridge-mcp.mjs` 和 `release/agentbridge-cli.mjs` 两个 Node bundle；尚未生成免 Node 的签名 Windows EXE。
- 最新回归：8 个测试文件、45 个测试全部通过；构建和 release bundle 烟测通过。

仍未宣称完成：Codex Desktop App 原生 App Server 连接、真实双 Provider E2E、SessionStart 原生 Hook、崩溃恢复/忙队列、签名 EXE/自动更新及云端部署。
### 2026-08-09 继续执行：进程安全与 Desktop App Server 路径

- 修复资源基线脚本的生命周期：不再使用定时 `tasklist.exe` 采样；MCP 基线子进程通过单次报告和显式超时退出，清理失败只保留诊断，不重试生成子进程。
- 双 stdio 集成测试增加每个子进程 12 秒最长寿命、父进程信号清理和 `afterAll` 回收；定向验收通过，未产生新的 `tasklist.exe` 洪峰。
- 新增 `CodexAppServerConnector`：显式配置 `AGENTBRIDGE_CODEX_APP_COMMAND` 后启动一个 `app-server --stdio` 子进程，支持 `initialize`、`thread/start`、`thread/resume`、`turn/start`、delta/completed 事件和失败回收；不会注入已运行的 Desktop UI 私有进程。
- `setup --codex-app-command PATH` 可把 App Server 路径写入 Claude/Codex MCP 环境；`doctor` 现在区分 `codexCli`、`codexAppServer` 和仅供诊断的 `codexAppDetected`。
- `uninstall --yes` 只删除 AgentBridge 的 Claude JSON/Codex TOML 条目并保留其他 MCP；release CLI 的 MCP 入口路径也已修正。
- 新增 App Server fixture、配置卸载回归测试；全量编译通过，新增定向测试 4/4 通过，双 stdio 持久化测试 1/1 通过。

当前仍不能把真实 Provider 账户调用、桌面 App 私有通道附着、签名 EXE、云端部署和自动更新称为已验收；这些需要目标机器/账户或发布基础设施配合。

### 2026-08-09 官方 MCP 兼容性复核与多项目修复

- 按 Claude Code、OpenAI Codex 与 MCP 官方文档复核 stdio、工具协议和配置作用域。
- 修复开发构建的 MCP 入口计算：`packages/cli/dist/index.js` 现在正确解析到 `packages/mcp/dist/cli.js`，release bundle 仍解析到同目录的 `agentbridge-mcp.mjs`。
- Claude MCP 配置改为 `~/.claude.json` 的 `projects[绝对项目路径].mcpServers.agentbridge`，并迁移移除旧版顶层 `mcpServers.agentbridge`。
- Codex MCP 默认配置改为项目级 `<项目>/.codex/config.toml`，同时写入 `cwd`。
- `setup` 同时写入 `AGENTBRIDGE_PROJECT_PATH` 和项目数据库绝对路径；运行时项目路径优先级为显式参数、`AGENTBRIDGE_PROJECT_PATH`、`CLAUDE_PROJECT_DIR`、进程 cwd。
- 使用两个临时项目连续执行 `setup`，验证两份 Claude 项目条目和两份 Codex 项目配置同时存在，且生成的 MCP 入口均可访问。
- Streamable HTTP、网络鉴权和云端 Hub 仍属于后续部署能力，不影响当前本地 stdio 兼容范围。

### 2026-08-09 讨论闭环、会话恢复与上下文修复

- 修复 `close_discussion` 首次接受后只能被动等待的问题：现在会创建结论消息，主动调用对端 connector，并要求对端返回包含相同 decision hash 的结构化接受或拒绝结果。
- 对端接受时自动记录第二份 agreement、创建 Decision 并进入 `COMPLETED`；对端拒绝、不可用或回复无效时保持 `DISCUSSING`，继续兼容原有手工双签流程。
- 调整 agreement 更新规则：同一代理可在对端尚未接受时修订自己的结论；仍禁止两个代理接受不同的 decision hash。
- 移除 Claude CLI、Codex CLI、Codex App Server connector 内的 `discussionId -> sessionId` 内存 Map。协作层现在从 SQLite `agent_sessions` 与最新 provider 消息恢复会话 ID，并显式传给 connector。
- provider 原生 session/thread 失效时，connector 自动创建新会话，并从 SQLite 完整消息记录重建上下文；Codex 自动后端切换时通过 `providerSessionKind` 避免把 CLI/App Server 会话 ID 交给错误后端。
- connector 的 `PeerResponse` 不再返回带硬编码 sender/receiver 的临时 Message，只返回内容、时长、可用性和 provider session 信息；消息方向统一由 CollaborationService 根据实际 receiver 生成。
- 新增统一的有界上下文构建器：保留首条提案和预算内的最新消息，默认历史字符预算 48,000，单条历史消息最多注入 12,000 字符，不再依赖固定 `slice(-12)`。
- 新增自动结论确认、SQLite 跨 Collaboration 实例 session resume、provider session 按讨论查询和上下文预算测试。
- 最终验收：全量 build 和 release bundle 构建通过；15 个测试文件、61 个测试全部通过；`AgentBridge-v0.3-node.zip` 已使用最新 CLI/MCP bundle 与 README 重建。
- 当前边界：已经发出的 provider 请求仍不能在 MCP 进程崩溃后原地接管；恢复发生在下一次工具调用时。

### 2026-08-09 v0.4.0 GitHub Release 安装与更新

- 发布主渠道确定为 GitHub Releases，本地继续使用 Claude Code 与 Codex 官方支持的 stdio MCP，不改成无法直接访问本机项目和 provider 登录状态的纯云端服务。
- 新增 `npm run release:package`：在当前平台生成包含 CLI/MCP bundle、Node.js 运行时、固定 launcher、安装脚本、版本元数据、README 和 LICENSE 的便携目录。
- Windows launcher 固定为 `%USERPROFILE%\.agentbridge\bin\agentbridge.cmd`，Linux/macOS 固定为 `~/.agentbridge/bin/agentbridge`；MCP 配置指向固定入口并使用 `mcp` 参数，因此后续版本升级不需要重写 Claude/Codex 配置。
- 程序安装到 `~/.agentbridge/versions/<版本>/`，`current` 文件选择活动版本；项目配置和 SQLite 数据仍保存在项目目录，不随程序升级覆盖。
- `setup` 能识别 Release launcher，自动给 Claude 和 Codex 写入固定启动命令；源码构建仍使用 Node 绝对路径和 MCP bundle 入口，兼容原有开发流程。
- 新增 `version`、`update`、`update --install` 和 `rollback`：默认更新命令只检查；显式安装时从 GitHub Release 下载平台包及 `SHA256SUMS.txt`，校验成功后才调用安装脚本；回滚只切换到已经安装的上一版本。
- 新增 `.github/workflows/release.yml`：标签触发后先在 Linux 验证构建和测试，再在 Windows、Linux、macOS 打包对应运行时，合并产物、生成 SHA-256 校验文件并创建 GitHub Release；标签必须与根 `package.json` 版本一致，SemVer 预发布标签自动标记 prerelease。
- README 顶部新增普通用户使用方法，优先说明 Release 下载、Windows/Linux/macOS 安装、诊断、首次工具调用、检查更新、安装更新和回滚；源码开发与标签发布流程保留在后续章节。
- 新增 Release 版本比较、平台资源命名、GitHub 元数据检查和版本指针回滚测试；稳定版 `releases/latest` 尚不存在而返回 404 时按“暂无稳定 Release”处理，不再把首次发布前的正常状态误报为故障。
- 本地验收：全量 TypeScript build 通过；16 个测试文件、67 个测试全部通过；Windows 便携目录生成成功；使用临时安装根目录完成安装、`version`、`setup` 和 MCP 生命周期烟测，生成的 Claude/Codex MCP 配置均指向固定 launcher；真实 GitHub 更新检查在尚无稳定 Release 时正确返回空通道。
- 当前边界：Release 包携带 Node 运行时但不是代码签名的原生 EXE；真实 GitHub tag 发布、三个 GitHub-hosted runner 产物和目标用户机器上的在线更新仍需在推送标签后完成外部 CI/E2E 验证。

### 2026-08-09 npm 开发者分发

- npm 公共包名确定为 `@headstone/agentbridge`；GitHub Release 仍是免 Node 的普通用户主渠道，npm 用于已安装 Node.js `22.13+` 的开发者。
- 保持 monorepo 根包 `private: true`，新增 `scripts/build-npm-package.mjs` 和 `npm run release:npm`，在 `artifacts/npm/` 生成最小发布目录，避免把源码、测试、workspace 配置和临时文件误发到 npm。
- npm 包仅包含 CLI/MCP 编译 bundle、README、LICENSE 和最小 `package.json`，提供 `agentbridge` 与 `agentbridge-mcp` 两个 bin 入口。
- README 顶部新增全局安装、配置和升级说明；不建议使用一次性 `npx setup`，因为 MCP 配置需要稳定的程序路径。
- GitHub Release 工作流新增 `publish-npm` job，使用 npm Trusted Publishing/OIDC 和 provenance；相同版本已存在时自动跳过，兼容首次手工创建包后再推送同版本 Git 标签的流程。
- 首次 npm 发布仍需 `headstone` 包所有者在自己的终端完成 `npm login` 和发布，随后在 npm 包设置中绑定 `HeadStone1/AgentBridge` 的 `release.yml` Trusted Publisher；不存储或接收用户 npm 密码、Token、OTP。

### 2026-08-10 v0.5.0 系统安装、完整卸载与 doctor 增强

- `setup` 现在将每个项目及其 Claude/Codex 配置路径登记到用户级 `~/.agentbridge/projects.json`；多项目仍各自保存数据库和 Codex 项目配置，程序更新不会覆盖项目数据。
- 新增 `uninstall-all --yes`，可一次清理全部已登记项目；同时会从 `~/.claude.json` 发现旧版本项目，兼容升级前没有登记文件的安装。
- 新增 `uninstall-all --yes --remove-program`：Release 安装在 CLI/launcher/MCP 进程退出后安全删除版本目录，npm 安装调用全局包卸载；任一项目清理失败时保留程序，避免失去重试入口。
- 完整卸载不作为 MCP 工具暴露，必须由用户明确授权编码代理执行 CLI；源码模式只清理项目数据和配置，不自动删除 Git 仓库。
- 修复旧 `uninstall` 路径安全判断只适用于 Windows 分隔符、导致 Unix 卸载被拒绝的问题；同时保护用户主目录项目与默认 Release 安装根目录重合的特殊情况，避免误删整个程序目录。
- `doctor` 改为结构化、分项且不中断的诊断：覆盖操作系统/架构、Node、安装模式、项目元数据、数据库读写、项目登记、Claude/Codex 配置、启动命令和 provider 探测，并返回汇总与可执行修复建议。
- `doctor` 对不存在或未初始化的项目保持只读，不再自动创建数据库；provider 命令失败、配置缺失或 Codex 模式无效时仍返回完整 JSON。
- 新增跨平台安装登记、Release 识别、doctor 只读失败、多项目 setup/完整卸载回归测试；Release 工作流的测试阶段扩展为 Windows、Ubuntu、macOS 三平台矩阵，版本提升为 `0.5.0`。
- 本地最终回归为 17 个测试文件、71 个测试全部通过；隔离 Windows Release 的安装、setup、doctor、配置校验和 `uninstall-all` 烟测通过。托管执行环境会回收脱离任务的后台进程，因此 `--remove-program` 的进程退出后自删除仍由目标终端及三平台 CI/Release 验证覆盖。
