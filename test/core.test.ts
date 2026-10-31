import { getSchema } from '@tiptap/core';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { docSchemaExtensions, docToMarkdown, MARKDOWN_MARKS, MARKDOWN_NODES, markdownToDoc, parseDocInline, type MarkdownPlugin } from '../src/index.js';
import { mentionPlugin } from '../src/mention.js';
import { PARAMS } from './generators.js';
import { SYNTHETIC_PAGES, syntheticPage } from './synthetic.js';

/** The codec as someone who has never heard of a plugin uses it: every call with its defaults. */
const roundTrip = (body: string): string => docToMarkdown(markdownToDoc(body));

describe('the core codec, with no plugin', () => {
  it('has only generic nodes in its schema', () => {
    const schema = getSchema(docSchemaExtensions());
    expect(Object.keys(schema.nodes).sort()).toEqual([...MARKDOWN_NODES].sort());
    expect(Object.keys(schema.marks).sort()).toEqual([...MARKDOWN_MARKS].sort());
    expect(schema.nodes.mention).toBeUndefined();
  });

  it('reads a mention token and a ticket-shaped key as plain text, and keeps their bytes', () => {
    for (const body of ['Ask <@user-123> about ABC-123.', '**<@u1>** and _<@u2>_', '| <@u1> |\n| --- |', '- [ ] <@a_b>']) {
      expect(roundTrip(body)).toBe(body);
    }
    expect(parseDocInline('Ask <@u1> about ABC-1.')).toEqual([{ kind: 'text', text: 'Ask <@u1> about ABC-1.' }]);
  });

  it('opens nothing it has no node for', () => {
    expect(JSON.stringify(markdownToDoc('Ask <@u1>.'))).not.toContain('"mention"');
    const schema = getSchema(docSchemaExtensions());
    expect(() => schema.nodeFromJSON(markdownToDoc('Ask <@u1> about ABC-1, see [[guide]].')).check()).not.toThrow();
  });

  it('drops a node from a plugin it was not given rather than inventing text', () => {
    expect(docToMarkdown({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'a ' }, { type: 'mention', attrs: { id: 'u1' } }] }] })).toBe('a');
  });

  it('round-trips the synthetic corpus, stable after one pass', () => {
    for (let index = 0; index < SYNTHETIC_PAGES; index += 20) {
      const once = roundTrip(syntheticPage(index, { mentions: false }));
      expect(roundTrip(once)).toBe(once);
    }
  });

  it('is stable on any text holding token-shaped pieces', () => {
    const piece = fc.constantFrom('<@u1>', '<@', '>', 'ABC-12', ' ', 'word', '**', '_', '`', '\\');
    fc.assert(
      fc.property(fc.array(piece, { maxLength: 12 }), (pieces) => {
        const once = roundTrip(pieces.join(''));
        expect(roundTrip(once)).toBe(once);
      }),
      PARAMS,
    );
  });
});

