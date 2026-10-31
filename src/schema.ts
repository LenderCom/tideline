// The extensions' commands (`toggleBold`, `insertTable`, …) are module augmentations of `@tiptap/core`. Kept in the
// emitted types so an editor built on this schema sees the commands its schema provides.
/// <reference types="@tiptap/extension-code" preserve="true" />
/// <reference types="@tiptap/extension-code-block" preserve="true" />
/// <reference types="@tiptap/extension-image" preserve="true" />
/// <reference types="@tiptap/extension-list" preserve="true" />
/// <reference types="@tiptap/extension-table" preserve="true" />
/// <reference types="@tiptap/starter-kit" preserve="true" />
import {
  combineTransactionSteps,
  Extension,
  getChangedRanges,
  InputRule,
  mergeAttributes,
  Node,
  textblockTypeInputRule,
  type AnyExtension,
  type NodeViewRenderer,
} from '@tiptap/core';
import { Code } from '@tiptap/extension-code';
import { CodeBlock } from '@tiptap/extension-code-block';
import { Image } from '@tiptap/extension-image';
import { ListItem } from '@tiptap/extension-list';
import { Table, TableCell, TableHeader, TableRow } from '@tiptap/extension-table';
import { Plugin, PluginKey, type Transaction } from '@tiptap/pm/state';
import { StarterKit } from '@tiptap/starter-kit';
import type { DocCalloutKind } from './parse.js';
import type { MarkdownPlugin } from './plugin.js';

/**
 * The editor's schema: the markdown format, exactly. Every node and mark here has a written form (`codec.ts` writes it,
 * `MARKDOWN_NODES`/`MARKDOWN_MARKS` name it, and the round-trip test fails if the two lists drift), and nothing outside
 * the format is enabled: no strike, no underline, no merged cells, no block content in a table cell, no link that is not
 * `https://` or an in-page `#anchor`.
 *
 * Inline atoms (a hard break, a page link, an image, a plugin's token) carry no marks. Co-editing syncs the document
 * through Yjs, and the Yjs bindings (`@tiptap/y-tiptap`, `y-prosemirror`) keep marks on text only: a mark on an atom would
 * vanish from every other collaborator's screen and from the saved page. ProseMirror lets a paragraph's marks land on
 * its atoms (Shift+Enter in bold text makes a bold break), so `UnmarkedAtoms` takes them off as they land; the codec
 * neither reads nor writes one.
 *
 * These are the schema-bearing extensions only. Node views, menus and upload handlers are layered on by the editor that
 * uses them; the codec's tests build their schema from this list alone.
 */

/** Links the format can write: `https://…`, `#anchor` into the same page, and `attachment:<id>`, a file your application holds. */
export function isAllowedDocHref(href: string): boolean {
  return /^https:\/\/[^\s)]+$/.test(href) || /^#[A-Za-z0-9][A-Za-z0-9._-]*$/.test(href) || /^attachment:[A-Za-z0-9_-]+$/.test(href);
}

/** Image sources the format can write: an uploaded attachment, or an `https://` URL. */
export function isAllowedImageSrc(src: string): boolean {
  return /^attachment:[A-Za-z0-9_-]+$/.test(src) || /^https:\/\/[^\s)]+$/.test(src);
}

export const CALLOUT_KINDS: readonly DocCalloutKind[] = ['note', 'tip', 'warning', 'danger'];

/** The attributes the format adds to stock nodes: a heading's pinned `{#anchor}`, a table column's alignment. */
const FormatAttributes = Extension.create({
  name: 'formatAttributes',
  addGlobalAttributes() {
    return [
      {
        types: ['heading'],
        attributes: {
          anchor: {
            default: null,
            parseHTML: (element) => element.getAttribute('data-anchor'),
            renderHTML: (attributes) => (attributes.anchor ? { 'data-anchor': attributes.anchor } : {}),
          },
        },
      },
      {
        types: ['tableCell', 'tableHeader'],
        attributes: {
          align: {
            default: null,
            parseHTML: (element) => {
              const value = element.style.textAlign || element.getAttribute('align');
              return value === 'left' || value === 'center' || value === 'right' ? value : null;
            },
            renderHTML: (attributes) => (attributes.align ? { style: `text-align: ${attributes.align}` } : {}),
          },
        },
      },
    ];
  },
});

