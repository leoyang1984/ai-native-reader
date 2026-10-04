import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { desktop } from './repository';

export type AgentProvider = 'codex' | 'pi';
export interface CodexStatus {
  provider: AgentProvider;
  phase: 'disconnected' | 'connecting' | 'ready' | 'running' | 'cancelling' | 'error';
  executable: string;
  version: string | null;
  account: string | null;
  threadId: string | null;
  message: string;
  generation: number;
}
export interface CodexTurn {
  requestId: string;
  threadId: string;
  turnId: string | null;
  status: 'streaming' | 'cancelling' | 'completed' | 'cancelled' | 'failed';
  text: string;
  message: string;
  generation: number;
}
export interface CodexRequest {
  requestId: string;
  result: Promise<CodexTurn>;
  cancel: () => Promise<void>;
}
/** Transport only: prompts and source contracts belong to the Ask/Reflect flows. */
export class CodexClient {
  status: CodexStatus = { provider: 'codex', phase: 'disconnected', executable: '', version: null, account: null, threadId: null,
    message: desktop ? '尚未连接' : '请在桌面版连接助手', generation: 0 };
  private unlisten: UnlistenFn[] = [];
  private jobs = new Map<string, { resolve: (turn: CodexTurn) => void; reject: (error: Error) => void;
    progress?: (turn: CodexTurn) => void; generation: number; cancelled: boolean }>();
  private statusRevision = 0;

  constructor(private onStatus: (status: CodexStatus) => void) {}
  private acceptStatus(status: CodexStatus) {
    if (status.generation < this.status.generation) return;
    this.status = status; this.statusRevision += 1; this.onStatus(status);
  }
  async initialize() {
    if (!desktop) { this.onStatus(this.status); return; }
    try {
      this.unlisten.push(await listen<CodexStatus>('codex-status', ({ payload }) => this.acceptStatus(payload)));
      this.unlisten.push(await listen<CodexTurn>('codex-turn', ({ payload }) => {
        const job = this.jobs.get(payload.requestId);
        if (!job || payload.generation !== job.generation) return;
        if (payload.status === 'streaming' || payload.status === 'cancelling') {
          if (!job.cancelled) job.progress?.(payload);
          return;
        }
        this.jobs.delete(payload.requestId);
        if (payload.status === 'completed' && !job.cancelled) job.resolve(payload);
        else job.reject(new Error(job.cancelled ? '提问已取消' : payload.message));
      }));
      const revision = this.statusRevision;
      const status = await invoke<CodexStatus>('codex_status');
      if (revision === this.statusRevision) this.acceptStatus(status);
    } catch (error) { this.dispose(); throw error; }
  }
  get label() { return this.status.provider === 'pi' ? 'pi' : 'Codex'; }
  async select(provider: AgentProvider) {
    if (!desktop) throw new Error('请在桌面版选择助手。');
    this.acceptStatus(await invoke<CodexStatus>('agent_select', { provider }));
  }
  async connect(executable = this.status.executable) {
    if (!desktop) throw new Error('请在桌面版连接助手。');
    const status = await invoke<CodexStatus>('codex_connect', { executable });
    this.acceptStatus(status);
  }
  async disconnect() {
    if (desktop) await invoke('codex_disconnect');
  }
  start(text: string, options: { fresh?: boolean; outputSchema?: Record<string, unknown>; onProgress?: (turn: CodexTurn) => void } = {}): CodexRequest {
    if (!desktop || this.status.phase !== 'ready' || this.jobs.size) throw new Error('请先连接助手，或等待当前提问结束。');
    const requestId = crypto.randomUUID();
    let resolve!: (turn: CodexTurn) => void, reject!: (error: Error) => void;
    const result = new Promise<CodexTurn>((yes, no) => { resolve = yes; reject = no; });
    const job = { resolve, reject, progress: options.onProgress, generation: this.status.generation, cancelled: false };
    this.jobs.set(requestId, job);
    void invoke('codex_start', { requestId, text, fresh: options.fresh ?? true, generation: job.generation, outputSchema: options.outputSchema ?? null }).catch((error: unknown) => {
      if (this.jobs.get(requestId) !== job) return;
      this.jobs.delete(requestId); reject(new Error(String(error)));
    });
    return { requestId, result, cancel: async () => {
      if (this.jobs.get(requestId) !== job || job.cancelled) return;
      job.cancelled = true; // Revoke presentation immediately; late completion cannot resolve.
      await invoke('codex_cancel', { requestId });
    } };
  }
  dispose() {
    for (const unlisten of this.unlisten.splice(0)) unlisten();
    for (const job of this.jobs.values()) job.reject(new Error('连接已关闭。'));
    this.jobs.clear();
  }
}
