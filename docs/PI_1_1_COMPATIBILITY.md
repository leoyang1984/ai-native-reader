# pi 1.1.0 兼容更新 / Compatibility update

Reader v0.1.5 · 2026-10-08

## 支持范围 / Accepted versions

- pi：1.0.0、1.0.1、1.0.2、1.0.3、1.0.4、**1.1.0**。未自动接受未经审查的其他版本。
- Codex CLI：0.159.2、0.160.0、0.160.1，保持 v0.1.4 的程序路径恢复。
- npm 版 pi 1.1.0 声明需要 Node.js ≥22.19.0。Reader 不捆绑 CLI、账号或密钥。

Pi 1.1.0 is now accepted alongside 1.0.0–1.0.4. Other unreviewed releases remain rejected. Codex support and launcher recovery are retained. The npm pi package requires Node.js ≥22.19.0; CLIs and credentials are not bundled.

## 协议核对 / Protocol review

核对上游 v1.0.4 到 v1.1.0 的 53 个提交、242 个变更文件，并逐字节比较 11 个关键文件。

- RPC 命令文档、RPC 概览、RPC 实现、RPC 类型、会话管理和启动入口共 6 个文件未改动。Reader 所用 get_state、new_session、switch_session、prompt、abort 及现有流式正文处理可继续使用。
- 会话结束事件新增 agent_settled.aborted。Reader 将 true 视为取消，避免将被中止的回答标记为完成；旧版无此字段时继续使用原有处理。
- pi 1.1.0 继续使用 --no-mcp，并保留禁用工具、扩展、技能、提示模板、主题、上下文文件和启动网络操作等已有参数。旧版 1.0.0–1.0.3 不传入 --no-mcp。
- 保留 pi-rpc/1.0.0 的协议绑定和 pi:<sessionId>，不因 CLI 版本升级主动清除对话。Reader 的依赖和数据结构未变。

The comparison covers 53 commits and 242 changed files, with byte comparisons of 11 key files. Six files are identical: RPC overview, commands, implementation, types, session manager and startup entry. The new agent_settled.aborted flag is treated as cancellation. Pi 1.1.0 receives --no-mcp and the existing resource restrictions; older 1.0.0–1.0.3 releases do not receive that flag. Existing conversation bindings and application dependencies remain unchanged.

## 使用 / Use

退出旧版 Reader，安装 v0.1.5，重新打开，在「助手连接」中选择 pi 并重新连接。沿用 pi 现有模型及登录配置，无需重建 Reader 书库或 Vault。无法恢复的模型会话仍需开启新对话，Reader 历史保留。

Quit Reader, install v0.1.5, reopen it and reconnect pi. Existing pi model/login configuration is used. Books and Vault configuration need no migration. If a model session cannot be resumed, start a new conversation; Reader history remains available.

## 依据与验证范围 / Sources and scope

- [上游版本比较 / Upstream comparison](https://github.com/earendil-works/pi/compare/v1.0.4...v1.1.0)
- [RPC 实现 / RPC implementation](https://github.com/earendil-works/pi/blob/v1.1.0/packages/coding-agent/src/modes/rpc/rpc-mode.ts)
- [结束事件 / Session lifecycle](https://github.com/earendil-works/pi/blob/v1.1.0/packages/coding-agent/src/core/agent-session.ts)
- [启动参数 / CLI options](https://github.com/earendil-works/pi/blob/v1.1.0/packages/coding-agent/docs/cli.md)
- [npm 元数据 / Package metadata](https://registry.npmjs.org/@earendil-works%2fpi-coding-agent/1.1.0)

本次完成代码与协议审查、应用构建和发行包完整性检查；未新增或运行实现测试，未发送真实模型问答。pi 1.1.0 的真实问答、停止和会话恢复尚未重新验收。此前完整阅读流程使用 Codex 0.160.0 / pi 1.0.0。代码支持不等于所有服务商和模型均已验证。

This update reviews code and protocols, builds the app and checks release integrity. No implementation tests or real model prompts were run. Live chat, stopping and session recovery with pi 1.1.0 have not been revalidated. Earlier full workflow acceptance used Codex 0.160.0 / pi 1.0.0. Provider/model combinations are not all verified.
