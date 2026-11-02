#!/usr/bin/env node
/**
 * The reference gate: fails when a tracked file names something this public repository must not, such as an internal
 * product name, an internal host or a private package scope.
 *
 * Two kinds of term:
 *   - WORDS are listed only as hashes (the first 16 hex of the SHA-256 of the lower-cased word, of two words joined
 *     by a space, or of a dashed name such as a repository's), so this file does not publish the words it keeps out.
 *     Every word, pair of words and run of two or more dash-joined parts in a tracked file is hashed and looked up.
 *   - SHAPES are regular expressions that say nothing on their own, with the part that matters held as a hash.
 *   - PATTERNS are plain regular expressions, for what says nothing even in full.
 *
 * Binary files are scanned too, by the printable runs inside them (as `strings` would show them).
 *
 * A hit fails unless an entry in reference-allowlist.json covers it (`{ "path": "…", "term": "<id>", "reason": "…" }`;
 * every entry must give a reason, and an entry that covers nothing fails too, so the list cannot go stale).
 *
 *   node scripts/reference-gate.mjs    # exit 1 with every hit listed as file:line and term
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const SELF = fileURLToPath(import.meta.url);
const ROOT = join(dirname(SELF), '..');

/** Hashed words: id → hash. */
export const DENIED_WORDS = {
  'internal-name-1': '7d9a4bdcf82d365f',
  'internal-name-2': '9d7ab7eb4fa42d59',
  'internal-name-3': 'f54807dccb47fbc8',
  'internal-name-4': 'e98dcad8dd8ada2b',
  'internal-phrase-1': '3fc7f317a816e60a',
  'internal-phrase-2': '01bbac405821b4e3',
  // Internal repository names, dashed: matched only as written with the dash, never as two English words.
  'internal-repo-name-1': '67b91b4a31982aaf',
  'internal-repo-name-2': '05241e505a5fb1c3',
  'internal-repo-name-3': 'bd7e94d0c54f7b32',
  'internal-repo-name-4': 'aec87c164486dc10',
  'internal-repo-name-5': '2ceb159284bc5211',
  'internal-repo-name-6': '28fbad8f1c15b550',
  'internal-repo-name-7': 'f72d6516559fa73c',
  'internal-repo-name-8': '46b5460d6b9d8186',
  'internal-repo-name-9': '83bd9a2c89c8167d',
  'internal-repo-name-10': '9bbe82e948a8699f',
  'internal-repo-name-11': 'ea38e330cfdc5f2f',
  'internal-repo-name-12': 'cf1dcf0e50d6c779',
};

/**
 * Shapes that say nothing on their own, with the part that matters held as a hash: a key prefix, a scope, a host. Group 1
 * of `shape` is hashed (lower-cased when the shape is case-insensitive) and looked up in `hashes`.
 */
export const DENIED_SHAPES = [
  { id: 'ticket-ref', shape: '\\b([A-Z]{2,8})-[0-9A-Z]+\\b', flags: '', hashes: ['ee4873c436138643', '60f2714c08a1188b'], fix: 'drop internal ticket references' },
  { id: 'internal-product', shape: '\\b([A-Z]{2,8})\\b', flags: '', hashes: ['ee4873c436138643'], fix: 'say By Dawn' },
  // Scopes are case-sensitive on purpose: npm scopes are always lower case, while a GitHub team such as the CODEOWNERS
  // entry is written with capitals and is public.
  { id: 'private-scope', shape: '(@[a-z0-9-]+)/', flags: '', hashes: ['6f29fe2e11134f5f', '0af612c3fb238873'], fix: 'use the public @bydawn/ scope' },
  // An `owner/repo-…` path, as owner plus the repo name's first part. The match is a lookahead, so it consumes nothing:
  // it is tried at the start of every run and after every dash in it, which finds the owner behind a dashed prefix
  // (`x-owner/repo-`). Both parts are bounded (GitHub's own limits: 39 for an owner, 100 for a repo), so a very long
  // run costs one bounded look per start, never a rescan to its end.
  { id: 'internal-repo', shape: '(?<![a-z0-9])(?=([a-z0-9][a-z0-9-]{0,38}/[a-z0-9]{1,100})-)', hashes: ['20f08bd128d4edfb'], fix: 'name the public repository, or nothing' },
  { id: 'internal-email', shape: '@([a-z0-9-]+\\.[a-z]+)\\b', hashes: ['8076151cbbdfc2c6'], fix: 'use an example.com address' },
  { id: 'internal-host', shape: '\\.([a-z0-9-]+)\\.net\\b', hashes: ['d0715322452baa1b'], fix: 'use a placeholder host such as app.example.com' },
];

/** Plain patterns: `flags` defaults to case-insensitive. */
export const DENIED_PATTERNS = [
  { id: 'internal-host', pattern: '\\.internal\\b', fix: 'use a placeholder host such as app.example.com' },
];

export function hash(s) {
  return createHash('sha256').update(s).digest('hex').slice(0, 16);
}

/**
 * The longest dashed name looked up, in characters (GitHub's limit for a repository name) and in parts. Every name kept
 * out is far inside both, and they keep a very long dashed run linear rather than one lookup per pair of its parts.
 */
const MAX_DASHED = 100;
const MAX_DASHED_PARTS = 8;

