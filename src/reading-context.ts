import type { BookRecord, ReadingPosition, ReadingSession } from './models';

export const CONTEXT_SCHEMA_VERSION = 1 as const;
export const CONTEXT_MAX_AGE_MS = 30_000;
export const CONTEXT_LIMITS = { selection: 4_000, before: 1_200, focus: 1_200, after: 1_200, chapter: 1_000_000, nodes: 100_000 } as const;

export type ContextView = 'library' | 'reader' | 'session' | 'reflect';
export type ContextStatus = 'no_book' | 'opening' | 'reading' | 'not_reading';
export interface ContextBook { id: string; fingerprint: string; title: string; author: string; language: string }
export interface ContextLocation { cfi: string; href: string; chapterLabel: string; percent: number | null }
/** characters counts UTF-16 code units, as do DOM Range offsets. CFI covers the original range when truncated. */
export interface ContextExcerpt { cfi: string; href: string; text: string; characters: number; truncated: boolean }
export interface ContextSelectionInput { cfi: string; href: string; text: string }
export type TextUnavailableReason = 'chapter_not_rendered' | 'anchor_not_found' | 'chapter_limit';
export interface SurroundingText {
  anchor: 'position' | 'selection';
  anchorCfi: string;
  href: string;
  before: ContextExcerpt | null;
  focus: ContextExcerpt | null;
  after: ContextExcerpt | null;
  unavailableReason: TextUnavailableReason | null;
}
export interface ContextSession { id: string; startedAt: string; updatedAt: string; activeSeconds: number }
export interface ReadingContext {
  schemaVersion: typeof CONTEXT_SCHEMA_VERSION;
  instanceId: string;
  revision: number;
  capturedAt: string;
  status: ContextStatus;
  view: ContextView;
  foreground: boolean;
  book: ContextBook | null;
  location: ContextLocation | null;
  session: ContextSession | null;
  selection: ContextExcerpt | null;
  textState: 'pending' | 'ready' | 'unavailable' | 'not_applicable';
  surrounding: SurroundingText | null;
}
export interface ReadingContextSnapshot {
  schemaVersion: typeof CONTEXT_SCHEMA_VERSION;
  source: 'runtime' | 'persisted';
  availability: 'live' | 'stale' | 'initializing' | 'not_running';
  observedAt: string;
  isStale: boolean;
  maxAgeMs: number;
  current: ReadingContext | null;
  lastKnownReading: ReadingContext | null;
}
export interface ContextInput {
  status: ContextStatus;
  view: ContextView;
  foreground: boolean;
  book: BookRecord | null;
  position: ReadingPosition | null;
  session: ReadingSession | null;
  selection: ContextSelectionInput | null;
}
export interface ContextRepository {
  beginContext(instanceId: string): Promise<void>;
  publishContext(context: ReadingContext): Promise<void>;
  readingContext(): Promise<ReadingContextSnapshot>;
  savedReadingContext(): Promise<ReadingContextSnapshot>;
}

export function boundedText(text: string, limit: number): string {
  let end = Math.min(text.length, limit);
  if (end < text.length && end > 0 && /[\uD800-\uDBFF]/.test(text[end - 1])) end--;
  return text.slice(0, end);
}
export function boundedSelection(selection: ContextSelectionInput): ContextExcerpt {
  const text = boundedText(selection.text, CONTEXT_LIMITS.selection);
  return { cfi: selection.cfi, href: selection.href, text, characters: text.length, truncated: text.length < selection.text.length };
}

export type CapturedContext<T> = T extends object ? { readonly [K in keyof T]: CapturedContext<T[K]> } : T;

function freeze<T>(value: T): T {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}
/** Call once at request start; keep this object for every part of that request. */
export async function captureReadingContext(repository: ContextRepository): Promise<CapturedContext<ReadingContextSnapshot>> {
  return freeze(structuredClone(await repository.readingContext()));
}

/** Captures detached values; an async completion cannot replace a newer location or selection. */
export class ReadingContextService {
  readonly instanceId = crypto.randomUUID();
  private revision = 0;
  private generation = 0;
  private current: ReadingContext | null = null;
  private lastKnownReading: ReadingContext | null = null;
  private extracting: Promise<void> = Promise.resolve();
  private sending: Promise<void> = Promise.resolve();
  private changedAt = 0;

  constructor(private readonly publish: (context: ReadingContext) => Promise<void>, private readonly onError: (error: unknown) => void) {}

  update(input: ContextInput, extract?: () => Promise<SurroundingText>): void {
    const generation = ++this.generation;
    this.extracting = Promise.resolve();
    const book = input.book && { id: input.book.id, fingerprint: input.book.fingerprint, title: boundedText(input.book.title, 4_096), author: boundedText(input.book.author, 4_096), language: boundedText(input.book.language, 256) };
    const location = input.position && { cfi: input.position.cfi, href: input.position.href, chapterLabel: boundedText(input.position.chapterLabel, 4_096), percent: input.position.percent };
    const session = input.session && { id: input.session.id, startedAt: input.session.startedAt, updatedAt: input.session.updatedAt, activeSeconds: input.session.activeSeconds };
    const reading = input.status === 'reading';
    const context: ReadingContext = { schemaVersion: CONTEXT_SCHEMA_VERSION, instanceId: this.instanceId, revision: 0, capturedAt: '',
      status: input.status, view: input.view, foreground: input.foreground, book, location, session,
      selection: reading && input.selection ? boundedSelection(input.selection) : null,
      textState: reading ? extract ? 'pending' : 'unavailable' : 'not_applicable', surrounding: null };
    this.accept(context);
    if (reading && extract) {
      this.extracting = extract().then((surrounding) => {
        if (generation !== this.generation) return;
        this.accept({ ...context, textState: surrounding.unavailableReason ? 'unavailable' : 'ready', surrounding });
      }).catch((error) => {
        if (generation !== this.generation) return;
        this.accept({ ...context, textState: 'unavailable' }); this.onError(error);
      });
    }
  }

  private accept(value: ReadingContext) {
    const context = freeze(structuredClone({ ...value, revision: ++this.revision, capturedAt: new Date().toISOString() }));
    this.current = context; this.changedAt = performance.now();
    if (context.status === 'reading' && context.textState !== 'pending') this.lastKnownReading = context;
    this.sending = this.sending.catch(() => undefined).then(() => this.publish(context)).catch(this.onError);
  }
  /** Refresh liveness without rereading or changing the excerpt captured at this location. */
  refresh() { if (this.current) this.accept(this.current); }
  snapshot(): ReadingContextSnapshot {
    const stale = !this.current || performance.now() - this.changedAt > CONTEXT_MAX_AGE_MS;
    return freeze(structuredClone({ schemaVersion: CONTEXT_SCHEMA_VERSION, source: 'runtime', availability: this.current ? stale ? 'stale' : 'live' : 'initializing',
      observedAt: new Date().toISOString(), isStale: stale, maxAgeMs: CONTEXT_MAX_AGE_MS,
      current: stale ? null : this.current, lastKnownReading: this.lastKnownReading }));
  }
  async capture(): Promise<ReadingContextSnapshot> {
    for (;;) {
      const generation = this.generation;
      await this.extracting;
      const revision = this.revision;
      await this.sending;
      if (generation === this.generation && revision === this.revision) return this.snapshot();
    }
  }
  async flush() { await this.extracting; await this.sending; }
}