/** The inline atoms, which carry no marks (see above). */
const UNMARKED_ATOMS: readonly string[] = ['hardBreak', 'pageLink', 'image'];

/** Takes marks off an inline atom wherever a change put one there, in the same update. */
const UnmarkedAtoms = Extension.create<{ atoms: ReadonlySet<string> }>({
  name: 'unmarkedAtoms',
  addOptions() {
    return { atoms: new Set(UNMARKED_ATOMS) };
  },
  addProseMirrorPlugins() {
    const { atoms } = this.options;
    return [
      new Plugin({
        key: new PluginKey('unmarkedAtoms'),
        appendTransaction: (transactions, oldState, state) => {
          if (!transactions.some((tr) => tr.docChanged)) return null;
          let tr: Transaction | null = null;
          for (const { newRange } of getChangedRanges(combineTransactionSteps(oldState.doc, [...transactions]))) {
            state.doc.nodesBetween(newRange.from, Math.min(newRange.to, state.doc.content.size), (node, pos) => {
              if (atoms.has(node.type.name) && node.marks.length > 0) tr = (tr ?? state.tr).removeMark(pos, pos + node.nodeSize);
            });
          }
          return tr;
        },
      }),
    ];
  },
});

/** Bold or italic code is in the format (`**`x`**`); code inside a link is not (link text is plain). */
const DocCode = Code.extend({ excludes: 'link' });

/** A list item that may be a task: `checked` is null on a plain item, true or false on a `- [ ]` one. */
export const DocListItem = ListItem.extend({
  addAttributes() {
    return {
      checked: {
        default: null,
        keepOnSplit: false,
        parseHTML: (element) => {
          const value = element.getAttribute('data-checked');
          return value === null ? null : value === 'true';
        },
        renderHTML: (attributes) => (typeof attributes.checked === 'boolean' ? { 'data-checked': String(attributes.checked) } : {}),
      },
    };
  },
  addInputRules() {
    // `[ ] ` or `[x] ` typed at the start of a list item makes it a task, as in GitHub.
    return [
      new InputRule({
        find: /^\[( |x|X)\]\s$/,
        handler: ({ state, range, match }) => {
          const { $from } = state.selection;
          const item = $from.node(-1);
          if (item?.type.name !== this.name || $from.index(-1) !== 0) return null;
          state.tr.delete(range.from, range.to).setNodeMarkup($from.before(-1), undefined, { ...item.attrs, checked: match[1] !== ' ' });
        },
      }),
    ];
  },
});

/** A cell holds one line of inline content: GFM tables have no blocks in cells. */
const DocTableHeader = TableHeader.extend({ content: 'paragraph' });
const DocTableCell = TableCell.extend({ content: 'paragraph' });

/** `:::kind Title` … `:::`. */
export const Callout = Node.create({
  name: 'callout',
  group: 'block',
  content: 'block+',
  defining: true,
  addAttributes() {
    return {
      kind: {
        default: 'note',
        parseHTML: (element) => {
          const value = element.getAttribute('data-callout');
          return CALLOUT_KINDS.includes(value as DocCalloutKind) ? value : 'note';
        },
        renderHTML: (attributes) => ({ 'data-callout': attributes.kind }),
      },
      title: {
        default: null,
        parseHTML: (element) => element.getAttribute('data-title'),
        renderHTML: (attributes) => (attributes.title ? { 'data-title': attributes.title } : {}),
      },
    };
  },
  parseHTML() {
    return [{ tag: 'aside[data-callout]' }];
  },
  renderHTML({ HTMLAttributes }) {
    return ['aside', mergeAttributes(HTMLAttributes, { class: 'doc-callout' }), 0];
  },
});

