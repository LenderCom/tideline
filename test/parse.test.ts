import { describe, expect, it } from 'vitest';
import { attachmentIdOf, docHeadings, docInlineText, headingSlug, mapDocInlines, type DocBlock, type DocInline } from '../src/parse.js';
import { parseDocBody, parseDocInline } from './grammar.js';

const mention = (id: string): DocInline => ({ kind: 'atom', type: 'mention', attrs: { id }, text: `<@${id}>` });

/** An application's own token, added after parsing: `ABC-123` found in text. */
type Ref = { kind: 'ref'; key: string };
function linkRefs(blocks: DocBlock[]): DocBlock<Ref>[] {
  return mapDocInlines<Ref>(blocks, (node) => {
    if (node.kind !== 'text') return [node];
    return node.text.split(/(ABC-\d+)/).flatMap((part): DocInline<Ref>[] => {
      if (part === '') return [];
      return /^ABC-\d+$/.test(part) ? [{ kind: 'ref', key: part }] : [{ kind: 'text', text: part }];
    });
  });
}

describe('the page parser', () => {
  it('reads a token no plugin claims as the text it was written as', () => {
    expect(parseDocInline('ping <@team:t1> and **<@team:t2>**')).toEqual([
      { kind: 'text', text: 'ping <@team:t1> and ' },
      { kind: 'strong', children: [{ kind: 'text', text: '<@team:t2>' }] },
    ]);
  });

  it('keeps the inline grammar: paragraphs, code, tables, quotes, mentions, https links', () => {
    const blocks = parseDocBody(
      ['Hello <@user-1>, see https://example.com.', '', '```ts', 'const x = 1;', '```', '', '| a | b |', '| - | -: |', '| 1 | 2 |', '', '> quoted'].join(
        '\n',
      ),
    );
    expect(blocks.map((block) => block.kind)).toEqual(['paragraph', 'code', 'table', 'quote']);
    expect(blocks[0]).toEqual({
      kind: 'paragraph',
      source: 'Hello <@user-1>, see https://example.com.',
      inline: [
        { kind: 'text', text: 'Hello ' },
        mention('user-1'),
        { kind: 'text', text: ', see ' },
        { kind: 'link', href: 'https://example.com', text: 'https://example.com' },
        { kind: 'text', text: '.' },
      ],
    });
    expect(blocks[1]).toEqual({ kind: 'code', lang: 'ts', text: 'const x = 1;' });
  });

  it('never turns raw HTML or an unsafe scheme into anything but text', () => {
    const blocks = parseDocBody('<script>alert(1)</script> <img src=x onerror=alert(1)> [x](javascript:alert(1)) ![p](http://evil/x.png)');
    expect(blocks).toHaveLength(1);
    const inline = blocks[0].kind === 'paragraph' ? blocks[0].inline : [];
    expect(inline.every((node) => node.kind === 'text')).toBe(true);
  });

  it('gives headings stable anchors: an explicit {#id}, else a slug, unique on the page', () => {
    const blocks = parseDocBody(['# Overview', '## Rollout plan {#D28.9}', '## Overview', '### `code` heading'].join('\n'));
    expect(docHeadings(blocks)).toEqual([
      { id: 'overview', level: 1, text: 'Overview' },
      { id: 'D28.9', level: 2, text: 'Rollout plan' },
      { id: 'overview-1', level: 2, text: 'Overview' },
      { id: 'code-heading', level: 3, text: 'code heading' },
    ]);
    expect(headingSlug('!!!')).toBe('section');
    // The anchor the writer pinned is kept apart from the slug, for the editor to write back.
    expect(blocks.map((block) => (block.kind === 'heading' ? (block.anchor ?? null) : 'other'))).toEqual([null, 'D28.9', null, null]);
  });

  it('nests lists by indentation, with task items and their own blocks', () => {
    const blocks = parseDocBody(['- [x] Done', '  - child', '    ```', '    code', '    ```', '- [ ] Todo', '', '- after a blank', '3. three'].join('\n'));
    expect(blocks[0]).toMatchObject({
      kind: 'list',
      ordered: false,
      items: [
        { checked: true, inline: [{ kind: 'text', text: 'Done' }], children: [{ kind: 'list', items: [{ children: [{ kind: 'code', text: 'code' }] }] }] },
        { checked: false, inline: [{ kind: 'text', text: 'Todo' }], children: [] },
        { inline: [{ kind: 'text', text: 'after a blank' }] },
      ],
    });
    expect(blocks[1]).toMatchObject({ kind: 'list', ordered: true, start: 3 });
  });

  it('reads :::callouts with an optional title, and closes an unclosed one at the end', () => {
    const blocks = parseDocBody([':::warning Before you deploy', 'Check **staging**.', ':::', ':::unknown', 'tail'].join('\n'));
    expect(blocks[0]).toMatchObject({
      kind: 'callout',
      callout: 'warning',
      title: 'Before you deploy',
      blocks: [{ kind: 'paragraph' }],
    });
    expect(blocks[1]).toMatchObject({ kind: 'callout', callout: 'note', blocks: [{ kind: 'paragraph' }] });
  });

  it('reads page links, images and in-page anchors, but not inside code', () => {
    expect(parseDocInline('See [[D28]], [[runbooks/deploy|the runbook]] and [top](#overview).')).toEqual([
      { kind: 'text', text: 'See ' },
      { kind: 'pageLink', target: 'D28' },
      { kind: 'text', text: ', ' },
      { kind: 'pageLink', target: 'runbooks/deploy', label: 'the runbook' },
      { kind: 'text', text: ' and ' },
      { kind: 'anchorLink', anchor: 'overview', text: 'top' },
      { kind: 'text', text: '.' },
    ]);
    expect(parseDocInline('![diagram](attachment:att-1) ![shot](https://x.test/a.png)')).toEqual([
      { kind: 'image', src: 'attachment:att-1', alt: 'diagram' },
      { kind: 'text', text: ' ' },
      { kind: 'image', src: 'https://x.test/a.png', alt: 'shot' },
    ]);
    expect(parseDocInline('`[[D28]]`')).toEqual([{ kind: 'code', text: '[[D28]]' }]);
  });

  it('reads `[label](attachment:<id>)` as a link to a file the application holds', () => {
    expect(parseDocInline('See [Rate sheet Q3.pdf](attachment:docattach-1a) and [the zip](attachment:att_2).')).toEqual([
      { kind: 'text', text: 'See ' },
      { kind: 'link', href: 'attachment:docattach-1a', text: 'Rate sheet Q3.pdf' },
      { kind: 'text', text: ' and ' },
      { kind: 'link', href: 'attachment:att_2', text: 'the zip' },
      { kind: 'text', text: '.' },
    ]);
    // Not an attachment id (a space in it), quoted as code, or escaped: none of them is a file link.
    expect(parseDocInline('[x](attachment:a b)')).toEqual([{ kind: 'text', text: '[x](attachment:a b)' }]);
    expect(parseDocInline('`[x](attachment:a1)`')).toEqual([{ kind: 'code', text: '[x](attachment:a1)' }]);
    expect(parseDocInline(String.raw`\[x](attachment:a1)`)).toEqual([{ kind: 'text', text: '[x](attachment:a1)' }]);
    // The image form stays an image.
    expect(parseDocInline('![x](attachment:a1)')).toEqual([{ kind: 'image', src: 'attachment:a1', alt: 'x' }]);
  });

  it('names the attachment an `attachment:` reference points at', () => {
    expect(attachmentIdOf('attachment:docattach-9')).toBe('docattach-9');
    expect(attachmentIdOf('https://x.test/a.pdf')).toBeNull();
    expect(attachmentIdOf('attachment:')).toBeNull();
  });

  it('reads an escape as text before it looks for page markup', () => {
    // An escaped bracket opens no page link, and an escaped backtick opens no code span that would hide one.
    expect(parseDocInline(String.raw`\[[D28]] and \[t](#a)`)).toEqual([{ kind: 'text', text: '[[D28]] and [t](#a)' }]);
    expect(parseDocInline(String.raw`\` [[D28]] \``)).toEqual([
      { kind: 'text', text: '` ' },
      { kind: 'pageLink', target: 'D28' },
      { kind: 'text', text: ' `' },
    ]);
  });

  it('keeps a mermaid fence as code with its language', () => {
    expect(parseDocBody('```mermaid\ngraph TD\n```')).toEqual([{ kind: 'code', lang: 'mermaid', text: 'graph TD' }]);
  });

  it('adds an application’s own tokens after parsing, inside nested blocks too', () => {
    const blocks = linkRefs(parseDocBody(['- see ABC-12 and UTF-8', ':::note', 'ABC-3', ':::'].join('\n')));
    expect(blocks[0]).toMatchObject({
      kind: 'list',
      items: [{ inline: [{ kind: 'text', text: 'see ' }, { kind: 'ref', key: 'ABC-12' }, { kind: 'text', text: ' and UTF-8' }] }],
    });
    expect(blocks[1]).toMatchObject({ kind: 'callout', blocks: [{ kind: 'paragraph', inline: [{ kind: 'ref', key: 'ABC-3' }] }] });
  });

  it('is total: odd input renders instead of throwing', () => {
    for (const body of ['', '\n\n', '```', ':::', '- ', '  - x', '# ', '[[', '[[]]', '![](', '|', '| a |\n| - |']) {
      expect(() => parseDocBody(body)).not.toThrow();
    }
  });

  it('flattens every inline kind to text', () => {
    const nodes: DocInline[] = [
      { kind: 'text', text: 'a' },
      { kind: 'code', text: 'b' },
      { kind: 'link', href: 'https://x.test', text: 'c' },
      { kind: 'anchorLink', anchor: 'x', text: 'd' },
      { kind: 'strong', children: [{ kind: 'text', text: 'e' }] },
      { kind: 'emphasis', children: [{ kind: 'text', text: 'f' }] },
      { kind: 'pageLink', target: 'g' },
      { kind: 'pageLink', target: 'x', label: 'h' },
      { kind: 'image', src: 'attachment:x', alt: 'i' },
      mention('j'),
    ];
    expect(docInlineText(nodes)).toBe('abcdefghi<@j>');
  });

  it('finds headings inside callouts and quotes, and drops a closing run of hashes', () => {
    const blocks = parseDocBody([':::note', '## Inside ##', ':::', '> ### Quoted', '', 'text'].join('\n'));
    expect(docHeadings(blocks)).toEqual([
      { id: 'inside', level: 2, text: 'Inside' },
      { id: 'quoted', level: 3, text: 'Quoted' },
    ]);
  });

  it('reads tab indentation, continuation blocks and blank lines inside items', () => {
    const blocks = parseDocBody(['- one', '\t- tabbed child', '', '  still one', '- two', '', 'after'].join('\r\n'));
    expect(blocks[0]).toMatchObject({
      kind: 'list',
      items: [
        { inline: [{ kind: 'text', text: 'one' }], children: [{ kind: 'list' }, { kind: 'paragraph' }] },
        { inline: [{ kind: 'text', text: 'two' }] },
      ],
    });
    expect(blocks[1]).toEqual({ kind: 'paragraph', source: 'after', inline: [{ kind: 'text', text: 'after' }] });
  });

  it('ends a list at a change of marker kind or a blank line before something else', () => {
    const blocks = parseDocBody(['- a', '1. b', '', '- c', '', '> d'].join('\n'));
    expect(blocks.map((block) => block.kind)).toEqual(['list', 'list', 'list', 'quote']);
    expect(blocks[1]).not.toHaveProperty('start');
  });

  it('keeps an indented marker inside prose as prose, but lets a flush one interrupt it', () => {
    expect(parseDocBody('text\n    - not a list').map((block) => block.kind)).toEqual(['paragraph']);
    expect(parseDocBody('text\n- a list').map((block) => block.kind)).toEqual(['paragraph', 'list']);
  });

  it('pads short table rows, ends a table at a blank or pipe-less line, and reads callout aliases', () => {
    const blocks = parseDocBody(['| a | b | c |', '| :-: | - |', '| 1 |', 'prose', '', ':::info', 'x', ':::', ':::success', ':::', ':::caution', ':::', ':::error', ':::'].join('\n'));
    expect(blocks[0]).toMatchObject({ kind: 'table', align: ['center', 'none', 'none'], rows: [[[{ text: '1' }], [], []]] });
    expect(blocks[1]).toMatchObject({ kind: 'paragraph' });
    expect(blocks.slice(2).map((block) => (block.kind === 'callout' ? block.callout : block.kind))).toEqual(['note', 'tip', 'warning', 'danger']);
    // A table at the very end of a body, and a pipe line with no delimiter row, stay what they are.
    expect(parseDocBody('a | b').map((block) => block.kind)).toEqual(['paragraph']);
    expect(parseDocBody('| a |\n| - |\n| 1 |\n| - |').map((block) => block.kind)).toEqual(['table', 'paragraph']);
  });

  it('maps inside emphasis, tables, quotes and headings, and leaves code and dividers alone', () => {
    const blocks = linkRefs(parseDocBody(['# ABC-1', '**ABC-2**', '| ABC-3 |', '| - |', '| ABC-4 |', '> ABC-5', '---', '```', 'ABC-6', '```'].join('\n')));
    expect(JSON.stringify(blocks).match(/"key":"ABC-\d"/g)).toEqual(['"key":"ABC-1"', '"key":"ABC-2"', '"key":"ABC-3"', '"key":"ABC-4"', '"key":"ABC-5"']);
  });

  it('merges text around a page link into single runs', () => {
    expect(parseDocInline('a *b* [[c]] d')).toEqual([
      { kind: 'text', text: 'a ' },
      { kind: 'emphasis', children: [{ kind: 'text', text: 'b' }] },
      { kind: 'text', text: ' ' },
      { kind: 'pageLink', target: 'c' },
      { kind: 'text', text: ' d' },
    ]);
  });
});

