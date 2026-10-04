import { ReadingContextService, boundedSelection, boundedText, type ContextSelectionInput, type ContextView } from './reading-context';
import './reader.css';
import './application.css';
import { AssistantPanel } from './assistant/panel';
import { CodexClient } from './codex-client';
import { ReadingAsk, type AskSource, type AskState } from './ask';
import { reflectionRepo, ReflectionTask, discussionMaterial, type ReflectionSource, type ReflectionDraft, type ConfirmedIdea } from './reflection';
import { invoke } from '@tauri-apps/api/core';
import { open as chooseFile } from '@tauri-apps/plugin-dialog';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { listen } from '@tauri-apps/api/event';
import { getCurrent, onOpenUrl } from '@tauri-apps/plugin-deep-link';
import { parseReaderLink, validateReaderLocation, type ReaderLocation, type SourceLocation } from './reader-link';
import { ActivityClock, defaultSettings, notesForDay, type Annotation, type BookRecord, type ReaderSettings, type ReadingPosition, type ReadingSession, type Snapshot, type VaultState, type VaultExport } from './models';
import { createRepository, desktop, readDesktopFile } from './repository';
import { EpubReaderAdapter, inspectBook, validateEpubLocation, type TextSelection } from './epub-reader';
import type { NavItem } from 'epubjs';

const $ = <T extends HTMLElement = HTMLElement>(selector: string): T => {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`Missing UI element: ${selector}`);
  return element;
};
const escape = (value: string) => value.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!);
const now = () => new Date().toISOString();
const repo = createRepository();
class PendingWriteError extends Error {
  constructor(cause: unknown) { super(cause instanceof Error ? cause.message : String(cause)); }
}
let settingsChanges: Promise<unknown> = Promise.resolve();
let data: Snapshot = { books: [], positions: [], annotations: [], sessions: [], settings: { ...defaultSettings }, vault: null, exports: [] };
let adapter: EpubReaderAdapter | null = null;
let currentBook: BookRecord | null = null;
let session: ReadingSession | null = null;
let lastSession: ReadingSession | null = null;
let clock: ActivityClock | null = null;
let screen: ContextView = 'library';
// Actual EPUB selection is separate from the note editor's retained quote.
let readingSelection: ContextSelectionInput | null = null;
let selected: TextSelection | null = null;
let editing: Annotation | null = null;
let originalBody = '';
let pendingPosition: ReadingPosition | null = null;
let positionTimer: ReturnType<typeof setTimeout> | undefined;
let writes: Promise<unknown> = Promise.resolve();
let importing = false;
let opening = false;
let shuttingDown = false;
const linkHistory: string[] = [];
let noteScope: 'today' | 'book' = 'today';
let exporting = false;
let vaultFocus: HTMLElement | null = null;
let ready = false;
let pendingLink: string | null = null;
let linkJobs: Promise<unknown> = Promise.resolve();
let lastLink = '';
let lastLinkAt = 0;
const codex = new CodexClient(() => renderCodex());
const ask = new ReadingAsk(codex, renderAsk);
const reflectionTask = new ReflectionTask(codex);
let reflectionEpoch = 0;
let reflectionSources: ReflectionSource[] = [];
let reflectionDraft: ReflectionDraft | null = null;
let confirmedIdeas: ConfirmedIdea[] = [];
let reflectionSaving = false;
let reflectionAnalyzing = false;
let reflectionSearching = false;
let reflectionScopeKey: string | null = null;
let ideasLoadRevision = 0;
let codexBusy = false;
let codexFocus: HTMLElement | null = null;
const contextService = new ReadingContextService((context) => write(() => repo.publishContext(context)), showError);

function syncReadingContext() {
  if (!ready) return;
  const reader = adapter, book = opening ? null : currentBook;
  const position = book && reader?.position ? { ...reader.position } : null;
  const currentSession = book && session ? { ...session } : null;
  const status = opening ? 'opening' : !book ? 'no_book' : screen === 'reader' && position && currentSession ? 'reading' : 'not_reading';
  const selection = status === 'reading' && readingSelection && readingSelection.href === position?.href ? { ...readingSelection } : null;
  contextService.update({ status, view: screen, foreground: document.hasFocus() && document.visibilityState === 'visible',
    book, position, session: currentSession, selection },
    status === 'reading' && reader && position ? () => reader.extractContext(position, selection) : undefined);
}

$('#app').innerHTML = `
<header class="topbar">
  <button class="text-button back-button" id="back-button">← <span>书架</span></button>
  <div class="topbar-book" id="topbar-book"></div>
  <div class="topbar-actions"><button class="icon-button" id="menu-button" aria-label="阅读选项" hidden>•••</button><button class="text-button layout-toggle" id="layout-toggle" aria-pressed="false" hidden>单栏</button><button class="text-button assistant-toggle" id="assistant-toggle" aria-expanded="true">助手</button></div>
</header>
<div class="operation-status" id="operation-status" role="status" hidden><span id="status-text"></span><button class="text-button" id="retry-save" hidden>重试保存</button><button class="text-button" id="open-pending-link" hidden>打开原文</button><button class="text-button" id="dismiss-status" aria-label="收起提示">×</button></div>
<div class="reader-workspace" id="reader-workspace"><main>
  <section class="screen library-screen active" id="library-screen" aria-label="书架">
    <div class="simple-page">
      <p class="eyebrow">YOUR LIBRARY</p><div class="library-heading"><h1>书架</h1><button class="primary-button" id="import-book">导入 EPUB</button></div>
      <p class="local-caption" id="storage-caption"></p>
      <div id="book-list"></div>
      <div class="empty-library" id="empty-library"><p>把一本书带进来，慢慢读。</p><p class="local-caption">选择或拖入无 DRM 的 EPUB 文件。</p></div>
      <button class="text-button sample-link" id="sample-book">先用示例试读 →</button>
      <button class="text-button vault-link" data-vault-settings>Obsidian 导出</button><button class="text-button vault-link" data-codex-settings>助手连接</button><button class="text-button vault-link" id="library-assistant">开启助手</button><button class="text-button vault-link" id="library-notes">回顾笔记</button>
      <input id="file-input" type="file" accept=".epub,application/epub+zip" hidden />
    </div>
  </section>
  <section class="screen reader-screen" id="reader-screen" aria-label="阅读">
    <div class="book-heading"><p class="eyebrow" id="book-author"></p><h1 id="book-title"></h1><button class="text-button chapter-label" id="chapter-label" aria-label="打开章节目录"></button></div>
    <div id="epub-view" aria-label="EPUB 正文"></div>
    <div class="reading-footer"><div class="page-navigation" id="page-navigation" hidden><button class="text-button" id="previous-page" title="同章上一组（↑）">↑ 上一页</button><span id="page-label"></span><button class="text-button" id="next-page" title="同章下一组（↓）">下一页 ↓</button></div><div class="progress-track"><span id="progress-fill"></span></div><div class="progress-meta"><button class="text-button" id="previous-chapter" title="上一章（←）">← 上一章</button><span id="progress-label"></span><button class="text-button" id="next-chapter" title="下一章（→）">下一章 →</button></div></div>
    <button class="text-button link-return" id="link-return" hidden>← 返回跳转前的位置</button>
  </section>
  <section class="screen session-screen" id="session-screen" aria-label="阅读结束"><div class="session-content"><p class="eyebrow">READING SESSION</p><h1 id="session-title"></h1><p class="chapter-label" id="session-location"></p><div class="session-stats"><span id="session-time"></span><i></i><span id="session-highlights"></span><i></i><span id="session-notes"></span></div><div class="session-actions"><button class="primary-button" id="finish-session">结束</button><button class="text-button reflect-link" id="enter-reflect">回顾今天的想法</button></div></div></section>
  <section class="screen reflect-screen" id="reflect-screen" aria-label="笔记回顾"><div class="reflect-content"><button class="text-button reflect-back" id="reflect-back">← 返回阅读</button><p class="eyebrow" id="reflect-date"></p><h1 id="reflect-title"></h1><div class="review-actions"><button class="text-button" data-vault-settings>Obsidian 导出</button><button class="text-button" id="export-scope">导出这些笔记</button><button class="text-button" id="start-reflection">关联旧笔记</button><button class="text-button" data-codex-settings>助手连接</button></div><div class="notes-list" id="notes-list"></div><section id="reflection-panel" class="reflection-panel" hidden><div class="reflection-heading"><h2>关联自己的想法</h2><button class="text-button" id="close-reflection">收起</button></div><p class="vault-copy">先检索并勾选来源。只有点击分析时，才会将勾选的有限摘录发送给 ${escape(codex.label)}。</p><div class="reflection-search"><input id="reflection-query" maxlength="100" placeholder="检索旧笔记的关键词" aria-label="检索旧笔记"/><select id="reflection-book" aria-label="笔记检索范围"><option value="">所有书籍</option></select><button class="text-button" id="search-reflection">检索</button></div><div class="reflection-scope"><button class="text-button" id="choose-reflection-scope">选择 Vault 检索文件夹</button><button class="text-button" id="clear-reflection-scope">断开检索</button><label><input type="checkbox" id="include-reflection-vault"/>也检索此文件夹</label><p class="vault-copy" id="reflection-scope-path"></p></div><p class="vault-copy" id="reflection-status" role="status"></p><div id="reflection-sources"></div><label class="reflection-label" for="reflection-question">想回顾什么？</label><textarea id="reflection-question" maxlength="1000" placeholder="这些想法有什么联系或矛盾？"></textarea><div class="reflection-actions"><button class="text-button" id="analyze-reflection">分析勾选的来源</button><button class="text-button" id="cancel-reflection" hidden>取消分析</button></div><div id="reflection-result"></div></section><section id="ideas-section" hidden><h2 class="ideas-heading">已确认的想法</h2><div id="ideas-list"></div></section></div></section>
</main></div>
<div class="selection-toolbar" id="selection-toolbar" role="toolbar" aria-label="选中文本操作"><button data-action="highlight">划线</button><button data-action="note">笔记</button><button data-action="ask">提问</button></div>
<div class="selection-popover" id="selection-popover" hidden></div>
<div class="modal-backdrop" id="options-backdrop" hidden><div class="options-menu"><p class="menu-label">阅读设置</p><label class="setting-row">字号 <input id="font-size" type="range" min="16" max="28" step="1"/><output id="font-size-label"></output></label><label class="setting-row">行距 <select id="line-height"><option value="1.6">紧凑</option><option value="1.8">舒适</option><option value="2">宽松</option></select></label><button id="theme-toggle">切换深色阅读</button><button id="book-notes">本书的划线与笔记</button><button data-vault-settings>Obsidian 导出</button><button data-codex-settings>助手连接</button><button id="end-reading">结束本次阅读</button></div></div>
<div class="modal-backdrop" id="toc-backdrop" hidden><nav class="toc-menu" aria-label="章节目录"><p class="menu-label">目录</p><div id="toc-items"></div></nav></div>
<div class="modal-backdrop" id="vault-backdrop" hidden><section class="vault-dialog" role="dialog" aria-modal="true" aria-labelledby="vault-title"><div class="vault-heading"><h2 id="vault-title">Obsidian 导出</h2><button class="text-button" id="close-vault" aria-label="关闭导出设置">×</button></div><p class="vault-copy">选择 Vault 后，新保存的笔记会写入 Reading 文件夹。已有笔记可手动导出。</p><p class="vault-copy">请先在 Obsidian 中打开这个 Vault。外部修改会保留，Reader 更新另存副本。</p><p class="vault-path" id="vault-path"></p><p class="vault-copy" id="vault-summary" role="status"></p><div class="vault-actions"><button class="primary-button" id="choose-vault">选择 Vault</button><button class="text-button" id="export-all">导出已有笔记</button><button class="text-button" id="disconnect-vault">断开连接</button></div><p class="vault-copy vault-result" id="vault-result" role="status"></p></section></div>
<div class="modal-backdrop" id="codex-backdrop" hidden><section class="vault-dialog" role="dialog" aria-modal="true" aria-labelledby="codex-title"><div class="vault-heading"><h2 id="codex-title">助手连接</h2><button class="text-button" id="close-codex" aria-label="关闭助手连接">×</button></div><label class="setting-row">助手 <select id="agent-provider" aria-label="选择助手"><option value="codex">Codex</option><option value="pi">pi agent</option></select></label><p class="vault-copy">使用这台 Mac 上已配置的助手。pi 沿用已有模型与登录配置。连接时不会发送书籍内容。</p><p class="vault-path" id="codex-path"></p><p class="vault-copy" id="codex-summary" role="status"></p><div class="vault-actions"><button class="primary-button" id="connect-codex">连接</button><button class="text-button" id="choose-codex">选择程序</button><button class="text-button" id="disconnect-codex">断开连接</button></div><p class="vault-copy">连接后，可在右侧助手继续讨论，也可选中正文提问。只有发送问题时才提供有限的阅读资料。</p></section></div>
`;

