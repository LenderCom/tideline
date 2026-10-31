import { describe, expect, it } from 'vitest';
import { matchLines, mergeMarkdown, type MarkdownMerge, type MarkdownMergeHunk } from '../src/merge.js';

const base = ['# Plan', '', 'Intro.', '', '- one', '- two', '', 'Outro.'].join('\n');

function conflicted(merge: MarkdownMerge): { hunks: MarkdownMergeHunk[]; mergedBody: string } {
  if (merge.clean) throw new Error(`expected a conflict, merged clean: ${JSON.stringify(merge.body)}`);
  expect(merge.conflicts).toBe(merge.hunks.length);
  return merge;
}

describe('mergeMarkdown', () => {
  it('keeps both edits when they touch different lines', () => {
    const mine = base.replace('Intro.', 'Intro, revised.');
    const theirs = base.replace('Outro.', 'Outro, revised.');
    expect(mergeMarkdown(base, mine, theirs)).toEqual({ clean: true, body: base.replace('Intro.', 'Intro, revised.').replace('Outro.', 'Outro, revised.') });
  });

  it('takes the only side that changed, and either side when both made the same change', () => {
    const edited = base.replace('- two', '- two\n- three');
    expect(mergeMarkdown(base, base, edited)).toEqual({ clean: true, body: edited });
    expect(mergeMarkdown(base, edited, base)).toEqual({ clean: true, body: edited });
    expect(mergeMarkdown(base, edited, edited)).toEqual({ clean: true, body: edited });
  });

  it('reports a conflict as a hunk with each side and the line it starts on', () => {
    const { hunks, mergedBody } = conflicted(mergeMarkdown(base, base.replace('Intro.', 'Mine.'), base.replace('Intro.', 'Theirs.')));
    expect(hunks).toEqual([
      {
        currentLine: 3,
        mergedLine: 3,
        base: 'Intro.',
        proposed: 'Mine.',
        current: 'Theirs.',
        baseLines: ['Intro.'],
        proposedLines: ['Mine.'],
        currentLines: ['Theirs.'],
      },
    ]);
    expect(mergedBody).toBe(base.replace('Intro.', 'Theirs.'));
  });
});