describe('parseDocInline: which markers are emphasis', () => {
  const plain = (text: string) => [{ kind: 'text', text }];
  const em = (text: string) => ({ kind: 'emphasis', children: [{ kind: 'text', text }] });
  const strong = (text: string) => ({ kind: 'strong', children: [{ kind: 'text', text }] });

  it.each([
    'glob *.ts and *.md files',
    'a * b * c',
    '2 * 3 and 4 * 5 here',
    'a ** b ** c',
    'a _ b _ c',
    'a __ b __ c',
    '*a *',
    '_a _',
    '**a **',
    'snake_case_name',
    '__dunder__method',
    '2*(3+4)*5',
    'f(*args, **kwargs)',
    'int *p = *q;',
    '**Note:**text',
    '*',
    '_',
    '***',
  ])('reads %s as literal text', (text) => {
    expect(parseDocInline(text)).toEqual(plain(text));
  });

  it('pairs what CommonMark pairs', () => {
    expect(parseDocInline('*a*')).toEqual([em('a')]);
    expect(parseDocInline('_a_')).toEqual([em('a')]);
    expect(parseDocInline('**a**')).toEqual([strong('a')]);
    expect(parseDocInline('__a__')).toEqual([strong('a')]);
    expect(parseDocInline('2*3*4')).toEqual([...plain('2'), em('3'), ...plain('4')]);
    expect(parseDocInline('_(a)_ x')).toEqual([em('(a)'), ...plain(' x')]);
    expect(parseDocInline('**a*')).toEqual([...plain('*'), em('a')]);
    expect(parseDocInline('*a**')).toEqual([em('a'), ...plain('*')]);
    expect(parseDocInline('_a_b_')).toEqual([em('a_b')]);
    expect(parseDocInline('*a *b*')).toEqual([...plain('*a '), em('b')]);
    expect(parseDocInline('***a***')).toEqual([{ kind: 'emphasis', children: [strong('a')] }]);
    expect(parseDocInline('*foo**bar*')).toEqual([em('foo**bar')]);
    expect(parseDocInline('*a **b** c*')).toEqual([{ kind: 'emphasis', children: [{ kind: 'text', text: 'a ' }, strong('b'), { kind: 'text', text: ' c' }] }]);
  });

  it('does not close on a marker inside a code span, a link or an escape', () => {
    expect(parseDocInline('*a `*` b*')).toEqual([{ kind: 'emphasis', children: [{ kind: 'text', text: 'a ' }, { kind: 'code', text: '*' }, { kind: 'text', text: ' b' }] }]);
    expect(parseDocInline('*a [b*](https://c.d) e*')).toEqual([
      { kind: 'emphasis', children: [{ kind: 'text', text: 'a ' }, { kind: 'link', href: 'https://c.d', text: 'b*' }, { kind: 'text', text: ' e' }] },
    ]);
    expect(parseDocInline('*a\\*b*')).toEqual([em('a*b')]);
  });

  it('leaves the inner marker literal when two spans cross', () => {
    expect(parseDocInline('*a _b* c_')).toEqual([em('a _b'), ...plain(' c_')]);
  });

  it('keeps emphasis to one line, whatever flanks it', () => {
    expect(parseDocInline('*a\nb*')).toEqual(plain('*a\nb*'));
    expect(parseDocInline('*a `x\ny` b*')).toEqual([{ kind: 'text', text: '*a ' }, { kind: 'code', text: 'x\ny' }, { kind: 'text', text: ' b*' }]);
  });

  it('treats a surrogate pair next to a marker as one character', () => {
    expect(parseDocInline('😀*a*😀')).toEqual([...plain('😀'), em('a'), ...plain('😀')]);
    expect(parseDocInline('𝒜*a*𝒜')).toEqual([...plain('𝒜'), em('a'), ...plain('𝒜')]);
  });

  const depth = (run: readonly DocInline[]): number =>
    Math.max(0, ...run.map((node) => (node.kind === 'strong' || node.kind === 'emphasis' ? 1 + depth(node.children) : 0)));
  const flat = (run: readonly DocInline[]): string =>
    run.map((node) => (node.kind === 'strong' || node.kind === 'emphasis' ? flat(node.children) : node.kind === 'text' ? node.text : '')).join('');

  it('caps how deep one long run of markers nests, and keeps the markers past the cap as text', () => {
    // Each side of `a`: how many markers a run of this size leaves literal. An odd run's outermost span takes one marker.
    const cases: Array<[size: number, depth: number, literal: number]> = [
      [32, 16, 0],
      [64, 32, 0],
      [65, 32, 2],
      [66, 32, 2],
      [100, 32, 36],
      [101, 32, 38],
      [20_000, 32, 19_936],
    ];
    for (const marker of ['*', '_']) {
      for (const [size, deep, literal] of cases) {
        const run = parseDocInline(`${marker.repeat(size)}a${marker.repeat(size)}`);
        expect(depth(run)).toBe(deep);
        expect(flat(run)).toBe(`${marker.repeat(literal)}a${marker.repeat(literal)}`);
      }
    }
    // Depth is what is capped, not how many: spans side by side all stay spans.
    expect(parseDocInline('**a** '.repeat(100)).filter((node) => node.kind === 'strong')).toHaveLength(100);
  });

  it('caps depth when spans of one run nest around others', () => {
    const body = `${'**'.repeat(40)}a${'**'.repeat(40)} ${'*a '.repeat(40)}b${' c*'.repeat(40)}`;
    const run = parseDocInline(body);
    expect(depth(run)).toBeLessThanOrEqual(32);
    expect(run.some((node) => node.kind === 'text' && node.text.includes('c'))).toBe(true);
  });

  it('caps how deep emphasis nests, and stays fast on a line of unpaired markers', () => {
    const nested = parseDocInline(`${'*a '.repeat(5000)}b${' c*'.repeat(5000)}`);
    expect(depth(nested)).toBeLessThanOrEqual(32);
    const started = performance.now();
    parseDocInline('*a _b '.repeat(50_000));
    expect(performance.now() - started).toBeLessThan(2000);
  });
});

