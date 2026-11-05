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

describe('codec: marks and the flanking rules', () => {
  /** Written once, read back to the same document, written again to the same bytes. */
  const written = (...content: JSONContent[]): string => {
    const body = docToMarkdown(doc(para(...content)));
    expect(docToMarkdown(markdownToDoc(body))).toBe(body);
    return body;
  };

  it('uses `*` where `_` cannot work, inside a word', () => {
    expect(written(text('un'), text('believ', 'italic'), text('able'))).toBe('un*believ*able');
    expect(written(text('**'), text('a', 'italic'))).toBe('**_a_');
  });

  it('keeps the text exact when a span cannot be written where it sits, giving up only its edge', () => {
    expect(written(text('x'), text('(b)', 'italic'), text('y'))).toBe('x(_b_)y');
    expect(written(text('Note:', 'bold'), text('text'))).toBe('**Note**:text');
    expect(written(text('a'), text('(', 'bold'), text('b'))).toBe('a(b');
    expect(written(text('x'), text('code', 'italic', 'code'), text('y'))).toBe('x`code`y');
  });

  it('writes bold italic beside a word as one run of `*`, so it keeps both marks', () => {
    expect(written(text('x'), text('q', 'bold', 'italic'), text('y'))).toBe('x***q***y');
    expect(written(text('q', 'bold', 'italic'), text('y'))).toBe('***q***y');
    expect(written(text('x'), text('q', 'bold', 'italic'))).toBe('x***q***');
    expect(written(text('x '), text('q', 'bold', 'italic'), text(' y'))).toBe('x **_q_** y');
    for (const body of ['x***q***y', '***q***y', 'x***q***']) stable(body);
    const read = paragraphInline('x***q***y');
    expect(leaves(read).find((leaf) => leaf.text === 'q')?.marks).toBe(leaves(paragraphInline('***q***'))[0].marks);
    // One mark running on past the other, and punctuation at the edge, which gives up only what it must.
    expect(written(text('x'), text('q', 'bold', 'italic'), text('r', 'bold'), text('y'))).toBe('x***q*r**y');
    expect(written(text('x'), text('r', 'bold'), text('q', 'bold', 'italic'), text('y'))).toBe('x**r*q***y');
    expect(written(text('x'), text('(q)', 'bold', 'italic'), text('y'))).toBe('x(**_q_**)y');
    expect(written(text('x'), text('q.', 'bold', 'italic'), text('y'))).toBe('x***q***.y');
  });

  it('gives up a mark rather than let delimiters that run together read as literal characters', () => {
    const body = written(text('a', 'bold', 'italic'), text('b', 'italic'), text('c'));
    expect(body.replace(/[*_]/g, '')).toBe('abc');
    expect(leaves(paragraphInline(body)).map((leaf) => leaf.text).join('')).toBe('abc');
  });

  it('writes spans side by side, however their delimiters meet', () => {
    expect(written(text('a', 'italic'), text('b', 'bold'))).toBe('_a_**b**');
    expect(written(text('a', 'bold'), text('b', 'italic'))).toBe('**a**_b_');
    expect(written(text('a', 'bold'), text('b', 'bold', 'italic'))).toBe('**a*b***');
    expect(written(text('x', 'italic'), text('.'))).toBe('_x_.');
    expect(written(text('.'), text('x', 'italic'))).toBe('._x_');
  });

  it('escapes a literal marker only when it would otherwise read as one', () => {
    expect(written(text('*a* * b'))).toBe('\\*a\\* \\* b');
    expect(written(text('a * b'))).toBe('a * b');
    expect(written(text('snake_case'))).toBe('snake_case');
    expect(written(text('_a_'))).toBe('\\_a\\_');
  });
});

