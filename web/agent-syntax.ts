/**
 * read_syntax's reference: the site's own /llms.txt (bundled with the desktop
 * app too), fetched once on first use and searched per query.
 */
import { type SyntaxEntry, searchSyntax, syntaxEntries } from '../lib/syntax-search.ts';

let reference: Promise<SyntaxEntry[]> | undefined;

function entries(): Promise<SyntaxEntry[]> {
  reference ??= fetch('/llms.txt')
    .then(res => (res.ok ? res.text() : Promise.reject(new Error(`HTTP ${res.status}`))))
    .then(syntaxEntries);
  // A failed load may be retried on the next call.
  reference.catch(() => (reference = undefined));
  return reference;
}

export async function readSyntax(query: string): Promise<string> {
  return searchSyntax(await entries(), query);
}