const assistant = new AssistantPanel($('#reader-workspace'), $('#assistant-toggle'), codex,
  () => screen === 'reader' ? currentBook : null,
  (focus) => run(async () => openCodex(focus)),
  async () => { syncReadingContext(); await contextService.flush(); },
  (source) => run(async () => {
    if (!source.anchor || !source.bookId) return;
    guardEditor(); closeContext();
    await openBook(source.bookId,undefined,{bookId:source.bookId,fingerprint:source.bookId,...source.anchor,noteId:''});
  }),
  (source) => run(async () => { await invoke('assistant_open_vault',source); }),
  () => !!data.vault,
  () => { run(async () => { data=await repo.snapshot(); await loadIdeas(); }); },
  () => { run(async () => { data=await repo.snapshot(); if (adapter && currentBook) await adapter.showAnnotations(data.annotations.filter(a=>a.bookId===currentBook!.id)); if (screen==='reflect') renderNotes(noteScope); }); });

function write<T>(task: () => Promise<T>): Promise<T> {
  const operation = writes.then(task);
  writes = operation.catch(() => undefined);
  return operation;
}
function run(task: () => Promise<unknown>) { void task().catch(showError); }
function showError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  $('#status-text').textContent = message;
  $('#operation-status').hidden = false;
  $('#retry-save').hidden = !(error instanceof PendingWriteError);
}
function clearStatus() { $('#operation-status').hidden = true; }
function showStatus(message: string) { $('#status-text').textContent = message; $('#operation-status').hidden = false; $('#retry-save').hidden = true; }
function dirtyEditor() { const input = document.querySelector<HTMLTextAreaElement>('#note-input'); return !!input && input.value !== originalBody && !$('#selection-popover').hidden; }
function guardEditor() { if (dirtyEditor()) throw new Error('笔记还未保存。请先保存，或选择取消编辑。'); if (reflectionSaving) throw new Error('想法正在保存，请稍候。'); if (reflectionDirty()) throw new Error('想法草稿尚未保存。请先确认保存，或放弃草稿。'); }
function closeContext(force = false) {
  ask.dismiss();
  $('#selection-popover').classList.remove('ask-card');
  $('#selection-toolbar').classList.remove('visible');
  if (force || !dirtyEditor()) { $('#selection-popover').hidden = true; selected = null; editing = null; }
}
function show(id: ContextView) {
  if (id !== 'reflect') abandonReflection();
  closeContext(true); readingSelection = null; screen = id;
  for (const name of ['library', 'reader', 'session', 'reflect']) $(`#${name}-screen`).classList.toggle('active', name === id);
  $('#menu-button').hidden = id !== 'reader';
  $('#layout-toggle').hidden = id !== 'reader';
  $('#topbar-book').textContent = id === 'reader' ? currentBook?.title ?? '' : '';
  window.scrollTo({ top: 0 });
  if (id === 'reflect') run(loadIdeas);
  syncReadingContext();
}
function updateSettingsUi() {
  document.body.classList.toggle('dark-mode', data.settings.theme === 'dark');
  $<HTMLInputElement>('#font-size').value = String(data.settings.fontSize);
  $('#font-size-label').textContent = String(data.settings.fontSize);
  $<HTMLSelectElement>('#line-height').value = String(data.settings.lineHeight);
  $('#theme-toggle').textContent = data.settings.theme === 'dark' ? '切换浅色阅读' : '切换深色阅读';
  updateLayoutUi();
}
function updateLayoutUi() {
  const double = data.settings.columns === 'double', actual = adapter?.layoutMode === 'double';
  const toggle = $<HTMLButtonElement>('#layout-toggle');
  toggle.textContent = double ? '双栏' : '单栏';
  toggle.setAttribute('aria-pressed', String(double));
  toggle.title = double ? (actual ? '切换为单栏阅读' : '已选择双栏，正文空间不足时暂用单栏；点击改为单栏') : '切换为双栏阅读';
  toggle.setAttribute('aria-label', toggle.title);
  $('#page-navigation').hidden = !actual;
  const pages = adapter?.pages;
  $('#page-label').textContent = pages ? `${pages.first}${pages.last > pages.first ? `–${pages.last}` : ''} / ${pages.total} 页` : '';
  $<HTMLButtonElement>('#previous-page').disabled = !pages || pages.first <= 1;
  $<HTMLButtonElement>('#next-page').disabled = !pages || pages.last >= pages.total;
}
function renderLibrary() {
  $('#empty-library').hidden = data.books.length > 0;
  $('#storage-caption').textContent = desktop ? '保存在这台 Mac 上。可拖入 EPUB。' : '浏览器预览 · 书籍保存在此浏览器中，与桌面版分开。';
  const sorted = [...data.books].sort((a, b) => {
    if (a.id === data.settings.lastBookId) return -1;
    if (b.id === data.settings.lastBookId) return 1;
    return b.importedAt.localeCompare(a.importedAt);
  });
  $('#book-list').innerHTML = sorted.map((book) => {
    const position = data.positions.find((p) => p.bookId === book.id);
    const progress = position?.percent == null ? '' : ` · ${Math.round(position.percent * 100)}%`;
    const cover = book.cover ? `<img class="book-cover" src="${escape(book.cover)}" alt="" />` : `<span class="book-cover">${escape(Array.from(book.title)[0] || '书')}</span>`;
    return `<button class="book-row" data-book-id="${book.id}">${cover}<span><strong>${escape(book.title)}</strong><small>${escape(book.author)}${position ? ` · ${escape(position.chapterLabel)}${progress}` : ' · 尚未阅读'}</small></span><span class="row-arrow">→</span></button>`;
  }).join('');
}
function updatePosition(position: ReadingPosition) {
  if (ask.state && (selected?.href !== position.href)) closeContext();
  if (readingSelection && readingSelection.href !== position.href) readingSelection = null;
  pendingPosition = position;
  data.positions = [...data.positions.filter((p) => p.bookId !== position.bookId), position];
  $('#chapter-label').textContent = `${position.chapterLabel} ↓`;
  $('#progress-label').textContent = position.percent == null ? position.chapterLabel : `${Math.round(position.percent * 100)}%`;
  $('#progress-fill').style.width = `${(position.percent ?? 0) * 100}%`;
  if (session && session.bookId === position.bookId) {
    if (!session.startPosition) {
      session.startPosition = { ...position };
      session.startCfi = position.cfi;
    }
    session.endCfi = position.cfi;
    session.endPosition = { ...position };
  }
  clearTimeout(positionTimer);
  positionTimer = setTimeout(() => run(flushPosition), 300);
  syncReadingContext();
}
async function flushPosition() {
  clearTimeout(positionTimer);
  const position = pendingPosition;
  if (!position) return;
  try { await write(() => repo.savePosition(position)); }
  catch (error) { throw new PendingWriteError(error); }
  if (pendingPosition === position) pendingPosition = null;
}
function activity() { clock?.activity(performance.now()); }
async function heartbeat() {
  if (!session || !clock) return;
  clock.tick(performance.now());
  session.activeSeconds = Math.round(clock.seconds);
  session.updatedAt = now();
  const copy = { ...session };
  try { await write(() => repo.saveSession(copy)); }
  catch (error) { throw new PendingWriteError(error); }
  data.sessions = [...data.sessions.filter((s) => s.id !== copy.id), copy];
  syncReadingContext();
}
async function finishCurrentSession() {
  await flushPosition();
  if (!session) return;
  await heartbeat();
  const copy = { ...session, endedAt: now(), updatedAt: now() };
  await write(() => repo.saveSession(copy));
  data.sessions = [...data.sessions.filter((s) => s.id !== copy.id), copy];
  lastSession = copy; session = null; clock = null; readingSelection = null;
  syncReadingContext();
}
async function openBook(id: string, target?: Annotation, location?: ReaderLocation, deadline?: number) {
  guardEditor();
  if (opening) throw new Error('书籍正在打开，请稍后重试。');
  abandonReflection(); closeContext(); await assistant.flush(); opening = true; readingSelection = null; syncReadingContext();
  let replacing = false;
  try {
    const nextBook = data.books.find((b) => b.id === id);
    if (!nextBook) throw new Error('书籍记录不存在，请重新导入。');
    const bytes = await repo.loadBook(id);
    if (location) {
      validateReaderLocation(location);
      if (nextBook.fingerprint !== location.fingerprint) throw new Error('书籍文件指纹不匹配。');
      await validateEpubLocation(bytes, location.cfi, location.href);
    }
    guardEditor();
    if (shuttingDown || (deadline !== undefined && Date.now() > deadline)) throw new Error('Reader 导航请求已过期。');
    $('#vault-backdrop').hidden = true; $('#codex-backdrop').hidden = true; $('#options-backdrop').hidden = true; $('#toc-backdrop').hidden = true;
    await finishCurrentSession();
    replacing = true;
    adapter?.destroy(); adapter = null;
    currentBook = nextBook;
    $('#book-title').textContent = currentBook.title;
    $('#book-author').textContent = currentBook.author;
    $('#chapter-label').textContent = '正在打开…';
    $('#progress-label').textContent = ''; $('#progress-fill').style.width = '0%';
    linkHistory.length = 0; $('#link-return').hidden = true;
    show('reader');
    const reader = new EpubReaderAdapter($('#epub-view'), currentBook, {
      selected(selection) {
        if (ask.state && selected?.cfi === selection.cfi && selected.href === selection.href && selected.text === selection.text) return;
        if (readingSelection?.cfi !== selection.cfi || readingSelection.text !== selection.text || readingSelection.href !== selection.href) {
          readingSelection = { cfi: selection.cfi, href: selection.href, text: selection.text }; syncReadingContext();
        }
        if (!dirtyEditor()) { selected = selection; showToolbar(selection); } activity();
      },
      selectionCleared() { if (readingSelection) { readingSelection = null; syncReadingContext(); } },
      relocated(position) { updatePosition(position); },
      activity, continued() { closeContext(); }, escape() { closeContext(); }, keydown: readingKeydown, layoutChanged: updateLayoutUi,
      annotationClicked(annotation, x, y) { openAnnotationEditor(annotation, x, y); },
      linkOrigin(cfi) { linkHistory.push(cfi); $('#link-return').hidden = false; },
      error: showError,
    });
    adapter = reader;
    await reader.open(bytes, data.settings, data.positions.find((p) => p.bookId === id));
    await reader.showAnnotations(data.annotations.filter((a) => a.bookId === id));
    if (target) await reader.openAnnotation(target);
    else if (location) await reader.displayLocation(location.cfi, location.href);
    const timestamp = now();
    const firstPosition = reader.position ? { ...reader.position } : null;
    session = { id: crypto.randomUUID(), bookId: id, startedAt: timestamp, endedAt: null, activeSeconds: 0, updatedAt: timestamp,
      startCfi: firstPosition?.cfi ?? '', endCfi: firstPosition?.cfi ?? '', startPosition: firstPosition, endPosition: firstPosition ? { ...firstPosition } : null };
    clock = new ActivityClock(performance.now());
    clock.foreground(document.hasFocus() && document.visibilityState === 'visible', performance.now());
    await heartbeat();
    data.settings.lastBookId = id;
    await write(() => repo.saveSettings({ ...data.settings }));
    renderToc(reader.toc);
    renderLibrary();
  } catch (error) {
    if (replacing) { adapter?.destroy(); adapter = null; currentBook = null; show('library'); }
    throw error;
  } finally { opening = false; syncReadingContext(); }
}

