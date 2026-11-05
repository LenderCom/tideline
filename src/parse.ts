import { alignOf, isDelimiterRow, parseInline, splitTableRow, type Inline, type TableAlign } from './inline.js';
import type { GrammarOptions } from './plugin.js';

/**
 * The page parser: the inline grammar (`inline.ts`) plus what a long-form page needs. It produces a token tree, never an
 * HTML string. The only URLs it emits are `https://` links, `#anchor` links into the same page, `[[page]]` links the
 * renderer resolves, and `attachment:<id>` references.
 *
 * On top of the inline grammar:
 *  · `## Title {#anchor}` heading ids, else a slug of the text;
 *  · nested lists, with GitHub task items (`- [ ]`, `- [x]`) as their own state;
 *  · `:::note` / `:::tip` / `:::warning` / `:::danger` callouts, with an optional title, closed by `:::`;
 *  · `[[page]]`, `[[path/to/page|label]]` page links;
 *  · `![alt](attachment:<id>)` and `![alt](https://…)` images;
 *  · `[label](attachment:<id>)` links to a file your application holds, read as a `link` whose `href` is the reference;
 *  · `[text](#anchor)` links within the page.
 * A ```` ```mermaid ```` fence is a code block with that language; the codec opens it as a `mermaid` node. Front matter
 * at the very start of a body is a code block too, with the language `FRONT_MATTER_LANG`, so its text is kept verbatim.
 * Quotes, callouts and list items nest `MAX_BLOCK_DEPTH` deep; a line that would open one more reads as text.
 */

/** One inline run: the inline grammar's tokens, plus the ones only a page carries. */
export type DocInline<X = never> =
  | Inline<X>
  /** `![alt](src)`: `src` is `attachment:<id>` or an `https://` URL. */
  | { kind: 'image'; src: string; alt: string }
  /** `[text](#anchor)`: a jump to a heading on the same page. */
  | { kind: 'anchorLink'; anchor: string; text: string };

export type DocCalloutKind = 'note' | 'tip' | 'warning' | 'danger';

export interface DocListItem<X = never> {
  inline: DocInline<X>[];
  /** A task item's state; absent on a plain item. */
  checked?: boolean;
  /** Blocks nested under the item: a sub-list, a fence, a further paragraph. */
  children: DocBlock<X>[];
}

export type DocBlock<X = never> =
  /** `source` is the paragraph's markdown as the body holds it. */
  | { kind: 'paragraph'; inline: DocInline<X>[]; source: string }
  | { kind: 'code'; lang?: string; text: string }
  | { kind: 'list'; ordered: boolean; start?: number; items: DocListItem<X>[] }
  /**
   * `id` is the heading's anchor on the page: `anchor` when the writer pinned one with `{#…}`, else a slug of the text,
   * de-duplicated. `anchor` is kept apart so the codec writes back only what the author pinned.
   */
  | { kind: 'heading'; level: number; id: string; anchor?: string; inline: DocInline<X>[] }
  | { kind: 'quote'; blocks: DocBlock<X>[] }
  | { kind: 'callout'; callout: DocCalloutKind; title?: string; blocks: DocBlock<X>[] }
  | { kind: 'table'; align: TableAlign[]; header: DocInline<X>[][]; rows: DocInline<X>[][][] }
  | { kind: 'divider' };

