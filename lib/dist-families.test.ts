import { emptyEnv } from './env.ts';
import { describe, expect, it } from 'vitest';

import { parseDistribution, scanDistribution } from './dist.ts';
import { DIST_FAMILIES, distFamily, distUsage, isModelName } from './dist-families.ts';
import { scanRegressions, tildeRow } from './regression.ts';
import { syntaxHelp } from './syntax-help.ts';

/** Every spelling of every family, with enough literal arguments to parse. */
const spellings = DIST_FAMILIES.flatMap(f =>
  [f.name, ...f.aliases]
    .flatMap(n => [n, n.toLowerCase(), n.toUpperCase()])
    .map(n => ({ f, n, call: `${n}(${f.params.map((p, k) => (p.unit ? 0.5 : k + 1)).join(', ')})` })),
);

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
    expect(syntaxHelp(text, text.length, emptyEnv()).hint).toContain(distUsage(f));
  });

  it('the unknown-distribution hint lists every family', () => {
    for (const f of DIST_FAMILIES) {
      expect(() => parseDistribution('Nope(1)', new Set())).toThrow(distUsage(f));
    }
  });

  it('model spellings are exactly the ones that mean something else too', () => {
    expect(DIST_FAMILIES.flatMap(f => f.modelNames ?? []).sort()).toEqual(['beta', 'exp', 'gamma', 't']);
  });

  // What these rows were before the families existed is what they still are.
  it.each(['exp', 'gamma', 'beta', 't', 'Gamma', 'BETA', 'T'])(
    '%s over declared data stays a regression in every form',
    name => {
      const forms = [
        `Y ~ ${name}(a X)`,
        `Y ~ ${name} (X - 1) + c`,
        `Y ~ ${name} X`,
        `Y ~ ${name} x + b`,
        `Y ~ a ${name}(X)`,
      ];
      expect([...scanRegressions(['Y = [1, 2, 3]', ...forms]).keys()]).toEqual([1, 2, 3, 4, 5]);
      // Bare: a regression too — except `exp`, the Exponential alias main already carved out.
      expect(scanRegressions(['Y = [1, 2, 3]', `Y ~ ${name}`]).size).toBe(/^exp$/i.test(name) ? 0 : 1);
      // …and with nothing declared on the left, every form is left to the distribution path.
      expect(scanRegressions([`W ~ ${name}`, `W ~ ${name}(2)`]).size).toBe(0);
    },
  );

  it('help asks the same predicate the row is read by', () => {
    const hint = (text: string, declared: string[]) =>
      syntaxHelp(text, text.length, emptyEnv(), new Set(declared)).hint ?? '';
    for (const [text, declared] of [
      ['Y ~ gamma(', ['Y']],
      ['Y ~ gamma(', []],
      ['Y ~ Weibull(', ['Y']],
      ['d.col ~ gamma(', []],
      ['f("a~b") ~ gamma(', []],
      ['Y ~ T(', ['Y']],
      ['Y ~ T(', ['Z']],
      ['[1, 2] ~ beta(', []],
    ] as Array<[string, string[]]>) {
      const row = tildeRow(text, new Set(declared))!;
      expect(hint(text, declared).includes('— Declare'), `${text} | ${declared}`).toBe(!row.regression);
    }
    // A ~ inside quotes or parens is not the row's ~: no distribution hint at all.
    expect(hint('g("~") + gamma(', [])).toContain('gamma(x)');
    expect(hint('h(a ~ gamma(', [])).not.toContain('— Declare');
    // A definition that failed to parse still declares its name, as scanRegressions sees it.
    expect(hint('Y ~ gamma(', ['Y'])).toContain('gamma(x)');
  });
});
