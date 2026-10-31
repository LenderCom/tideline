/**
 * One region `mine` and `theirs` changed differently, narrowed to the lines they still disagree on. `proposed` is
 * `mine`, `current` is `theirs`. Each side is its lines, and
 * also those lines joined with newlines; only the lists tell a side with no lines from a side that is one blank line.
 * `currentLine` is the 1-based line in `theirs` where the region starts; `mergedLine` is where it starts in the
 * merge's `mergedBody`, which holds `theirs`' lines there.
 */
export interface MarkdownMergeHunk {
  currentLine: number;
  mergedLine: number;
  base: string;
  proposed: string;
  current: string;
  baseLines: string[];
  proposedLines: string[];
  currentLines: string[];
}

/**
 * A 3-way merge of a page's markdown: `clean` with the merged body, or every place both sides changed differently.
 * On a conflict, `conflicts` counts the `hunks`, and `mergedBody` is everything that merged with `theirs`' lines left
 * in each hunk, so a person resolving it keeps what merged cleanly.
 */
export type MarkdownMerge = { clean: true; body: string } | { clean: false; conflicts: number; hunks: MarkdownMergeHunk[]; mergedBody: string };

/**
 * How many edits the line diff explores before it stops looking for matches inside the changed middle. Past it the
 * middle counts as wholly rewritten: the merge stays correct but coarser, which bounds the cost on two unrelated
 * 512 KB bodies.
 */
const MAX_EDIT_DISTANCE = 1000;

/**
 * Merge two edits of one page: `base` is the revision the editor opened, `mine` is the edit being
 * saved, `theirs` is what the page became meanwhile. Markdown is lines of text, so the merge is line by line, like git's: edits
 * to different lines both survive; the same line changed the same way is no conflict; the same line changed two ways
 * is one, which the editor puts to the person rather than guessing.
 *
 * Both sides are diffed against the base, and a region only one side changed
 * takes that side. A region both changed differently is narrowed: the two sides are diffed against each other, the
 * lines they agree on merge, and only the runs between them that still differ are conflicts. Lines are split on `\n`
 * and joined back with it, so a body's trailing newline (or its absence) survives.
 */
export function mergeMarkdown(base: string, mine: string, theirs: string): MarkdownMerge {
  if (mine === theirs || base === theirs) return { clean: true, body: mine };
  if (base === mine) return { clean: true, body: theirs };

  const o = base.split('\n');
  const a = mine.split('\n');
  const b = theirs.split('\n');
  const oToA = matchLines(o, a);
  const oToB = matchLines(o, b);

  const merged: string[] = [];
  const hunks: MarkdownMergeHunk[] = [];
  let lo = 0;
  let la = 0;
  let lb = 0;
  while (lo < o.length || la < a.length || lb < b.length) {
    // The stable run: lines all three agree on, in step.
    let run = 0;
    while (lo + run < o.length && oToA[lo + run] === la + run && oToB[lo + run] === lb + run) run++;
    if (run > 0) {
      append(merged, o, lo, lo + run);
      lo += run;
      la += run;
      lb += run;
      continue;
    }

    // The unstable region runs to the next base line both sides still hold (or to the end of all three).
    let no = lo;
    while (no < o.length && (oToA[no] < 0 || oToB[no] < 0)) no++;
    const na = no < o.length ? oToA[no] : a.length;
    const nb = no < o.length ? oToB[no] : b.length;

    mergeRegion(o.slice(lo, no), a.slice(la, na), b.slice(lb, nb), lb, merged, hunks);

    lo = no;
    la = na;
    lb = nb;
  }

  return hunks.length === 0
    ? { clean: true, body: merged.join('\n') }
    : { clean: false, conflicts: hunks.length, hunks, mergedBody: merged.join('\n') };
}

/**
 * One unstable region: whichever side changed it, else both sides narrowed against each other. A conflict leaves
 * `theirs`' lines in `merged`, so the merge with conflicts reads as the page there.
 */
function mergeRegion(baseChunk: string[], proposed: string[], current: string[], currentStart: number, merged: string[], hunks: MarkdownMergeHunk[]): void {
  if (sameLines(proposed, baseChunk)) {
    append(merged, current);
    return;
  }
  if (sameLines(current, baseChunk) || sameLines(proposed, current)) {
    append(merged, proposed);
    return;
  }

  // Narrow: the lines both sides hold split the region, so only what still differs between them conflicts. A blank
  // line never splits it on its own; it would line up unrelated paragraphs.
  const map = matchLines(proposed, current);
  const anchors = new Set<number>();
  proposed.forEach((line, index) => {
    if (map[index] >= 0 && !isBlank(line)) anchors.add(index);
  });
  const anchoredInCurrent = new Set([...anchors].map((index) => map[index]));
  const looseProposed = loose(proposed, anchors);
  const looseCurrent = loose(current, anchoredInCurrent);
  let pi = 0;
  let ci = 0;
  for (let i = 0; i <= proposed.length; i++) {
    if (i < proposed.length && !anchors.has(i)) continue;
    const j = i < proposed.length ? map[i] : current.length;
    mergeGap(baseChunk, proposed.slice(pi, i), current.slice(ci, j), currentStart + ci, looseProposed, looseCurrent, merged, hunks);
    if (i === proposed.length) break;
    merged.push(current[j]);
    pi = i + 1;
    ci = j + 1;
  }
}