describe('codec: a bare URL in emphasis', () => {
  it.each([
    '**https://example.com**',
    '_https://example.com/a_',
    '**https://example.com/a_b** and _https://example.com/c_d_',
  ])('keeps %s as it stands', (body) => {
    stable(body);
  });

  it('keeps a mark on one beside a word, where only the bare spelling can hold it', () => {
    const url = 'https://example.com';
    const link = (label: string, ...marks: string[]): JSONContent => ({ type: 'text', text: label, marks: [{ type: 'link', attrs: { href: url } }, ...marks.map((type) => ({ type }))] });
    const body = (...content: JSONContent[]): string => {
      const written = docToMarkdown(doc(para(...content)));
      stable(written);
      return written;
    };
    expect(body(link(url, 'bold'), text('y'))).toBe(`**${url}**y`);
    expect(body(text('x'), link(url, 'italic'), text('y'))).toBe(`x*${url}*y`);
    expect(body(text('x'), link(url, 'bold', 'italic'), text('y'))).toBe(`x***${url}***y`);
    for (const old of [`**${url}**y`, `*${url}*y`, `x*${url}*y`, `**${url}**-y`]) stable(old);
    // Bracketed, the closing marker follows `)` and cannot close, so the mark goes.
    expect(body(link('label', 'bold'), text('y'))).toBe(`[label](${url})y`);
    // A URL with a `*` in it could close the span early, so it counts as bracketed too.
    const star = 'https://example.com/a*b';
    const marked: JSONContent = { type: 'text', text: star, marks: [{ type: 'link', attrs: { href: star } }, { type: 'bold' }] };
    expect(leaves(paragraphInline(body(marked, text('y')))).map((leaf) => leaf.text).join('')).toBe(`${star}y`);
    // Text beside it that needs escaping does not cost the link its bare spelling, or the mark.
    expect(body(text('*a* '), link(url, 'bold'), text('y'))).toBe(`\\*a\\* **${url}**y`);
  });

  it('normalises a bare URL under `*` to `_` once, and writes a bold one under `**`', () => {
    expect(docToMarkdown(markdownToDoc('*https://example.com/a*'))).toBe('_https://example.com/a_');
    const link = { type: 'text', text: 'https://example.com', marks: [{ type: 'link', attrs: { href: 'https://example.com' } }, { type: 'bold' }] };
    expect(docToMarkdown(doc(para(link)))).toBe('**https://example.com**');
  });

  it('keeps a URL that ends in the marker around it, under the other marker or in brackets', () => {
    const marked = (url: string, ...marks: string[]): JSONContent => ({ type: 'text', text: url, marks: [{ type: 'link', attrs: { href: url } }, ...marks.map((type) => ({ type }))] });
    const star = 'https://example.com/a*';
    expect(docToMarkdown(doc(para(marked(star, 'bold'))))).toBe(`__${star}__`);
    stable(`__${star}__`);
    const both = 'https://example.com/a*_';
    const body = docToMarkdown(doc(para(marked(both, 'bold'))));
    expect(leaves(paragraphInline(body))).toEqual(leaves(paragraphInline(`**[${both}](${both})**`)));
    stable(body);
  });
});

