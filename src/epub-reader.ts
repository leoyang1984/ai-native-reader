import ePub, { EpubCFI, type Book, type Contents, type Location, type NavItem, type Rendition } from 'epubjs';
import JSZip from 'jszip';
import { invalidateContextText, surroundingFromRange, unavailableText } from './context-text';
import type { ContextSelectionInput, SurroundingText } from './reading-context';
import type Section from 'epubjs/types/section';
import type { Annotation, BookRecord, ReaderSettings, ReadingPosition } from './models';

export interface TextSelection { cfi: string; href: string; text: string; x: number; y: number }
interface ReaderEvents {
  selected(selection: TextSelection): void;
  selectionCleared(): void;
  relocated(position: ReadingPosition): void;
  activity(): void;
  continued(): void;
  annotationClicked(annotation: Annotation, x: number, y: number): void;
  linkOrigin(cfi: string): void;
  error(message: string): void;
  escape(): void;
  keydown(event: KeyboardEvent): void;
  layoutChanged(): void;
}

export async function validateArchive(bytes: ArrayBuffer): Promise<void> {
  if (bytes.byteLength > 100 * 1024 * 1024) throw new Error('第一版暂不支持超过 100 MB 的 EPUB。');
  let zip: JSZip;
  try { zip = await JSZip.loadAsync(bytes); } catch { throw new Error('这不是有效的 EPUB 压缩包。'); }
  if (!zip.file('META-INF/container.xml')) throw new Error('EPUB 缺少 META-INF/container.xml。');
  if (await zip.file('mimetype')?.async('string') !== 'application/epub+zip') throw new Error('文件格式不是标准 EPUB。');
  const encryption = await zip.file('META-INF/encryption.xml')?.async('string');
  if (encryption) {
    const xml = new DOMParser().parseFromString(encryption, 'application/xml');
    for (const method of Array.from(xml.getElementsByTagNameNS('*', 'EncryptionMethod'))) {
      const algorithm = method.getAttribute('Algorithm') ?? '';
      if (!['http://www.idpf.org/2008/embedding', 'http://ns.adobe.com/pdf/enc#RC'].includes(algorithm)) {
        throw new Error('这本 EPUB 的内容已加密；第一版支持无 DRM 的 EPUB。');
      }
    }
  }
}

export async function inspectBook(bytes: ArrayBuffer, fileName: string): Promise<BookRecord> {
  await validateArchive(bytes);
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  const fingerprint = Array.from(new Uint8Array(hash), (x) => x.toString(16).padStart(2, '0')).join('');
  const book = ePub(bytes, { replacements: 'blobUrl' });
  try {
    await book.opened;
    const metadata = await book.loaded.metadata;
    if (metadata.layout === 'pre-paginated') throw new Error('这本书采用固定版式；第一版支持可重排版 EPUB。');
    let cover: string | null = null;
    try {
      const url = await book.coverUrl();
      if (url && !/^https?:/i.test(url)) {
        const blob = await (await fetch(url)).blob();
        if (blob.size < 2 * 1024 * 1024) cover = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = () => reject(reader.error); reader.readAsDataURL(blob);
        });
      }
    } catch { /* A missing cover must not prevent reading. */ }
    return { id: fingerprint, fingerprint, title: metadata.title?.trim() || fileName.replace(/\.epub$/i, ''),
      author: metadata.creator?.trim() || '作者未知', language: metadata.language || '', cover, importedAt: new Date().toISOString() };
  } catch (error) {
    throw new Error(error instanceof Error ? `无法打开 EPUB：${error.message}` : '无法解析 EPUB。请检查文件是否完整。');
  } finally { book.destroy(); }
}

function sanitizeDocument(doc: Document) {
  // Books are data. Keep their reading markup but remove executable/embedded surfaces.
  doc.querySelectorAll('script, iframe, object, embed, form, input, button, meta[http-equiv="refresh"]').forEach((node) => node.remove());
  for (const element of Array.from(doc.querySelectorAll('*'))) {
    for (const attr of Array.from(element.attributes)) {
      if (/^on/i.test(attr.name) || (/^(href|src|xlink:href)$/i.test(attr.name) && /^\s*(javascript|vbscript):/i.test(attr.value))) element.removeAttribute(attr.name);
    }
  }
  const meta = doc.createElement('meta');
  meta.setAttribute('http-equiv', 'Content-Security-Policy');
  meta.setAttribute('content', "default-src 'self' blob: data:; script-src 'none'; style-src 'self' 'unsafe-inline' blob: data:; connect-src 'none'; frame-src 'none'; object-src 'none'; form-action 'none'");
  doc.querySelector('head')?.prepend(meta);
}

