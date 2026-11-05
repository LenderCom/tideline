import type { JSONContent } from '@tiptap/core';
import { canCloseEmphasis, canOpenEmphasis, charAt, charBefore, isDelimiterRow, isPunctuationChar, isSpaceChar, type TableAlign } from './inline.js';
import { endsFencedCode, FENCE_GUARD, FRONT_MATTER_KEY, isFenceLine, FRONT_MATTER_LANG, parseDocBody, parseDocInline, type DocBlock, type DocCalloutKind, type DocInline, type DocListItem } from './parse.js';
import { tokenMatcher, type GrammarOptions, type MarkdownPlugin } from './plugin.js';

/**
 * The codec: markdown ⇄ the editor's ProseMirror JSON.
 *
 * ONE GRAMMAR. Reading goes through the page parser (`parseDocBody`), so the editor opens exactly the page a reader sees,
 * never a second interpretation of the same bytes. Writing is this file's job, and it is checked against that same
 * parser: every inline run is written, re-read with `parseDocInline`/`parseDocBody`, and only accepted when it reads back
 * as what was meant. A run that does not is re-written more defensively (bracketed links, then every risky character
 * escaped). So the writer never trusts its own escaping rules; the parser is the arbiter.
 *
 * The round-trip property test (`codec.test.ts`) holds this file to three promises over generated pages:
 *   1. what the writer writes is what the parser reads (`parseDocBody(write(doc))` is the doc's own tree);
 *   2. markdown → editor → markdown is stable after one pass, byte for byte;
 *   3. a reader sees the same page before and after a round trip.
 * `codec.yjs.test.ts` adds a fourth, for co-editing: a document synced through a Y.Doc writes the same markdown as the
 * editor alone.
 *
 * What the editor can hold that the format cannot is normalised rather than lost silently, and each case is listed where
 * it is handled: a hard break at the end of a paragraph, whitespace before a paragraph's first word, a line in a code
 * block that would close its fence, two lists of the same kind back to back (the format reads them as one), a callout
 * nested in a callout, bold or italic on a code span or link text that runs across lines, bold or italic that CommonMark's
 * flanking rules cannot write where it sits (see `fitMarksToFlanking`), merged table cells, and bold or italic on a plugin's
 * atom (an inline atom holds no marks, because Yjs could not sync them: see `schema.ts`). A code
 * span that runs across lines is cut where one of its lines would read as a block, or as a blank line, so that the line
 * starts with the next span's fence. One shape is beyond it and is written as best it can be: an inline code span holding
 * two backticks in a row, at the very start of a paragraph line (its fence is three backticks long, which the block
 * grammar reads as a code fence before the span is seen), and a code span that runs across lines and holds a backtick,
 * where one of its lines would read as a block on its own (the cut would make that three-backtick fence).
 */

/** The node and mark names the editor schema uses; `docSchemaExtensions` registers exactly these, plus each plugin's. */
export const MARKDOWN_NODES = [
  'doc',
  'paragraph',
  'text',
  'hardBreak',
  'heading',
  'codeBlock',
  'mermaid',
  'blockquote',
  'callout',
  'bulletList',
  'orderedList',
  'listItem',
  'table',
  'tableRow',
  'tableHeader',
  'tableCell',
  'horizontalRule',
  'image',
  'pageLink',
] as const;
export const MARKDOWN_MARKS = ['bold', 'italic', 'code', 'link'] as const;

type Mark = NonNullable<JSONContent['marks']>[number];

/** `out.push(...items)` passes every item as an argument, and a long enough list (a large page's) overflows the stack. */
function pushAll<T>(out: T[], items: readonly T[]): void {
  for (const item of items) out.push(item);
}

// ─── markdown → editor───────────────────────────────────────────────────────────────────────────────────────────────

/** Read a page body into the editor's document. Total, like the parser it rests on. */
export function markdownToDoc(body: string, options: GrammarOptions = {}): JSONContent {
  const content = blocksToNodes(parseDocBody(body, options));
  return { type: 'doc', content: content.length > 0 ? content : [{ type: 'paragraph' }] };
}

function blocksToNodes(blocks: readonly DocBlock[]): JSONContent[] {
  return blocks.map(blockToNode);
}

function blockToNode(block: DocBlock): JSONContent {
  switch (block.kind) {
    case 'paragraph':
      return paragraph(inlineToNodes(block.inline));
    case 'heading':
      return {
        type: 'heading',
        attrs: { level: block.level, anchor: block.anchor ?? null },
        ...withContent(inlineToNodes(block.inline)),
      };
    case 'code':
      if (block.lang === 'mermaid') return { type: 'mermaid', ...withContent(textNodes(block.text)) };
      return { type: 'codeBlock', attrs: { language: block.lang ?? null }, ...withContent(textNodes(block.text)) };
    case 'quote':
      return { type: 'blockquote', content: nonEmpty(blocksToNodes(block.blocks)) };
    case 'callout':
      return {
        type: 'callout',
        attrs: { kind: block.callout, title: block.title ?? null },
        content: nonEmpty(blocksToNodes(block.blocks)),
      };
    case 'list':
      return block.ordered
        ? { type: 'orderedList', attrs: { start: block.start ?? 1 }, content: block.items.map(listItemToNode) }
        : { type: 'bulletList', content: block.items.map(listItemToNode) };
    case 'table': {
      const cell = (type: 'tableHeader' | 'tableCell', inline: DocInline[], col: number): JSONContent => ({
        type,
        attrs: { align: alignAttr(block.align[col]) },
        content: [paragraph(inlineToNodes(inline))],
      });
      return {
        type: 'table',
        content: [
          { type: 'tableRow', content: block.header.map((inline, col) => cell('tableHeader', inline, col)) },
          ...block.rows.map((row) => ({ type: 'tableRow', content: row.map((inline, col) => cell('tableCell', inline, col)) })),
        ],
      };
    }
    case 'divider':
      return { type: 'horizontalRule' };
  }
}

function listItemToNode(item: DocListItem): JSONContent {
  return {
    type: 'listItem',
    attrs: { checked: item.checked ?? null },
    content: [paragraph(inlineToNodes(item.inline)), ...blocksToNodes(item.children)],
  };
}

function alignAttr(align: TableAlign | undefined): string | null {
  return align && align !== 'none' ? align : null;
}

function paragraph(content: JSONContent[]): JSONContent {
  return { type: 'paragraph', ...withContent(content) };
}

/** ProseMirror refuses an empty `content` array on a node whose content may be empty; leave the key off instead. */
function withContent(content: JSONContent[]): { content?: JSONContent[] } {
  return content.length > 0 ? { content } : {};
}

/** A container that needs at least one block (a quote, a callout) gets an empty paragraph rather than nothing. */
function nonEmpty(content: JSONContent[]): JSONContent[] {
  return content.length > 0 ? content : [{ type: 'paragraph' }];
}

function textNodes(text: string): JSONContent[] {
  return text === '' ? [] : [{ type: 'text', text }];
}

/**
 * Inline tokens → text nodes with marks, and the inline atoms. A newline in the text is a hard break (the parser keeps
 * it as a line break); the parser only ever produces one in a paragraph, never in a heading, a cell or a list item's line.
 *
 * A code span that runs across a line keeps its newline as text, in the span (the editor shows it as a line break, as
 * the parser does). A hard break there would have to carry the code mark for the writer to rejoin the span, and Yjs
 * keeps marks on text only: co-editing would save `` `a\nb` `` as `` `a`\n`b` ``. As text it
 * also keeps that apart from two code spans on two lines, which the editor holds as code, break, code.
 */
function inlineToNodes(nodes: readonly DocInline[], marks: Mark[] = []): JSONContent[] {
  const out: JSONContent[] = [];
  const pushText = (text: string, extra: Mark[] = []): void => {
    const all = [...marks, ...extra];
    const lines = all.some((mark) => mark.type === 'code') ? [text] : text.split('\n');
    lines.forEach((line, index) => {
      if (index > 0) out.push({ type: 'hardBreak' });
      if (line !== '') out.push({ type: 'text', text: line, ...(all.length ? { marks: all } : {}) });
    });
  };
  for (const node of nodes) {
    switch (node.kind) {
      case 'text':
        pushText(node.text);
        break;
      case 'code':
        pushText(node.text, [{ type: 'code' }]);
        break;
      case 'link':
        pushText(node.text, [{ type: 'link', attrs: { href: node.href } }]);
        break;
      case 'anchorLink':
        pushText(node.text, [{ type: 'link', attrs: { href: `#${node.anchor}` } }]);
        break;
      // Emphasis inside emphasis (`*a _b_ c*`) is still just italic: a mark is held once.
      case 'strong':
        pushAll(out, inlineToNodes(node.children, withMark(marks, 'bold')));
        break;
      case 'emphasis':
        pushAll(out, inlineToNodes(node.children, withMark(marks, 'italic')));
        break;
      // A plugin's token takes no marks (an inline atom; see `schema.ts`): bold around one opens it plain.
      case 'atom':
        out.push({ type: node.type, attrs: node.attrs });
        break;
      case 'pageLink':
        out.push({ type: 'pageLink', attrs: { target: node.target, label: node.label ?? null } });
        break;
      case 'image':
        out.push({ type: 'image', attrs: { src: node.src, alt: node.alt } });
        break;
    }
  }
  return joinText(out);
}

