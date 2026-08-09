# AgentBridge

AgentBridge 是一个本地优先的 MCP 协作核心，让 Claude Code 和 Codex 能在同一个项目中互相提问、回复、重试、达成一致，并把讨论状态保存在项目本地的 SQLite 数据库中。

> 当前版本：v0.4.2。本项目以 GitHub Release 分发本地 stdio MCP；便携包自带 Node.js 运行时，不要求用户另外安装 Node 或 npm。

## 使用方法（先看这里）

### Windows：安装并配置当前项目

1. 打开 [GitHub Releases](https://github.com/HeadStone1/AgentBridge/releases)，下载 `AgentBridge-v版本-win32-x64.zip`。
2. 解压 ZIP，进入解压后的目录。
3. 在 PowerShell 中执行：

```powershell
powershell -ExecutionPolicy Bypass -File .\install.ps1 -ProjectPath "C:\你的项目目录"
```

安装脚本会把程序安装到 `%USERPROFILE%\.agentbridge`，并自动为指定项目配置 Claude Code 和 Codex。然后执行：

```powershell
& "$env:USERPROFILE\.agentbridge\bin\agentbridge.cmd" doctor "C:\你的项目目录"
```

最后完全退出并重新启动 Claude Code 和 Codex，使 MCP 配置重新加载。

### Linux / macOS：安装并配置当前项目

下载与系统匹配的 `tar.gz`，解压后执行：

```bash
./install.sh /absolute/path/to/your-project
~/.agentbridge/bin/agentbridge doctor /absolute/path/to/your-project
```

安装完成后重新启动 Claude Code 和 Codex。

### 验证是否成功

在 Claude Code 或 Codex 中要求它使用 AgentBridge，例如：

```text
请使用 AgentBridge 的 ask_peer 工具询问另一个代理：检查当前项目 README，并概括项目用途。
```

如果能收到另一个代理的回答，并且下面的命令能看到讨论记录，说明基本联通成功：

```powershell
& "$env:USERPROFILE\.agentbridge\bin\agentbridge.cmd" status "C:\你的项目目录"
```

Linux/macOS 使用：

```bash
~/.agentbridge/bin/agentbridge status /absolute/path/to/your-project
```

### 检查更新、安装更新和回滚

Windows：

```powershell
$ab = "$env:USERPROFILE\.agentbridge\bin\agentbridge.cmd"
& $ab version
& $ab update
& $ab update --install
& $ab rollback
```

Linux/macOS：

```bash
~/.agentbridge/bin/agentbridge version
~/.agentbridge/bin/agentbridge update
~/.agentbridge/bin/agentbridge update --install
~/.agentbridge/bin/agentbridge rollback
```

`update` 只检查，不修改文件；只有 `update --install` 才会下载对应平台的 Release 包，校验 `SHA256SUMS.txt` 后安装。程序按版本保存在 `~/.agentbridge/versions/`，项目中的配置和 SQLite 数据不会被覆盖。`rollback` 只切换到已经安装的上一版本。

### npm 安装（适合已经安装 Node.js 的开发者）

npm 包名为 `@headstone/agentbridge`，要求 Node.js `22.13` 或更高版本。建议全局安装，不建议用一次性的 `npx` 执行 `setup`，因为 MCP 配置需要一个长期稳定的程序路径。

```bash
npm install --global @headstone/agentbridge
agentbridge setup /absolute/path/to/your-project
agentbridge doctor /absolute/path/to/your-project
```

升级 npm 安装版本：

```bash
npm install --global @headstone/agentbridge@latest
agentbridge setup /absolute/path/to/your-project
```

升级后重新运行 `setup` 可以确认 Claude/Codex 配置仍指向当前全局安装位置。npm 安装不携带 Node 运行时；不想管理 Node/npm 的用户应使用上面的 GitHub Release 便携包。

## 目录

- [它如何工作](#它如何工作)
- [使用方法（先看这里）](#使用方法先看这里)
- [当前功能与边界](#当前功能与边界)
- [虚拟机快速开始](#虚拟机快速开始)
- [配置 Claude 和 Codex](#配置-claude-和-codex)
- [首次真实联通测试](#首次真实联通测试)
- [MCP 工具说明](#mcp-工具说明)
- [讨论状态说明](#讨论状态说明)
- [管理命令](#管理命令)
- [环境变量](#环境变量)
- [更新到最新版](#更新到最新版)
- [备份、恢复与卸载](#备份恢复与卸载)
- [常见问题](#常见问题)
- [开发与发布](#开发与发布)
- [安全说明](#安全说明)

## 它如何工作

Claude Code 和 Codex 各自启动一个短生命周期的 stdio MCP 进程。两个 MCP 进程共享项目中的 SQLite 数据库，但各自代表不同的代理身份。

```mermaid
flowchart LR
    C["Claude Code"] -->|"stdio · AGENT=claude"| CM["AgentBridge MCP"]
    X["Codex"] -->|"stdio · AGENT=codex"| XM["AgentBridge MCP"]
    CM -->|"App Server 优先 · CLI 回退"| XP["Codex peer"]
    XM -->|"调用 Claude CLI"| CP["Claude peer"]
    CM --> DB[(".agentbridge/agentbridge.sqlite")]
    XM --> DB
```

AgentBridge 不会把代码或讨论上传到自己的云服务。实际模型请求仍由本机安装并已登录的 Claude/Codex 客户端发送给各自的服务商。

## 当前功能与边界

已实现：

- 使用 Node 内置 `node:sqlite` 的 SQLite WAL 存储。
- 双 MCP 进程共享讨论、消息、决定、审计事件、会话租约和 provider 原生会话 ID。
- `ask_peer`、`reply_peer`、`get_discussion`、`list_discussions`、`close_discussion`、`cancel_discussion`、`retry_discussion` 七个 MCP 工具。
- Claude CLI、Codex CLI 和 Codex App Server 的会话 ID 按讨论持久化；MCP 重启后自动续接，续接失败时使用 SQLite 历史重建有界上下文。
- 自动发现 Codex Desktop 自带的可执行程序，优先使用 App Server stdio 协议。
- App Server 不可用时自动回退到 Codex CLI `exec --json` 和 `exec resume`。
- 讨论轮数、重试次数、总消息长度和持续时间限制。
- `init`、`setup`、`doctor`、`status`、`register-session`、`version`、`update`、`rollback` 和 `uninstall` 管理命令。
- 增量修改 Claude JSON 与 Codex TOML 配置，修改前生成备份。
- 并发 SQLite 启动锁等待与双进程回归测试。

当前边界：

- 必须在运行 AgentBridge 的系统或虚拟机内安装并登录 Claude/Codex；宿主机登录状态不会自动进入虚拟机。
- Codex App Server 适配器会启动一个新的受控子进程，不会接管已打开的 Codex Desktop 私有进程。
- 尚无常驻 HTTP 服务、Web UI、PostgreSQL/Redis、严格模式或等待队列。
- 正在执行中的 provider 请求仍无法在进程崩溃后原地恢复；代码签名、静默后台更新和云端部署仍是后续工作。
- 是否能完成真实调用最终取决于本机 provider 版本、账号权限、网络和模型配额。

## 虚拟机快速开始

以下命令以 Linux/bash 为主。PowerShell 可执行同样的 `git`、`npm` 和 `node` 命令，只需把路径换成 Windows 路径。

### 1. 检查必需软件

```bash
git --version
node --version
npm --version
claude --version
# 仅 Codex CLI 用户需要：
codex --version
```

要求：

- Node.js `22.13` 或更高版本。
- Git。
- Claude 侧需要可调用的 Claude CLI；Codex 侧可以只安装 Codex Desktop，也可以安装 Codex CLI。
- Claude/Codex 已在虚拟机内完成登录，并能各自单独执行一次普通请求。

GUI 用户不要求手工把 Codex 加入 `PATH`。Windows 上会自动检查 Codex Desktop 的 `%LOCALAPPDATA%\OpenAI\Codex\bin\codex.exe` 及其版本化运行文件；macOS 上会检查标准应用目录。找不到桌面端时才尝试 PATH 中的 `codex`。

如果 `node --version` 低于 `v22.13.0`，先升级 Node。Node 22.5–22.12 的 `node:sqlite` 默认仍需要实验开关，不在本项目支持范围内。

### 2. 获取或更新代码

首次下载：

```bash
git clone --branch main --single-branch https://github.com/HeadStone1/AgentBridge.git
cd AgentBridge
```

已经克隆过：

```bash
cd AgentBridge
git pull --ff-only origin main
```

确认版本：

```bash
git log -1 --oneline
```

### 3. 安装依赖并构建

```bash
npm install
npm test
npm run build
```

测试成功时应看到所有测试通过。构建产物位于各 package 的 `dist/` 目录。

### 4. 初始化项目

在 AgentBridge 仓库目录运行：

```bash
node packages/cli/dist/index.js setup .
```

该命令会：

1. 创建 `.agentbridge/project.json`。
2. 在需要时创建 `.agentbridge/agentbridge.sqlite`。
3. 增量更新 `~/.claude.json`。
4. 创建或增量更新当前项目的 `.codex/config.toml`。
5. 修改已有配置前创建 `*.agentbridge.bak` 备份。

如果只想初始化本地状态、不修改 provider 配置：

```bash
node packages/cli/dist/index.js setup . --no-config
```

如果使用非默认配置文件：

```bash
node packages/cli/dist/index.js setup . \
  --claude-config /path/to/claude.json \
  --codex-config /path/to/config.toml
```

### 5. 运行诊断

```bash
node packages/cli/dist/index.js doctor .
node packages/cli/dist/index.js status .
```

重点检查 `doctor` 输出：

- `node.supported` 应为 `true`。
- `providers.claudeCli` 应在使用 Claude CLI 时为 `true`。
- `providers.codexSelectedBackend.mode` 默认应优先显示 `app-server`。
- `providers.codexSelectedBackend.source` 为 `desktop` 时，表示已自动找到 GUI 自带运行文件。
- App Server 不可用而 CLI 可用时，`providers.codexSelectedBackend.mode` 会显示 `cli`。
- `database.readable` 应为 `true`。

## 配置 Claude 和 Codex

### 代理身份非常重要

两个 MCP 进程使用同一入口文件，但必须拥有不同的 `AGENTBRIDGE_AGENT`：

| 宿主 | 必需值 | 对端 |
|---|---|---|
| Claude Code | `AGENTBRIDGE_AGENT=claude` | Codex |
| Codex | `AGENTBRIDGE_AGENT=codex` | Claude |

当前 `setup` 会自动生成两个 MCP 条目，分别写入正确的 `AGENTBRIDGE_AGENT`，并让两端共享同一个绝对数据库路径。下面的示例主要用于检查或手工配置。修改配置后重启 Claude Code 和 Codex。

配置按项目隔离：Claude 使用 `~/.claude.json` 中的 `projects[绝对项目路径]` 本地作用域；Codex 使用项目根目录的 `.codex/config.toml`。因此多个项目可以同时拥有各自的 AgentBridge 数据库，不会由后一次 `setup` 覆盖前一个项目。相关作用域由 [Claude Code MCP 文档](https://code.claude.com/docs/en/mcp) 和 [OpenAI Codex MCP 文档](https://learn.chatgpt.com/docs/extend/mcp?surface=cli) 定义。

### Claude 配置示例

默认文件：

- Linux/macOS：`~/.claude.json`
- Windows：`C:\Users\<用户名>\.claude.json`

只展示 AgentBridge 相关部分：

```json
{
  "projects": {
    "/absolute/path/to/project": {
      "mcpServers": {
        "agentbridge": {
          "command": "/absolute/path/to/node",
          "args": [
            "/absolute/path/to/AgentBridge/packages/mcp/dist/cli.js"
          ],
          "env": {
            "AGENTBRIDGE_AGENT": "claude",
            "AGENTBRIDGE_PROJECT_PATH": "/absolute/path/to/project",
            "AGENTBRIDGE_DB_PATH": "/absolute/path/to/project/.agentbridge/agentbridge.sqlite"
          }
        }
      }
    }
  }
}
```

保留文件中已有的其他字段和 MCP 服务，不要用示例覆盖整个文件。JSON 中的 Windows 反斜杠必须写成 `\\`，或者使用正斜杠路径。

### Codex 配置示例

默认文件位于当前项目，而不是用户级 Codex 配置：

- Linux/macOS：`<项目>/.codex/config.toml`
- Windows：`<项目>\.codex\config.toml`

```toml
[mcp_servers.agentbridge]
command = '/absolute/path/to/node'
args = ['/absolute/path/to/AgentBridge/packages/mcp/dist/cli.js']
cwd = '/absolute/path/to/project'
env.AGENTBRIDGE_AGENT = 'codex'
env.AGENTBRIDGE_PROJECT_PATH = '/absolute/path/to/project'
env.AGENTBRIDGE_DB_PATH = '/absolute/path/to/project/.agentbridge/agentbridge.sqlite'
```

Claude 和 Codex 的 `AGENTBRIDGE_DB_PATH` 必须指向同一个文件，否则双方看不到同一场讨论。建议使用绝对路径，尤其是在虚拟机、容器或从不同工作目录启动 provider 时。

工具参数中的显式 `projectPath` 优先级最高；未提供时依次使用 `AGENTBRIDGE_PROJECT_PATH`、Claude 提供的 `CLAUDE_PROJECT_DIR`，最后才回退到进程当前目录。

可用以下命令取得绝对路径：

```bash
which node
pwd
```

PowerShell：

```powershell
(Get-Command node).Source
(Get-Location).Path
```

### Codex GUI 优先与 App Server

默认策略为 `auto`，无需提供 Codex CLI 路径：

1. 先检查显式环境变量。
2. 自动查找 Codex Desktop 自带的可执行程序。
3. 对每个候选程序运行 `app-server --help` 能力探测。
4. 优先启动独立的 stdio App Server；不支持时才回退到 `codex exec`。

App Server 是 OpenAI 为富客户端集成提供的公开协议，stdio 是默认传输。参见 [OpenAI Codex App Server 文档](https://learn.chatgpt.com/docs/app-server)。

一般用户只需运行：

```bash
node packages/cli/dist/index.js setup .
node packages/cli/dist/index.js doctor .
```

如果自动发现失败，可以显式指定支持 App Server 的可执行程序：

```bash
node packages/cli/dist/index.js setup . \
  --codex-app-command /absolute/path/to/codex-executable
```

也可以设置：

```bash
export AGENTBRIDGE_CODEX_APP_COMMAND=/absolute/path/to/codex-executable
```

也可以强制后端模式：

```bash
# 只允许 App Server，探测失败时直接报错
node packages/cli/dist/index.js setup . --codex-mode app-server

# 强制使用传统 CLI 通道
node packages/cli/dist/index.js setup . --codex-mode cli \
  --codex-command /absolute/path/to/codex
```

GUI 优先不等于接管当前窗口。AgentBridge 会复用 GUI 安装中公开的 Codex 运行程序和登录配置，但会启动新的受控 App Server 子进程；它不会连接到已经打开的 Codex Desktop 私有会话，也不会读取当前 GUI 对话。

## 首次真实联通测试

完成配置后，完全退出并重新启动 Claude Code 和 Codex，使 MCP 配置重新加载。

### 从 Claude 发起

在 Claude Code 中输入类似请求：

```text
请使用 AgentBridge 的 ask_peer 工具询问 Codex：
检查当前项目的 README，并用一句话回复是否能正常读取项目。
```

Claude 调用的工具参数应类似：

```json
{
  "peer": "codex",
  "message": "检查当前项目的 README，并用一句话回复是否能正常读取项目。",
  "projectPath": "/absolute/path/to/AgentBridge"
}
```

成功响应通常包含：

- `discussionId`，例如 `dsc_...`。
- `messageId`。
- `status: "DISCUSSING"`。
- provider 可用时的 `peerResponse`。

### 从 Codex 发起

在 Codex 中输入：

```text
请使用 AgentBridge 的 ask_peer 工具询问 Claude：
总结 package.json 中提供的 npm scripts。
```

Codex 侧 `peer` 必须是 `claude`。

### 检查持久化结果

```bash
node packages/cli/dist/index.js status .
```

也可以让任一代理调用：

```json
{
  "name": "list_discussions",
  "arguments": {
    "projectPath": "/absolute/path/to/AgentBridge"
  }
}
```

如果真实调用失败，讨论记录仍可能保存为 `PEER_BUSY`、`FAILED` 或 `TIMEOUT`，可通过 `status` 或 `get_discussion` 查看。

## MCP 工具说明

### `ask_peer`

开始一场新讨论，并调用另一代理。

```json
{
  "peer": "codex",
  "message": "请审查这个实现方案。",
  "projectPath": "/project/path"
}
```

- Claude 侧只能选择 `codex`。
- Codex 侧只能选择 `claude`。
- `projectPath` 可省略，默认使用 MCP 进程当前工作目录。
- 返回的 `discussionId` 用于后续所有操作。

### `reply_peer`

继续已有讨论，并把回复发送给另一参与者。

```json
{
  "discussionId": "dsc_xxxxxxxxxxxx",
  "message": "我接受第一点，但建议修改超时策略。"
}
```

发送者由当前 MCP 宿主身份决定，不需要在参数中指定。

### `get_discussion`

读取讨论详情、全部消息以及最终决定。

```json
{
  "discussionId": "dsc_xxxxxxxxxxxx"
}
```

### `list_discussions`

列出讨论。可按项目路径过滤：

```json
{
  "projectPath": "/project/path"
}
```

不传 `projectPath` 时会列出当前数据库中的全部讨论。

### `close_discussion`

记录当前代理对结论的接受，并自动请求对端确认：

```json
{
  "discussionId": "dsc_xxxxxxxxxxxx",
  "conclusion": "采用 WAL，并在申请写锁前设置有界等待。"
}
```

重要规则：

- AgentBridge 会把规范结论和 decision hash 发送给对端，要求对端返回结构化的接受或拒绝结果。
- 对端接受同一 hash 时自动记录第二份 agreement，进入 `COMPLETED` 并生成决定记录。
- 对端不可用、回复格式无效或拒绝时保持 `DISCUSSING`，返回 `waitingFor` 和可用的 `peerResponse`，调用方可以继续讨论后再次提交。
- 自动确认不可用时仍兼容手工双签：另一个代理可使用相同 `discussionId` 和完全相同的 `conclusion` 调用一次 `close_discussion`。

讨论消息始终完整保存在 SQLite 中。发送给新 provider 会话的恢复上下文采用“首条提案 + 尽可能多的最近消息”，默认历史字符预算为 48,000，并对单条历史消息截断；成功续接 provider 原生会话时不会重复注入历史。

### `cancel_discussion`

取消讨论并释放本地会话租约：

```json
{
  "discussionId": "dsc_xxxxxxxxxxxx"
}
```

### `retry_discussion`

在 `FAILED`、`PEER_BUSY`、`TIMEOUT` 或 `NEEDS_USER_DECISION` 后，重新派发最后一条消息：

```json
{
  "discussionId": "dsc_xxxxxxxxxxxx"
}
```

失败重试会消耗重试预算。达到上限后，讨论进入 `NEEDS_USER_DECISION`。

## 讨论状态说明

| 状态 | 含义 | 常用后续操作 |
|---|---|---|
| `CREATED` | 已创建，尚未正式讨论 | 等待派发 |
| `DISCUSSING` | 正在讨论 | `reply_peer`、`close_discussion` |
| `AGREED` | 双方已同意，正在生成/完成决定 | 通常自动进入 `COMPLETED` |
| `IMPLEMENTING` | 预留的实现阶段 | 当前本地流程较少使用 |
| `REVIEWING` | 预留的审查阶段 | 当前本地流程较少使用 |
| `COMPLETED` | 已完成 | `get_discussion` |
| `FAILED` | provider 或处理失败 | `retry_discussion` |
| `PEER_BUSY` | 对端繁忙或不可用 | 检查 provider，再重试 |
| `TIMEOUT` | 超时或达到资源限制 | 检查原因，再重试或取消 |
| `NEEDS_USER_DECISION` | 自动恢复或重试预算已用尽 | 用户决定重试或取消 |
| `CANCELLED` | 已取消 | 只读查看历史 |

## 管理命令

Release 安装用户在 Windows 使用：

```powershell
& "$env:USERPROFILE\.agentbridge\bin\agentbridge.cmd" <command> [path] [options]
```

Linux/macOS 使用：

```bash
~/.agentbridge/bin/agentbridge <command> [path] [options]
```

从源码运行的开发者使用：

```bash
node packages/cli/dist/index.js <command> [path] [options]
```

| 命令 | 作用 |
|---|---|
| `init [path]` | 只创建 `.agentbridge/project.json` |
| `setup [path]` | 初始化项目并配置 MCP |
| `doctor [path]` | 检查 Node、数据库和 provider 可用性 |
| `status [path]` | 显示会话、讨论和审计指标 |
| `register-session` | 手动登记 provider 原生会话 |
| `version` | 显示当前程序版本 |
| `update` | 从 GitHub Releases 检查稳定版更新，不安装 |
| `update --install` | 下载、校验并安装当前平台的最新稳定版 |
| `update --channel beta` | 检查包含预发布版本的更新通道 |
| `rollback` | 切换到本机已经安装的上一版本 |
| `uninstall [path] --yes` | 删除本地状态并移除 AgentBridge MCP 条目 |

查看帮助：

```bash
node packages/cli/dist/index.js help
```

手动登记会话示例：

```bash
node packages/cli/dist/index.js register-session \
  --provider codex \
  --session-id SESSION_ID \
  --status IDLE \
  --project-path . \
  --metadata '{"source":"manual"}'
```

支持的会话状态为 `IDLE`、`BUSY`、`BRIDGE_OWNED` 和 `UNKNOWN`。

## 环境变量

| 变量 | 用途 | 默认值/说明 |
|---|---|---|
| `AGENTBRIDGE_AGENT` | 当前 MCP 身份 | `claude`；Codex 侧必须显式设置为 `codex` |
| `AGENTBRIDGE_PROJECT_PATH` | 当前项目的稳定绝对路径 | `setup` 自动写入；其次使用 `CLAUDE_PROJECT_DIR` |
| `AGENTBRIDGE_DB_PATH` | SQLite 数据库路径 | `<项目>/.agentbridge/agentbridge.sqlite` |
| `AGENTBRIDGE_CLAUDE_COMMAND` | Claude CLI 命令或绝对路径 | `claude` |
| `AGENTBRIDGE_CODEX_MODE` | Codex 后端策略 | `auto`；也可设为 `app-server` 或 `cli` |
| `AGENTBRIDGE_CODEX_COMMAND` | Codex 可执行程序覆盖路径 | 未设置时自动发现 Desktop，再尝试 PATH |
| `CODEX_CLI_PATH` | Codex CLI 备用路径 | 无 |
| `AGENTBRIDGE_CODEX_MODEL` | Codex CLI 模型覆盖 | 使用 Codex 默认模型 |
| `AGENTBRIDGE_CODEX_APP_COMMAND` | 仅用于 App Server 的可执行程序覆盖路径 | 未设置时自动发现 Desktop |
| `AGENTBRIDGE_RECOVERY_MAX_AGE_MS` | 旧讨论恢复阈值 | 默认 30 分钟 |

不要把测试专用的 `AGENTBRIDGE_TEST_*` 变量用于生产配置。

## 更新到最新版

### Release 安装用户

检查新版不会修改本机：

```powershell
& "$env:USERPROFILE\.agentbridge\bin\agentbridge.cmd" update
```

确认后安装：

```powershell
& "$env:USERPROFILE\.agentbridge\bin\agentbridge.cmd" update --install
```

更新流程会：

1. 调用 `HeadStone1/AgentBridge` 的 GitHub Releases API。
2. 选择当前操作系统和 CPU 架构对应的包。
3. 下载 Release 包与 `SHA256SUMS.txt`。
4. 校验 SHA-256；缺少校验文件或校验失败时拒绝安装。
5. 安装到 `~/.agentbridge/versions/<版本>/`，再切换 `current` 版本指针。
6. 保留旧版本、项目 MCP 配置和项目 SQLite 数据。

安装成功后重启 Claude Code 和 Codex。需要回退时：

```powershell
& "$env:USERPROFILE\.agentbridge\bin\agentbridge.cmd" rollback
```

Linux/macOS 把命令入口替换为 `~/.agentbridge/bin/agentbridge`。

### 源码安装用户

在虚拟机或目标机器中执行：

```bash
cd AgentBridge
git status
git pull --ff-only origin main
npm install
npm test
npm run build
node packages/cli/dist/index.js setup .
node packages/cli/dist/index.js doctor .
```

如果 `git status` 显示有未提交修改，先确认这些修改是否需要保留。需要保留时：

```bash
git stash
git pull --ff-only origin main
git stash pop
```

不要在不了解本地修改用途时执行强制重置。

## 备份、恢复与卸载

### 配置备份

AgentBridge 修改已有配置前会创建：

- `~/.claude.json.agentbridge.bak`
- `<项目>/.codex/config.toml.agentbridge.bak`

每次配置前建议另外复制一份带时间戳的备份，因为固定名称的 `.agentbridge.bak` 可能被后续操作覆盖。

Linux 恢复示例：

```bash
cp ~/.claude.json.agentbridge.bak ~/.claude.json
cp .codex/config.toml.agentbridge.bak .codex/config.toml
```

### 讨论数据备份

停止 Claude/Codex 后，复制整个 `.agentbridge` 目录：

```bash
cp -a .agentbridge .agentbridge.backup
```

数据库可能使用 `-wal` 和 `-shm` 文件，因此不要只复制主 `.sqlite` 文件，也不要在活跃写入期间直接复制。

### 卸载

```bash
node packages/cli/dist/index.js uninstall . --yes
```

该操作会：

- 从 Claude/Codex 配置中移除名为 `agentbridge` 的 MCP 条目。
- 保留其他 MCP 服务和 provider 配置。
- 删除当前项目的 `.agentbridge` 目录，包括讨论数据库。

卸载会删除本地讨论数据；需要保留时先执行备份。

## 常见问题

### `Cannot find module 'node:sqlite'` 或 SQLite 实验功能错误

原因：Node 版本过低。

```bash
node --version
```

升级到 Node `22.13` 或更高版本，然后重新执行：

```bash
npm install
npm run build
```

### `claudeCli: false` 或 `codexCli: false`

先分别执行：

```bash
claude --version
codex --version
```

如果只在某个 shell 中可用，请在 MCP 配置中把 `AGENTBRIDGE_CLAUDE_COMMAND` 或 `AGENTBRIDGE_CODEX_COMMAND` 设置为绝对路径。还要确认 provider 已在虚拟机内完成登录。

### MCP 工具中出现了错误的 `peer`

例如 Codex 侧的 `ask_peer` 仍只允许选择 `codex`，通常说明 Codex MCP 被错误识别成 Claude。

检查 Codex 的 `config.toml`：

```toml
env.AGENTBRIDGE_AGENT = 'codex'
```

Claude 侧则应为：

```json
"AGENTBRIDGE_AGENT": "claude"
```

修改后完全重启两个 provider。

### 两边看不到同一场讨论

确认两个配置中的 `AGENTBRIDGE_DB_PATH` 完全相同，并且虚拟机用户对该目录有读写权限。建议使用绝对路径。

### `database is locked`

当前版本会在启动阶段进行 5 秒有界等待。若仍出现锁错误：

1. 确认使用的是最新 `main` 并已重新构建。
2. 确认数据库不在不可靠的网络共享或不支持标准文件锁的挂载点。
3. 关闭遗留的 Claude/Codex/MCP 进程后重试。
4. 不要让多个不同项目误用同一个数据库路径。

### `peer is not available` 或 `PEER_BUSY`

执行：

```bash
node packages/cli/dist/index.js doctor .
```

确认对端 CLI 可运行、账号已登录、网络正常。问题解决后调用 `retry_discussion`，无需重新创建讨论。

### Codex 后端不可用或返回 `no agent message`

先运行诊断并查看实际选中的后端：

```bash
node packages/cli/dist/index.js doctor .
```

如果 `codexSelectedBackend.mode` 是 `app-server`，检查对应程序能否执行 `app-server --help`。如果模式是 `cli`，再独立验证：

```bash
codex --version
codex exec --json "只回复 OK"
```

如果底层命令本身失败，先修复 Codex 安装、登录或网络；AgentBridge 无法绕过 provider 的认证或账号限制。

### 修改配置后 MCP 工具没有出现

1. 检查 JSON/TOML 语法。
2. 确认 `command` 和 `args` 都是绝对路径。
3. 重新执行 `npm run build`。
4. 完全退出并重启 Claude Code/Codex。
5. 再运行 `doctor`。

### `git pull --ff-only` 失败

先执行：

```bash
git status
git branch --show-current
git remote -v
```

确认当前在 `main`，远端是 `https://github.com/HeadStone1/AgentBridge.git`，并处理未提交修改后再更新。

### Windows 提示 Git `dubious ownership`

仅在确认仓库确实属于当前用户后执行：

```powershell
git config --global --add safe.directory C:/absolute/path/to/AgentBridge
```

不要把不可信目录加入安全列表。

## 开发与发布

开发要求 Node.js `22.13` 或更高版本。

```bash
npm install
npm test
npm run build
npm run baseline
npm run release
npm run release:package
npm run release:npm
```

脚本说明：

- `npm test`：运行单元和集成测试。
- `npm run build`：按依赖顺序构建所有 workspace。
- `npm run baseline`：测量 MCP 启动时间和内存基线。
- `npm run release`：重新构建并生成 `release/agentbridge-mcp.mjs` 与 `release/agentbridge-cli.mjs`。
- `npm run release:package`：为当前平台生成包含 Node 运行时、固定 launcher 和安装脚本的 `artifacts/AgentBridge-v版本-平台-架构/`。
- `npm run release:npm`：生成只包含编译 bundle 和必要文档的 `artifacts/npm/`，包名为 `@headstone/agentbridge`。

`release/*.mjs` 是需要 Node 的单文件 bundle；最终 GitHub Release 压缩包会同时携带 Node 运行时，因此普通用户不需要预装 Node/npm。它仍不是代码签名的原生 EXE。

### 发布新版本

1. 修改根目录 `package.json` 的版本号，并更新 README/DEVLOG。
2. 执行：

```bash
npm ci
npm test
npm run release:package
```

3. 提交代码后创建与 `package.json` 完全一致的标签：

```bash
git tag v0.4.2
git push origin main
git push origin v0.4.2
```

标签推送后，[GitHub Actions Release 工作流](.github/workflows/release.yml) 会再次执行构建和测试，然后分别在 Windows、Linux、macOS runner 上打包自带运行时的压缩包，生成 `SHA256SUMS.txt`，最后创建 GitHub Release。标签与 `package.json` 版本不一致时工作流会拒绝发布。

预发布版本使用标准 SemVer，例如把版本改为 `0.4.1-beta.1`，再推送 `v0.4.1-beta.1` 标签；工作流会把它标记为 GitHub prerelease，用户通过 `update --channel beta` 检查。

### 首次发布 npm 包

第一次创建 `@headstone/agentbridge` 时，需要包所有者在自己的终端完成 npm 登录和首次发布，不要把密码、Token 或一次性验证码提交到仓库或发送给其他人：

```bash
npm login
npm run release:npm
npm pack ./artifacts/npm --dry-run
npm publish ./artifacts/npm --access public
```

首次发布成功后，在 npmjs.com 的 `@headstone/agentbridge` 包设置中添加 GitHub Actions Trusted Publisher：

- GitHub owner：`HeadStone1`
- Repository：`AgentBridge`
- Workflow：`release.yml`
- Environment：留空，除非以后专门创建 npm 发布 environment

之后推送与 `package.json` 版本一致的 Git 标签时，Release 工作流会通过 GitHub OIDC 发布 npm 包并生成 provenance，不需要在 GitHub Secrets 中保存长期 npm Token。若相同版本已由首次手工发布，工作流会检测后跳过，避免重复版本导致失败。

项目主要目录：

```text
packages/protocol       协议类型和状态机
packages/storage        SQLite 存储
packages/audit          审计与指标
packages/connectors     Claude/Codex/App Server 连接器
packages/collaboration  协作业务逻辑
packages/mcp            MCP Server 与 stdio 入口
packages/cli            管理命令与配置写入
tests                   单元和双进程集成测试
release                 打包后的 Node artifacts
artifacts               当前平台的便携 Release 目录（不提交 Git）
scripts                 打包、安装与固定 launcher
.github/workflows       标签触发的跨平台 Release 自动化
```

## 安全说明

- Claude 连接器使用 print/plan 模式，不开启 permission bypass。
- Codex 连接器默认使用 `read-only` sandbox，不默认启用危险权限绕过。
- 子进程通过参数数组启动，未使用 shell 字符串拼接。
- 对端讨论内容被标记为不可信上下文，但模型输出仍应由调用方审查。
- `.agentbridge/agentbridge.sqlite` 包含讨论消息和审计信息，默认未加密；请按项目敏感级别保护文件权限和备份。
- provider 配置备份可能包含其他 MCP 环境变量或凭据，不要上传到公共仓库。
- AgentBridge 不会替代 Claude/Codex 自身的权限、沙箱、认证和网络安全策略。

## 最小验收清单

部署完成后逐项确认：

- [ ] `node --version` 不低于 `22.13`。
- [ ] `npm test` 全部通过。
- [ ] `npm run build` 成功。
- [ ] Claude 配置包含 `AGENTBRIDGE_AGENT=claude`。
- [ ] Codex 配置包含 `AGENTBRIDGE_AGENT=codex`。
- [ ] 两边使用同一个绝对 `AGENTBRIDGE_DB_PATH`。
- [ ] `doctor` 能检测到需要的 provider。
- [ ] Claude 能通过 `ask_peer` 收到 Codex 回复。
- [ ] Codex 能通过 `ask_peer` 收到 Claude 回复。
- [ ] `status` 能看到刚才的讨论记录。
- [ ] 一边提交结论且对端结构化接受后，讨论自动进入 `COMPLETED`；无法自动确认时手工双签仍可完成。
