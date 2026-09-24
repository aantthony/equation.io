import { describe, expect, it } from 'vitest';
import { analyzeRows } from './analysis.ts';

const kinds = (rows: string[]) => analyzeRows(rows).rows.map(r => r.error ?? r.cls?.object.kind ?? r.def?.kind);

describe('named curves and surfaces', () => {
  it('inline a named parametric vector into later rows', () => {
    // Before, c_y failed: "can only depend on other constants and t (found u)".
    expect(kinds(['c = (cos(2pi u), sin(2pi u))', 'c', '2c', 'c + (1, 0)'])).toEqual(['const', 'curve', 'curve', 'curve']);
    expect(kinds(['A = [(2, 1), (1, 1)]', 'c = (cos(2pi u), sin(2pi u))', 'A c'])).toEqual(['const', 'const', 'curve']);
    expect(kinds(['S = (sin(pi v)cos(2pi u), sin(pi v)sin(2pi u), cos(pi v))', '2S'])).toEqual(['const', 'surface']);
    expect(kinds(['k = u^2', '(u, k)'])).toEqual(['const', 'curve']);
  });

  it('draws the same curve as writing it inline', () => {
    const named = analyzeRows(['A = [(2, 1), (1, 1)]', 'c = (cos(2pi u), sin(2pi u))', 'A c']).rows[2].cls!.object;
    const inline = analyzeRows(['A = [(2, 1), (1, 1)]', 'A (cos(2pi u), sin(2pi u))']).rows[1].cls!.object;
    expect(named).toEqual(inline);
  });

  it('draws no grid of its own', () => {
    expect(analyzeRows(['k = u^2', 'c = (u, u^2)']).gridFields).toEqual([]);
  });
});
