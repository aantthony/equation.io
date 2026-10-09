import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { LLMS_TXT, SWIFT_INSTRUCTIONS, readReference, referenceFiles } from '../scripts/reference.ts';
import { analyzeRows } from './analysis.ts';
import { CHARTED_GROUPS, swiftInstructions } from './assistant-instructions.ts';
import { kindOf } from './assistant-tools.ts';
import { parseCsv } from './csv.ts';
import { builtinHelp } from './syntax-help.ts';
import { kindNames, llmsTxt } from './reference.ts';
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

  it('draws every named shape: each form with its parameters set, and its instance, as the kind it names', () => {
    expect(ref.shapes.length).toBeGreaterThan(25);
    for (const shape of ref.shapes)
      for (const form of shape.forms) {
        const what = `${shape.name}: ${form.rows.join('; ')}`;
        expect(Object.keys(KIND_MEANINGS), what).toContain(form.kind);
        for (const [name] of form.params)
          expect(form.rows.join(' '), what).toMatch(new RegExp(`(?<![A-Za-z_])${name}(?![A-Za-z0-9_])`));
        const params = form.params.map(([name]) => `${name} = 2`);
        expect(lastKind([...params, ...form.rows]), what).toEqual({ errors: [], kind: form.kind });
        if (params.length)
          expect(lastKind(form.rows).errors.length, `${what}, its parameters unset`).toBeGreaterThan(0);
        const instance = `${shape.name}: ${form.example.rows.join('; ')}`;
        // The instance names each parameter's value, as `a = 3, c = 2`.
        const values = (form.example.values ?? '').split(', ').filter(Boolean);
        expect(
          values.map(v => /^(\w+) = -?[\d.]+$/.exec(v)?.[1]),
          instance,
        ).toEqual(form.params.map(([name]) => name));
        expect(lastKind(form.example.rows), instance).toEqual({ errors: [], kind: form.kind });
      }
  });

  it('gives every named shape names of its own', () => {
    const key = (name: string) => name.toLowerCase();
    const names = ref.shapes.flatMap(s => [s.name, ...s.aliases].map(key));
    expect(names.filter((name, k) => names.indexOf(name) !== k)).toEqual([]);
  });

  it('has written web/public/llms.txt and Instructions.swift (pnpm reference)', () => {
    expect(readFileSync(LLMS_TXT, 'utf8')).toBe(llmsTxt(ref));
    expect(readFileSync(SWIFT_INSTRUCTIONS, 'utf8')).toBe(swiftInstructions(kindNames(ref, CHARTED_GROUPS)));
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