// Conflict shapes, case by case: a merge must split them the same way every time.
describe('mergeMarkdown, conflict shapes', () => {
  const deploy = '# Deploy\n\nRun the canary.\n\nThen promote.\n';

  it('merges edits to different lines', () => {
    expect(
      mergeMarkdown(deploy, '# Deploy\n\nRun the canary for ten minutes.\n\nThen promote.\n', '# Deploy\n\nRun the canary.\n\nThen promote to all regions.\n'),
    ).toEqual({ clean: true, body: '# Deploy\n\nRun the canary for ten minutes.\n\nThen promote to all regions.\n' });
  });

  it('merges insertions at either end and a deletion', () => {
    expect(mergeMarkdown('a\nb\nc\nd', 'intro\na\nb\nc\nd', 'a\nc\nd\noutro')).toEqual({ clean: true, body: 'intro\na\nc\nd\noutro' });
  });

  it('conflicts where both sides inserted different lines at one spot', () => {
    const [hunk] = conflicted(mergeMarkdown('a\nb', 'a\nmine\nb', 'a\ntheirs\nb')).hunks;
    expect(hunk).toMatchObject({ base: '', proposed: 'mine', current: 'theirs', currentLine: 2, baseLines: [] });
  });

  it('narrows a conflict to the lines the two sides still disagree on', () => {
    // Both added table rows at one spot. The rows they agree on merge; each row they
    // wrote differently is its own small conflict.
    const page =
      "| Scope | Claim |\n| `tests:read` | read |\n| `tests:write` | page's |\n| `customers:read` | same |\n| `customers:write` | page's |\n\n## Decision";
    const { hunks, mergedBody } = conflicted(
      mergeMarkdown(
        '| Scope | Claim |\n| `tests:read` | read |\n\n## Decision',
        "| Scope | Claim |\n| `tests:read` | read |\n| `tests:write` | run's |\n| `customers:read` | same |\n| `customers:write` | run's |\n\n## Decision",
        page,
      ),
    );
    expect(hunks).toHaveLength(2);
    expect(hunks[0]).toMatchObject({ proposedLines: ["| `tests:write` | run's |"], currentLines: ["| `tests:write` | page's |"], baseLines: [], currentLine: 3 });
    expect(hunks[1]).toMatchObject({ proposedLines: ["| `customers:write` | run's |"], currentLine: 5, mergedLine: 5 });
    expect(mergedBody).toBe(page);
  });

  it('where both only added text, takes the other side over a side that added only a blank line', () => {
    expect(mergeMarkdown('intro\nend', 'intro\n\nend', 'intro\n\nA GitHub Actions trust carries only `tests:write`.\nend')).toEqual({
      clean: true,
      body: 'intro\n\nA GitHub Actions trust carries only `tests:write`.\nend',
    });
  });

  it('where both only added text, keeps a line one side added', () => {
    expect(mergeMarkdown('a\nz', 'a\nshared\nrun only\nz', 'a\nshared\nz')).toEqual({ clean: true, body: 'a\nshared\nrun only\nz' });
  });

  it('conflicts on a line both added at different places rather than writing it twice', () => {
    const { hunks, mergedBody } = conflicted(mergeMarkdown('a\nz', 'a\nX\nA\nB\nz', 'a\nA\nB\nX\nz'));
    expect(hunks.map((hunk) => [hunk.proposedLines, hunk.currentLines])).toEqual([
      [['X'], []],
      [[], ['X']],
    ]);
    expect(mergedBody).toBe('a\nA\nB\nX\nz');
  });

  it('takes theirs where the sides differ only in blank lines and trailing spaces', () => {
    expect(mergeMarkdown('a\nold\nz', 'a\nnew  \n\nz', 'a\nnew\nz')).toEqual({ clean: true, body: 'a\nnew\nz' });
  });

  it('never splits a conflict on a blank line alone', () => {
    const { hunks } = conflicted(mergeMarkdown('a\nold\nz', 'a\nmine one\n\nmine two\nz', 'a\ntheirs one\n\ntheirs two\nz'));
    expect(hunks).toHaveLength(1);
    expect(hunks[0]).toMatchObject({ proposedLines: ['mine one', '', 'mine two'], currentLines: ['theirs one', '', 'theirs two'], baseLines: ['old'] });
  });

  it('still conflicts on a line only one side holds where the base held text', () => {
    const { hunks, mergedBody } = conflicted(mergeMarkdown('a\nold\nz', 'a\nnew\nextra\nz', 'a\nnew\nz'));
    expect(hunks).toEqual([expect.objectContaining({ proposedLines: ['extra'], currentLines: [], currentLine: 3, mergedLine: 3 })]);
    expect(mergedBody).toBe('a\nnew\nz');
  });

  it('tells a side that is one blank line from a side with no lines', () => {
    const [hunk] = conflicted(mergeMarkdown('a\nold\nz', 'a\n\nz', 'a\nnew\nz')).hunks;
    expect(hunk).toMatchObject({ proposed: '', proposedLines: [''], currentLines: ['new'] });
  });

  it('keeps what merged cleanly elsewhere in the merge with conflicts', () => {
    const { hunks, mergedBody } = conflicted(mergeMarkdown('t\na\nb\nc', 'T\na\nmine\nc', 't\na\ntheirs\nc'));
    expect(mergedBody).toBe('T\na\ntheirs\nc');
    expect(hunks).toEqual([expect.objectContaining({ mergedLine: 3, currentLine: 3 })]);
  });

  it.each([
    ['one\ntwo\n', 'one\ntwo\n', 'one\n2\n', 'one\n2\n'],
    ['one\ntwo\n', 'one\n2\n', 'one\ntwo\n', 'one\n2\n'],
    ['', 'new page body', '', 'new page body'],
  ])('takes the other side when one is unchanged (%#)', (from, mine, theirs, body) => {
    expect(mergeMarkdown(from, mine, theirs)).toEqual({ clean: true, body });
  });

  it('still lines up repeated lines', () => {
    expect(mergeMarkdown('x\n---\ny\n---\nz', 'x\n---\ny2\n---\nz', 'x\n---\ny\n---\nz2')).toEqual({ clean: true, body: 'x\n---\ny2\n---\nz2' });
  });

  it('finishes on two long unrelated bodies, and conflicts rather than hangs', () => {
    const lines = (word: string) => Array.from({ length: 6000 }, (_, i) => `${word} ${i}`).join('\n');
    expect(mergeMarkdown(lines('base'), lines('mine'), lines('theirs')).clean).toBe(false);
  });
});

describe('matchLines', () => {
  it('pairs a longest common subsequence in order', () => {
    const map = matchLines(['a', 'b', 'c', 'a', 'b', 'b', 'a'], ['c', 'b', 'a', 'b', 'a', 'c']);
    const pairs = map.flatMap((to, from) => (to >= 0 ? [[from, to] as const] : []));
    expect(pairs).toHaveLength(4);
    expect(pairs.every(([, to], index) => index === 0 || to > pairs[index - 1][1])).toBe(true);
  });
});
