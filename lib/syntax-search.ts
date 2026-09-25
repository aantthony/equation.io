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

/** Query words worth matching: 3+ characters, not filler, with a naive plural strip. */
function words(query: string): string[] {
  return [
    ...new Set(
      query
        .toLowerCase()
        .split(/[^a-z0-9_^]+/)
        .filter(w => w.length >= 3 && !STOP.has(w))
        .map(w => (w.length > 4 && w.endsWith('s') ? w.slice(0, -1) : w)),
    ),
  ];
}

/**
 * The best entries for a query, formatted under their section headings and
 * capped at `maxChars`; or, when nothing matches, the list of sections.
 */
export function searchSyntax(entries: SyntaxEntry[], query: string, limit = 6, maxChars = 6000): string {
  const terms = words(query);
  const scored = entries
    .map((entry, index) => {
      const body = entry.text.toLowerCase();
      const title = entry.section.toLowerCase();
      // "- Parametric surface: …" — the label an entry opens with names its topic.
      const lead = body.slice(0, body.search(/[:—]/) + 1 || 40);
      let score = 0;
      for (const w of terms) {
        const hits = body.split(w).length - 1;
        // Every term that appears counts most; repeats, the entry's own label,
        // and a matching section add a little.
        if (hits) score += 10 + Math.min(hits, 5);
        if (lead.includes(w)) score += 6;
        if (title.includes(w)) score += 3;
      }
      return { entry, index, score };
    })
    .filter(s => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .sort((a, b) => a.index - b.index);
  if (!scored.length) {
    const sections = [...new Set(entries.map(e => e.section))];
    return `Nothing matched "${query}". Sections: ${sections.join('; ')}. Try other words, e.g. a section name.`;
  }
  let out = '';
  let section = '';
  for (const { entry } of scored) {
    const piece = (entry.section !== section ? `## ${entry.section}\n` : '') + entry.text + '\n\n';
    if (out.length + piece.length > maxChars) break;
    out += piece;
    section = entry.section;
  }
  return out.trim();
}
