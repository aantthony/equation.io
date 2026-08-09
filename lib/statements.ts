/**
 * The statement-list text format shared by the URL hash, the examples menu,
 * and clipboard paste: statements separate on newlines or ';', but only at
 * bracket depth zero, so a formula wrapped across lines inside parens (how
 * LLMs and textbooks format multi-component tuples) stays one statement.
 * Newlines swallowed inside brackets become spaces so token boundaries
 * survive.
 *
 * Implemented as a raw character scan rather than on the tokenizer: splitting
 * must be total (the editor splits half-typed, unparseable text, and one
 * broken statement must not corrupt the rows after it).
 *
 * Quoted text — file names, column values — is the one token that can hold a
 * bracket, so the scan tracks it: `open("a)b.csv")` must not read as depth
 * zero halfway through. A newline always ends a string, so a half-typed
 * `y = "` cannot swallow the rows below it.
 *
 * Both quotes count, because both open text in the grammar. `'` is also the
 * prime mark, so it opens text only where a token could start — the same rule
 * the tokenizer uses (the symbol pattern absorbs a trailing `'` before the
 * string pattern is tried), which is what keeps `f'(x)` and `a' = -a` whole.
 * A closing quote always closes, wherever it falls.
 */
/** Characters a symbol can end with, so a following `'` is a prime mark. */
const SYMBOL_CHAR = /[A-Za-z_0-9Σ∑Π∏∫∞']/;

export function splitStatements(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let cur = '';
  let quote: string | null = null;
  let prev = '';
  for (const ch of text.replace(/\r\n?/g, '\n')) {
    const wasPrev = prev;
    prev = ch;
    if (ch === '\n') quote = null;
    else if (quote) { if (ch === quote) quote = null; cur += ch; continue; }
    else if (ch === '"' || (ch === "'" && !SYMBOL_CHAR.test(wasPrev))) quote = ch;
    else if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') depth = Math.max(0, depth - 1);
    if ((ch === '\n' || ch === ';') && depth === 0) {
      parts.push(cur);
      cur = '';
    } else {
      cur += ch === '\n' ? ' ' : ch;
    }
  }
  parts.push(cur);
  return parts;
}
