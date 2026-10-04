import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ActivityClock, notesForDay, type Annotation } from '../src/models.ts';

test('time spent away or beyond the idle window does not inflate a reading session', () => {
  const clock = new ActivityClock(0);
  clock.tick(30_000);
  clock.foreground(false, 40_000);
  clock.tick(600_000);
  assert.equal(clock.seconds, 40);
  clock.foreground(true, 600_000);
  clock.tick(900_000);
  assert.equal(clock.seconds, 160); // Only 120 seconds after the last activity.
  clock.activity(901_000);
  clock.tick(911_000);
  assert.equal(clock.seconds, 170);
});

test('today uses creation time in the local day, not last edit time or highlights', () => {
  const annotation = (id: string, kind: Annotation['kind'], createdAt: string, updatedAt: string): Annotation => ({
    id, kind, createdAt, updatedAt, bookId: 'book', fingerprint: 'fingerprint', cfi: 'epubcfi(/6/2!/4/2/1:0)',
    href: 'chapter.xhtml', quote: 'original', body: 'thought', sessionId: 'session',
  });
  const day = new Date(2026, 9, 2, 12);
  const yesterday = new Date(2026, 9, 1, 22).toISOString();
  const today = new Date(2026, 9, 2, 8).toISOString();
  const later = new Date(2026, 9, 2, 18).toISOString();
  const notes = notesForDay([
    annotation('old-edited-today', 'note', yesterday, today),
    annotation('highlight', 'highlight', today, today),
    annotation('later', 'note', later, later),
    annotation('earlier', 'note', today, today),
  ], day);
  assert.deepEqual(notes.map((n) => n.id), ['earlier', 'later']);
});
