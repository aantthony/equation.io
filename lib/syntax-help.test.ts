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
});
