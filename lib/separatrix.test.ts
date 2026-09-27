import { describe, expect, it } from 'vitest';
import { analyzeRows } from './analysis.ts';
import { criticalFinder } from './separatrix.ts';

/** H at the critical points hamiltonian(H) draws through (lib/separatrix.ts). */
function levels(rows: string[], box = { x0: -10, x1: 10, y0: -6, y1: 6 }) {
  const analysis = analyzeRows(rows);
  const o = analysis.rows.at(-1)!.cls!.object;
  if (o.kind !== 'vector-field' || !o.levels) throw new Error(o.kind);
  const find = criticalFinder(o.levels.expr, o.levels.params)!;
  return find({ ...analysis.constEnv }, box);
}

describe('critical levels of H', () => {
  it('is one separatrix through all of a pendulum’s saddles', () => {
    // Saddles at ±π and ±3π, all at H = 1; the wells at 0 and ±2π at H = −1.
    const { separatrices, critical } = levels(['hamiltonian(y^2/2 - cos(x))']);
    expect(separatrices).toHaveLength(1);
    expect(separatrices[0]).toBeCloseTo(1, 9);
    expect(critical).toHaveLength(2);
    expect(critical[0]).toBeCloseTo(-1, 9);
  });
  it('is the level through a double well’s hump, following a slider', () => {
    // H = y²/2 + x⁴/4 − k x²/2: saddle at the origin (H = 0), wells at ±√k
    // (H = −k²/4).
    const { separatrices, critical } = levels(['k = 2', 'hamiltonian(y^2/2 + x^4/4 - k x^2/2)']);
    expect(separatrices).toEqual([0]);
    expect(critical[0]).toBeCloseTo(-1, 9);
    const shifted = levels(['k = 2', 'hamiltonian(y^2/2 + x^4/4 - k x^2/2 + k)']);
    expect(shifted.separatrices[0]).toBeCloseTo(2, 9);
  });
  it('has no separatrix for a harmonic oscillator, only its well', () => {
    expect(levels(['hamiltonian(y^2/2 + x^2/2)'])).toEqual({ separatrices: [], critical: [0] });
  });
  it('only counts points in the box', () => {
    const { separatrices } = levels(['hamiltonian(y^2/2 - cos(x))'], { x0: -2, x1: 2, y0: -2, y1: 2 });
    expect(separatrices).toEqual([]);
  });
});