describe('codec: marks no spelling can hold', () => {
  const written = (...content: JSONContent[]): string => docToMarkdown(doc(para(...content)));
  const unreadable = [text('a', 'bold', 'italic'), text('b', 'italic'), text('c')];

  it('takes one mark off one unreadable spot and leaves the rest of the run marked', () => {
    const body = written(...unreadable, text(' and '), text('p', 'italic'), text(' then '), text('q', 'bold'));
    expect(body).toContain(' and _p_ then **q**');
    expect(leaves(paragraphInline(body)).map((leaf) => leaf.text).join('')).toBe('abc and p then q');
    stable(body);
  });

  it('takes one mark off each spot in a run with two of them', () => {
    const body = written(...unreadable, text(' '), ...unreadable);
    expect(body).toBe('**a***b*c **a***b*c');
    stable(body);
  });

  it('leaves harmless touching spans and bold bare URLs marked beside one unreadable spot', () => {
    const touching = written(...unreadable, text(' and '), text('x', 'bold'), text('y', 'italic'), text(' and '), text('p', 'bold'), text('q', 'italic'));
    expect(touching).toBe('**a***b*c and **x**_y_ and **p**_q_');
    stable(touching);
    const urls = ['https://a.b', 'https://c.d', 'https://e.f', 'https://g.h'];
    const linked = written(...unreadable, ...urls.flatMap((url) => [text(' and '), { ...text(url, 'bold'), marks: [{ type: 'bold' }, { type: 'link', attrs: { href: url } }] }]));
    expect(linked).toBe(`**a***b*c${urls.map((url) => ` and **${url}**`).join('')}`);
    stable(linked);
  });

  it('charges a spot for what touches it, so long paragraphs keep their marks', () => {
    const filler = 'word (x) '.repeat(1100);
    const paragraphs = Array.from({ length: 12 }, (_, index) => para(text(filler), ...unreadable, text(' '), text(`keep${index}`, 'bold')));
    const body = docToMarkdown(doc(...paragraphs));
    for (let index = 0; index < paragraphs.length; index += 1) expect(body).toContain(`**keep${index}**`);
  });

  it('keeps a bold phrase around an unreadable spot', () => {
    const body = written(text('all bold ', 'bold'), text('it', 'bold', 'italic'), text(' more ', 'bold'), text('a', 'bold', 'italic'), text('b', 'italic'), text('c'), text(' and '), text('z', 'italic'));
    expect(body).toBe('**all bold _it_ more a***b*c and _z_');
    stable(body);
  });

  it('gives up the marks of a chain too long to search, and only of that chain', () => {
    const chain = Array.from({ length: 40 }, (_, index) => (index % 2 ? text('y', 'italic') : text('x', 'bold')));
    const body = written(...chain, ...unreadable, text(' and '), text('p', 'bold'), text('q', 'italic'));
    expect(body).toBe(`${'xy'.repeat(20)}abc and **p**_q_`);
    stable(body);
  });

  it.each([
    ['a marked bare URL beside a word', 'https://a.b***y ******'.repeat(200)],
    ['spans whose delimiters run together', '***a****b*c '.repeat(200)],
    ['one unbroken chain of such spans', '***a****b*c'.repeat(2000)],
    ['such spots among harmless marks', '***a****b*c **x**_y_ https://a.b **https://c.d** '.repeat(500)],
  ])('stays fast on a page of %s', (_shape, source) => {
    const page = markdownToDoc(source);
    const started = performance.now();
    const body = docToMarkdown(page);
    expect(performance.now() - started).toBeLessThan(2000);
    stable(body);
  });

  it('stays fast on a page of paragraphs that each hold two such spots', () => {
    const page = doc(...Array.from({ length: 2000 }, () => para(...unreadable, text(' '), ...unreadable)));
    const started = performance.now();
    const body = docToMarkdown(page);
    expect(performance.now() - started).toBeLessThan(2000);
    expect(body.split('\n\n')).toEqual(Array.from({ length: 2000 }, () => '**a***b*c **a***b*c'));
  });

  it('keeps the marks of words that read apart but not together, at the cost of one', () => {
    const spot = 'foo**bar baz*qux***';
    const body = docToMarkdown(markdownToDoc('See **important** and foo***bar*** **baz*qux*** then _z_.'));
    expect(body).toBe(`See **important** and ${spot} then _z_.`);
    stable(body);
    // Two of them in one run: each phrase is repaired on its own.
    const twice = docToMarkdown(markdownToDoc('foo***bar*** **baz*qux*** and **x**_y_ and foo***bar*** **baz*qux***'));
    expect(twice).toBe(`${spot} and **x**_y_ and ${spot}`);
    stable(twice);
  });

  it('shares one repair allowance across a document: later spots go plain, and a run that reads whole keeps its marks', () => {
    const count = 40_000;
    const started = performance.now();
    const body = docToMarkdown(doc(...Array.from({ length: count }, () => para(...unreadable)), para(text('x', 'bold'), text('y', 'italic'))));
    expect(performance.now() - started).toBeLessThan(5000);
    const paragraphs = body.split('\n\n');
    expect(paragraphs).toHaveLength(count + 1);
    expect(paragraphs[0]).toBe('**a***b*c');
    expect(paragraphs[count - 1]).toBe('abc');
    expect(paragraphs[count]).toBe('**x**_y_');
    expect(new Set(paragraphs.slice(0, count))).toEqual(new Set(['**a***b*c', 'abc']));
    stable(body);
  });

  it.each([
    ['spots in one run', '***a****b*c '],
    ['one unbroken chain', '***a****b*c'],
    ['a marked bare URL beside a word', 'https://a.b***y ******'],
    ['phrases whose words read apart', 'foo***bar*** **baz*qux*** '],
    ['paragraphs of one spot', '***a****b*c\n\n'],
  ])('writes a 1 MB page of %s within seconds', (_shape, unit) => {
    const page = markdownToDoc(unit.repeat(Math.ceil(1_000_000 / unit.length)));
    const started = performance.now();
    docToMarkdown(page);
    expect(performance.now() - started).toBeLessThan(15_000);
  });

  it('stays fast on one long run of marked words', () => {
    const page = markdownToDoc('*a* **b** '.repeat(30_000));
    const started = performance.now();
    const body = docToMarkdown(page);
    expect(performance.now() - started).toBeLessThan(2000);
    expect(body.startsWith('_a_ **b** _a_')).toBe(true);
  });
});

