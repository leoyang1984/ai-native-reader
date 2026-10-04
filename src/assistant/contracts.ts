import outputSchema from './output.schema.json';

export const ASSISTANT_CONTRACT_VERSION = 1 as const;
export { outputSchema as assistantOutputSchema };
/** v1 supports authenticated runtime book excerpts, human notes, and confirmed ideas. */
export interface AssistantBookSource {
  schemaVersion: 1; id: string; kind: 'book'; createdBy: 'author';
  bookId: string; fingerprint: string; title: string; version: string; text: string; truncated: boolean;
  anchor: { cfi: string; href: string } | null;
}
export interface AssistantNoteSource {
  schemaVersion: 1; id: string; kind: 'note'; createdBy: 'human';
  bookId: string; fingerprint: string; title: string; version: string; text: string; truncated: boolean;
  anchor: { cfi: string; href: string } | null;
}
export interface AssistantIdeaSource {
  schemaVersion: 1; id: string; kind: 'idea'; createdBy: 'agent';
  bookId: string; fingerprint: string; title: string; version: string; text: string; truncated: boolean;
  anchor: null;
}
export interface AssistantVaultSource {
  schemaVersion: 1; id: string; kind: 'vault'; createdBy: 'unknown';
  bookId: string; fingerprint: string; title: string; version: string; text: string; truncated: boolean;
  anchor: null;
}
export type AssistantSource = AssistantBookSource | AssistantNoteSource | AssistantIdeaSource | AssistantVaultSource;
export interface AssistantInput {
  schemaVersion: 1; question: string;
  context: { capturedAt: string; instanceId: string | null; revision: number | null; bookId: string | null; chapter: string | null };
  sources: AssistantSource[]; truncated: boolean;
  retrieval?: {scope: string; matched: number; sent: number; partial: boolean; vaultRoot?: string | null} | null;
}
export interface AssistantAnswer {
  schemaVersion: 1; answer: string; citations: { sourceId: string; quote: string }[]; proposal: null;
}
export interface Conversation {
  id: string; title: string; bookId: string | null; threadId: string | null;
  instructionVersion: string; protocolVersion: string | null; draft: string; createdAt: string; updatedAt: string;
}
export type MessageStatus = 'pending' | 'streaming' | 'cancelling' | 'completed' | 'cancelled' | 'interrupted' | 'failed';
export interface AssistantMessage {
  id: string; conversationId: string; requestId: string; role: 'user' | 'assistant'; sequence: number;
  body: string; status: MessageStatus; threadId: string | null; turnId: string | null;
  input: AssistantInput; answer: AssistantAnswer | null; error: string | null; createdAt: string;
}
export interface ActionDraft {messageId: string; kind: 'note' | 'idea'; body: string; quote: string; title: string; exportToVault: boolean}
export interface ConversationPage { conversation: Conversation; messages: AssistantMessage[]; hasMore: boolean;
  receipts: ActionReceipt[]; actionDrafts: ActionDraft[]; attachment: AssistantSource | null }
export interface AssistantTurn {
  conversationId: string; requestId: string; threadId: string; turnId: string | null;
  status: MessageStatus; body: string; answer: AssistantAnswer | null; message: string; generation: number;
}

export interface ActionReceipt {
  actionId: string;
  actionType: string;
  targetId: string;
  contentHash: string;
  createdAt: string;
}

export interface SaveNoteResult {
  noteId: string;
  kind: 'book_annotation' | 'conversation_note' | string;
  receipt: ActionReceipt;
  exported: boolean;
  exportMessage: string | null;
}

export interface AssistantSaveNoteDraft {
  noteId: string;
  actionId: string;
  conversationId: string;
  messageId: string | null;
  body: string;
  quote: string;
  anchor: { cfi: string; href: string } | null;
  bookId: string | null;
  exportToVault: boolean;
}

export interface AssistantSaveIdeaDraft {
  actionId: string; conversationId: string; messageId: string;
  draft: {
    id: string;
    title: string;
    body: string;
    question: string;
    sources: {
      source: {
        id: string;
        kind: string;
        key: string;
        title: string;
        text: string;
        contentHash: string;
        truncated: boolean;
        location?: { bookId: string; fingerprint: string; cfi: string; href: string };
        vaultPath?: string;
        relativePath?: string;
        startLine?: number;
        endLine?: number;
      };
      quote: string;
    }[];
  };
  exportToVault: boolean;
}

export interface AssistantSaveIdeaResult {
  idea: {
    id: string;
    title: string;
    body: string;
    question: string;
    createdBy: string;
    confirmedBy: string;
    createdAt: string;
    confirmedAt: string;
    sources: { source: unknown; quote: string }[];
  };
  receipt: ActionReceipt;
  exported: boolean;
  exportMessage: string | null;
}