type McpLocation = SourceLocation;
interface McpRequest {
  id: string; action: 'capture_context' | 'surrounding_text' | 'open_location'; deadline: number;
  arguments: { location?: McpLocation; instanceId?: string; revision?: number } & Partial<McpLocation>;
}
async function handleMcpRequest(request: McpRequest) {
  let result: unknown = null, error: string | null = null;
  try {
    if (!ready || shuttingDown || Date.now() > request.deadline) throw new Error('Reader 请求已过期或界面尚未就绪。');
    if (request.action === 'capture_context') {
      readingSelection = screen === 'reader' ? adapter?.currentSelection() ?? null : null;
      syncReadingContext(); result = await contextService.capture();
    } else if (request.action === 'surrounding_text') {
      const { location, instanceId, revision } = request.arguments;
      const snapshot = contextService.snapshot(), context = snapshot.current;
      if (!context || context.instanceId !== instanceId || context.revision !== revision || context.status !== 'reading'
          || !location || context.book?.id !== location.bookId || context.book.fingerprint !== location.fingerprint
          || context.location?.href !== location.href || !adapter?.position) throw new Error('阅读位置已变化，请重新获取上下文。');
      const reader = adapter;
      const text = await reader.extractContext({ ...reader.position!, cfi: location.cfi, href: location.href }, null);
      const latest = contextService.snapshot().current;
      if (reader !== adapter || latest?.instanceId !== instanceId || latest.revision !== revision) throw new Error('阅读位置已变化，本次正文结果已丢弃。');
      result = text;
    } else if (request.action === 'open_location') {
      guardEditor();
      const location = request.arguments as McpLocation;
      validateReaderLocation(location);
      const book = data.books.find((book) => book.id === location.bookId && book.fingerprint === location.fingerprint);
      if (!book) throw new Error('指定版本的 EPUB 尚未导入 Reader。');
      await openBook(book.id, undefined, { ...location, noteId: '' }, request.deadline);
      result = { opened: true, requested: location, context: await contextService.capture() };
    } else { throw new Error('未知的 Reader 请求。'); }
  } catch (cause) { error = cause instanceof Error ? cause.message : String(cause); }
  try { await invoke('complete_mcp_request', { id: request.id, result: error ? null : result, error }); }
  catch (cause) { console.error('Reader MCP response unavailable', cause); }
}

