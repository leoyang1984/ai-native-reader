# pi 兼容更新 / Pi compatibility update

日期 / Date: 2026-10-05

后续更新 / Follow-up (2026-10-07): Reader v0.1.3 支持 Codex 0.160.1 / pi 1.0.4，参阅 [最新 CLI 兼容说明 / Current CLI compatibility](CLI_COMPATIBILITY.md)。下文保留 v0.1.2 当时的记录 / The record below describes v0.1.2.

## 用户说明

- Reader 支持 pi **1.0.0、1.0.1、1.0.2、1.0.3**。
- 安装更新后的 Reader，重新打开「助手连接」，选择 pi，再点击「重新连接」。无需重新配置登录或迁移 Reader 数据。
- 继续使用 pi 中配置的模型；无须在前台打开 pi。
- 保留已有 Reader 会话的 `pi:<sessionId>` 和 `pi-rpc/1.0.0` 绑定；后者表示 Reader 使用的协议契约，并非当前 pi CLI 版本。
- 其他版本仍会明确提示不兼容，待核对上游变更后再加入支持。

## User instructions

- Reader supports pi **1.0.0, 1.0.1, 1.0.2, and 1.0.3**.
- Install the updated Reader, open the assistant connection dialog, select pi, and reconnect. No login reconfiguration or Reader data migration is required.
- Reader uses the model configured in pi. You do not need a foreground pi window.
- Existing `pi:<sessionId>` and `pi-rpc/1.0.0` bindings remain unchanged. The latter identifies Reader's RPC contract rather than the installed pi CLI version.
- Other versions remain unsupported until their upstream changes have been reviewed.

## 技术依据 / Technical review

核对本机安装包的 1.0.3 文档，以及上游 `v1.0.0...v1.0.3` 共 58 个提交、227 个变更文件。RPC 实现、类型、RPC 文档、JSON 事件文档、会话管理和 agent 核心未发生变更；CLI 参数修改仅涉及 `--models` 的空项过滤，Reader 不使用该参数。Reader 使用的 `get_state`、`new_session`、`switch_session`、`prompt`、`abort`、`text_delta`、`message_end`、`agent_settled` 契约保持一致。

Reviewed the installed 1.0.3 documentation and the upstream comparison of 58 commits and 227 changed files. RPC implementation, types, RPC/JSON event documentation, session management, and agent core are unchanged. The CLI argument change filters empty `--models` entries; Reader does not use that option. Reader's command and event contracts remain unchanged.

- [版本差异 / Version comparison](https://github.com/earendil-works/pi/compare/v1.0.0...v1.0.3)
- [1.0.3 RPC 文档 / RPC documentation](https://github.com/earendil-works/pi/blob/v1.0.3/packages/coding-agent/docs/rpc.md)
- [1.0.3 更新记录 / Changelog](https://github.com/earendil-works/pi/blob/v1.0.3/packages/coding-agent/CHANGELOG.md)

上游 1.0.3 将 Azure 提供者名称从 `azure-openai-responses` 改为 `azure`。使用该提供者的用户需要按上游说明在 pi 中更新配置，并在 Reader 中开启新对话；Reader 不自动改写 pi 的登录配置。其他提供者的模型绑定规则保持不变。

Pi 1.0.3 renames the Azure provider from `azure-openai-responses` to `azure`. Users of that provider must update their pi configuration as instructed upstream and start a new Reader conversation. Reader does not rewrite pi login settings.

## 验证范围 / Verification scope

本次核对了协议与源代码差异，并构建发行包。真实问答依据此前 pi 1.0.0 的阅读场景验收；1.0.1–1.0.3 的实际问答、续谈和停止尚未重新验收。本次没有新增或运行实现测试，也没有发送真实模型问题。

This update reviews upstream protocol and source changes and builds the release package. Live chat evidence comes from the earlier pi 1.0.0 reading workflow acceptance. Live chat, continuation, and cancellation on 1.0.1–1.0.3 have not been revalidated. No implementation tests were added or run, and no real model prompts were sent for this update.
