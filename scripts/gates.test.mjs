import { describe, expect, it } from 'bun:test';
import { alternatives, judge, judgeId, violations } from './license-gate.mjs';
import { allowlistProblems, binaryStrings, hash, lineHits, scan } from './reference-gate.mjs';

describe('the licence gate', () => {
  it('passes the licences it names, in any case, and judges a WITH exception by its base id', () => {
    expect(judge('MIT')).toBe('ok');
    expect(judge('mit')).toBe('ok');
    expect(judge('Apache-2.0')).toBe('ok');
    expect(judge('Apache-2.0 WITH LLVM-exception')).toBe('ok');
    expect(judge('apache-2.0 with LLVM-exception')).toBe('ok');
    expect(judgeId('BSD-3-Clause')).toBe('ok');
  });

  it('denies a garbled expression that names a denied licence, so no clarification can vouch it through', () => {
    for (const garbled of ['GPL-3.0 OR', '(GPL-3.0', 'GPL-3.0)', 'AGPL-3.0 AND AND MIT', '(MIT OR SSPL-1.0']) expect(judge(garbled)).toBe('denied');
    // Multi-word denied names stay whole in the fallback.
    for (const garbled of ['(Business Source License 1.1', '(Apache-2.0 AND Commons Clause', '(MIT OR Commons Clause', 'Business Source License 1.1 OR'])
      expect(judge(garbled)).toBe('denied');
    expect(violations([{ name: 'z', version: '1', license: '(Business Source License 1.1' }], [{ package: 'z', license: 'MIT', reason: 'trust me' }], [])).toHaveLength(1);
    expect(violations([{ name: 'x', version: '1', license: 'GPL-3.0 OR' }], [{ package: 'x', license: 'MIT', reason: 'trust me' }], [])).toHaveLength(1);
    // Garbled but naming nothing denied: unnamed, and a clarification may vouch for it.
    expect(judge('(MIT OR')).toBe('unnamed');
    expect(violations([{ name: 'y', version: '1', license: '(MIT OR' }], [{ package: 'y', license: 'MIT', reason: 'MIT in its LICENSE file' }], [])).toHaveLength(0);
  });

  it('calls a licence it cannot name unnamed, however harmless it sounds', () => {
    expect(judge('BSD')).toBe('unnamed');
    expect(judge('Apache')).toBe('unnamed');
    expect(judge('MIT-ish')).toBe('unnamed');
    expect(judge('')).toBe('unnamed');
    expect(judge(undefined)).toBe('unnamed');
    expect(judge('UNKNOWN')).toBe('unnamed');
    expect(judge('UNLICENSED')).toBe('unnamed');
    expect(judge('SEE LICENSE IN LICENSE.md')).toBe('unnamed');
    expect(judge('LicenseRef-Proprietary')).toBe('unnamed');
    expect(judge('Custom: https://example.com/licence')).toBe('unnamed');
  });

  it('denies the families we may not depend on, a WITH exception included', () => {
    expect(judge('GPL-3.0')).toBe('denied');
    expect(judge('AGPL-3.0-only')).toBe('denied');
    expect(judge('LGPL-2.1-or-later')).toBe('denied');
    expect(judge('GPL-2.0 WITH Classpath-exception-2.0')).toBe('denied');
    expect(judge('SSPL-1.0')).toBe('denied');
    expect(judge('BUSL-1.1')).toBe('denied');
    expect(judge('CC-BY-NC-4.0')).toBe('denied');
    expect(judge('CC-BY-ND-4.0')).toBe('denied');
    expect(judge('Elastic-2.0')).toBe('denied');
    // A denied family written as the exception is denied too, and no clarification can vouch it through.
    for (const id of ['Apache-2.0 WITH Commons-Clause', 'Apache-2.0 WITH Commons Clause', 'MIT with commons-clause', '(Apache-2.0 WITH Commons-Clause) OR GPL-3.0'])
      expect(judge(id)).toBe('denied');
    expect(judge('MIT OR Apache-2.0 WITH Commons-Clause')).toBe('ok');
    for (const garbled of ['(Apache-2.0 WITH Commons Clause', 'Apache-2.0 WITH Commons-Clause)', '(MIT WITH Commons Clause OR'])
      expect(judge(garbled)).toBe('denied');
    expect(violations([{ name: 'w', version: '1', license: '(Apache-2.0 WITH Commons Clause' }], [{ package: 'w', license: 'Apache-2.0', reason: 'trust me' }], [])).toHaveLength(1);
  });

  it('takes one acceptable alternative of an OR, but every id of an AND', () => {
    expect(alternatives('(MIT OR Apache-2.0)')).toEqual([['MIT'], ['Apache-2.0']]);
    expect(alternatives('MIT AND BSD-3-Clause')).toEqual([['MIT', 'BSD-3-Clause']]);
    expect(judge('MIT OR GPL-3.0')).toBe('ok');
    expect(judge('(GPL-3.0 OR MIT)')).toBe('ok');
    expect(judge('MIT AND GPL-3.0')).toBe('denied');
    expect(judge('GPL-3.0 OR AGPL-3.0')).toBe('denied');
    expect(judge('GPL-3.0 OR BSD')).toBe('unnamed');
    expect(judge('MIT AND BSD')).toBe('unnamed');
  });

  it('groups parentheses first and binds AND tighter than OR, so a required id is never dropped', () => {
    expect(alternatives('GPL-3.0 AND (MIT OR BSD-3-Clause)')).toEqual([
      ['GPL-3.0', 'MIT'],
      ['GPL-3.0', 'BSD-3-Clause'],
    ]);
    expect(alternatives('(MIT OR Apache-2.0) AND Unicode-DFS-2016')).toEqual([
      ['MIT', 'Unicode-DFS-2016'],
      ['Apache-2.0', 'Unicode-DFS-2016'],
    ]);
    expect(alternatives('MIT OR Apache-2.0 AND GPL-3.0')).toEqual([['MIT'], ['Apache-2.0', 'GPL-3.0']]);
    expect(alternatives('(Apache-2.0 WITH LLVM-exception) or MIT')).toEqual([['Apache-2.0 WITH LLVM-exception'], ['MIT']]);
    expect(judge('GPL-3.0 AND (MIT OR BSD-3-Clause)')).toBe('denied');
    expect(judge('(MIT OR Apache-2.0) AND Unicode-DFS-2016')).toBe('unnamed');
    expect(judge('(MIT OR GPL-3.0) AND (Apache-2.0 OR GPL-3.0)')).toBe('ok');
    expect(judge('((MIT))')).toBe('ok');
    expect(judge('MIT License')).toBe('unnamed');
  });

  it('calls a malformed expression unnamed rather than guessing at it', () => {
    expect(() => alternatives('(MIT OR Apache-2.0')).toThrow('missing )');
    expect(judge('(MIT OR Apache-2.0')).toBe('unnamed');
    expect(judge('MIT OR')).toBe('unnamed');
    expect(judge('MIT AND AND ISC')).toBe('unnamed');
    expect(judge('MIT) OR (ISC')).toBe('unnamed');
    expect(judge('()')).toBe('unnamed');
  });

  it('lets a person vouch for an unnamed licence, never for a denied one, and skips our own package', () => {
    const inventory = [
      { name: 'a', version: '1.0.0', license: 'MIT' },
      { name: 'b', version: '1.0.0', license: 'BSD' },
      { name: 'c', version: '1.0.0', license: 'GPL-3.0' },
      { name: 'd', version: '1.0.0', license: undefined },
      { name: 'self', version: '0.1.0', license: 'UNLICENSED' },
    ];
    const clarifications = [
      { package: 'b', license: 'BSD-2-Clause', reason: 'the LICENSE file is the two-clause text' },
      { package: 'c', license: 'MIT', reason: 'a vouch cannot clear a denied licence' },
      { package: 'd', license: 'MIT' },
    ];
    const out = violations(inventory, clarifications, ['self']);
    expect(out).toHaveLength(2);
    expect(out[0]).toStartWith('c@1.0.0: licence GPL-3.0 may not be depended on');
    expect(out[1]).toStartWith('d@1.0.0: licence "none found" is unnamed');
  });
});

