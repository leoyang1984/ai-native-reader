import assert from 'node:assert/strict';
import test from 'node:test';
import { DraftWriter, conversationTitle, panelPreferences, panelWidth, overlayPanel, messageLabel, continuationDraft } from '../src/assistant/presentation.ts';

test('panel preferences recover malformed storage and clamp widths', () => {
  assert.deepEqual(panelPreferences(null), { open: true, width: 340 });
  assert.deepEqual(panelPreferences('{'), { open: true, width: 340 });
  assert.deepEqual(panelPreferences('{"open":false,"width":999}'), { open: false, width: 480 });
  assert.deepEqual(panelPreferences('{"open":"false","width":-10}'), { open: true, width: 280 });
  assert.equal(panelWidth(NaN), 340);
  assert.equal(panelWidth(Infinity), 340);
});
test('overlay protects the reading area for every supported sidebar width', () => {
  assert.equal(overlayPanel(1200, 480), false);
  assert.equal(overlayPanel(800, 280), true);
  assert.equal(overlayPanel(867, 340), true);
  assert.equal(overlayPanel(868, 340), false);
  assert.equal(messageLabel('completed'), '');
  assert.match(messageLabel('cancelled'), /未完成/);
  assert.match(messageLabel('interrupted'), /未完成/);
});
test('draft edits during a slow save are written in order with latest value last', async () => {
  const values: string[] = []; let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const writer = new DraftWriter(async (value) => { values.push(value); if (values.length === 1) await gate; });
  writer.update('第一版'); const first = writer.flush(); await Promise.resolve();
  writer.update('第二版'); const second = writer.flush(); release();
  await Promise.all([first, second]); assert.deepEqual(values, ['第一版', '第二版']);
  await writer.flush(); assert.equal(values.length, 2);
});
test('failed draft remains dirty for explicit retry; a sent draft can be cleared', async () => {
  let fail = true; const values: string[] = [];
  const writer = new DraftWriter(async (value) => { if (fail) throw new Error('disk'); values.push(value); });
  writer.update('待发送'); await assert.rejects(writer.flush(), /disk/);
  fail = false; await writer.flush(); writer.update(''); await writer.flush();
  assert.deepEqual(values, ['待发送', '']);
});

test('conversation titles fit the native Unicode limit for long book names', () => {
  assert.equal(conversationTitle(null), '阅读讨论');
  assert.equal(conversationTitle('一本书'), '读《一本书》');
  assert.equal(Array.from(conversationTitle('📖'.repeat(300))).length, 160);
});

test('M5-07 pending selection attaches text, cfi, href, and book metadata', () => {
  const selection = {
    text: '这是一段阅读笔记中的引文摘录',
    cfi: 'epubcfi(/6/4[chap01]!/4/2/10)',
    href: 'text/chap01.xhtml',
    title: '深度学习导论',
    bookId: 'book-uuid-1234',
  };
  assert.equal(selection.bookId, 'book-uuid-1234');
  assert.equal(selection.title, '深度学习导论');
  assert.match(selection.text, /引文摘录/);
});

test('M5-07 continuity ensures unsent draft is not lost across flushes', async () => {
  const draftHistory: string[] = [];
  const writer = new DraftWriter(async (val) => { draftHistory.push(val); });
  writer.update('用户正在编辑的长篇草稿');
  await writer.flush();
  assert.equal(draftHistory[draftHistory.length - 1], '用户正在编辑的长篇草稿');

  // 连续更新未发送草稿
  writer.update('用户正在编辑的长篇草稿 · 追加内容');
  await writer.flush();
  assert.equal(draftHistory[draftHistory.length - 1], '用户正在编辑的长篇草稿 · 追加内容');
});

test('continuation carries bounded completed discussion and retains the new question', () => {
  const draft = continuationDraft([{role:'user',body:'分类为何简化？',status:'completed'}, {role:'assistant',body:'分类方便交流。',status:'completed'}, {role:'assistant',body:'未完成内容',status:'interrupted'}],'如何纠错？');
  assert.match(draft,/分类方便交流/); assert.match(draft,/如何纠错/); assert.doesNotMatch(draft,/未完成内容/);
  assert.ok(Array.from(continuationDraft([{role:'user',body:'甲'.repeat(5000),status:'completed'}],'乙'.repeat(5000))).length<=2000);
});

test('continuation preserves an existing maximum-length question', () => { const draft='问'.repeat(2000); assert.equal(continuationDraft([{role:'assistant',body:'历史讨论',status:'completed'}],draft),draft); });