async function validateBookLocation(book: Book, cfi: string, href: string): Promise<void> {
  try {
    const parsed = new EpubCFI(cfi);
    const section = book.spine.get(parsed.spinePos);
    if (!section || section.href.split('#')[0] !== href.split('#')[0]) throw new Error('chapter mismatch');
    const range = await book.getRange(cfi);
    if (!range || !range.startContainer || !range.endContainer) throw new Error('anchor missing');
  } catch { throw new Error('原文位置无效，或 CFI 与章节来源不匹配。'); }
}

/** Validate an external source before ending the current session or replacing the visible book. */
export async function validateEpubLocation(bytes: ArrayBuffer, cfi: string, href: string): Promise<void> {
  const book = ePub(bytes, { replacements: 'blobUrl' });
  try {
    await book.opened;
    book.spine.hooks.content.register(sanitizeDocument);
    await validateBookLocation(book, cfi, href);
  } finally { book.destroy(); }
}

function normalized(s: string) { return s.replace(/\s+/g, ' ').trim(); }

/** Reanchor only an unambiguous exact excerpt within its original chapter. */
export function rangeForUniqueQuote(doc: Document, quote: string): Range | null {
  const root = doc.querySelector('body');
  if (!root || !quote) return null;
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes: Text[] = []; let text = ''; let node: Node | null;
  while ((node = walker.nextNode())) { nodes.push(node as Text); text += node.textContent ?? ''; }
  const start = text.indexOf(quote);
  if (start < 0 || text.indexOf(quote, start + 1) >= 0) return null;
  const range = doc.createRange(); let offset = 0; let begun = false;
  for (const item of nodes) {
    const length = item.length;
    if (!begun && start < offset + length) { range.setStart(item, start - offset); begun = true; }
    if (begun && start + quote.length <= offset + length) { range.setEnd(item, start + quote.length - offset); return range; }
    offset += length;
  }
  return null;
}

export class EpubReaderAdapter {
  private book!: Book;
  private rendition!: Rendition;
  private destroyed = false;
  private locationsReady = false;
  private renderedAnnotations = new Map<string, { cfi: string; type: string }>();
  private annotations: Annotation[] = [];
  private activeSettings!: ReaderSettings;
  private resizeObserver?: ResizeObserver;
  private resizeTimer?: ReturnType<typeof setTimeout>;
  private operations: Promise<void> = Promise.resolve();
  private reflowing = false;
  private reflowAnchor: string | undefined;
  private layoutSize = { width: 0, height: 0 };
  private pageTurning = false;
  private wheelAt = 0;
  private wheelDelta = 0;
  private wheelTurned = false;
  layoutMode: 'single' | 'double' = 'single';
  pages: { first: number; last: number; total: number } | null = null;
  toc: NavItem[] = [];
  position: ReadingPosition | null = null;
  unresolved = new Set<string>();

  constructor(private readonly host: HTMLElement, private readonly record: BookRecord, private readonly events: ReaderEvents) {}

  async open(bytes: ArrayBuffer, settings: ReaderSettings, position?: ReadingPosition) {
    this.activeSettings = settings;
    this.book = ePub(bytes, { replacements: 'blobUrl' });
    await this.book.opened;
    this.toc = (await this.book.loaded.navigation).toc;
    this.book.spine.hooks.content.register(sanitizeDocument);
    // WKWebView suppresses even parent-installed event listeners in an iframe
    // whose sandbox disables scripts. Book scripts are stripped above and the
    // chapter CSP still forbids executing book code; trusted reader handlers
    // need this sandbox flag for selection, navigation and activity events.
    this.layoutMode = this.desiredLayout();
    this.mountRendition(this.layoutMode);
    try { await this.displayStable(position?.cfi); }
    catch {
      if (!position) throw new Error('书籍正文无法显示。');
      await this.displayStable(position.href || undefined);
      this.events.error('原阅读位置未能恢复，已回到对应章节。');
    }
    this.bindContainer();
    this.layoutSize = { width: this.host.clientWidth, height: this.host.clientHeight };
    this.resizeObserver = new ResizeObserver(() => {
      clearTimeout(this.resizeTimer);
      this.resizeTimer = setTimeout(() => {
        if (!this.destroyed && this.host.clientWidth && this.host.clientHeight) {
          void this.enqueue(() => this.reflow()).catch((error) => { if (!this.destroyed) this.events.error(String(error)); });
        }
      }, 120);
    });
    // Parent width reflects the space left after opening/resizing the assistant.
    this.resizeObserver.observe(this.host.parentElement ?? this.host);
    this.resizeObserver.observe(this.host);
    this.events.layoutChanged();
    void this.book.locations.generate(1000).then(() => {
      if (!this.destroyed) { this.locationsReady = true; this.reportPosition(this.rendition.currentLocation() as unknown as Location); }
    }).catch(() => { /* Chapter navigation still works without global progress. */ });
  }