describe('parseDocInline: a bare URL in emphasis', () => {
  const link = (href: string) => ({ kind: 'link', href, text: href });
  const strong = (...children: unknown[]) => ({ kind: 'strong', children });
  const em = (...children: unknown[]) => ({ kind: 'emphasis', children });

  it('leaves the closing marker to close', () => {
    expect(parseDocInline('**https://example.com**')).toEqual([strong(link('https://example.com'))]);
    expect(parseDocInline('__https://example.com__')).toEqual([strong(link('https://example.com'))]);
    expect(parseDocInline('*https://example.com/a*')).toEqual([em(link('https://example.com/a'))]);
    expect(parseDocInline('_https://example.com/a_')).toEqual([em(link('https://example.com/a'))]);
    expect(parseDocInline('***https://example.com***')).toEqual([em(strong(link('https://example.com')))]);
    expect(parseDocInline('**https://a.b**, then **https://c.d**.')).toEqual([strong(link('https://a.b')), { kind: 'text', text: ', then ' }, strong(link('https://c.d')), { kind: 'text', text: '.' }]);
    expect(parseDocInline('**see https://a.b**x')).toEqual([strong({ kind: 'text', text: 'see ' }, link('https://a.b')), { kind: 'text', text: 'x' }]);
    expect(parseDocInline('**https://a.b/.**')).toEqual([strong(link('https://a.b/'), { kind: 'text', text: '.' })]);
    expect(parseDocInline('*https://*')).toEqual([em({ kind: 'text', text: 'https://' })]);
    // An escaped marker, or one between backticks, cannot end the span around a URL.
    expect(parseDocInline('*see https://a.b/x\\* now*')).toEqual([em({ kind: 'text', text: 'see ' }, link('https://a.b/x\\*'), { kind: 'text', text: ' now' })]);
    expect(parseDocInline('*see https://a.b/`x*y` z*')).toEqual([em({ kind: 'text', text: 'see ' }, link('https://a.b/`x*y`'), { kind: 'text', text: ' z' })]);
    expect(parseDocInline('*https://a.b/`x*')).toEqual([em(link('https://a.b/`x'))]);
  });

  it('keeps a marker in the URL when it closes nothing', () => {
    expect(parseDocInline('https://a.b/x_y_z')).toEqual([link('https://a.b/x_y_z')]);
    expect(parseDocInline('https://a.b/x*')).toEqual([link('https://a.b/x*')]);
    expect(parseDocInline('https://a.b/x_')).toEqual([link('https://a.b/x_')]);
    expect(parseDocInline('https://a.b**')).toEqual([link('https://a.b**')]);
    expect(parseDocInline('_https://a.b/x_y_')).toEqual([em(link('https://a.b/x_y'))]);
    expect(parseDocInline('**https://a.b/x*y**')).toEqual([strong(link('https://a.b/x*y'))]);
    expect(parseDocInline('*https://a.b/*x*')).toEqual([em(link('https://a.b/*x'))]);
    expect(parseDocInline('*a* https://a.b/x*')).toEqual([em({ kind: 'text', text: 'a' }), { kind: 'text', text: ' ' }, link('https://a.b/x*')]);
  });

  it('still leaves the same punctuation and non-URLs out of a bare link', () => {
    expect(parseDocInline('https://a.b.')).toEqual([link('https://a.b'), { kind: 'text', text: '.' }]);
    expect(parseDocInline('(https://a.b/c).')).toEqual([{ kind: 'text', text: '(' }, link('https://a.b/c'), { kind: 'text', text: ').' }]);
    expect(parseDocInline('https://')).toEqual([{ kind: 'text', text: 'https://' }]);
    expect(parseDocInline('https://.')).toEqual([{ kind: 'text', text: 'https://.' }]);
    expect(parseDocInline('http://a.b')).toEqual([{ kind: 'text', text: 'http://a.b' }]);
  });

  it('stays linear on a line of URLs that each close a span', () => {
    const started = performance.now();
    parseDocInline('**https://a'.repeat(100_000));
    expect(performance.now() - started).toBeLessThan(2000);
  });
});

