import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const flags = process.argv.slice(2);
if (flags.some((flag) => flag !== '--release')) {
  console.error('用法：npm run mcp:config [-- --release]'); process.exit(1);
}
const profile = flags.includes('--release') ? 'release' : 'debug';
const command = join(root, 'src-tauri', 'target', profile, 'bundle', 'macos', 'AI Native Reader.app', 'Contents', 'MacOS', 'ai-native-reader');
if (!existsSync(command)) {
  console.error(`请先生成 ${profile} Mac 应用包，再获取 MCP 配置。`); process.exit(1);
}
// JSON string escaping is compatible with TOML basic strings; paths are never shell commands.
console.log(`[mcp_servers.ainativereader]\ncommand = ${JSON.stringify(command)}\nargs = ["--mcp"]\nstartup_timeout_sec = 10\ntool_timeout_sec = 30\nenabled = true`);
