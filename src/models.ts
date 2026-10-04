import type { ContextRepository } from './reading-context';

export interface BookRecord {
  id: string;
  fingerprint: string;
  title: string;
  author: string;
  language: string;
  cover: string | null;
  importedAt: string;
}

export interface ReadingPosition {
  bookId: string;
  cfi: string;
  href: string;
  chapterLabel: string;
  percent: number | null;
  updatedAt: string;
}

export interface Annotation {
  id: string;
  bookId: string;
  fingerprint: string;
  cfi: string;
  href: string;
  quote: string;
  kind: 'highlight' | 'note';
  body: string;
  sessionId: string;
  createdAt: string;
  updatedAt: string;
  chapterLabel?: string;
  createdBy?: 'human';
}

export interface VaultConfig { path: string }
export interface VaultExport {
  noteId: string;
  vaultPath: string;
  relativePath: string;
  contentHash: string | null;
  sourceHash: string | null;
  exportedAt: string | null;
  status: 'pending' | 'synced' | 'conflict' | 'failed';
  message: string | null;
  conflictPath: string | null;
  backupPath: string | null;
}
export interface VaultState { config: VaultConfig | null; exports: VaultExport[] }

export interface ReadingSession {
  id: string;
  bookId: string;
  startedAt: string;
  endedAt: string | null;
  activeSeconds: number;
  updatedAt: string;
  startCfi: string;
  endCfi: string;
  /** Optional for sessions written before M3-03; never infer from the book's current position. */
  startPosition?: ReadingPosition | null;
  endPosition?: ReadingPosition | null;
}

export interface ReaderSettings {
  fontSize: number;
  lineHeight: number;
  theme: 'light' | 'dark';
  columns: 'single' | 'double';
  lastBookId: string | null;
}

export interface Snapshot {
  books: BookRecord[];
  positions: ReadingPosition[];
  annotations: Annotation[];
  sessions: ReadingSession[];
  settings: ReaderSettings;
  vault: VaultConfig | null;
  exports: VaultExport[];
}

export const defaultSettings: ReaderSettings = {
  fontSize: 19, lineHeight: 1.8, theme: 'light', columns: 'single', lastBookId: null,
};

export interface ReaderRepository extends ContextRepository {
  snapshot(): Promise<Snapshot>;
  importBook(book: BookRecord, bytes: ArrayBuffer, sourcePath?: string): Promise<void>;
  loadBook(id: string): Promise<ArrayBuffer>;
  savePosition(position: ReadingPosition): Promise<void>;
  saveAnnotation(annotation: Annotation): Promise<void>;
  deleteAnnotation(id: string): Promise<void>;
  saveSession(session: ReadingSession): Promise<void>;
  saveSettings(settings: ReaderSettings): Promise<void>;
  vaultState(): Promise<VaultState>;
  configureVault(path: string | null): Promise<VaultState>;
  exportNote(id: string): Promise<VaultExport>;
  openExport(id: string, copy: boolean): Promise<void>;
}

/** Counts only foreground time within the idle window, even after a suspended timer. */
export class ActivityClock {
  private lastTick: number;
  private lastActivity: number;
  private active = true;
  seconds = 0;
  constructor(now: number, private readonly idleMs = 120_000) {
    this.lastTick = this.lastActivity = now;
  }
  tick(now: number): number {
    if (this.active) {
      this.seconds += Math.max(0, Math.min(now, this.lastActivity + this.idleMs) - this.lastTick) / 1000;
    }
    this.lastTick = now;
    return this.seconds;
  }
  activity(now: number) { this.tick(now); this.lastActivity = now; }
  foreground(active: boolean, now: number) { this.tick(now); this.active = active; if (active) this.lastActivity = now; }
}

export function notesForDay(annotations: Annotation[], day: Date): Annotation[] {
  return annotations.filter((a) => a.kind === 'note' && new Date(a.createdAt).toDateString() === day.toDateString())
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}
