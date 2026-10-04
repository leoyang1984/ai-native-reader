import { AssistantClient, type AssistantRequest } from './client';
import type { AssistantMessage, Conversation, ConversationPage, ActionDraft, ActionReceipt, AssistantSource } from './contracts';
import type { CodexClient } from '../codex-client';
import { desktop } from '../repository';
import { DraftWriter, conversationTitle, messageLabel, overlayPanel, panelPreferences, panelWidth, PANEL_DEFAULT, PANEL_MIN, PANEL_MAX, continuationDraft, type PendingSelection } from './presentation';
import './panel.css';

const PREFERENCES = 'reader.assistant.panel.v1';
const PREVIEW_DRAFT = 'reader.assistant.preview-draft.v1';
function read(key: string) { try { return localStorage.getItem(key); } catch { return null; } }
function element<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text = '') {
  const node = document.createElement(tag); node.className = className; node.textContent = text; return node;
}
function escapeHtml(s: string) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export class AssistantPanel {
  private client: AssistantClient;
  private preferences = panelPreferences(read(PREFERENCES));
  private conversation: Conversation | null = null;
  private creating: Promise<Conversation> | null = null;
  private writer: DraftWriter;
  private draftTimer: ReturnType<typeof setTimeout> | undefined;
  private request: AssistantRequest | null = null;
  private submitting: Promise<void> | null = null;
  private switching: Promise<void> | null = null;
  private loading = true;
  private stopping = false;
  private messages: AssistantMessage[] = [];
  private more = false;
  private live: HTMLElement | null = null;
  private layoutObserver: ResizeObserver;
  private aside: HTMLElement;
  private log: HTMLElement;
  private input: HTMLTextAreaElement;
  private status: HTMLButtonElement;
  private send: HTMLButtonElement;
  private stop: HTMLButtonElement;
  private fresh: HTMLButtonElement;
  private historyBtn: HTMLButtonElement;
  private historyList: HTMLElement;
  private notice: HTMLElement;
  private title: HTMLElement;
  private earlier: HTMLButtonElement;
  private separator: HTMLElement;
  private shade: HTMLButtonElement;
  private attachmentBar: HTMLElement;
  private pendingSelection: PendingSelection | null = null;
  private savedActions = new Map<string, string>();
  private receipts = new Map<string, ActionReceipt>();
  private actionDrafts = new Map<string, ActionDraft>();
  private actionWriter: DraftWriter;
  private attachmentTask: Promise<void> = Promise.resolve();
  private recovery: HTMLButtonElement;

  constructor(private workspace: HTMLElement, private toggle: HTMLButtonElement, private codex: CodexClient,
    private book: () => { id: string; title: string } | null, private connect: (focus: HTMLElement) => void,
    private beforeSend: () => Promise<void>,
    private onNavigateCitation?: (source: AssistantSource) => void,
    private onOpenVaultSource?: (source: {conversationId: string; messageId: string; sourceId: string}) => void,
    private hasVault?: () => boolean,
    private onIdeaSaved?: () => void, private onNoteSaved?: () => void) {
    this.client = new AssistantClient(codex);
    this.aside = element('aside', 'assistant-panel'); this.aside.id = 'assistant-panel';
    this.aside.setAttribute('aria-label', '阅读助手');
    this.aside.innerHTML = `<div class="assistant-heading"><h2>助手</h2><button type="button" class="text-button assistant-collapse" aria-label="收起助手">收起</button></div>
      <div class="assistant-toolbar"><button type="button" class="text-button assistant-connection"></button><div class="assistant-actions"><button type="button" class="text-button assistant-history">历史</button><button type="button" class="text-button assistant-new">新对话</button></div></div>
      <div class="assistant-history-menu" hidden aria-label="历史对话列表"></div>
      <p class="assistant-title"></p><div class="assistant-messages" tabindex="0" aria-label="对话记录"><button type="button" class="text-button assistant-earlier" hidden>查看更早消息</button><div class="assistant-records"></div></div>
      <form class="assistant-composer"><div class="assistant-attachment" hidden><span class="assistant-attachment-text"></span><button type="button" class="text-button assistant-attachment-remove" aria-label="移除引用">×</button></div><label class="assistant-input-label" for="assistant-input">对话</label><textarea id="assistant-input" rows="3" maxlength="2000" placeholder="写下你的问题…" aria-label="给助手的消息"></textarea><p class="assistant-notice" role="status"></p><div class="assistant-send-row"><span>⌘ / Ctrl + Enter 发送</span><button type="button" class="text-button assistant-stop" hidden>停止</button><button type="submit" class="text-button assistant-send">发送</button></div></form>`;
    const get = <T extends HTMLElement>(selector: string) => this.aside.querySelector<T>(selector)!;
    this.log = get('.assistant-messages'); this.input = get('#assistant-input'); this.status = get('.assistant-connection');
    this.send = get('.assistant-send'); this.stop = get('.assistant-stop'); this.fresh = get('.assistant-new');
    this.historyBtn = get('.assistant-history'); this.historyList = get('.assistant-history-menu');
    this.notice = get('.assistant-notice'); this.title = get('.assistant-title'); this.earlier = get('.assistant-earlier');
    this.attachmentBar = get('.assistant-attachment');
    this.recovery = element('button', 'text-button', '带入新对话继续'); this.recovery.type = 'button'; this.recovery.hidden = true;
    get('.assistant-toolbar').append(this.recovery);
    this.recovery.addEventListener('click', () => { if (this.switching) return; this.switching = this.newConversation(true); this.perform(async () => {try {await this.switching;} finally {this.switching=null;} }); });
    this.separator = element('div', 'assistant-separator'); this.separator.tabIndex = 0;
    this.separator.setAttribute('role', 'separator'); this.separator.setAttribute('aria-orientation', 'vertical');
    this.separator.setAttribute('aria-label', '调整助手宽度'); this.separator.setAttribute('aria-controls', this.aside.id);
    this.separator.setAttribute('aria-valuemin', String(PANEL_MIN)); this.separator.setAttribute('aria-valuemax', String(PANEL_MAX));
    this.shade = element('button', 'assistant-shade'); this.shade.type = 'button'; this.shade.tabIndex = -1; this.shade.setAttribute('aria-label', '收起助手');
    workspace.append(this.shade, this.separator, this.aside);
    toggle.setAttribute('aria-controls', this.aside.id);
    this.writer = new DraftWriter(async (value) => {
      if (desktop) await this.client.saveDraft((await this.ensureConversation()).id, value);
      else localStorage.setItem(PREVIEW_DRAFT, value);
    });
    this.actionWriter = new DraftWriter(async value => {
      if (desktop && this.conversation) await this.client.saveActionDrafts(this.conversation.id, JSON.parse(value || '[]') as ActionDraft[]);
    });
    toggle.addEventListener('click', () => this.setOpen(!this.preferences.open, true));
    get('.assistant-collapse').addEventListener('click', () => this.setOpen(false, true));
    this.shade.addEventListener('click', () => this.setOpen(false, true));
    this.status.addEventListener('click', () => this.connect(this.status));
    this.fresh.addEventListener('click', () => {
      if (this.switching) return;
      this.historyList.hidden = true;
      this.switching = this.newConversation();
      this.perform(async () => { try { await this.switching; } finally { this.switching = null; } });
    });
    this.historyBtn.addEventListener('click', () => {
      this.historyList.hidden = !this.historyList.hidden;
      if (!this.historyList.hidden) this.perform(() => this.renderHistoryList());
    });
    this.attachmentBar.querySelector('.assistant-attachment-remove')?.addEventListener('click', () => {
      this.perform(async () => { await this.attachmentTask; if (this.conversation) await this.client.clearAttachment(this.conversation.id); this.clearPendingSelection(); });
    });
    this.earlier.addEventListener('click', () => this.perform(() => this.loadEarlier()));
    this.input.addEventListener('input', () => {
      this.writer.update(this.input.value); this.notice.textContent = ''; this.updateStatus();
      clearTimeout(this.draftTimer); this.draftTimer = setTimeout(() => this.perform(() => this.flush()), 350);
    });
    this.input.addEventListener('blur', () => this.perform(() => this.flush()));
    get('form').addEventListener('submit', (event) => { event.preventDefault(); this.beginSend(); });
    this.input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && !event.isComposing) { event.preventDefault(); this.beginSend(); }
    });
    this.stop.addEventListener('click', () => this.perform(() => this.cancel()));
    this.aside.addEventListener('keydown', (event) => {
      // Existing settings dialogs own Escape while visible.
      const modal = [...document.querySelectorAll<HTMLElement>('.modal-backdrop')].some((node) => !node.hidden);
      if (event.key === 'Escape' && !modal) { event.stopPropagation(); this.setOpen(false, true); }
    });
    this.bindResize();
    this.layoutObserver = new ResizeObserver(() => this.layout()); this.layoutObserver.observe(workspace);
    this.layout(); this.updateStatus();
  }
  private perform(task: () => Promise<unknown>) { void task().catch((error) => { this.notice.textContent = error instanceof Error ? error.message : String(error); }); }
  private persist() {
    try { localStorage.setItem(PREFERENCES, JSON.stringify(this.preferences)); }
    catch { this.notice.textContent = '面板偏好未能保存，下次打开可能恢复默认布局。'; }
  }
  private layout() {
    const open = this.preferences.open, overlay = overlayPanel(this.workspace.clientWidth, this.preferences.width);
    this.workspace.classList.toggle('assistant-open', open); this.workspace.classList.toggle('assistant-overlay', overlay);
    this.workspace.style.setProperty('--assistant-width', `${this.preferences.width}px`);
    this.aside.hidden = !open; this.separator.hidden = !open || overlay; this.shade.hidden = !open || !overlay;
    this.toggle.setAttribute('aria-expanded', String(open)); this.toggle.textContent = open ? '助手 ·' : '助手';
    this.separator.setAttribute('aria-valuenow', String(this.preferences.width));
    this.separator.setAttribute('aria-valuetext', `${this.preferences.width} 像素`);
  }
  setOpen(open: boolean, focus: boolean) {
    this.preferences.open = open; this.layout(); this.persist();
    if (focus) (open ? this.input : this.toggle).focus();
  }
  private bindResize() {
    let drag: { pointer: number; x: number; width: number } | null = null;
    this.separator.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) return;
      event.preventDefault(); this.separator.focus(); this.separator.setPointerCapture(event.pointerId);
      drag = { pointer: event.pointerId, x: event.clientX, width: this.preferences.width };
      this.workspace.classList.add('assistant-resizing');
    });
    this.separator.addEventListener('pointermove', (event) => {
      if (!drag || drag.pointer !== event.pointerId) return;
      // Clamp to available reading space while docked, so the handle stays under the pointer.
      this.preferences.width = panelWidth(Math.min(drag.width + drag.x - event.clientX, this.workspace.clientWidth - 528));
      this.layout();
    });
    const finish = () => { if (!drag) return; drag = null; this.workspace.classList.remove('assistant-resizing'); this.persist(); };
    this.separator.addEventListener('pointerup', finish); this.separator.addEventListener('lostpointercapture', finish); this.separator.addEventListener('pointercancel', finish);
    this.separator.addEventListener('dblclick', () => { this.preferences.width = PANEL_DEFAULT; this.layout(); this.persist(); });
    this.separator.addEventListener('keydown', (event) => {
      const delta = event.shiftKey ? 40 : 10;
      let width = this.preferences.width;
      if (event.key === 'ArrowLeft') width += delta;
      else if (event.key === 'ArrowRight') width -= delta;
      else if (event.key === 'Home') width = PANEL_MIN;
      else if (event.key === 'End') width = PANEL_MAX;
      else return;
      event.preventDefault(); this.preferences.width = panelWidth(Math.min(width, this.workspace.clientWidth - 528)); this.layout(); this.persist();
    });
  }
  async initialize() {
    try {
      await this.client.initialize();
      if (desktop) {
        const latest = (await this.client.list())[0];
        if (latest) {
          const page = await this.client.load(latest.id); this.conversation = page.conversation;
          this.input.value = page.conversation.draft; this.applyPage(page);
        }
      } else this.input.value = read(PREVIEW_DRAFT) ?? '';
      this.renderMessages(); this.scrollEnd();
    } catch (error) {
      this.notice.textContent = `助手记录暂不可用：${error instanceof Error ? error.message : String(error)}`;
      // Keep reading usable. Retry by reopening the app; never replace an unread store.
      this.input.disabled = true; return;
    } finally { this.loading = false; this.updateStatus(); }
  }
  private ensureConversation(): Promise<Conversation> {
    if (this.conversation) return Promise.resolve(this.conversation);
    if (!this.creating) {
      const book = this.book();
      this.creating = this.client.create(conversationTitle(book?.title ?? null), book?.id ?? null).then((conversation) => {
        this.conversation = conversation; this.title.textContent = conversation.title; return conversation;
      }).finally(() => { this.creating = null; });
    }
    return this.creating;
  }
  async flush() {
    clearTimeout(this.draftTimer);
    if (this.switching) await this.switching;
    if (this.loading) return;
    if (this.submitting) await this.submitting;
    await this.flushEdits();
  }
  private async newConversation(carry = false) {
    if (!desktop || this.request || this.submitting || this.loading) return;
    this.loading = true; this.updateStatus();
    try {
      clearTimeout(this.draftTimer); await this.flushEdits();
      const existingDraft = carry ? continuationDraft(this.messages,this.input.value) : this.input.value;
      // Create first: a failure cannot discard the currently visible draft/history.
      const previous = this.conversation?.id;
      const book = this.book(); const conversation = await this.client.create(conversationTitle(book?.title ?? null), book?.id ?? null);
      if (previous) await this.client.copyAttachment(previous,conversation.id);
      this.conversation = conversation;
      this.input.value = existingDraft;
      this.writer.update(existingDraft); await this.writer.flush();
      this.messages = []; this.more = false; this.live = null; this.actionDrafts.clear(); this.clearPendingSelection();
      this.notice.textContent = ''; const page=await this.client.load(conversation.id); this.applyPage(page); this.renderMessages(); this.input.focus();
    } finally { this.loading = false; this.updateStatus(); }
  }
  updateStatus() {
    const phase = this.codex.status.phase;
    const name = this.codex.label;
    const labels = { disconnected: `连接 ${name}`, connecting: '正在连接…', ready: `${name} 已连接`, running: `${name} 正在回答`, cancelling: `${name} 正在停止`, error: `重新连接 ${name}` };
    this.status.textContent = desktop ? labels[phase] : '桌面版可连接助手';
    this.status.title = this.codex.status.message;
    const mismatch = !!this.conversation?.threadId && (this.conversation.protocolVersion?.startsWith('pi-rpc/') === true) !== (this.codex.status.provider === 'pi');
    this.send.disabled = mismatch || !desktop || this.loading || !!this.request || !!this.submitting || phase !== 'ready' || !this.input.value.trim() || this.input.disabled;
    this.recovery.hidden = !desktop || !this.messages.length || !(mismatch || this.messages.some(m => m.role === 'assistant' && ['failed','interrupted'].includes(m.status)));
    this.recovery.disabled = this.loading || !!this.request || !!this.submitting;
    this.fresh.disabled = !desktop || this.loading || !!this.request || !!this.submitting || this.input.disabled;
    this.stop.hidden = !this.request; this.stop.disabled = this.stopping;
    this.earlier.disabled = !!this.request;
    this.input.readOnly = this.loading || !!this.submitting;
    this.title.textContent = this.conversation ? `${this.conversation.title}${mismatch ? ' · 请开启新对话使用当前助手' : ''}` : (desktop ? '随时继续讨论' : '浏览器预览 · 草稿保存在此浏览器');
    if (mismatch && !this.notice.textContent) {
      this.notice.textContent = `当前会话与 ${name} 格式不匹配。点击「新对话」即可无缝开始，草稿已保留。`;
    }
  }
  private beginSend() {
    if (this.send.disabled || this.submitting || this.request) return;
    // Reserve synchronously before any draft/context work, preventing repeated submits.
    this.submitting = this.submit(); this.updateStatus();
    void this.submitting.catch((error) => { this.notice.textContent = error instanceof Error ? error.message : String(error); })
      .finally(() => { this.submitting = null; this.updateStatus(); });
  }
  private async submit() {
    clearTimeout(this.draftTimer); await this.flushEdits(); await this.beforeSend();
    const conversation = await this.ensureConversation(), question = this.input.value.trim();
    const request = this.client.start(conversation.id, question, (turn) => {
      if (this.request !== request) return;
      this.showLive(turn.body, messageLabel(turn.status));
    });
    this.request = request; this.stopping = false; this.notice.textContent = ''; this.updateStatus();
    this.records().querySelector('.assistant-empty')?.remove();
    const pending = element('article', 'assistant-message assistant-user');
    pending.append(element('p', 'assistant-role', '你'), element('p', 'assistant-body', question));
    this.records().append(pending); this.live = null; this.showLive('', '正在准备…'); this.scrollEnd();
    // Consume the result immediately, including failure before the start acknowledgement.
    const outcome = request.result.then(() => null, (error: unknown) => error);
    try {
      await request.accepted;
      this.clearPendingSelection();
      this.input.value = ''; this.writer.update(''); await this.flushEdits();
      const page = await this.client.load(conversation.id); this.applyPage(page);
      this.renderMessages(); this.scrollEnd();
    } catch (error) {
      // Native begin may already have stored a failed request. Keep an unsent draft only
      // when no user message was accepted; don't silently replay a stored question.
      try {
        const page = await this.client.load(conversation.id);
        if (page.messages.some((message) => message.requestId === request.requestId)) {
          this.input.value = ''; this.writer.update(''); await this.flushEdits();
        }
        this.applyPage(page); this.renderMessages();
      } catch { /* Retain the draft and live text when local refresh fails. */ }
      this.notice.textContent = error instanceof Error ? error.message : String(error);
    }
    // Release the composer while the response runs; drafts can now be saved after begin.
    this.submitting = null; this.updateStatus();
    void outcome.then(async (error) => {
      try {
        await this.flushEdits(); const page = await this.client.load(conversation.id);
        this.applyPage(page); this.renderMessages();
        if (error && !this.stopping) this.notice.textContent = error instanceof Error ? error.message : String(error);
        else if (this.stopping) this.notice.textContent = '已停止。可以继续提问。';
      } catch (loadError) {
        if (this.live) this.showLive(this.live.querySelector('.assistant-body')?.textContent ?? '', '回复未完成 · 记录待刷新');
        this.notice.textContent = `回复已结束，但记录未能刷新：${String(loadError)}`;
      }
      finally { if (this.request === request) this.request = null; this.stopping = false; this.updateStatus(); }
    });
  }
  private async cancel() {
    if (!this.request || this.stopping) return;
    this.stopping = true; this.updateStatus(); this.notice.textContent = '正在停止，已收到的文字会保留。';
    this.showLive(this.live?.querySelector('.assistant-body')?.textContent ?? '', '正在停止…');
    try { await this.request.cancel(); }
    catch (error) { this.stopping = false; this.updateStatus(); throw error; }
  }
  private async flushEdits() { await this.attachmentTask; await this.writer.flush(); await this.actionWriter.flush(); }
  private applyPage(page: ConversationPage) {
    this.messages = page.messages; this.more = page.hasMore;
    for (const r of page.receipts ?? []) {
      const id = r.actionId.slice(r.actionId.indexOf('-') + 1);
      this.receipts.set(id,r); this.savedActions.set(id,r.actionType === 'idea' ? '已确认想法' : r.actionType === 'book_annotation' ? '已存为书籍笔记' : '已存为对话笔记');
    }
    this.actionDrafts = new Map((page.actionDrafts ?? []).map(d => [d.messageId,d]));
    if (page.attachment) this.showAttachment(page.attachment);
    else this.clearPendingSelection();
  }
  private persistActionDrafts() { this.actionWriter.update(JSON.stringify([...this.actionDrafts.values()])); this.perform(() => this.actionWriter.flush()); }
  private trackCard(card: HTMLElement, message: AssistantMessage, kind: 'note' | 'idea') {
    const capture = () => {
      const field = <T extends HTMLInputElement | HTMLTextAreaElement>(name: string) => card.querySelector<T>(`.assistant-${kind}-${name}`);
      this.actionDrafts.set(message.id,{messageId:message.id,kind,body:field('body')?.value ?? '',quote:field('quote')?.value ?? '',title:field('title')?.value ?? '',exportToVault:field<HTMLInputElement>('export')?.checked ?? false});
      this.persistActionDrafts();
    };
    card.addEventListener('input', capture); card.addEventListener('change',capture); capture();
  }
  private discardCard(card: HTMLElement, id: string) { card.remove(); this.actionDrafts.delete(id); this.persistActionDrafts(); }
  private showAttachment(source: AssistantSource) {
    this.pendingSelection = {text:source.text,cfi:source.anchor?.cfi ?? '',href:source.anchor?.href ?? '',bookId:source.bookId,title:source.title};
    this.attachmentBar.hidden=false;
    this.attachmentBar.querySelector<HTMLElement>('.assistant-attachment-text')!.textContent=`引用：「${Array.from(source.text).slice(0,58).join('')}」`;
  }
  private records() { return this.aside.querySelector<HTMLElement>('.assistant-records')!; }
  refreshVault() {
    // A completed conversation must expose export immediately after connecting.
    if (!this.request) this.renderMessages();
  }
  private renderMessages() {
    const nearEnd = this.log.scrollHeight - this.log.scrollTop - this.log.clientHeight < 80;
    const records = this.records(); records.replaceChildren(); this.live = null;
    this.earlier.hidden = !this.more;
    if (!this.messages.length) records.append(element('p', 'assistant-empty', desktop ? '读到哪里，聊到哪里。' : '在桌面版连接 Codex 后，就可以开始讨论。'));
    for (const message of this.messages) {
      const row = element('article', `assistant-message assistant-${message.role}`);
      row.append(element('p', 'assistant-role', message.role === 'user' ? '你' : '助手'));
      row.append(element('p', 'assistant-body', message.body));
      const label = message.role === 'assistant' ? messageLabel(message.status) : '';
      if (label) row.append(element('p', 'assistant-message-status', label));
      if (message.error && message.status === 'failed') row.append(element('p', 'assistant-message-status', message.error));
      if (message.role === 'assistant' && message.input.retrieval) {
        const retrieval=message.input.retrieval;
        row.append(element('p','assistant-message-status',`检索匹配 ${retrieval.matched} 项，使用 ${retrieval.sent} 项。${retrieval.partial ? '检索范围尚不完整，未命中不代表不存在。' : ''}${retrieval.scope.includes('Vault 未连接') ? 'Vault 未连接或不可用。' : ''}`));
      }
      if (message.answer?.citations.length) {
        const hasNonBook = message.answer.citations.some((c) => {
          const s = message.input.sources.find((source) => source.id === c.sourceId);
          return s && s.kind !== 'book';
        });
        const summaryLabel = hasNonBook ? `参考依据 · ${message.answer.citations.length}` : `原文依据 · ${message.answer.citations.length}`;
        const details = element('details', 'assistant-citations'); details.append(element('summary', '', summaryLabel));
        for (const citation of message.answer.citations) {
          const source = message.input.sources.find((source) => source.id === citation.sourceId);
          if (source) {
            const item = element('div', 'assistant-citation-item');
            const titleRow = element('p', 'assistant-source-title');
            const badgeText = source.kind === 'note' ? '笔记' : source.kind === 'idea' ? '想法' : source.kind === 'vault' ? '文档' : '原文';
            const badge = element('span', `assistant-source-badge assistant-source-badge-${source.kind}`, badgeText);
            titleRow.append(badge, ' ', document.createTextNode(source.title));
            if (source.anchor && this.onNavigateCitation) {
              const jumpBtn = element('button', 'text-button assistant-citation-jump', '查看原文 →');
              jumpBtn.type = 'button';
              jumpBtn.addEventListener('click', () => {
                this.onNavigateCitation?.(source);
              });
              titleRow.append(' ', jumpBtn);
            }
            if (source.kind === 'vault' && this.onOpenVaultSource) {
              const openVaultBtn = element('button', 'text-button assistant-citation-jump', '在 Obsidian 打开 →');
              openVaultBtn.type = 'button';
              openVaultBtn.addEventListener('click', () => {
                this.onOpenVaultSource?.({conversationId:message.conversationId,messageId:message.id,sourceId:source.id});
              });
              titleRow.append(' ', openVaultBtn);
            }
            item.append(titleRow, element('blockquote', '', citation.quote));
            details.append(item);
          }
        }
        row.append(details);
      }

      if ((message.status === 'completed' || message.role === 'user') && message.body.trim()) {
        const actions = element('div', 'assistant-message-actions');
        const actionKey = message.id;
        const savedStatus = this.savedActions.get(actionKey);
        if (savedStatus) {
          actions.append(element('span', 'assistant-action-badge', savedStatus));
          const receipt = this.receipts.get(message.id);
          if (receipt && this.hasVault?.()) {
            const exportButton = element('button','text-button','导出'); exportButton.type='button';
            exportButton.addEventListener('click', () => this.perform(async () => {const result=await this.client.exportSaved(receipt); this.notice.textContent=result.message || (result.status==='synced' ? '已导出至 Vault。' : '导出尚未完成。');})); actions.append(exportButton);
          }
        } else {
          if (message.role === 'user') {
          const saveNoteBtn = element('button', 'text-button', '存为笔记');
          saveNoteBtn.type = 'button';
          saveNoteBtn.addEventListener('click', () => {
            this.renderSaveNoteCard(row, message);
          });
          actions.append(saveNoteBtn);
          }
          if (message.role === 'assistant' && message.status === 'completed') {
            const confirmIdeaBtn = element('button', 'text-button', '确认想法');
            confirmIdeaBtn.type = 'button';
            confirmIdeaBtn.addEventListener('click', () => {
              this.renderConfirmIdeaCard(row, message);
            });
            actions.append(confirmIdeaBtn);
          }
        }
        row.append(actions);
      }

      records.append(row);
      const draft = this.actionDrafts.get(message.id);
      if (draft && !this.savedActions.has(message.id)) { if (draft.kind === 'idea') this.renderConfirmIdeaCard(row,message); else this.renderSaveNoteCard(row,message); }
      if (message.requestId === this.request?.requestId && message.role === 'assistant') this.live = row;
    }
    if (nearEnd) this.scrollEnd();
  }

  private renderSaveNoteCard(row: HTMLElement, message: AssistantMessage) {
    const existing = row.querySelector('.assistant-action-card');
    if (existing) { this.discardCard(existing as HTMLElement,message.id); return; }

    const card = element('div', 'assistant-action-card');
    const draft = this.actionDrafts.get(message.id);
    const anchorSource = message.input.sources.find(s => s.kind === 'book' && s.anchor && !s.truncated);
    const defaultQuote = draft?.quote ?? anchorSource?.text ?? '';
    const anchorDesc = anchorSource?.anchor ? `来源：${anchorSource.title} · 发送时的原文位置` : '无完整原文锚点，存为独立对话笔记';

    card.innerHTML = `
      <label>正文</label>
      <textarea class="assistant-note-body" aria-label="笔记正文" maxlength="8000" rows="2">${escapeHtml(draft?.body ?? message.body)}</textarea>
      <label>原文摘录</label>
      <input type="text" class="assistant-note-quote" aria-label="原文摘录" ${anchorSource ? 'readonly' : ''} value="${escapeHtml(defaultQuote)}" />
      <p style="font-size:10px;color:var(--muted);margin:2px 0 6px">${anchorDesc}</p>
      <label class="assistant-action-checkbox"><input type="checkbox" class="assistant-note-export" ${this.hasVault?.() ? (draft?.exportToVault === false ? '' : 'checked') : 'disabled'} /> 确认后导出到 Obsidian Vault</label>
      <div class="assistant-action-footer">
        <button type="button" class="text-button assistant-action-cancel">取消</button>
        <button type="button" class="primary-button assistant-action-confirm" style="font-size:11px;padding:4px 10px">保存笔记</button>
      </div>
    `;

    card.querySelector('.assistant-action-cancel')?.addEventListener('click', () => this.discardCard(card,message.id));
    card.querySelector('.assistant-action-confirm')?.addEventListener('click', () => {
      const body = card.querySelector<HTMLTextAreaElement>('.assistant-note-body')?.value.trim() ?? '';
      const quote = card.querySelector<HTMLInputElement>('.assistant-note-quote')?.value.trim() ?? '';
      const exportToVault = card.querySelector<HTMLInputElement>('.assistant-note-export')?.checked ?? false;
      if (!body && !quote) {
        this.notice.textContent = '笔记内容不能为空。';
        return;
      }
      const confirmBtn = card.querySelector<HTMLButtonElement>('.assistant-action-confirm')!;
      confirmBtn.disabled = true;
      this.perform(async () => {
        try {
          const actionId = `note-${message.id}`;
          const noteId = crypto.randomUUID();
          const res = await this.client.saveNote({
            noteId,
            actionId,
            conversationId: message.conversationId,
            messageId: message.id,
            body,
            quote,
            anchor: anchorSource?.anchor ?? null,
            bookId: anchorSource?.bookId ?? null,
            exportToVault,
          });
          const badgeText = res.kind === 'book_annotation' ? '已存为书籍笔记' : '已存为对话笔记';
          this.savedActions.set(message.id, badgeText); this.receipts.set(message.id,res.receipt);
          this.discardCard(card,message.id);
          const actionsRow = row.querySelector('.assistant-message-actions');
          if (actionsRow) {
            actionsRow.replaceChildren(element('span', 'assistant-action-badge', badgeText));
          }
          this.notice.textContent = res.exportMessage || (res.exported ? `${badgeText}，并已导出至 Vault。` : `${badgeText}。`);
          this.onNoteSaved?.(); this.renderMessages();
        } catch (e) {
          confirmBtn.disabled = false;
          throw e;
        }
      });
    });

    row.append(card); this.trackCard(card,message,'note');
  }

  private renderConfirmIdeaCard(row: HTMLElement, message: AssistantMessage) {
    const existing = row.querySelector('.assistant-action-card');
    if (existing) { this.discardCard(existing as HTMLElement,message.id); return; }

    const card = element('div', 'assistant-action-card');
    const draft = this.actionDrafts.get(message.id);
    const defaultTitle = draft?.title ?? (Array.from(message.body.trim()).slice(0,24).join('').replace(/\n/g,' ') || '对话想法');

    card.innerHTML = `
      <label>标题</label>
      <input type="text" class="assistant-idea-title" aria-label="想法标题" maxlength="80" value="${escapeHtml(defaultTitle)}" />
      <label>正文</label>
      <textarea class="assistant-idea-body" aria-label="想法正文" rows="3" maxlength="4000">${escapeHtml(draft?.body ?? Array.from(message.body).slice(0,4000).join(''))}</textarea>
      <label class="assistant-action-checkbox"><input type="checkbox" class="assistant-idea-export" ${this.hasVault?.() ? (draft?.exportToVault === false ? '' : 'checked') : 'disabled'} /> 确认后导出到 Obsidian Vault</label>
      <div class="assistant-action-footer">
        <button type="button" class="text-button assistant-action-cancel">取消</button>
        <button type="button" class="primary-button assistant-action-confirm" style="font-size:11px;padding:4px 10px">确认并保存想法</button>
      </div>
    `;

    card.querySelector('.assistant-action-cancel')?.addEventListener('click', () => this.discardCard(card,message.id));
    card.querySelector('.assistant-action-confirm')?.addEventListener('click', () => {
      const title = card.querySelector<HTMLInputElement>('.assistant-idea-title')?.value.trim() ?? '';
      const body = card.querySelector<HTMLTextAreaElement>('.assistant-idea-body')?.value.trim() ?? '';
      const exportToVault = card.querySelector<HTMLInputElement>('.assistant-idea-export')?.checked ?? false;
      if (!title || !body) {
        this.notice.textContent = '想法标题和正文不能为空。';
        return;
      }
      const confirmBtn = card.querySelector<HTMLButtonElement>('.assistant-action-confirm')!;
      confirmBtn.disabled = true;

      this.perform(async () => {
        try {
          const actionId = `idea-${message.id}`;
          const ideaId = crypto.randomUUID();
          const res = await this.client.saveIdea({
            actionId, conversationId:message.conversationId, messageId:message.id,
            draft: {
              id: ideaId,
              title,
              body,
              question: message.input.question || '助手讨论整理',
              sources: [],
            },
            exportToVault,
          });
          const badgeText = '已确认想法';
          this.savedActions.set(message.id, badgeText); this.receipts.set(message.id,res.receipt);
          this.discardCard(card,message.id);
          const actionsRow = row.querySelector('.assistant-message-actions');
          if (actionsRow) {
            actionsRow.replaceChildren(element('span', 'assistant-action-badge', badgeText));
          }
          this.notice.textContent = res.exportMessage || (res.exported ? '想法已确认保存，并已导出至 Vault。' : '想法已确认保存在 Reader。');
          this.renderMessages();
          this.onIdeaSaved?.();
        } catch (e) {
          confirmBtn.disabled = false;
          throw e;
        }
      });
    });

    row.append(card); this.trackCard(card,message,'idea');
  }

  setDraftAndOpen(text: string, selection?: PendingSelection) {
    if (selection) {
      this.attachSelection(selection);
    } else {
      this.setOpen(true, true);
    }
    if (text) {
      this.input.value = text;
      this.writer.update(text);
      this.notice.textContent = '';
      this.updateStatus();
    }
    this.input.focus();
  }

  attachSelection(selection: PendingSelection) {
    this.pendingSelection = selection;
    if (desktop) {
      this.attachmentTask = this.beforeSend().then(async () => {
        const conversation = await this.ensureConversation();
        this.showAttachment(await this.client.captureSelection(conversation.id,selection.noteId ?? null));
      }).catch(error => { this.clearPendingSelection(); this.notice.textContent=String(error); });
      this.perform(() => this.attachmentTask);
    }
    this.attachmentBar.hidden = false;
    const preview = selection.text.length > 60 ? selection.text.slice(0, 58) + '…' : selection.text;
    this.attachmentBar.querySelector<HTMLElement>('.assistant-attachment-text')!.textContent = `引用：「${preview}」`;
    this.setOpen(true, true);
    this.input.focus();
  }
  clearPendingSelection() {
    this.pendingSelection = null;
    this.attachmentBar.hidden = true;
    this.attachmentBar.querySelector<HTMLElement>('.assistant-attachment-text')!.textContent = '';
  }
  private async renderHistoryList() {
    if (!desktop) return;
    this.historyList.replaceChildren();
    try {
      const list = await this.client.list();
      if (!list.length) {
        this.historyList.append(element('p', 'assistant-history-empty', '暂无历史对话'));
        return;
      }
      for (const item of list) {
        const row = element('button', 'assistant-history-item', item.title || '无标题对话');
        row.type = 'button';
        if (this.conversation?.id === item.id) row.classList.add('active');
        row.addEventListener('click', () => {
          this.historyList.hidden = true;
          this.perform(() => this.switchConversation(item.id));
        });
        this.historyList.append(row);
      }
    } catch (e) {
      this.historyList.append(element('p', 'assistant-history-empty', `加载失败：${String(e)}`));
    }
  }
  private async switchConversation(id: string) {
    if (!desktop || this.request || this.submitting || this.loading || this.conversation?.id === id) return;
    this.loading = true; this.updateStatus();
    try {
      clearTimeout(this.draftTimer); await this.flushEdits();
      const page = await this.client.load(id);
      this.conversation = page.conversation;
      this.input.value = page.conversation.draft;
      this.applyPage(page);
      this.notice.textContent = '';
      this.renderMessages();
      this.scrollEnd();
      this.input.focus();
    } finally { this.loading = false; this.updateStatus(); }
  }
  private showLive(body: string, status: string) {
    const nearEnd = this.log.scrollHeight - this.log.scrollTop - this.log.clientHeight < 80;
    if (!this.live) {
      this.live = element('article', 'assistant-message assistant-assistant');
      this.live.append(element('p', 'assistant-role', '助手'), element('p', 'assistant-body'), element('p', 'assistant-message-status'));
      this.records().append(this.live);
    }
    this.live.querySelector('.assistant-body')!.textContent = body;
    let label = this.live.querySelector('.assistant-message-status');
    if (!label) { label = element('p', 'assistant-message-status'); this.live.append(label); }
    label.textContent = status; if (nearEnd) this.scrollEnd();
  }
  private scrollEnd() { this.log.scrollTop = this.log.scrollHeight; }
  private async loadEarlier() {
    if (!this.conversation || !this.more || this.request) return;
    this.earlier.disabled = true;
    const height = this.log.scrollHeight, top = this.log.scrollTop;
    try {
      await this.flushEdits();
      const page = await this.client.load(this.conversation.id, this.messages[0]?.sequence ?? null);
      for (const r of page.receipts ?? []) {
        const id=r.actionId.slice(r.actionId.indexOf('-')+1);
        this.receipts.set(id,r); this.savedActions.set(id,r.actionType==='idea' ? '已确认想法' : r.actionType==='book_annotation' ? '已存为书籍笔记' : '已存为对话笔记');
      }
      for (const draft of page.actionDrafts ?? []) if (!this.actionDrafts.has(draft.messageId)) this.actionDrafts.set(draft.messageId,draft);
      this.messages = [...page.messages, ...this.messages]; this.more = page.hasMore; this.renderMessages();
      this.log.scrollTop = top + this.log.scrollHeight - height;
    } finally { this.earlier.disabled = false; }
  }
}
