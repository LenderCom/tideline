import { tokenMatcher, type GrammarOptions, type InlineAtom } from './plugin.js';

/**
 * The inline grammar: code spans, links, emphasis and page links, plus whatever tokens the plugins add. It is
 * hand-written, and it produces a token tree, never an HTML string, so a renderer puts every literal through its text
 * path and escaping is not a step anyone can forget. Raw HTML is never interpreted: it reads back exactly as typed.
 *
 * Only `https://` links are ever emitted. `javascript:`, `data:` and bare `http://` never match, so they stay text and a
 * renderer is never handed a scheme it would have to decide about.
 */

/**
 * One inline run. Emphasis nests; everything else is a leaf. `X` is whatever extra tokens a caller's own post-parse
 * step adds through `mapDocInlines`; the parser itself never produces one.
 */
export type Inline<X = never> =
  | { kind: 'text'; text: string }
  | { kind: 'code'; text: string }
  | InlineAtom
  | { kind: 'link'; href: string; text: string }
  /** `[[target]]` or `[[target|label]]`. The target is resolved by the renderer; the parser knows no pages. */
  | { kind: 'pageLink'; target: string; label?: string }
  | { kind: 'strong'; children: Inline<X>[] }
  | { kind: 'emphasis'; children: Inline<X>[] }
  | X;

/** How a GFM table column is aligned, read from its delimiter cell (`:--`, `:--:`, `--:`, `--`). */
export type TableAlign = 'left' | 'center' | 'right' | 'none';

/**
 * The alternation the inline scanner walks, in precedence order: at each position, an earlier branch wins.
 *
 *  1. Inline code, matched by its own backtick run (``a ` b``). It comes first because a span inside code must never be
 *     re-read as markup.
 *  2. The plugins' tokens, in the order they were given.
 *  3. A `[[page]]` or `[[target|label]]` link, before the bracketed link that would otherwise read its `[`. Then a
 *     bracketed link, then a bare autolink, both https-only. A label may carry escaped punctuation (`\[`, `\]`), as
 *     GFM allows, and reads unescaped.
 *  4. Strong before emphasis, so `**x**` is not read as an emphasis of `*x*`.
 *  5. A backslash escape (`\_`, `\*`, `\[`): the punctuation reads as itself. `\:` is in the set, as in CommonMark, so
 *     a writer can spell a literal `https:` or a line starting `:::`.
 *
 * Emphasis bodies refuse newlines: an unpaired `*` in a multi-line note would otherwise swallow everything to the next
 * one, several lines away, and italicize a paragraph nobody marked up.
 */
function inlineSource(options: GrammarOptions): string {
  return [
    '(?<fence>`+)(?<code>[^]*?)\\k<fence>',
    ...(options.plugins ?? []).map((plugin, index) => `(?<atom${index}>${plugin.pattern})`),
    '\\[\\[(?<target>[^\\[\\]\\n|]+?)(?:\\|(?<label>[^\\[\\]\\n]+?))?\\]\\]',
    '\\[(?<linkText>(?:\\\\[\\\\`*_{}\\[\\]()<>#+\\-.!|~:]|[^\\]\\\\\\n])+)\\]\\((?<href>https:\\/\\/[^\\s)]+)\\)',
    '(?<auto>https:\\/\\/[^\\s<>()\\[\\]\'"]*[^\\s<>()\\[\\].,;:!?\'"])',
    '\\*\\*(?<strongStar>[^\\n]+?)\\*\\*',
    '__(?<strongUnder>[^\\n]+?)__',
    '\\*(?<emStar>[^*\\n]+)\\*',
    '_(?<emUnder>[^_\\n]+)_',
    '\\\\(?<escaped>[\\\\`*_{}\\[\\]()<>#+\\-.!|~:])',
  ].join('|');
}

