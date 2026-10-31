/**
 * Lossless Markdown ⇄ Tiptap 3, with a 3-way merge: the grammar, the editor schema and the codec between them. Headless:
 * nothing here touches the DOM, so it runs under plain Node. An editor's node views and menus are layered on through
 * `docSchemaExtensions({ views })`.
 */
export { alignOf, isDelimiterRow, parseInline, splitTableRow, type Inline, type TableAlign } from './inline.js';
export {
  attachmentIdOf,
  mapDocInlines,
  parseDocBody,
  parseDocInline,
  type DocBlock,
  type DocCalloutKind,
  type DocInline,
  type DocListItem,
} from './parse.js';
export type { GrammarOptions, InlineAtom, MarkdownPlugin } from './plugin.js';
export { CALLOUT_KINDS, docSchemaExtensions, isAllowedDocHref, isAllowedImageSrc, type DocSchemaConfig } from './schema.js';
export { docToMarkdown, MARKDOWN_MARKS, MARKDOWN_NODES, markdownToDoc } from './codec.js';
export { mergeMarkdown, type MarkdownMerge, type MarkdownMergeHunk } from './merge.js';