function withMark(marks: Mark[], type: string): Mark[] {
  return marks.some((mark) => mark.type === type) ? marks : [...marks, { type }];
}

/** Adjacent text with the same marks as one node, as ProseMirror itself would hold it. */
function joinText(nodes: JSONContent[]): JSONContent[] {
  const out: JSONContent[] = [];
  for (const node of nodes) {
    const prev = out[out.length - 1];
    if (node.type === 'text' && prev?.type === 'text' && JSON.stringify(prev.marks ?? []) === JSON.stringify(node.marks ?? [])) {
      out[out.length - 1] = { ...prev, text: `${prev.text ?? ''}${node.text ?? ''}` };
    } else out.push(node);
  }
  return out;
}

// ─── editor → markdown───────────────────────────────────────────────────────────────────────────────────────────────

/** Write the editor's document as markdown. Blocks are separated by one blank line; the body ends without a newline. */
export function docToMarkdown(doc: JSONContent, options: GrammarOptions = {}): string {
  return writeBlocks(doc.content ?? [], { inCallout: false, top: true, plugins: options.plugins ?? [], repairs: markRepairs() }).join('\n');
}

interface BlockContext {
  /** Inside a callout, where a `:::` line would close it — so a nested callout cannot be written closed. */
  inCallout: boolean;
  /** This block is the last of its run, so a callout here may be left unclosed: the parser ends it where the run ends. */
  last?: boolean;
  /** These are the page's own blocks, so the first one can be front matter. */
  top?: boolean;
  plugins: readonly MarkdownPlugin[];
  repairs: MarkRepairs;
}

/** The lines of a run of blocks, a blank line between each pair. */
function writeBlocks(blocks: readonly JSONContent[], context: BlockContext): string[] {
  // A paragraph with nothing to write goes first, so lists it stood between join as the parser will join them.
  const nodes = joinAdjacentLists(blocks.filter((block) => block.type !== 'paragraph' || splitAtBlankLines(block.content ?? [], context.plugins).length > 0));
  const out: string[] = [];
  for (const [index, node] of nodes.entries()) {
    const frontMatter = context.top && index === 0 ? writeFrontMatter(node) : null;
    const lines = frontMatter ?? writeBlock(node, { inCallout: context.inCallout, last: index === nodes.length - 1, plugins: context.plugins, repairs: context.repairs });
    if (lines.length === 0) continue;
    if (out.length > 0) out.push('');
    pushAll(out, lines);
  }
  return out;
}

/**
 * Two lists of one kind side by side read back as one list (the format has no way to write them apart), so they are written as
 * one from the first pass; the second list's start number is dropped with it.
 */
function joinAdjacentLists(blocks: readonly JSONContent[]): JSONContent[] {
  const out: JSONContent[] = [];
  for (const block of blocks) {
    const prev = out[out.length - 1];
    if (prev && prev.type === block.type && (block.type === 'bulletList' || block.type === 'orderedList')) {
      out[out.length - 1] = { ...prev, content: [...(prev.content ?? []), ...(block.content ?? [])] };
    } else out.push(block);
  }
  return out;
}

function writeBlock(node: JSONContent, context: BlockContext): string[] {
  switch (node.type) {
    case 'paragraph':
      // A blank line inside a paragraph (two breaks, or a line of only spaces) ends it in the format, so it is written as two.
      return splitAtBlankLines(node.content ?? [], context.plugins).flatMap((part, index) => [...(index > 0 ? [''] : []), ...writeParagraph(part, context)]);
    case 'heading':
      return [writeHeading(node, context)];
    case 'codeBlock':
      return writeFence(String(node.attrs?.language ?? '').trim(), plainText(node.content), context);
    case 'mermaid':
      return writeFence('mermaid', plainText(node.content), context);
    case 'blockquote': {
      // The quote marker resets the callout context: `> :::` is not a line a callout's closing check can see.
      const lines = writeBlocks(node.content ?? [], { inCallout: false, plugins: context.plugins, repairs: context.repairs }).map((line) => (line === '' ? '>' : `> ${line}`));
      return lines.length > 0 ? lines : ['>'];
    }
    case 'callout': {
      const inner = writeBlocks(node.content ?? [], { inCallout: true, plugins: context.plugins, repairs: context.repairs });
      const kind = calloutKind(node.attrs?.kind);
      const title = oneLine(String(node.attrs?.title ?? '')).trim();
      const open = `:::${kind}${title ? ` ${title}` : ''}`;
      if (!context.inCallout) return [open, ...inner, ':::'];
      // Inside a callout a nested one cannot close: its `:::` would close the parent. As the last block of its run it is
      // left open, which is how the parser reads it back (an unclosed callout runs to the end of what holds it). Anywhere
      // else it is written as its content.
      return context.last ? [open, ...inner] : inner;
    }
    case 'bulletList':
    case 'orderedList':
      return writeList(node, context);
    case 'table':
      return writeTable(node, context);
    case 'horizontalRule':
      return ['---'];
    default:
      // Not a block of the format (nothing in the schema produces one): keep its text rather than drop it.
      return writeParagraph([{ type: 'text', text: plainText(node.content) }], { ...context, inCallout: false });
  }
}

const CALLOUT_KINDS: readonly DocCalloutKind[] = ['note', 'tip', 'warning', 'danger'];

function calloutKind(value: unknown): DocCalloutKind {
  return CALLOUT_KINDS.includes(value as DocCalloutKind) ? (value as DocCalloutKind) : 'note';
}

function writeHeading(node: JSONContent, { plugins, repairs }: BlockContext): string {
  const level = Math.min(Math.max(Number(node.attrs?.level) || 1, 1), 6);
  const anchor = validAnchor(node.attrs?.anchor);
  const suffix = anchor ? ` {#${anchor}}` : '';
  const hashes = '#'.repeat(level);
  const expected = { level, anchor };
  const text = writeInlineVerified(node.content ?? [], (written) => {
    const [block, ...rest] = parseDocBody(`${hashes} ${written}${suffix}`, { plugins });
    return rest.length === 0 && block?.kind === 'heading' && block.level === expected.level && block.anchor === (expected.anchor ?? undefined)
      ? block.inline
      : null;
  }, { breaks: 'space', trim: 'both', plugins, repairs });
  return `${hashes} ${text}${suffix}`;
}

/** An anchor the grammar can read back: `{#…}` takes `[A-Za-z0-9][A-Za-z0-9._-]*`, nothing else. */
function validAnchor(value: unknown): string | null {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value) ? value : null;
}

const CALLOUT_CLOSE = /^ {0,3}:::\s*$/;

/**
 * A fenced block. the format has no longer fences, so a content line that looks like a fence would close the block early; it
 * gets a zero-width space in front (`FENCE_GUARD`), which keeps the page whole. Inside a callout a `:::` line is the same
 * hazard (the callout is closed by lines, before fences are read) and gets the same treatment. The parser drops one
 * guard from such a line, so a line that already starts with zero-width spaces before a fence or `:::` gets one more,
 * wherever it is: the code reads back exactly as it was typed.
 */
function writeFence(lang: string, text: string, context: BlockContext): string[] {
  const guarded = (line: string): boolean =>
    isFenceLine(line) || (context.inCallout && CALLOUT_CLOSE.test(line)) || (line.startsWith(FENCE_GUARD) && endsFencedCode(line));
  const lines = text === '' ? [] : text.split('\n').map((line) => (guarded(line) ? `${FENCE_GUARD}${line}` : line));
  return [`\`\`\`${oneLine(lang)}`, ...lines, '```'];
}

/** Front matter back between its `---` lines, when that reads back as the same block. Anything else is an ordinary fence. */
function writeFrontMatter(node: JSONContent): string[] | null {
  if (node.type !== 'codeBlock' || node.attrs?.language !== FRONT_MATTER_LANG) return null;
  const lines = plainText(node.content).split('\n');
  if (!FRONT_MATTER_KEY.test(lines[0]) || lines.some((line) => line.trimEnd() === '---')) return null;
  return ['---', ...lines, '---'];
}

function splitAtBlankLines(content: readonly JSONContent[], plugins: readonly MarkdownPlugin[]): JSONContent[][] {
  const lines: JSONContent[][] = [[]];
  for (const node of content) {
    if (node.type === 'hardBreak') lines.push([]);
    else lines[lines.length - 1].push(node);
  }
  const blank = (line: JSONContent[]): boolean =>
    line.every((node) => node.type === 'text' && (node.text ?? '').trim() === '' && !(node.marks ?? []).some((mark) => mark.type === 'code'));
  const parts: JSONContent[][] = [];
  let current: JSONContent[][] = [];
  for (const line of lines) {
    if (blank(line)) {
      if (current.length > 0) parts.push(current.flatMap((run, index) => [...(index > 0 ? [{ type: 'hardBreak' }] : []), ...run]));
      current = [];
    } else current.push(line);
  }
  if (current.length > 0) parts.push(current.flatMap((run, index) => [...(index > 0 ? [{ type: 'hardBreak' }] : []), ...run]));
  // Whether it writes anything, not what: writing it here too would run every paragraph through `readableMarks` three times.
  return parts.filter((part) => trimPieces(writablePieces(part, { plugins }), 'both').length > 0);
}