  private mountRendition(mode: 'single' | 'double') {
    this.host.classList.toggle('double-layout', mode === 'double');
    this.rendition = this.book.renderTo(this.host, { width: '100%', height: '100%', flow: mode === 'double' ? 'paginated' : 'scrolled-doc', spread: mode === 'double' ? 'auto' : 'none', minSpreadWidth: 960, allowScriptedContent: true });
    this.rendition.hooks.content.register((contents: Contents) => this.bindContents(contents));
    this.rendition.on('selected', (_cfi: string, contents: Contents) => this.publishSelection(contents));
    this.rendition.on('relocated', (location: Location) => this.reportPosition(location));
    this.rendition.on('displayError', () => this.events.error('这一章节未能显示，请尝试从目录重新打开。'));
    this.applySettings(this.activeSettings);
  }

  private bindContainer() {
    const container = this.host.querySelector('.epub-container');
    // Programmatic CFI navigation also scrolls. Only user gestures dismiss a
    // context card, otherwise returning to a note immediately hides its editor.
    container?.addEventListener('scroll', () => this.events.activity(), { passive: true });
    container?.addEventListener('pointerdown', () => { this.reflowAnchor = undefined; });
    container?.addEventListener('wheel', (event) => this.readingWheel(event as WheelEvent), { passive: false });
  }

  private publishSelection(contents: Contents) {
    if (this.destroyed || this.reflowing || !(this.rendition.getContents() as unknown as Contents[]).includes(contents)) return;
    const href = this.book.spine.get(contents.sectionIndex).href;
    if (this.position && href !== this.position.href) return;
    const selection = contents.window.getSelection();
    if (!selection || selection.isCollapsed || !selection.rangeCount) { this.events.selectionCleared(); return; }
    try {
      // Read the actual DOM selection, including for epub.js's delayed event.
      // An old emitted CFI must not resurrect a selection that has been cleared.
      const range = selection.getRangeAt(0), text = range.toString().trim();
      if (text.length < 2) { this.events.selectionCleared(); return; }
      const rect = range.getBoundingClientRect(), frame = contents.window.frameElement?.getBoundingClientRect();
      this.events.selected({ cfi: contents.cfiFromRange(range), href, text,
        x: (frame?.left ?? 0) + rect.left + rect.width / 2, y: (frame?.top ?? 0) + rect.top });
    } catch { this.events.selectionCleared(); this.events.error('选区无法定位，请重新选中一段正文。'); }
  }

  private bindContents(contents: Contents) {
    const doc = contents.document;
    // WKWebView may not deliver epub.js's debounced selection event after a drag.
    // Capture the completed native selection as well, without changing book markup.
    let selectionTimer: ReturnType<typeof setTimeout>;
    const scheduleSelection = () => { clearTimeout(selectionTimer); selectionTimer = setTimeout(() => this.publishSelection(contents), 250); };
    doc.addEventListener('selectionchange', scheduleSelection);
    doc.addEventListener('mouseup', scheduleSelection);
    doc.addEventListener('keyup', scheduleSelection);
    doc.addEventListener('pointerdown', () => { this.reflowAnchor = undefined; this.events.activity(); this.events.continued(); });
    doc.addEventListener('wheel', (event) => this.readingWheel(event), { passive: false });
    doc.addEventListener('keydown', (event) => { this.events.keydown(event); if (event.defaultPrevented) return; this.events.activity(); if (event.key === 'Escape') this.events.escape(); else this.events.continued(); });
    doc.addEventListener('click', (event) => {
      const link = (event.target as Element).closest?.('a[href]');
      if (!link) return;
      const href = link.getAttribute('href') ?? '';
      if (/^(https?:|mailto:|tel:)/i.test(href)) { event.preventDefault(); event.stopImmediatePropagation(); return; }
      if (this.position) this.events.linkOrigin(this.position.cfi);
    }, true);
  }