describe('codec: pages too long to pass as arguments', () => {
  const longCode = 'a\n'.repeat(300_000);
  const code: JSONContent = { type: 'codeBlock', content: [text(longCode)] };

  it('reads and writes one span holding hundreds of thousands of pieces', () => {
    const source = `**${'*a* '.repeat(200_000)}b**`;
    const page = markdownToDoc(source);
    expect(docToMarkdown(page).length).toBeGreaterThan(source.length / 2);
  });

  it.each([
    ['at the top of a page', doc(code)],
    ['in a quote', doc({ type: 'blockquote', content: [code] })],
    ['in a list item', doc({ type: 'bulletList', content: [{ type: 'listItem', content: [para(text('x')), code] }] })],
  ])('writes a code block of hundreds of thousands of lines %s', (_where, page) => {
    expect(docToMarkdown(page).split('\n').length).toBeGreaterThan(300_000);
  });

  it('fences a code span holding hundreds of thousands of backtick runs', () => {
    expect(docToMarkdown(doc(para({ ...text('a`'.repeat(300_000)), marks: [{ type: 'code' }] }))).startsWith('``')).toBe(true);
  });
});

describe('codec: emphasis past the depth cap', () => {
  it('reads a long run of markers without throwing, and is stable after one pass', () => {
    const body = docToMarkdown(markdownToDoc(`${'*'.repeat(20_000)}a${'*'.repeat(20_000)}`));
    stable(body);
    expect(leaves(paragraphInline(body)).map((leaf) => leaf.text).join('').replace(/\*/g, '')).toBe('a');
  });
});

describe('codec: front matter', () => {
  const fence = (language: string, value: string): JSONContent => ({ type: 'codeBlock', attrs: { language }, content: [text(value)] });

  it('opens as a code block, so the editor needs no node of its own', () => {
    expect(markdownToDoc('---\ntitle: x\n---').content).toEqual([fence('front-matter', 'title: x')]);
  });

  it('writes back between its `---` lines only as the first block, and only when that reads back the same', () => {
    expect(docToMarkdown(doc(fence('front-matter', 'title: x'), para(text('b'))))).toBe('---\ntitle: x\n---\n\nb');
    expect(docToMarkdown(doc(para(), fence('front-matter', 'title: x')))).toBe('---\ntitle: x\n---');
    for (const body of [
      docToMarkdown(doc(para(text('b')), fence('front-matter', 'title: x'))),
      docToMarkdown(doc(fence('front-matter', 'no key'))),
      docToMarkdown(doc(fence('front-matter', 'title: x\n---\nmore'))),
      docToMarkdown(doc({ type: 'blockquote', content: [fence('front-matter', 'title: x')] })),
    ]) {
      expect(body).toContain('```front-matter');
      stable(body);
    }
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
