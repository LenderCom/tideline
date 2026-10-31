import type { AnyExtension } from '@tiptap/core';

/**
 * An inline token a plugin adds to the grammar: one piece of markdown text that opens as one atom in the editor. The
 * core codec knows nothing about any particular token. Without the plugin, the same bytes are ordinary text.
 *
 * For a token to round-trip, its text must not be able to run into what's next to it: start it with punctuation the
 * format can escape (`<`, `[`, `*`, `_`, `` ` ``, `(`, `{`, `#`, `|`, `!`) and give it a closing delimiter, as `<@id>`
 * does. A bare `#12` next to the text `3` would read back as `#123`, and a bare `ABC-1` in plain text can't be escaped.
 */
export interface MarkdownPlugin {
  /** The ProseMirror node name the token opens as: an inline atom, which carries no marks, named unlike any core node. */
  type: string;
  /**
   * The token's regular expression source, with no flags. It may not use named groups or numbered backreferences,
   * because it is joined into one expression with the grammar's own. It sees inline text after images, page links and
   * `#anchor` links are taken out, and it is tried after code spans and before links and emphasis at the same position.
   */
  pattern: string;
  /** The node's attributes (strings) for a token the pattern matched, or null to leave those characters as text. */
  read(token: string): Record<string, string> | null;
  /** The token for a node's attributes, or null when they cannot be written. A token the pattern refuses counts as null. */
  write(attrs: Record<string, unknown>): string | null;
  /** The Tiptap extension that defines the node. Without one, you must register the node yourself. */
  extension?(): AnyExtension;
}

/** Which plugins a parse or write runs with. A document must be read and written with the same list. */
export interface GrammarOptions {
  plugins?: readonly MarkdownPlugin[];
}

/** A token a plugin read. `text` is the token as it is written in markdown. */
export interface InlineAtom {
  kind: 'atom';
  type: string;
  attrs: Record<string, string>;
  text: string;
}

const CORE_NODES: ReadonlySet<string> = new Set(['doc', 'paragraph', 'text', 'hardBreak', 'heading', 'codeBlock', 'mermaid', 'blockquote', 'callout', 'bulletList', 'orderedList', 'listItem', 'table', 'tableRow', 'tableHeader', 'tableCell', 'horizontalRule', 'image', 'pageLink']);

const checked = new WeakMap<MarkdownPlugin, RegExp>();

/**
 * The expression a whole token must match. Building it is also where a plugin is checked, the first time it is used: a
 * bad plugin fails here with its own name, not later as a wrong parse or an engine-dependent syntax error.
 */
export function tokenMatcher(plugin: MarkdownPlugin): RegExp {
  const known = checked.get(plugin);
  if (known) return known;
  const refuse = (why: string): never => {
    throw new Error(`Markdown plugin "${plugin.type}": ${why}`);
  };
  if (CORE_NODES.has(plugin.type)) refuse('its type is a core node name');
  if (/\(\?<[A-Za-z_$]/.test(plugin.pattern)) refuse('its pattern may not use named groups');
  if (/\\[1-9]|\\k</.test(plugin.pattern)) refuse('its pattern may not use backreferences');
  let matcher: RegExp | undefined;
  try {
    // Compiled alone first: `X)(Y` is only valid once it is wrapped, and would silently match the wrong thing.
    new RegExp(plugin.pattern);
    matcher = new RegExp(`^(?:${plugin.pattern})$`);
  } catch (error) {
    refuse(`its pattern does not compile: ${error instanceof Error ? error.message : String(error)}`);
  }
  checked.set(plugin, matcher as RegExp);
  return matcher as RegExp;
}
