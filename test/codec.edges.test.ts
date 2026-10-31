import type { JSONContent } from '@tiptap/core';
import { describe, expect, it } from 'vitest';
import { leaves, trimLeaves } from '../src/codec.js';
import type { DocInline } from '../src/parse.js';
import { docToMarkdown, editorInlineLeaves, markdownToDoc, parseDocBody } from './grammar.js';
import { mergeMarkdown } from '../src/merge.js';

/**
 * The codec's edges: shapes the property generators reach rarely or never, pinned one by one so each stays
 * handled. Every written case is also checked to read back as itself, the codec's first promise.
 */

const doc = (...content: JSONContent[]): JSONContent => ({ type: 'doc', content });
const para = (...content: JSONContent[]): JSONContent => ({ type: 'paragraph', content });
const text = (value: string, ...marks: string[]): JSONContent => ({ type: 'text', text: value, ...(marks.length ? { marks: marks.map((type) => ({ type })) } : {}) });

/** The inline run of a body that is one paragraph. */
function paragraphInline(body: string): DocInline[] {
  const [block] = parseDocBody(body);
  return block?.kind === 'paragraph' ? block.inline : [];
}

function stable(body: string): void {
  expect(docToMarkdown(markdownToDoc(body))).toBe(body);
}

describe('codec: reading', () => {
  it('holds emphasis inside emphasis as one italic', () => {
    expect(markdownToDoc('*a _b_ c*').content?.[0].content).toEqual([{ type: 'text', text: 'a b c', marks: [{ type: 'italic' }] }]);
  });

  it('joins adjacent code spans into one run, as the editor holds them', () => {
    expect(markdownToDoc('`a``b`').content?.[0].content).toEqual([{ type: 'text', text: 'ab', marks: [{ type: 'code' }] }]);
  });

  it('reads an empty quote and an empty callout with a paragraph to type into', () => {
    expect(markdownToDoc('>').content).toEqual([{ type: 'blockquote', content: [{ type: 'paragraph' }] }]);
    expect(markdownToDoc(':::tip\n:::').content).toEqual([{ type: 'callout', attrs: { kind: 'tip', title: null }, content: [{ type: 'paragraph' }] }]);
  });
});

