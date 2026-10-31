import type { JSONContent } from '@tiptap/core';
import fc from 'fast-check';
import type { DocBlock, DocInline } from '../src/parse.js';
import { parseDocBody } from './grammar.js';

/**
 * The round-trip gate's two generators, shared by the editor leg (`codec.test.ts`) and the co-editing
 * leg (`codec.yjs.test.ts`):
 *   · `page`: adversarial markdown text, built line by line from every block marker and every piece of inline punctuation
 *     the grammar reacts to, so the parser is fed the shapes a writer would never produce on purpose;
 *   · `docArb`: editor documents built from every node and mark in the schema, with text drawn from the same risky
 *     alphabet, so the writer has to escape what the user typed.
 *
 * Runs are seeded so CI is deterministic. `FC_SEED` / `FC_RUNS` explore further locally:
 *   FC_RUNS=20000 bun run test
 */
export const SEED = Number(process.env.FC_SEED) || 1111;
const RUNS = Number(process.env.FC_RUNS) || 400;
export const PARAMS = { seed: SEED, numRuns: RUNS };

// ─── generator 1: adversarial pages ────────────────────────────────────────────────────────────────────────────────

const word = fc.constantFrom('alpha', 'beta', 'x', 'D28', 'ABC-12', 'snake_case', 'C:\\dir', 'naïve', '日本', '1.5', 'a+b');
const risky = fc.constantFrom(
  '*', '**', '_', '__', '`', '``', '\\', '[', ']', '(', ')', '<', '>', '{', '}', '#', '|', ':', '!', '-', '+', '.', '~', '@',
  '<@u1>', '<@bad id>', '[x](https://a.b)', '[x](http://a.b)', 'https://ex.am/p', 'https://ex.am/p.', '[[D28]]', '[[a/b|Label]]',
  '![alt](attachment:k1)', '![alt](https://ex.am/i.png)', '[t](#anchor)', '{#id}', '\\*', '\\_', '\\[', '\\:', ' ', '  ', '\t',
);
const inlineText = fc.array(fc.oneof({ weight: 3, arbitrary: word }, { weight: 3, arbitrary: risky }, { weight: 2, arbitrary: fc.constant(' ') }), {
  minLength: 1,
  maxLength: 10,
}).map((parts) => parts.join(''));

const indent = fc.constantFrom('', '', '', ' ', '  ', '   ', '    ', '\t');
const line = fc.oneof(
  { weight: 6, arbitrary: inlineText },
  { weight: 1, arbitrary: fc.tuple(fc.integer({ min: 1, max: 7 }), inlineText).map(([n, t]) => `${'#'.repeat(n)} ${t}`) },
  { weight: 1, arbitrary: fc.tuple(fc.integer({ min: 1, max: 3 }), inlineText, fc.constantFrom('', ' {#pin}', ' {#D28.9}', ' ##')).map(([n, t, s]) => `${'#'.repeat(n)} ${t}${s}`) },
  { weight: 3, arbitrary: fc.tuple(indent, fc.constantFrom('- ', '* ', '+ ', '1. ', '2) ', '10. ', '- [ ] ', '- [x] ', '-  '), inlineText).map(([i, m, t]) => `${i}${m}${t}`) },
  { weight: 2, arbitrary: fc.tuple(fc.constantFrom('> ', '>', '> > ', ' > '), inlineText).map(([m, t]) => `${m}${t}`) },
  { weight: 1, arbitrary: fc.constantFrom('```', '```ts', '```mermaid', '  ```', '```js title') },
  { weight: 1, arbitrary: fc.tuple(fc.constantFrom(':::note', ':::tip', ':::warning', ':::danger', ':::info', ':::bogus', '::: note'), fc.constantFrom('', ' Title', ' **T**')).map(([a, b]) => `${a}${b}`) },
  { weight: 1, arbitrary: fc.constantFrom(':::', ' :::', ':::  ') },
  { weight: 1, arbitrary: fc.constantFrom('---', '***', '___', '- - -', '----') },
  { weight: 2, arbitrary: fc.array(inlineText, { minLength: 1, maxLength: 3 }).map((cells) => `| ${cells.join(' | ')} |`) },
  { weight: 1, arbitrary: fc.constantFrom('| --- | --- |', '| :--- | ---: |', '|---|', '| :-: |', '--- | ---') },
  { weight: 2, arbitrary: fc.constant('') },
);
export const page = fc
  .array(line, { minLength: 1, maxLength: 14 })
  .map((lines) => lines.join('\n'))
  // A code span running across lines that holds a backtick is beyond the format when one of its lines would read as a block
  // on its own (see the codec): pages with one are left out.
  .filter((body) => !inlineCodeOf(parseDocBody(body)).some((code) => code.includes('\n') && code.includes('`')));

