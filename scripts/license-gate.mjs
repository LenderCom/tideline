#!/usr/bin/env node
/**
 * The licence gate. Fails when:
 *   1. this repository's LICENSE is not the verbatim Apache License 2.0 text. GitHub only shows "Apache-2.0" for an
 *      unmodified file, so the copyright line lives in NOTICE, never in LICENSE;
 *   2. an installed npm package, or a Go module in the build list, carries a licence family we may not depend on
 *      (GPL, AGPL, LGPL, SSPL, Business Source, Commons Clause, Elastic, non-commercial or no-derivatives Creative
 *      Commons, proprietary or commercial), or
 *   3. one carries a licence this gate cannot name, and no entry in license-clarifications.json vouches for it
 *      (`{ "package": "name", "license": "MIT", "reason": "…" }`). The gate names only the licences in ALLOWED; any
 *      other id, however harmless it sounds, counts as unnamed until a person vouches for it.
 *
 * npm: reads every package.json under node_modules (install first). Go: reads `go list -m -json all` and each
 * module's LICENSE file (run `go mod download` first). No dependencies of its own.
 *
 *   node scripts/license-gate.mjs
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SELF = fileURLToPath(import.meta.url);
const ROOT = join(dirname(SELF), '..');

/** SHA-256 of https://www.apache.org/licenses/LICENSE-2.0.txt, the file GitHub's licence detector matches. */
export const APACHE_2_SHA256 = 'cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30';

/** The SPDX ids a dependency may carry, compared case-insensitively. A `WITH` exception is judged by its base id, unless it names a denied family. */
export const ALLOWED = [
  '0BSD',
  'Apache-2.0',
  'BlueOak-1.0.0',
  'BSD-2-Clause',
  'BSD-3-Clause',
  'CC-BY-3.0',
  'CC-BY-4.0',
  'CC0-1.0',
  'ISC',
  'MIT',
  'MIT-0',
  'MPL-2.0',
  'Python-2.0',
  'Unlicense',
  'Zlib',
];

export const DENIED = [
  /^(?:A|L)?GPL\b/i,
  /^SSPL\b/i,
  /^BUSL\b/i,
  /^BSL$/i,
  /^BSL-1\.1$/i,
  /Business Source/i,
  /Commons[- ]Clause/i,
  /^Elastic\b/i,
  /^WTFPL$/i,
  /^CC-BY(?:-SA)?-NC/i,
  /^CC-BY(?:-NC)?-ND/i,
  /PolyForm/i,
  /Non-?Commercial/i,
  /^PROPRIETARY\b/i,
  /^COMMERCIAL\b/i,
];

const ALLOWED_IDS = new Set(ALLOWED.map((id) => id.toLowerCase()));

const UNNAMED = /^(?:UNKNOWN|UNLICENSED|SEE LICENSE IN\b|Custom:|LicenseRef-)/i;

/**
 * An SPDX expression → its alternatives, each the list of ids that must all be acceptable: `A OR B` → [[A], [B]];
 * `A AND B` → [[A, B]]; `A AND (B OR C)` → [[A, B], [A, C]]. Parentheses group first, then AND binds tighter than
 * OR, as SPDX defines. Operators match in any case; adjacent words with no operator between them (`MIT License`,
 * `X WITH exception`) stay one id. Throws on a malformed expression (unbalanced parentheses, a dangling operator).
 */
export function alternatives(expression) {
  const tokens = expression.match(/[()]|[^\s()]+/g) ?? [];
  let pos = 0;
  const peek = () => tokens[pos];
  const isOp = (t, op) => t !== undefined && t.toUpperCase() === op;
  const fail = (why) => {
    throw new Error(`malformed licence expression "${expression}": ${why}`);
  };
  // or := and (OR and)*   and := atom (AND atom)*   atom := '(' or ')' | word+
  const parseOr = () => {
    let alts = parseAnd();
    while (isOp(peek(), 'OR')) {
      pos++;
      alts = alts.concat(parseAnd());
    }
    return alts;
  };
  const parseAnd = () => {
    let alts = parseAtom();
    while (isOp(peek(), 'AND')) {
      pos++;
      const right = parseAtom();
      alts = alts.flatMap((left) => right.map((r) => [...left, ...r]));
    }
    return alts;
  };
  const parseAtom = () => {
    const t = peek();
    if (t === '(') {
      pos++;
      const alts = parseOr();
      if (peek() !== ')') fail('missing )');
      pos++;
      return alts;
    }
    const words = [];
    while (peek() !== undefined && peek() !== '(' && peek() !== ')' && !isOp(peek(), 'AND') && !isOp(peek(), 'OR')) words.push(tokens[pos++]);
    if (!words.length) fail(t === undefined ? 'ends early' : `unexpected "${t}"`);
    return [[words.join(' ')]];
  };
  const alts = parseOr();
  if (pos < tokens.length) fail(`unexpected "${peek()}"`);
  return alts;
}

