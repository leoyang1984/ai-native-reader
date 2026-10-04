import { CONTEXT_MAX_AGE_MS, CONTEXT_SCHEMA_VERSION, type ReadingContext, type ReadingContextSnapshot } from './reading-context';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { defaultSettings, type Annotation, type BookRecord, type ReaderRepository, type ReaderSettings, type ReadingPosition, type ReadingSession, type Snapshot, type VaultExport, type VaultState } from './models';

class DesktopRepository implements ReaderRepository {
  beginContext(instanceId: string) { return invoke<void>('begin_reading_context', { instanceId }); }
  publishContext(context: ReadingContext) { return invoke<void>('publish_reading_context', { context }); }
  readingContext() { return invoke<ReadingContextSnapshot>('get_reading_context'); }
  savedReadingContext() { return invoke<ReadingContextSnapshot>('get_saved_reading_context'); }
  snapshot() { return invoke<Snapshot>('snapshot'); }
  importBook(book: BookRecord, _bytes: ArrayBuffer, sourcePath?: string) {
    if (!sourcePath) throw new Error('请从文件选择器或拖入导入 EPUB。');
    return sourcePath === ':sample:' ? invoke<void>('import_sample', { book }) : invoke<void>('import_book', { book, sourcePath });
  }
  loadBook(id: string) { return invoke<ArrayBuffer>('load_book', { id }); }
  savePosition(position: ReadingPosition) { return invoke<void>('save_position', { position }); }
  saveAnnotation(annotation: Annotation) { return invoke<void>('save_annotation', { annotation }); }
  deleteAnnotation(id: string) { return invoke<void>('delete_annotation', { id }); }
  saveSession(session: ReadingSession) { return invoke<void>('save_session', { session }); }
  saveSettings(settings: ReaderSettings) { return invoke<void>('save_settings', { settings }); }
  vaultState() { return invoke<VaultState>('vault_state'); }
  configureVault(path: string | null) { return invoke<VaultState>('configure_vault', { path }); }
  exportNote(id: string) { return invoke<VaultExport>('export_note', { id }); }
  openExport(id: string, copy: boolean) { return invoke<void>('open_export', { id, copy }); }
}

