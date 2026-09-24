import { describe, expect, it } from 'vitest';
import { EXAMPLES } from '../web/examples.ts';
import { analyzeRows } from './analysis.ts';
import { splitStatements } from './statements.ts';

describe('examples menu', () => {
  it('has unique category names, and unique labels within each', () => {
    const categories = EXAMPLES.map(([c]) => c);
    expect(new Set(categories).size).toBe(categories.length);
    for (const [category, items] of EXAMPLES) {
      const labels = items.map(([l]) => l);
      expect(new Set(labels).size, category).toBe(labels.length);
    }
  });

  it('never repeats an example', () => {
    const seen = new Map<string, string>();
    for (const [category, items] of EXAMPLES) {
      for (const [label, text] of items) {
        // Spacing is not a difference: `x^2+y^2` and `x^2 + y^2` are one example.
        const key = text.replace(/\s+/g, '');
        expect(seen.get(key), `${category} / ${label}`).toBeUndefined();
        seen.set(key, label);
      }
    }
  });

  // An example is the first thing a visitor tries, so a row error there is
  // the worst place for one: every row of every example must compile. A row
  // can also compile and still be wrong — `e = 0.6` meant as a slider reads
  // "Never true" — so every row must also define, frame or draw something,
  // and none may be a decided comparison.
  it.each(EXAMPLES.flatMap(([category, items]) =>
    items.map(([label, text]) => [`${category} / ${label}`, text])))('%s compiles', (_, text) => {
    const rows = splitStatements(text).map(s => s.trim()).filter(Boolean);
    const problems = analyzeRows(rows).rows.flatMap(r =>
      r.error ? [`${r.text}: ${r.error}`]
      : /^(Always|Never) true/.test(r.info ?? '') ? [`${r.text}: ${r.info}`]
      : !r.comment && !r.cls && !r.def && !r.view ? [`${r.text}: does nothing`]
      : []);
    expect(problems).toEqual([]);
  });
});