describe('the reference gate', () => {
  // Made-up terms, so this file publishes none of the real ones. The gate's own list works the same way.
  const words = new Map([
    [hash('gloaming'), 'word'],
    [hash('night heron'), 'pair'],
    [hash('dawn-chorus'), 'dashed'],
  ]);

  it('hits a word, a pair of words and a dashed name, in any case', () => {
    expect(lineHits('the Gloaming falls', words)).toEqual(['word']);
    expect(lineHits('a NIGHT HERON calls', words)).toEqual(['pair']);
    expect(lineHits('clone dawn-chorus first', words)).toEqual(['dashed']);
    expect(lineHits('github.com/example/Dawn-Chorus.git', words)).toEqual(['dashed']);
  });

  it('finds a dashed name inside a longer dashed run, but not as two English words', () => {
    expect(lineHits('the early-dawn-chorus-mirror job', words)).toEqual(['dashed']);
    expect(lineHits('dawn-chorus-2', words)).toEqual(['dashed']);
    expect(lineHits('we heard the dawn chorus', words)).toEqual([]);
    expect(lineHits('dawn-choruses', words)).toEqual([]);
    expect(lineHits('nothing to see here', words)).toEqual([]);
  });

  it('reads the printable runs of six or more characters out of a binary file', () => {
    const buf = Buffer.concat([
      Buffer.from([0, 1, 2]),
      Buffer.from('repo=dawn-chorus'),
      Buffer.from([0, 0xff]),
      Buffer.from('short'),
      Buffer.from([0]),
      Buffer.from('a night heron'),
      Buffer.from([0x7f]),
    ]);
    expect(binaryStrings(buf)).toBe('repo=dawn-chorus\na night heron');
    expect(binaryStrings(Buffer.from([0, 1, 2]))).toBe('');
    const { hits } = scan({ 'logo.png': binaryStrings(buf) }, [], words);
    expect(hits).toEqual([
      { path: 'logo.png', line: 1, term: 'dashed' },
      { path: 'logo.png', line: 2, term: 'pair' },
    ]);
  });

  it('lets a reasoned allow-list entry cover a hit, and fails an entry that covers nothing', () => {
    const files = { 'docs/a.md': 'the gloaming\n', 'b.md': 'fine\n' };
    expect(scan(files, [], words).hits).toEqual([{ path: 'docs/a.md', line: 1, term: 'word' }]);
    const covered = scan(files, [{ path: 'docs/', reason: 'quoted on purpose' }], words);
    expect(covered.hits).toEqual([]);
    expect(covered.problems).toEqual([]);
    const stale = scan(files, [{ path: 'docs/', reason: 'quoted' }, { path: 'b.md', reason: 'stale' }], words);
    expect(stale.problems).toEqual(['allow-list entry 1 (b.md) covers nothing; remove it']);
  });

  it('refuses an allow-list entry without a reason or with an unknown term', () => {
    expect(allowlistProblems({})).toEqual(['the allow-list must be a JSON array of { path, term?, reason }']);
    expect(allowlistProblems([{ path: 'a.md', reason: ' ' }])).toEqual(['allow-list entry 0 has no reason']);
    expect(allowlistProblems([{ path: 'a.md', term: 'nope', reason: 'r' }])).toEqual(['allow-list entry 0 names an unknown term "nope"']);
  });
});