/** Browser development uses isolated IndexedDB; the desktop version always uses SQLite. */
class BrowserRepository implements ReaderRepository {
  private db: Promise<IDBDatabase>;
  private contextInstance: string | null = null;
  private currentContext: ReadingContext | null = null;
  private receivedAt = 0;
  private lastKnownReading: ReadingContext | null = null;
  async beginContext(instanceId: string) {
    this.contextInstance = instanceId; this.currentContext = null;
    this.lastKnownReading = (await this.savedReadingContext()).lastKnownReading;
  }
  async publishContext(context: ReadingContext) {
    if (context.instanceId !== this.contextInstance || (this.currentContext && context.revision <= this.currentContext.revision)) throw new Error('旧的阅读上下文已失效。');
    this.currentContext = structuredClone(context); this.receivedAt = performance.now();
    if (context.status === 'reading' && context.textState !== 'pending') {
      this.lastKnownReading = structuredClone(context);
      await this.write('settings', 'reading_context_v1', context);
    }
  }
  async readingContext(): Promise<ReadingContextSnapshot> {
    const fresh = !!this.currentContext && performance.now() - this.receivedAt <= CONTEXT_MAX_AGE_MS;
    return structuredClone({ schemaVersion: CONTEXT_SCHEMA_VERSION, source: 'runtime', availability: this.currentContext ? fresh ? 'live' : 'stale' : 'initializing',
      observedAt: new Date().toISOString(), isStale: !fresh, maxAgeMs: CONTEXT_MAX_AGE_MS,
      current: fresh ? this.currentContext : null, lastKnownReading: this.lastKnownReading });
  }
  async savedReadingContext(): Promise<ReadingContextSnapshot> {
    const saved = await this.read<ReadingContext | undefined>('settings', 'reading_context_v1');
    return { schemaVersion: CONTEXT_SCHEMA_VERSION, source: 'persisted', availability: 'stale', observedAt: new Date().toISOString(), isStale: true,
      maxAgeMs: CONTEXT_MAX_AGE_MS, current: null, lastKnownReading: saved?.schemaVersion === CONTEXT_SCHEMA_VERSION && saved.status === 'reading' && saved.textState !== 'pending' ? saved : null };
  }
  constructor() {
    this.db = new Promise((resolve, reject) => {
      const request = indexedDB.open('ai-native-reader-m1', 1);
      request.onupgradeneeded = () => {
        const db = request.result;
        for (const name of ['books', 'files', 'positions', 'annotations', 'sessions', 'settings', 'deletedAnnotations']) db.createObjectStore(name);
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(new Error('浏览器本地存储无法打开。请允许站点使用本地数据。'));
    });
  }
  private async read<T>(store: string, key?: string): Promise<T> {
    const db = await this.db;
    return new Promise((resolve, reject) => {
      const tx = db.transaction(store, 'readonly');
      const request = key ? tx.objectStore(store).get(key) : tx.objectStore(store).getAll();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }
  private async write(store: string, key: string, value: unknown) {
    const db = await this.db;
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(store, 'readwrite');
      tx.objectStore(store).put(value, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error ?? new Error('本地保存未完成。'));
    });
  }
  async snapshot(): Promise<Snapshot> {
    const [books, positions, annotations, sessions, settings] = await Promise.all([
      this.read<BookRecord[]>('books'), this.read<ReadingPosition[]>('positions'), this.read<Annotation[]>('annotations'),
      this.read<ReadingSession[]>('sessions'), this.read<ReaderSettings | undefined>('settings', 'reader'),
    ]);
    return { books, positions, annotations, sessions, settings: { ...defaultSettings, ...settings }, vault: null, exports: [] };
  }
  async importBook(book: BookRecord, bytes: ArrayBuffer) {
    const db = await this.db;
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(['books', 'files'], 'readwrite');
      tx.objectStore('books').put(book, book.id);
      tx.objectStore('files').put(bytes, book.id);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  }
  async loadBook(id: string) {
    const bytes = await this.read<ArrayBuffer | undefined>('files', id);
    if (!bytes) throw new Error('书籍文件缺失。请重新导入同一 EPUB 文件。');
    return bytes;
  }
  savePosition(value: ReadingPosition) { return this.write('positions', value.bookId, value); }
  saveAnnotation(value: Annotation) { return this.write('annotations', value.id, value); }
  async deleteAnnotation(id: string) {
    const db = await this.db;
    const annotation = await this.read<Annotation>('annotations', id);
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(['annotations', 'deletedAnnotations'], 'readwrite');
      tx.objectStore('deletedAnnotations').put({ annotation, deletedAt: new Date().toISOString() }, id);
      tx.objectStore('annotations').delete(id);
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(tx.error);
      tx.onerror = () => reject(tx.error);
    });
  }
  saveSession(value: ReadingSession) { return this.write('sessions', value.id, value); }
  saveSettings(value: ReaderSettings) { return this.write('settings', 'reader', value); }
  async vaultState(): Promise<VaultState> { return { config: null, exports: [] }; }
  async configureVault(_path: string | null): Promise<VaultState> { throw new Error('Vault 导出请在 Mac 应用中使用。'); }
  async exportNote(_id: string): Promise<VaultExport> { throw new Error('Vault 导出请在 Mac 应用中使用。'); }
  async openExport(_id: string, _copy: boolean): Promise<void> { throw new Error('打开 Obsidian 请在 Mac 应用中使用。'); }
}

export const desktop = isTauri();
export function createRepository(): ReaderRepository { return desktop ? new DesktopRepository() : new BrowserRepository(); }
export async function readDesktopFile(path: string): Promise<ArrayBuffer> { return invoke<ArrayBuffer>('read_import_file', { path }); }
