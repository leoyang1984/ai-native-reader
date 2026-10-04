import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { desktop } from '../repository';
import type { CodexClient } from '../codex-client';
import type {
  AssistantTurn, Conversation, ConversationPage, AssistantSource, ActionDraft, ActionReceipt,
  AssistantSaveNoteDraft, SaveNoteResult,
  AssistantSaveIdeaDraft, AssistantSaveIdeaResult,
} from './contracts';

export interface AssistantRequest {
  requestId: string; conversationId: string; result: Promise<AssistantTurn>; accepted: Promise<void>; cancel: () => Promise<void>;
}
/** Conversation lifecycle is independent of page/selection lifecycle. M5-02 mounts the panel. */
export class AssistantClient {
  private unlisten: UnlistenFn | null = null;
  private initializing = false;
  private jobs = new Map<string, { conversationId: string; generation: number; cancelled: boolean;
    resolve: (turn: AssistantTurn) => void; reject: (error: Error) => void; progress?: (turn: AssistantTurn) => void }>();
  constructor(private readonly codex: CodexClient) {}
  async initialize() {
    if (!desktop) return;
    if (this.unlisten || this.initializing) throw new Error('助手已初始化。');
    this.initializing = true;
    try {
      this.unlisten = await listen<AssistantTurn>('assistant-turn', ({ payload }) => {
        const job = this.jobs.get(payload.requestId);
        if (!job || payload.conversationId !== job.conversationId || payload.generation !== job.generation) return;
        if (payload.status === 'streaming' || payload.status === 'cancelling') {
          if (!job.cancelled) job.progress?.(payload);
          return;
        }
        this.jobs.delete(payload.requestId);
        if (payload.status === 'completed' && !job.cancelled) job.resolve(payload);
        else job.reject(new Error(job.cancelled ? '讨论已停止。' : payload.message));
      });
    } finally { this.initializing = false; }
  }
  create(title: string, bookId: string | null = null) {
    return invoke<Conversation>('assistant_create', { id: crypto.randomUUID(), title, bookId });
  }
  list(before: string | null = null) { return invoke<Conversation[]>('assistant_list', { before }); }
  load(id: string, before: number | null = null) { return invoke<ConversationPage>('assistant_load', { id, before }); }
  saveDraft(id: string, text: string) { return invoke<void>('assistant_draft', { id, text }); }
  copyAttachment(from: string, to: string) { return invoke<void>('assistant_copy_attachment',{from,to}); }
  captureSelection(conversationId: string, noteId: string | null = null) { return invoke<AssistantSource>('assistant_capture_selection', { conversationId, noteId }); }
  clearAttachment(conversationId: string) { return invoke<void>('assistant_clear_attachment', { conversationId }); }
  saveActionDrafts(conversationId: string, drafts: ActionDraft[]) { return invoke<void>('assistant_action_drafts', { conversationId, drafts }); }
  exportSaved(receipt: ActionReceipt) {
    return invoke<{status: string; message: string | null}>(receipt.actionType === 'idea' ? 'export_idea' : receipt.actionType === 'book_annotation' ? 'export_note' : 'assistant_export_conversation_note', {id:receipt.targetId});
  }
  openVault(conversationId: string, messageId: string, sourceId: string) { return invoke<void>('assistant_open_vault', {conversationId,messageId,sourceId}); }
  saveNote(draft: AssistantSaveNoteDraft) {
    return invoke<SaveNoteResult>('assistant_save_note', { draft });
  }
  saveIdea(draft: AssistantSaveIdeaDraft) {
    return invoke<AssistantSaveIdeaResult>('assistant_save_idea', { draft });
  }
  exportConversationNote(id: string) {
    return invoke<unknown>('assistant_export_conversation_note', { id });
  }
  start(conversationId: string, question: string, onProgress?: (turn: AssistantTurn) => void): AssistantRequest {
    if (!desktop || !this.unlisten || this.codex.status.phase !== 'ready' || this.jobs.size) throw new Error('请先连接助手，或等待当前讨论结束。');
    const requestId = crypto.randomUUID(), generation = this.codex.status.generation;
    let resolve!: (turn: AssistantTurn) => void, reject!: (error: Error) => void;
    const result = new Promise<AssistantTurn>((yes, no) => { resolve = yes; reject = no; });
    const job = { conversationId, generation, cancelled: false, resolve, reject, progress: onProgress };
    this.jobs.set(requestId, job);
    const accepted = invoke<void>('assistant_start', { conversationId, requestId, question, generation }).catch((error: unknown) => {
      if (this.jobs.get(requestId) === job) {
        this.jobs.delete(requestId); reject(new Error(String(error)));
      }
      throw error;
    });
    return { requestId, conversationId, result, accepted, cancel: async () => {
      if (this.jobs.get(requestId) !== job || job.cancelled) return;
      job.cancelled = true;
      try { await invoke('codex_cancel', { requestId }); }
      catch (error) {
        if (this.jobs.get(requestId) === job) job.cancelled = false;
        throw error;
      }
    } };
  }
  dispose() {
    this.unlisten?.(); this.unlisten = null;
    // Closing presentation does not stop native requests. Records continue to persist.
    for (const job of this.jobs.values()) job.reject(new Error('助手界面已关闭，回复保留在原对话中。'));
    this.jobs.clear();
  }
}
