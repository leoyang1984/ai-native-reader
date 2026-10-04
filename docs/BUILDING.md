# 构建与开发

## 浏览器预览（各桌面系统）

安装 Git 和 Node.js 22.12+（包含 npm），获取源码并进入仓库目录：

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

以上应用包未签名、公证。对外分发签名版本需另行配置 Apple 开发者证书及公证流程，仓库不保存证书或口令。

## Windows / Linux

当前只提供浏览器预览的完整操作方法。桌面版仍有明确运行阻塞，见 [平台状态](PLATFORMS.md)，请不要把编译成功当作可用完整版。

若参与移植，先安装 [Tauri 官方平台依赖](https://v2.tauri.app/start/prerequisites/)：Windows 需要 MSVC 构建工具与 WebView2，Linux 需要相应发行版的 WebKitGTK 等开发包。之后可用 `npm ci`、`npm run build` 和 `cargo check --locked --manifest-path src-tauri/Cargo.toml` 检查源码。当前 `desktop:build` 的 `app` 目标属于 macOS；Windows/Linux 的安装包目标还未配置。

## 自动流程

- `CI`：检查前端类型与构建，并在 macOS 编译 Rust。不会使用模型账户或真实书籍。
- `Build macOS (unsigned)`：仓库所有者手动运行，生成未签名 `.app` 压缩包作为 Actions 构建产物，不自动发布 Release。

工作流尚需在远端实际运行后确认。下载构建产物后仍需完成系统、阅读、助手、Vault、MCP 的实际验收。

## 开发者检查命令

```sh
npm run check
npm test
cargo test --locked --manifest-path src-tauri/Cargo.toml
```

真实模型及 MCP 检查应使用独立目录、原创样书和测试 Vault。不要在 CI 上传用户数据库、日志、聊天记录或登录配置。
