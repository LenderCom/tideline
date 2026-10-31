import { getSchema, type JSONContent } from '@tiptap/core';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { DocBlock } from '../src/parse.js';
import { leaves, MARKDOWN_MARKS, MARKDOWN_NODES, trimLeaves, type InlineLeaf } from '../src/codec.js';
import { docSchemaExtensions, docToMarkdown, editorInlineLeaves, markdownToDoc, parseDocBody } from './grammar.js';
import { docArb, page, PARAMS, SEED } from './generators.js';
import { CANONICAL } from './vectors.js';

/**
 * The round-trip gate: markdown → editor → markdown is stable, for every construct the format has. Two generators:
 *   · PAGES: adversarial markdown text, built line by line from every block marker and every piece of inline punctuation the
 *     grammar reacts to, so the parser is fed the shapes a writer would never produce on purpose;
 *   · DOCS: editor documents built from every node and mark in the schema, with text drawn from the same risky alphabet,
 *     so the writer has to escape what the user typed.
 * The parser a reader uses (`parseDocBody`) is the oracle throughout.
 *
 * Both generators are in `generators.ts`, shared with the co-editing leg (`codec.yjs.test.ts`).
 */

// ─── what a reader sees, normalised ───────────────────────────────────────────────────────────────────────────

type Shape = unknown;

/**
 * A page as a reader would render it. Inline runs compare as leaves with mark sets (`**_a_**` ≡ `_**a**_`). Two
 * lists of the same kind side by side compare as one: the format has no way to write them apart, and a reader shows them
 * the same way.
 */
function blockShapes(blocks: readonly DocBlock[]): Shape[] {
  const merged: DocBlock[] = [];
  // Paragraphs with nothing visible go first: lists either side of one then sit together, as they do once written.
  const shown = blocks.filter((block) => block.kind !== 'paragraph' || splitLeavesAtBlankLines(leaves(block.inline)).some((run) => trimLeaves(run, 'both').length > 0));
  for (const block of shown) {
    const last = merged[merged.length - 1];
    if (block.kind === 'list' && last?.kind === 'list' && last.ordered === block.ordered) {
      merged[merged.length - 1] = { ...last, items: [...last.items, ...block.items] };
    } else merged.push(block);
  }
  // A blank line inside a paragraph (around an empty code span, say) splits it in two, and a paragraph with nothing
  // visible in it renders as nothing: both documented normalisations.
  const visible = merged.flatMap((block): Array<DocBlock | { kind: 'para'; run: InlineLeaf[] }> =>
    block.kind === 'paragraph'
      ? splitLeavesAtBlankLines(leaves(block.inline)).map((run) => ({ kind: 'para' as const, run: trimLeaves(run, 'both') })).filter((p) => p.run.length > 0)
      : [block],
  );
  return visible.map((block): Shape => {
    switch (block.kind) {
      case 'para':
        return { p: block.run };
      case 'paragraph':
        return { p: [] };
      case 'heading':
        return { h: block.level, id: block.id, anchor: block.anchor ?? null, inline: trimLeaves(leaves(block.inline), 'both') };
      case 'code':
        return { code: block.text, lang: block.lang ?? null };
      case 'quote':
        return { quote: blockShapes(block.blocks) };
      case 'callout':
        return { callout: block.callout, title: block.title ?? null, blocks: blockShapes(block.blocks) };
      case 'list':
        return {
          list: block.ordered ? 'ol' : 'ul',
          start: block.start ?? 1,
          items: block.items.map((item) => ({ checked: item.checked ?? null, inline: trimLeaves(leaves(item.inline), 'start'), children: blockShapes(item.children) })),
        };
      case 'table':
        return { align: block.align, header: block.header.map((cell) => trimLeaves(leaves(cell), 'both')), rows: block.rows.map((row) => row.map((cell) => trimLeaves(leaves(cell), 'both'))) };
      case 'divider':
        return { hr: true };
    }
  });
}

const shapeOf = (body: string): Shape[] => blockShapes(parseDocBody(body));

