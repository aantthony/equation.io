/**
 * Graph-link payload codec, shared by the web app and the worker.
 *
 * A payload is the part after `/#` or `/g/`: percent-encoded equations joined
 * by `;`. Beyond encodeURIComponent we also escape ( ) ! ' * — chat-app URL
 * linkifiers (iMessage, Slack, Markdown) cut links at those characters, and a
 * truncated payload renders the wrong graph.
 */

import { splitStatements } from './statements.ts';

const LINK_UNSAFE = /[()!'*]/g;
const ESCAPED_PERCENT_VERSION = '~2~';

/**
 * A `;` a row means — `people[people.city == "a;b"]`, a file named
 * `sales;2026.csv` — encodes to the same three characters as the separator
 * between rows, and the reader has to accept `%3B` as a separator because
 * clients hand it back that way. Encoded once, the two were indistinguishable
 * and the row came back split in half. So the one inside a row is encoded
 * TWICE: `%3B` in a payload is always a separator, `%253B` is always data.
 *
 * Payloads containing literal percent signs use a version marker and escape
 * those signs too. This distinguishes `%3B` text from a semicolon without
 * changing how existing, unmarked links are decoded.
 */
const encodeRow = (text: string, escapePercent = false): string =>
  encodeURIComponent(escapePercent ? text.replace(/%/g, '%25') : text)
    .replace(LINK_UNSAFE, c => '%' + c.charCodeAt(0).toString(16).toUpperCase())
    .replace(/%3B/gi, '%253B');

export function encodePayload(texts: string[]): string {
  const rows = texts.map(t => t.trim()).filter(Boolean);
  const escapePercent = rows.some(t => t.includes('%'));
  return (escapePercent ? ESCAPED_PERCENT_VERSION : '') + rows.map(t => encodeRow(t, escapePercent)).join(';');
}

/**
 * Rows from a payload, reading both the `/g/` form and legacy `/#…` links.
 *
 * The separator survives in either spelling. We emit a literal `;`, but a
 * round trip through the address bar, a copy, or a chat client can hand it
 * back as `%3B`, and a payload that no longer separates renders as one row
 * containing a `;` — which then fails to parse. A row's own semicolons are
 * encoded twice (see encodeRow), so `%3B` here can only be a separator.
 *
 * Rows are then decoded exactly once. Decoding the whole payload up front
 * instead would also un-escape any other `%`-sequence before the split, so a
 * row is decoded here and never again — and the second `%3B` a data semicolon
 * was wrapped in survives that single decode, to be read back here.
 */
export function decodePayload(payload: string): string[] {
  const escapePercent = payload.startsWith(ESCAPED_PERCENT_VERSION);
  if (escapePercent) payload = payload.slice(ESCAPED_PERCENT_VERSION.length);
  return splitStatements(payload.replace(/%3B/gi, ';'))
    .map(s => {
      const decoded = decodeURIComponent(s);
      // One pass: a restored literal %3B must not be decoded a second time.
      return escapePercent
        ? decoded.replace(/%25|%3B/gi, token => (token.toUpperCase() === '%25' ? '%' : ';'))
        : decoded.replace(/%3B/gi, ';');
    })
    .filter(s => s.trim());
}
