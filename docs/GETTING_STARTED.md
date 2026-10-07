# macOS 预览版：安装与助手连接

## 下载安装

本次发布：AI Native Reader 0.1.3 预览版，Apple Silicon（M1、M2、M3、M4 及之后的同架构芯片）。Intel Mac 不能运行此 arm64 安装包。Windows/Linux 完整版仍待适配。

1. 在 GitHub Releases 下载 `AI-Native-Reader-0.1.3-macOS-arm64.zip`。
2. 解压，将 `AI Native Reader.app` 拖入“应用程序”。
3. 打开应用，使用内置 Reader Lab 原创样书，或导入自己的无 DRM、流式排版 EPUB（最大 100 MB）。

普通阅读、划线及本地笔记不需要安装 Node.js、Rust、Codex、pi 或 Obsidian。

这是预览版，尚无 Apple 开发者签名和公证。首次打开若被系统阻止，在确认下载来源和文件未被改动后，按 [Apple 官方说明](https://support.apple.com/en-us/102445) 在“系统设置 → 隐私与安全性”选择“仍要打开”。受组织管理的 Mac 可能不允许这一操作。

## AI 助手：Codex 或 pi 任选其一

Reader 不内置模型程序、账号、订阅、API key 或模型额度。请先在终端确认所选程序能够正常问答，再连接 Reader。只有发起问答时才会把问题及有限资料交给所连接的模型程序。

| 程序 | 当前 Reader 接受的版本 | 已完成完整真实问答验收 |
| --- | --- | --- |
| Codex CLI | 0.159.2、0.160.0、0.160.1 | 0.160.0；0.160.1 完成协议核对，实际问答尚未重新验收 |
| pi | 1.0.0、1.0.1、1.0.2、1.0.3、1.0.4 | 1.0.0；新增版本完成协议核对，实际问答尚未重新验收 |

版本是明确的兼容范围，不代表更新版本也能连接。Reader 当前会拒绝其他版本。安装的是终端 CLI；仅安装 Codex 桌面应用不等于终端里已有 `codex` 程序。

### 方案 A：Codex CLI 0.160.1（也支持 0.159.2 / 0.160.0）

使用 npm 安装时需要 Node.js（该 CLI 包声明最低 Node.js 16；建议采用 Node.js 22.19.0 或更新版本，方便兼容 pi）：

```sh
npm install -g @openai/codex@0.160.1
codex --version
codex login
```

版本应显示 `codex-cli 0.160.1`。完成登录，并在终端确认 Codex 能正常响应。账户可用范围及模型费用遵循 OpenAI 当前规则，参阅 [官方认证说明](https://learn.chatgpt.com/docs/auth)。

### 方案 B：pi 1.0.4（也支持 1.0.0–1.0.3）

需要 **Node.js 22.19.0 或更新版本**。本次验收使用的是 `@earendil-works/pi-coding-agent`，不要将其他同名包当作这个兼容版本。

```sh
npm install -g --ignore-scripts @earendil-works/pi-coding-agent@1.0.4
pi --version
pi
```

上述安装命令的版本应显示 `1.0.4`。进入 pi 后按其支持的方式登录（例如 `/login`）或配置模型服务，确认终端中可以正常问答。已有 pi 配置可以继续使用，Reader 不要求重新创建账号。模型服务可能收费，由用户的服务配置决定。

官方项目：[earendil-works/pi](https://github.com/earendil-works/pi)。Node.js 要求取自 [1.0.4 软件包发布元数据](https://registry.npmjs.org/@earendil-works%2fpi-coding-agent/1.0.4)。

已有 pi 1.0.0–1.0.4 可直接继续使用。升级 Reader 后在「助手连接」中重新连接即可，无需重新登录。Azure 提供者在 pi 1.0.3 中改名，需要按上游说明更新 pi 配置并开启新对话；详见 [兼容说明](CLI_COMPATIBILITY.md)。

### 在 Reader 中连接

1. 打开“助手连接”，选择 Codex 或 pi。
2. 选择已安装的程序并连接；如果未自动找到，可在终端用 `command -v codex` 或 `command -v pi` 查看路径，再在应用内选择对应程序。
3. 展开右侧助手，输入问题，或选中书内原文后提问。

不用同时安装两种助手。Reader 内对话不需要配置 MCP；外部工具访问 Reader 才需要可选 MCP 配置。Obsidian Vault 也是可选连接。

## 当前范围与限制

- Mac 主线已在 Apple Silicon、macOS 26.6.2 上验证。其他 macOS 版本尚未覆盖全部实际操作；安装包声明最低 macOS 11.0；这一最低声明不代表所有旧系统已完成实际验收。
- 支持 EPUB；PDF、DRM 书籍、固定版式 EPUB、移动端及跨设备同步尚未实现。
- Vault 检索受时间、数量、大小和目录深度限制，大库可能只覆盖部分资料，不是完整语义索引。
- 网络／账户变化的所有组合、旧 Reflect 的完整桌面分支、超长聊天分页和 Obsidian 外部链接仍有未验证范围。
- 保存与导出前可编辑、确认；Vault 外部改动不会自动反向合并到 Reader。

反馈请使用原创样书或可公开测试材料，不要在 Issue 上传私人书籍、笔记、对话、登录文件或密钥。

## 源码与许可证

项目原创代码采用 GPLv3（仅第 3 版）。对应版本的项目源码、固定 Rust 依赖源码和 npm 运行依赖随 `AI-Native-Reader-0.1.3-source.tar.gz` 提供；源码不要求购买。第三方许可及通知在应用 `Contents/Resources` 和源码的 `release-notices/` 中提供。

`SHA256SUMS.txt` 用于核对下载文件完整性。预览版允许合规商业使用与分发。

配置完成后，日常只需打开 Reader。点击连接时，Reader 会在后台启动所选的 Codex CLI 或 pi，无需保持 Codex 桌面应用或终端问答窗口开启。AI 提问仍需要所选模型服务的可用账号和网络。