function splitLeavesAtBlankLines(run: readonly InlineLeaf[]): InlineLeaf[][] {
  const parts: InlineLeaf[][] = [[]];
  for (const leaf of run) {
    if (leaf.kind !== 'text') {
      parts[parts.length - 1].push(leaf);
      continue;
    }
    const pieces = (leaf.text ?? '').split(/\n[^\S\n]*\n\s*/);
    pieces.forEach((text, index) => {
      if (index > 0) parts.push([]);
      if (text !== '') parts[parts.length - 1].push({ ...leaf, text });
    });
  }
  return parts;
}


/** markdown → editor → markdown. */
const roundTrip = (body: string): string => docToMarkdown(markdownToDoc(body));

const schema = getSchema(docSchemaExtensions());

/** Valid for the editor: ProseMirror accepts the JSON as a document of its schema, marks and content included. */
function expectValid(doc: JSONContent): void {
  expect(() => schema.nodeFromJSON(doc).check()).not.toThrow();
}

describe('codec: the editor schema', () => {
  it('has exactly the nodes and marks the codec reads and writes', () => {
    expect(Object.keys(schema.nodes).sort()).toEqual([...MARKDOWN_NODES, 'mention'].sort());
    expect(Object.keys(schema.marks).sort()).toEqual([...MARKDOWN_MARKS].sort());
  });

  it('accepts every canonical vector as the codec reads it', () => {
    for (const body of Object.values(CANONICAL)) expectValid(markdownToDoc(body));
  });
});

describe('codec: canonical vectors', () => {
  it.each(Object.entries(CANONICAL))('%s round-trips byte for byte', (_, body) => {
    expect(roundTrip(body)).toBe(body);
  });

  it.each(Object.entries(CANONICAL))('%s reads the same in the editor as in a reader', (_, body) => {
    expect(shapeOf(roundTrip(body))).toEqual(shapeOf(body));
  });
});

