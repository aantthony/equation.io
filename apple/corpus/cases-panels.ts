/**
 * Targeted documents for apple/corpus/analysis.ts: split views, mapped axes
 * (lib/axis-map.ts), coordinate grids (lib/grid.ts) and states (lib/ode.ts).
 * One concern each, rows separated as the examples' are.
 */
import type { Analysis } from '../../lib/analysis.ts';
import { compileGridCpu, compileGridGpu } from '../../lib/compiler.ts';
import { panelIndices } from '../../lib/panels.ts';

/** A document's coordinate fields as web/main.ts compiles them (reconcile),
 *  each with the panel its definition is in (gridFieldPanels). */
export function recordGridFields(analysis: Analysis): unknown[] {
  const panels = panelIndices(analysis.rows);
  const panelOf = new Map<string, number>();
  analysis.rows.forEach((row, i) => {
    if (row.def && !panelOf.has(row.def.name)) panelOf.set(row.def.name, panels[i]);
  });
  return analysis.gridFields.map(spec => {
    try {
      return { name: spec.name, panel: panelOf.get(spec.name) ?? 0, cpu: compileGridCpu(spec), gpu: compileGridGpu(spec) };
    } catch (err) {
      return { name: spec.name, error: (err as Error).message };
    }
  });
}

export const PANEL_CASES: string[] = [
  // Panels: each frames itself; definitions are document-wide.
  'f(x) = x^2; y = f(x); view(x = -2..2); --- below 40%, shared x; y = d/dx f(x); view(y = -4..4); grid(axes)',
  'y = x; --- right; view(x = 0..1); view(y = 0..1); --- inset bottom left 25%; grid(off); grid(on)',
  'a = 2; y = a x; ---; A = (1, a); A; --- below, shared x y; view(x = 1..a, locked); (a, 1)',
  '---; ---; ---; ---; ---; ---; ---; ---; y = x',
  '--- top bottom; --- left right; --- 40% 50%; --- shared; --- shared z; --- above left; --- 0%; --- top-left 20%',
  // Mapped axes: the map, its window, and its errors.
  'view(x = 1..1000, x = 10^X); y = x^2; y = sqrt(x); x = 3; x y = 1; x^2 + y^2 = 100',
  'view(y = 1..100000, y = 10^Y); y = e^x; y = x^4; y < x; 2 < y < 10 x; sin(x) y; x + y',
  'view(x = 0.1..1000, y = 0.01..100000, x = 10^X, y = 10^Y); y = x^2; y = 10/x; x = y; y = y; x y; x < y',
  'view(x = -1000..1000, y = -2..2, x = sinh(X)); y = cos(ln(abs(x))); y = tanh(x/50); (1, 1); (x, y)',
  'view(x = 2 exp(X/3) - 1); y = x; view(y = sqrt(Y))',
  'view(x = X^3, x = 1..8); y = x; ---; view(y = Y^2, y = 1..4); y = x; ---; view(x = ln(X)); y = x',
  'b = 2; view(x = 1..64, x = b^X); y = x; c = t; ---; view(x = c^X); y = x; ---; view(x = q^X)',
  'view(x = 10^X, x = 2^X); ---; view(x = -X); ---; view(x = sin(X)); ---; view(x = 10^Y); ---; view(x = X +)',
  'view(x = -1..10, x = 10^X); ---; view(x = 10^X, y = 0..1); y = x; ---; view(y = 10^Y, ratio = 2, locked); y = x',
  'view(x = 10^X, i = 0..5); ---; view(x = cos X); ---; view(x = 10^X, x = 1..10, x = 2..3)',
  'view(x = log(X), x = 0..1); y = x; ---; view(x = log2(X)); ---; view(y = asinh(Y)); y = x^3; ---; view(y = 3 - 2/Y)',
  // What a mapped panel draws: substituted, placed, read out, refused.
  'view(x = 1..100, x = 10^X); a = 2; y = a x; a x; (a, a); A = (10, 1); A; (10 u + 1, u); 1 + a; a = 2; 2 < 1',
  "view(x = 1..100, y = 1..100, x = 10^X, y = 10^Y); (y, -x); y' = y/x; dy/dx = x; (x', y') = (x, y); (1, x)",
  'view(y = 10^Y); r = sqrt(x^2 + y^2); r = 2; r < 3; r; th = atan2(y, x); th = 1; within = y > 1; {within: x}',
  'view(x = 10^X); k = 2; x^2 + y^2 = k; k = x y; y = d/dx x^3; y = {x > 10: 1, 0}; f(x) = x^2; y = f(x); f(y) = x',
  'y = x^2; ---; view(x = 1..100, x = 10^X); y = x^2; ---; y = x^2',
  'view(x = 10^X); z = x y; (1, 2, 3); x^2 + y^2 + z^2 = 1',
  // Coordinate grids: the fields that grid a panel, and grid(…) naming them.
  'r = sqrt(x^2 + y^2); theta = atan2(y, x); r = 2; theta = pi/4',
  'a = 2; r = sqrt(x^2 + y^2)/a; th = atan(y, x) + t; s = x + z; q = u^2; k = floor(x); A = (x, y); y = r',
  'r = sqrt(x^2 + y^2); grid(r); ---; grid(r, theta); theta = atan2(y, x); ---; grid(x, y); ---; grid(theta, x)',
  'grid(r); ---; grid(z); ---; grid(x, x); ---; grid(1 + 2); ---; grid(a, b, c, d); ---; grid(q); q = x z; ---; grid(sin()',
  'm = x y; n = x^2 - y^2; grid(m, n); m = 1; n = 2; ---; grid(ON); grid(Axes); ---; grid(m,); grid(,n)',
  'r = sqrt(x^2 + y^2); within = r < 2; ---; p = x + y; grid(p, r, within); ---; grid(off); c = 2 x; A = (1, 2); grid(A_x)',
  'u1 = ln(sqrt(x^2 + y^2)); v1 = atan2(y, x); w1 = gamma(x) + y; e1 = erf(x) y; grid(u1, v1)',
];
