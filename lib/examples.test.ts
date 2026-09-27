import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { COVERS, EXAMPLES, TAGS, exampleShotPath, searchCategories, searchExamples } from '../web/examples.ts';
import { analyzeRows } from './analysis.ts';
import { scanSequences } from './seq.ts';
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
  it.each(EXAMPLES.flatMap(([category, items]) => items.map(([label, text]) => [`${category} / ${label}`, text])))(
    '%s compiles',
    (_, text) => {
      const rows = splitStatements(text)
        .map(s => s.trim())
        .filter(Boolean);
      // An automaton's seed row `c_0[i] = …` draws through its rule row.
      const seeds = scanSequences(rows).map(s => !!s?.seed);
      const problems = analyzeRows(rows).rows.flatMap((r, i) =>
        r.error
          ? [`${r.text}: ${r.error}`]
          : /^(Always|Never) true/.test(r.info ?? '')
            ? [`${r.text}: ${r.info}`]
            : !r.comment && !r.cls && !r.def && !r.view && !seeds[i]
              ? [`${r.text}: does nothing`]
              : [],
      );
      expect(problems).toEqual([]);
    },
  );

  // The menu shows each example by its screenshot. The manifest records the
  // rows each shot was taken from, so an edited example fails here until
  // `pnpm shots:examples` reshoots it.
  it('has a current screenshot of every example, and no others', () => {
    const dir = new URL('../web/shots/examples/', import.meta.url);
    const manifest: Record<string, string> = JSON.parse(readFileSync(new URL('manifest.json', dir), 'utf8'));
    const expected: Record<string, string> = {};
    for (const [category, items] of EXAMPLES) {
      for (const [label, text] of items) {
        const slug = exampleShotPath(category, label);
        expect(expected[slug], `${category} / ${label} shares a shot path`).toBeUndefined();
        expected[slug] = text;
        expect(existsSync(new URL(`${slug}.webp`, dir)), `${slug}.webp — run pnpm shots:examples`).toBe(true);
      }
    }
    expect(manifest, 'shots out of date — run pnpm shots:examples').toEqual(expected);
    const files = readdirSync(dir, { recursive: true, encoding: 'utf8' })
      .filter(f => f.endsWith('.webp'))
      .map(f => f.replace(/\.webp$/, ''));
    expect(files.filter(f => !(f in expected))).toEqual([]);
  });

  it('covers each category with one of its own examples', () => {
    for (const [category, label] of Object.entries(COVERS)) {
      const items = EXAMPLES.find(([c]) => c === category)?.[1];
      expect(items, `COVERS names unknown category "${category}"`).toBeDefined();
      expect(
        items!.map(([l]) => l),
        category,
      ).toContain(label);
    }
  });

  it('searches labels, categories and rows, every word, ignoring accents and case', () => {
    const labels = (q: string) => searchExamples(q).map(e => e.label);
    expect(labels('julia')).toEqual(['quaternion Julia set (slide s)', 'Julia set', 'Julia orbit']);
    expect(labels('THEBAULT')).toEqual(['Thébault’s theorem']);
    expect(labels('fractals ship')).toEqual(['burning ship']);
    expect(labels('conformal(w')).toContain('Joukowski airfoil');
    expect(labels('  ')).toEqual([]);
  });

  it('tags every example from the list, and uses every tag', () => {
    const used = new Set<string>();
    for (const [category, items] of EXAMPLES) {
      for (const [label, , tags] of items) {
        const list = tags.split(' ');
        expect(list.length, `${category} / ${label}`).toBeGreaterThan(0);
        expect(new Set(list).size, `${category} / ${label} repeats a tag`).toBe(list.length);
        for (const t of list) {
          expect(TAGS as readonly string[], `${category} / ${label}`).toContain(t);
          used.add(t);
        }
      }
    }
    expect(TAGS.filter(t => !used.has(t))).toEqual([]);
  });

  it('finds tags by word, and exactly with #', () => {
    const labels = (q: string) => searchExamples(q).map(e => e.label);
    expect(labels('#knot')).toEqual(['trefoil', 'torus knot (2,5)', 'figure eight']);
    // `knot` alone also finds the category's name in the rows' category.
    expect(labels('knot')).toContain('helix');
    expect(labels('#biology')).toEqual(['logistic growth', 'Lotka–Volterra', 'SIR epidemic']);
    expect(labels('#animated #complex').length).toBeGreaterThan(3);
    expect(searchCategories('#3d')).toEqual([]);
  });

  it('searches within one category', () => {
    const labels = (q: string, c: string) => searchExamples(q, c).map(e => e.label);
    expect(labels('julia', 'fractals')).toEqual(['Julia set', 'Julia orbit']);
    expect(labels('torus', 'fractals')).toEqual([]);
  });

  it('matches categories by name alone', () => {
    expect(searchCategories('3d')).toEqual(['3D surfaces', '3D curves + knots']);
    expect(searchCategories('probability')).toEqual(['probability: continuous', 'probability: discrete']);
    // `torus` names examples, not a category.
    expect(searchCategories('torus')).toEqual([]);
  });
});