describe('codec: documented normalisations', () => {
  it('rewrites equivalent spellings once, then holds', () => {
    const cases: Array<[string, string]> = [
      ['* star bullet\n+ plus bullet', '- star bullet\n- plus bullet'],
      ['1) paren', '1. paren'],
      [':::info Aliased kind\nx\n:::', ':::note Aliased kind\nx\n:::'],
      ['## Closing hashes ##', '## Closing hashes'],
      ['[x](https://a.b)', '[x](https://a.b)'],
      // A link to a file the application holds round-trips as written, inside emphasis too.
      ['[Rate sheet.pdf](attachment:docattach-1)', '[Rate sheet.pdf](attachment:docattach-1)'],
      ['**see [the zip](attachment:k2)**', '**see [the zip](attachment:k2)**'],
      ['__strong__ *em*', '**strong** _em_'],
      ['```\nunterminated', '```\nunterminated\n```'],
    ];
    for (const [input, output] of cases) {
      expect(roundTrip(input)).toBe(output);
      expect(roundTrip(output)).toBe(output);
      expect(shapeOf(output)).toEqual(shapeOf(input));
    }
  });

  it('holds a code span across a line as one text run, and two spans on two lines as two', () => {
    // The newline stays in the span's text: a hard break would need the code mark, which Yjs drops (marks on text only).
    expect(markdownToDoc('a `one\ntwo` b').content?.[0].content).toEqual([
      { type: 'text', text: 'a ' },
      { type: 'text', text: 'one\ntwo', marks: [{ type: 'code' }] },
      { type: 'text', text: ' b' },
    ]);
    expect(markdownToDoc('`one`\n`two`').content?.[0].content).toEqual([
      { type: 'text', text: 'one', marks: [{ type: 'code' }] },
      { type: 'hardBreak' },
      { type: 'text', text: 'two', marks: [{ type: 'code' }] },
    ]);
    // Where a line cannot break, the span's newline is a space, as a hard break there is.
    const code = (text: string): JSONContent => ({ type: 'text', text, marks: [{ type: 'code' }] });
    expect(docToMarkdown({ type: 'doc', content: [{ type: 'heading', attrs: { level: 2 }, content: [code('a\nb')] }] })).toBe('## `a b`');
    expect(docToMarkdown({ type: 'doc', content: [{ type: 'bulletList', content: [{ type: 'listItem', content: [{ type: 'paragraph', content: [code('a\nb')] }] }] }] })).toBe('- `a b`');
  });

  it('opens a formatted mention plain: an inline atom holds no marks', () => {
    expect(markdownToDoc('**<@u1>**').content?.[0].content).toEqual([{ type: 'mention', attrs: { id: 'u1' } }]);
    expect(roundTrip('**<@u1>** and _<@u2>_')).toBe('<@u1> and <@u2>');
    expect(roundTrip('**Ask <@u1> now**')).toBe('**Ask** <@u1> **now**');
    expect(shapeOf('**Ask** <@u1> **now**')).toEqual(shapeOf('**Ask <@u1> now**'));
  });

  it('keeps a code line that looks like a fence inside the block, behind a zero-width space', () => {
    const doc: JSONContent = { type: 'doc', content: [{ type: 'codeBlock', attrs: { language: 'md' }, content: [{ type: 'text', text: 'a\n```\nb' }] }] };
    const written = docToMarkdown(doc);
    expect(written).toBe('```md\na\n\u200B```\nb\n```');
    expect(parseDocBody(written)).toEqual([{ kind: 'code', lang: 'md', text: 'a\n\u200B```\nb' }]);
  });

  it('guards a `:::` line in a code block inside a callout the same way', () => {
    const doc: JSONContent = {
      type: 'doc',
      content: [{ type: 'callout', attrs: { kind: 'tip', title: null }, content: [{ type: 'codeBlock', attrs: { language: null }, content: [{ type: 'text', text: ':::' }] }] }],
    };
    expect(docToMarkdown(doc)).toBe(':::tip\n```\n\u200B:::\n```\n:::');
    expect(docToMarkdown({ type: 'doc', content: doc.content?.[0].content })).toBe('```\n:::\n```');
  });

  it('writes a callout nested mid-callout as its content, since its closing line would close the parent', () => {
    const doc: JSONContent = {
      type: 'doc',
      content: [
        {
          type: 'callout',
          attrs: { kind: 'note', title: null },
          content: [
            { type: 'callout', attrs: { kind: 'tip', title: null }, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'inner' }] }] },
            { type: 'paragraph', content: [{ type: 'text', text: 'after' }] },
          ],
        },
      ],
    };
    expect(docToMarkdown(doc)).toBe(':::note\ninner\n\nafter\n:::');
  });

  it('drops a trailing hard break and empty paragraphs, and keeps a link the format cannot hold as its text', () => {
    const doc: JSONContent = {
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'a' }, { type: 'hardBreak' }] },
        { type: 'paragraph' },
        { type: 'paragraph', content: [{ type: 'text', text: 'insecure', marks: [{ type: 'link', attrs: { href: 'http://x.y' } }] }] },
      ],
    };
    expect(docToMarkdown(doc)).toBe('a\n\ninsecure');
  });

  it('cannot italicise a code span holding both delimiters, so it writes it plain', () => {
    const doc: JSONContent = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'a*b_c', marks: [{ type: 'italic' }, { type: 'code' }] }] }] };
    expect(docToMarkdown(doc)).toBe('`a*b_c`');
    const italic: JSONContent = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'a*b', marks: [{ type: 'italic' }, { type: 'code' }] }] }] };
    expect(docToMarkdown(italic)).toBe('_`a*b`_');
  });

  it('opens an empty page as one empty paragraph and writes it back as nothing', () => {
    expect(markdownToDoc('')).toEqual({ type: 'doc', content: [{ type: 'paragraph' }] });
    expect(docToMarkdown(markdownToDoc(''))).toBe('');
  });
});