const FENCE_LINE = /^\s*```(.*)$/;
const LIST_ITEM = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
const HEADING_LINE = /^ {0,3}(#{1,6})[ \t]+(.*)$/;
const HEADING_ANCHOR = /\s*\{#([A-Za-z0-9][A-Za-z0-9._-]*)\}\s*$/;
const BLOCKQUOTE_LINE = /^ {0,3}> ?(.*)$/;
const THEMATIC_BREAK = /^ {0,3}(?:-{3,}|\*{3,}|_{3,})[ \t]*$/;
const CALLOUT_OPEN = /^ {0,3}:::\s*([A-Za-z]+)\s*(.*)$/;
const CALLOUT_CLOSE = /^ {0,3}:::\s*$/;
const TASK_MARKER = /^\[( |x|X)\]\s+/;
/** How far a line is indented to read as code, once it is not carrying on a paragraph. */
const CODE_INDENT = 4;
/**
 * How many quotes, callouts and list items may enclose a block, so a pathological body cannot overflow the stack of
 * whatever walks the tree, this parser first. The same depth the inline grammar allows emphasis. Inside that many, a line
 * that would open one more reads as paragraph text where it stands: its `>`, list marker or `:::` is literal.
 */
export const MAX_BLOCK_DEPTH = 32;

/**
 * A fenced-code line that would end its block early, a fence or a `:::` line, is written behind a zero-width space; one
 * that already starts with zero-width spaces before such a line gets one more. Reading drops one, so the code holds
 * exactly what was typed. U+200B is not whitespace to `\s`, which is why the guarded line does not close the fence.
 */
export const FENCE_GUARD = '\u200B';

/** Whether `line`, behind any zero-width spaces, would end the fenced block or the callout around it. */
export function endsFencedCode(line: string): boolean {
  const bare = line.replace(/^\u200B+/, '');
  return FENCE_LINE.test(bare) || CALLOUT_CLOSE.test(bare);
}

/** A fenced-code line as it was typed: one guarding zero-width space dropped. */
function unguard(line: string): string {
  return line.startsWith(FENCE_GUARD) && endsFencedCode(line) ? line.slice(FENCE_GUARD.length) : line;
}

/** The language of the code block that holds a body's front matter. The codec writes it back between `---` lines. */
export const FRONT_MATTER_LANG = 'front-matter';
/** The first line front matter must have: without it, `---` at the top of a body is an ordinary divider. */
export const FRONT_MATTER_KEY = /^[A-Za-z_][\w-]*:(?:\s|$)/;

const CALLOUT_KINDS: Readonly<Record<string, DocCalloutKind>> = {
  note: 'note',
  info: 'note',
  tip: 'tip',
  success: 'tip',
  warning: 'warning',
  caution: 'warning',
  danger: 'danger',
  error: 'danger',
};

/**
 * The page-only inline tokens, scanned BEFORE the inline grammar. A code span is matched first so a `[[x]]` quoted in
 * backticks stays code, and a backslash escape is matched so `\[[x]]` stays text. Everything between matches is handed to
 * the inline grammar unchanged.
 */
const DOC_INLINE_SOURCE = [
  // 1 a code span, re-read by the inline grammar. Its run opens only as a whole, as there; a run that closes nothing is
  // consumed whole too, so no backtick of it can open a span further on.
  '(`+)(?:(?!`)[^]*?\\1)?',
  '!\\[([^\\]\\n]*)\\]\\(((?:attachment:[A-Za-z0-9_-]+)|https:\\/\\/[^\\s)]+)\\)', // 2 alt, 3 src
  '\\[\\[([^\\[\\]\\n|]+?)(?:\\|([^\\[\\]\\n]+?))?\\]\\]', // 4 target, 5 label
  '\\[([^\\[\\]\\n]+)\\]\\(#([A-Za-z0-9][A-Za-z0-9._-]*)\\)', // 6 text, 7 anchor
  // 8 a backslash escape, re-read by the inline grammar. Consumed here so an escaped `` \` `` cannot open a code span
  // and an escaped `\[` cannot open a page link: the escape means "this is not markup" to both scanners.
  '(\\\\[\\\\`*_{}\\[\\]()<>#+\\-.!|~:])',
  '\\[([^\\[\\]\\n]+)\\]\\((attachment:[A-Za-z0-9_-]+)\\)', // 9 label, 10 href: a link to a file your application holds
].join('|');

/** The attachment id an `attachment:<id>` reference names, or null for any other href or image source. */
export function attachmentIdOf(ref: string): string | null {
  return /^attachment:[A-Za-z0-9_-]+$/.test(ref) ? ref.slice('attachment:'.length) : null;
}

/** Parse a page body into blocks. Total: any input renders, nothing throws. */
export function parseDocBody(body: string, options: GrammarOptions = {}): DocBlock[] {
  const lines = body.replace(/\r\n?/g, '\n').split('\n');
  const ids = new Map<string, number>();
  const close = frontMatterEnd(lines);
  if (close < 0) return parseBlocks(lines, ids, options, 0);
  return [{ kind: 'code', lang: FRONT_MATTER_LANG, text: lines.slice(1, close).join('\n') }, ...parseBlocks(lines.slice(close + 1), ids, options, 0)];
}

/** The line that closes the front matter at the start of a body, or -1 when the body does not start with any. */
function frontMatterEnd(lines: readonly string[]): number {
  if (lines[0].trimEnd() !== '---' || !FRONT_MATTER_KEY.test(lines[1] ?? '')) return -1;
  return lines.findIndex((line, index) => index > 1 && line.trimEnd() === '---');
}

/** The id a heading gets without an explicit `{#anchor}`: lowercase words joined by hyphens. */
export function headingSlug(text: string): string {
  return (
    text
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, '')
      .trim()
      .replace(/[\s-]+/g, '-') || 'section'
  );
}

/** Flatten a run of inlines to its plain text — for heading slugs and accessible labels. */
export function docInlineText(nodes: readonly DocInline[]): string {
  return nodes
    .map((node) => {
      switch (node.kind) {
        case 'text':
        case 'code':
          return node.text;
        case 'link':
        case 'anchorLink':
          return node.text;
        case 'strong':
        case 'emphasis':
          return docInlineText(node.children);
        case 'pageLink':
          return node.label ?? node.target;
        case 'image':
          return node.alt;
        case 'atom':
          return node.text;
      }
    })
    .join('');
}

/** Every heading, in order: the page's outline. */
export function docHeadings(blocks: readonly DocBlock[]): Array<{ id: string; level: number; text: string }> {
  return blocks.flatMap((block) => {
    if (block.kind === 'heading') return [{ id: block.id, level: block.level, text: docInlineText(block.inline) }];
    if (block.kind === 'callout' || block.kind === 'quote') return docHeadings(block.blocks);
    return [];
  });
}

/**
 * Rewrite every inline leaf of a parsed page through `map`, recursing into emphasis and every block that holds prose.
 * Code blocks and dividers are kept as they are. This is how an application adds tokens of its own after parsing, such
 * as links found in text: `Y` is the shape of what it adds, so name it: `mapDocInlines<MyToken>(blocks, map)`.
 */
export function mapDocInlines<Y = never, X = never>(blocks: readonly DocBlock<X>[], map: (node: DocInline<X>) => DocInline<X | Y>[]): DocBlock<X | Y>[] {
  const inline = (nodes: readonly DocInline<X>[]): DocInline<X | Y>[] =>
    nodes.flatMap((node): DocInline<X | Y>[] => {
      if (typeof node === 'object' && node !== null && 'kind' in node && (node.kind === 'strong' || node.kind === 'emphasis')) {
        return [{ ...node, children: inline(node.children as DocInline<X>[]) as Inline<X | Y>[] }];
      }
      return map(node);
    });
  return blocks.map((block): DocBlock<X | Y> => {
    switch (block.kind) {
      case 'paragraph':
      case 'heading':
        return { ...block, inline: inline(block.inline) };
      case 'list':
        return { ...block, items: block.items.map((item) => ({ ...item, inline: inline(item.inline), children: mapDocInlines<Y, X>(item.children, map) })) };
      case 'quote':
      case 'callout':
        return { ...block, blocks: mapDocInlines<Y, X>(block.blocks, map) };
      case 'table':
        return { ...block, header: block.header.map(inline), rows: block.rows.map((row) => row.map(inline)) };
      case 'code':
      case 'divider':
        return block;
    }
  });
}

/** Parse one inline run: the page-only tokens, and the inline grammar for everything around them. */
export function parseDocInline(text: string, options: GrammarOptions = {}): DocInline[] {
  const pattern = new RegExp(DOC_INLINE_SOURCE, 'g');
  const out: DocInline[] = [];
  let cursor = 0;

  const pushInline = (value: string): void => {
    if (value === '') return;
    for (const node of parseInline(value, options)) {
      const last = out[out.length - 1];
      if (node.kind === 'text' && last?.kind === 'text') last.text += node.text;
      else out.push(node);
    }
  };

  for (let match = pattern.exec(text); match !== null; match = pattern.exec(text)) {
    if (match[1] !== undefined || match[8] !== undefined) continue; // a code span or an escape: left for the inline grammar
    pushInline(text.slice(cursor, match.index));
    cursor = match.index + match[0].length;
    if (match[3] !== undefined) {
      out.push({ kind: 'image', src: match[3], alt: match[2] });
    } else if (match[10] !== undefined) {
      out.push({ kind: 'link', href: match[10], text: match[9] });
    } else if (match[4] !== undefined) {
      const target = match[4].trim();
      const label = match[5]?.trim();
      out.push({ kind: 'pageLink', target, ...(label ? { label } : {}) });
    } else {
      out.push({ kind: 'anchorLink', anchor: match[7], text: match[6] });
    }
  }

  pushInline(text.slice(cursor));
  return out;
}

/**
 * How many columns a line is indented. Past `limit` the count stops, so the result is exact up to it and only says
 * "deeper" beyond: a list compares every line under it with its own indent, and a deeply indented body would otherwise
 * be rescanned in full at every level.
 */
function indentOf(line: string, limit = Infinity): number {
  let width = 0;
  for (let index = 0; index < line.length && width <= limit; index += 1) {
    const char = line[index];
    if (char === ' ') width += 1;
    else if (char === '\t') width += 4 - (width % 4);
    else break;
  }
  return width;
}

/** Drop up to `width` columns of leading whitespace — less when the line has less. */
function dedent(line: string, width: number): string {
  let cut = 0;
  let seen = 0;
  while (cut < line.length && seen < width) {
    const char = line[cut];
    if (char === ' ') seen += 1;
    else if (char === '\t') seen += 4 - (seen % 4);
    else break;
    cut += 1;
  }
  return line.slice(cut);
}

/**
 * The block grammar. `depth` is how many quotes, callouts and list items enclose these lines; at `MAX_BLOCK_DEPTH` none
 * opens, so recursion is bounded however the body is shaped, and the lines a deeper level would have taken are copied
 * no further. `ids` is shared across the whole page so two headings with the same text still get distinct anchors.
 */
function parseBlocks(lines: string[], ids: Map<string, number>, options: GrammarOptions, depth: number, inListItem = false): DocBlock[] {
  const nests = depth < MAX_BLOCK_DEPTH;
  const blocks: DocBlock[] = [];
  let paragraph: string[] = [];

  const flushParagraph = (): void => {
    if (paragraph.length === 0) return;
    const text = paragraph.join('\n');
    paragraph = [];
    if (text.trim() !== '') blocks.push({ kind: 'paragraph', inline: parseDocInline(text, options), source: text.trim() });
  };

  const uniqueId = (base: string): string => {
    const count = ids.get(base) ?? 0;
    ids.set(base, count + 1);
    return count === 0 ? base : `${base}-${count}`;
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];

    // A list item's own lines are read leniently, as they were written by hand: a sub-list or fence indented too far is
    // still that, and the line right under the item carries on its paragraph.
    const lenient = inListItem && (index === 0 || LIST_ITEM.test(line) || FENCE_LINE.test(line));
    if (paragraph.length === 0 && line.trim() !== '' && indentOf(line, CODE_INDENT) >= CODE_INDENT && !lenient) {
      const body: string[] = [];
      while (index < lines.length && (lines[index].trim() === '' || indentOf(lines[index], CODE_INDENT) >= CODE_INDENT)) {
        body.push(dedent(lines[index], CODE_INDENT));
        index += 1;
      }
      index -= 1;
      // Blank lines after the last indented line are between blocks, not code.
      while (body[body.length - 1].trim() === '') {
        body.pop();
        index -= 1;
      }
      blocks.push({ kind: 'code', text: body.join('\n') });
      continue;
    }

    const fence = FENCE_LINE.exec(line);
    if (fence) {
      flushParagraph();
      const lang = fence[1].trim();
      const body: string[] = [];
      index += 1;
      // An unterminated fence runs to the end of the body: the rest of it is plainly code.
      while (index < lines.length && !FENCE_LINE.test(lines[index])) {
        body.push(unguard(lines[index]));
        index += 1;
      }
      blocks.push({ kind: 'code', ...(lang ? { lang } : {}), text: body.join('\n') });
      continue;
    }

    const callout = nests ? CALLOUT_OPEN.exec(line) : null;
    if (callout) {
      flushParagraph();
      const inner: string[] = [];
      index += 1;
      // An unclosed callout runs to the end of the body, like an unterminated fence.
      while (index < lines.length && !CALLOUT_CLOSE.test(lines[index])) {
        inner.push(lines[index]);
        index += 1;
      }
      const title = callout[2].trim();
      blocks.push({
        kind: 'callout',
        callout: CALLOUT_KINDS[callout[1].toLowerCase()] ?? 'note',
        ...(title ? { title } : {}),
        blocks: parseBlocks(inner, ids, options, depth + 1),
      });
      continue;
    }

    const heading = HEADING_LINE.exec(line);
    if (heading) {
      flushParagraph();
      const level = heading[1].length;
      let text = heading[2].replace(/\s+#+\s*$/, '').trim();
      const anchor = HEADING_ANCHOR.exec(text);
      if (anchor) text = text.slice(0, anchor.index).trim();
      const inline = parseDocInline(text, options);
      blocks.push({
        kind: 'heading',
        level,
        id: uniqueId(anchor?.[1] ?? headingSlug(docInlineText(inline))),
        ...(anchor ? { anchor: anchor[1] } : {}),
        inline,
      });
      continue;
    }

    if (THEMATIC_BREAK.test(line)) {
      flushParagraph();
      blocks.push({ kind: 'divider' });
      continue;
    }

    const quote = nests ? BLOCKQUOTE_LINE.exec(line) : null;
    if (quote) {
      flushParagraph();
      const inner: string[] = [];
      while (index < lines.length) {
        const q = BLOCKQUOTE_LINE.exec(lines[index]);
        if (!q) break;
        inner.push(q[1]);
        index += 1;
      }
      index -= 1;
      blocks.push({ kind: 'quote', blocks: parseBlocks(inner, ids, options, depth + 1) });
      continue;
    }

    if (line.includes('|') && isDelimiterRow(lines[index + 1] ?? '')) {
      flushParagraph();
      const headerCells = splitTableRow(line);
      const delimCells = splitTableRow(lines[index + 1] ?? '');
      const align = headerCells.map((_, col) => alignOf(delimCells[col] ?? ''));
      const header = headerCells.map((cell) => parseDocInline(cell, options));
      index += 2;
      const rows: DocInline[][][] = [];
      while (index < lines.length) {
        const row = lines[index];
        if (row.trim() === '' || !row.includes('|') || isDelimiterRow(row)) break;
        const cells = splitTableRow(row);
        rows.push(header.map((_, col) => parseDocInline(cells[col] ?? '', options)));
        index += 1;
      }
      index -= 1;
      blocks.push({ kind: 'table', align, header, rows });
      continue;
    }

    const item = nests ? LIST_ITEM.exec(line) : null;
    // A list item may interrupt a paragraph only when it is not indented under it (`  - x` inside prose stays prose).
    if (item && (paragraph.length === 0 || indentOf(line, 3) <= 3)) {
      flushParagraph();
      index = parseList(lines, index, ids, blocks, options, depth) - 1;
      continue;
    }

    if (line.trim() === '') {
      flushParagraph();
      continue;
    }
    paragraph.push(line);
  }

  flushParagraph();
  return blocks;
}

/**
 * One list starting at `start`, pushed onto `blocks`; returns the index of the first line after it. The list runs while
 * the marker kind holds at its own indent. A line indented deeper than the marker belongs to the item above it and is
 * parsed as that item's own blocks, so a sub-list, a fence or a second paragraph nests. A blank line ends the list
 * unless the next line carries on inside it.
 */
function parseList(lines: string[], start: number, ids: Map<string, number>, blocks: DocBlock[], options: GrammarOptions, depth: number): number {
  const first = LIST_ITEM.exec(lines[start]);
  if (!first) return start + 1;
  const baseIndent = indentOf(first[1]);
  const ordered = /\d/.test(first[2]);
  const items: DocListItem[] = [];
  let index = start;

  while (index < lines.length) {
    const match = LIST_ITEM.exec(lines[index]);
    if (!match || indentOf(match[1], baseIndent) !== baseIndent || /\d/.test(match[2]) !== ordered) break;
    const contentIndent = baseIndent + match[2].length + 1;
    const body: string[] = [];
    index += 1;
    while (index < lines.length) {
      const next = lines[index];
      if (next.trim() === '') {
        // A blank line stays inside the item only when the item carries on after it.
        const after = lines.slice(index + 1).find((candidate) => candidate.trim() !== '');
        if (after !== undefined && indentOf(after, baseIndent) > baseIndent) {
          body.push('');
          index += 1;
          continue;
        }
        break;
      }
      if (indentOf(next, baseIndent) <= baseIndent) break;
      body.push(dedent(next, contentIndent));
      index += 1;
    }
    const task = TASK_MARKER.exec(match[3]);
    const text = task ? match[3].slice(task[0].length) : match[3];
    items.push({
      inline: parseDocInline(text, options),
      ...(task ? { checked: task[1] !== ' ' } : {}),
      children: parseBlocks(body, ids, options, depth + 1, true),
    });
    // A blank line between two items of the same list keeps the list going.
    if (index < lines.length && lines[index].trim() === '') {
      const resume = lines.slice(index).findIndex((candidate) => candidate.trim() !== '');
      const nextItem = resume >= 0 ? LIST_ITEM.exec(lines[index + resume]) : null;
      if (nextItem && indentOf(nextItem[1], baseIndent) === baseIndent && /\d/.test(nextItem[2]) === ordered) index += resume;
    }
  }

  const startNumber = ordered ? Number.parseInt(first[2], 10) : undefined;
  blocks.push({
    kind: 'list',
    ordered,
    ...(startNumber !== undefined && startNumber !== 1 && Number.isFinite(startNumber) ? { start: startNumber } : {}),
    items,
  });
  return index;
}
