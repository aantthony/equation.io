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
    // Short words and symbols match whole: pi, ln, d/dx and Σ are all in the manual.
    ['pi', '- Constants: `pi`'],
    ['ln', 'ln('],
    ['d/dx', '- Derivatives: `d/dx (x^3)`'],
    ['Σ', 'Σ'],
    ['π', '- Constants: `pi`'],
  ])('finds %s', (query, expected) => {
    const found = searchSyntax(entries, query);
    expect(found).toContain(expected);
    expect(found.length).toBeLessThanOrEqual(6000);
  });

  it('does not match a short word inside a longer one', () => {
    const entries = [
      { section: 'A', text: '- Spin: a camera spin.' },
      { section: 'B', text: '- Constants: pi and tau.' },
    ];
    expect(searchSyntax(entries, 'pi')).toBe('## B\n- Constants: pi and tau.');
  });

  it('keeps the best entries when the budget runs short, skipping ones that do not fit', () => {
    const entries = [
      { section: 'Early', text: `- Long: surface ${'x'.repeat(500)}` },
      { section: 'Early', text: '- Aside: surface.' },
      { section: 'Late', text: '- Parametric surface: surface in u and v, a surface.' },
    ];
    const found = searchSyntax(entries, 'parametric surface', 6, 120);
    expect(found).toContain('Parametric surface');
    expect(found).toContain('Aside');
    expect(found).not.toContain('Long');
    expect(found.length).toBeLessThanOrEqual(120);
    // Printed in document order.
    expect(found.indexOf('Aside')).toBeLessThan(found.indexOf('Parametric'));
  });

  it('lists the sections when nothing matches', () => {
    expect(searchSyntax(entries, 'zzqx')).toMatch(/^Nothing matched "zzqx"\. Sections: .*Row types/);
  });
});
