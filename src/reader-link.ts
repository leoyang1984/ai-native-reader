export interface ReaderLocation { bookId: string; fingerprint: string; noteId: string; cfi: string; href: string }
export type SourceLocation = Omit<ReaderLocation, 'noteId'>;

export function validateReaderLocation(location: SourceLocation): void {
  if (!/^[a-f0-9]{64}$/.test(location.bookId) || location.bookId !== location.fingerprint
      || location.cfi.length > 8192 || !location.cfi.startsWith('epubcfi(') || !location.cfi.endsWith(')')
      || !location.href || location.href.length > 2048 || location.href.startsWith('/') || location.href.includes(':')
      || location.href.split('/').includes('..') || /[\u0000-\u001f\u007f\\]/.test(location.href)) {
    throw new Error('Reader 链接中的书籍版本或原文位置无效。');
  }
}

/** URI links only navigate an already imported, fingerprint-matched book. */
export function parseReaderLink(raw: string): ReaderLocation {
  if (raw.length > 16_384) throw new Error('Reader 定位链接过长。');
  const url = new URL(raw);
  if (url.protocol !== 'ainativereader:' || url.hostname !== 'open' || (url.pathname && url.pathname !== '/')
      || url.username || url.password || url.port || url.hash) throw new Error('Reader 定位链接格式无效。');
  for (const key of ['book', 'fingerprint', 'cfi', 'href']) {
    if (url.searchParams.getAll(key).length !== 1) throw new Error('Reader 定位链接缺少必要信息。');
  }
  const location = { bookId: url.searchParams.get('book')!, fingerprint: url.searchParams.get('fingerprint')!,
    noteId: url.searchParams.get('note') ?? '', cfi: url.searchParams.get('cfi')!, href: url.searchParams.get('href')! };
  if (url.searchParams.getAll('note').length > 1 || (url.searchParams.has('note') && !/^[a-f0-9-]{36}$/i.test(location.noteId))
      || Array.from(url.searchParams.keys()).some(key => !['book', 'fingerprint', 'note', 'cfi', 'href'].includes(key))) {
    throw new Error('Reader 链接中的书籍版本或原文位置无效。');
  }
  validateReaderLocation(location);
  return location;
}
