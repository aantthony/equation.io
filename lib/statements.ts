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
 * Double-quoted text — file names, column values — is the one token that can
 * hold a bracket, so the scan tracks it: `open("a)b.csv")` must not read as
 * depth zero halfway through. A newline always ends a string, so a half-typed
 * `y = "` cannot swallow the rows below it. Single quotes are left alone
 * deliberately: `f'(x)` is prime notation, and treating that as an opening
 * quote would eat the rest of the line.
 */
export function splitStatements(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let cur = '';
  let quoted = false;
  for (const ch of text.replace(/\r\n?/g, '\n')) {
    if (ch === '\n') quoted = false;
    else if (ch === '"') quoted = !quoted;
    else if (quoted) { cur += ch; continue; }
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
