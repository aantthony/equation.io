/**
 * Keyword search over the syntax reference (web/public/llms.txt), for voice
 * mode's read_syntax tool. The whole reference is far too long for a realtime
 * model's instructions, so the model asks for what it needs ("parametric
 * surface", "vector field") and gets back the handful of entries that match.
 *
 * An entry is one top-level bullet (with its continuation lines) or one
 * paragraph, tagged with its `## ` section. Sections about links, the MCP
 * server and other assistants are left out: a voice session edits the graph
 * directly and never builds a URL.
 */

export interface SyntaxEntry {
  section: string;
  text: string;
}

const SKIP_SECTIONS = new Set([
  'Deep links',
  'Share links with preview images (/g/)',
  'MCP server',
  'Guidance for assistants',
  'More',
]);

/** Splits the reference into searchable entries, in document order. */
export function syntaxEntries(reference: string): SyntaxEntry[] {
  const entries: SyntaxEntry[] = [];
  let section = '';
  let current: string[] = [];
  const flush = () => {
    const text = current.join('\n').trim();
    if (text && section && !SKIP_SECTIONS.has(section)) entries.push({ section, text });
    current = [];
  };
  for (const line of reference.split('\n')) {
    if (line.startsWith('## ')) {
      flush();
      section = line.slice(3).trim();
    } else if (line.startsWith('- ') || line.trim() === '') {
      // A new top-level bullet or a blank line ends the entry; indented lines continue it.
      flush();
      if (line.trim()) current.push(line);
    } else {
      current.push(line);
    }
  }
  flush();
  return entries;
}

const STOP = new Set(['the', 'and', 'for', 'how', 'what', 'with', 'use', 'draw', 'make', 'plot', 'graph', 'row']);

/** A query term and how many times an entry mentions it. */
interface Term {
  word: string;
  hits: (text: string) => number;
}

const escape = (w: string) => w.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');

/** Occurrences as a whole word: `pi` in "pi/2" but not in "spin". */
const wholeWord = (word: string): Term => {
  const re = new RegExp(`(?<![\\p{L}\\p{N}_])${escape(word)}(?![\\p{L}\\p{N}_])`, 'gu');
  return { word, hits: text => text.match(re)?.length ?? 0 };
};
const substring = (word: string): Term => ({ word, hits: text => text.split(word).length - 1 });

/**
 * Query terms worth matching. Words of 3+ letters match anywhere (with a naive
 * plural strip), so "parametric" finds "parametrically". Shorter words (pi,
 * ln), and single non-ASCII symbols (Σ, π, ∇), are too common inside other
 * words, so they match whole. A token that is notation, like d/dx or x^2,
 * also matches as written.
 */
function terms(query: string): Term[] {
  const out = new Map<string, Term>();
  for (const token of query.toLowerCase().split(/[\s,;:?!"()]+/)) {
    const notation = token.replace(/^[.'`]+|[.'`]+$/g, '');
    const words = notation.split(/[^\p{L}\p{N}_]+/u).filter(Boolean);
    if (words.length !== 1 || words[0] !== notation) {
      if (notation.length >= 2) out.set(notation, substring(notation));
    }
    for (const w of words) {
      if (STOP.has(w)) continue;
      if (w.length >= 3 && /^[a-z0-9_]+$/.test(w)) {
        const stem = w.length > 4 && w.endsWith('s') ? w.slice(0, -1) : w;
        out.set(stem, substring(stem));
      } else if (w.length === 2 || /\P{ASCII}/u.test(w)) {
        out.set(w, wholeWord(w));
      }
    }
  }
  return [...out.values()];
}

/**
 * The best entries for a query, formatted under their section headings and
 * capped at `maxChars`; or, when nothing matches, the list of sections.
 * Entries are chosen best first, skipping any too long for what is left, then
 * printed in document order.
 */
export function searchSyntax(entries: SyntaxEntry[], query: string, limit = 6, maxChars = 6000): string {
  const found = terms(query);
  const scored = entries
    .map((entry, index) => {
      const body = entry.text.toLowerCase();
      const title = entry.section.toLowerCase();
      // "- Parametric surface: …" — the label an entry opens with names its topic.
      const lead = body.slice(0, body.search(/[:—]/) + 1 || 40);
      let score = 0;
      for (const t of found) {
        const hits = t.hits(body);
        // Every term that appears counts most; repeats, the entry's own label,
        // the term written alone as code, and a matching section add a little.
        if (hits) score += 10 + Math.min(hits, 5);
        if (t.hits(lead)) score += 6;
        // `pi` alone as code: the entry that documents it, not one that uses it.
        if (body.includes(`\`${t.word}\``)) score += 8;
        if (t.hits(title)) score += 3;
      }
      return { entry, index, score };
    })
    .filter(s => s.score > 0)
    .sort((a, b) => b.score - a.score);
  if (!scored.length) {
    const sections = [...new Set(entries.map(e => e.section))];
    return `Nothing matched "${query}". Sections: ${sections.join('; ')}. Try other words, e.g. a section name.`;
  }
  // Budget each entry as if it opened its own section, so the total can only come in under.
  const piece = (entry: SyntaxEntry) => `## ${entry.section}\n`.length + entry.text.length + 2;
  const chosen: typeof scored = [];
  let left = maxChars;
  for (const s of scored) {
    if (chosen.length === limit) break;
    if (piece(s.entry) > left) continue;
    chosen.push(s);
    left -= piece(s.entry);
  }
  if (!chosen.length) return `The entries for "${query}" are too long to show; try narrower words.`;
  let out = '';
  let section = '';
  for (const { entry } of chosen.sort((a, b) => a.index - b.index)) {
    out += (entry.section !== section ? `## ${entry.section}\n` : '') + entry.text + '\n\n';
    section = entry.section;
  }
  return out.trim();
}
