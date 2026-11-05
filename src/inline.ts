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

const AUTOLINK_SCHEME = 'https://';

/**
 * The alternation the inline scanner walks, in precedence order: at each position, an earlier branch wins.
 *
 *  1. Inline code, matched by its own backtick run (``a ` b``). It comes first because a span inside code must never be
 *     re-read as markup.
 *  2. The plugins' tokens, in the order they were given.
 *  3. A `[[page]]` or `[[target|label]]` link, before the bracketed link that would otherwise read its `[`. Then a
 *     bracketed link, then a bare autolink, both https-only. A label may carry escaped punctuation (`\[`, `\]`), as
 *     GFM allows, and reads unescaped. Only a bare link's scheme is matched here: `bareUrlEnd` walks the rest.
 *  4. A run of `*` or `_`, which may turn out to be emphasis or a literal character (see `parseInline`).
 *  5. A backslash escape (`\_`, `\*`, `\[`): the punctuation reads as itself. `\:` is in the set, as in CommonMark, so
 *     a writer can spell a literal `https:` or a line starting `:::`.
 */
function inlineSource(options: GrammarOptions): string {
  return [
    '(?<fence>`+)(?<code>[^]*?)\\k<fence>',
    ...(options.plugins ?? []).map((plugin, index) => `(?<atom${index}>${plugin.pattern})`),
    '\\[\\[(?<target>[^\\[\\]\\n|]+?)(?:\\|(?<label>[^\\[\\]\\n]+?))?\\]\\]',
    '\\[(?<linkText>(?:\\\\[\\\\`*_{}\\[\\]()<>#+\\-.!|~:]|[^\\]\\\\\\n])+)\\]\\((?<href>https:\\/\\/[^\\s)]+)\\)',
    '(?<auto>https:\\/\\/)',
    '(?<run>\\*+|_+)',
    '\\\\(?<escaped>[\\\\`*_{}\\[\\]()<>#+\\-.!|~:])',
  ].join('|');
}

