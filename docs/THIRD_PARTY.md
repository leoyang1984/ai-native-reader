# 第三方组件

项目的许可不能替代第三方组件自身的许可，也不能对其原有权利追加限制。

- npm 直接依赖及固定解析版本见 `package.json` 和 `package-lock.json`。
- Rust 直接依赖及固定解析版本见 `src-tauri/Cargo.toml` 和 `src-tauri/Cargo.lock`。
- Codex app-server 协议子集位于 `src-tauri/protocol/`，由对应版本工具生成。上游项目：[openai/codex](https://github.com/openai/codex)，采用 Apache-2.0。这些上游生成资料保留原许可；许可证与通知分别见 `LICENSES/Apache-2.0.txt` 和 `LICENSES/Codex-NOTICE.txt`。Reader 项目的 GPL 许可不改变上游原有权利。
- Reader Lab 样书由项目脚本 `scripts/create-fixture.mjs` 生成，不包含用户导入的商业书籍。

0.1.5 的第三方许可及通知已汇总在 `release-notices/THIRD-PARTY-NOTICES.txt`；依赖清单见 `release-notices/DEPENDENCIES.json`。通知保留固定 Rust 依赖（包含其他平台和构建工具）以及安装的 npm 运行依赖的许可文本及上游署名；上游软件包只声明 SPDX 许可而未包含单独文件时，附标准许可文本或共享工作区／上游通知，原始头部仍保存在对应源码中。

应用包同时携带项目许可、Codex 通知和第三方通知。对应项目、固定 Rust 依赖及 npm 运行依赖源码作为 Release 附件提供。再分发者仍须自行履行适用许可义务，不能只保留依赖名称列表。