describe('parseDocBody: indented code', () => {
  it('reads an indented block as code, keeping its blank lines and inner indent', () => {
    expect(parseDocBody('para\n\n    a\n\n      b\n\n\nafter')).toEqual([
      { kind: 'paragraph', inline: [{ kind: 'text', text: 'para' }], source: 'para' },
      { kind: 'code', text: 'a\n\n  b' },
      { kind: 'paragraph', inline: [{ kind: 'text', text: 'after' }], source: 'after' },
    ]);
    expect(parseDocBody('\tcode')).toEqual([{ kind: 'code', text: 'code' }]);
    expect(parseDocBody('    - not a list\n    # not a heading')).toEqual([{ kind: 'code', text: '- not a list\n# not a heading' }]);
  });

  it('keeps an indented line that carries on a paragraph as that paragraph', () => {
    expect(parseDocBody('para\n    more')[0].kind).toBe('paragraph');
    expect(parseDocBody('para\n    more')).toHaveLength(1);
  });

  it('reads code under a list item only after a blank line, and leaves over-indented sub-lists alone', () => {
    const [first] = parseDocBody('- a\n      carried on');
    expect(first.kind === 'list' && first.items[0].children[0].kind).toBe('paragraph');
    const [second] = parseDocBody('- a\n\n      code');
    expect(second.kind === 'list' && second.items[0].children[0]).toEqual({ kind: 'code', text: 'code' });
    const [third] = parseDocBody('- a\n      - b');
    expect(third.kind === 'list' && third.items[0].children[0].kind).toBe('list');
  });

  it('stops at the first line that is not indented, even with no blank line', () => {
    expect(parseDocBody('    code\nafter').map((block) => block.kind)).toEqual(['code', 'paragraph']);
  });
});

