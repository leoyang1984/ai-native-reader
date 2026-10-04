# AI Native Reader · 伴读

[English](README.en.md)

一个安静的本地 EPUB 阅读器。右侧助手让你围绕原文持续讨论，把读书时的疑问与思考留在书旁。

## 已有功能

- 导入 EPUB、书架、目录、阅读位置恢复。
- 单栏／双栏阅读，方向键翻章及滚动，划线和人工笔记。
- 连接本机 Codex 或 pi，选中原文提问、连续追问、停止回答和恢复讨论。
- 检索 Reader 人工笔记、已确认想法和已连接 Obsidian Vault 的 Markdown 材料。
- 保存用户原话，编辑并确认 AI 整理结果，导出 Markdown，点击书内引用回跳。
- 可选本地 MCP 接口，供外部工具查询阅读资料及请求原文导航。

## 平台状态

| 方式 | 当前状态 |
| --- | --- |
| macOS 桌面应用 | 已在 Apple Silicon Mac 完成主要阅读流程验收；其他 Mac 环境仍需验证 |
| 浏览器预览 | EPUB、阅读布局及本地笔记；不包含桌面助手、Vault 或 MCP |
| Windows / Linux 桌面 | 待适配，当前代码不能作为可用完整版交付 |

具体阻塞和验收要求见 [平台状态](docs/PLATFORMS.md)。Tauri 支持多平台，不代表本项目已完成所有平台适配。

## 下载预览版

Mac 用户可在 [GitHub Releases](https://github.com/leoyang1984/ai-native-reader/releases) 下载 Apple Silicon 应用，参阅 [安装与 Codex/pi 条件](docs/GETTING_STARTED.md)。

## 本地运行

浏览器预览需要 Node.js 22.12 或更新版本：

```sh
npm ci
npm run dev
```

打开终端显示的本地地址。预览与桌面应用的数据独立。

macOS 桌面还需要 Rust 和 Xcode 开发工具：

```sh
npm ci
npm run desktop
```

生成 macOS 应用：

```sh
npm run desktop:build
```

应用在 `src-tauri/target/release/bundle/macos/AI Native Reader.app`。参阅 [构建说明](docs/BUILDING.md)。自行构建的应用没有开发者签名或公证，打包不等于完成系统兼容性验收。

## 助手与 Obsidian

先安装并登录你自己的 Codex 或 pi，再在 Reader 的连接界面选择程序。历史验收使用 Codex CLI 0.160.0、pi 1.0.0；其他版本需验证协议兼容性。只在 Reader 内对话不需要配置 MCP。

选择 Obsidian Vault 后，助手使用该连接配置检索材料，无需在每次对话中重新提供目录。当前检索有数量、大小与时间限制，不是完整的大型 Vault 索引；未命中不能证明整个 Vault 不含相关材料。

## 资料与隐私

仓库仅包含项目源码和原创样书，不包含用户书籍、数据库、笔记库、登录信息或模型密钥。阅读与笔记主要保存在本地；发送助手问题时，会将问题及选取的上下文交给所连接的模型程序，实际服务商可能处理这些内容。详见 [数据说明](docs/PRIVACY.md)。

需要让外部工具访问 Reader 时，参阅 [MCP 说明](docs/MCP.md)。

## 许可与商业化

项目原创代码采用 [GNU GPLv3](LICENSE)（`GPL-3.0-only`）。允许个人及商业使用、修改和分发；分发受 GPL 覆盖的作品时须遵守提供对应源码、保留许可与通知等要求。没有附加“禁止商业使用”条款。

项目将优先通过开放源码和可靠体验积累用户；未来可以提供付费官方服务、支持或其他商业产品。商业规划不改变已经授予的 GPL 权利，也不限制合规第三方收费分发。详见 [商业规划](docs/COMMERCIAL_PLAN.md)。第三方组件保留各自许可证，见 [第三方说明](docs/THIRD_PARTY.md)。