  private reportPosition(location: Location) {
    if (!location?.start?.cfi || this.destroyed || this.reflowing) return;
    const first = location.start.displayed?.page, last = location.end?.displayed?.page, total = location.start.displayed?.total;
    this.pages = this.layoutMode === 'double' && first && last && total ? { first, last: Math.min(last, total), total } : null;
    const href = location.start.href;
    const find = (items: NavItem[]): string | undefined => {
      for (const item of items) {
        if (item.href.split('#')[0] === href.split('#')[0]) return item.label.trim();
        const nested = find(item.subitems ?? []); if (nested) return nested;
      }
    };
    const percent = this.locationsReady && this.book.locations.length() > 0 ? this.book.locations.percentageFromCfi(location.start.cfi) : null;
    this.position = { bookId: this.record.id, cfi: location.start.cfi, href, chapterLabel: find(this.toc) || `第 ${location.start.index + 1} 节`,
      percent: Number.isFinite(percent) ? percent : null, updatedAt: new Date().toISOString() };
    this.events.relocated(this.position);
    this.events.layoutChanged();
  }

  applySettings(settings: ReaderSettings) {
    this.activeSettings = settings;
    const dark = settings.theme === 'dark';
    this.rendition.themes.default({
      'html': { background: dark ? '#282923 !important' : '#f7f5ef !important' },
      'body': { color: dark ? '#dedbd1 !important' : '#45463f !important', 'font-family': "Georgia, 'Songti SC', 'STSong', serif !important", 'font-size': `${settings.fontSize}px !important`, 'line-height': `${settings.lineHeight} !important`, padding: this.layoutMode === 'double' ? '10px 12px !important' : '0 12px 30px !important', margin: '0 !important' },
      'p': { 'margin-bottom': '1.1em !important', 'line-height': 'inherit !important' },
      'img, svg': { 'max-width': '100% !important', height: 'auto !important' },
      'a': { color: dark ? '#bbc3ad !important' : '#6e7764 !important' },
      'h1, h2, h3': { 'font-weight': '400 !important', 'line-height': '1.5 !important' },
    });
  }