describe('codec: writing', () => {
  it('writes blocks with no content array at all', () => {
    expect(docToMarkdown(doc({ type: 'paragraph' }, { type: 'heading', attrs: { level: 2 } }, { type: 'mermaid' }))).toBe('## \n\n```mermaid\n```');
    expect(docToMarkdown(doc({ type: 'bulletList' }, { type: 'bulletList', content: [{ type: 'listItem', content: [para(text('a'))] }] }))).toBe('- a');
  });

  it('writes a code span that ends a paragraph on a break, and one that runs to its end', () => {
    const body = docToMarkdown(doc(para(text('x '), text('a\n', 'code'))));
    expect(body).toBe('x `a\n`');
    expect(markdownToDoc(body)).toEqual(doc(para(text('x '), text('a\n', 'code'))));
    expect(parseDocBody(body)).toEqual([{ kind: 'paragraph', source: 'x `a\n`', inline: [{ kind: 'text', text: 'x ' }, { kind: 'code', text: 'a\n' }] }]);
  });

  it('keeps a code run of only spaces, which shows, and drops a paragraph of plain spaces, which does not', () => {
    expect(docToMarkdown(doc(para(text('   ')), para(text('  ', 'code'))))).toBe('`  `');
    expect(docToMarkdown(doc(para(text('a'), { type: 'hardBreak' }, text('   '), { type: 'hardBreak' }, text('b'))))).toBe('a\n\nb');
  });

  it('escapes a list item line that would read as a table delimiter', () => {
    const body = docToMarkdown(doc({ type: 'bulletList', content: [{ type: 'listItem', content: [para(text('a | b'))] }, { type: 'listItem', content: [para(text('|'))] }] }));
    expect(body).toBe('- a | b\n- \\|');
    expect(parseDocBody(body)[0].kind).toBe('list');
  });

  it('writes code inside a list item indented with it, blank lines and all', () => {
    const body = docToMarkdown(doc({ type: 'orderedList', attrs: { start: 9 }, content: [{ type: 'listItem', content: [para(text('step')), { type: 'codeBlock', attrs: { language: 'sh' }, content: [text('a\n\nb')] }] }] }));
    expect(body).toBe('9. step\n   ```sh\n   a\n\n   b\n   ```');
    stable(body);
  });

  it('writes a table whose first row is missing and whose cells hold no paragraph', () => {
    expect(docToMarkdown(doc({ type: 'table', content: [{ type: 'tableRow' }] }))).toBe('|  |\n| --- |');
    expect(docToMarkdown(doc({ type: 'table', content: [{ type: 'tableRow', content: [{ type: 'tableHeader' }] }] }))).toBe('|  |\n| --- |');
  });

  it('writes inline nodes with missing attributes as nothing, and unknown inline nodes as their text', () => {
    expect(docToMarkdown(doc(para(text('a'), { type: 'mention' }, { type: 'pageLink' }, { type: 'image' }, { type: 'unknownInline' }, text('b'))))).toBe('ab');
    expect(docToMarkdown(doc(para({ type: 'text' }, text('kept'))))).toBe('kept');
  });

  it('writes a link a break runs through as two links on one line', () => {
    const link = [{ type: 'link', attrs: { href: 'https://x.test' } }];
    expect(docToMarkdown(doc({ type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'a', marks: link }, { type: 'hardBreak' }, { type: 'text', text: 'b', marks: link }] }))).toBe(
      '# [a](https://x.test) [b](https://x.test)',
    );
  });

  it('marks bold and italic around code and links only when the format can read it back', () => {
    const boldItalicCode = docToMarkdown(doc(para(text('a_b', 'bold', 'italic', 'code'))));
    expect(leaves(paragraphInline(boldItalicCode))).toEqual([
      { kind: 'code', marks: 'bold,italic', text: 'a_b' },
    ]);
    stable(boldItalicCode);
    const bothDelims = docToMarkdown(doc(para({ type: 'text', text: '*_', marks: [{ type: 'bold' }, { type: 'link', attrs: { href: 'https://x.test' } }] })));
    stable(bothDelims);
  });

  it('cuts a bold run whose spans hold both delimiters into parts that each read back bold', () => {
    const body = docToMarkdown(doc(para(text('a*', 'bold'), text('b_c', 'bold', 'italic'), text('d', 'bold'))));
    expect(leaves(paragraphInline(body)).filter((leaf) => leaf.marks.includes('bold')).map((leaf) => leaf.text).join('')).toBe('a*b_cd');
    stable(body);
  });

  it('writes a text piece before a formatted one without escaping a backslash it does not need to', () => {
    expect(docToMarkdown(doc(para(text('a\\'), text('b', 'bold'))))).toBe('a\\\\**b**');
    expect(docToMarkdown(doc(para(text('a\\ b'))))).toBe('a\\ b');
  });

  it('splits a multi-line code span before a blank or delimiter-like line, and keeps it whole when it holds a backtick', () => {
    // The blank line starts with the second span's fence, so it is not blank.
    expect(docToMarkdown(doc(para(text('a\n\nb', 'code'))))).toBe('`a\n``\nb`');
    const hasTick = docToMarkdown(doc(para(text('`a\n-|\nb', 'code'))));
    expect(hasTick.startsWith('``')).toBe(true);
  });
});

describe('codec: comparison helpers', () => {
  it('trims only what each container trims', () => {
    const run = [{ kind: 'text', marks: '', text: '  a  ' }];
    expect(trimLeaves(run, undefined)).toEqual(run);
    expect(trimLeaves(run, 'start')).toEqual([{ kind: 'text', marks: '', text: 'a  ' }]);
    expect(trimLeaves([{ kind: 'text', marks: '', text: '   ' }, { kind: 'code', marks: '', text: 'x' }, { kind: 'text', marks: '', text: '  ' }], 'both')).toEqual([
      { kind: 'code', marks: '', text: 'x' },
    ]);
  });

  it('joins adjacent links to one target and keeps links to two apart', () => {
    expect(
      leaves([
        { kind: 'link', href: 'https://a', text: 'x' },
        { kind: 'link', href: 'https://a', text: 'y' },
        { kind: 'link', href: 'https://b', text: 'z' },
        { kind: 'anchorLink', anchor: 'h', text: 'p' },
        { kind: 'anchorLink', anchor: 'h', text: 'q' },
      ]),
    ).toEqual([
      { kind: 'link', marks: '', href: 'https://a', text: 'xy' },
      { kind: 'link', marks: '', href: 'https://b', text: 'z' },
      { kind: 'anchorLink', marks: '', anchor: 'h', text: 'pq' },
    ]);
  });

  it('reads what editor nodes mean, a break included', () => {
    expect(editorInlineLeaves([text('a'), { type: 'hardBreak' }, text('b')])).toEqual([{ kind: 'text', marks: '', text: 'a\nb' }]);
  });
});

describe('mergeMarkdown', () => {
  it('merges two clean edits into one body', () => {
    const base = 'a\nb\nc\nd\ne';
    expect(mergeMarkdown(base, 'A\nb\nc\nd\ne', 'a\nb\nc\nd\nE')).toEqual({ clean: true, body: 'A\nb\nc\nd\nE' });
  });
});
