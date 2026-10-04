import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

/** Small external stdio client for reproducible Reader integration checks. */
export class ReaderMcpClient {
  constructor(command, { env = {}, protocolVersion = '2025-06-18' } = {}) {
    this.sequence = 0;
    this.pending = new Map();
    this.protocolVersion = protocolVersion;
    this.child = spawn(command, ['--mcp'], { env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
    this.stderr = '';
    this.child.stderr.on('data', (chunk) => { this.stderr = (this.stderr + chunk).slice(-4000); });
    this.lines = createInterface({ input: this.child.stdout });
    this.lines.on('line', (line) => {
      try {
        const message = JSON.parse(line);
        if (message.jsonrpc !== '2.0') throw new Error('Invalid JSON-RPC output');
        const pending = this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id); clearTimeout(pending.timer);
        if (message.error) pending.reject(new Error(message.error.message));
        else pending.resolve(message.result);
      } catch (error) { this.fail(error); }
    });
    this.child.on('error', (error) => this.fail(error));
    this.child.stdin.on('error', (error) => this.fail(error));
    this.child.on('exit', (code) => this.fail(new Error(`Reader MCP exited (${code}): ${this.stderr}`)));
  }
  fail(error) {
    this.failure = error;
    for (const { reject, timer } of this.pending.values()) { clearTimeout(timer); reject(error); }
    this.pending.clear();
  }
  send(message) { this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`); }
  request(method, params = {}) {
    if (this.failure) return Promise.reject(this.failure);
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`MCP timeout: ${method}`)); }, 30_000);
      this.pending.set(id, { resolve, reject, timer }); this.send({ id, method, params });
    });
  }
  async initialize() {
    const result = await this.request('initialize', { protocolVersion: this.protocolVersion, capabilities: {}, clientInfo: { name: 'reader-integration-check', version: '1' } });
    this.send({ method: 'notifications/initialized' }); return result;
  }
  async call(name, args = {}) {
    const result = await this.request('tools/call', { name, arguments: args });
    if (result.isError) throw new Error(result.content?.[0]?.text ?? 'Reader tool failed');
    return result.structuredContent ?? JSON.parse(result.content[0].text);
  }
  close() { this.child.stdin.end(); this.lines.close(); this.child.kill(); this.fail(new Error('MCP client closed')); }
}