function renderToc(items: NavItem[]) {
  const render = (entries: NavItem[], level = 0): string => entries.map((item) => `<button class="text-button toc-item" style="padding-left:${12 + level * 14}px" data-href="${escape(item.href)}">${escape(item.label.trim())}</button>${render(item.subitems ?? [], level + 1)}`).join('');
  $('#toc-items').innerHTML = render(items);
}
async function importBytes(bytes: ArrayBuffer, fileName: string, sourcePath?: string) {
  guardEditor();
  showStatus('正在导入 EPUB…');
  const metadata = await inspectBook(bytes, fileName);
  const existing = data.books.find((book) => book.id === metadata.id);
  const record = existing ?? metadata;
  await write(() => repo.importBook(record, bytes, sourcePath));
  if (!existing) data.books.unshift(record);
  clearStatus(); renderLibrary();
  if (pendingLink && parseReaderLink(pendingLink).bookId === record.id) await openReaderLink(pendingLink);
  else await openBook(record.id);
}
async function importPath(path: string) {
  if (importing) return;
  importing = true;
  try { await importBytes(await readDesktopFile(path), path.split(/[\\/]/).pop() ?? 'Book.epub', path); }
  finally { importing = false; }
}
async function importFile(file: File) {
  if (importing) return;
  if (!file.name.toLowerCase().endsWith('.epub')) throw new Error('请选择 EPUB 文件。');
  importing = true;
  try { await importBytes(await file.arrayBuffer(), file.name); }
  finally { importing = false; }
}
async function selectFile() {
  guardEditor();
  if (desktop) {
    const path = await chooseFile({ multiple: false, directory: false, filters: [{ name: 'EPUB 电子书', extensions: ['epub'] }] });
    if (typeof path === 'string') await importPath(path);
  } else $<HTMLInputElement>('#file-input').click();
}
function showToolbar(selection: TextSelection) {
  ask.dismiss(); $('#selection-popover').classList.remove('ask-card');
  if (dirtyEditor()) return;
  $('#selection-popover').hidden = true;
  const toolbar = $('#selection-toolbar');
  toolbar.style.left = `${Math.max(100, Math.min(window.innerWidth - 100, selection.x))}px`;
  toolbar.style.top = `${Math.max(100, Math.min(window.innerHeight - 20, selection.y - 10))}px`;
  toolbar.classList.add('visible');
}
function positionPopover(x: number, y: number) {
  const popover = $('#selection-popover');
  popover.style.left = `${Math.max(16, Math.min(window.innerWidth - 406, x - 195))}px`;
  popover.style.top = `${Math.max(80, Math.min(window.innerHeight - 280, y + 15))}px`;
  popover.hidden = false;
  $('#selection-toolbar').classList.remove('visible');
}
function openAsk(selection: TextSelection) {
  guardEditor();
  const reader = adapter, book = currentBook;
  if (!reader?.position || !book || screen !== 'reader') throw new Error('请先打开一本书并选中正文。');
  const anchor = { ...selection }, position = { ...reader.position };
  const valid = () => !opening && !shuttingDown && screen === 'reader' && adapter === reader
    && currentBook?.id === book.id && currentBook.fingerprint === book.fingerprint && reader.position?.href === anchor.href;
  selected = anchor;
  ask.open(anchor.text, async () => {
    if (!valid()) throw new Error('阅读位置已变化，请重新选中正文。');
    const base = contextService.snapshot().current;
    if (!base?.book || base.book.id !== book.id || base.book.fingerprint !== book.fingerprint || base.status !== 'reading' || !base.location || base.location.href !== anchor.href) throw new Error('阅读上下文尚未就绪。');
    const surrounding = await reader.extractContext(position, anchor);
    if (!valid()) throw new Error('阅读位置已变化，请重新选中正文。');
    return { instanceId: base.instanceId, revision: base.revision, capturedAt: now(), book: { ...base.book },
      location: { ...base.location, cfi: position.cfi, href: anchor.href }, selection: boundedSelection(anchor), surrounding };
  }, valid);
  positionPopover(anchor.x, anchor.y);
  $<HTMLTextAreaElement>('#ask-question').focus();
}
function renderAsk(state: AskState) {
  const popover = $('#selection-popover'); popover.classList.add('ask-card');
  const editingQuestion = state.phase === 'draft' || state.phase === 'error';
  const quote = boundedText(state.quote, 180);
  const sources = state.answer?.sources ?? [];
  popover.innerHTML = `<div class="ask-heading"><span>问这段原文</span><button class="text-button" id="close-ask" aria-label="收起提问">×</button></div>
    <p class="selected-quote">${escape(quote)}${state.quote.length > quote.length ? '…' : ''}</p>
    ${editingQuestion ? `<textarea id="ask-question" aria-label="阅读问题" maxlength="1000" placeholder="这段话是什么意思？">${escape(state.question)}</textarea><p class="ask-caption">点击提问会将选区和有限的附近正文发送给 ${escape(codex.label)}。</p>` : `<p class="ask-question-label">${escape(state.question)}</p>`}
    <div class="ask-response" role="status" aria-live="polite">${state.answer ? `<p class="response-copy">${escape(state.answer.answer)}</p>` : state.message ? `<p class="${state.phase === 'error' ? 'editor-error' : 'ask-caption'}">${escape(state.message)}</p>` : ''}</div>
    ${state.answer ? `<div class="ask-sources" aria-label="回答的原文来源">${sources.map((source, i) => `<button class="text-button" data-ask-source="${i}" title="${escape(source.quote)}">${source.id === 'selection' ? '选区' : source.id === 'before' ? '上文' : '下文'} · ${escape(source.chapterLabel || '原文')} →</button>`).join('')}</div>` : ''}
    ${state.truncated ? '<p class="ask-caption">长选区与附近正文按长度截取。</p>' : ''}
    <div class="popover-footer">${editingQuestion ? `<button class="text-button" id="ask-connect" ${codex.status.phase === 'ready' ? 'hidden' : ''}>连接 Codex</button><span>⌘ Enter</span><button class="text-button" id="send-ask">${state.phase === 'error' ? '重试' : '提问'}</button>` : `<span></span><button class="text-button" id="dismiss-ask">${state.phase === 'answer' ? '继续阅读' : '取消'}</button>`}</div>`;
  $('#close-ask').addEventListener('click', () => closeContext());
  document.querySelector('#dismiss-ask')?.addEventListener('click', () => closeContext());
  document.querySelector('#ask-connect')?.addEventListener('click', () => $<HTMLButtonElement>('[data-codex-settings]').click());
  const submit = () => { void ask.submit($<HTMLTextAreaElement>('#ask-question').value); };
  document.querySelector('#send-ask')?.addEventListener('click', submit);
  document.querySelector('#ask-question')?.addEventListener('keydown', (event) => {
    const key = event as KeyboardEvent;
    if ((key.metaKey || key.ctrlKey) && key.key === 'Enter') { key.preventDefault(); submit(); }
  });
  for (const button of document.querySelectorAll<HTMLButtonElement>('[data-ask-source]')) button.addEventListener('click', () => run(() => openAskSource(sources[Number(button.dataset.askSource)])));
  if (editingQuestion) $<HTMLTextAreaElement>('#ask-question').focus(); else $('#close-ask').focus();
  requestAnimationFrame(() => {
    if (ask.state !== state || popover.hidden) return;
    const height = popover.getBoundingClientRect().height;
    popover.style.top = `${Math.max(72, Math.min(parseFloat(popover.style.top) || 100, window.innerHeight - height - 16))}px`;
  });
}
async function openAskSource(source: AskSource) {
  guardEditor(); validateReaderLocation(source);
  const reader = adapter;
  if (!reader || currentBook?.id !== source.bookId || currentBook.fingerprint !== source.fingerprint) throw new Error('原文书籍版本已变化，请重新提问。');
  const origin = reader.position?.cfi; closeContext();
  await reader.displayLocation(source.cfi, source.href);
  if (origin && origin !== source.cfi) { linkHistory.push(origin); $('#link-return').hidden = false; }
}