describe('codec: whatever the editor hands it', () => {
  const doc = (...content: JSONContent[]): JSONContent => ({ type: 'doc', content });
  const text = (value: string, marks?: JSONContent['marks']): JSONContent => ({ type: 'text', text: value, ...(marks ? { marks } : {}) });

  it('writes nodes with missing or odd attributes with safe defaults', () => {
    expect(docToMarkdown(doc({ type: 'heading', content: [text('No level')] }))).toBe('# No level');
    expect(docToMarkdown(doc({ type: 'heading', attrs: { level: 9, anchor: 'bad anchor!' }, content: [text('Clamped')] }))).toBe('###### Clamped');
    expect(docToMarkdown(doc({ type: 'callout', attrs: { kind: 'bogus', title: 'Line\nbreak' }, content: [{ type: 'paragraph', content: [text('x')] }] }))).toBe(':::note Line break\nx\n:::');
    expect(docToMarkdown(doc({ type: 'callout' }))).toBe(':::note\n:::');
    expect(docToMarkdown(doc({ type: 'blockquote' }))).toBe('>');
    expect(docToMarkdown(doc({ type: 'codeBlock' }))).toBe('```\n```');
    expect(docToMarkdown(doc({ type: 'orderedList', attrs: { start: -3 }, content: [{ type: 'listItem', content: [{ type: 'paragraph', content: [text('zero')] }] }] }))).toBe('0. zero');
    expect(docToMarkdown(doc({ type: 'orderedList', content: [{ type: 'listItem' }] }))).toBe('1. ');
    expect(docToMarkdown(doc({ type: 'mystery', content: [text('kept as text')] }))).toBe('kept as text');
    expect(docToMarkdown({ type: 'doc' })).toBe('');
  });

  it('writes a list item that does not start with a paragraph, and spills a hard break in its first line', () => {
    const item = { type: 'listItem', content: [{ type: 'codeBlock', content: [text('code')] }] };
    expect(docToMarkdown(doc({ type: 'bulletList', content: [item] }))).toBe('- \n  ```\n  code\n  ```');
    const spill = { type: 'listItem', content: [{ type: 'paragraph', content: [text('first'), { type: 'hardBreak' }, text('second')] }] };
    expect(docToMarkdown(doc({ type: 'bulletList', content: [spill] }))).toBe('- first\n  second');
    // Two lists of one kind side by side are one list.
    const list = { type: 'bulletList', content: [{ type: 'listItem', content: [{ type: 'paragraph', content: [text('a')] }] }] };
    expect(docToMarkdown(doc(list, { type: 'paragraph' }, list))).toBe('- a\n- a');
  });

  it('writes tables without rows, short rows, extra paragraphs in a cell and a header of dashes', () => {
    expect(docToMarkdown(doc({ type: 'table' }))).toBe('');
    const cell = (type: string, ...content: JSONContent[]): JSONContent => ({ type, content });
    const table = {
      type: 'table',
      content: [
        { type: 'tableRow', content: [cell('tableHeader', { type: 'paragraph', content: [text('a')] }, { type: 'paragraph', content: [text('b')] }), cell('tableHeader')] },
        { type: 'tableRow', content: [cell('tableCell', { type: 'codeBlock', content: [text('x')] })] },
        { type: 'tableRow', content: [cell('tableCell', { type: 'paragraph', content: [text('-')] }), cell('tableCell', { type: 'paragraph', content: [text('-')] })] },
      ],
    };
    expect(docToMarkdown(doc(table))).toBe('| a b |  |\n| --- | --- |\n| x |  |\n| \\- | \\- |');
  });

  it('keeps what the format cannot hold as text, and drops what it cannot write at all', () => {
    const inline = (...content: JSONContent[]): string => docToMarkdown(doc({ type: 'paragraph', content }));
    expect(inline(text('mail', [{ type: 'link', attrs: { href: 'mailto:a@b.c' } }]))).toBe('mail');
    expect(inline(text('[x]', [{ type: 'link', attrs: { href: '#a' } }]), text('`', [{ type: 'link', attrs: { href: '#a' } }]))).toBe('[x](#a)');
    expect(inline(text('``', [{ type: 'link', attrs: { href: '#a' } }]))).toBe('\\`\\`');
    expect(inline(text('a', [{ type: 'link', attrs: { href: 'https://x.y' } }]), text('b', [{ type: 'link', attrs: { href: 'https://x.y' } }]))).toBe('[ab](https://x.y)');
    expect(inline({ type: 'mention', attrs: { id: 'not valid' } }, text('x'))).toBe('x');
    expect(inline({ type: 'pageLink', attrs: { target: '[]|' } }, { type: 'pageLink', attrs: { target: 'D28', label: 'D28' } })).toBe('[[D28]]');
    expect(inline({ type: 'image', attrs: { src: 'javascript:alert(1)', alt: 'x' } }, { type: 'image', attrs: { src: 'attachment:a1', alt: 'a]\nb' } })).toBe('![ab](attachment:a1)');
    expect(inline({ type: 'mystery', content: [text('inner')] })).toBe('inner');
    // Marks on an atom (which the editor takes off) are not kept: a break is a break, a mention is plain.
    expect(inline(text('a'), { type: 'hardBreak', marks: [{ type: 'code' }] }, text('b', [{ type: 'code' }]))).toBe('a\n`b`');
    expect(inline({ type: 'mention', attrs: { id: 'u1' }, marks: [{ type: 'bold' }] })).toBe('<@u1>');
  });
});

