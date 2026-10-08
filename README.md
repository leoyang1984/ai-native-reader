# AI Native Reader · 伴读

<img src="src-tauri/icons/reader-v2.png" width="96" height="96" alt="伴读 · AI Native Reader app icon">

[English](README.en.md)

一个安静的本地 EPUB 阅读器。右侧助手让你围绕原文持续讨论，把读书时的疑问与思考留在书旁。

![阅读原文、与右侧助手讨论并查看原文引用](docs/screenshots/reading-assistant.jpg)

*真实 Mac 应用截图，使用项目原创双语样书和已有验收对话。*

## 已有功能

- 导入 EPUB、书架、目录、阅读位置恢复。
- 单栏／双栏阅读，方向键翻章及滚动，划线和人工笔记。
- 连接本机 Codex 或 pi，选中原文提问、连续追问、停止回答和恢复讨论。
- 检索 Reader 人工笔记、已确认想法和已连接 Obsidian Vault 的 Markdown 材料。
- 保存用户原话，编辑并确认 AI 整理结果，导出 Markdown，点击书内引用回跳。
- 可选本地 MCP 接口，供外部工具查询阅读资料及请求原文导航。

## 简单上手

1. **打开一本书**：在书架导入或拖入 EPUB，也可以点击“先用示例试读”。顶栏切换单栏／双栏；← / → 翻章，↑ / ↓ 在当前章节移动。
2. **围绕原文讨论**：先按 [连接说明](docs/GETTING_STARTED.md) 连接 Codex 或 pi。选中正文，点击浮动工具条的“提问”，或展开右侧“助手”输入问题。按 ⌘ / Ctrl + Enter 发送；展开回答的“原文依据／参考依据”，点击“查看原文”回到书中。检索范围与资料限制收在同一折叠区，默认不占用回答正文。
3. **留下自己的思考**：用户消息可“存为笔记”；AI 回答点击“确认想法”，编辑标题和正文后，再“确认并保存想法”。连接 Obsidian Vault 后，可选择导出 Markdown。

<details>
<summary>更多界面：双栏阅读与确认保存</summary>

### 双栏阅读

![收起助手后的双栏阅读与同章页码](docs/screenshots/double-column.jpg)

点击顶栏“单栏／双栏”切换。双栏按左、右顺序阅读，下方页码按钮或 ↑ / ↓ 在当前章节翻页；正文空间不足时会暂用单栏。助手可以收起，也可拖动边界调整宽度。

### 编辑后确认保存

![在助手中编辑 AI 整理结果并选择确认保存](docs/screenshots/confirm-idea.jpg)

整理结果先显示为可编辑草稿，确认后才保存为想法。截图展示此前验收中的草稿与测试 Vault 导出选项；普通阅读不要求连接 Vault。

</details>

## 平台状态

| 方式 | 当前状态 |
| --- | --- |
| macOS 桌面应用 | 已在 Apple Silicon Mac 完成主要阅读流程验收；其他 Mac 环境仍需验证 |
| 浏览器预览 | EPUB、阅读布局及本地笔记；不包含桌面助手、Vault 或 MCP |
| Windows / Linux 桌面 | 待适配，当前代码不能作为可用完整版交付 |

具体阻塞和验收要求见 [平台状态](docs/PLATFORMS.md)。Tauri 支持多平台，不代表本项目已完成所有平台适配。

### Windows / Linux 用户

目前可以按下方 [本地运行](#本地运行) 的步骤使用浏览器预览，体验 EPUB 阅读和浏览器本地笔记；桌面助手、Vault 和 MCP 不包含在预览中。

桌面版还需适配：Windows 的本地通信桥接尚未实现，Linux 的数据目录和通信路径仍需调整，两个平台的安装包目标也未配置。完整桌面编译教程和下载包将在适配并完成实际阅读流程验收后提供。参与移植可先查看 [构建说明](docs/BUILDING.md#windows--linux)。

## 下载预览版

最新版本为 **v0.1.6 预览版**，减少助手反复追加的检索提醒，资料范围默认收进来源折叠区；保留 pi 1.1.0 和 Codex 0.160.1 支持。详见 [助手说明](docs/QUIET_ASSISTANT.md)。Mac 用户可在 [GitHub Releases](https://github.com/leoyang1984/ai-native-reader/releases) 下载 Apple Silicon 应用，参阅 [安装与 Codex/pi 条件](docs/GETTING_STARTED.md)。

## 本地运行

### 浏览器预览（macOS / Windows / Linux）

需要 Git 和 Node.js 22.12 或更新版本。首次获取源码：

```sh
git clone https://github.com/leoyang1984/ai-native-reader.git
cd ai-native-reader
```

在源码目录运行：

```sh
npm ci
npm run dev
```

打开终端显示的本地地址。预览与桌面应用的数据独立。

### macOS 桌面

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

先安装并登录你自己的 Codex 或 pi，再在 Reader 的连接界面选择程序。Reader 接受 Codex CLI 0.159.2 / 0.160.0 / 0.160.1 和 pi 1.0.0–1.0.4 及 1.1.0。历史真实问答验收使用 Codex CLI 0.160.0、pi 1.0.0；新增 CLI 版本已核对协议，实际问答尚未重新验收，详见 [pi 1.1.0 兼容说明](docs/PI_1_1_COMPATIBILITY.md)。配置完成后，日常只需打开伴读；连接时会在后台启动所选 CLI，无需另外保持 Codex 桌面应用、pi 或终端窗口开启。只在 Reader 内对话不需要配置 MCP。

选择 Obsidian Vault 后，助手使用该连接配置检索材料，无需在每次对话中重新提供目录。当前检索有数量、大小与时间限制，不是完整的大型 Vault 索引；未命中不能证明整个 Vault 不含相关材料。

## 资料与隐私

仓库仅包含项目源码和原创样书，不包含用户书籍、数据库、笔记库、登录信息或模型密钥。阅读与笔记主要保存在本地；发送助手问题时，会将问题及选取的上下文交给所连接的模型程序，实际服务商可能处理这些内容。详见 [数据说明](docs/PRIVACY.md)。

需要让外部工具访问 Reader 时，参阅 [MCP 说明](docs/MCP.md)。

## 许可与商业化

项目原创代码采用 [GNU GPLv3](LICENSE)（`GPL-3.0-only`）。允许个人及商业使用、修改和分发；分发受 GPL 覆盖的作品时须遵守提供对应源码、保留许可与通知等要求。没有附加“禁止商业使用”条款。

项目将优先通过开放源码和可靠体验积累用户；未来可以提供付费官方服务、支持或其他商业产品。商业规划不改变已经授予的 GPL 权利，也不限制合规第三方收费分发。详见 [商业规划](docs/COMMERCIAL_PLAN.md)。第三方组件保留各自许可证，见 [第三方说明](docs/THIRD_PARTY.md)。