describe('parseDocBody: front matter', () => {
  it('holds a leading block verbatim, and carries on with the page after it', () => {
    expect(parseDocBody('---\ntitle: *x*\n\nkey:\n  - a\n---\n\n# H')).toEqual([
      { kind: 'code', lang: 'front-matter', text: 'title: *x*\n\nkey:\n  - a' },
      { kind: 'heading', level: 1, id: 'h', inline: [{ kind: 'text', text: 'H' }] },
    ]);
  });

  it.each([
    ['a divider then prose', '---\n\ntitle: x\n\n---'],
    ['no key on its first line', '---\nJust a note\n---'],
    ['no closing line', '---\ntitle: x'],
    ['not at the very start', '\n---\ntitle: x\n---'],
    ['an indented opener', ' ---\ntitle: x\n---'],
  ])('does not read %s as front matter', (_, body) => {
    expect(parseDocBody(body).some((block) => block.kind === 'code')).toBe(false);
  });

  it('is only a page\'s own: not inside a quote or a callout', () => {
    expect(parseDocBody('> ---\n> title: x\n> ---')[0]).toMatchObject({ kind: 'quote' });
    expect(JSON.stringify(parseDocBody(':::note\n---\ntitle: x\n---\n:::'))).not.toContain('front-matter');
  });
});
