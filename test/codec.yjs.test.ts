import { getSchema, type JSONContent } from '@tiptap/core';
import { prosemirrorJSONToYDoc, yDocToProsemirrorJSON } from '@tiptap/y-tiptap';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { docArb, page, PARAMS } from './generators.js';
import { docSchemaExtensions, docToMarkdown, markdownToDoc } from './grammar.js';
import { SYNTHETIC_PAGES, syntheticPage } from './synthetic.js';
import { CANONICAL } from './vectors.js';

/**
 * The round-trip gate's co-editing leg. Under co-editing a page lives as a Y.Doc while it is open: each editor binds to it
 * through `@tiptap/extension-collaboration` (which syncs through `@tiptap/y-tiptap`, into the fragment `default`), and a
 * server saves it back as markdown with this same codec. So a page must come through Yjs as the editor alone would write
 * it:
 *
 *   markdown → editor JSON → Y.Doc → update → a fresh Y.Doc (another client, or a server after a reload) → editor JSON → markdown
 *
 * is `docToMarkdown(markdownToDoc(body))`, byte for byte: for one page per construct, over both property generators, and
 * over a synthetic corpus of long pages (`synthetic.ts`).
 */
const schema = getSchema(docSchemaExtensions());

/** The fragment `@tiptap/extension-collaboration` binds to unless told otherwise. */
const FIELD = 'default';

/** An editor document through Yjs, as a second client receives it: encoded, applied to a fresh doc, read back. */
function throughYjs(doc: JSONContent): JSONContent {
  const update = Y.encodeStateAsUpdate(prosemirrorJSONToYDoc(schema, doc, FIELD));
  const remote = new Y.Doc();
  Y.applyUpdate(remote, update);
  const json = yDocToProsemirrorJSON(remote, FIELD) as JSONContent;
  // What comes back must still be a document of the schema, or the editor could not open it.
  schema.nodeFromJSON(json).check();
  return json;
}

/** What the editor alone writes for a page, and what a save writes for it after Yjs. */
const editorOnly = (body: string): string => docToMarkdown(markdownToDoc(body));
const saved = (body: string): string => docToMarkdown(throughYjs(markdownToDoc(body)));

const corpus = Array.from({ length: SYNTHETIC_PAGES }, (_, index): [string, string] => [`page ${index}`, syntheticPage(index)]);

describe('codec through Yjs: a save writes what the editor writes', () => {
  it('keeps a code span that runs across a line (the spike’s one loss) and marks around inline atoms', () => {
    for (const body of ['`one\ntwo`', 'a `one\ntwo` b and `two`\n`spans`', '**Ask <@u1> now**\n**[[D28]] ![i](attachment:k)**']) {
      expect(saved(body)).toBe(editorOnly(body));
    }
    expect(saved('`one\ntwo`')).toBe('`one\ntwo`');
  });

  it.each(Object.entries(CANONICAL))('%s', (_, body) => {
    expect(saved(body)).toBe(editorOnly(body));
  });

  it('adversarial pages', () => {
    fc.assert(
      fc.property(page, (body) => {
        expect(saved(body)).toBe(editorOnly(body));
      }),
      PARAMS,
    );
  });

  it('editor documents', () => {
    fc.assert(
      fc.property(docArb, (doc) => {
        expect(docToMarkdown(throughYjs(doc))).toBe(docToMarkdown(doc));
      }),
      PARAMS,
    );
  });
});

describe('codec through Yjs: the synthetic corpus', () => {
  it('holds at least 200 pages, reaching every node and mark in the schema', () => {
    // A truncated or thin corpus would make the leg below pass vacuously.
    expect(corpus.length).toBeGreaterThanOrEqual(200);
    const seen = new Set<string>();
    const walk = (node: JSONContent): void => {
      if (node.type) seen.add(node.type);
      for (const mark of node.marks ?? []) seen.add(mark.type);
      for (const child of node.content ?? []) walk(child);
    };
    for (const [, body] of corpus) walk(markdownToDoc(body));
    expect([...Object.keys(schema.nodes), ...Object.keys(schema.marks)].filter((name) => !seen.has(name))).toEqual([]);
  });

  it.each(corpus)('%s', (_, body) => {
    expect(saved(body)).toBe(editorOnly(body));
  });
});
