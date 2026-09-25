import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { searchSyntax, syntaxEntries } from './syntax-search.ts';

const reference = readFileSync(new URL('../web/public/llms.txt', import.meta.url), 'utf8');
const entries = syntaxEntries(reference);

describe('syntax search over llms.txt', () => {
  it('splits into sectioned entries, leaving out link and MCP material', () => {
    expect(entries.length).toBeGreaterThan(50);
    const sections = new Set(entries.map(e => e.section));
    expect(sections.has('Row types')).toBe(true);
    expect(sections.has('Deep links')).toBe(false);
    expect(sections.has('MCP server')).toBe(false);
  });

  it.each([
    ['parametric surface', 'Parametric surface: three components in u and v'],
    ['vector field', 'vector field'],
    ['polar coordinates', 'theta'],
    ['random variable normal distribution', 'Normal('],
    ['text label', 'label('],
    ['camera spin', 'spin = '],
  ])('finds %s', (query, expected) => {
    const found = searchSyntax(entries, query);
    expect(found).toContain(expected);
    expect(found.length).toBeLessThanOrEqual(6000);
  });

  it('lists the sections when nothing matches', () => {
    expect(searchSyntax(entries, 'zzqx')).toMatch(/^Nothing matched "zzqx"\. Sections: .*Row types/);
  });
});
