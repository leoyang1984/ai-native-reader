import type { AssistantInput } from './contracts';

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

/** Expose scope on request without making it part of every answer. */
export function materialDetails(input: AssistantInput): string[] {
  const books = input.sources.filter(source => source.kind === 'book');
  const lines = [books.length
    ? `书内原文：${books.length} 段有限摘录${books.some(source => source.truncated) ? '（部分已截取）' : ''}，并非整章全文。`
    : '本次未提供书内原文。'];
  const supplements = [
    ['note', '人工笔记'], ['idea', '已确认想法'], ['vault', 'Vault 文档'],
  ].flatMap(([kind, label]) => {
    const count = input.sources.filter(source => source.kind === kind).length;
    return count ? [`${label} ${count} 项`] : [];
  });
  if (supplements.length) lines.push(`使用的补充资料：${supplements.join('、')}。`);
  if (input.retrieval) {
    const retrieval = input.retrieval;
    lines.push(`补充资料检索：匹配 ${retrieval.matched} 项，使用 ${retrieval.sent} 项。`);
    if (!retrieval.sent) lines.push('本次未使用人工笔记、已确认想法或 Vault 摘录。');
    if (retrieval.partial) lines.push('补充资料检索范围尚不完整，未命中不代表不存在；这不表示书内原文缺失。');
    if (retrieval.scope.includes('Vault 未连接')) lines.push('Vault 未连接或不可用。');
  }
  if (input.truncated) lines.push('部分资料经过截取或数量限制。');
  return lines;
}
