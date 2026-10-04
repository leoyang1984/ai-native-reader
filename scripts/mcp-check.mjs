import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ReaderMcpClient } from './lib/mcp-client.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const mode = process.argv[2] ?? '--live';
if (!['--live', '--offline', '--legacy', '--navigate', '--draft', '--invalid-location', '--empty'].includes(mode)) {
  console.error('用法：npm run mcp:check -- [--live|--offline|--legacy|--navigate|--draft|--invalid-location|--empty]'); process.exit(1);
}
const bookId = createHash('sha256').update(readFileSync(join(root, 'public/samples/reader-lab.epub'))).digest('hex');
const emptyDirectory = mode === '--empty' ? mkdtempSync('/private/tmp/ainr-mcp-empty-') : null;
const client = new ReaderMcpClient(join(root, 'src-tauri/target/debug/bundle/macos/AI Native Reader.app/Contents/MacOS/ai-native-reader'),
  { protocolVersion: mode === '--legacy' ? '2024-11-05' : '2025-06-18', env: emptyDirectory ? { AINATIVE_READER_DATA_DIR: emptyDirectory } : {} });
let checks = 0;
const check = (condition, label) => { assert.ok(condition, label); checks++; };
try {
  await assert.rejects(client.request('tools/list'), /initialization/); checks++;
  const initialized = await client.initialize();
  check(initialized.protocolVersion === (mode === '--legacy' ? '2024-11-05' : '2025-06-18'), 'protocol negotiation');
  await client.request('ping'); checks++;
  const catalog = await client.request('tools/list');
  check(catalog.tools.length === 8, 'eight tools');
  const context = await client.call('get_current_context');
  if (mode === '--empty') {
    check(context.current === null && context.lastKnownReading === null && context.availability === 'not_running', 'empty installation');
    for (const name of ['get_notes', 'get_highlights', 'search_notes', 'get_reading_history']) {
      const page = await client.call(name, name === 'search_notes' ? { query: 'sample' } : {});
      check(page.items.length === 0 && page.nextCursor === null && page.schemaVersion === 1, 'empty page');
    }
    await assert.rejects(client.call('get_notes', { bookId }), /未导入/); checks++;
    await assert.rejects(client.call('get_notes', { cursor: 'invalid' }), /游标/); checks++;
    check(readdirSync(emptyDirectory).length === 0, 'MCP must not create a database or files');
    console.log(JSON.stringify({ mode, checks, result: 'passed', protocolVersion: initialized.protocolVersion }));
    client.close(); rmdirSync(emptyDirectory); process.exit(0);
  }
  if (mode === '--offline') {
    check(context.availability === 'not_running' && context.current === null && context.isStale, 'offline context is historical');
    check(context.lastKnownReading?.book.id === bookId, 'sample history retained');
    await assert.rejects(client.call('open_location', { bookId, fingerprint: bookId, cfi: 'epubcfi(/6/2!/4/2/1:0)', href: 'chapter1.xhtml' }), /未运行/); checks++;
  } else {
    check(context.availability === 'live' && context.current?.status === 'reading', 'live reading');
    check(context.current.book.id === bookId, 'open project sample before checking');
    check(context.current.textState === 'ready', 'bounded text extracted');
    for (const passage of Object.values(context.current.surrounding ?? {})) {
      if (passage && typeof passage === 'object') check(passage.text.length <= 1200 && passage.href === context.current.location.href, 'passage source and limit');
    }
    const source = { bookId, fingerprint: bookId, cfi: context.current.location.cfi, href: context.current.location.href };
    if (mode === '--draft') {
      await assert.rejects(client.call('open_location', source), /草稿|保存|取消/); checks++;
    } else if (mode === '--invalid-location') {
      await assert.rejects(client.call('open_location', { ...source, href: 'missing-chapter.xhtml' }), /章节|位置/); checks++;
      await assert.rejects(client.call('open_location', { ...source, cfi: 'epubcfi(/6/2!/4/99999/1:999999)' }), /章节|位置/); checks++;
      const unchanged = await client.call('get_current_context');
      check(unchanged.current?.book.id === bookId && unchanged.current?.location.href === source.href && unchanged.current?.session.id === context.current.session.id, 'invalid navigation preserves reading');
    } else {
      const book = await client.call('get_current_book');
      check(book.book.id === bookId && book.contextVersion.instanceId === context.current.instanceId, 'current book source');
      const surrounding = await client.call('get_surrounding_text');
      check(surrounding.context.current.book.id === bookId, 'current surrounding source');
      const explicit = await client.call('get_surrounding_text', source);
      check(explicit.location.cfi === source.cfi && explicit.book.id === bookId, 'explicit surrounding source');
      if (mode === '--navigate') {
        const opened = await client.call('open_location', source);
        check(opened.opened && opened.context.current.book.id === bookId && opened.context.current.location.href === source.href, 'navigation receipt');
      }
    }
  }
  for (const name of ['get_notes', 'get_highlights', 'get_reading_history']) {
    let cursor, previous, count = 0;
    const ids = new Set();
    do {
      const args = { bookId, limit: 1, ...(cursor ? { cursor } : {}) };
      const page = await client.call(name, args);
      check(page.schemaVersion === 1 && page.source === 'reader_database', 'page contract');
      check(page.items.length <= 1, 'page limit');
      for (const item of page.items) {
        const record = item.annotation ?? item.session;
        check(item.book.id === bookId && record.bookId === bookId && !ids.has(record.id), 'page provenance and no duplicates');
        const key = [record.createdAt ?? record.startedAt, record.id].join('|');
        if (previous) check(key < previous, 'descending keyset order');
        previous = key; ids.add(record.id);
        if (item.annotation) {
          check(item.annotation.quote.length <= 4000 && item.annotation.body.length <= 16000 && item.readerUrl.startsWith('ainativereader://open?'), 'annotation limits and link');
          if (item.readingSession) check(item.readingSession.id === record.sessionId && item.readingSession.bookId === bookId, 'session association');
          if (name === 'get_notes' && count === 0) {
            const query = Array.from(record.body).slice(0, 8).join('');
            const search = await client.call('search_notes', { bookId, query });
            check(search.items.some(hit => hit.annotation.id === record.id && hit.searchMatch.bodyExcerpt?.includes(query)), 'literal search and matching excerpt');
          }
        } else {
          for (const [location, url] of [[item.startLocation, item.startReaderUrl], [item.endLocation, item.endReaderUrl]]) {
            if (location) check(location.bookId === bookId && location.fingerprint === bookId && !!location.cfi && !!location.href && url?.startsWith('ainativereader://open?'), 'historical location source and link');
            else check(url === null, 'missing history has no invented link');
          }
        }
        count++;
      }
      cursor = page.nextCursor;
    } while (cursor && count < 8);
  }
  await assert.rejects(client.call('get_notes', { bookId, cursor: 'invalid' }), /游标/); checks++;
  await assert.rejects(client.call('search_notes', { bookId, query: '' }), /查询|范围/); checks++;
  console.log(JSON.stringify({ mode, checks, result: 'passed', protocolVersion: initialized.protocolVersion }));
} catch (error) { console.error(`${mode} failed: ${error.message}`); process.exitCode = 1; }
finally { client.close(); if (emptyDirectory && readdirSync(emptyDirectory).length === 0) rmdirSync(emptyDirectory); }