function noteEditor(selection: TextSelection, annotation: Annotation | null = null) {
  guardEditor(); ask.dismiss(); $('#selection-popover').classList.remove('ask-card'); selected = selection; editing = annotation;
  originalBody = annotation?.body ?? '';
  $('#selection-popover').innerHTML = `<p class="selected-quote">${escape(selection.text)}</p><textarea id="note-input" aria-label="笔记正文" placeholder="写下此刻的想法…">${escape(originalBody)}</textarea><p id="note-error" class="editor-error" hidden></p><div class="popover-footer"><button class="text-button" id="cancel-note">取消</button>${annotation ? '<button class="text-button" id="delete-note">删除笔记</button>' : ''}<span>⌘ Enter</span><button class="text-button" id="save-note">保存</button></div>`;
  positionPopover(selection.x, selection.y);
  $<HTMLTextAreaElement>('#note-input').focus();
  $('#save-note').addEventListener('click', () => run(saveNote));
  $('#cancel-note').addEventListener('click', () => { closeContext(true); adapter?.clearSelection(); });
  document.querySelector('#delete-note')?.addEventListener('click', () => run(async () => { if (annotation) await removeAnnotation(annotation); }));
  $('#note-input').addEventListener('keydown', (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') { event.preventDefault(); run(saveNote); }
  });
}
function openAnnotationEditor(annotation: Annotation, x: number, y: number) {
  if (dirtyEditor()) return;
  ask.dismiss(); $('#selection-popover').classList.remove('ask-card');
  const selection = { cfi: annotation.cfi, href: annotation.href, text: annotation.quote, x, y };
  if (annotation.kind === 'note') noteEditor(selection, annotation);
  else {
    selected = selection;
    $('#selection-popover').innerHTML = `<p class="selected-quote">${escape(annotation.quote)}</p><div class="popover-footer"><button id="delete-highlight">删除划线</button><button id="annotate-highlight">添加笔记</button></div>`;
    positionPopover(x, y);
    $('#delete-highlight').addEventListener('click', () => run(() => removeAnnotation(annotation)));
    $('#annotate-highlight').addEventListener('click', () => noteEditor(selection));
  }
}
async function saveAnnotation(kind: Annotation['kind'], body = '', existing: Annotation | null = null) {
  if (!selected || !currentBook || !session) throw new Error('请先在阅读页选中正文。');
  const duplicate = existing ?? data.annotations.find((a) => a.bookId === currentBook!.id && a.cfi === selected!.cfi && a.kind === kind);
  const timestamp = now();
  const annotation: Annotation = { id: duplicate?.id ?? crypto.randomUUID(), bookId: currentBook.id, fingerprint: currentBook.fingerprint,
    cfi: selected.cfi, href: selected.href, quote: selected.text, kind, body, sessionId: duplicate?.sessionId ?? session.id,
    createdAt: duplicate?.createdAt ?? timestamp, updatedAt: timestamp, createdBy: 'human',
    chapterLabel: duplicate?.chapterLabel || chapterLabel(selected.href) };
  await write(() => repo.saveAnnotation(annotation));
  data.annotations = [...data.annotations.filter((a) => a.id !== annotation.id), annotation];
  closeContext(true); adapter?.clearSelection();
  await adapter?.showAnnotations(data.annotations.filter((a) => a.bookId === currentBook?.id));
  if (kind === 'note' && data.vault) {
    try { await exportOne(annotation.id, true); }
    catch (error) { showStatus(`笔记已保存在 Reader。${error instanceof Error ? error.message : String(error)}`); }
  }
}
async function saveNote() {
  const body = $<HTMLTextAreaElement>('#note-input').value.trim();
  if (!body) { $('#note-error').textContent = '请先写下笔记。'; $('#note-error').hidden = false; return; }
  $<HTMLButtonElement>('#save-note').disabled = true;
  try { await saveAnnotation('note', body, editing); }
  catch (error) { $('#note-error').textContent = `未保存：${error instanceof Error ? error.message : String(error)}。内容仍保留，可重试。`; $('#note-error').hidden = false; }
  finally { const button = document.querySelector<HTMLButtonElement>('#save-note'); if (button) button.disabled = false; }
}
async function removeAnnotation(annotation: Annotation) {
  await write(() => repo.deleteAnnotation(annotation.id));
  data.annotations = data.annotations.filter((a) => a.id !== annotation.id);
  data.exports = data.exports.filter((e) => e.noteId !== annotation.id);
  closeContext(true);
  await adapter?.showAnnotations(data.annotations.filter((a) => a.bookId === currentBook?.id));
}
function renderNotes(scope: 'today' | 'book', reveal = true) {
  if (reveal) { guardEditor(); abandonReflection(); }
  noteScope = scope;
  $<HTMLButtonElement>('#export-scope').disabled = !desktop || !data.vault || exporting;
  $('#reflect-date').textContent = scope === 'today' ? new Date().toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric' }) : currentBook?.title ?? '';
  $('#reflect-title').textContent = scope === 'today' ? '今天你留下的想法' : '划线与笔记';
  const items = scope === 'today' ? notesForDay(data.annotations, new Date()) : data.annotations.filter((a) => a.bookId === currentBook?.id).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  $('#notes-list').innerHTML = items.length ? items.map((note) => {
    const book = data.books.find((b) => b.id === note.bookId);
    const time = new Date(note.createdAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
    const unresolved = adapter?.unresolved.has(note.id);
    return `<article class="note-entry"><time>${escape(time)} · ${escape(book?.title ?? '')}</time><button class="text-button note-jump" data-note-id="${note.id}">${escape(note.kind === 'note' ? note.body : note.quote)}</button>${note.kind === 'note' ? `<blockquote>${escape(note.quote)}</blockquote>` : ''}<div class="note-links"><button class="text-button" data-edit-note="${note.id}">${note.kind === 'note' ? '编辑' : '查看划线'}</button><button class="text-button" data-discuss-note="${note.id}">在助手中讨论</button>${unresolved ? '<span>原文位置待恢复</span>' : '<span>点击内容回到原文</span>'}</div>${note.kind === 'note' ? exportActions(note.id) : ''}</article>`;
  }).join('') : '<p class="empty-notes">这里还没有笔记。阅读时留下的想法会出现在这里。</p>';
  renderIdeas();
  if (reveal) { show('reflect'); run(loadIdeas); }
}
function chapterLabel(href: string): string {
  const normalized = (value: string) => value.split('#')[0].replace(/^\.\//, '');
  const find = (items: NavItem[]): string | undefined => {
    for (const item of items) {
      if (normalized(item.href) === normalized(href)) return item.label.trim();
      const child = find(item.subitems ?? []); if (child) return child;
    }
  };
  return find(adapter?.toc ?? []) ?? (adapter?.position?.href === href ? adapter.position.chapterLabel : href);
}
function exportActions(id: string) {
  const record = data.exports.find((e) => e.noteId === id);
  if (!desktop || !data.vault) return '';
  const labels = { pending: '待导出', synced: '已导出', failed: '导出未完成', conflict: '已保留双方版本' };
  const label = record ? labels[record.status] : '待导出';
  return `<div class="note-export"><span>${label}</span><button class="text-button" data-export-note="${id}" ${exporting ? 'disabled' : ''}>${record?.status === 'failed' ? '重试导出' : '导出'}</button>${record?.contentHash ? `<button class="text-button" data-open-export="${id}">在 Obsidian 中打开</button>` : ''}${record?.conflictPath ? `<button class="text-button" data-open-copy="${id}">打开 Reader 副本</button>` : ''}</div>${record?.message ? `<p class="export-message">${escape(record.message)}</p>` : ''}`;
}
function renderVault() {
  $('#vault-path').textContent = data.vault?.path ?? (desktop ? '尚未选择 Vault' : '请在 Mac 应用中使用 Vault 导出。');
  const count = (status: VaultExport['status']) => data.exports.filter((e) => e.status === status).length;
  $('#vault-summary').textContent = data.vault ? `${count('synced')} 条已导出 · ${count('pending')} 条待导出 · ${count('conflict')} 条保留副本 · ${count('failed')} 条未完成` : '';
  $('#choose-vault').textContent = data.vault ? '更换 Vault' : '选择 Vault';
  $<HTMLButtonElement>('#choose-vault').disabled = !desktop || exporting;
  $<HTMLButtonElement>('#disconnect-vault').disabled = !data.vault || exporting;
  $<HTMLButtonElement>('#export-all').disabled = !data.vault || exporting || !data.annotations.some((a) => a.kind === 'note');
  if (screen === 'reflect') renderNotes(noteScope, false);
}
function applyVault(state: VaultState) { data.vault = state.config; data.exports = state.exports; renderVault(); assistant.refreshVault(); if (screen === 'reflect') { renderIdeas(); run(updateReflectionScope); } }
async function exportOne(id: string, quiet = false) {
  const record = await write(() => repo.exportNote(id));
  data.exports = [...data.exports.filter((e) => e.noteId !== id), record];
  renderVault();
  if (!quiet) $('#vault-result').textContent = record.status === 'synced' ? '笔记已导出。' : record.message ?? '导出未完成，可重试。';
  if (record.status === 'failed' && quiet) showStatus('笔记已保存在 Reader，Vault 导出未完成。可在笔记回顾中重试。');
  return record;
}
async function exportBatch(items: Annotation[]) {
  if (exporting || !data.vault) return;
  exporting = true; renderVault();
  let done = 0, failed = 0, conflicts = 0;
  try {
    for (const item of items.filter((a) => a.kind === 'note')) {
      try { const record = await exportOne(item.id); if (record.status === 'synced') done++; else if (record.status === 'conflict') conflicts++; else failed++; }
      catch { failed++; }
    }
  } finally { exporting = false; renderVault(); }
  const result = `${done} 条已导出，${conflicts} 条保留副本，${failed} 条未完成。`;
  $('#vault-result').textContent = result;
  if ($('#vault-backdrop').hidden) showStatus(result);
}
function showVault() {
  guardEditor(); stopReflectionAnalysis(); $('#options-backdrop').hidden = true;
  vaultFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  $('#vault-result').textContent = ''; renderVault(); $('#vault-backdrop').hidden = false; $('#close-vault').focus();
}
async function openReaderLink(raw: string) {
  const location = parseReaderLink(raw);
  pendingLink = raw; $('#open-pending-link').hidden = false;
  guardEditor();
  const book = data.books.find((b) => b.id === location.bookId && b.fingerprint === location.fingerprint);
  if (!book) { await returnLibrary(); throw new Error('这条笔记的 EPUB 尚未导入。请导入同一文件，然后重新打开原文。'); }
  const note = data.annotations.find((a) => a.id === location.noteId && a.bookId === book.id && a.fingerprint === location.fingerprint);
  await openBook(book.id, note, location);
  if (pendingLink === raw) { pendingLink = null; $('#open-pending-link').hidden = true; clearStatus(); }
}
function receiveReaderLink(raw: string) {
  if (!ready) { pendingLink = raw; return; }
  if (lastLink === raw && Date.now() - lastLinkAt < 1200) return;
  lastLink = raw; lastLinkAt = Date.now();
  linkJobs = linkJobs.then(() => openReaderLink(raw)).catch(showError);
}
async function endReading() {
  guardEditor(); $('#options-backdrop').hidden = true;
  await finishCurrentSession();
  const position = data.positions.find((p) => p.bookId === currentBook?.id);
  $('#session-title').textContent = currentBook?.title ?? '';
  $('#session-location').textContent = position ? `${position.chapterLabel}${position.percent == null ? '' : ` · ${Math.round(position.percent * 100)}%`}` : '';
  const seconds = lastSession?.activeSeconds ?? 0;
  $('#session-time').textContent = seconds < 60 ? `${seconds} 秒` : `${Math.floor(seconds / 60)} min`;
  const notes = data.annotations.filter((a) => a.sessionId === lastSession?.id);
  $('#session-highlights').textContent = `${notes.filter((a) => a.kind === 'highlight').length} 处划线`;
  $('#session-notes').textContent = `${notes.filter((a) => a.kind === 'note').length} 条笔记`;
  show('session');
}
async function returnLibrary() {
  guardEditor(); abandonReflection(); await assistant.flush(); await finishCurrentSession(); adapter?.destroy(); adapter = null; currentBook = null;
  renderLibrary(); show('library');
}
async function changeSettings(patch: Partial<ReaderSettings>) {
  const operation = settingsChanges.then(async () => {
    const settings = { ...data.settings, ...patch };
    await write(() => repo.saveSettings(settings));
    data.settings = settings; updateSettingsUi();
    await adapter?.setSettings(settings);
    await adapter?.showAnnotations(data.annotations.filter((a) => a.bookId === currentBook?.id));
  });
  settingsChanges = operation.catch(() => undefined);
  await operation;
}

function reflectionDirty() {
  if (!reflectionDraft || $('#reflection-panel').hidden) return false;
  const title = document.querySelector<HTMLInputElement>('#idea-title'), body = document.querySelector<HTMLTextAreaElement>('#idea-body');
  return !!title && !!body && (title.value !== reflectionDraft.title || body.value !== reflectionDraft.body);
}
function setReflectionStatus(message: string) { $('#reflection-status').textContent = message; }
function stopReflectionAnalysis() { reflectionEpoch += 1; reflectionTask.cancel(); reflectionAnalyzing = false; reflectionSearching = false; updateReflectionButtons(); }
function abandonReflection() {
  stopReflectionAnalysis(); reflectionSearching = false; reflectionDraft = null; reflectionSources = [];
  $('#reflection-panel').hidden = true; $('#reflection-result').innerHTML = ''; $('#reflection-sources').innerHTML = '';
}
function updateReflectionButtons() {
  const busy = reflectionAnalyzing || reflectionSearching || reflectionSaving;
  $<HTMLButtonElement>('#search-reflection').disabled = !desktop || busy;
  $<HTMLButtonElement>('#analyze-reflection').disabled = !desktop || busy || !reflectionSources.length;
  $<HTMLButtonElement>('#choose-reflection-scope').disabled = !desktop || busy || !data.vault;
  $<HTMLButtonElement>('#clear-reflection-scope').disabled = !desktop || busy;
  $('#cancel-reflection').hidden = !reflectionAnalyzing && !reflectionSearching;
  for (const input of document.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>('#reflection-panel input, #reflection-panel select, #reflection-panel textarea')) {
    if (input.id !== 'discussion-material') input.disabled = busy;
  }
  $<HTMLInputElement>('#include-reflection-vault').disabled = busy || !reflectionScopeKey || !desktop;
  const exportChoice = document.querySelector<HTMLInputElement>('#export-confirmed-idea'); if (exportChoice) exportChoice.disabled = busy || !data.vault;
  const save = document.querySelector<HTMLButtonElement>('#save-idea'); if (save) save.disabled = reflectionSaving;
}
async function updateReflectionScope() {
  const scope = await reflectionRepo.scope();
  const key = scope ? `${scope.vaultPath}\n${scope.path}` : null;
  if (key !== reflectionScopeKey) {
    stopReflectionAnalysis(); reflectionDraft = null; reflectionSources = [];
    $('#reflection-result').innerHTML = ''; $('#reflection-sources').innerHTML = '';
  }
  reflectionScopeKey = key;
  $('#reflection-scope-path').textContent = scope ? `只检索：${scope.path}` : '尚未选择 Vault 检索范围。';
  if (!scope) $<HTMLInputElement>('#include-reflection-vault').checked = false;
  updateReflectionButtons();
}
function renderReflectionSources() {
  $('#reflection-sources').innerHTML = reflectionSources.length ? reflectionSources.map((source, index) => `<article class="reflection-source"><label><input type="checkbox" data-reflection-source="${index}"/><span>${escape(source.title)}<small>${source.kind === 'reader' ? '人工阅读笔记' : `Vault 文件 · 第 ${source.startLine}–${source.endLine} 行`}${source.truncated ? ' · 有限摘录' : ''}</small></span></label><blockquote>${escape(source.text)}</blockquote></article>`).join('') : '<p class="empty-notes">没有匹配来源。请换个关键词或范围，不会生成虚构的旧想法。</p>';
}
async function searchReflection() {
  guardEditor(); stopReflectionAnalysis(); reflectionDraft = null; $('#reflection-result').innerHTML = '';
  const epoch = ++reflectionEpoch; reflectionSearching = true; updateReflectionButtons(); setReflectionStatus('正在本机检索…');
  const query = $<HTMLInputElement>('#reflection-query').value, bookId = $<HTMLSelectElement>('#reflection-book').value || null;
  try {
    const result = await reflectionRepo.search(query, bookId, $<HTMLInputElement>('#include-reflection-vault').checked);
    if (epoch !== reflectionEpoch || screen !== 'reflect' || $('#reflection-panel').hidden) return;
    reflectionSources = result.sources; renderReflectionSources(); setReflectionStatus(result.message);
  } catch (error) { if (epoch === reflectionEpoch) setReflectionStatus(error instanceof Error ? error.message : String(error)); }
  finally { if (epoch === reflectionEpoch) { reflectionSearching = false; updateReflectionButtons(); } }
}
async function analyzeReflection() {
  guardEditor(); if (reflectionAnalyzing || reflectionSearching) return;
  const selectedSources = [...document.querySelectorAll<HTMLInputElement>('[data-reflection-source]:checked')].map((input)=>reflectionSources[Number(input.dataset.reflectionSource)]);
  const question = $<HTMLTextAreaElement>('#reflection-question').value.trim() || '这些想法有什么联系或矛盾？';
  const epoch = ++reflectionEpoch; reflectionAnalyzing = true; reflectionDraft = null; $('#reflection-result').innerHTML = ''; updateReflectionButtons(); setReflectionStatus('正在核对来源并分析…');
  const valid = () => epoch === reflectionEpoch && screen === 'reflect' && !$('#reflection-panel').hidden && !shuttingDown && !opening;
  try {
    const draft = await reflectionTask.analyze(question, selectedSources, valid);
    if (!draft || !valid()) return;
    reflectionDraft = draft; renderReflectionDraft(); setReflectionStatus(draft.body ? '这是可编辑提案。只有确认保存后才会写入 Reader。' : '资料不足，未生成想法提案。');
  } catch (error) { if (valid()) setReflectionStatus(error instanceof Error ? error.message : String(error)); }
  finally { if (epoch === reflectionEpoch) { reflectionAnalyzing = false; updateReflectionButtons(); } }
}
function sourceButtons(sources: ReflectionDraft['sources'], prefix: string) {
  return sources.map(({source,quote}, index)=>`<div class="reflection-citation"><button class="text-button" data-${prefix}-source="${index}">${escape(source.title)} →</button><blockquote>${escape(quote)}</blockquote></div>`).join('');
}
function renderReflectionDraft() {
  const draft = reflectionDraft; if (!draft) return;
  $('#reflection-result').innerHTML = `<p class="reflection-analysis">${escape(draft.analysis)}</p>${sourceButtons(draft.sources,'draft')}${draft.body ? `<div class="idea-editor"><p class="vault-copy">整理成一个想法 · 可编辑提案</p><label for="idea-title">标题</label><input id="idea-title" maxlength="160" value="${escape(draft.title)}"/><label for="idea-body">正文</label><textarea id="idea-body" maxlength="8000">${escape(draft.body)}</textarea><label class="idea-export-choice"><input type="checkbox" id="export-confirmed-idea" ${data.vault ? 'checked' : 'disabled'}/>确认保存后导出到已选 Vault</label><div class="reflection-actions"><button class="primary-button" id="save-idea">确认并保存</button><button class="text-button" id="discard-idea">放弃草稿</button></div></div>` : '<button class="text-button" id="discard-idea">收起分析</button>'}<div style="display:flex;gap:10px;flex-wrap:wrap"><button class="text-button discussion-copy" id="discuss-reflection">带入助手继续讨论</button><button class="text-button discussion-copy" id="copy-discussion">复制讨论材料</button></div><textarea id="discussion-material" aria-label="可复制的讨论材料" readonly hidden></textarea>`;
  for (const button of document.querySelectorAll<HTMLButtonElement>('[data-draft-source]')) button.addEventListener('click',()=>run(()=>openReflectionSource(draft.sources[Number(button.dataset.draftSource)].source)));
  document.querySelector('#save-idea')?.addEventListener('click',()=>{ void confirmIdea(); });
  $('#discard-idea').addEventListener('click',()=> { if (reflectionSaving) return; reflectionDraft=null; $('#reflection-result').innerHTML=''; setReflectionStatus('草稿已放弃，未写入笔记或 Vault。'); });
  $('#discuss-reflection')?.addEventListener('click', () => {
    const material = discussionMaterial(draft, document.querySelector<HTMLInputElement>('#idea-title')?.value ?? '', document.querySelector<HTMLTextAreaElement>('#idea-body')?.value ?? '');
    assistant.setDraftAndOpen(`请结合以下阅读回顾草稿，帮我进一步梳理和深化思路：\n\n${material}`);
  });
  $('#copy-discussion').addEventListener('click',()=>run(async()=> {
    const material = discussionMaterial(draft, document.querySelector<HTMLInputElement>('#idea-title')?.value ?? '',document.querySelector<HTMLTextAreaElement>('#idea-body')?.value ?? '');
    try { await navigator.clipboard.writeText(material); setReflectionStatus('材料已复制，可在 Codex 中粘贴继续讨论。'); }
    catch { const input = $<HTMLTextAreaElement>('#discussion-material'); input.value=material; input.hidden=false; input.focus(); input.select(); setReflectionStatus('请选择并复制这些材料，再粘贴到 Codex。'); }
  }));
}
async function confirmIdea() {
  if (!reflectionDraft || reflectionSaving) return;
  const draft = reflectionDraft, title=$<HTMLInputElement>('#idea-title').value, body=$<HTMLTextAreaElement>('#idea-body').value;
  const exportAfter = $<HTMLInputElement>('#export-confirmed-idea').checked && !!data.vault;
  reflectionSaving=true; updateReflectionButtons(); setReflectionStatus('正在确认保存…');
  try {
    const saved = await write(()=>reflectionRepo.save({id:draft.id,title,body,question:draft.question,sources:draft.sources}));
    ideasLoadRevision += 1; confirmedIdeas = [saved,...confirmedIdeas.filter((idea)=>idea.id!==saved.id)]; reflectionDraft=null;
    $('#reflection-result').innerHTML=''; renderIdeas(); setReflectionStatus('想法已确认并保存在 Reader。');
    if (exportAfter) {
      try { const record = await exportIdea(saved.id); setReflectionStatus(record.status==='synced' ? '想法已确认保存并导出到 Vault。' : `想法已保存。${record.message ?? '导出未完成，可重试。'}`); }
      catch (error) { setReflectionStatus(`想法已保存，导出未完成：${error instanceof Error ? error.message : String(error)}`); }
    }
  } catch (error) { setReflectionStatus(`未保存：${error instanceof Error ? error.message : String(error)}。草稿仍保留。`); }
  finally { reflectionSaving=false; updateReflectionButtons(); }
}
async function openReflectionSource(source: ReflectionSource) {
  guardEditor();
  if (source.location) {
    validateReaderLocation(source.location);
    await openBook(source.location.bookId,undefined,{...source.location,noteId:''});
  } else { await reflectionRepo.open(source); }
}
async function loadIdeas() { const revision = ++ideasLoadRevision; const ideas = await reflectionRepo.ideas(); if (revision === ideasLoadRevision) { confirmedIdeas=ideas; renderIdeas(); } }
function renderIdeas() {
  $('#ideas-section').hidden = !confirmedIdeas.length;
  $('#ideas-list').innerHTML = confirmedIdeas.map((idea)=>`<article class="note-entry"><time>${escape(new Date(idea.confirmedAt).toLocaleString('zh-CN'))} · AI 提案，经你确认</time><h3 class="idea-title">${escape(idea.title)}</h3><p class="idea-body">${escape(idea.body)}</p>${idea.sources.map(({source,quote},index)=>`<div class="reflection-citation"><button class="text-button" data-idea-source="${index}" data-idea-id="${idea.id}">${escape(source.title)} →</button><blockquote>${escape(quote)}</blockquote></div>`).join('')}${desktop && data.vault ? `<div class="note-export"><button class="text-button" data-export-idea="${idea.id}">导出想法</button>${data.exports.find((record)=>record.noteId===idea.id)?.contentHash ? `<button class="text-button" data-open-idea="${idea.id}">在 Obsidian 中打开</button>` : ''}${data.exports.find((record)=>record.noteId===idea.id)?.conflictPath ? `<button class="text-button" data-open-idea-copy="${idea.id}">打开 Reader 副本</button>` : ''}</div>` : ''}</article>`).join('');
}
async function exportIdea(id: string) {
  const record = await write(()=>invoke<VaultExport>('export_idea',{id})); data.exports=[...data.exports.filter((value)=>value.noteId!==id),record]; renderVault(); renderIdeas(); return record;
}
$('#start-reflection').addEventListener('click',()=>run(async()=> {
  if (!$('#reflection-panel').hidden) { if (!reflectionAnalyzing && !reflectionSearching && !reflectionSaving) $('#reflection-query').focus(); return; }
  guardEditor(); $('#reflection-panel').hidden=false;
  $<HTMLSelectElement>('#reflection-book').innerHTML='<option value="">所有书籍</option>'+data.books.map((book)=>`<option value="${book.id}">${escape(book.title)}</option>`).join('');
  $<HTMLSelectElement>('#reflection-book').value=noteScope==='book' ? currentBook?.id ?? '' : '';
  await updateReflectionScope(); setReflectionStatus(desktop ? '检索只在本机进行，请先选定来源再分析。' : '请在桌面版使用助手回顾。');
  $('#reflection-query').focus();
}));
$('#close-reflection').addEventListener('click',()=>run(async()=> { guardEditor(); abandonReflection(); }));
$('#search-reflection').addEventListener('click',()=>{ void searchReflection().catch(showError); });
$('#analyze-reflection').addEventListener('click',()=>{ void analyzeReflection().catch(showError); });
$('#cancel-reflection').addEventListener('click',()=> { stopReflectionAnalysis(); reflectionSearching=false; setReflectionStatus('已取消，迟到结果不会显示。'); updateReflectionButtons(); });
$('#choose-reflection-scope').addEventListener('click',()=>run(async()=> {
  guardEditor(); stopReflectionAnalysis();
  const path = await chooseFile({directory:true,multiple:false,title:'选择当前 Vault 内允许检索的文件夹'});
  if (typeof path==='string') { await reflectionRepo.configureScope(path); reflectionDraft=null; $('#reflection-result').innerHTML=''; reflectionSources=[]; renderReflectionSources(); await updateReflectionScope(); }
}));
$('#clear-reflection-scope').addEventListener('click',()=>run(async()=> { guardEditor(); stopReflectionAnalysis(); await reflectionRepo.configureScope(null); reflectionDraft=null; $('#reflection-result').innerHTML=''; reflectionSources=[]; renderReflectionSources(); await updateReflectionScope(); }));
$('#ideas-list').addEventListener('click',(event)=> {
  const button=(event.target as Element).closest<HTMLButtonElement>('[data-idea-source], [data-export-idea], [data-open-idea], [data-open-idea-copy]'); if (!button) return;
  if (button.dataset.ideaSource !== undefined) { const idea=confirmedIdeas.find((value)=>value.id===button.dataset.ideaId); if (idea) run(()=>openReflectionSource(idea.sources[Number(button.dataset.ideaSource)].source)); }
  else if (button.dataset.exportIdea) run(async()=> { const record=await exportIdea(button.dataset.exportIdea!); if (record.status!=='synced') showStatus(record.message ?? '导出未完成。'); });
  else run(()=>repo.openExport((button.dataset.openIdea ?? button.dataset.openIdeaCopy)!,!!button.dataset.openIdeaCopy));
});
$('#library-notes').addEventListener('click',()=>run(async()=> { guardEditor(); renderNotes('today'); }));
$('#library-assistant')?.addEventListener('click', () => { assistant.setOpen(true, true); });

document.querySelectorAll('[data-vault-settings]').forEach((button) => button.addEventListener('click', () => run(async () => showVault())));
function closeVault() { $('#vault-backdrop').hidden = true; vaultFocus?.focus(); }
$('#close-vault').addEventListener('click', closeVault);
$('#vault-backdrop').addEventListener('click', (event) => { if (event.target === $('#vault-backdrop')) closeVault(); });
$('#choose-vault').addEventListener('click', () => run(async () => {
  const path = await chooseFile({ directory: true, multiple: false, title: '选择 Obsidian Vault' });
  if (typeof path === 'string') { applyVault(await write(() => repo.configureVault(path))); $('#vault-result').textContent = '已连接。新保存的笔记将自动导出；已有笔记可手动导出。'; }
}));
$('#disconnect-vault').addEventListener('click', () => run(async () => { applyVault(await write(() => repo.configureVault(null))); $('#vault-result').textContent = '已断开。Reader 笔记和已经导出的文件均保留。'; }));
$('#export-all').addEventListener('click', () => run(() => exportBatch(data.annotations)));
$('#export-scope').addEventListener('click', () => run(() => exportBatch(noteScope === 'today' ? notesForDay(data.annotations, new Date()) : data.annotations.filter((a) => a.bookId === currentBook?.id))));
$('#open-pending-link').addEventListener('click', () => { if (pendingLink) run(() => openReaderLink(pendingLink!)); });
$('#notes-list').addEventListener('click', (event) => {
  const button = (event.target as Element).closest<HTMLElement>('[data-export-note], [data-open-export], [data-open-copy]');
  if (!button) return;
  if (button.dataset.exportNote) run(async () => { const record = await exportOne(button.dataset.exportNote!); if (record.status !== 'synced') showStatus(record.message ?? '导出未完成。'); });
  else run(() => repo.openExport((button.dataset.openExport ?? button.dataset.openCopy)!, !!button.dataset.openCopy));
});
$('#import-book').addEventListener('click', () => run(selectFile));
$('#sample-book').addEventListener('click', () => run(async () => {
  if (importing) return;
  importing = true;
  try {
    const bytes = desktop ? await invoke<ArrayBuffer>('read_sample_file') : await (await fetch('/samples/reader-lab.epub')).arrayBuffer();
    await importBytes(bytes, 'reader-lab.epub', ':sample:');
  } finally { importing = false; }
}));
$('#file-input').addEventListener('change', () => {
  const input = $<HTMLInputElement>('#file-input'); const file = input.files?.[0]; input.value = '';
  if (file) run(() => importFile(file));
});
$('#book-list').addEventListener('click', (event) => { const button = (event.target as Element).closest<HTMLElement>('[data-book-id]'); if (button) run(() => openBook(button.dataset.bookId!)); });
$('#back-button').addEventListener('click', () => run(returnLibrary));
$('#finish-session').addEventListener('click', () => run(returnLibrary));
$('#enter-reflect').addEventListener('click', () => renderNotes('today'));
$('#reflect-back').addEventListener('click', () => run(async () => { if (currentBook) await openBook(currentBook.id); else await returnLibrary(); }));
function renderCodex() {
  assistant.updateStatus();
  const status = codex.status;
  $('#codex-path').textContent = status.executable ? `${codex.label}：${status.executable.split('/').pop()}` : `尚未找到 ${codex.label} 程序，请选择程序`;
  $<HTMLSelectElement>('#agent-provider').value = status.provider;
  $<HTMLSelectElement>('#agent-provider').disabled = !desktop || codexBusy || ['connecting', 'running', 'cancelling'].includes(status.phase);
  $('#codex-path').title = status.executable;
  $('#codex-summary').textContent = [status.message, status.version, status.account].filter(Boolean).join(' · ');
  $<HTMLButtonElement>('#connect-codex').disabled = !desktop || codexBusy || ['connecting', 'running', 'cancelling'].includes(status.phase) || !status.executable;
  $('#connect-codex').textContent = status.phase === 'error' ? '重新连接' : status.phase === 'ready' ? '重新连接' : '连接';
  $<HTMLButtonElement>('#choose-codex').disabled = !desktop || codexBusy || ['connecting', 'running', 'cancelling'].includes(status.phase);
  $<HTMLButtonElement>('#disconnect-codex').disabled = !desktop || status.phase === 'disconnected';
}
function closeCodex() { $('#codex-backdrop').hidden = true; codexFocus?.focus(); }
async function connectCodex(executable = codex.status.executable) {
  codexBusy = true; renderCodex();
  try { await codex.connect(executable); }
  finally { codexBusy = false; renderCodex(); }
}
function openCodex(focus: HTMLElement) {
  guardEditor(); stopReflectionAnalysis(); $('#options-backdrop').hidden = true; closeContext(); codexFocus = focus;
  renderCodex(); $('#codex-backdrop').hidden = false; $('#close-codex').focus();
}
for (const button of document.querySelectorAll<HTMLButtonElement>('[data-codex-settings]')) button.addEventListener('click', () => run(async () => openCodex(screen === 'reader' ? $('#menu-button') : button)));
$('#agent-provider').addEventListener('change', () => run(async () => {
  const provider = $<HTMLSelectElement>('#agent-provider').value === 'pi' ? 'pi' : 'codex';
  codexBusy = true;
  try { await codex.select(provider); }
  finally { codexBusy = false; renderCodex(); }
}));
$('#close-codex').addEventListener('click', closeCodex);
$('#codex-backdrop').addEventListener('click', (event) => { if (event.target === $('#codex-backdrop')) closeCodex(); });
$('#connect-codex').addEventListener('click', () => run(() => connectCodex()));
$('#choose-codex').addEventListener('click', () => run(async () => {
  if (!desktop) return;
  const path = await chooseFile({ title: `选择 ${codex.label} 可执行程序`, directory: false, multiple: false });
  if (typeof path === 'string') await connectCodex(path);
}));
$('#disconnect-codex').addEventListener('click', () => run(() => codex.disconnect()));

$('#menu-button').addEventListener('click', () => { $('#options-backdrop').hidden = false; });
$('#options-backdrop').addEventListener('click', (event) => { if (event.target === $('#options-backdrop')) $('#options-backdrop').hidden = true; });
$('#layout-toggle').addEventListener('click', () => run(async () => {
  guardEditor(); closeContext();
  const button = $<HTMLButtonElement>('#layout-toggle'); button.disabled = true;
  try {
    await changeSettings({ columns: data.settings.columns === 'double' ? 'single' : 'double' });
    if (data.settings.columns === 'double' && adapter?.layoutMode !== 'double') showStatus('双栏偏好已保存。正文空间不足，暂用单栏；扩大窗口或收起助手后会自动恢复双栏。');
  }
  finally { button.disabled = false; updateLayoutUi(); }
}));
$('#previous-page').addEventListener('click', () => run(async () => { guardEditor(); closeContext(); activity(); await adapter?.scrollChapter(-1); }));
$('#next-page').addEventListener('click', () => run(async () => { guardEditor(); closeContext(); activity(); await adapter?.scrollChapter(1); }));
$('#theme-toggle').addEventListener('click', () => run(async () => { await changeSettings({ theme: data.settings.theme === 'dark' ? 'light' : 'dark' }); $('#options-backdrop').hidden = true; }));
$('#font-size').addEventListener('change', () => run(() => changeSettings({ fontSize: Number($<HTMLInputElement>('#font-size').value) })));
$('#font-size').addEventListener('input', () => { $('#font-size-label').textContent = $<HTMLInputElement>('#font-size').value; });
$('#line-height').addEventListener('change', () => run(() => changeSettings({ lineHeight: Number($<HTMLSelectElement>('#line-height').value) })));
$('#book-notes').addEventListener('click', () => run(async () => { guardEditor(); await finishCurrentSession(); $('#options-backdrop').hidden = true; renderNotes('book'); }));
$('#end-reading').addEventListener('click', () => run(endReading));
$('#chapter-label').addEventListener('click', () => { $('#toc-backdrop').hidden = false; });
$('#toc-backdrop').addEventListener('click', (event) => { if (event.target === $('#toc-backdrop')) $('#toc-backdrop').hidden = true; });
$('#toc-items').addEventListener('click', (event) => { const button = (event.target as Element).closest<HTMLElement>('[data-href]'); if (button) run(async () => { guardEditor(); closeContext(); $('#toc-backdrop').hidden = true; activity(); await adapter?.display(button.dataset.href!); }); });
$('#previous-chapter').addEventListener('click', () => run(() => changeChapter(-1)));
$('#next-chapter').addEventListener('click', () => run(() => changeChapter(1)));
$('#link-return').addEventListener('click', () => run(async () => { const cfi = linkHistory.pop(); closeContext(); if (cfi) await adapter?.display(cfi); $('#link-return').hidden = linkHistory.length === 0; }));
$('#selection-toolbar').addEventListener('click', (event) => {
  const action = (event.target as HTMLElement).dataset.action;
  if (action === 'highlight') run(() => saveAnnotation('highlight'));
  else if (action === 'note' && selected) noteEditor(selected, data.annotations.find((a) => a.kind === 'note' && a.cfi === selected!.cfi && a.bookId === currentBook?.id) ?? null);
  else if (action === 'ask' && selected) {
    const sel = selected;
    closeContext();
    assistant.attachSelection({ text: sel.text, cfi: sel.cfi, href: sel.href, title: currentBook?.title });
  }
});
$('#notes-list').addEventListener('click', (event) => {
  const discuss = (event.target as Element).closest<HTMLElement>('[data-discuss-note]');
  if (discuss) {
    const annotation = data.annotations.find((a) => a.id === discuss.dataset.discussNote);
    if (annotation) {
      const book = data.books.find((b) => b.id === annotation.bookId);
      const prompt = annotation.kind === 'note' ? `关于笔记「${annotation.body}」，想深入讨论：` : `请帮我解读这段划线内容：`;
      assistant.setDraftAndOpen(prompt, {
        text: annotation.quote || annotation.body,
        bookId: annotation.bookId,
        noteId: annotation.id,
        cfi: annotation.cfi,
        href: annotation.href,
        title: book?.title,
      });
    }
    return;
  }
  const button = (event.target as Element).closest<HTMLElement>('[data-note-id], [data-edit-note]');
  if (!button) return;
  const annotation = data.annotations.find((a) => a.id === (button.dataset.noteId ?? button.dataset.editNote));
  if (!annotation) return;
  run(async () => { await openBook(annotation.bookId, annotation); if (button.dataset.editNote && adapter) openAnnotationEditor(annotation, window.innerWidth / 2, 180); });
});
$('#dismiss-status').addEventListener('click', clearStatus);
$('#retry-save').addEventListener('click', () => run(async () => { await flushPosition(); await heartbeat(); clearStatus(); }));
document.addEventListener('pointerdown', (event) => {
  activity();
  if (!(event.target as Element).closest('#selection-popover, #selection-toolbar')) closeContext();
});
let changingChapter = false;
async function changeChapter(direction: -1 | 1) {
  if (changingChapter || opening || shuttingDown || screen !== 'reader' || !adapter) return;
  guardEditor(); closeContext(); activity(); changingChapter = true;
  try { if (direction < 0) await adapter.previous(); else await adapter.next(); }
  finally { changingChapter = false; }
}
function readingKeydown(event: KeyboardEvent) {
  if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key) || event.defaultPrevented
    || event.isComposing || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey
    || screen !== 'reader' || opening || shuttingDown || !adapter) return;
  if (document.querySelector('.modal-backdrop:not([hidden])')) return;
  // Use nodeType instead of instanceof: EPUB events originate in another window.
  const target = event.target as Element | null;
  if (target?.nodeType === 1 && target.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="slider"], [role="separator"], #assistant-panel, #selection-popover, #selection-toolbar')) return;
  if (target?.nodeType === 1 && target.closest('button') && !target.closest('.reading-footer')) return;
  event.preventDefault(); activity();
  if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
    if (!event.repeat) run(() => changeChapter(event.key === 'ArrowLeft' ? -1 : 1));
  } else run(async () => { guardEditor(); closeContext(); await adapter?.scrollChapter(event.key === 'ArrowUp' ? -1 : 1); });
}
document.addEventListener('keydown', (event) => {
  readingKeydown(event);
  activity();
  if ((!$('#vault-backdrop').hidden || !$('#codex-backdrop').hidden || !!ask.state) && event.key === 'Tab') {
    const dialog = !$('#codex-backdrop').hidden ? '#codex-backdrop' : !$('#vault-backdrop').hidden ? '#vault-backdrop' : '#selection-popover';
    const buttons = [...document.querySelectorAll<HTMLElement>(`${dialog} button:not(:disabled), ${dialog} textarea:not(:disabled), ${dialog} select:not(:disabled)`)];
    const first = buttons[0], last = buttons[buttons.length - 1];
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
  }
  if (event.key === 'Escape') { if (reflectionAnalyzing || reflectionSearching) { stopReflectionAnalysis(); reflectionEpoch += 1; reflectionSearching = false; setReflectionStatus('已取消；迟到结果不会显示。'); updateReflectionButtons(); } closeContext(); $('#options-backdrop').hidden = true; $('#toc-backdrop').hidden = true; if (!$('#vault-backdrop').hidden) closeVault(); if (!$('#codex-backdrop').hidden) closeCodex(); }
});
function foreground() { syncReadingContext(); clock?.foreground(document.hasFocus() && document.visibilityState === 'visible' && screen === 'reader', performance.now()); run(async () => { await flushPosition(); await heartbeat(); }); }
window.addEventListener('resize', () => {
  if (!ask.state || !selected) return;
  positionPopover(selected.x, selected.y);
  const popover = $('#selection-popover'), height = popover.getBoundingClientRect().height;
  popover.style.top = `${Math.max(72, Math.min(parseFloat(popover.style.top) || 100, window.innerHeight - height - 16))}px`;
});
window.addEventListener('focus', foreground); window.addEventListener('blur', foreground); document.addEventListener('visibilitychange', foreground);
setInterval(() => run(async () => { await flushPosition(); await heartbeat(); }), 15_000);
setInterval(() => { if (ready && !shuttingDown) contextService.refresh(); }, 10_000);
window.addEventListener('pagehide', () => { run(async () => { await assistant.flush(); await flushPosition(); await heartbeat(); }); });
if (!desktop) {
  document.addEventListener('dragover', (event) => event.preventDefault());
  document.addEventListener('drop', (event) => { event.preventDefault(); const file = event.dataTransfer?.files[0]; if (file) run(() => importFile(file)); });
}

