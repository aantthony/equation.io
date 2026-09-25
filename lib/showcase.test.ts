import { describe, expect, it } from 'vitest';
import { HERO, SHOWCASE } from '../web/about/showcase.ts';
import { analyzeRows } from './analysis.ts';
import { scanSequences } from './seq.ts';

// The /about/ gallery links each card straight into the app, so it gets the
// examples menu's check: every row compiles and does something.
describe('about showcase', () => {
  it('has unique slugs', () => {
    const slugs = [HERO, ...SHOWCASE].map(i => i.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
  });

  it.each([HERO, ...SHOWCASE].map(i => [i.slug, i.eqs] as const))('%s compiles', (_, rows) => {
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
  });
});