function isCodeText(node: JSONContent): boolean {
  return (node.marks ?? []).some((mark) => mark.type === 'code');
}

function writeParagraph(content: readonly JSONContent[], { plugins, inCallout, repairs }: BlockContext): string[] {
  // A hard break at the very end has nothing after it to break to, and a blank line would end the paragraph.
  const trimmed = [...content];
  while (trimmed.length > 0 && trimmed[trimmed.length - 1].type === 'hardBreak') trimmed.pop();
  const shows = (node: JSONContent): boolean => isCodeText(node) || (node.type !== 'hardBreak' && (node.type !== 'text' || (node.text ?? '').trim() !== ''));
  if (!trimmed.some(shows)) return [];
  const text = writeInlineVerified(trimmed, (written) => {
    const blocks = parseDocBody(written, { plugins });
    return blocks.length === 1 && blocks[0].kind === 'paragraph' ? blocks[0].inline : null;
    // A paragraph is not indented (CommonMark strips it too): after a list, an indented first line would join the list.
    // Whitespace and breaks after its last word show nothing.
  }, { lineStarts: true, inCallout, trim: 'both', plugins, repairs });
  // Nothing to write (its only content was an atom that cannot be written) is no paragraph, not a blank line.
  return text === '' ? [] : text.split('\n');
}

function writeList(node: JSONContent, context: BlockContext): string[] {
  const ordered = node.type === 'orderedList';
  const start = ordered ? Math.max(0, Math.floor(Number(node.attrs?.start ?? 1)) || 0) : 0;
  const out: string[] = [];
  (node.content ?? []).forEach((item, index) => {
    const marker = ordered ? `${start + index}. ` : '- ';
    const checked = typeof item.attrs?.checked === 'boolean' ? (item.attrs.checked as boolean) : undefined;
    const task = checked === true ? '[x] ' : checked === false ? '[ ] ' : '';
    const [first, ...rest] = item.content ?? [];
    const firstInline = first?.type === 'paragraph' ? (first.content ?? []) : [];
    const children = first?.type === 'paragraph' ? rest : (item.content ?? []);
    // An item's first line cannot break: what follows a hard break in it becomes the item's next paragraph.
    const breakAt = firstInline.findIndex((child) => child.type === 'hardBreak');
    const lead = breakAt < 0 ? firstInline : firstInline.slice(0, breakAt);
    const spill = breakAt < 0 ? [] : firstInline.slice(breakAt + 1);
    const line = writeInlineVerified(lead, (written) => {
      const [block, ...others] = parseDocBody(`${marker}${task}${written}`, { plugins: context.plugins });
      if (others.length > 0 || block?.kind !== 'list' || block.items.length !== 1) return null;
      const read = block.items[0];
      return read.children.length === 0 && read.checked === checked ? read.inline : null;
    }, { breaks: 'space', trim: 'start', plugins: context.plugins, repairs: context.repairs });
    // `- | ` is also a table delimiter row: after a line with a pipe in it, the list would read as a table.
    out.push(isDelimiterRow(`${marker}${task}${line}`) ? `${marker}${task}${line.replace(/(?<!\\)\|/g, '\\|')}` : `${marker}${task}${line}`);
    // Children sit directly under the item line, indented to its content; blank lines between them stay in the item.
    const indent = ' '.repeat(marker.length);
    const body = writeBlocks([...(spill.length > 0 ? [{ type: 'paragraph', content: spill }] : []), ...children], context);
    pushAll(out, body.map((bodyLine) => (bodyLine === '' ? '' : `${indent}${bodyLine}`)));
  });
  return out;
}

function writeTable(node: JSONContent, { plugins, repairs }: BlockContext): string[] {
  const rows = (node.content ?? []).filter((row) => row.type === 'tableRow');
  if (rows.length === 0) return [];
  const header = rows[0].content ?? [];
  const width = Math.max(1, header.length);
  const align: TableAlign[] = Array.from({ length: width }, (_, col) => {
    const value = header[col]?.attrs?.align;
    return value === 'left' || value === 'center' || value === 'right' ? value : 'none';
  });
  const cellText = (cell: JSONContent | undefined): string => {
    // A cell holds one line of inline content; a second paragraph (pasted in) joins the first with a space.
    const inline = (cell?.content ?? []).flatMap((block, index) => [
      ...(index > 0 ? [{ type: 'text', text: ' ' }] : []),
      ...(block.type === 'paragraph' ? (block.content ?? []) : [{ type: 'text', text: plainText(block.content) }]),
    ]);
    return writeInlineVerified(inline, (written) => {
      const [block, ...rest] = parseDocBody(`| ${written} |\n| --- |`, { plugins });
      return rest.length === 0 && block?.kind === 'table' && block.rows.length === 0 && block.header.length === 1 ? block.header[0] : null;
    }, { breaks: 'space', table: true, trim: 'both', plugins, repairs });
  };
  const line = (cells: string[]): string => {
    const row = `| ${cells.join(' | ')} |`;
    // A body row of dashes would read as a delimiter and end the table; its dashes are escaped (`\-` reads as `-`).
    return isDelimiterRow(row) ? `| ${cells.map((cell) => cell.replace('-', '\\-')).join(' | ')} |` : row;
  };
  const delimiter = align.map((value) => (value === 'center' ? ':---:' : value === 'right' ? '---:' : value === 'left' ? ':---' : '---'));
  return [
    line(Array.from({ length: width }, (_, col) => cellText(header[col]))),
    `| ${delimiter.join(' | ')} |`,
    ...rows.slice(1).map((row) => line(Array.from({ length: width }, (_, col) => cellText(row.content?.[col])))),
  ];
}

function plainText(content: readonly JSONContent[] | undefined): string {
  return (content ?? []).map((node) => (node.type === 'hardBreak' ? '\n' : (node.text ?? plainText(node.content)))).join('');
}

function oneLine(text: string): string {
  return text.replace(/[\r\n]+/g, ' ');
}

// ─── inline writing ────────────────────────────────────────────────────────────────────────────────────────────────

/** How a run is written: bare autolinks or bracketed ones, and how much punctuation is escaped. */
interface InlineStyle {
  bareAutolinks: boolean;
  escape: 'light' | 'full';
}

/** Tried in order; the first whose output reads back as meant wins. The last is the most defensive. */
const STYLES: readonly InlineStyle[] = [
  { bareAutolinks: true, escape: 'light' },
  { bareAutolinks: false, escape: 'light' },
  { bareAutolinks: true, escape: 'full' },
  { bareAutolinks: false, escape: 'full' },
];

interface InlineOptions {
  /** The grammar trims this run's edges (a heading, a table cell) or its start (a list item's first line). */
  trim?: 'start' | 'both';
  /** What a hard break becomes where a line cannot break: a space, or (a list item's first line) a real newline. */
  breaks?: 'newline' | 'space' | 'split';
  /** Inside a table cell, where an unescaped `|` would open a new column. */
  table?: boolean;
  /** A paragraph, whose every line is read for block markers first (a heading's text, say, follows its `#`). */
  lineStarts?: boolean;
  /** The paragraph sits in a callout, where a bare `:::` line would close it. */
  inCallout?: boolean;
  /** The grammar's tokens, for reading back what was written and writing the nodes they open as. */
  plugins?: readonly MarkdownPlugin[];
  /** What the document being written has left to spend repairing marks. */
  repairs?: MarkRepairs;
}

/**
 * Write a run of inline nodes in the first style whose output `read` (the caller's own re-parse, in context) turns back
 * into the same content. `read` returns the inline tokens it found, or null when the text did not even keep its shape.
 */
function writeInlineVerified(
  nodes: readonly JSONContent[],
  read: (written: string) => DocInline[] | null,
  options: InlineOptions = {},
): string {
  const pieces = trimPieces(toPieces(nodes, options), options.trim);
  const expected = trimLeaves(leaves(piecesToInline(pieces)), options.trim);
  let last = '';
  for (const style of STYLES) {
    last = writePieces(pieces, style, options);
    const got = read(last);
    if (got !== null && sameLeaves(trimLeaves(leaves(got), options.trim), expected)) return last;
  }
  return last;
}

