# 可选 MCP 连接

只在 Reader 内与 Codex 或 pi 对话，不需要设置 MCP。MCP 用于让外部助手读取 Reader 的笔记、划线、历史及阅读上下文，或请求导航到书内位置。

当前 MCP 实现及生成配置脚本适用于 macOS。先构建并启动 Reader：

```sh
npm ci
npm run desktop:build
npm run mcp:config -- --release
```

脚本输出本机 Codex 可使用的 TOML 配置，自动使用你本地生成的应用路径。将输出加入需要连接的 Codex 客户端 MCP 设置即可。路径因电脑而异，不要将生成配置提交到公开仓库。

配置概念示例（替换为自己的程序绝对路径）：

```toml
[mcp_servers.ainativereader]
command = "<absolute-path-to-reader-executable>"
args = ["--mcp"]
startup_timeout_sec = 10
tool_timeout_sec = 30
enabled = true
```

不需要同时配置 Codex 与 pi。只配置实际从外部访问 Reader 的客户端；pi 的接入方式取决于所用客户端或扩展是否支持 MCP，此仓库没有 pi 的通用 MCP 安装器。

`--mcp` 以标准输入输出提供接口，不要将图形应用路径当作远程服务器地址。打开 Reader 可得到实时上下文及原文导航；应用退出后，部分接口只能返回本地历史，实时位置及导航不可用。

`mcp:check` 是开发者验收脚本，会读取当前 Reader 数据；只有准备好独立测试目录和项目样书时才运行，不要用真实阅读库做公开演示。