/**
 * 'ok' | 'denied' | 'unnamed' for one licence id. `X WITH exception` is allowed or unnamed by X alone, but denied when
 * X or the exception names a denied family: an exception can add a restriction (`Apache-2.0 WITH Commons-Clause`).
 */
export function judgeId(id) {
  const [base, ...exceptions] = id.split(/\s+WITH\s+/i).map((part) => part.trim());
  if ([base, ...exceptions].some((part) => DENIED.some((re) => re.test(part)))) return 'denied';
  if (ALLOWED_IDS.has(base.toLowerCase())) return 'ok';
  return 'unnamed';
}

/** 'ok' | 'denied' | 'unnamed' for one SPDX expression. */
export function judge(expression) {
  if (!expression || UNNAMED.test(expression.trim())) return 'unnamed';
  let alts;
  try {
    alts = alternatives(expression);
  } catch {
    // A garbled expression cannot be trusted to offer a way out: if it names a denied licence anywhere, it is denied,
    // so no clarification can vouch it through. Otherwise it is unnamed, like any licence the gate cannot read.
    // Candidates are each operand between AND/OR (parentheses dropped), so a multi-word name such as
    // `Business Source License 1.1` or `Commons Clause` stays whole, and each single word, as before.
    const flat = expression.replace(/[()]/g, ' ').replace(/\s+/g, ' ').trim();
    const operands = flat.split(/(?:^|\s+)(?:AND|OR)(?=\s|$)/i).map((o) => o.trim()).filter(Boolean);
    const words = flat.split(' ').filter((w) => w && !/^(?:AND|OR|WITH)$/i.test(w));
    return [...operands, ...words].some((id) => judgeId(id) === 'denied') ? 'denied' : 'unnamed';
  }
  if (alts.some((ids) => ids.every((id) => judgeId(id) === 'ok'))) return 'ok';
  if (alts.every((ids) => ids.some((id) => judgeId(id) === 'denied'))) return 'denied';
  return 'unnamed';
}

/** A licence file's text → its SPDX id, by the phrases each licence is known by; undefined when it can't tell. */
export function classifyLicenseText(text) {
  const t = text.replace(/\s+/g, ' ');
  if (/GNU AFFERO GENERAL PUBLIC LICENSE/i.test(t)) return 'AGPL-3.0';
  if (/GNU LESSER GENERAL PUBLIC LICENSE/i.test(t)) return 'LGPL';
  if (/GNU GENERAL PUBLIC LICENSE/i.test(t)) return 'GPL';
  if (/Server Side Public License/i.test(t)) return 'SSPL-1.0';
  if (/Business Source License/i.test(t)) return 'BUSL-1.1';
  if (/Apache License,? Version 2\.0|Apache License\s+Version 2\.0/i.test(t)) return 'Apache-2.0';
  if (/Mozilla Public License,? (?:Version|v\.?) ?2\.0/i.test(t)) return 'MPL-2.0';
  if (/Permission is hereby granted, free of charge/i.test(t)) return 'MIT';
  if (/Permission to use, copy, modify, and\/or distribute/i.test(t)) return 'ISC';
  if (/Redistribution and use in source and binary forms/i.test(t)) return /Neither the name/i.test(t) ? 'BSD-3-Clause' : 'BSD-2-Clause';
  if (/CC0 1\.0 Universal/i.test(t)) return 'CC0-1.0';
  return undefined;
}

function licenseField(pkg) {
  if (typeof pkg.license === 'string') return pkg.license;
  if (pkg.license?.type) return pkg.license.type;
  if (Array.isArray(pkg.licenses)) return pkg.licenses.map((l) => l.type ?? l).join(' OR ');
  return undefined;
}

