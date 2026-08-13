# AgentBridge v0.7.3 开发收尾报告

日期：2026-08-13  
分支：`agent/v0.7.3-robustness-audit`  
基线提交：`ade8f831924e8f9384d0daee170206821a233bfa`  
版本：`0.7.3`

## 1. 结论

AgentBridge v0.7.3 的功能开发、专项审计修复、健壮性测试、全量回归和本地打包已经完成。最终门禁结果为：

- TypeScript 全 workspace 构建通过。
- 22 个测试文件、128 项测试全部通过。
- 官方 MCP SDK 连续 30 次 `initialize -> tools/list` 握手通过。
- Windows 独立包内 CLI 输出 `0.7.3`，包内 MCP 返回 8 个工具。
- `npm audit --audit-level=low`：0 个漏洞。
- `git diff --check`：通过；只有 Git 的 CRLF/LF 提示，无空白错误。
- Codex Security 差异扫描已封存，13/13 个审查面闭合，0 个最终可报告安全问题。

当前代码和发布包已达到可提交状态，但本轮没有执行 GitHub push、PR merge、tag、GitHub Release 或 `npm publish`。

## 2. 本版主要开发内容

### 2.1 讨论深度与行为规范

新增并统一了三种讨论模式：

- `review`：快速评审，默认最多 3 个 provider 响应。
- `discussion`：常规讨论，默认最多 12 个 provider 响应。
- `deep-discussion`：深度决策讨论，默认最多 20 个 provider 响应。

讨论状态现在具有明确的收敛信号和停止原因，包括 `READY_TO_CLOSE`、`NEEDS_USER_DECISION`、最大轮次、provider 错误、取消与超时。`maxTurns`、总消息字符数、讨论持续时间、session/discussion lease 和单讨论并发请求共同限制资源消耗。

`NEEDS_USER_DECISION` 后必须由讨论参与者显式回复才会继续；`retryDiscussion` 的 `maxRetries` 只约束失败消息重发，不会形成自动无限循环。

### 2.2 会话生命周期与项目隔离

新增或强化：

- 项目级 collaboration session，支持 `auto`、`reuse`、`fresh` 策略。
- Claude/Codex provider session 与 collaboration session 的显式绑定。
- discussion lease、provider session lease、心跳续租、取消和重启恢复。
- 可选的关闭后 provider session 归档。
- provider session 只允许在所属项目内刷新；跨项目复用同一 `(provider, sessionId)` 会被拒绝。
- collaboration session 的绑定和查询同时校验 provider session 的项目归属。

最后两条是本轮审计收尾时新增的防御性修复，用于避免 provider 返回重复 session id 时改写已有项目归属。

### 2.3 CLI、MCP 与验证能力

新增或完善：

- `agentbridge verify`：验证 release 入口、MCP 初始化与工具列表；`--live` 明确区分 provider 可达性和真实宿主 E2E 证据。
- 官方 `@modelcontextprotocol/sdk` stdio 客户端 smoke，不使用 shell 拼接命令。
- MCP/CLI 对讨论模式、轮次和运行配置的严格解析。
- 发布 bundle 的 ESM `createRequire` 兼容层，解决 CommonJS 依赖在 standalone CLI 中启动失败的问题。
- smoke 子进程寿命使用标准十进制字符串 `30000`，避免 `Number.parseInt('30_000')` 实际只得到 30ms。

### 2.4 Skills

发行包包含 4 个职责清晰的 Skills：

1. `agentbridge-collaboration`：通用协作和讨论协议。
2. `agentbridge-peer-review`：快速交叉评审。
3. `agentbridge-decision-debate`：深度方案辩论与决策收敛。
4. `agentbridge-debug`：跨代理诊断和最小复现。

当前数量足以覆盖主要使用路径。继续增加泛化 Skill 会提高选择歧义和维护成本，因此本版不再扩充；后续只有在出现独立、重复、高频工作流时再增加。

安装器只发现直接子目录中的 `agentbridge-*` Skill，保留目标根目录约束、内容哈希和冲突保护；不会静默覆盖用户自定义 Skill。

## 3. 审计与修复

### 3.1 Codex Security 差异扫描

- Scan ID：`8b0156c8-475f-4ce0-8441-96dca22b3985`
- 扫描模式：working-tree diff
- 审查工作项：13/13 完成
- 候选项：2
- 最终可报告安全问题：0
- 覆盖完整度：complete
- 封存时间：`2026-08-12T18:13:49.555890Z`

两条候选的裁定：

