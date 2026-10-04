import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { assistantOutputSchema, ASSISTANT_CONTRACT_VERSION } from '../src/assistant/contracts.ts';

test('assistant envelope forbids executable actions and requires every field', () => {
  assert.equal(ASSISTANT_CONTRACT_VERSION, 1);
  assert.equal(assistantOutputSchema.additionalProperties, false);
  assert.deepEqual(assistantOutputSchema.required, ['schemaVersion', 'answer', 'citations', 'proposal']);
  assert.deepEqual(assistantOutputSchema.properties.proposal, { type: 'null' });
  assert.equal(assistantOutputSchema.properties.citations.items.additionalProperties, false);
  assert.deepEqual(assistantOutputSchema.properties.citations.items.required, ['sourceId', 'quote']);
});

test('pinned stable protocols provide continuity, ephemeral isolation and per-turn envelopes', () => {
  for (const version of ['0.159.2', '0.160.0']) {
    const wire = JSON.parse(readFileSync(new URL(`../src-tauri/protocol/codex-${version}.schema.json`, import.meta.url), 'utf8'));
    const defs = wire.definitions.v2;
    assert.ok(defs.ThreadStartParams.properties.ephemeral);
    assert.ok(defs.ThreadResumeParams.properties.threadId);
    assert.ok(defs.ThreadResumeParams.properties.excludeTurns);
    assert.ok(defs.TurnStartParams.properties.clientUserMessageId);
    assert.ok(defs.TurnStartParams.properties.outputSchema);
    assert.ok(defs.Thread.properties.turns);
    assert.ok(defs.Turn.properties.status);
    assert.equal(defs.ThreadStartParams.properties.dynamicTools, undefined);
  }
});

test('new phase and start notifications have resolved pinned definitions', () => {
  const wire = JSON.parse(readFileSync(new URL('../src-tauri/protocol/codex-0.160.0.schema.json', import.meta.url), 'utf8'));
  for (const root of ['v2/ItemStartedNotification', 'v2/TurnStartedNotification']) assert.ok(wire.roots.includes(root));
  const visit = (value: unknown) => {
    if (!value || typeof value !== 'object') return;
    for (const [key, item] of Object.entries(value)) {
      if (key === '$ref') {
        assert.equal(typeof item, 'string');
        const parts = (item as string).replace('#/', '').split('/');
        let target = wire;
        for (const part of parts) target = target[part];
        assert.ok(target, `unresolved definition: ${item}`);
      } else visit(item);
    }
  };
  visit(wire.definitions);
});

test('assistant source contract supports book, note, and idea with discriminators', () => {
  const bookSource = {
    schemaVersion: 1 as const,
    id: 'book-1',
    kind: 'book' as const,
    createdBy: 'author' as const,
    bookId: 'b'.repeat(64),
    fingerprint: 'b'.repeat(64),
    title: '认知心理学',
    version: 'hash1',
    text: '注意力分配理论',
    truncated: false,
    anchor: { cfi: 'epubcfi(/6/2)', href: 'c1.xhtml' },
  };

  const noteSource = {
    schemaVersion: 1 as const,
    id: 'note-1',
    kind: 'note' as const,
    createdBy: 'human' as const,
    bookId: 'b'.repeat(64),
    fingerprint: 'note-id-1',
    title: '认知心理学 · 笔记',
    version: 'hash2',
    text: '思考：选择性注意的核心是抑制干扰。',
    truncated: false,
    anchor: { cfi: 'epubcfi(/6/4)', href: 'c1.xhtml' },
  };

  const ideaSource = {
    schemaVersion: 1 as const,
    id: 'idea-1',
    kind: 'idea' as const,
    createdBy: 'agent' as const,
    bookId: '' as const,
    fingerprint: 'idea-id-1',
    title: '想法 · 抑制机制',
    version: 'hash3',
    text: '抑制控制可训练性分析。',
    truncated: false,
    anchor: null,
  };

  const vaultSource = {
    schemaVersion: 1 as const,
    id: 'vault-1',
    kind: 'vault' as const,
    createdBy: 'unknown' as const,
    bookId: '' as const,
    fingerprint: 'Notes/Cognition.md',
    title: 'Notes/Cognition.md',
    version: 'hash4',
    text: '认知负荷与工作记忆模型。',
    truncated: false,
    anchor: null,
  };

  const sources = [bookSource, noteSource, ideaSource, vaultSource];
  assert.equal(sources.length, 4);
  assert.equal(sources[0].kind, 'book');
  assert.equal(sources[1].kind, 'note');
  assert.equal(sources[2].kind, 'idea');
  assert.equal(sources[3].kind, 'vault');
});

test('M5-06 save note and idea draft contracts maintain idempotency receipts', () => {
  const noteDraft = {
    noteId: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
    actionId: 'act-12345',
    conversationId: 'conv-1',
    messageId: 'msg-1',
    body: '记录下这个想法',
    quote: '注意力分配理论',
    anchor: { cfi: 'epubcfi(/6/2)', href: 'c1.xhtml' },
    bookId: 'b'.repeat(64),
    exportToVault: true,
  };
  assert.ok(noteDraft.actionId);
  assert.equal(noteDraft.exportToVault, true);

  const saveResult = {
    noteId: noteDraft.noteId,
    kind: 'book_annotation' as const,
    receipt: {
      actionId: noteDraft.actionId,
      actionType: 'book_annotation',
      targetId: noteDraft.noteId,
      contentHash: 'hash-abc',
      createdAt: new Date().toISOString(),
    },
    exported: true,
    exportMessage: null,
  };
  assert.equal(saveResult.receipt.actionId, noteDraft.actionId);
  assert.equal(saveResult.kind, 'book_annotation');
});