function inlineCodeOf(blocks: readonly DocBlock[]): string[] {
  const fromInline = (run: readonly DocInline[]): string[] =>
    run.flatMap((node) => (node.kind === 'code' ? [node.text] : node.kind === 'strong' || node.kind === 'emphasis' ? fromInline(node.children) : []));
  return blocks.flatMap((block): string[] => {
    switch (block.kind) {
      case 'paragraph':
      case 'heading':
        return fromInline(block.inline);
      case 'quote':
      case 'callout':
        return inlineCodeOf(block.blocks);
      case 'list':
        return block.items.flatMap((item) => [...fromInline(item.inline), ...inlineCodeOf(item.children)]);
      case 'table':
        return [...block.header, ...block.rows.flat()].flatMap(fromInline);
      default:
        return [];
    }
  });
}

// ─── generator 2: editor documents ─────────────────────────────────────────────────────────────────────────────────

// Text as a user types it: words, spaces, and every character the grammar reacts to. No newline (that is a hard break).
const typed = fc
  .array(
    fc.oneof(
      { weight: 4, arbitrary: word },
      { weight: 3, arbitrary: fc.constantFrom('*', '_', '`', '\\', '[', ']', '(', ')', '<', '<@u1>', '{#x}', '#', '|', ':', '!', '-', '+', '.', 'https://a.b', '[[p]]', '![a](attachment:k)', '[t](#a)', ':::', '```', '> ', '- ', '1. ') },
      { weight: 2, arbitrary: fc.constant(' ') },
    ),
    { minLength: 1, maxLength: 6 },
  )
  .map((parts) => parts.join(''));

type MarkSet = NonNullable<JSONContent['marks']>;
const formatting = fc.subarray([{ type: 'bold' }, { type: 'italic' }] as MarkSet);
const href = fc.constantFrom('https://a.example/x', 'https://b.example/y?q=1', '#anchor', '#D28.9');

const textNode = fc.oneof(
  { weight: 6, arbitrary: fc.tuple(typed, formatting).map(([text, marks]): JSONContent => ({ type: 'text', text, ...(marks.length ? { marks } : {}) })) },
  // Code holding two backticks in a row needs a three-backtick fence, which at the start of a paragraph line the format reads
  // as a code fence (see the codec): left out.
  { weight: 1, arbitrary: fc.tuple(typed.filter((text) => !text.includes('``')), formatting).map(([text, marks]): JSONContent => ({ type: 'text', text, marks: [...marks, { type: 'code' }] })) },
  {
    weight: 1,
    arbitrary: fc.tuple(typed, formatting, href).map(([text, marks, link]): JSONContent => ({
      type: 'text',
      text,
      marks: [...(link.startsWith('#') ? [] : marks), { type: 'link', attrs: { href: link } }],
    })),
  },
);
// Inline atoms carry no marks: the editor takes them off (see `schema.ts`).
const atom = fc.oneof(
  fc.constantFrom('u1', 'user-2', 'abc_DEF').map((id): JSONContent => ({ type: 'mention', attrs: { id } })),
  fc.tuple(fc.constantFrom('D28', 'a/b', 'chart:n-1', 'Some page'), fc.constantFrom(null, 'Label', 'D28')).map(([target, label]): JSONContent => ({ type: 'pageLink', attrs: { target, label } })),
  fc.tuple(fc.constantFrom('attachment:k1', 'https://a.example/i.png'), fc.constantFrom('', 'alt text', 'a*b')).map(([src, alt]): JSONContent => ({ type: 'image', attrs: { src, alt } })),
);

/** A code span that runs across a line, as the codec holds it (the newline is the span's text). Only where lines break. */
const codeAcrossLine = fc
  .tuple(typed, typed, formatting)
  .filter(([a, b]) => !`${a}${b}`.includes('``'))
  .map(([a, b, marks]): JSONContent => ({ type: 'text', text: `${a}\n${b}`, marks: [...marks, { type: 'code' }] }));