- C01：provider session ID 跨项目重绑可作为存储健壮性缺陷复现，但 session ID 来自本机受信任 provider，没有证据表明低权限调用方可控制，因此不作为安全漏洞上报。尽管如此，本版已按项目归属不变量完成修复。
- C02：`retryCount` 在用户显式回复后可超过 `maxRetries`，但每次都需要已登记参与者发起新请求，并受轮次、消息、时长、lease 和并发限制；不是自动重试绕过。

封存报告对应修复前工作树快照。封存后仅追加了 C01 项目归属修复、smoke 寿命修复和 bundle ESM 兼容修复；这些变更均有定向测试、原始复现反证、包内 smoke 和最终全量回归。

### 3.2 修复验证

跨项目 provider session 原始复现：

- 修复前：第二次注册会把 owner 从 `/victim` 改为 `/attacker`。
- 修复后：第二次注册抛出 `belongs to another project`，owner 保持 `/victim`。
- 同项目重复注册仍能正常刷新状态和 metadata。
- 非所属 collaboration session 的绑定被拒绝。

发布 bundle 验证：

- 修复前：standalone CLI 在加载 `cross-spawn` 时因 ESM dynamic require 崩溃。
- 修复后：`agentbridge-cli.mjs version` 输出 `0.7.3`。
- 包内 MCP 通过官方 SDK 握手并返回全部 8 个工具。

## 4. 测试与质量门禁

| 检查 | 最终结果 |
| --- | --- |
| `npm test` | 22 个文件、128/128 项通过 |
| Storage 定向测试 | 29/29 通过 |
| 发布 bundle 定向测试 | 2/2 通过 |
| MCP/launcher 定向测试 | 9/9 通过 |
| 官方 MCP SDK 连续握手 | 30/30 通过 |
| Windows 包内 CLI | 输出 `0.7.3` |
| Windows 包内 MCP | PASS，8 个工具 |
| `npm audit --audit-level=low` | 0 vulnerabilities |
| `git diff --check` | 通过 |

未执行真实 Claude/Codex 双向回答 E2E，因为它依赖本机 provider 登录状态和授权环境。`verify --live` 在这些前置条件缺失时明确返回 `NOT_TESTED`/失败，不会误报通过。

## 5. 最终发布产物

### npm tarball

- 文件：`artifacts/headstone-agentbridge-0.7.3.tgz`
- npm 名称：`@headstone/agentbridge@0.7.3`
- 大小：328,784 bytes
- 文件数：23
- SHA-256：`B0B4B9CCACA249ABC946711D34B25908CE3A5863FA3DD7F62FDA04B5C5F28DE5`

### Windows 独立包

- 文件：`artifacts/AgentBridge-v0.7.3-win32-x64.zip`
- 大小：162,607,459 bytes
- SHA-256：`2066D29DCFB26891A16E9DCFF31708ED87236682BAC323FA4C000AF6276668D3`
- 内含 Node runtime、CLI/MCP bundles、Codex 平台依赖、安装脚本、文档和 4 个 Skills。

### Release bundles

- `release/agentbridge-cli.mjs`
  - 682,763 bytes
  - SHA-256：`655A715A176374F10DE1A1DEA0FC2EF463E7C21A832D61585F655AF732F358BD`
- `release/agentbridge-mcp.mjs`
  - 779,244 bytes
  - SHA-256：`4B60D317478511D2B9B0691A825AE3F2182A0D3B07601750C2BFB1C10F702A13`

Windows 包内的两个 bundle 与仓库 `release/` 中的最终 bundle 一致。

## 6. 用户配置要求

普通安装和本地 MCP 注册不要求用户手动编辑数据库或项目配置。安装/`setup` 会负责 MCP 注册和 Skills 安装。

仍需要用户完成的外部前置条件只有：

- Claude Code 和/或 Codex 已安装并登录。
- 如需 `verify --live`，显式提供可用的 provider 命令并允许真实 provider 调用。
- 如需发布到 npm，需要 npm 账号、scope 发布权限和登录/token。
- 如需 GitHub 合并发布，需要推送当前分支、创建/更新 PR、合并、创建 `v0.7.3` tag 和 Release。

## 7. 尚未执行的发布动作

以下动作有外部状态影响，本轮收尾没有执行：

1. 提交当前工作树。
2. 推送 `agent/v0.7.3-robustness-audit`。
3. 创建或更新 PR 并合并到默认分支。
4. 创建 `v0.7.3` tag 和 GitHub Release，上传 ZIP 和校验值。
5. 执行 `npm publish artifacts/headstone-agentbridge-0.7.3.tgz --access public`。

建议发布顺序：commit → push → PR/CI → merge → tag/Release → npm publish。发布前不要再次修改源码或 bundle；如有任何修改，应重新运行全量测试和两类打包命令并更新哈希。