const BY_HASH = new Map(Object.entries(DENIED_WORDS).map(([id, h]) => [h, id]));
const MATCHERS = DENIED_PATTERNS.map((p) => ({ ...p, re: new RegExp(p.pattern, p.flags ?? 'i') }));
const SHAPES = DENIED_SHAPES.map((s) => ({ ...s, fold: (s.flags ?? 'i') === 'i', re: new RegExp(s.shape, `${s.flags ?? 'i'}g`), held: new Set(s.hashes) }));

/** The term ids one line hits. `byHash` (hash → id) defaults to DENIED_WORDS; the tests pass their own. */
export function lineHits(line, byHash = BY_HASH) {
  const ids = new Set();
  const words = line.toLowerCase().match(/[a-z0-9]+/g) ?? [];
  for (let i = 0; i < words.length; i++) {
    const one = byHash.get(hash(words[i]));
    if (one) ids.add(one);
    if (i + 1 < words.length) {
      const two = byHash.get(hash(`${words[i]} ${words[i + 1]}`));
      if (two) ids.add(two);
    }
  }
  // A dashed run is matched only from its start (the lookbehind), so a long run is read once rather than from every
  // character in it. Within it, every span of two or more parts is looked up, up to MAX_DASHED / MAX_DASHED_PARTS.
  for (const dashed of line.toLowerCase().match(/(?<![a-z0-9])[a-z0-9]+(?:-[a-z0-9]+)+/g) ?? []) {
    const parts = dashed.split('-');
    for (let i = 0; i < parts.length; i++) {
      let span = parts[i];
      for (let j = i + 1; j < parts.length && j - i < MAX_DASHED_PARTS; j++) {
        span += `-${parts[j]}`;
        if (span.length > MAX_DASHED) break;
        const id = byHash.get(hash(span));
        if (id) ids.add(id);
      }
    }
  }
  for (const m of MATCHERS) if (m.re.test(line)) ids.add(m.id);
  for (const s of SHAPES) {
    for (const match of line.matchAll(s.re)) if (s.held.has(hash(s.fold ? match[1].toLowerCase() : match[1]))) ids.add(s.id);
  }
  return [...ids];
}

export function allowlistProblems(allowlist) {
  if (!Array.isArray(allowlist)) return ['the allow-list must be a JSON array of { path, term?, reason }'];
  const known = new Set([...Object.keys(DENIED_WORDS), ...DENIED_PATTERNS.map((p) => p.id), ...DENIED_SHAPES.map((p) => p.id)]);
  const problems = [];
  allowlist.forEach((e, i) => {
    if (typeof e?.path !== 'string' || !e.path) problems.push(`allow-list entry ${i} has no path`);
    if (typeof e?.reason !== 'string' || !e.reason.trim()) problems.push(`allow-list entry ${i} has no reason`);
    if (e?.term !== undefined && !known.has(e.term)) problems.push(`allow-list entry ${i} names an unknown term "${e.term}"`);
  });
  return problems;
}

/** Scan `files` (path → text). Returns the uncovered hits and the allow-list problems. */
export function scan(files, allowlist = [], byHash = BY_HASH) {
  const problems = allowlistProblems(allowlist);
  const used = new Set();
  const hits = [];
  for (const [path, text] of Object.entries(files)) {
    text.split('\n').forEach((line, i) => {
      for (const term of lineHits(line, byHash)) {
        const cover = allowlist.findIndex((e) => (e.path === path || (e.path.endsWith('/') && path.startsWith(e.path))) && (!e.term || e.term === term));
        if (cover >= 0) used.add(cover);
        else hits.push({ path, line: i + 1, term });
      }
    });
  }
  allowlist.forEach((e, i) => {
    if (!used.has(i)) problems.push(`allow-list entry ${i} (${e.path}) covers nothing; remove it`);
  });
  return { hits, problems };
}

/** A binary file's printable runs of six or more characters, one per line: what a name or key embedded in it looks like. */
export function binaryStrings(buf) {
  return (buf.toString('latin1').match(/[\x20-\x7e]{6,}/g) ?? []).join('\n');
}

function trackedFiles(root) {
  const out = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' });
  const files = {};
  for (const rel of out.split('\0').filter(Boolean)) {
    const abs = join(root, rel);
    if (abs === SELF || !existsSync(abs)) continue;
    const buf = readFileSync(abs);
    files[rel] = buf.includes(0) ? binaryStrings(buf) : buf.toString('utf8');
  }
  return files;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const allowPath = join(dirname(SELF), 'reference-allowlist.json');
  const allowlist = existsSync(allowPath) ? JSON.parse(readFileSync(allowPath, 'utf8')) : [];
  const { hits, problems } = scan(trackedFiles(ROOT), allowlist);
  const fixes = Object.fromEntries([...DENIED_PATTERNS, ...DENIED_SHAPES].map((p) => [p.id, p.fix]));
  for (const p of problems) console.error(`reference-gate: ${p}`);
  for (const h of hits) console.error(`${h.path}:${h.line}: ${h.term}${fixes[h.term] ? ` (${fixes[h.term]})` : ' (remove the internal name)'}`);
  if (hits.length || problems.length) {
    console.error(`reference-gate: ${hits.length} hit(s), ${problems.length} problem(s) in ${relative(process.cwd(), allowPath) || allowPath}`);
    process.exit(1);
  }
  console.log(`reference-gate: clean (${Object.keys(DENIED_WORDS).length} words, ${DENIED_PATTERNS.length} patterns)`);
}
