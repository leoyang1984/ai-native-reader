import { CONTEXT_LIMITS, type ContextExcerpt, type SurroundingText, type TextUnavailableReason } from './reading-context';

interface Part { node: Text; start: number; end: number }
interface TextIndex { parts: Part[]; text: string; limited: boolean }
const indexes = new WeakMap<Document, TextIndex>();

function indexDocument(doc: Document): TextIndex {
  const cached = indexes.get(doc); if (cached) return cached;
  const body = doc.body;
  const parts: Part[] = []; const chunks: string[] = [];
  let length = 0, nodes = 0, limited = false;
  if (!body) return { parts, text: '', limited };
  const visibility = new WeakMap<Element, boolean>();
  function readable(element: Element | null): boolean {
    if (!element || element === body) return true;
    const cached = visibility.get(element); if (cached !== undefined) return cached;
    const style = doc.defaultView?.getComputedStyle(element);
    const result = !/^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE|SVG)$/.test(element.localName.toUpperCase()) && !element.hasAttribute('hidden')
      && element.getAttribute('aria-hidden') !== 'true' && style?.display !== 'none' && style?.visibility !== 'hidden' && readable(element.parentElement);
    visibility.set(element, result); return result;
  }
  const walker = doc.createTreeWalker(body, NodeFilter.SHOW_TEXT);
  let item: Node | null;
  while ((item = walker.nextNode())) {
    if (++nodes > CONTEXT_LIMITS.nodes) { limited = true; break; }
    if (!readable(item.parentElement)) continue;
    const text = item as Text;
    if (!text.length) continue;
    if (length + text.length > CONTEXT_LIMITS.chapter) { limited = true; break; }
    parts.push({ node: text, start: length, end: length + text.length }); chunks.push(text.data); length += text.length;
  }
  const index = { parts, text: chunks.join(''), limited }; indexes.set(doc, index); return index;
}

export function invalidateContextText(doc: Document) { indexes.delete(doc); }

function offsetOf(index: TextIndex, boundary: Range): number | null {
  if (boundary.startContainer.nodeType === Node.TEXT_NODE) {
    const part = index.parts.find((part) => part.node === boundary.startContainer);
    return part ? part.start + boundary.startOffset : null;
  }
  for (const part of index.parts) {
    // For an element boundary, find the first readable text at or after it.
    if (boundary.comparePoint(part.node, 0) >= 0) return part.start;
  }
  return index.limited ? null : index.text.length;
}
function rangeAt(doc: Document, index: TextIndex, start: number, end: number): Range | null {
  const first = index.parts.find((p) => p.end > start);
  const last = index.parts.find((p) => p.end >= end && p.start < end);
  if (!first || !last || start >= end) return null;
  const range = doc.createRange(); range.setStart(first.node, start - first.start); range.setEnd(last.node, end - last.start); return range;
}
function excerpt(doc: Document, index: TextIndex, start: number, end: number, href: string, cfiFromRange: (range: Range) => string, truncated: boolean): ContextExcerpt | null {
  // DOM offsets use UTF-16. Do not cut an emoji between its surrogate halves.
  if (start > 0 && /[\uDC00-\uDFFF]/.test(index.text[start])) start++;
  if (end < index.text.length && end > 0 && /[\uD800-\uDBFF]/.test(index.text[end - 1])) end--;
  const range = rangeAt(doc, index, start, end); if (!range) return null;
  const text = index.text.slice(start, end);
  return text.trim() ? { cfi: cfiFromRange(range), href, text, characters: text.length, truncated } : null;
}
export function unavailableText(anchor: 'position' | 'selection', anchorCfi: string, href: string, reason: TextUnavailableReason): SurroundingText {
  return { anchor, anchorCfi, href, before: null, focus: null, after: null, unavailableReason: reason };
}
/** Read only the displayed chapter. Returned passages carry their own precise CFI ranges. */
export function surroundingFromRange(doc: Document, range: Range, href: string, anchorCfi: string, anchor: 'position' | 'selection', cfiFromRange: (range: Range) => string): SurroundingText {
  if (!doc.body?.contains(range.startContainer) || !doc.body.contains(range.endContainer)) return unavailableText(anchor, anchorCfi, href, 'anchor_not_found');
  const index = indexDocument(doc);
  const first = range.cloneRange(); first.collapse(true);
  const last = range.cloneRange(); last.collapse(false);
  const start = offsetOf(index, first), selectedEnd = offsetOf(index, last);
  if (start === null || selectedEnd === null) return unavailableText(anchor, anchorCfi, href, index.limited ? 'chapter_limit' : 'anchor_not_found');
  if (start >= index.text.length || selectedEnd < start) return unavailableText(anchor, anchorCfi, href, index.limited ? 'chapter_limit' : 'anchor_not_found');
  const focusEnd = anchor === 'selection' && selectedEnd > start ? Math.min(selectedEnd, start + CONTEXT_LIMITS.focus) : Math.min(index.text.length, start + CONTEXT_LIMITS.focus);
  const afterStart = anchor === 'selection' ? Math.max(selectedEnd, focusEnd) : focusEnd;
  const focus = excerpt(doc, index, start, focusEnd, href, cfiFromRange, anchor === 'selection' ? selectedEnd > focusEnd : index.limited || focusEnd < index.text.length);
  if (!focus) return unavailableText(anchor, anchorCfi, href, 'anchor_not_found');
  return { anchor, anchorCfi, href,
    before: excerpt(doc, index, Math.max(0, start - CONTEXT_LIMITS.before), start, href, cfiFromRange, start > CONTEXT_LIMITS.before),
    focus,
    after: excerpt(doc, index, afterStart, Math.min(index.text.length, afterStart + CONTEXT_LIMITS.after), href, cfiFromRange, index.limited || afterStart + CONTEXT_LIMITS.after < index.text.length),
    unavailableReason: null };
}
