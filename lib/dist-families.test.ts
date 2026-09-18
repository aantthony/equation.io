import { describe, expect, it } from 'vitest';
import { emptyDefs } from './defs.ts';
import { parseDistribution, scanDistribution } from './dist.ts';
import { DIST_FAMILIES, distFamily, distUsage, isModelName } from './dist-families.ts';
import { scanRegressions } from './regression.ts';
import { syntaxHelp } from './syntax-help.ts';

/** Every spelling of every family, with enough literal arguments to parse. */
const spellings = DIST_FAMILIES.flatMap(f => [f.name, ...f.aliases].flatMap(n => [n, n.toLowerCase(), n.toUpperCase()])
  .map(n => ({ f, n, call: `${n}(${f.params.map((_, k) => k + 1).join(', ')})` })));

describe('one table of families, every consumer', () => {
  it.each(spellings)('$n: parses, declares, and shows its signature', ({ f, n, call }) => {
    expect(distFamily(n)).toBe(f);
    expect(parseDistribution(call, new Set()).kind).toBe(f.kind);
    expect(scanDistribution(`X ~ ${call}`)).toEqual({ name: 'X', rhs: call });
    // Undeclared left side: never a regression, whatever the spelling.
    expect(scanRegressions([`X ~ ${call}`]).size).toBe(0);
    // Declared data on the left: a model only for the spellings marked as one.
    expect(scanRegressions(['Y = [1, 2, 3]', `Y ~ ${call}`]).size).toBe(isModelName(n) ? 1 : 0);
    const text = `X ~ ${n}(`;
    expect(syntaxHelp(text, text.length, emptyDefs()).hint).toContain(distUsage(f));
  });

  it('the unknown-distribution hint lists every family', () => {
    for (const f of DIST_FAMILIES) {
      expect(() => parseDistribution('Nope(1)', new Set())).toThrow(distUsage(f));
    }
  });

  it('model spellings are exactly the ones that mean something else too', () => {
    expect(DIST_FAMILIES.flatMap(f => f.modelNames ?? []).sort()).toEqual(['beta', 'exp', 'gamma', 't']);
    // Bare, a function name cannot be a model; a coefficient name can.
    expect(scanRegressions(['Y = [1, 2]', 'Y ~ exp', 'Y ~ GAMMA']).size).toBe(0);
    expect(scanRegressions(['Y = [1, 2]', 'Y ~ beta', 'Y ~ T']).size).toBe(2);
  });
});