/** Whitespace (and hard breaks) the container would trim, taken off before writing so both passes agree. */
function trimPieces(pieces: Piece[], trim: InlineOptions['trim']): Piece[] {
  if (!trim) return pieces;
  const out = pieces.map((piece) => ({ ...piece }));
  while (out[0]?.kind === 'break' || out[0]?.kind === 'text') {
    const first = out[0];
    if (first.kind === 'text') first.text = first.text.replace(/^\s+/, '');
    if (first.kind === 'text' && first.text !== '') break;
    out.shift();
  }
  while (trim === 'both' && (out[out.length - 1]?.kind === 'break' || out[out.length - 1]?.kind === 'text')) {
    const last = out[out.length - 1];
    // `trimEnd`, never `replace(/\s+$/)`: the regex retries at every space of an inner run, quadratic on a deep paragraph.
    if (last.kind === 'text') last.text = last.text.trimEnd();
    if (last.kind === 'text' && last.text !== '') break;
    out.pop();
  }
  return out;
}

/** One unit of inline output. Links and code spans are atomic: the format gives them no inner markup. */
type Piece =
  | { kind: 'text'; text: string; bold: boolean; italic: boolean }
  | { kind: 'break' }
  | { kind: 'code'; text: string; bold: boolean; italic: boolean }
  | { kind: 'link'; href: string; text: string; bold: boolean; italic: boolean }
  | { kind: 'anchorLink'; anchor: string; text: string }
  | { kind: 'atom'; type: string; attrs: Record<string, string>; text: string; bold: boolean; italic: boolean }
  | { kind: 'pageLink'; target: string; label?: string }
  | { kind: 'image'; src: string; alt: string };

const HTTPS_HREF = /^https:\/\/[^\s)]+$/;
const ANCHOR_HREF = /^#([A-Za-z0-9][A-Za-z0-9._-]*)$/;
const ATTACHMENT_SRC = /^attachment:[A-Za-z0-9_-]+$/;

function toPieces(nodes: readonly JSONContent[], options: InlineOptions): Piece[] {
  return readableMarks(canonicalPieces(options.plugins ?? [], writablePieces(nodes, options)), options);
}