  private enqueue(task: () => Promise<void>): Promise<void> {
    const operation = this.operations.then(async () => { if (!this.destroyed) await task(); });
    this.operations = operation.catch(() => undefined);
    return operation;
  }
  private desiredLayout(): 'single' | 'double' {
    const parent = this.host.parentElement;
    const style = parent ? getComputedStyle(parent) : null;
    const available = parent ? parent.clientWidth - parseFloat(style!.paddingLeft || '0') - parseFloat(style!.paddingRight || '0') : this.host.clientWidth;
    return this.activeSettings.columns === 'double' && available >= 960 ? 'double' : 'single';
  }
  private async reflow(force = false) {
    const mode = this.desiredLayout();
    const changed = mode !== this.layoutMode;
    if (!changed && !force && this.layoutSize.width === this.host.clientWidth && this.layoutSize.height === this.host.clientHeight) return;
    // Keep the original CFI across consecutive reflows: spread starts are rounded
    // to page groups and must not become the next resize's earlier anchor.
    const target = this.reflowAnchor ?? this.position?.cfi;
    this.reflowAnchor = target;
    this.reflowing = true;
    try {
      this.clearSelection();
      this.layoutMode = mode;
      this.host.classList.toggle('double-layout', mode === 'double');
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      const width = this.host.clientWidth, height = this.host.clientHeight;
      this.layoutSize = { width, height };
      if (this.destroyed || !width || !height) return;
      if (changed) {
        // Switching flow/spread on a live rendition keeps epub.js's pixel-sized stage from the
        // previous layout, so the spread never reached its 960px threshold. Start from a clean one.
        this.rendition.destroy();
        this.host.innerHTML = '';
        this.mountRendition(mode);
        await this.displayStable(target);
        this.bindContainer();
        this.renderedAnnotations.clear();
        void this.showAnnotations(this.annotations);
        return;
      }
      (this.rendition.getContents() as unknown as Contents[]).forEach((c) => invalidateContextText(c.document));
      this.applySettings(this.activeSettings);
      (this.rendition.resize as unknown as (w: number, h: number, cfi?: string) => void)(width, height, target);
      await this.displayStable(target);
      await this.showAnnotations(this.annotations);

    } finally {
      this.reflowing = false;
      if (!this.destroyed) {
        this.reportPosition(this.rendition.currentLocation() as unknown as Location);
        this.events.layoutChanged();
      }
    }
  }
  async setSettings(settings: ReaderSettings) {
    await this.enqueue(async () => { this.activeSettings = settings; await this.reflow(true); });
  }
  private readingWheel(event: WheelEvent) {
    this.reflowAnchor = undefined;
    this.events.activity(); this.events.continued();
    if (this.layoutMode !== 'double' || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;
    event.preventDefault();
    // One trackpad gesture advances one spread, including its inertia tail.
    const time = performance.now();
    if (time - this.wheelAt > 180) { this.wheelDelta = 0; this.wheelTurned = false; }
    this.wheelAt = time;
    this.wheelDelta += Math.abs(event.deltaY) >= Math.abs(event.deltaX) ? event.deltaY : event.deltaX;
    if (!this.wheelTurned && Math.abs(this.wheelDelta) >= 40) {
      this.wheelTurned = true;
      void this.scrollChapter(this.wheelDelta < 0 ? -1 : 1).catch((error) => this.events.error(String(error)));
    }
  }

  private async displayStable(target?: string) {
    await this.rendition.display(target);
    // epub.js resolves display before its content/theme hooks finish. Restore
    // the anchor after fonts and layout settle, so WebKit uses the final metrics.
    const contents = this.rendition.getContents() as unknown as Contents[];
    await Promise.all(contents.map((content) => content.document.fonts?.ready));
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    if (this.destroyed) return;
    if (target) await this.rendition.display(target);
    if (target?.startsWith('epubcfi(') && this.layoutMode === 'double') {
      // WebKit/epub.js can round a CFI on a column boundary into the preceding
      // spread. Check the resulting CFI interval instead of trusting its pixels.
      const compare = new EpubCFI().compare.bind(new EpubCFI());
      for (let attempt = 0; attempt < 2; attempt++) {
        const location = this.rendition.currentLocation() as unknown as Location;
        const first = location?.start?.displayed?.page, last = location?.end?.displayed?.page, total = location?.start?.displayed?.total;
        if (!location?.start?.cfi || !location.end?.cfi || !first || !last || !total) break;
        if (compare(target, location.end.cfi) >= 0 && last < total) await this.rendition.next();
        else if (compare(target, location.start.cfi) < 0 && first > 1) await this.rendition.prev();
        else break;
        await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
        if (this.destroyed) return;
      }
    }
    this.reportPosition(this.rendition.currentLocation() as unknown as Location);
  }

  async display(target: string) { await this.enqueue(async () => { this.reflowAnchor = undefined; this.clearSelection(); await this.displayStable(target); }); }
  async displayLocation(cfi: string, href: string) {
    await validateBookLocation(this.book, cfi, href);
    await this.display(cfi);
  }
  currentSelection(): ContextSelectionInput | null {
    if (this.destroyed || !this.position) return null;
    for (const contents of this.rendition.getContents() as unknown as Contents[]) {
      const href = this.book.spine.get(contents.sectionIndex).href;
      if (href !== this.position.href) continue;
      const selection = contents.window.getSelection();
      if (!selection || selection.isCollapsed || !selection.rangeCount) return null;
      try {
        const range = selection.getRangeAt(0), text = range.toString().trim();
        return text.length >= 2 ? { cfi: contents.cfiFromRange(range), href, text } : null;
      } catch { return null; }
    }
    return null;
  }
  async previous() {
    this.reflowAnchor = undefined;
    await this.enqueue(async () => {
      const target = this.book.spine.get(this.position?.href ?? 0)?.prev();
      if (target?.href) { this.clearSelection(); await this.displayStable(target.href); }
    });
  }
  async next() {
    this.reflowAnchor = undefined;
    await this.enqueue(async () => {
      const target = this.book.spine.get(this.position?.href ?? 0)?.next();
      if (target?.href) { this.clearSelection(); await this.displayStable(target.href); }
    });
  }
  async scrollChapter(direction: -1 | 1) {
    this.reflowAnchor = undefined;
    if (this.pageTurning) return;
    this.pageTurning = true;
    try {
      await this.enqueue(async () => {
        if (this.layoutMode === 'double') {
          const location = this.rendition.currentLocation() as unknown as Location;
          const first = location?.start?.displayed?.page, last = location?.end?.displayed?.page, total = location?.start?.displayed?.total;
          if (!first || !last || !total || (direction < 0 ? first <= 1 : last >= total)) return;
          this.clearSelection();
          const original = this.position;
          if (direction < 0) await this.rendition.prev(); else await this.rendition.next();
          await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
          if (this.destroyed) return;
          const next = this.rendition.currentLocation() as unknown as Location;
          // Keep these controls inside the chapter even for unusual EPUB layouts.
          if (original && next?.start?.href !== original.href) await this.displayStable(original.cfi);
          else this.reportPosition(next);
        } else {
          const container = this.host.querySelector<HTMLElement>('.epub-container');
          if (!container) return;
          const step = Math.max(48, Math.round(container.clientHeight * 0.12));
          container.scrollTop = Math.max(0, Math.min(container.scrollHeight - container.clientHeight, container.scrollTop + direction * step));
        }
      });
    } finally { this.pageTurning = false; }
  }
  clearSelection() {
    (this.rendition?.getContents() as unknown as Contents[] | undefined)?.forEach((c) => c.window.getSelection()?.removeAllRanges());
    this.events.selectionCleared();
  }

  async extractContext(position: ReadingPosition, selection: ContextSelectionInput | null): Promise<SurroundingText> {
    const anchor = selection ? 'selection' : 'position';
    const cfi = selection?.cfi ?? position.cfi, href = position.href;
    const unavailable = (reason: 'chapter_not_rendered' | 'anchor_not_found') => unavailableText(anchor, cfi, href, reason);
    if (this.destroyed || position.bookId !== this.record.id) return unavailable('chapter_not_rendered');
    if (selection && selection.href !== href) return unavailable('anchor_not_found');
    const contents = (this.rendition.getContents() as unknown as Contents[])
      .find((content) => this.book.spine.get(content.sectionIndex)?.href.split('#')[0] === href.split('#')[0]);
    if (!contents) return unavailable('chapter_not_rendered');
    try {
      if (new EpubCFI(cfi).spinePos !== contents.sectionIndex) return unavailable('anchor_not_found');
      const range = contents.range(cfi);
      return surroundingFromRange(contents.document, range, href, cfi, anchor, (range) => contents.cfiFromRange(range));
    } catch { return unavailable('anchor_not_found'); }
  }

  private async resolve(annotation: Annotation): Promise<string | null> {
    if (annotation.fingerprint !== this.record.fingerprint) return null;
    try {
      const range = await this.book.getRange(annotation.cfi);
      if (range && normalized(range.toString()) === normalized(annotation.quote)) return annotation.cfi;
    } catch { /* Try exact, unique quote matching in the original chapter only. */ }
    try {
      const section = this.book.spine.get(annotation.href) as Section;
      if (!section) return null;
      await section.load(this.book.load.bind(this.book));
      const range = rangeForUniqueQuote(section.document, annotation.quote);
      return range ? section.cfiFromRange(range) : null;
    } catch { return null; }
  }

  async showAnnotations(annotations: Annotation[]) {
    this.annotations = annotations;
    for (const item of this.renderedAnnotations.values()) this.rendition.annotations.remove(item.cfi, item.type);
    this.renderedAnnotations.clear(); this.unresolved.clear();
    for (const annotation of annotations) {
      const cfi = await this.resolve(annotation);
      if (this.destroyed) return;
      if (!cfi) { this.unresolved.add(annotation.id); continue; }
      const type = annotation.kind === 'note' ? 'underline' : 'highlight';
      const callback = (event: MouseEvent) => {
        this.events.annotationClicked(annotation, event?.clientX ?? this.host.getBoundingClientRect().left + 80, event?.clientY ?? 180);
      };
      if (type === 'underline') this.rendition.annotations.underline(cfi, { id: annotation.id }, callback, 'reader-note', { stroke: '#929780', 'stroke-width': '1.2', 'stroke-opacity': '0.8' });
      else this.rendition.annotations.highlight(cfi, { id: annotation.id }, callback, 'reader-highlight', { fill: this.activeSettings.theme === 'dark' ? '#87916a' : '#c5ca94', 'fill-opacity': '0.28', 'mix-blend-mode': 'multiply' });
      this.renderedAnnotations.set(annotation.id, { cfi, type });
    }
  }

  async openAnnotation(annotation: Annotation) {
    const cfi = await this.resolve(annotation);
    if (!cfi) throw new Error('这条笔记的原文位置暂无法恢复。摘录和笔记仍然保留。');
    await this.display(cfi);
  }

  destroy() {
    this.destroyed = true; clearTimeout(this.resizeTimer); this.resizeObserver?.disconnect();
    this.host.classList.remove('double-layout');
    this.rendition?.destroy(); this.book?.destroy(); this.host.innerHTML = '';
  }
}
