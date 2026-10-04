export const PANEL_MIN = 280;
export const PANEL_MAX = 480;
export const PANEL_DEFAULT = 340;
export interface PanelPreferences { open: boolean; width: number }
export function panelWidth(value: number) {
  return Number.isFinite(value) ? Math.round(Math.min(PANEL_MAX, Math.max(PANEL_MIN, value))) : PANEL_DEFAULT;
}
export function panelPreferences(raw: string | null): PanelPreferences {
  try {
    const value = JSON.parse(raw ?? 'null');
    return { open: typeof value?.open === 'boolean' ? value.open : true, width: panelWidth(typeof value?.width === 'number' ? value.width : PANEL_DEFAULT) };
  } catch { return { open: true, width: PANEL_DEFAULT }; }
}
// Reading area includes 48 px padding around roughly 480 px of text.
export function overlayPanel(available: number, width: number) { return available < width + 528; }
export function conversationTitle(title: string | null) {
  if (!title) return '阅读讨论';
  const chars = Array.from(title);
  return `读《${chars.slice(0, 156).join('')}${chars.length > 156 ? '…' : ''}》`;
}
export function messageLabel(status: string) {
  return ({ pending: '正在准备…', streaming: '正在回答…', cancelling: '正在停止…', cancelled: '已停止 · 回复未完成', interrupted: '应用已中断 · 回复未完成', failed: '回复未完成' } as Record<string, string>)[status] ?? '';
}
export interface PendingSelection {
  text: string;
  cfi: string;
  href: string;
  title?: string;
  bookId?: string;
  noteId?: string;
}
/** Serialize draft writes. Failed values stay dirty and can be retried on blur/exit. */
export class DraftWriter {
  private revision = 0;
  private saved = 0;
  private value = '';
  private queue: Promise<void> = Promise.resolve();
  constructor(private write: (value: string) => Promise<void>) {}
  update(value: string) { this.value = value; this.revision += 1; }
  flush() {
    const task = this.queue.then(async () => {
      while (this.saved !== this.revision) {
        const revision = this.revision, value = this.value;
        await this.write(value);
        this.saved = revision;
      }
    });
    this.queue = task.catch(() => undefined);
    return task;
  }
}

export function continuationDraft(messages: {role: string; body: string; status: string}[], draft: string) {
  const history = messages.filter(m => m.status === 'completed' && m.body).slice(-4)
    .map(m => `${m.role === 'user' ? '读者' : '助手'}：${Array.from(m.body).slice(0, 280).join('')}`).join('\n');
  const question = Array.from(draft).slice(0,2000).join('');
  const room = 2000 - Array.from(question).length - 65;
  if (room <= 0) return question;
  return `继续此前的阅读讨论（以下是历史摘要，不能当作当前检索结果）：\n${Array.from(history).slice(0,room).join('')}\n\n我的新问题：${question}`;
}
