# Codex 升级后的连接修复 / Codex launcher recovery

Reader v0.1.4，2026-10-07。

## 原因与处理

Reader 曾保存符号链接解析后的版本目录。Homebrew 升级后，旧的 `Caskroom/codex/<version>/bin/codex` 被删除，重新连接在检查版本之前就失败。这是 v0.1.3 兼容更新遗漏的路径迁移问题。

- 启动 Reader 时，已保存的程序不存在则重新发现当前 Codex。
- Reader 打开期间程序升级，默认重新连接也能恢复失效路径。
- 连接成功后保存稳定的 `bin/codex` 入口；校验版本和启动进程仍使用同一次解析得到的实际程序。
- 稳定入口必须与选中程序指向同一个文件；有效的自定义安装不会被切换到其他程序。
- 加入用户 npm 全局目录的程序发现。pi 的连接代码不变。

重新打开 Reader，在「助手连接」选择 Codex，点击「连接」。无需手动修改连接配置或重新登录。Reader 书籍、笔记和持久化对话不做迁移。

## English

Reader previously saved the resolved, version-specific executable path. A Homebrew upgrade removed the old installation, so reconnect failed before version checking. Version 0.1.3 added CLI compatibility but missed this path migration.

Reader now rediscovers Codex when the saved executable is missing, including upgrades while Reader stays open. It saves a stable `bin/codex` launcher and uses its resolved binary for both version checking and process startup. A launcher is selected only when it resolves to the chosen binary, preserving custom installations. Discovery also includes the user's npm global directory. Pi connection code is unchanged.

Reopen Reader, select Codex, and connect. No manual configuration edits, login reset, or reading data migration are required.

## 核对范围 / Review scope

确认现有保存路径已失效且当前稳定入口存在；完成源码审阅和应用构建。未新增或运行实现测试，未发送模型问题；实际连接尚需使用更新后的应用确认。

Confirmed the saved executable is missing and the current stable launcher exists. Source review and application builds were completed. No implementation tests or model prompts were run; live connection has not yet been confirmed with the updated app.
