# AgentBridge v0.7.2 基线 / v0.7.3 修复综合审计报告

- 审计日期：2026-08-12
- 审计基线：`main` / `ade8f831924e8f9384d0daee170206821a233bfa`
- 交叉审计来源：仓库专项审计与外部 `AgentBridge_v0.7.2_专项审计与健壮性测试报告_2026-08-12.md`
- 修复版本：v0.7.3
- 范围：v0.7.1/v0.7.2 既有目标、Release MCP 稳定性、live verify 证据语义、Provider 会话生命周期、讨论深度、Skill 边界、安装升级和发布包

## 一、结论摘要

两份审计报告中的代码级高优先级发现已合并核对并修复：

1. Release MCP smoke 从手写 JSONL 改为官方 MCP SDK `Client + StdioClientTransport`，并增加 30 次连续握手稳定性门禁。
2. `verify --live` 改为每次随机 nonce 的精确挑战码；缺少已认证 Provider 或响应不精确时整体结果为失败，不再出现 `ok=true` 假阳性。
3. `fresh` 现在只在创建 collaboration room 时隔离旧上下文，同一 fresh discussion 的后续轮次复用该 room 自己的 Provider 会话；另一个 fresh discussion 仍保持隔离。
4. discussion 关闭或取消不再归档 `auto/reuse` 共享 collaboration session 的 Provider thread，避免破坏仍在运行的其他 discussion。
5. 讨论深度成为 MCP 参数、SQLite 状态和 Provider 提示契约：`review`、`discussion`、`deep-discussion` 默认成功响应上限分别为 3、12、20。
6. 精确收敛信号 `CONTINUE`、`READY_TO_CLOSE`、`NEEDS_USER_DECISION` 可持久化、审计和恢复；`maxTurns` 只作为安全上限。
7. 默认 Skill 从一个宽泛入口规范为四个聚焦工作流，并由多 Skill 安装器逐项管理 hash、冲突和卸载保护。

本轮结论是：**代码和本地发布门禁通过，可以发布 v0.7.3**。真实 Host 加载与双向 `ask_peer` 仍属于发布后的 L3/L4 环境验收，不能由本地 Provider 直连或自动化测试代替。

## 二、发现与处置

| 编号 | 等级 | 发现 | 处置 | 状态 |
| --- | --- | --- | --- | --- |
| ABR-01 | 高 | 讨论深度不是协议字段，无法选择、持久化或审计 | 增加 `DiscussionMode`、MCP `mode`、SQLite 列和模式默认预算 | 已修复 |
| ABR-02 | 高 | 生产 MCP 显式传入全局 `maxTurns=12`，覆盖模式默认值 | 仅当用户实际配置环境变量时应用全局覆盖 | 已修复 |
| ABR-03 | 中 | 收敛依赖自然语言，无法安全区分继续、关闭和用户决策 | 注入唯一末尾信号，持久化 `lastSignal`，为用户决策提供恢复路径 | 已修复 |
| ABR-04 | 中 | 单一 Skill 同时承担路由、评审、调试和高风险辩论 | 拆分为 collaboration、peer-review、debug、decision-debate 四项聚焦 Skill | 已修复 |
| ABR-05 | 中 | Skill 安装器只处理一个硬编码目录 | 自动发现全部 `agentbridge-*` Skill，并逐 Skill/host 管理 hash 和冲突 | 已修复 |
| ABR-06 | 高 | Release `verify` MCP 握手随机超时 | 使用官方 MCP SDK transport；新增 30 次连续真实 Release bundle 握手测试 | 已修复 |
| ABR-07 | 高 | `verify --live` 接受任意非空回复；缺 Provider 时也可能 `ok=true` | 每次生成 provider-specific nonce，要求精确匹配；live 前提不满足时 `ok=false/status=FAIL` | 已修复 |
| ABR-08 | 高 | `fresh` discussion 第二轮再次创建 Provider session | fresh collaboration session 也绑定并读取自己的 Provider session | 已修复 |
| ABR-09 | 高 | 关闭一个 discussion 会归档共享 room 的 Provider session | 共享 `auto/reuse` room 跳过 discussion 级归档；仅 legacy/fresh discussion-owned session 可归档 | 已修复 |
| ABR-10 | 中 | `claudeToCodex/codexToClaude` 名称容易被误读为 Host 双向 E2E | 保持兼容字段，同时增加 `L2_PROVIDER_REACHABILITY` 与 scope 说明 | 已修复 |
| ABR-11 | 中 | 缺少发布版本提升，存在覆盖 v0.7.2 的风险 | 版本提升到 v0.7.3，使用新 tag 触发 npm 与三平台 Release | 已修复 |
| ABR-12 | 高 | 开发/CI 工具链审计发现旧 Vitest/Vite/esbuild 共 4 个漏洞 | 提升 Vitest 至 4.1.10、esbuild 至 0.28.2；干净 `npm ci` 后 `npm audit` 为 0 | 已修复 |

## 三、讨论规范与深度行为

| 模式 | 适用场景 | 默认上限 | 成功标准 |
| --- | --- | ---: | --- |
| `review` | 代码审查、专项审计、测试缺口、发布门禁 | 3 | 发现按严重度排列，绑定位置/证据/影响/修复；允许明确的 clean review |
| `discussion` | 常规设计、实现方案、故障根因与一般取舍 | 12 | 事实与假设分离，有新证据或可证伪实验，避免无进展复述 |
| `deep-discussion` | 架构、安全边界、迁移和高代价决策 | 20 | challenge → evidence → rebuttal → revision → verification → convergence |

