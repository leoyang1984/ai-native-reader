# 构建与开发

## 浏览器预览（各桌面系统）

安装 Git 和 Node.js 22.12+（包含 npm），获取源码并进入仓库目录：

```sh
git clone https://github.com/leoyang1984/ai-native-reader.git
cd ai-native-reader
```

在源码目录运行：

```sh
npm ci
npm run dev
```

地址为 `http://127.0.0.1:4173`。浏览器数据在当前浏览器的 IndexedDB 中，与桌面 SQLite 数据库独立；清理网站数据会删除预览数据。

```sh
npm run build
npm run preview
```

`dist/` 是浏览器构建输出。直接双击 HTML 不等同于启动预览。

## macOS 桌面

需要 Node.js 22.12+、Rust stable/Cargo、Xcode Command Line Tools。

```sh
xcode-select --install
npm ci
npm run desktop
```

首次构建会下载 npm 与 Cargo 依赖。运行助手还需自行安装、登录兼容的 Codex 或 pi；应用包不包含这些程序或账户凭证。

发布模式构建：

```sh
npm run desktop:build
```

输出：`src-tauri/target/release/bundle/macos/AI Native Reader.app`。

构建用于独立测试数据的开发包：

```sh
npm run desktop:build -- --debug
```

开发包输出在 `src-tauri/target/debug/bundle/macos/`。调试模式可通过 `AINATIVE_READER_DATA_DIR` 指定独立测试目录；请使用新建空目录，不要填写真实 Vault 或原有应用数据目录。发布模式不使用这一测试覆盖配置。原创样书在 `public/samples/reader-lab.epub`。

上述本地构建命令未配置 Apple Developer ID 签名或公证。当前发布工作流会生成完整的 ad-hoc 应用签名；这种签名没有 Apple 开发者身份认证，也不能替代公证。对外分发经过 Apple 认证的版本需另行配置开发者证书及公证流程，仓库不保存证书或口令。

## Windows / Linux

### 使用浏览器预览

Windows/Linux 用户可按本文开头的 [浏览器预览](#浏览器预览各桌面系统) 步骤运行和构建阅读预览。此方式包含 EPUB 阅读与浏览器本地笔记，不提供桌面助手、Vault 或 MCP。

### 参与桌面移植（尚未完成验收）

当前桌面版存在运行阻塞：Windows 本地通信桥接未实现，Linux 的数据与通信路径需要调整。详情见 [平台状态](PLATFORMS.md)。Windows/Linux 的完整桌面编译教程、安装包与已验证环境将在适配及实际阅读流程验收后提供。

若参与移植，先安装 [Tauri 官方平台依赖](https://v2.tauri.app/start/prerequisites/)：Windows 需要 MSVC 构建工具与 WebView2，Linux 需要相应发行版的 WebKitGTK 等开发包。之后可用 `npm ci`、`npm run build` 和 `cargo check --locked --manifest-path src-tauri/Cargo.toml` 检查源码。当前 `desktop:build` 的 `app` 目标属于 macOS；Windows/Linux 的安装包目标还未配置。

## 自动流程

- `CI`：检查前端类型与构建，并在 macOS 编译 Rust。不会使用模型账户或真实书籍。
- `Build macOS (unsigned)`：仓库所有者手动运行，构建 Apple Silicon `.app`、生成并验证完整 ad-hoc 签名，再压缩为 ZIP 构建产物。工作流名称沿用原名；应用没有 Apple Developer ID 签名或公证。不会自动发布 Release。

2026-10-04，v0.1.0 对应提交 `14866ab749216a1e17cfb146622781b765cd207a` 的 [CI](https://github.com/leoyang1984/ai-native-reader/actions/runs/37197117278) 与 [macOS 应用构建](https://github.com/leoyang1984/ai-native-reader/actions/runs/37197149969) 均已成功运行。CI 包括 Ubuntu 上的前端构建和 macOS 上的 Rust 编译检查，没有执行 Windows/Linux 桌面验收。

[v0.1.0 预览版](https://github.com/leoyang1984/ai-native-reader/releases/tag/v0.1.0) 已发布。下载包通过版本、arm64 架构、许可资源、系统动态库、应用签名完整性、原生 MCP 初始化及公开下载校验；此次未重新执行完整图形界面与真实模型问答验收。完整阅读主线依据相同功能源码此前的 M5-08 验收。每个新平台仍需完成系统、阅读、助手、Vault、MCP 的实际验收。

## 开发者检查命令

```sh
npm run check
npm test
cargo test --locked --manifest-path src-tauri/Cargo.toml
```

真实模型及 MCP 检查应使用独立目录、原创样书和测试 Vault。不要在 CI 上传用户数据库、日志、聊天记录或登录配置。