describe('codec: adversarial pages', () => {
  it('reads the same in a reader after a round trip', () => {
    fc.assert(
      fc.property(page, (body) => {
        expectValid(markdownToDoc(body));
        expect(shapeOf(roundTrip(body))).toEqual(shapeOf(body));
      }),
      PARAMS,
    );
  });

  it('is stable after one pass: a second round trip changes no byte', () => {
    fc.assert(
      fc.property(page, (body) => {
        const once = roundTrip(body);
        expect(roundTrip(once)).toBe(once);
      }),
      PARAMS,
    );
  });
});

describe('codec: editor documents', () => {
  it('writes what a reader reads: parsing the output gives the document back', () => {
    fc.assert(
      fc.property(docArb, (doc) => {
        expectValid(doc);
        const written = docToMarkdown(doc);
        expect(docToMarkdown(markdownToDoc(written))).toBe(written);
        expect(shapeOf(docToMarkdown(markdownToDoc(written)))).toEqual(shapeOf(written));
        expect(editorShape(markdownToDoc(written))).toEqual(editorShape(doc));
      }),
      PARAMS,
    );
  });

  it('generates every node and mark the schema has, so a new one cannot ship without a round trip', () => {
    const seen = new Set<string>();
    const visit = (node: JSONContent): void => {
      if (node.type) seen.add(node.type);
      for (const mark of node.marks ?? []) seen.add(mark.type);
      node.content?.forEach(visit);
    };
    fc.sample(docArb, { seed: SEED, numRuns: 300 }).forEach(visit);
    expect([...MARKDOWN_NODES, 'mention', ...MARKDOWN_MARKS].filter((name) => !seen.has(name))).toEqual([]);
  });
});

/**
 * An editor document reduced to what the format promises to keep: blocks and their attributes, and inline content as what it
 * means (`editorInlineLeaves`, taken before any escaping). Comparing the generated document with the one read back from
 * its markdown therefore checks the writer's escaping against intent, not against itself.
 */
function editorShape(doc: JSONContent): Shape {
  const inlineLeaves = (nodes: readonly JSONContent[] | undefined) => editorInlineLeaves(nodes ?? []);
  const walk = (node: JSONContent): Shape => {
    switch (node.type) {
      case 'paragraph':
        return { p: inlineLeaves(node.content) };
      case 'heading':
        return { h: node.attrs?.level, anchor: node.attrs?.anchor ?? null, inline: inlineLeaves(node.content) };
      // A line that would close its block early is written behind a zero-width space (a documented normalisation).
      case 'codeBlock':
        return { code: unguarded(node.content?.[0]?.text ?? ''), lang: node.attrs?.language ?? null };
      case 'mermaid':
        return { mermaid: unguarded(node.content?.[0]?.text ?? '') };
      case 'listItem':
        return { checked: node.attrs?.checked ?? null, content: (node.content ?? []).map(walk) };
      case 'tableHeader':
      case 'tableCell':
        return { align: node.attrs?.align ?? null, content: (node.content ?? []).map(walk) };
      case 'callout':
        return { callout: node.attrs?.kind, title: node.attrs?.title ?? null, content: (node.content ?? []).map(walk) };
      case 'orderedList':
        return { ol: node.attrs?.start ?? 1, content: (node.content ?? []).map(walk) };
      default:
        return { [node.type ?? '?']: (node.content ?? []).map(walk) };
    }
  };
  return walk(doc);
}

function unguarded(code: string): string {
  return code.replace(/^\u200B/gm, '');
}