每次受策略约束的 Provider 回复必须且只能以一个精确信号结束：

- `[AGENTBRIDGE_SIGNAL: CONTINUE]`：仍有新证据、实质异议或可证伪步骤。
- `[AGENTBRIDGE_SIGNAL: READY_TO_CLOSE]`：结论已可规范化，但仍必须走双方确认关闭流程。
- `[AGENTBRIDGE_SIGNAL: NEEDS_USER_DECISION]`：剩余阻塞属于产品、权限、风险或偏好选择。

信号缺失、重复或后面仍有文字时不改变机器状态。用户提供决策后沿原 `discussionId` 恢复，保留完整审计链。

## 四、Skill 评估

四项是当前合理规模，不建议为提示词细微差异继续拆分：

1. `agentbridge-collaboration`：模式路由、discussion 生命周期、等待、重试、关闭和会话安全。
2. `agentbridge-peer-review`：短而独立的发现驱动评审。
3. `agentbridge-debug`：复现、事实/假设分离、单变量实验、证伪、根因与回归验证。
4. `agentbridge-decision-debate`：高影响方案的反方挑战、证据、反驳、修正和收敛。

外部报告建议的 design-review 已由 decision-debate 覆盖其稳定触发条件和输出契约，避免重叠 Skill 同时触发。未来只有出现独立、稳定、可评价的新工作流时再增加 Skill。Plugin 分发可作为后续 P2，不阻塞 v0.7.3。

## 五、证据等级

| 等级 | 含义 | 本轮状态 |
| --- | --- | --- |
| L1 Server | 最终 Release launcher 完成 MCP initialize 与 tools/list | PASS；官方 SDK 连续 30 次 |
| L2 Provider | verifier 直接调用已认证 Provider 并精确返回 nonce | 未提供显式已认证 Provider 命令时为 NOT_TESTED，且 `--live` 整体失败 |
| L3 Host Load | Claude/Codex Host 确实加载 AgentBridge MCP | NOT_TESTED；需要真实客户端环境 |
| L4 双向 E2E | 两个 Host 分别完成一次真实 `ask_peer` 并留存审计 proof | NOT_TESTED；需要真实客户端环境 |

兼容字段 `claudeToCodex` / `codexToClaude` 当前只表示 L2 Provider reachability，输出已明确 scope，不能据此声明 L4 双向 E2E。

## 六、健壮性验证

覆盖项包括：

- 三种模式默认预算、显式覆盖、非法 mode、阶段推进和精确信号解析。
- 用户决策暂停、同 discussion 恢复、审计事件、maxTurns、maxDuration、消息预算、取消、重试和失败恢复。
- SQLite 旧 schema 增列、会话租约、多进程并发、项目隔离和 MCP 重启恢复。
- `auto/reuse` 跨 discussion 复用、fresh room 内复用和 fresh room 间隔离。
- 共享 room 关闭隔离，避免一个 discussion 归档另一个正在使用的 thread。
- 多 Skill 安装、修改检测、卸载保护和同名单目标冲突。
- live nonce 的正确、错误、附加说明、空回复及前提缺失语义。
- npm 包完整包含四项 Skill、参考协议和 OpenAI 元数据。

最终本地执行记录：

| 门禁 | 结果 |
| --- | --- |
| 干净 `npm ci --ignore-scripts` | PASS；161 packages，0 vulnerabilities |
| TypeScript 全工作区构建 | PASS |
| Vitest 4.1.10 | PASS；22 个测试文件，126 项测试 |
| Release MCP SDK 稳定性 | PASS；连续 30 次 connect / initialize / tools/list，每次 8 tools |
| UTF-8 | PASS；82 个文件 |
| `release:package` | PASS；`AgentBridge-v0.7.3-win32-x64` |
| `release:npm` | PASS；`@headstone/agentbridge@0.7.3` |
| `npm pack --dry-run --json` | PASS；23 个文件，约 329 KB，四项 Skill 完整包含 |

GitHub tag workflow 还会在 Windows、Linux、macOS 三个平台重复测试后发布资产和 checksum，并通过 npm provenance 发布。

## 七、剩余风险与后续项

1. CollaborationSession 显式 close/archive、idle TTL、context rollover 和 room cleanup 仍是 P1 生命周期增强；本轮先消除了数据破坏路径，不在没有明确产品语义时自动回收共享上下文。
2. `auto` 与 `reuse` 当前都复用项目 active room；后续应定义 `auto` 的轮换策略，或合并重复选项。
3. 自动化测试不能替代真实 Claude Code / Codex Host 的 L3/L4 验收。
4. Provider 若不遵守讨论末尾信号，系统会安全保留内容并令 `lastSignal=null`，不会伪造收敛。

## 八、最终判定

- 代码级审计：**通过**。
- 功能健壮性门禁：**通过**，以本报告最终执行记录为准。
- npm / GitHub 发布：允许使用新版本 `v0.7.3`；不得覆盖或复用 `v0.7.2` tag。
- 真实双向通信声明：**有条件通过**；完成 L3/L4 真实客户端验收后方可称为完整端到端通过。