/** A ```` ```mermaid ```` fence: its source is the node's text, its diagram is drawn by the node view. */
export const Mermaid = Node.create({
  name: 'mermaid',
  group: 'block',
  content: 'text*',
  marks: '',
  code: true,
  defining: true,
  parseHTML() {
    // Ahead of the code block's own `pre` rule, so a copied diagram pastes back as a diagram.
    return [{ tag: 'pre[data-mermaid]', preserveWhitespace: 'full', priority: 60 }];
  },
  renderHTML({ HTMLAttributes }) {
    return ['pre', mergeAttributes(HTMLAttributes, { 'data-mermaid': '' }), ['code', 0]];
  },
  addInputRules() {
    return [textblockTypeInputRule({ find: /^```mermaid[\s\n]$/, type: this.type })];
  },
});

/** `[[target]]` / `[[target|label]]`: a link your application resolves: a page, by key or path, or anything else it names. */
export const PageLink = Node.create({
  name: 'pageLink',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,
  marks: '',
  addAttributes() {
    return {
      target: { default: '', parseHTML: (element) => element.getAttribute('data-page-link') ?? '' },
      label: { default: null, parseHTML: (element) => element.getAttribute('data-label') },
    };
  },
  parseHTML() {
    return [{ tag: 'span[data-page-link]' }];
  },
  renderHTML({ node, HTMLAttributes }) {
    const { target, label } = node.attrs as { target: string; label: string | null };
    return ['span', mergeAttributes(HTMLAttributes, { 'data-page-link': target, ...(label ? { 'data-label': label } : {}) }), label ?? target];
  },
  renderText({ node }) {
    const { target, label } = node.attrs as { target: string; label: string | null };
    return `[[${target}${label ? `|${label}` : ''}]]`;
  },
});

/** `![alt](attachment:<id>)` or `![alt](https://…)`, inline. Anything else pasted in is not kept. */
const DocImage = Image.extend({
  inline: true,
  group: 'inline',
  marks: '',
  addAttributes() {
    return {
      src: { default: null },
      alt: { default: '' },
    };
  },
  parseHTML() {
    return [
      {
        tag: 'img[src]',
        getAttrs: (element) => {
          const src = (element as HTMLElement).getAttribute('src') ?? '';
          return isAllowedImageSrc(src) ? { src, alt: (element as HTMLElement).getAttribute('alt') ?? '' } : false;
        },
      },
    ];
  },
}).configure({ inline: true, allowBase64: false });

/** What an editor layers on the schema: the node views, plugins, and undo. Headless use needs none but the plugins. */
export interface DocSchemaConfig {
  views?: Partial<Record<'callout' | 'codeBlock' | 'mermaid' | 'pageLink' | 'image' | 'listItem', NodeViewRenderer>>;
  /** The grammar's optional tokens. Pass the same list here, to `markdownToDoc` and to `docToMarkdown`. */
  plugins?: readonly MarkdownPlugin[];
  /**
   * StarterKit's own undo history. On by default; the real-time co-editor turns it off, because Tiptap
   * Collaboration brings a Yjs undo manager that only undoes the person's own edits. It is no part of the schema.
   */
  undoRedo?: boolean;
}

/** The schema-bearing extensions, configured to the format. */
export function docSchemaExtensions(config: DocSchemaConfig = {}): AnyExtension[] {
  const { views = {}, plugins = [] } = config;
  const withView = <T extends AnyExtension>(extension: T, view: NodeViewRenderer | undefined): T =>
    (view ? (extension as unknown as Node).extend({ addNodeView: () => view }) : extension) as T;
  return [
    StarterKit.configure({
      ...(config.undoRedo === false ? { undoRedo: false as const } : {}),
      strike: false,
      underline: false,
      code: false,
      codeBlock: false,
      listItem: false,
      link: {
        openOnClick: false,
        autolink: true,
        linkOnPaste: true,
        defaultProtocol: 'https',
        protocols: [],
        isAllowedUri: (url) => isAllowedDocHref(url),
        shouldAutoLink: (url) => /^https:\/\//.test(url),
      },
      heading: { levels: [1, 2, 3, 4, 5, 6] },
    }),
    DocCode,
    withView(CodeBlock.configure({ defaultLanguage: null }), views.codeBlock),
    withView(DocListItem, views.listItem),
    FormatAttributes,
    withView(Callout, views.callout),
    withView(Mermaid, views.mermaid),
    withView(PageLink, views.pageLink),
    withView(DocImage, views.image),
    ...plugins.flatMap((plugin) => (plugin.extension ? [plugin.extension()] : [])),
    Table.configure({ resizable: false }),
    TableRow,
    DocTableHeader,
    DocTableCell,
    UnmarkedAtoms.configure({ atoms: new Set([...UNMARKED_ATOMS, ...plugins.map((plugin) => plugin.type)]) }),
  ];
}
