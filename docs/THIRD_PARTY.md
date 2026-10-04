# 第三方组件

项目的许可不能替代第三方组件自身的许可，也不能对其原有权利追加限制。

- npm 直接依赖及固定解析版本见 `package.json` 和 `package-lock.json`。
- Rust 直接依赖及固定解析版本见 `src-tauri/Cargo.toml` 和 `src-tauri/Cargo.lock`。
- Codex app-server 协议子集位于 `src-tauri/protocol/`，由对应版本工具生成。上游项目：[openai/codex](https://github.com/openai/codex)，采用 Apache-2.0。这些上游生成资料保留原许可；许可证与通知分别见 `LICENSES/Apache-2.0.txt` 和 `LICENSES/Codex-NOTICE.txt`。Reader 项目的 GPL 许可不改变上游原有权利。
- Reader Lab 样书由项目脚本 `scripts/create-fixture.mjs` 生成，不包含用户导入的商业书籍。

源码仓库不打包 npm/Cargo 的第三方源码；自行安装与构建时应保留各组件要求的许可证与通知。对外提供二进制版本之前，还需汇总实际构建依赖的许可证、署名及再分发义务。本准备阶段尚未完成可分发二进制的完整第三方通知清单。