/** Inline content as an editor holds it: adjacent text with the same marks joined, as ProseMirror itself joins it. */
function inline(options: { breaks: boolean; edges: 'unindented' | 'trimmed' }): fc.Arbitrary<JSONContent[]> {
  const item = options.breaks
    ? fc.oneof(
        { weight: 6, arbitrary: textNode },
        { weight: 2, arbitrary: atom },
        { weight: 1, arbitrary: fc.constant<JSONContent>({ type: 'hardBreak' }) },
        { weight: 1, arbitrary: codeAcrossLine },
      )
    : fc.oneof({ weight: 6, arbitrary: textNode }, { weight: 2, arbitrary: atom });
  return fc
    .array(item, { minLength: 1, maxLength: 6 })
    .map((nodes) => tidyInline(nodes, options.edges))
    .filter((nodes) => nodes.some((node) => node.type !== 'hardBreak' && (node.type !== 'text' || (node.text ?? '').trim() !== '')))
    // A code span across lines that holds a backtick cannot be cut where a line would read as a block (see the codec).
    // Code runs side by side may be written as one span, so a backtick in any of them counts.
    .filter((nodes) => {
      const code = nodes.filter((node) => node.marks?.some((mark) => mark.type === 'code')).map((node) => node.text ?? '');
      return !(code.some((text) => text.includes('\n')) && code.some((text) => text.includes('`')));
    });
}

/**
 * The shapes the format cannot hold, kept out of generated documents (each is covered by a documented normalisation above):
 * a hard break first, last or twice in a row, a line of only whitespace, whitespace before a paragraph's first word, and
 * whitespace at either edge of a run the format trims (a heading, a table cell, a list item's first line).
 */
function tidyInline(nodes: JSONContent[], edges: 'unindented' | 'trimmed'): JSONContent[] {
  const out: JSONContent[] = [];
  for (const node of nodes) {
    const prev = out[out.length - 1];
    if (node.type === 'hardBreak' && (!prev || prev.type === 'hardBreak')) continue;
    if (node.type === 'text' && prev?.type === 'text' && JSON.stringify(prev.marks ?? []) === JSON.stringify(node.marks ?? [])) {
      out[out.length - 1] = { ...prev, text: `${prev.text}${node.text}` };
      continue;
    }
    out.push(node);
  }
  while (out[out.length - 1]?.type === 'hardBreak') out.pop();
  // No line made of whitespace alone: a blank line ends a paragraph.
  const lines: JSONContent[][] = [[]];
  for (const node of out) if (node.type === 'hardBreak') lines.push([]); else lines[lines.length - 1].push(node);
  const kept = lines.filter((run) => run.some((node) => node.type !== 'text' || (node.text ?? '').trim() !== ''));
  const joined = kept.flatMap((run, index) => (index > 0 ? [{ type: 'hardBreak' }, ...run] : run));
  return trimEdges(joined, edges === 'trimmed');
}

function trimEdges(nodes: JSONContent[], both: boolean): JSONContent[] {
  const out = nodes.map((node) => ({ ...node }));
  while (out[0]?.type === 'text') {
    out[0].text = (out[0].text ?? '').replace(/^\s+/, '');
    if (out[0].text !== '') break;
    out.shift();
  }
  while (both && out[out.length - 1]?.type === 'text') {
    const last = out[out.length - 1];
    last.text = (last.text ?? '').replace(/\s+$/, '');
    if (last.text !== '') break;
    out.pop();
  }
  return out;
}

const paragraphNode = inline({ breaks: true, edges: 'trimmed' }).map((content): JSONContent => ({ type: 'paragraph', content }));
const headingNode = fc
  .tuple(fc.integer({ min: 1, max: 6 }), fc.constantFrom(null, 'pin', 'D28.9'), inline({ breaks: false, edges: 'trimmed' }))
  .filter(([, , content]) => content.length > 0)
  .map(([level, anchor, content]): JSONContent => ({ type: 'heading', attrs: { level, anchor }, content }));
