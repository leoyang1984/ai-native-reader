# 助手 CLI 兼容更新 / Assistant CLI compatibility

更新日期 / Updated: 2026-10-07。Reader v0.1.3。

## 支持范围 / Supported versions

| 助手 / Assistant | 接受的版本 / Accepted versions | 真实问答验收 / Prior live acceptance |
| --- | --- | --- |
| Codex CLI | 0.159.2、0.160.0、**0.160.1** | 0.160.0 |
| pi | 1.0.0、1.0.1、1.0.2、1.0.3、**1.0.4** | 1.0.0 |

更新 Reader 后打开「助手连接」，选择已安装的 Codex 或 pi，再点击「重新连接」。不用同时安装两个 CLI，也无需重复登录、迁移阅读数据或配置 MCP。连接时 Reader 在后台启动所选 CLI，不需要另开桌面应用或终端窗口。

After updating Reader, open the assistant connection dialog, select your installed Codex or pi, and reconnect. Choose one CLI; installing both is unnecessary. No login reset, reading data migration, or MCP configuration is required. Reader starts the selected CLI in the background.

列表之外的版本仍会提示不兼容；支持范围依据具体版本的协议核对，未自动开放未来版本。

Versions outside the list remain unsupported until their protocol changes have been reviewed.

## Codex 0.160.1

- 直接比较上游 0.160.0 / 0.160.1 标签中 1,624 个 app-server、app-server-protocol 和 protocol 文件的 Git blob 哈希：相同。上游变更涉及 Windows MCP 子进程环境变量，与 Reader 使用的问答协议无关。
- 用本机 0.160.1 的 `app-server generate-json-schema` 导出稳定协议；Reader 使用的 17 个入口、91 个可达定义与已固定的 0.160.0 协议结构相同。新增 `src-tauri/protocol/codex-0.160.1.schema.json`，保留此前快照。
- 保留现有会话绑定、请求和回答事件处理；继续禁用 experimental API。

The 1,624 upstream app-server/protocol files have identical Git blob hashes across these tags. The upstream patch changes Windows MCP process environment handling. The stable schema exported by installed Codex 0.160.1 matches Reader's pinned 0.160.0 contract across 17 roots and 91 reachable definitions. Existing bindings and event handling remain unchanged; experimental APIs stay disabled.

## pi 1.0.4

- 核对上游 1.0.3–1.0.4 的 28 个提交、133 个变更文件。RPC 命令、事件文档、RPC 实现和会话管理文件未改动。
- pi 的工具过滤及 MCP 生命周期有调整；Reader 在 1.0.4 上额外传入新参数 `--no-mcp`，并继续使用 `--no-tools`、`--no-extensions` 等原有参数。只对 1.0.4 使用新参数，避免旧版本拒绝启动。
- 保留 `pi:<sessionId>` 和 `pi-rpc/1.0.0` 会话绑定；后者表示 Reader 的 RPC 契约，而非安装的 CLI 版本。

The upstream comparison contains 28 commits and 133 changed files, with no changes to RPC commands, events, RPC implementation, or session management. Pi 1.0.4 changes tool filtering and MCP lifecycle handling. Reader adds the new `--no-mcp` flag only for 1.0.4, retaining its existing tool/resource restrictions and session bindings. Older supported versions are not passed this new flag.

## 资料依据 / Sources

- [Codex 版本比较 / Version comparison](https://github.com/openai/codex/compare/rust-v0.160.0...rust-v0.160.1)
- [pi 版本比较 / Version comparison](https://github.com/earendil-works/pi/compare/v1.0.3...v1.0.4)
- [pi 1.0.4 命令行 / Command line](https://github.com/earendil-works/pi/blob/v1.0.4/packages/coding-agent/docs/cli.md)
- [此前 pi 兼容记录 / Previous pi update](PI_COMPATIBILITY.md)

pi 1.0.3 曾将 Azure 提供者从 `azure-openai-responses` 改为 `azure`。尚未完成这一迁移的 Azure 用户，应按 pi 上游说明更新配置并开启新对话；Reader 不自动改写登录配置。

Pi 1.0.3 renamed the Azure provider to `azure`. Azure users who have not migrated must follow the upstream configuration instructions and start a new Reader conversation. Reader does not rewrite login settings.

## 验证范围 / Verification scope

本次核对协议并构建应用，发行包检查覆盖版本、架构、图标、签名、许可资源和附件完整性。此前完整阅读流程和真实问答验收使用 Codex 0.160.0 / pi 1.0.0。**本次没有新增或运行实现测试，也没有发送真实模型问题；Codex 0.160.1 和 pi 1.0.4 的真实问答、停止及会话恢复尚未重新验收。**

This update reviews protocols and builds the app; release inspection covers version, architecture, icon, signature, license resources, and asset integrity. Earlier full reading workflow and live chat acceptance used Codex 0.160.0 / pi 1.0.0. **No implementation tests or real model prompts were run for this update. Live chat, cancellation, and session recovery on Codex 0.160.1 and pi 1.0.4 have not been revalidated.**