/**
 * What is left between two lines both sides agree on. Sides that differ only in blank lines or trailing whitespace
 * take `theirs`. Where the base held nothing, both sides only added text, so a side that added nothing (or only blank
 * lines) takes the other's — unless the other side's lines also sit in a gap elsewhere in the region on this side:
 * both added them, at different places, and taking each place's would write them twice. Anything else is a conflict.
 */
function mergeGap(
  baseChunk: string[],
  proposed: string[],
  current: string[],
  currentStart: number,
  looseProposed: Set<string>,
  looseCurrent: Set<string>,
  merged: string[],
  hunks: MarkdownMergeHunk[],
): void {
  if (sameText(proposed, current)) {
    append(merged, current);
    return;
  }
  if (baseChunk.length === 0) {
    if (proposed.every(isBlank) && !alsoLoose(current, looseProposed)) {
      append(merged, current);
      return;
    }
    if (current.every(isBlank) && !alsoLoose(proposed, looseCurrent)) {
      append(merged, proposed);
      return;
    }
  }

  hunks.push({
    currentLine: currentStart + 1,
    mergedLine: merged.length + 1,
    base: baseChunk.join('\n'),
    proposed: proposed.join('\n'),
    current: current.join('\n'),
    baseLines: baseChunk,
    proposedLines: proposed,
    currentLines: current,
  });
  append(merged, current);
}

/** The non-blank lines of a region's side that no anchor holds (trailing whitespace set aside): the lines left in its gaps. */
function loose(side: string[], anchored: Set<number>): Set<string> {
  const lines = new Set<string>();
  side.forEach((line, index) => {
    if (!anchored.has(index) && !isBlank(line)) lines.add(line.trimEnd());
  });
  return lines;
}

function isBlank(line: string): boolean {
  return line.trim().length === 0;
}

/** Whether any non-blank line of `lines` is among the other side's loose lines. */
function alsoLoose(lines: string[], otherLoose: Set<string>): boolean {
  return lines.some((line) => !isBlank(line) && otherLoose.has(line.trimEnd()));
}

function sameLines(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((line, index) => line === b[index]);
}

/** Whether two runs of lines say the same once blank lines and trailing whitespace are set aside. */
function sameText(a: readonly string[], b: readonly string[]): boolean {
  const said = (lines: readonly string[]) => lines.filter((line) => !isBlank(line)).map((line) => line.trimEnd());
  return sameLines(said(a), said(b));
}

/** Push `from[start..end)` onto `to` a line at a time: a spread of a long body would overflow the call stack. */
function append(to: string[], from: readonly string[], start = 0, end = from.length): void {
  for (let i = start; i < end; i++) to.push(from[i]);
}

/**
 * For each line of `from`, the index of the line of `to` it is matched to in a longest common subsequence (Myers), or
 * -1. The matches are increasing on both sides.
 */
export function matchLines(from: readonly string[], to: readonly string[]): number[] {
  const map = new Array<number>(from.length).fill(-1);

  // The common head and tail match outright; only the middle needs the diff.
  let head = 0;
  while (head < from.length && head < to.length && from[head] === to[head]) {
    map[head] = head;
    head++;
  }
  let tail = 0;
  while (tail < from.length - head && tail < to.length - head && from[from.length - 1 - tail] === to[to.length - 1 - tail]) {
    map[from.length - 1 - tail] = to.length - 1 - tail;
    tail++;
  }

  const n = from.length - head - tail;
  const m = to.length - head - tail;
  if (n > 0 && m > 0) for (const [x, y] of myersMatches(from, head, n, to, head, m)) map[head + x] = head + y;
  return map;
}

/**
 * The matched (x, y) pairs of a shortest edit script between `a[aStart..aStart+n)` and `b[bStart..bStart+m)`, by
 * Myers' O((N+M)D) greedy algorithm. When the script is longer than `MAX_EDIT_DISTANCE`, nothing in the range matches.
 */
function myersMatches(a: readonly string[], aStart: number, n: number, b: readonly string[], bStart: number, m: number): [number, number][] {
  const max = Math.min(n + m, MAX_EDIT_DISTANCE);
  const offset = max + 1;
  const v = new Int32Array(2 * max + 3);
  const trace: Int32Array[] = [];

  for (let d = 0; d <= max; d++) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1]) ? v[offset + k + 1] : v[offset + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[aStart + x] === b[bStart + y]) {
        x++;
        y++;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) return backtrack(trace, offset, n, m, d, a, aStart, b, bStart);
    }
  }

  return [];
}

function backtrack(
  trace: Int32Array[],
  offset: number,
  n: number,
  m: number,
  dEnd: number,
  a: readonly string[],
  aStart: number,
  b: readonly string[],
  bStart: number,
): [number, number][] {
  const matches: [number, number][] = [];
  let x = n;
  let y = m;
  for (let d = dEnd; d > 0; d--) {
    const v = trace[d];
    const k = x - y;
    const prevK = k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1]) ? k + 1 : k - 1;
    const prevX = v[offset + prevK];
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      x--;
      y--;
      matches.push([x, y]);
    }
    x = prevX;
    y = prevY;
  }

  // d = 0: the diagonal from the start.
  while (x > 0 && y > 0) {
    x--;
    y--;
    if (a[aStart + x] === b[bStart + y]) matches.push([x, y]);
  }

  matches.reverse();
  return matches;
}
