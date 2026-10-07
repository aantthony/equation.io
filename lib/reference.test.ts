import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { LLMS_TXT, SWIFT_INSTRUCTIONS, readReference, referenceFiles } from '../scripts/reference.ts';
import { analyzeRows } from './analysis.ts';
import { swiftInstructions } from './assistant-instructions.ts';
import { kindOf } from './assistant-tools.ts';
import { parseCsv } from './csv.ts';
import { builtinHelp } from './syntax-help.ts';
import { llmsTxt } from './reference.ts';
import { KIND_MEANINGS, rowKind } from './row-kind.ts';
import { splitStatements } from './statements.ts';

const ref = readReference();
/** Data examples read a file the test supplies. */
const tables = () => parseCsv('age,height\n20,170\n30,180\n40,175');

/** The kind rows draw, by the last row: a named point's definition draws a point. */
function lastKind(rows: string[]) {
  const analysis = analyzeRows(rows, { readouts: true, tables });
  const last = analysis.rows.at(-1)!;
  const kind = kindOf(last) ?? (rowKind(last, analysis.defs) === 'definition (point)' ? 'point' : undefined);
  return { errors: analysis.rows.map(r => r.error).filter(Boolean), kind };
}

describe('the reference', () => {
  it('has a page for every kind, and every kind in one group of the index', () => {
    const kinds = Object.keys(KIND_MEANINGS).sort();
    expect([...ref.kinds.keys()].sort()).toEqual(kinds);
    expect(ref.groups.flatMap(g => g.kinds).sort()).toEqual(kinds);
  });

  it('gives every example rows that draw its kind, with no error', () => {
    for (const page of ref.kinds.values()) {
      expect(page.examples.length, page.slug).toBeGreaterThan(0);
      for (const example of page.examples) {
        const what = `${page.slug}: ${example.name}`;
        expect(lastKind(example.rows), what).toEqual({ errors: [], kind: page.kind });
      }
    }
  });

  it("gives every kind a smallest form that draws it (list_kinds' line)", () => {
    for (const page of ref.kinds.values()) {
      const rows = splitStatements(page.form).map(s => s.trim());
      expect(lastKind(rows), page.form).toEqual({ errors: [], kind: page.kind });
    }
  });

  it('links only to kinds it has, and notes only functions that exist', () => {
    const text = Object.values(referenceFiles()).join('\n');
    for (const [, target] of text.matchAll(/\]\(#([\w-]+)\)/g))
      expect(ref.kinds.has(target as never), target).toBe(true);
    for (const name of ref.notes.keys()) expect(builtinHelp(name), name).not.toBeNull();
  });

  it('has written web/public/llms.txt and Instructions.swift (pnpm reference)', () => {
    expect(readFileSync(LLMS_TXT, 'utf8')).toBe(llmsTxt(ref));
    expect(readFileSync(SWIFT_INSTRUCTIONS, 'utf8')).toBe(swiftInstructions());
  });

  it('keeps one kind per heading in llms.txt, its name first, and More last', () => {
    const llms = llmsTxt(ref);
    const headings = [...llms.matchAll(/^### (.+) \(`(\w+)`\)$/gm)].map(m => m[2]);
    expect(headings.sort()).toEqual(Object.keys(KIND_MEANINGS).sort());
    expect(llms.trimEnd().split('\n## ').at(-1)).toMatch(/^More\n/);
    // Guidance before the reference itself.
    expect(llms.indexOf('## Guidance for assistants')).toBeLessThan(llms.indexOf('## Expression syntax'));
  });
});