describe('plugins', () => {
  it('open a token as its node with the plugin, and leave it as text without', () => {
    const plugins = [mentionPlugin()];
    expect(markdownToDoc('<@u1>', { plugins }).content?.[0].content).toEqual([{ type: 'mention', attrs: { id: 'u1' } }]);
    expect(markdownToDoc('<@u1>').content?.[0].content).toEqual([{ type: 'text', text: '<@u1>' }]);
    expect(Object.keys(getSchema(docSchemaExtensions({ plugins })).nodes)).toContain('mention');
  });

  it('escape text that spells a token only when a plugin would read it', () => {
    const paragraph = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: '<@u1>' }] }] };
    expect(docToMarkdown(paragraph)).toBe('<@u1>');
    const written = docToMarkdown(paragraph, { plugins: [mentionPlugin()] });
    expect(written).toBe('\\<@u1>');
    expect(markdownToDoc(written, { plugins: [mentionPlugin()] })).toEqual(paragraph);
  });

  it('can be any inline atom, with text left as typed when the plugin refuses a match', () => {
    const issue: MarkdownPlugin = {
      type: 'issue',
      pattern: '<#\\d+>',
      read: (token) => (token === '<#0>' ? null : { number: token.slice(2, -1) }),
      write: (attrs) => `<#${String(attrs.number)}>`,
    };
    const plugins = [issue];
    expect(markdownToDoc('see <#12> and <#0>', { plugins }).content?.[0].content).toEqual([
      { type: 'text', text: 'see ' },
      { type: 'issue', attrs: { number: '12' } },
      { type: 'text', text: ' and <#0>' },
    ]);
    expect(docToMarkdown(markdownToDoc('see <#12> and <#0>', { plugins }), { plugins })).toBe('see <#12> and <#0>');
    expect(docToMarkdown({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'issue', attrs: { number: 'x' } }] }] }, { plugins })).toBe('');
    expect(parseDocInline('`<#12>`', { plugins })).toEqual([{ kind: 'code', text: '<#12>' }]);
  });

  it('keep an atom and the text beside it apart, when the token closes', () => {
    const issue: MarkdownPlugin = { type: 'issue', pattern: '<#\\d+>', read: (token) => ({ number: token.slice(2, -1) }), write: (attrs) => `<#${String(attrs.number)}>` };
    const doc = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'issue', attrs: { number: '12' } }, { type: 'text', text: '3 and <#4>' }] }] };
    const written = docToMarkdown(doc, { plugins: [issue] });
    expect(markdownToDoc(written, { plugins: [issue] })).toEqual(doc);
  });

  it('never hang on a pattern that can match nothing', () => {
    for (const pattern of ['x*', 'x?', '(?=a)']) {
      for (const read of [() => null, () => ({})]) {
        const plugin: MarkdownPlugin = { type: 'empty', pattern, read, write: () => null };
        expect(parseDocInline('abc', { plugins: [plugin] })).toEqual([{ kind: 'text', text: 'abc' }]);
      }
    }
  });

  it('are refused by name when they could not work', () => {
    const refused = (plugin: Partial<MarkdownPlugin>): string => {
      try {
        parseDocInline('x', { plugins: [{ type: 'p', pattern: 'y', read: () => ({}), write: () => null, ...plugin }] });
        return '';
      } catch (error) {
        return (error as Error).message;
      }
    };
    expect(refused({ pattern: '<(?<code>[a-z]+)>' })).toContain('named groups');
    expect(refused({ pattern: '(a)\\1' })).toContain('backreferences');
    expect(refused({ pattern: '(' })).toContain('does not compile');
    expect(refused({ pattern: 'X)(Y' })).toContain('does not compile');
    expect(refused({ type: 'image' })).toContain('core node');
    expect(refused({ pattern: '(?<=a)b|(c)' })).toBe('');
  });

  it('drop a node whose token the pattern refuses, so it cannot be saved as something else', () => {
    const issue: MarkdownPlugin = { type: 'issue', pattern: '<#\\d+>', read: () => ({}), write: (attrs) => `<#${String(attrs.number)}>` };
    const doc = (attrs: Record<string, unknown>) => ({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'a ' }, { type: 'issue', attrs }, { type: 'text', text: ' b' }] }] });
    expect(docToMarkdown(doc({}), { plugins: [issue] })).toBe('a  b');
    expect(docToMarkdown(doc({ number: '1' }), { plugins: [issue] })).toBe('a <#1> b');
  });

  it('write nothing for a paragraph whose only content cannot be written, and hold after one pass', () => {
    const only = { type: 'paragraph', content: [{ type: 'mention', attrs: { id: 'u1' } }] };
    const para = (text: string) => ({ type: 'paragraph', content: [{ type: 'text', text }] });
    expect(docToMarkdown({ type: 'doc', content: [para('a'), only, para('b')] })).toBe('a\n\nb');
    expect(docToMarkdown({ type: 'doc', content: [para('a'), only] })).toBe('a');
  });

  it('are escaped in a table cell if their token holds a pipe', () => {
    const pipe: MarkdownPlugin = { type: 'pipe', pattern: '%a\\\\?\\|b%', read: () => ({}), write: () => '%a|b%' };
    const doc = { type: 'doc', content: [{ type: 'table', content: [{ type: 'tableRow', content: [{ type: 'tableHeader', content: [{ type: 'paragraph', content: [{ type: 'pipe' }] }] }] }] }] };
    expect(docToMarkdown(doc, { plugins: [pipe] })).toContain('%a\\|b%');
  });
});