/** The pieces a run of nodes writes, with its marks as they came. */
function writablePieces(nodes: readonly JSONContent[], options: InlineOptions): Piece[] {
  const pieces: Piece[] = [];
  const has = (node: JSONContent, type: string): boolean => (node.marks ?? []).some((mark) => mark.type === type);
  for (const node of nodes) {
    const bold = has(node, 'bold');
    const italic = has(node, 'italic');
    switch (node.type) {
      case 'hardBreak':
        pieces.push(options.breaks === 'space' ? { kind: 'text', text: ' ', bold, italic } : { kind: 'break' });
        break;
      case 'text': {
        const text = node.text ?? '';
        if (text === '') break;
        const link = (node.marks ?? []).find((mark) => mark.type === 'link');
        const href = typeof link?.attrs?.href === 'string' ? encodeBackticks(link.attrs.href) : '';
        const anchor = ANCHOR_HREF.exec(href);
        if (has(node, 'code')) {
          // A code span that runs across a line keeps its newline, where the line can break.
          pieces.push({ kind: 'code', text: options.breaks === 'space' ? text.replace(/\n/g, ' ') : text, bold, italic });
        } else if (anchor) {
          // `[text](#anchor)` takes no markup inside or around it (the page scanner reads it before emphasis).
          const prev = pieces[pieces.length - 1];
          if (prev?.kind === 'anchorLink' && prev.anchor === anchor[1]) prev.text += text;
          else pieces.push({ kind: 'anchorLink', anchor: anchor[1], text });
        } else if (link && (HTTPS_HREF.test(href) || ATTACHMENT_SRC.test(href))) {
          const prev = pieces[pieces.length - 1];
          // Adjacent nodes under one link with the same marks are one link: Link text is plain. Where the marks differ
          // (half of it italic) they stay two links, so neither half takes the other's marks.
          if (prev?.kind === 'link' && prev.href === href && prev.bold === bold && prev.italic === italic) prev.text += text;
          else pieces.push({ kind: 'link', href, text, bold, italic });
        } else {
          // A link the format cannot write (not https, not an anchor) keeps its text.
          pieces.push({ kind: 'text', text, bold, italic });
        }
        break;
      }
      case 'pageLink': {
        const target = cleanTarget(String(node.attrs?.target ?? ''));
        const label = cleanLabel(String(node.attrs?.label ?? ''));
        if (target) pieces.push({ kind: 'pageLink', target, ...(label && label !== target ? { label } : {}) });
        break;
      }
      case 'image': {
        const src = encodeBackticks(String(node.attrs?.src ?? ''));
        if (ATTACHMENT_SRC.test(src) || HTTPS_HREF.test(src)) pieces.push({ kind: 'image', src, alt: cleanAlt(String(node.attrs?.alt ?? '')) });
        break;
      }
      default: {
        // Written unformatted, as the editor holds it: a mark that reached a plugin's atom anyway (pasted JSON) is not kept.
        const plugin = options.plugins?.find((candidate) => candidate.type === node.type);
        if (plugin) {
          const written = plugin.write(node.attrs ?? {});
          const writable = written !== null && !written.includes('\n') && tokenMatcher(plugin).test(written);
          const attrs = writable ? plugin.read(written) : null;
          if (writable && attrs !== null) pieces.push({ kind: 'atom', type: plugin.type, attrs, text: written, bold: false, italic: false });
          break;
        }
        const text = plainText(node.content);
        if (text) pieces.push({ kind: 'text', text, bold, italic });
      }
    }
  }
  // Links and anchor links whose text ended up empty or unwritable degrade to text, so nothing is dropped.
  return pieces.map((piece): Piece => {
    if (piece.kind === 'anchorLink') {
      // Anchor-link text is read raw (no escapes): brackets, backticks and newlines cannot be written in it.
      const text = piece.text.replace(/[[\]`\n]/g, '');
      return text.trim() ? { ...piece, text } : { kind: 'text', text: piece.text, bold: false, italic: false };
    }
    return piece;
  });
}

/**
 * How many marks `readableMarks` will try taking off one stretch of a run, one at a time. One unreadable spot needs only a
 * few, and each try reads the stretch again, so a long chain of touching spans must not get a try per span.
 */
const MAX_MARK_ATTEMPTS = 16;

/**
 * How many characters `readableMarks` may read to repair marks while one document is written, with `READ_OVERHEAD` more for
 * each read. Repair is the one part of writing that reads the same text again, and this can run on a server's event loop,
 * so the whole document shares one allowance: a page of unreadable spots costs about a second more at most, in however many
 * runs, and a page with a handful spends almost none of it. Spots past the allowance are written plain.
 */
const MARK_REPAIR_ALLOWANCE = 1_000_000;
const READ_OVERHEAD = 32;

/** A neighbour of a stretch, cut to the word that touches it: the rest of a long paragraph is not what a read there is for. */
function nearestWord(piece: Piece, which: 'first' | 'last'): Piece {
  if (piece.kind !== 'text') return piece;
  const { text } = piece;
  if (which === 'first') return { ...piece, text: /^\s*\S*/.exec(text)?.[0] ?? text };
  let at = text.length;
  while (at > 0 && isSpaceChar(text[at - 1])) at -= 1;
  while (at > 0 && !isSpaceChar(text[at - 1])) at -= 1;
  return { ...piece, text: text.slice(at) };
}

/** What is left of `MARK_REPAIR_ALLOWANCE` for the document being written. */
interface MarkRepairs {
  left: number;
}

function markRepairs(): MarkRepairs {
  return { left: MARK_REPAIR_ALLOWANCE };
}

/**
 * The last resort for marks no spelling can hold, where neighbouring spans' delimiters run together into one marker that no
 * longer flanks (bold italic, then italic, then a word, all touching). Left alone the delimiters would read as literal
 * characters and change the text, so one piece gives up a mark, italic first, and failing that its stretch is written plain.
 * The rest of the run keeps its marks.
 *
 * Whitespace beside a marker settles how it flanks, so a spot is first looked for word by word, each read on its own with what
 * touches it: a page of such spots (`https://a.b***y ******` repeated) stays linear. Words can read apart and still not
 * together, as a mark shared across a space pairs its delimiters differently (`foo***bar* baz*qux***`), so if the run does
 * not read whole the same search widens to each phrase, where marks carry across spaces, and then to the run. Each style is
 * tried in full, as the run is written in one. If no style holds, it is written plain.
 */
function readableMarks(pieces: Piece[], options: InlineOptions): Piece[] {
  const marked = (piece: Piece, mark: 'bold' | 'italic'): boolean => isFormatted(piece) && piece[mark];
  const anyMark = (piece: Piece | undefined): boolean => piece !== undefined && (marked(piece, 'bold') || marked(piece, 'italic'));
  // Only spans of different marks can touch, and only a bare link can lean on being written bare; everything else was
  // fitted above. This is on the path of every run, so most stop here.
  const atRisk = (run: readonly Piece[], index: number): boolean => {
    const piece = run[index];
    return anyMark(piece) && (anyMark(run[index - 1]) || anyMark(run[index + 1]) || (piece.kind === 'link' && writesBare(piece)));
  };
  if (!pieces.some((_, index) => atRisk(pieces, index))) return pieces;
  // Read as a run, so a table's pipe escapes (the row reads those, before the cell) stay out of it.
  const asRun = { ...options, table: false };
  const render = (style: InlineStyle, candidate: readonly Piece[]): string => renderSpans(candidate, style, asRun, 'bold');
  const says = (written: string, candidate: readonly Piece[]): boolean =>
    sameLeaves(leaves(parseDocInline(written, { plugins: options.plugins ?? [] })), leaves(piecesToInline(candidate)));
  // Without a link or a character to escape every style writes the same bytes, and reading them again would learn nothing.
  const styles = pieces.some((piece) => piece.kind === 'link' || (piece.kind === 'text' && piece.text.search(FULL_ESCAPE) >= 0)) ? STYLES : STYLES.slice(0, 1);
  const reads = (candidate: readonly Piece[]): boolean => styles.some((style) => says(render(style, candidate), candidate));
  if (reads(pieces)) return pieces;
  const repairs = options.repairs ?? markRepairs();
  const settled = (candidate: readonly Piece[]): Piece[] => settleMarks(shareWhitespaceMarks(candidate));
  /** A read that repair pays for. */
  const paidRead = (style: InlineStyle, candidate: readonly Piece[]): boolean => {
    const written = render(style, candidate);
    repairs.left -= written.length + READ_OVERHEAD;
    return says(written, candidate);
  };
  const withoutMarks = (piece: Piece): Piece => (isFormatted(piece) ? { ...piece, bold: false, italic: false } : piece);
  /** The run with each stretch at risk that does not read in this style given up a mark, or failing that all of them. */
  const givenUp = (run: readonly Piece[], style: InlineStyle, joined: (left: Piece, right: Piece) => boolean): Piece[] => {
    const out = [...run];
    for (let start = 0, end = 1; start < run.length; start = end, end = start + 1) {
      while (end < run.length && joined(run[end - 1], run[end])) end += 1;
      const stretch = Array.from({ length: end - start }, (_, offset) => start + offset).filter((index) => atRisk(run, index));
      if (stretch.length === 0) continue;
      const from = Math.max(0, start - 1);
      const beside = run.slice(from, end + 1).map((piece, offset) => (from + offset < start ? nearestWord(piece, 'last') : from + offset >= end ? nearestWord(piece, 'first') : piece));
      const holds = (candidate: readonly Piece[]): boolean => repairs.left > 0 && paidRead(style, settled(candidate));
      if (holds(beside)) continue;
      const attempts = (['italic', 'bold'] as const).flatMap((mark) => stretch.filter((index) => marked(run[index], mark) && !isSpacePiece(run[index])).map((index) => ({ mark, index })));
      const fix = attempts
        .slice(0, MAX_MARK_ATTEMPTS)
        .find(({ mark, index }) => holds(beside.map((piece, offset) => (from + offset === index ? { ...piece, [mark]: false } : piece))));
      if (fix) out[fix.index] = { ...run[fix.index], [fix.mark]: false };
      else for (let index = start; index < end; index += 1) out[index] = withoutMarks(run[index]);
    }
    return out;
  };
  const sameWord = (left: Piece, right: Piece): boolean => anyMark(left) && anyMark(right) && !isSpaceChar(edgeChars(left).last) && !isSpaceChar(edgeChars(right).first);
  const samePhrase = (left: Piece, right: Piece): boolean => anyMark(left) && anyMark(right);
  const repaired = (style: InlineStyle): Piece[] | null => {
    let current: Piece[] = pieces;
    for (const joined of [sameWord, samePhrase, () => true]) {
      current = settled(givenUp(current, style, joined));
      if (paidRead(style, current)) return current;
      if (repairs.left <= 0) return null;
    }
    return null;
  };
  // A word that needs a mark off in one style may read whole in another, so the style that kept the most wins.
  const kept = (candidate: readonly Piece[]): number =>
    candidate.reduce((sum, piece) => sum + (isFormatted(piece) ? (Number(piece.bold) + Number(piece.italic)) * piece.text.length : 0), 0);
  let best: Piece[] | null = null;
  for (const style of styles) {
    if (repairs.left <= 0) break;
    const candidate = repaired(style);
    if (candidate && (!best || kept(candidate) > kept(best))) best = candidate;
  }
  if (best) return best;
  const plain = joinPieces(pieces.map(withoutMarks));
  return reads(plain) ? plain : pieces;
}

/**
 * One spelling for every way of marking whitespace. Bold or italic whitespace looks like any other, so a run of it takes
 * exactly the marks shared by the content on both sides: inside a bold phrase it stays bold (one span, not two), at a
 * span's edge it is unmarked. Two documents that differ only there read the same and must write the same bytes, or the
 * writer is not stable: `_a _b` and `_a_ b` would otherwise come back different.
 *
 * A code span or a link whose text runs across lines loses its bold or italic: emphasis does not cross a line, so the
 * format cannot mark it.
 */
function canonicalPieces(plugins: readonly MarkdownPlugin[], pieces: readonly Piece[]): Piece[] {
  const marked = pieces.map((piece) => ((piece.kind === 'code' || piece.kind === 'link') && (piece.bold || piece.italic) ? { ...piece, ...markableAs(piece, plugins) } : piece));
  return settleMarks(shareWhitespaceMarks(marked));
}

function isSpacePiece(piece: Piece | undefined): boolean {
  return piece?.kind === 'text' && piece.text.trim() === '';
}

/** Whitespace takes the marks shared by the content on both sides (see `canonicalPieces`). Text is split at whitespace to do it. */
function shareWhitespaceMarks(pieces: readonly Piece[]): Piece[] {
  const split = pieces.flatMap((piece): Piece[] => (piece.kind === 'text' ? piece.text.split(/(\s+)/).filter((text) => text !== '').map((text) => ({ ...piece, text })) : [piece]));
  const marksOf = (piece: Piece | undefined): { bold: boolean; italic: boolean } =>
    piece && isFormatted(piece) ? { bold: piece.bold, italic: piece.italic } : { bold: false, italic: false };
  return split.map((piece, index) => {
    if (!isSpacePiece(piece)) return piece;
    let before = index - 1;
    while (before >= 0 && isSpacePiece(split[before])) before -= 1;
    let after = index + 1;
    while (after < split.length && isSpacePiece(split[after])) after += 1;
    const left = marksOf(split[before]);
    const right = marksOf(split[after]);
    return { ...(piece as Formatted), bold: left.bold && right.bold, italic: left.italic && right.italic };
  });
}

/** Fit the marks to the flanking rules. Each mark given up can change what the whitespace beside it shares, so it repeats until nothing changes. */
function settleMarks(pieces: readonly Piece[]): Piece[] {
  let current = joinPieces(pieces);
  for (let fitted = fitMarksToFlanking(current); fitted !== current; fitted = fitMarksToFlanking(current)) {
    current = joinPieces(shareWhitespaceMarks(fitted));
  }
  return current;
}

/**
 * Text with the same marks joins; so does code, and a link to one place, which the format would otherwise write as two
 * spans that the editor joins on the way back.
 */
function joinPieces(pieces: readonly Piece[]): Piece[] {
  const out: Piece[] = [];
  for (const next of pieces) {
    const prev = out[out.length - 1];
    const sameMarks = prev !== undefined && isFormatted(prev) && isFormatted(next) && prev.bold === next.bold && prev.italic === next.italic;
    const joins =
      sameMarks &&
      prev.kind === next.kind &&
      (next.kind === 'text' || next.kind === 'code' || (next.kind === 'link' && prev.kind === 'link' && prev.href === next.href));
    if (joins) (prev as { text: string }).text += (next as { text: string }).text;
    else out.push({ ...next });
  }
  return out;
}

/** A URL that reads back whole when written bare, whatever span is around it: `*` could close one, and the rest would end it. */
const BARE_URL = /^https:\/\/[^\s<>()[\]'"*]*[^\s<>()[\].,;:!?'"*]$/;

function writesBare(link: Extract<Piece, { kind: 'link' }>): boolean {
  return link.text === link.href && BARE_URL.test(link.href);
}

/**
 * What a piece writes first and last, as the flanking rules see it. A link counts as bracketed, as a bare one may not
 * survive, unless it is marked and can be written bare: that is the one spelling that can mark it beside a word
 * (`x*https://a.b*y`), and `readableMarks` checks that it reads.
 */
function edgeChars(piece: Piece): { first: string; last: string } {
  switch (piece.kind) {
    case 'text':
    case 'atom':
      return { first: charAt(piece.text, 0), last: charBefore(piece.text, piece.text.length) };
    case 'break':
      return { first: '\n', last: '\n' };
    case 'code':
      return { first: '`', last: '`' };
    case 'pageLink':
      return { first: '[', last: ']' };
    case 'image':
      return { first: '!', last: ')' };
    case 'link':
      return (piece.bold || piece.italic) && writesBare(piece) ? { first: charAt(piece.href, 0), last: charBefore(piece.href, piece.href.length) } : { first: '[', last: ')' };
    default:
      return { first: '[', last: ')' };
  }
}

// With the whitespace beside it, which a span's edge never holds.
const LEADING_PUNCTUATION = /^[\p{P}\p{S}]+\s*/u;
const TRAILING_PUNCTUATION = /\s*[\p{P}\p{S}]+$/u;

/**
 * CommonMark cannot write every span: a marker between a word and punctuation is not a delimiter, so no spelling makes
 * `(b)` italic in `a(b)c`, or bold `Note:` directly before a word. Such a span gives up what it must for the text to stay
 * exactly as typed. Text at its edge gives up the punctuation (`a(_b_)c`), and a code span or link, which cannot be cut,
 * gives up the mark (a bare link keeps it where its own first and last characters flank: `x*https://a.b*y`). Two marks
 * starting or ending together are one run of `*` (`x***y***z`), so the character beside that run is what counts, and where
 * it cannot work italic is given up first, as in `markableAs`.
 *
 * Checked with `*`, the more permissive marker: if it cannot work, `_` cannot.
 */
function fitMarksToFlanking(pieces: Piece[]): Piece[] {
  if (!pieces.some((piece) => isFormatted(piece) && (piece.bold || piece.italic))) return pieces;
  const out = [...pieces];
  let changed = false;
  const marks = (piece: Piece): Array<'bold' | 'italic'> => (isFormatted(piece) ? (['bold', 'italic'] as const).filter((mark) => piece[mark]) : []);
  /** Take `lost` off a piece's edge punctuation, or off the whole piece when it holds nothing else or cannot be cut. */
  const giveUp = (index: number, lost: Array<'bold' | 'italic'>, edge: RegExp): void => {
    const piece = out[index] as Formatted;
    const without = Object.fromEntries(lost.map((mark) => [mark, false]));
    const part = piece.kind === 'text' && lost.length === 1 ? edge.exec(piece.text)?.[0] : undefined;
    if (part === undefined || part === (piece as { text: string }).text) {
      out[index] = { ...piece, ...without };
      return;
    }
    const text = (piece as { text: string }).text;
    const shed = { ...piece, ...without, text: part };
    const rest = { ...piece, text: edge === LEADING_PUNCTUATION ? text.slice(part.length) : text.slice(0, -part.length) };
    out.splice(index, 1, ...(edge === LEADING_PUNCTUATION ? [shed, rest] : [rest, shed]));
  };
  // Every change takes a mark off or cuts off punctuation that then holds fewer marks, so this ends.
  for (let index = 0; index + 1 < out.length; ) {
    const before = out[index];
    const after = out[index + 1];
    const beforeMarks = marks(before);
    const afterMarks = marks(after);
    const closing = beforeMarks.filter((mark) => !afterMarks.includes(mark));
    const opening = afterMarks.filter((mark) => !beforeMarks.includes(mark));
    const last = edgeChars(before).last;
    const first = edgeChars(after).first;
    // A span's edge whitespace is written outside it, and a span ending and another starting put a marker between them.
    const opens = opening.length === 0 || isSpaceChar(first) || canOpenEmphasis('*', closing.length > 0 ? '*' : last, first);
    const closes = closing.length === 0 || isSpaceChar(last) || canCloseEmphasis('*', last, opening.length > 0 ? '*' : first);
    if (opens && closes) {
      index += 1;
      continue;
    }
    changed = true;
    if (!opens) giveUp(index + 1, opening.length === 2 ? ['italic'] : opening, LEADING_PUNCTUATION);
    else giveUp(index, closing.length === 2 ? ['italic'] : closing, TRAILING_PUNCTUATION);
    index = Math.max(0, index - 1);
  }
  return changed ? out : pieces;
}

/**
 * The marks a code span or link can actually carry: both if the pair wraps it and reads back, else italic is given up
 * first, then bold. A span that runs across lines takes neither.
 */
function markableAs(piece: Extract<Piece, { kind: 'code' | 'link' }>, plugins: readonly MarkdownPlugin[]): { bold: boolean; italic: boolean } {
  const span = piece.kind === 'code' ? codeSpan(piece.text, {}) : `[${piece.text.replace(FULL_ESCAPE, '\\$&')}](${piece.href})`;
  const options: Array<{ bold: boolean; italic: boolean }> = [
    { bold: piece.bold, italic: piece.italic },
    { bold: piece.bold, italic: false },
    { bold: false, italic: piece.italic },
  ];
  for (const marks of options) {
    if (!marks.bold && !marks.italic) continue;
    const italic = marks.italic ? delimit(span, 'italic', plugins) : span;
    if (marks.italic && italic === span) continue;
    const both = marks.bold ? delimit(italic, 'bold', plugins) : italic;
    if (marks.bold && both === italic) continue;
    const expected = leaves(piecesToInline([{ ...piece, ...marks }]));
    if (JSON.stringify(leaves(parseDocInline(both, { plugins }))) === JSON.stringify(expected)) return marks;
  }
  return { bold: false, italic: false };
}

/**
 * A URL cannot escape a backtick, and a bare one would pair with the next code span's fence and swallow the text
 * between. `%60` is the same URL.
 */
export function encodeBackticks(url: string): string {
  return url.replace(/`/g, '%60');
}

function cleanTarget(value: string): string {
  return value.replace(/[[\]|\n]/g, '').trim();
}

function cleanLabel(value: string): string {
  return value.replace(/[[\]\n]/g, '').trim();
}

function cleanAlt(value: string): string {
  return value.replace(/[\]\n]/g, '');
}

/** The pieces as the inline tokens they are meant to read back as — the expectation `writeInlineVerified` checks. */
function piecesToInline(pieces: readonly Piece[]): DocInline[] {
  const wrap = (node: DocInline, bold: boolean, italic: boolean): DocInline => {
    let out = node;
    if (italic) out = { kind: 'emphasis', children: [out as never] };
    if (bold) out = { kind: 'strong', children: [out as never] };
    return out;
  };
  return pieces.map((piece): DocInline => {
    switch (piece.kind) {
      case 'text':
        return wrap({ kind: 'text', text: piece.text }, piece.bold, piece.italic);
      case 'break':
        return { kind: 'text', text: '\n' };
      case 'code':
        return wrap({ kind: 'code', text: piece.text }, piece.bold, piece.italic);
      case 'link':
        return wrap({ kind: 'link', href: piece.href, text: piece.text }, piece.bold, piece.italic);
      case 'anchorLink':
        return { kind: 'anchorLink', anchor: piece.anchor, text: piece.text };
      case 'atom':
        return wrap({ kind: 'atom', type: piece.type, attrs: piece.attrs, text: piece.text }, piece.bold, piece.italic);
      case 'pageLink':
        return { kind: 'pageLink', target: piece.target, ...(piece.label ? { label: piece.label } : {}) };
      case 'image':
        return { kind: 'image', src: piece.src, alt: piece.alt };
    }
  });
}

/**
 * Render pieces as markdown text. Bold and italic become nested spans over maximal runs (bold outside italic); each span's
 * delimiter is chosen so its own content cannot close it early.
 */
function writePieces(pieces: readonly Piece[], style: InlineStyle, options: InlineOptions): string {
  const raw = renderSpans(pieces, style, options, 'bold');
  return options.lineStarts ? escapeLineStarts(raw, options.inCallout ?? false) : raw;
}

type Formatted = Extract<Piece, { bold: boolean }>;

function isFormatted(piece: Piece): piece is Formatted {
  return 'bold' in piece;
}

/** The characters written either side of a span, which decide whether its delimiters read as delimiters. */
interface SpanEdges {
  before: string;
  after: string;
}

const NO_EDGES: SpanEdges = { before: '', after: '' };
/**
 * What sits beside a span nested in another. That span's delimiter does, but beside a word only `*` can write the outer
 * span, and only if the inner one touching that edge takes `*` too, as one run (`x***y***z`). So a word shows through.
 */
function insideSpan(edges: SpanEdges): SpanEdges {
  const isWord = (char: string): boolean => !isSpaceChar(char) && !isPunctuationChar(char);
  return { before: isWord(edges.before) ? edges.before : '*', after: isWord(edges.after) ? edges.after : '*' };
}

function renderSpans(pieces: readonly Piece[], style: InlineStyle, options: InlineOptions, mark: 'bold' | 'italic' | null, edges: SpanEdges = NO_EDGES): string {
  if (mark === null) return pieces.map((piece, index) => renderPiece(piece, style, options, pieces[index + 1])).join('');
  let out = '';
  // Kept apart from `out`, because reading a character of a string being built flattens it: a long run would cost its square.
  let before = edges.before;
  const write = (written: string): void => {
    out += written;
    if (written !== '') before = charBefore(written, written.length);
  };
  let index = 0;
  const around = (end: number): SpanEdges => ({
    before,
    after: end < pieces.length ? (nextLeadChar(pieces[end]) ?? '') : edges.after,
  });
  while (index < pieces.length) {
    const piece = pieces[index];
    if (!isFormatted(piece) || !piece[mark]) {
      // A run without this mark, rendered for the next mark in.
      let end = index;
      while (end < pieces.length && !(isFormatted(pieces[end]) && (pieces[end] as Formatted)[mark])) end += 1;
      write(renderSpans(pieces.slice(index, end), style, options, mark === 'bold' ? 'italic' : null, around(end)));
      index = end;
      continue;
    }
    let end = index;
    while (end < pieces.length && isFormatted(pieces[end]) && (pieces[end] as Formatted)[mark] && pieces[end].kind !== 'break') end += 1;
    const inner = pieces.slice(index, end).map((p) => ({ ...(p as Formatted), [mark]: false }));
    write(wrapRun(inner, mark, style, options, around(end)));
    index = end;
  }
  return out;
}

/**
 * One bold or italic run, wrapped. When no delimiter holds the whole run (its text, or the spans nested in it, hold
 * both `*` and `_`), it is written as adjacent spans: first parts that each avoid one delimiter, then one span per
 * piece. Adjacent spans read back as one run. Only content no span can hold is left unmarked.
 */
function wrapRun(inner: readonly Formatted[], mark: 'bold' | 'italic', style: InlineStyle, options: InlineOptions, edges: SpanEdges): string {
  const render = (part: readonly Formatted[], around: SpanEdges): string => renderSpans(part, style, options, mark === 'bold' ? 'italic' : null, insideSpan(around));
  const whole = render(inner, edges);
  const wrapped = delimit(whole, mark, options.plugins ?? [], edges);
  if (wrapped !== whole || whole.trim() === '') return wrapped;
  const attempt = (parts: readonly Formatted[][]): string | null => {
    let out = '';
    let before = edges.before;
    for (const [index, part] of parts.entries()) {
      const around: SpanEdges = { before, after: index === parts.length - 1 ? edges.after : '*' };
      const content = render(part, around);
      const span = delimit(content, mark, options.plugins ?? [], around);
      if (span === content && content.trim() !== '') return null;
      out += span;
      if (span !== '') before = charBefore(span, span.length);
    }
    return out;
  };
  return (
    attempt(splitByDelimiters(inner)) ??
    attempt(inner.flatMap((piece) => (piece.kind === 'text' ? splitByDelimiters([piece]) : [[piece]]))) ??
    whole
  );
}

/** Cut a run into the fewest consecutive parts that each hold `*` or `_` but not both. Text is cut between characters. */
function splitByDelimiters(pieces: readonly Formatted[]): Formatted[][] {
  const parts: Formatted[][] = [[]];
  let star = false;
  let under = false;
  const push = (piece: Formatted, hasStar: boolean, hasUnder: boolean): void => {
    if ((star && hasUnder && !hasStar) || (under && hasStar && !hasUnder) || (hasStar && hasUnder)) {
      if (parts[parts.length - 1].length > 0) parts.push([]);
      star = false;
      under = false;
    }
    const current = parts[parts.length - 1];
    const prev = current[current.length - 1];
    if (piece.kind === 'text' && prev?.kind === 'text' && prev.bold === piece.bold && prev.italic === piece.italic) prev.text += piece.text;
    else current.push({ ...piece });
    star ||= hasStar;
    under ||= hasUnder;
  };
  for (const piece of pieces) {
    if (piece.kind === 'text') for (const char of piece.text) push({ ...piece, text: char }, char === '*', char === '_');
    else if (piece.kind === 'atom') push(piece, piece.text.includes('*'), piece.text.includes('_'));
    else {
      // A code span or link is a part of its own, whatever it holds: a marker inside one is not a marker.
      if (parts[parts.length - 1].length > 0) parts.push([]);
      parts[parts.length - 1].push({ ...piece });
      parts.push([]);
      star = false;
      under = false;
    }
  }
  return parts.filter((part) => part.length > 0);
}

/**
 * Wrap a span. The delimiter is the one that reads as a delimiter between the characters around it (`_` does not work
 * inside a word) and that the content does not close early; content that trips both is written without the mark rather
 * than with a broken one. Edge whitespace is written outside the span, and a span of only whitespace bare: bold or
 * italic whitespace looks like any other.
 */
function delimit(content: string, mark: 'bold' | 'italic', plugins: readonly MarkdownPlugin[], edges: SpanEdges = NO_EDGES): string {
  // Whitespace at a span's edges goes outside it: `* a *` at the start of a line would read as a list item.
  const lead = /^\s*/.exec(content)?.[0] ?? '';
  const core = content.slice(lead.length).trimEnd();
  const trail = content.slice(lead.length + core.length);
  if (core === '') return content;
  const candidates = mark === 'bold' ? ['**', '__'] : ['_', '*'];
  const before = lead === '' ? edges.before : charBefore(lead, lead.length);
  const after = trail === '' ? edges.after : charAt(trail, 0);
  const kind = mark === 'bold' ? 'strong' : 'emphasis';
  for (const delim of candidates) {
    // A nested span's delimiter joins this one's run when it is the same marker, so the characters past it are what flank.
    const joined = delim[0] === '*' ? core.replace(/^\*+/, '') : core;
    const first = charAt(joined, 0);
    const last = delim[0] === '*' ? trimTrailingStars(core) : core;
    if (!canOpenEmphasis(delim[0], before, first) || !canCloseEmphasis(delim[0], charBefore(last, last.length), after)) continue;
    const body = `${delim}${core}${delim}`;
    const [token, ...rest] = parseDocInline(body, { plugins });
    if (rest.length !== 0 || token === undefined) continue;
    // `***a***` reads as a span in a span, with either on the outside.
    const onlyChild = (token.kind === 'strong' || token.kind === 'emphasis') && token.children.length === 1 ? token.children[0] : undefined;
    if (token.kind === kind || onlyChild?.kind === kind) return `${lead}${body}${trail}`;
  }
  return content;
}

function trimTrailingStars(text: string): string {
  let end = text.length;
  while (end > 0 && text[end - 1] === '*') end -= 1;
  return text.slice(0, end);
}

/** Characters that can open markup somewhere in the inline grammar; escaped when a run is written defensively. */
const FULL_ESCAPE = /[\\`*_[\]()<{#|!]/g;
/** Punctuation a backslash escapes (the inline grammar's escape branch). A backslash before one of these must itself be escaped. */
const ESCAPABLE = /[\\`*_{}[\]()<>#+\-.!|~:]/;

function escapeText(text: string, style: InlineStyle, options: InlineOptions, next: Piece | undefined): string {
  let out: string;
  if (style.escape === 'full') {
    out = text.replace(FULL_ESCAPE, '\\$&').replace(/https:/g, 'https\\:');
  } else {
    out = '';
    for (let index = 0; index < text.length; index += 1) {
      const char = text[index];
      const after = index + 1 < text.length ? text[index + 1] : nextLeadChar(next);
      if (char === '\\' && (after === undefined || ESCAPABLE.test(after))) out += '\\\\';
      else out += char;
    }
    // Text that spells a URL is not a link; left bare, the autolink rule would make it one.
    out = out.replace(/https:/g, 'https\\:');
  }
  // A table cell is cut on every unescaped `|` before its text is read, so a literal one is always escaped there.
  if (options.table) out = out.replace(/(?<!\\)\|/g, '\\|');
  return out;
}

/** The first character the next piece will write, when the boundary matters to an escape. */
function nextLeadChar(next: Piece | undefined): string | undefined {
  if (!next) return undefined;
  if (next.kind === 'break') return '\n';
  if (isFormatted(next) && (next.bold || next.italic)) return '*';
  switch (next.kind) {
    case 'text':
      return charAt(next.text, 0);
    case 'code':
      return '`';
    case 'atom':
      return charAt(next.text, 0);
    case 'image':
      return '!';
    default:
      return '[';
  }
}

function renderPiece(piece: Piece, style: InlineStyle, options: InlineOptions, next: Piece | undefined): string {
  switch (piece.kind) {
    case 'text':
      return escapeText(piece.text, style, options, next);
    case 'break':
      return '\n';
    case 'code':
      return codeSpan(piece.text, options);
    case 'link': {
      // A label reads its escapes, so it is escaped like text: brackets always, the rest when written defensively.
      const label = style.escape === 'full' ? piece.text.replace(FULL_ESCAPE, '\\$&') : piece.text.replace(/[\\[\]]/g, '\\$&');
      const href = piece.href;
      const tableSafe = (value: string): string => (options.table ? value.replace(/\|/g, '\\|') : value);
      if (style.bareAutolinks && piece.text === href && HTTPS_HREF.test(href)) return tableSafe(href);
      return tableSafe(`[${label}](${href})`);
    }
    case 'anchorLink':
      return `[${options.table ? piece.text.replace(/\|/g, '\\|') : piece.text}](#${piece.anchor})`;
    case 'atom':
      return options.table ? piece.text.replace(/\|/g, '\\|') : piece.text;
    case 'pageLink':
      // In a table the label's `|` is escaped: the row is cut on bare pipes before the cell is read.
      return `[[${piece.target}${piece.label ? `${options.table ? '\\|' : '|'}${piece.label}` : ''}]]`;
    case 'image':
      return `![${options.table ? piece.alt.replace(/\|/g, '\\|') : piece.alt}](${piece.src})`;
  }
}

/**
 * A code span whose fence is longer than any backtick run inside it, padded when the content starts or ends badly. A
 * span running across lines cannot hold a line of only whitespace (a blank line ends the paragraph first) or one that
 * reads as a table delimiter (`-|` under a line with a pipe), so it is cut into adjacent spans before such a line: the
 * line then starts with a fence, which is neither blank nor a delimiter cell.
 */
function codeSpan(text: string, options: InlineOptions): string {
  const lines = text.split('\n');
  const chunks: string[] = [];
  let current = '';
  lines.forEach((line, index) => {
    const last = index === lines.length - 1;
    // A line the block grammar would read first: blank (it ends the paragraph), a table delimiter, or a block's start
    // (a list item, a heading, a quote, a fence, `:::` in a callout). Starting it with the next span's fence keeps it
    // in the paragraph; an escape cannot, as code takes no escapes.
    const hazard = index > 0 && ((!last && line.trim() === '') || isDelimiterRow(line) || readsAsBlock(line, false, options.inCallout ?? false));
    // The two fences meet at the start of the line; a run of three backticks there would read as a code fence, so a
    // span holding a backtick (fence of two or more) cannot be cut. That shape is beyond the format and is written whole.
    if (hazard && current !== '' && !current.includes('`') && !lines.slice(index).join('\n').includes('`')) {
      chunks.push(current);
      current = '';
    }
    current += last ? line : `${line}\n`;
  });
  if (current !== '') chunks.push(current);
  return chunks.map((chunk) => oneCodeSpan(chunk, options)).join('');
}

function oneCodeSpan(text: string, options: InlineOptions): string {
  const longest = (text.match(/`+/g) ?? []).reduce((most, run) => Math.max(most, run.length), 0);
  const fence = '`'.repeat(longest + 1);
  const pad = text.startsWith('`') || text.endsWith('`') || (text.startsWith(' ') && text.endsWith(' ') && text.trim() !== '');
  const body = pad ? ` ${text} ` : text;
  const span = `${fence}${body}${fence}`;
  return options.table ? span.replace(/\|/g, '\\|') : span;
}

/** What the block grammar reads at the start of any paragraph line (`parse.ts`, in its own order). */
const BLOCK_START = [
  /^\s*```/, // a fence
  /^ {0,3}:::\s*[A-Za-z]/, // a callout
  /^ {0,3}#{1,6}[ \t]/, // a heading
  /^ {0,3}(?:-{3,}|\*{3,}|_{3,})[ \t]*$/, // a divider
  /^ {0,3}>/, // a quote
];
/** A list item starts a paragraph at any indent, but interrupts one only at an indent of three or less. */
const LIST_START = /^(\s*)(?:[-*+]|\d{1,9}[.)])\s/;

/**
 * A line of a paragraph that would read as the start of a block gets its first marker character escaped. Every
 * paragraph line is checked, not only the first: inside a list item or a callout, any line can be the one the block
 * grammar sees first. The rules are the parser's own, no broader: an escape inside a code span that runs across lines
 * would change the code.
 */
function escapeLineStarts(text: string, inCallout: boolean): string {
  const lines = text.split('\n');
  return lines
    .map((line, index) => {
      // A line that reads as a table delimiter turns the line above it into a table header when that line has a pipe.
      // Above a paragraph's first line sits whatever holds it (a list item's line, say), so that one is always escaped;
      // it holds only pipes, dashes and colons, so it cannot be inside a code span.
      if (isDelimiterRow(line) && (index === 0 || lines[index - 1].includes('|'))) return line.replace('|', '\\|');
      if (!readsAsBlock(line, index === 0, inCallout)) return line;
      const at = line.search(/\S/);
      const digits = /^\d{1,9}/.exec(line.slice(at));
      const cut = digits ? at + digits[0].length : at;
      return `${line.slice(0, cut)}\\${line.slice(cut)}`;
    })
    .join('\n');
}

/** A paragraph line the block grammar reads as a block's start; `first` is the paragraph's first line. */
function readsAsBlock(line: string, first: boolean, inCallout: boolean): boolean {
  const list = LIST_START.exec(line);
  if (list !== null && (first || indentWidth(list[1]) <= 3)) return true;
  // A bare `:::` is text, except inside a callout, which it closes.
  if (inCallout && CALLOUT_CLOSE.test(line)) return true;
  return BLOCK_START.some((pattern) => pattern.test(line));
}

function indentWidth(lead: string): number {
  let width = 0;
  for (const char of lead) width += char === '\t' ? 4 - (width % 4) : 1;
  return width;
}

/**
 * What an editor inline run MEANS, as a reader's leaves: the content the writer must make a reader see. The
 * round-trip test compares this with what the parser actually reads back, so escaping is checked against intent
 * rather than against itself.
 */
export function editorInlineLeaves(nodes: readonly JSONContent[], options: GrammarOptions = {}): InlineLeaf[] {
  return leaves(piecesToInline(toPieces(nodes, { plugins: options.plugins ?? [] })));
}

// ─── comparison ────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * An inline run flattened to leaves, each with the set of marks around it, adjacent text with the same marks joined.
 * Two runs with the same leaves render identically however their spans nest (`**_a_**` and `_**a**_`), and whether or
 * not a mark covers the whitespace between words.
 */
export interface InlineLeaf {
  kind: string;
  marks: string;
  [key: string]: string | undefined;
}

export function leaves(nodes: readonly DocInline[]): InlineLeaf[] {
  const out: InlineLeaf[] = [];
  for (const leaf of collectLeaves(nodes, [])) {
    const last = out[out.length - 1];
    // Adjacent text joins, and so do adjacent code spans and links to one target: the editor holds `a``b` as one code
    // run and two links to one place as one link, and they look the same.
    const joins =
      last?.kind === leaf.kind &&
      last.marks === leaf.marks &&
      (leaf.kind === 'text' || leaf.kind === 'code' || (leaf.kind === 'link' && last.href === leaf.href) || (leaf.kind === 'anchorLink' && last.anchor === leaf.anchor));
    if (joins && last) last.text = `${last.text ?? ''}${leaf.text ?? ''}`;
    else out.push({ ...leaf });
  }
  return out;
}

function collectLeaves(nodes: readonly DocInline[], marks: readonly string[]): InlineLeaf[] {
  const out: InlineLeaf[] = [];
  const key = [...new Set(marks)].sort().join(',');
  for (const node of nodes) {
    switch (node.kind) {
      case 'strong':
        pushAll(out, collectLeaves(node.children, [...marks, 'bold']));
        break;
      case 'emphasis':
        pushAll(out, collectLeaves(node.children, [...marks, 'italic']));
        break;
      case 'text':
        // Bold or italic whitespace looks like plain whitespace, so whitespace never counts as marked.
        for (const text of node.text.split(/(\s+)/)) {
          if (text !== '') out.push({ kind: 'text', marks: key && text.trim() !== '' ? key : '', text });
        }
        break;
      case 'code':
        // An empty code span renders as nothing, and the editor has no empty text to hold it.
        if (node.text !== '') out.push({ kind: 'code', marks: key, text: node.text });
        break;
      case 'link':
        out.push({ kind: 'link', marks: key, href: encodeBackticks(node.href), text: node.text });
        break;
      case 'anchorLink':
        out.push({ kind: 'anchorLink', marks: key, anchor: node.anchor, text: node.text });
        break;
      // A plugin's token is an inline atom, which holds no marks in the editor (see `schema.ts`): around one they do not count.
      case 'atom':
        out.push({ kind: 'atom', marks: '', type: node.type, text: node.text });
        break;
      case 'pageLink':
        out.push({ kind: 'pageLink', marks: key, target: node.target, label: node.label });
        break;
      case 'image':
        out.push({ kind: 'image', marks: key, src: encodeBackticks(node.src), alt: node.alt });
        break;
    }
  }
  return out;
}

/**
 * A run with the whitespace its container trims taken off: a heading's or a table cell's edges, a list item's start, a
 * paragraph's start. Whitespace a mark wrapped (`_ _`) is trimmed too: a reader sees nothing there either way.
 */
export function trimLeaves(run: readonly InlineLeaf[], trim: 'start' | 'both' | undefined): InlineLeaf[] {
  if (!trim) return [...run];
  const out = run.map((leaf) => ({ ...leaf }));
  while (out[0]?.kind === 'text') {
    const text = (out[0].text ?? '').replace(/^\s+/, '');
    if (text !== '') {
      out[0].text = text;
      break;
    }
    out.shift();
  }
  while (trim === 'both' && out[out.length - 1]?.kind === 'text') {
    const last = out[out.length - 1];
    const text = (last.text ?? '').trimEnd();
    if (text !== '') {
      last.text = text;
      break;
    }
    out.pop();
  }
  return out;
}

function sameLeaves(a: readonly InlineLeaf[], b: readonly InlineLeaf[]): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
