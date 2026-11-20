/**
 * Targeted documents for apple/corpus/analysis.ts: split views, mapped axes
 * (lib/axis-map.ts), coordinate grids (lib/grid.ts) and states (lib/ode.ts).
 * One concern each, rows separated as the examples' are.
 */
import type { Analysis } from '../../lib/analysis.ts';
import { compileGridCpu, compileGridGpu } from '../../lib/compiler.ts';
import { evaluate } from '../../lib/expr.ts';
import { orbitInput, traceOrbit } from '../../lib/orbit.ts';
import { panelIndices } from '../../lib/panels.ts';
import { advanceState, initialState } from '../../lib/state.ts';

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
      return {
        name: spec.name,
        panel: panelOf.get(spec.name) ?? 0,
        cpu: compileGridCpu(spec),
        gpu: compileGridGpu(spec),
      };
    } catch (err) {
      return { name: spec.name, error: (err as Error).message };
    }
  });
}

const text = (v: number) => (Number.isSafeInteger(v) ? v : String(v));

/**
 * A document's state system as the site runs it: where each state starts,
 * where a run stepped frame by frame (60 a second, as web/main.ts
 * currentConstEnv steps it) has them after half a second and after two, and
 * each orbit row's polyline, thinned to a few of its points (lib/orbit.ts).
 */
export function recordStates(analysis: Analysis): unknown {
  const sys = analysis.document.stateSystem;
  if (!sys) return null;
  const defs = analysis.defs;
  const initial = initialState(defs, sys);
  const values = { ...initial };
  const runs: unknown[] = [];
  let reached = 0;
  for (let frame = 1; frame <= 120; frame++) {
    reached = advanceState(defs, sys, values, reached, frame / 60);
    if (frame === 30 || frame === 120)
      runs.push({ time: frame / 60, reached: text(reached), values: sys.names.map(n => text(values[n])) });
  }
  const orbits = analysis.rows.map(row => {
    if (row.cpu?.type !== 'orbit' || row.error) return null;
    try {
      const plot = row.cpu;
      const pts = traceOrbit(
        orbitInput(
          defs,
          plot.paths,
          plot.series,
          evaluate(plot.from, analysis.constEnv),
          evaluate(plot.to, analysis.constEnv),
          analysis.constEnv,
        ),
      );
      const step = Math.max(1, Math.floor(pts.length / 40));
      return { count: pts.length, step, points: pts.filter((_, k) => k % step === 0).map(p => p.map(text)) };
    } catch (err) {
      return { error: (err as Error).message };
    }
  });
  return { names: sys.names, initial: sys.names.map(n => text(initial[n])), runs, orbits };
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
  'view(x = 1..100, x = 10^X); segment((1, 1), (10, 2)); label((10, 1), "ten"); polygon((1, 0), (10, 0), (10, 1))',
  'view(y = 10^Y); A = (1, 10); B = (3, 100); segment(A, B); vector(A, B); (1, 2, 3, 4); circle(A, 2); A + B',
  // Coordinate grids: the fields that grid a panel, and grid(…) naming them.
  'r = sqrt(x^2 + y^2); theta = atan2(y, x); r = 2; theta = pi/4',
  'a = 2; r = sqrt(x^2 + y^2)/a; th = atan(y, x) + t; s = x + z; q = u^2; k = floor(x); A = (x, y); y = r',
  'r = sqrt(x^2 + y^2); grid(r); ---; grid(r, theta); theta = atan2(y, x); ---; grid(x, y); ---; grid(theta, x)',
  'grid(r); ---; grid(z); ---; grid(x, x); ---; grid(1 + 2); ---; grid(a, b, c, d); ---; grid(q); q = x z; ---; grid(sin()',
  'm = x y; n = x^2 - y^2; grid(m, n); m = 1; n = 2; ---; grid(ON); grid(Axes); ---; grid(m,); grid(,n)',
  'r = sqrt(x^2 + y^2); within = r < 2; ---; p = x + y; grid(p, r, within); ---; grid(off); c = 2 x; A = (1, 2); grid(A_x)',
  'u1 = ln(sqrt(x^2 + y^2)); v1 = atan2(y, x); w1 = gamma(x) + y; e1 = erf(x) y; grid(u1, v1)',
  // States: the system, its starting values, what reads a state, and its errors.
  "a' = -a; a(0) = 1; y = a x; a; a + 1; (a, 1); a > 0.5",
  "th' = om; om' = -sin(th) - om/8; th(0) = 3; bob = (sin(th), -cos(th)); bob; (th, om); y = th; th + om",
  "k = 2; p' = v1; v1' = -k p; p(0) = k/2; e1 = v1^2/2 + k p^2/2; e1; y = e1; x = p; view(x = -p..p)",
  "pos' = vel; vel' = sin(2t) - pos - vel/5; X = (pos, vel); X; X(0..6); pos(0..6); (t, pos)",
  "b = 0.3; g = 0.1; S' = -b S sick; sick' = b S sick - g sick; S(0) = 0.99; sick(0) = 0.01; R = 1 - S - sick; S(0..20); R(0..20)",
  "r' = (10(r_2 - r_1), r_1(28 - r_3) - r_2, r_1 r_2 - 8 r_3/3); r(0) = (1, 1, 20); q = (r_1/4, r_3/4 - 6); q(1..3); q; r_1",
  "w' = (w_2, -w_1); w(0) = (1, 0); w; w(0..3); w_1 + w_2; (w_1, w_2); c' = 1; c(0) = (1, 2); d2' = (1, 2); d2(0) = 3",
  "a' = x; b' = q; c' = c2; c2 = 1; c(0) = t; h' = h; h(0) = h; m(0) = 1; n' = 1; n = 2; f' = 1; f(s) = s",
  "a' = -a; a(0) = 1; a' = 2; a(0) = 3; a = 4; y = a x",
  "a' = b; b' = -a; a(0) = 1; a(5..1); a(-1..2); a(0..x); a(0..a); (a, b, 1)(0..1); a(0..1) + 1; (1, 2)(0..1); a(0..t)",
  "s' = -s/2; s(0) = 2; s(0..4); (s, s^2)(0..4); c = s + 1; c(0..2); k = 3; k(0..2); (t, s)(1..2); y = s(0..1)",
  "a' = sin(; a(0) = 1; b' = -b; b(0) = (; c' = 1/0; c; d2' = ln(-1); d2",
  "u1' = -u1; u1(0) = 1; view(x = 0..u1); grid(u1); ---; view(x = 10^X); (u1 + 1, 1); y = u1 x",
  "th' = om; om' = -sin(th); th(0) = [1..12]/4; (th, om); y = x",
  "r' = vel; vel' = -9 r/|r|^3; r(0) = (2, 0); vel(0) = (0, 1.5); r; (0, 0)",
  // Trails: where a moving point has been.
  'A = (2cos(3t), 2sin(2t)); trail(A); trail((cos(t), sin(t))); trail(cos(t), t); a = 2; trail((a, t)); trail(A + (1, 1))',
  "th' = om; om' = -sin(th); th(0) = 1; trail((th, om)); trail(th, om); view(x = 10^X); trail((th + 5, 1))",
  'trail(1); trail((1, 2, 3)); trail((x, y)); trail((u, 1)); 1 + trail((1, 2)); trail((1, 2)) + 1; (trail((1, 2)), 1)',
  'B = trail((t, 1)); trail(); trail(1, 2, 3, 4); trail((t, 1), (1, t)); trail((t, q)); y = trail((t, 1)); trail(t, t, t)',
];
