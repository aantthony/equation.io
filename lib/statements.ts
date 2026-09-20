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
 * `y = "` cannot swallow the rows below it — and it ends the statement's
 * brackets with it. An unbalanced bracket at a newline is ambiguous (a
 * formula wrapped across lines looks exactly like that), but an unclosed
 * string is not: text never spans a line, so the statement is known broken
 * and its depth is only open because it is broken. Leaving the depth stranded
 * would half-recover — `p = open("foo.csv` would still eat every row below.
 *
 * Both quotes count, because both open text in the grammar. `'` is also the
 * prime mark, so it opens text only where a token could start, which is what
 * keeps `f'(x)` and `a' = -a` whole. Anything that ENDS a value counts, not
 * just the symbol characters the tokenizer absorbs a prime into: after `)`,
 * `]` or `!` no string can begin, and reading one there let a stray prime —
 * `f(x)' ; y = 2`, a typo or a half-typed row — swallow the `;` and take the
 * perfectly good row after it out of the document. Splitting wrongly costs a
 * whole row; tokenizing wrongly costs one row its message.
 * A closing quote always closes, wherever it falls.
 */
import { GLYPH_CHARS, SUPERSCRIPT_CHARS, WRITTEN_NAME_CHARS } from './expr.ts';

/** Characters a value can end with, so a following `'` is a prime mark:
 *  written name characters (Greek and subscript spellings included),
 *  constant/operator glyphs, superscript exponents, and everything that
 *  closes or ends a value. */
export const VALUE_END = new RegExp(`[${WRITTEN_NAME_CHARS}${GLYPH_CHARS}${SUPERSCRIPT_CHARS}')\\]}!]`);

export function splitStatements(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let cur = '';
  let quote: string | null = null;
  let prev = '';
  for (const ch of text.replace(/\r\n?/g, '\n')) {
    const wasPrev = prev;
    prev = ch;
    if (ch === '\n') {
      if (quote) depth = 0;
      quote = null;
    }
    else if (quote) { if (ch === quote) quote = null; cur += ch; continue; }
    else if (ch === '"' || (ch === "'" && !VALUE_END.test(wasPrev))) quote = ch;
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
