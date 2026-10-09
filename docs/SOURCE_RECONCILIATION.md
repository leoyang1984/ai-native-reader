# 源码同步与隐私检查 / Source reconciliation and privacy review

日期 / Date: 2026-10-09

## 结果 / Result

原开发目录中未提交的 CLI 兼容、Codex 程序路径恢复、助手资料说明折叠及新版图标，已经包含在公开仓库 v0.1.6 对应的提交中。本次逐文件核对功能源码和资源，补入两份此前未公开的开发记录：

- [图标 v2 开发与交付记录](APP_ICON_V2.md)
- [pi 连接及方向键开发记录](PI_KEYBOARD_DEVELOPMENT.md)

这两份记录描述各阶段当时的状态，当前版本和兼容范围请以 README 与最新兼容说明为准。

The uncommitted changes in the original development checkout—CLI compatibility, Codex launcher recovery, collapsed assistant material details and the new icon—are already included in the public v0.1.6 source. This reconciliation compares functional source files and assets and adds the two historical development reports linked above. Those reports describe their original stages; use the README and latest compatibility notes for current support.

## 检查范围 / Review scope

检查原开发目录的 22 个待提交文件、公开仓库已跟踪文件，以及本次新增文档。检查覆盖常见凭据格式、硬编码密钥、个人目录路径和邮箱，并人工区分第三方许可证中的作者署名、通用安装路径与 GitHub 构建路径。未发现待提交内容中含有真实 API 密钥、登录令牌或个人目录地址。此检查不等于对所有潜在隐私形式的绝对保证。

The review covers 22 pending development files, tracked public files and the added documentation. It checks common credential formats, literal secrets, personal filesystem paths and email addresses, with manual review of third-party license attribution, generic installation paths and CI paths. No real API keys, login tokens or personal directory addresses were found in the pending content. This is a scoped review, not a guarantee against every possible form of private information.

原开发仓库既有验收记录包含本机绝对路径，其私人历史没有合入公开仓库。公开合并以检查后的文件为单位，保留公开仓库现有许可证、构建配置及提交历史。

Existing acceptance records in the development repository contain machine-specific absolute paths. That private history is not merged into the public repository. Reviewed files are integrated while preserving public licensing, build configuration and commit history.

本次提交身份使用 GitHub 隐私邮箱。部分既有公开提交的身份元数据包含个人邮箱，本次没有改写已有历史。

New commits use a GitHub noreply email. Some existing public commits contain a personal email in their identity metadata; this update does not rewrite that history.

本次没有修改运行逻辑、运行功能测试、重新打包应用、创建标签或更新 Release。

This update changes no runtime behavior and runs no implementation tests. It does not rebuild the app, create a tag or update a Release.