/** The same set the escape branch reads as itself: unescaped inside a link label, which renders as plain text. */
const ESCAPED_PUNCTUATION = /\\([\\`*_{}[\]()<>#+\-.!|~:])/g;

/**
 * Recursion is bounded by construction: every nested call parses a STRICTLY shorter slice (the
 * delimiters are consumed), so a pathological body cannot spin here.
 *
 * The matcher is built PER CALL rather than hoisted to a module constant: a `g` regex carries
 * `lastIndex` on the object itself, so one shared instance would have an emphasis body's nested
 * scan rewind the outer scan's cursor mid-loop — the same run of text re-tokenized forever.
 */
export function parseInline(text: string, options: GrammarOptions = {}): Inline[] {
  const plugins = options.plugins ?? [];
  plugins.forEach(tokenMatcher);
  const pattern = new RegExp(inlineSource(options), 'g');
  const out: Inline[] = [];
  let cursor = 0;

  const pushText = (value: string): void => {
    if (value === '') return;
    const last = out[out.length - 1];
    // Coalesce, so a body that produced no markup at all is ONE text node rather than a run of
    // adjacent ones — which keeps the rendered DOM (and every test's `textContent`) simple.
    if (last?.kind === 'text') last.text += value;
    else out.push({ kind: 'text', text: value });
  };

  for (let match = pattern.exec(text); match !== null; match = pattern.exec(text)) {
    // Only a plugin's pattern can match nothing. It reads as nothing, and the scan must still move on.
    if (match[0] === '') {
      pattern.lastIndex += 1;
      continue;
    }
    pushText(text.slice(cursor, match.index));
    cursor = match.index + match[0].length;

    const groups = match.groups ?? {};
    const atomIndex = plugins.findIndex((_, index) => groups[`atom${index}`] !== undefined);
    if (groups.code !== undefined) {
      // Markdown's own rule: one leading + trailing space inside a code span is padding that
      // lets the span start or end with a backtick, not content.
      out.push({ kind: 'code', text: stripCodePadding(groups.code) });
    } else if (atomIndex >= 0) {
      const attrs = plugins[atomIndex].read(match[0]);
      if (attrs === null) pushText(match[0]);
      else out.push({ kind: 'atom', type: plugins[atomIndex].type, attrs, text: match[0] });
    } else if (groups.target !== undefined) {
      const target = groups.target.trim();
      const label = groups.label?.trim();
      // A link whose target is blank (`[[ ]]`) names nothing: it reads as typed.
      if (target === '') pushText(match[0]);
      else out.push({ kind: 'pageLink', target, ...(label ? { label } : {}) });
    } else if (groups.linkText !== undefined && groups.href !== undefined) {
      out.push({ kind: 'link', href: groups.href, text: groups.linkText.replace(ESCAPED_PUNCTUATION, '$1') });
    } else if (groups.auto !== undefined) {
      out.push({ kind: 'link', href: groups.auto, text: groups.auto });
    } else if (groups.strongStar !== undefined || groups.strongUnder !== undefined) {
      out.push({ kind: 'strong', children: parseInline(groups.strongStar ?? groups.strongUnder ?? '', options) });
    } else if (groups.emStar !== undefined || groups.emUnder !== undefined) {
      out.push({ kind: 'emphasis', children: parseInline(groups.emStar ?? groups.emUnder ?? '', options) });
    } else if (groups.escaped !== undefined) {
      pushText(groups.escaped);
    }
  }

  pushText(text.slice(cursor));
  return out;
}

function stripCodePadding(value: string): string {
  return value.startsWith(' ') && value.endsWith(' ') && value.trim() !== '' ? value.slice(1, -1) : value;
}

/**
 * Split one table line into trimmed cells. The optional outer pipes are dropped first, then the row
 * is cut on every UNescaped `|`; a `\|` is the writer's way to put a literal pipe INSIDE a cell, so
 * it survives as one and never opens a new column.
 */
export function splitTableRow(line: string): string[] {
  let text = line.trim();
  if (text.startsWith('|')) text = text.slice(1);
  if (text.endsWith('|') && !text.endsWith('\\|')) text = text.slice(0, -1);

  const cells: string[] = [];
  let cell = '';
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === '\\' && text[index + 1] === '|') {
      cell += '|';
      index += 1;
      continue;
    }
    if (text[index] === '|') {
      cells.push(cell);
      cell = '';
      continue;
    }
    cell += text[index];
  }
  cells.push(cell);
  return cells.map((value) => value.trim());
}

/** A delimiter row is every cell of the form `:?-+:?` and at least one dash — the shape that turns
 * the line ABOVE it into a table header rather than leaving it as prose. */
export function isDelimiterRow(line: string): boolean {
  if (!line.includes('-') || !line.includes('|')) return false;
  const cells = splitTableRow(line);
  return cells.length > 0 && cells.every((cell) => /^:?-+:?$/.test(cell));
}

/** The alignment a delimiter cell asks for: a colon pins that side, both pins centre, neither is none. */
export function alignOf(cell: string): TableAlign {
  const left = cell.startsWith(':');
  const right = cell.endsWith(':');
  if (left && right) return 'center';
  if (right) return 'right';
  if (left) return 'left';
  return 'none';
}
