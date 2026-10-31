/**
 * The synthetic corpus: long pages of every construct the format has, generated from a seed, so the Yjs leg runs over
 * page-sized documents. Nothing here comes from a real document.
 */
const WORDS = (
  'harbour tide lantern quay breakwater shingle estuary current mooring gull ferry salt inlet channel buoy keel anchor ' +
  'dune reef swell horizon pier rope sail chart compass drift ebb flood headland jetty kelp lagoon marsh neap rudder ' +
  'sandbar sextant shoal spit strand surf tiller wake wharf windward snake_case C:\\dir 1.5 a+b naïve 日本'
).split(' ');
const IDS = ['u1', 'user-2', 'abc_DEF'];
const LANGS = ['ts', 'go', 'sh', ''];

/** A small seeded generator (mulberry32), so every run sees the same pages. */
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function writer(seed: number, mentions: boolean) {
  const next = random(seed);
  const int = (max: number): number => Math.floor(next() * max);
  const pick = <T>(items: readonly T[]): T => items[int(items.length)];
  const words = (count: number): string => Array.from({ length: count }, () => pick(WORDS)).join(' ');
  const inline = (): string => {
    const text = words(1 + int(4)).replace(/_/g, '\\_').replace(/\\dir/, '\\\\dir');
    switch (int(mentions ? 11 : 10)) {
      case 0:
        return `**${text}**`;
      case 1:
        return `_${text}_`;
      case 2:
        return `\`${text}\``;
      case 3:
        return `[${text}](https://example.com/${pick(WORDS).replace(/[^a-z]/g, '')})`;
      case 4:
        return `[${text}](#section-${int(9)})`;
      case 5:
        return `[[${pick(['guide', 'notes/tides', 'charts/north'])}|${text}]]`;
      case 6:
        return `![${text}](attachment:file-${int(99)})`;
      case 7:
        return `https://example.com/${int(99)}`;
      case 8:
        return `**_${text}_**`;
      case 9:
        return text;
      default:
        return `<@${pick(IDS)}>`;
    }
  };
  const sentence = (): string => Array.from({ length: 2 + int(5) }, inline).join(' ');
  const paragraph = (): string => Array.from({ length: 1 + int(3) }, sentence).join('\n');
  const list = (depth: number): string => {
    const ordered = int(2) === 0;
    const task = !ordered && int(3) === 0;
    return Array.from({ length: 2 + int(4) }, (_, index) => {
      const pad = '  '.repeat(depth);
      const marker = ordered ? `${index + 1}. ` : task ? `- [${pick([' ', 'x'])}] ` : '- ';
      const nested = depth < 2 && int(4) === 0 ? `\n${list(depth + 1).replace(/^/gm, ordered ? ' ' : '')}` : '';
      return `${pad}${marker}${sentence()}${nested}`;
    }).join('\n');
  };
  const table = (): string => {
    const width = 2 + int(3);
    const row = (): string => `| ${Array.from({ length: width }, inline).join(' | ').replace(/\[\[([^\]|]+)\|/g, '[[$1\\|')} |`;
    const align = Array.from({ length: width }, () => pick(['---', ':---', '---:', ':---:'])).join(' | ');
    return [row(), `| ${align} |`, ...Array.from({ length: 1 + int(5) }, row)].join('\n');
  };
  const block = (): string => {
    switch (int(10)) {
      case 0:
        return `${'#'.repeat(1 + int(6))} ${words(2 + int(4)).replace(/_/g, '\\_').replace(/\\dir/, '\\\\dir')}${int(3) === 0 ? ` {#section-${int(9)}}` : ''}`;
      case 1:
        return list(0);
      case 2:
        return `\`\`\`${pick(LANGS)}\n${words(4)}\n\n${words(3)}\n\`\`\``;
      case 3:
        return `\`\`\`mermaid\ngraph TD\n  A-->B\n\`\`\``;
      case 4:
        return `:::${pick(['note', 'tip', 'warning', 'danger'])} ${words(2).replace(/[_\\]/g, '')}\n${paragraph()}\n:::`;
      case 5:
        return `> ${paragraph().replace(/\n/g, '\n> ')}`;
      case 6:
        return table();
      case 7:
        return '---';
      default:
        return paragraph();
    }
  };
  return { block, int };
}

/** Page `index` of the corpus. Pages grow with their index, up to a few hundred blocks. */
export function syntheticPage(index: number, { mentions = true } = {}): string {
  const { block, int } = writer(0x7d1 + index, mentions);
  return Array.from({ length: 20 + index + int(60) }, block).join('\n\n');
}

export const SYNTHETIC_PAGES = 220;
