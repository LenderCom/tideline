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
