import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseReaderLink, validateReaderLocation } from '../src/reader-link.ts';

const source = { bookId: 'a'.repeat(64), fingerprint: 'a'.repeat(64), cfi: 'epubcfi(/6/2!/4/2/1:0)', href: 'chapter.xhtml' };
function link(note?: string) {
  const params = new URLSearchParams({ book: source.bookId, fingerprint: source.fingerprint, cfi: source.cfi, href: source.href });
  if (note !== undefined) params.set('note', note);
  return `ainativereader://open?${params}`;
}
test('history location links do not require a note', () => {
  assert.deepEqual(parseReaderLink(link()), { ...source, noteId: '' });
});
test('existing note links retain their stable note identity', () => {
  const note = '12345678-1234-1234-1234-123456789abc';
  assert.equal(parseReaderLink(link(note)).noteId, note);
});
test('ambiguous, unknown and malformed link fields are rejected', () => {
  for (const raw of [link() + '&book=' + source.bookId, link() + '&extra=1', link(''), link('invalid'), link() + '#fragment', link().replace('://open', '://other')]) {
    assert.throws(() => parseReaderLink(raw));
  }
});
test('source validation rejects wrong versions and unsafe chapter paths', () => {
  assert.throws(() => validateReaderLocation({ ...source, fingerprint: 'b'.repeat(64) }));
  for (const href of ['/chapter.xhtml', '../chapter.xhtml', 'https://example.com', 'chapter\u007f.xhtml', 'chapter\\one.xhtml', 'x'.repeat(2049)]) {
    assert.throws(() => validateReaderLocation({ ...source, href }));
  }
  assert.throws(() => validateReaderLocation({ ...source, cfi: 'epubcfi(' + 'x'.repeat(8192) + ')' }));
});