/** Every installed npm package: [{ name, version, license }]. */
export function npmInventory(root) {
  const seen = new Map();
  const walk = (dir) => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir)) {
      if (entry.startsWith('.')) continue;
      const path = join(dir, entry);
      if (entry.startsWith('@')) {
        walk(path);
        continue;
      }
      const manifest = join(path, 'package.json');
      if (!existsSync(manifest)) continue;
      const pkg = JSON.parse(readFileSync(manifest, 'utf8'));
      if (pkg.name) seen.set(`${pkg.name}@${pkg.version}`, { name: pkg.name, version: pkg.version, license: licenseField(pkg) });
      walk(join(path, 'node_modules'));
    }
  };
  walk(join(root, 'node_modules'));
  return [...seen.values()];
}

/**
 * Every Go module compiled into this module's packages and their tests, except the main one: [{ name, version,
 * license }]. `go list -deps` (not `go list -m all`) so the gate judges what is built, not every module the graph
 * mentions; those others are never downloaded and could not be read anyway.
 */
export function goInventory(root) {
  const format = '{{with .Module}}{{if not .Main}}{{.Path}}\t{{.Version}}\t{{.Dir}}{{end}}{{end}}';
  const out = execFileSync('go', ['list', '-deps', '-test', '-f', format, './...'], { cwd: root, encoding: 'utf8' });
  const modules = new Map();
  for (const row of out.split('\n')) {
    const [path, version, dir] = row.split('\t');
    if (!path || modules.has(path)) continue;
    let license;
    if (dir && existsSync(dir)) {
      const file = readdirSync(dir).find((f) => /^(?:LICEN[CS]E|COPYING)(?:\.(?:md|txt))?$/i.test(f));
      if (file) license = classifyLicenseText(readFileSync(join(dir, file), 'utf8'));
    }
    modules.set(path, { name: path, version, license });
  }
  return [...modules.values()];
}

/** Violations for an inventory, given the clarifications and our own package name(s). */
export function violations(inventory, clarifications = [], self = []) {
  const vouched = new Map(clarifications.map((c) => [c.package, c]));
  const out = [];
  for (const dep of inventory) {
    if (self.includes(dep.name)) continue;
    const verdict = judge(dep.license ?? '');
    if (verdict === 'ok') continue;
    if (verdict === 'unnamed' && vouched.get(dep.name)?.reason) continue;
    out.push(`${dep.name}@${dep.version}: ${verdict === 'denied' ? `licence ${dep.license} may not be depended on` : `licence "${dep.license ?? 'none found'}" is unnamed; add it to license-clarifications.json with a reason, or drop the dependency`}`);
  }
  return out;
}

export function licenseFileProblem(root) {
  const path = join(root, 'LICENSE');
  if (!existsSync(path)) return 'LICENSE is missing';
  const sha = createHash('sha256').update(readFileSync(path)).digest('hex');
  return sha === APACHE_2_SHA256 ? undefined : 'LICENSE is not the verbatim Apache License 2.0 text; GitHub will not detect it. Restore it, and keep the copyright line in NOTICE.';
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const problems = [];
  const fileProblem = licenseFileProblem(ROOT);
  if (fileProblem) problems.push(fileProblem);
  const clarPath = join(dirname(SELF), 'license-clarifications.json');
  const clarifications = existsSync(clarPath) ? JSON.parse(readFileSync(clarPath, 'utf8')) : [];
  let inventory = [];
  const self = [];
  if (existsSync(join(ROOT, 'package.json'))) {
    self.push(JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).name);
    if (!existsSync(join(ROOT, 'node_modules'))) problems.push('node_modules is missing; install first (bun install)');
    inventory = inventory.concat(npmInventory(ROOT));
  }
  if (existsSync(join(ROOT, 'go.mod'))) inventory = inventory.concat(goInventory(ROOT));
  problems.push(...violations(inventory, clarifications, self));
  for (const p of problems) console.error(`license-gate: ${p}`);
  if (problems.length) process.exit(1);
  console.log(`license-gate: clean (LICENSE is Apache-2.0; ${inventory.length} dependencies checked)`);
}
