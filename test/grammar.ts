import type { JSONContent } from '@tiptap/core';
import { docToMarkdown as write, editorInlineLeaves as leavesOf, markdownToDoc as read } from '../src/codec.js';
import { mentionPlugin } from '../src/mention.js';
import { parseDocBody as parseBody, parseDocInline as parseRun } from '../src/parse.js';
import { docSchemaExtensions as schema, type DocSchemaConfig } from '../src/schema.js';

/**
 * The suites run the whole format, mentions included, so the codec is held to its promises with a token between its
 * delimiters. `core.test.ts` runs the codec with no plugin at all.
 */
export const plugins = [mentionPlugin()];

export const markdownToDoc = (body: string): JSONContent => read(body, { plugins });
export const docToMarkdown = (doc: JSONContent): string => write(doc, { plugins });
export const parseDocBody = (body: string) => parseBody(body, { plugins });
export const parseDocInline = (text: string) => parseRun(text, { plugins });
export const editorInlineLeaves = (nodes: readonly JSONContent[]) => leavesOf(nodes, { plugins });
export const docSchemaExtensions = (config: DocSchemaConfig = {}) => schema({ plugins, ...config });