async function start() {
  data = await repo.snapshot();
  await repo.beginContext(contextService.instanceId);
  if (!desktop) {
    for (const interrupted of data.sessions.filter((s) => !s.endedAt)) {
      interrupted.endedAt = interrupted.updatedAt;
      await write(() => repo.saveSession({ ...interrupted }));
    }
  }
  updateSettingsUi(); renderLibrary();
  if (desktop) {
    await listen<McpRequest>('reader-mcp-request', (event) => { void handleMcpRequest(event.payload); });
    await onOpenUrl((urls) => { for (const url of urls) receiveReaderLink(url); });
    const initialUrls = await getCurrent();
    if (initialUrls?.length) pendingLink = initialUrls[initialUrls.length - 1];
    const window = getCurrentWindow();
    await window.onDragDropEvent((event) => { const payload = event.payload; if (payload.type === 'drop' && payload.paths[0]) run(() => importPath(payload.paths[0])); });
    const prepareExit = async () => {
      if (shuttingDown) return;
      try {
        guardEditor(); abandonReflection(); closeContext(); await assistant.flush(); await settingsChanges; await finishCurrentSession(); await contextService.flush(); await writes;
        shuttingDown = true; await invoke('finish_exit');
      } catch (error) { showError(error); }
    };
    await window.onCloseRequested(async (event) => {
      if (shuttingDown) return;
      event.preventDefault(); await prepareExit();
    });
    await codex.initialize().catch(showError);
    await listen('reader-exit-requested', () => { void prepareExit(); });
  }
  await assistant.initialize();
  ready = true; syncReadingContext(); renderVault();
  if (pendingLink) { const initial = pendingLink; receiveReaderLink(initial); }
  else if (data.settings.lastBookId && data.books.some((b) => b.id === data.settings.lastBookId)) await openBook(data.settings.lastBookId);
}
run(start);