const codeText = fc.array(fc.constantFrom('const a = 1;', '  indented', '', '\ttab', '<b>html</b>', '# not a heading', '- not a list', ':::', '> q', '|a|'), { minLength: 1, maxLength: 4 }).map((lines) => lines.join('\n'));
const codeNode = fc.tuple(fc.constantFrom(null, 'ts', 'python', 'sh'), codeText).map(([language, text]): JSONContent => ({ type: 'codeBlock', attrs: { language }, content: text ? [{ type: 'text', text }] : undefined }));
const mermaidNode = fc.constantFrom('graph TD\n  A-->B', 'sequenceDiagram\n  A->>B: hi').map((text): JSONContent => ({ type: 'mermaid', content: [{ type: 'text', text }] }));
const ruleNode = fc.constant<JSONContent>({ type: 'horizontalRule' });
const tableNode = fc
  .tuple(fc.integer({ min: 1, max: 3 }), fc.integer({ min: 0, max: 2 }))
  .chain(([cols, rows]) =>
    fc.tuple(
      fc.array(fc.constantFrom(null, 'left', 'center', 'right'), { minLength: cols, maxLength: cols }),
      fc.array(fc.array(fc.option(inline({ breaks: false, edges: 'trimmed' }), { nil: undefined }), { minLength: cols, maxLength: cols }), { minLength: rows + 1, maxLength: rows + 1 }),
    ),
  )
  .map(([align, grid]): JSONContent => ({
    type: 'table',
    content: grid.map((row, r) => ({
      type: 'tableRow',
      content: row.map((cell, c) => ({
        type: r === 0 ? 'tableHeader' : 'tableCell',
        attrs: { align: align[c] },
        content: [{ type: 'paragraph', ...(cell && cell.length > 0 ? { content: cell } : {}) }],
      })),
    })),
  }));

const { block: blockNode } = fc.letrec<{ block: JSONContent; blocks: JSONContent[]; calloutBlocks: JSONContent[] }>((tie) => ({
  block: fc.oneof(
    { depthSize: 'small', withCrossShrink: true },
    { weight: 6, arbitrary: paragraphNode },
    { weight: 2, arbitrary: headingNode },
    { weight: 1, arbitrary: codeNode },
    { weight: 1, arbitrary: mermaidNode },
    { weight: 1, arbitrary: ruleNode },
    { weight: 1, arbitrary: tableNode },
    { weight: 1, arbitrary: tie('blocks').map((content): JSONContent => ({ type: 'blockquote', content })) },
    {
      weight: 1,
      arbitrary: fc
        .tuple(fc.constantFrom('note', 'tip', 'warning', 'danger'), fc.constantFrom(null, 'Heads up', 'A **title**'), tie('calloutBlocks'))
        .map(([kind, title, content]): JSONContent => ({ type: 'callout', attrs: { kind, title }, content })),
    },
    {
      weight: 2,
      arbitrary: fc
        .tuple(
          fc.constantFrom('bulletList', 'orderedList'),
          fc.integer({ min: 0, max: 12 }),
          fc.array(fc.tuple(fc.constantFrom(null, true, false), inline({ breaks: false, edges: 'trimmed' }), tie('blocks')), { minLength: 1, maxLength: 3 }),
        )
        .map(([type, start, items]): JSONContent => ({
          type,
          ...(type === 'orderedList' ? { attrs: { start } } : {}),
          content: items.map(([checked, lead, children]) => ({
            type: 'listItem',
            attrs: { checked },
            content: [{ type: 'paragraph', content: lead }, ...children.slice(0, 2)],
          })),
        })),
    },
  ),
  blocks: fc.array(tie('block'), { minLength: 1, maxLength: 3 }).map(separateLists),
  // A callout cannot nest a callout (mid-run); the documented normalisation covers that case on its own.
  calloutBlocks: fc.array(tie('block'), { minLength: 1, maxLength: 3 }).map((blocks) => separateLists(blocks.filter((b) => b.type !== 'callout'))).filter((b) => b.length > 0),
}));

/** Two lists of one kind side by side read back as one list (a documented normalisation), so a paragraph separates them. */
function separateLists(blocks: JSONContent[]): JSONContent[] {
  const out: JSONContent[] = [];
  for (const block of blocks) {
    const prev = out[out.length - 1];
    if (prev && prev.type === block.type && (block.type === 'bulletList' || block.type === 'orderedList')) {
      out.push({ type: 'paragraph', content: [{ type: 'text', text: 'between' }] });
    }
    out.push(block);
  }
  return out;
}

export const docArb = fc
  .array(blockNode, { minLength: 1, maxLength: 5 })
  .map((blocks): JSONContent => ({ type: 'doc', content: separateLists(blocks) }))
  .filter((doc) => !nestsCallout(doc, false));

/** A callout anywhere inside a callout, not under a quote: written as its content (a documented normalisation). */
function nestsCallout(node: JSONContent, inCallout: boolean): boolean {
  if (node.type === 'callout' && inCallout) return true;
  const inside = node.type === 'blockquote' ? false : inCallout || node.type === 'callout';
  return (node.content ?? []).some((child) => nestsCallout(child, inside));
}
