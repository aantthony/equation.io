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
  it('honors user shadowing of builtins', () => {
    const d = emptyDefs(); d.consts.set('mean', {kind:'num',value:3});
    expect(syntaxHelp('mea', 3, d).suggestions.find(s => s.name === 'mean')?.call).toBe(false);
    expect(syntaxHelp('mean(', 5, d).hint).toBeUndefined();
  });
});
