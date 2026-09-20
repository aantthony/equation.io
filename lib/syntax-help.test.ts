import { describe, expect, it } from 'vitest';
import { buildDefs, emptyDefs, scanDefinition, type Definition } from './defs.ts';
import { parseCsv } from './csv.ts';
import { syntaxHelp } from './syntax-help.ts';

const defs = () => buildDefs(['amplitude = 2', 'f(x,q) = x+q', 'wave(x) = sin(x)', 'L = [1,2]', 'data = open("people.csv")']
  .map(scanDefinition).filter((d): d is Definition => !!d), () => parseCsv('age,height\n20,170')).defs;

describe('contextual syntax help', () => {
  it('suggests builtins and replaces the entire token when the caret is in its middle', () => {
    const h = syntaxHelp('y = sqroot', 6, defs());
    expect(h.start).toBe(4); expect(h.end).toBe(10);
    expect(h.suggestions.some(s => s.name === 'sqrt')).toBe(true);
  });
  it('distinguishes motion trails from matrix trace in suggestions and hints', () => {
    const suggestions = syntaxHelp('tra', 3, defs()).suggestions;
    expect(suggestions.map(s => s.signature)).toEqual(['trace(M)', 'trail(point)']);
    expect(syntaxHelp('trail(', 6, defs()).hint).toContain('Draw a moving point’s path');
    expect(syntaxHelp('TRAIL(', 6, defs()).hint).toContain('trail(point)');
    expect(syntaxHelp('trace(', 6, defs()).hint).toContain('Matrix trace');
  });
  it('describes the polyline and vector geometry statements', () => {
    expect(syntaxHelp('polyl', 5, defs()).suggestions.map(s => s.signature)).toEqual(['polyline(A, B, C, …)']);
    expect(syntaxHelp('vector(', 7, defs()).hint).toContain('from the origin to V');
  });
  it('describes revolve', () => {
    expect(syntaxHelp('revo', 4, defs()).suggestions.map(s => s.signature)).toEqual(['revolve(f(x))']);
    expect(syntaxHelp('revolve(', 8, defs()).hint).toContain('about the x-axis');
  });
  it('describes the distance and angle measurements', () => {
    expect(syntaxHelp('dista', 5, defs()).suggestions.map(s => s.signature)).toEqual(['distance(A, B)']);
    expect(syntaxHelp('angle(', 6, defs()).hint).toContain('angle(A, B, C) or angle(U, V)');
  });
  it('suggests defined values, functions and CSV columns', () => {
    expect(syntaxHelp('a', 1, defs()).suggestions.find(s => s.name === 'amplitude')?.call).toBe(false);
    expect(syntaxHelp('wa', 2, defs()).suggestions.find(s => s.name === 'wave')?.signature).toBe('wave(x)');
    expect(syntaxHelp('data.', 5, defs()).suggestions.map(s => s.name)).toEqual(['data.age', 'data.height']);
  });
  it('shows nested call signatures and falls back to the enclosing function', () => {
    expect(syntaxHelp('f(sin(', 6, defs()).hint).toContain('sin(x)');
    expect(syntaxHelp('f(sin(x), ', 10, defs()).hint).toContain('f(x, q)');
    expect(syntaxHelp('Y ~ ', 4, defs()).hint).toContain('unbound coefficients');
  });
  it('suppresses suggestions in comments and strings, but allows derivatives', () => {
    expect(syntaxHelp('# sq', 4, defs()).suggestions).toEqual([]);
    expect(syntaxHelp('open("sq', 8, defs()).suggestions).toEqual([]);
    expect(syntaxHelp("q' = sq", 7, defs()).suggestions.some(s => s.name === 'sqrt')).toBe(true);
  });
  it.each(['Sin(', 'SIN(', 'sin('])('shows the builtin signature for %s', text => {
    expect(syntaxHelp(text, text.length, defs()).hint).toContain('sin(x)');
  });
  it.each(['normal(', 'NORMAL(', 'Normal('])('shows the distribution signature for %s', text => {
    expect(syntaxHelp(text, text.length, defs()).hint).toContain('Normal(mean, sd)');
  });
  it('shows the zoo signatures, parameterisation included', () => {
    expect(syntaxHelp('X ~ Gamma(', 10, defs()).hint).toContain('Gamma(shape, rate)');
    expect(syntaxHelp('X ~ Gamma(', 10, defs()).hint).toContain('rate, not scale');
    expect(syntaxHelp('X ~ weibull(', 12, defs()).hint).toContain('Weibull(shape, scale)');
    expect(syntaxHelp('X ~ LOGNORMAL(', 14, defs()).hint).toContain('LogNormal(mu, sigma)');
    expect(syntaxHelp('Ca', 2, defs()).suggestions.some(s => s.name === 'Cauchy')).toBe(true);
  });
  it('reads gamma and T as distributions only right of a ~', () => {
    expect(syntaxHelp('X ~ gamma(', 10, defs()).hint).toContain('Gamma(shape, rate)');
    expect(syntaxHelp('X ~ T(', 6, defs()).hint).toContain('StudentT(df)');
    expect(syntaxHelp('X ~ chisq(', 10, defs()).hint).toContain('ChiSquared(df)');
    expect(syntaxHelp('y = gamma(', 10, defs()).hint).toContain('gamma(x)');
    expect(syntaxHelp('GAMMA(', 6, defs()).hint).toContain('gamma(x)');
    expect(syntaxHelp('T(', 2, defs()).hint).toBeUndefined();
    // A user's own T(…) keeps its signature even there.
    const d = defs();
    d.fns.set('T', { params: ['q'], body: { kind: 'var', name: 'q' } });
    expect(syntaxHelp('X ~ T(', 6, d).hint).toContain('T(q)');
  });
  it('reads a distribution name only at the head of a ~ row, not inside its arguments', () => {
    const hint = (text: string) => syntaxHelp(text, text.length, defs()).hint ?? '';
    expect(hint('X ~ Normal(gamma(')).toContain('gamma(x)');
    expect(hint('Y ~ a gamma(')).toContain('gamma(x)');
    expect(hint('W ~ Normal(0, t(')).not.toContain('StudentT');
    expect(hint('Z ~ Normal(0, beta(')).not.toContain('Beta(a, b)');
    expect(hint('Z ~ Normal(0, (2 + chisq(')).not.toContain('ChiSquared');
    expect(hint('f(q) = gamma(')).toContain('gamma(x)');
    // Inside the head call's own arguments the head's signature still shows.
    expect(hint('X ~ Gamma(2, (1 + ')).toContain('Gamma(shape, rate)');
    expect(hint('X ~  gamma (')).toContain('Gamma(shape, rate)');
    // Over declared data these names are models, as the row itself will be read.
    const d = defs();
    d.lists.set('Y', { kind: 'list', items: [] } as never);
    expect(syntaxHelp('Y ~ gamma(', 10, d).hint).toContain('gamma(x)');
    expect(syntaxHelp('Y ~ Weibull(', 12, d).hint).toContain('Weibull(shape, scale)');
  });
  it('keeps user function names case-sensitive and gives exact definitions priority', () => {
    const d = defs();
    expect(syntaxHelp('wave(', 5, d).hint).toContain('wave(x)');
    expect(syntaxHelp('Wave(', 5, d).hint).toBeUndefined();
    d.fns.set('Normal', { params: ['q'], body: { kind: 'var', name: 'q' } });
    expect(syntaxHelp('Normal(', 7, d).hint).toContain('Normal(q)');
    expect(syntaxHelp('NORMAL(', 7, d).hint).toContain('Normal(mean, sd)');
  });
  it('honors user shadowing of builtins', () => {
    const d = emptyDefs(); d.consts.set('mean', {kind:'num',value:3});
    expect(syntaxHelp('mea', 3, d).suggestions.find(s => s.name === 'mean')?.call).toBe(false);
    expect(syntaxHelp('mean(', 5, d).hint).toBeUndefined();
    expect(syntaxHelp('Mean(', 5, d).hint).toBeUndefined();
  });
  it('suggests symbol escapes for a \\word, replacing the backslash too', () => {
    const h = syntaxHelp('y = \\pi', 7, defs());
    expect(h.start).toBe(4); // covers the backslash
    const pi = h.suggestions.find(s => s.name === '\\pi');
    expect(pi).toMatchObject({ insert: 'π', call: false });
    expect(syntaxHelp('\\', 1, defs()).suggestions.length).toBe(6);
    expect(syntaxHelp('\\nab', 4, defs()).suggestions.map(s => s.insert)).toEqual(['∇']);
    // Unknown names hint at the feature instead of listing functions.
    const unknown = syntaxHelp('\\zz', 3, defs());
    expect(unknown.suggestions).toEqual([]);
    expect(unknown.hint).toContain('\\pi');
    // An escaped backslash is a literal one: no symbol suggestions for \\pi.
    expect(syntaxHelp('\\\\pi', 4, defs()).suggestions.some(s => s.insert)).toBe(false);
  });
  it('completes user definitions with Greek names', () => {
    const d = emptyDefs(); d.consts.set('θmax', {kind:'num',value:3});
    expect(syntaxHelp('θ', 1, d).suggestions.map(s => s.name)).toEqual(['θmax']);
  });
});