/** The same set the escape branch reads as itself: unescaped inside a link label, which renders as plain text. */
const ESCAPED_PUNCTUATION = /\\([\\`*_{}[\]()<>#+\-.!|~:])/g;

const SPACE = /^\s$/u;
const PUNCTUATION = /^[\p{P}\p{S}]$/u;

/** The character before a position, whole when it is a surrogate pair; empty at the start of the text. */
export function charBefore(text: string, index: number): string {
  if (index <= 0) return '';
  const pair = index >= 2 ? text.codePointAt(index - 2) : undefined;
  return pair !== undefined && pair > 0xffff ? text.slice(index - 2, index) : text[index - 1];
}

/** The character at a position, whole when it is a surrogate pair; empty at the end of the text. */
export function charAt(text: string, index: number): string {
  const point = text.codePointAt(index);
  return point === undefined ? '' : String.fromCodePoint(point);
}

export const isSpaceChar = (char: string): boolean => char === '' || SPACE.test(char);
export const isPunctuationChar = (char: string): boolean => PUNCTUATION.test(char);

function leftFlanking(before: string, after: string): boolean {
  return !isSpaceChar(after) && (!isPunctuationChar(after) || isSpaceChar(before) || isPunctuationChar(before));
}

function rightFlanking(before: string, after: string): boolean {
  return !isSpaceChar(before) && (!isPunctuationChar(before) || isSpaceChar(after) || isPunctuationChar(after));
}

/**
 * CommonMark's flanking rules: whether a run of `*` or `_` between these two characters can open emphasis. The edge of
 * the text counts as whitespace. So a run with a space after it is a literal character, and `_` does not open inside a word.
 */
export function canOpenEmphasis(marker: string, before: string, after: string): boolean {
  return leftFlanking(before, after) && (marker === '*' || !rightFlanking(before, after) || isPunctuationChar(before));
}

/** The same for closing: a run with a space before it is a literal character, and `_` does not close inside a word. */
export function canCloseEmphasis(marker: string, before: string, after: string): boolean {
  return rightFlanking(before, after) && (marker === '*' || !leftFlanking(before, after) || isPunctuationChar(after));
}

type EmphasisKind = 'strong' | 'emphasis';

/** One run of `*` or `_` while a line is scanned: how much of it is unpaired, and the spans it has opened and closed. */
interface MarkerRun {
  kind: 'run';
  marker: string;
  size: number;
  left: number;
  index: number;
  canOpen: boolean;
  canClose: boolean;
  opens: EmphasisKind[];
  closes: EmphasisKind[];
}

/** How many runs may wait to be closed at once, which keeps the pairing linear. */
const MAX_OPEN_RUNS = 32;

/**
 * How deep emphasis nests, so a pathological body cannot overflow the stack of whatever walks the tree. One run can open
 * a span per pair of its markers, so the runs waiting do not bound this: `buildTree` does, and the markers of a span past
 * the cap read as the literal characters they are.
 */
const MAX_EMPHASIS_DEPTH = 32;

/** CommonMark's rule of three: a run that can both open and close does not pair where the two sizes add to a multiple of 3. */
function ruleOfThree(opener: MarkerRun, closer: MarkerRun): boolean {
  return (opener.canClose || closer.canOpen) && (opener.size + closer.size) % 3 === 0 && (opener.size % 3 !== 0 || closer.size % 3 !== 0);
}

/**
 * Pair a run with the runs waiting on its marker, nearest first. What waited between the two can no longer pair, so a
 * crossing (`*a _b* c_`) leaves the inner marker literal.
 */
function pairRun(run: MarkerRun, waiting: Record<string, MarkerRun[]>): void {
  const stack = waiting[run.marker];
  if (run.canClose) {
    let at = stack.length - 1;
    while (run.left > 0 && at >= 0) {
      const opener = stack[at];
      if (ruleOfThree(opener, run)) {
        at -= 1;
        continue;
      }
      const used = opener.left >= 2 && run.left >= 2 ? 2 : 1;
      const kind: EmphasisKind = used === 2 ? 'strong' : 'emphasis';
      opener.opens.push(kind);
      run.closes.push(kind);
      opener.left -= used;
      run.left -= used;
      stack.length = opener.left > 0 ? at + 1 : at;
      for (const other of Object.values(waiting)) {
        while (other.length > 0 && other[other.length - 1].index > opener.index) other.pop();
      }
      at = stack.length - 1;
    }
  }
  const open = Object.values(waiting).reduce((sum, list) => sum + list.length, 0);
  if (run.canOpen && run.left > 0 && open < MAX_OPEN_RUNS) stack.push(run);
}

/** Whether a run has a waiting opener to pair with, which is what makes it a closing marker. */
function closesAny(run: MarkerRun, waiting: Record<string, MarkerRun[]>): boolean {
  return run.canClose && waiting[run.marker].some((opener) => !ruleOfThree(opener, run));
}

const URL_TRAILING_PUNCTUATION = '.,;:!?';

/**
 * Where the bare URL starting at `start` ends. A URL may hold `*` and `_`, but a run that would close a span waiting
 * around the URL closes it (`**https://a.b**`), so the URL stops there, and a run that closes nothing stays in it. An
 * escaped marker, or one between backticks, is no closing marker. The walk goes no further than where it stops, so a line
 * of such URLs stays linear. Trailing punctuation is the sentence's.
 * The end is right after the scheme when no URL is left.
 */
function bareUrlEnd(text: string, start: number, closes: (run: string, at: number) => boolean): number {
  const part = /\\[*_]?|`[^\s<>()[\]'"`]*`|`|\*+|_+|[^\s<>()[\]'"*_\\`]+/y;
  const scheme = start + AUTOLINK_SCHEME.length;
  part.lastIndex = scheme;
  let end = scheme;
  for (let match = part.exec(text); match !== null; match = part.exec(text)) {
    if ((match[0][0] === '*' || match[0][0] === '_') && closes(match[0], match.index)) break;
    end = match.index + match[0].length;
  }
  while (end > scheme && URL_TRAILING_PUNCTUATION.includes(text[end - 1])) end -= 1;
  return end;
}

/**
 * One inline run as a token tree. The scanner reads its tokens in one pass and pairs the `*` and `_` runs as it meets
 * them, the way CommonMark's delimiter stack does; a run that never pairs reads as the literal characters it is.
 *
 * Emphasis does not run across a line: an unpaired `*` in a multi-line note would otherwise swallow everything to the
 * next one, several lines away, and italicize a paragraph nobody marked up.
 *
 * The matcher is built PER CALL rather than hoisted to a module constant: a `g` regex carries `lastIndex` on the object
 * itself, so a shared instance is one re-entrant call away from rewinding another scan's cursor.
 */
export function parseInline(text: string, options: GrammarOptions = {}): Inline[] {
  const plugins = options.plugins ?? [];
  plugins.forEach(tokenMatcher);
  const pattern = new RegExp(inlineSource(options), 'g');
  const items: Array<Inline | MarkerRun> = [];
  const waiting: Record<string, MarkerRun[]> = { '*': [], _: [] };
  let cursor = 0;

  // A token or a stretch of text that holds a line break ends every span still waiting to close.
  const pushItem = (item: Inline, source: string): void => {
    items.push(item);
    if (source.includes('\n')) for (const list of Object.values(waiting)) list.length = 0;
  };
  const pushText = (value: string): void => {
    if (value !== '') pushItem({ kind: 'text', text: value }, value);
  };
  const markerRun = (run: string, at: number): MarkerRun => {
    const before = charBefore(text, at);
    const after = charAt(text, at + run.length);
    return {
      kind: 'run',
      marker: run[0],
      size: run.length,
      left: run.length,
      index: items.length,
      canOpen: canOpenEmphasis(run[0], before, after),
      canClose: canCloseEmphasis(run[0], before, after),
      opens: [],
      closes: [],
    };
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
      pushItem({ kind: 'code', text: stripCodePadding(groups.code) }, match[0]);
    } else if (atomIndex >= 0) {
      const attrs = plugins[atomIndex].read(match[0]);
      if (attrs === null) pushText(match[0]);
      else pushItem({ kind: 'atom', type: plugins[atomIndex].type, attrs, text: match[0] }, match[0]);
    } else if (groups.target !== undefined) {
      const target = groups.target.trim();
      const label = groups.label?.trim();
      // A link whose target is blank (`[[ ]]`) names nothing: it reads as typed.
      if (target === '') pushText(match[0]);
      else pushItem({ kind: 'pageLink', target, ...(label ? { label } : {}) }, match[0]);
    } else if (groups.linkText !== undefined && groups.href !== undefined) {
      pushItem({ kind: 'link', href: groups.href, text: groups.linkText.replace(ESCAPED_PUNCTUATION, '$1') }, match[0]);
    } else if (groups.auto !== undefined) {
      cursor = bareUrlEnd(text, match.index, (run, at) => closesAny(markerRun(run, at), waiting));
      pattern.lastIndex = cursor;
      const url = text.slice(match.index, cursor);
      if (url === AUTOLINK_SCHEME) pushText(url);
      else pushItem({ kind: 'link', href: url, text: url }, url);
    } else if (groups.run !== undefined) {
      const run = markerRun(groups.run, match.index);
      pairRun(run, waiting);
      items.push(run);
    } else if (groups.escaped !== undefined) {
      pushText(groups.escaped);
    }
  }

  pushText(text.slice(cursor));
  return buildTree(items);
}

/**
 * The scanned items as a tree: each run closes its spans, leaves what never paired as text, then opens its spans. A run
 * opens its outermost span first, with the markers nearest its content paired first. A span past `MAX_EMPHASIS_DEPTH`
 * is not one: its markers read as text, where they stand.
 */
function buildTree(items: ReadonlyArray<Inline | MarkerRun>): Inline[] {
  const frames: Inline[][] = [[]];
  // One entry per span open at this point, innermost last: whether it holds a frame, or is past the cap and literal.
  const open: boolean[] = [];
  const push = (node: Inline): void => {
    const top = frames[frames.length - 1];
    const last = top[top.length - 1];
    // Coalesce, so a body that produced no markup at all is ONE text node rather than a run of
    // adjacent ones — which keeps the rendered DOM (and every test's `textContent`) simple.
    if (node.kind === 'text' && last?.kind === 'text') last.text += node.text;
    else top.push(node);
  };
  for (const item of items) {
    if (item.kind !== 'run') {
      push(item);
      continue;
    }
    const literal = (kind: EmphasisKind): void => push({ kind: 'text', text: item.marker.repeat(kind === 'strong' ? 2 : 1) });
    for (const kind of item.closes) {
      if (open.pop()) push({ kind, children: frames.pop() ?? [] });
      else literal(kind);
    }
    if (item.left > 0) push({ kind: 'text', text: item.marker.repeat(item.left) });
    for (const kind of [...item.opens].reverse()) {
      const held = frames.length <= MAX_EMPHASIS_DEPTH;
      open.push(held);
      if (held) frames.push([]);
      else literal(kind);
    }
  }
  return frames[0];
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
