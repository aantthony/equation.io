/**
 * `add_type` events (worker/events.ts): the graph types a document draws,
 * each counted the first time it appears there. Only type names
 * (lib/row-kind.ts KIND_MEANINGS) leave the page, never equations.
 *
 * Rows that an example or the featured graph put on the page aren't the
 * visitor's until they edit them, so browsing the examples menu doesn't read
 * as people drawing what the examples draw. A row is known by its text:
 * editing changes it, while undo and DOM rebuilds (which make new row
 * objects) don't.
 *
 * A document starts over, with every type new again, on page load, on opening
 * an example, and when it's emptied.
 */
export class TypeEvents {
  private seen = new Set<string>();
  private example = new Set<string>();
  private pending: string[] = [];

  /** An example or the featured graph replaced the document. */
  opened(rows: readonly string[]) {
    this.seen.clear();
    this.example = new Set(rows.map(r => r.trim()));
  }

  /** The rows as they stand, each with the type it draws, if any. */
  note(rows: readonly { text: string; type?: string }[]) {
    if (rows.every(r => !r.text.trim())) {
      this.seen.clear();
      this.example.clear();
      return;
    }
    for (const { text, type } of rows) {
      if (!type || this.seen.has(type) || this.example.has(text.trim())) continue;
      this.seen.add(type);
      this.pending.push(type);
    }
  }

  /** Types first seen since the last call. */
  take(): string[] {
    return this.pending.splice(0);
  }
}
