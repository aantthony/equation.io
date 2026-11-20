/**
 * Targeted documents for a panel's metric (ds^2 rows, geodesics, light
 * cones, tidal forces) and for the corners other kinds left
 * (apple/corpus/analysis.ts runs them with its own), and what the site
 * draws of a metric's rows over a fixed window, from lib/surface-geometry.ts,
 * lib/light-cone.ts and lib/tidal.ts. One concern each, rows separated as
 * the examples' are.
 */
import type { Analysis } from '../../lib/analysis.ts';
import type { CpuPlan } from '../../lib/compiler.ts';
import { behindHorizon, coneGlyphs, type ConeView, indicatrixScale } from '../../lib/light-cone.ts';
import {
  type GeodesicEnd,
  geodesicCutNote,
  geodesicPath,
  metricOrientation,
  metricValues,
  numericIn,
  traceWindow,
} from '../../lib/surface-geometry.ts';
import { tidalGlyphs, tidalReader, tidalScale } from '../../lib/tidal.ts';

const SCHWARZSCHILD =
  'r = sqrt(x^2 + y^2); phi = atan2(y, x); M = 1; ds^2 = -(1 - 2M/r) dt^2 + dr^2/(1 - 2M/r) + r^2 dphi^2';
const KERR =
  'r = sqrt(x^2 + y^2); phi = atan2(y, x); M = 1; a = 0.9; ' +
  'ds^2 = -(1 - 2M/r) dt^2 - 4 M a/r dt dphi + r^2/(r^2 - 2M r + a^2) dr^2 + (r^2 + a^2 + 2M a^2/r) dphi^2';

export const LEFTOVER_CASES: string[] = [
  // The metric row: its signatures, coordinates and readouts.
  'ds^2 = dx^2 + dy^2; y = x',
  'ds^2 = (dx^2 + dy^2)/y^2; y < 0; x^2 + y^2 = 4',
  'ds² = -dy^2 + dx^2; ds ^ 2 = dx^2 - dy^2',
  'ds^2 = -dx^2 + dy^2; lightcones',
  'ds^2 = 2 dx dy; lightcones; geodesic((0, 0), (1, 1))',
  'ds^2 = x dx^2 + dy^2; geodesic((1, 0), (1, 1)); geodesic((-1, 0), (0, 1)); lightray((-1, 0), (1, 0)); lightcones',
  'ds^2 = -dt^2 + dx^2 + dy^2; lightcones; tidal',
  'ds^2 = -dτ^2 + dx^2 + dy^2; ds^2 = -dtau^2 + dx^2 + dy^2',
  `${SCHWARZSCHILD}; r < 2M; r = 3M; y = x`,
  `${KERR}; r < M + sqrt(M^2 - a^2)`,
  'r = sqrt(x^2 + y^2); phi = atan2(y, x); ds^2 = dr^2 + r^2 dphi^2; geodesic((1, 0), (0, 1), 3)',
  'phi = atan2(y, x); r = sqrt(x^2 + y^2); ds^2 = dr^2 + sinh(r)^2 dphi^2; geodesic((1, 0), ([0..3], 1))',
  'k = 2; ds^2 = k (dx^2 + dy^2)/(1 + x^2 + y^2)^2; geodesic((0, 0), (1, 0)); k = 3',
  'ds^2 = abs(y) dx^2 + dy^2; ds^2 = floor(x) dx^2 + dy^2',
  // What a ds^2 row refuses.
  'ds^2 = dx^2; ds^2 = dy^2 + dz^2',
  'ds^2 = dr^2 + dphi^2',
  'ds^2 = dr^2 + r^2 dphi^2 + dx^2; r = sqrt(x^2 + y^2); phi = atan2(y, x)',
  'ds^2 = -dt^2 + dx^2 + dy^2 + dq^2',
  'ds^2 = -t dt^2 + dx^2 + dy^2',
  'ds^2 = -dq^2 q + dx^2 + dy^2',
  'ds^2 = dx^2 + dy^2 + dx',
  'ds^2 = dx^3 + dy^2',
  'ds^2 = -dx^2 - dy^2',
  'ds^2 = dt^2 + dx^2 + dy^2',
  'ds^2 = dx^2 + dy^2 + dpi^2; ds^2 = dx^2 + dy^2 + dsin^2',
  'k = 2; ds^2 = dx^2 + dy^2 + dk^2',
  'dr = 3; ds^2 = dr^2 + dx^2 + dy^2',
  'ds^2 = dx^2 + dy^2 + q',
  'ds^2 = dx^2 + dy^2; ds^2 = dx^2 + 2 dy^2',
  'r = x; s = 2 x; ds^2 = dr^2 + ds^2',
  'r = sqrt(x^2 + y^2 + z^2); phi = atan2(y, x); ds^2 = dr^2 + dphi^2',
  'r = x + t; ds^2 = dr^2 + dy^2',
  'ds^2; ds^2 = ; ds^2 < dx^2; ds = 2; ds^2 = dx^2 + dy^2',
  'ds = 3; ds^2 = 9',
  'view(x = 10^X); ds^2 = dx^2 + dy^2; geodesic((1, 1), (1, 0))',
  'ds^2 = dx^2 + dy^2; ---; ds^2 = -dy^2 + dx^2; lightcones; ---; lightcones; geodesic((0, 0), (1, 0))',
  'on((X, Y, Z) = (x, y, x y)); ds^2 = dx^2 + dy^2; lightcones; tidal; lightray((0, 0), (1, 0)); lightcone((0, 0)); y = x',
  // Geodesics and light rays: starts, directions, lengths, families, errors.
  'ds^2 = (dx^2 + dy^2)/y^2; P = (0, 1); a = [0..5] pi/3; geodesic(P, (cos(a), sin(a))); geodesic(P, (1, 0), 2)',
  'ds^2 = (dx^2 + dy^2)/y^2; geodesic((0, 1), (1, 0), [1, 2, 3]); geodesic(([0..2], 1), (0, 1), -1)',
  'ds^2 = (dx^2 + dy^2)/y^2; b = 1.5; geodesic((b, 1), (cos(t), sin(t))); geodesic((0, 1), (1, 0), b)',
  'ds^2 = (dx^2 + dy^2)/y^2; geodesic((0, 1)); geodesic(); geodesic((0, 1), 2); geodesic((0, 1), (1, 0), (1, 2))',
  'ds^2 = (dx^2 + dy^2)/y^2; geodesic((x, 1), (1, 0)); geodesic((q, 1), (1, 0)); geodesic((0, 1), (1, 0), 1, 2)',
  'ds^2 = (dx^2 + dy^2)/y^2; geodesic(([0..2], 1), ([0..3], 1)); geodesic(([0..70], 1), (1, 0))',
  'ds^2 = (dx^2 + dy^2)/y^2; lightray((0, 1), (1, 0)); lightcones; lightcone((0, 1)); tidal; tidal((0, 1))',
  'geodesic((0, 1), (1, 0)); lightray((0, 1), (1, 0)); lightcones; lightcone((1, 2)); tidal; tidal((1, 2))',
  'geodesic((0, 1)); lightray((0, 1)); lightcone(); tidal(1, 2); geodesic(1)',
  'ds^2 = dx^2 + dy^2 + dx; geodesic((0, 1), (1, 0)); lightray((0, 1), (1, 0)); lightcones; tidal; lightcone((0, 0))',
  `${SCHWARZSCHILD}; P = (20, 0); speed = 0.18; geodesic(P, speed (-P.y, P.x)/sqrt(P.x^2 + P.y^2), 1600)`,
  `${SCHWARZSCHILD}; b = [-4..4]; lightray((-30, b), (1, 0)); lightray((5, 0), (0, 1), 40); geodesic((6, 0), (0, 0))`,
  `${SCHWARZSCHILD}; geodesic((6, 0), (0, 2)); geodesic((1, 0), (0, 0.1)); lightray((6, 0), (0, 0)); lightray((1, 0), (1, 0))`,
  `${KERR}; lightray((-20, [2..6]), (1, 0)); geodesic((1.5, 0), (0, 0)); geodesic((8, 0), (0, 0.3), 300)`,
  'M = 1; ds^2 = -(1 - 2M/x) dy^2 + dx^2/(1 - 2M/x); geodesic(([2..5] 2, 0), (0, 1)); lightray((3, 0), ([-1, 1], 1))',
  'M = 1; ds^2 = -(1 - 2M/x) dy^2 + 2 dy dx; geodesic(([3..6], 0), (0, 1)); lightray(([2..12]/4, 0), (0, 1)); geodesic((4, 0), (1, 0))',
  'geodesic(P, d) = P + d; geodesic(1, 2); lightcones = 3; lightcones; tidal = 2; tidal',
  // Light cones and tidal forces: lattices, points, lists, errors.
  'M = 1; ds^2 = -(1 - 2M/x) dy^2 + dx^2/(1 - 2M/x); lightcones; lightcone((4, 0)); lightcone(([3..8], 0)); tidal; tidal((3, 1))',
  'M = 1; ds^2 = -(1 - 2M/x) dy^2 + 2 dy dx; lightcones; tidal; lightcone((1, 1)); tidal(([3..6], 0))',
  `${SCHWARZSCHILD}; lightcones; tidal; lightcone((4, 0)); tidal((6, 0)); P = (5, 5); lightcone(P); tidal(P)`,
  `${KERR}; lightcones; tidal; lightcone((1.8, 0)); tidal((4, 3))`,
  `${SCHWARZSCHILD}; lightcone(4); lightcone((x, 0)); lightcone((q, 0)); tidal(4); tidal((x, 0)); lightcone((1, 2, 3))`,
  `${SCHWARZSCHILD}; lightcone(([0..300], 0)); tidal(([0..300], 0)); lightcone((t, 0)); tidal((M, t))`,
  'r = sqrt(x^2 + y^2); phi = atan2(y, x); M = 1; ds^2 = -(1 - 2M/sqrt(x^2 + y^2)) dt^2 + dr^2/(1 - 2M/r) + r^2 dphi^2; tidal; tidal((5, 1))',
  'L = 3; ds^2 = -(1 - (x^2 + y^2)/L^2) dt^2 + dx^2 + dy^2 + (x dx + y dy)^2/(L^2 - x^2 - y^2); tidal; lightcones',
  'g = 0.2; ds^2 = -(1 + g x)^2 dy^2 + dx^2; tidal; lightcones; geodesic((1, 0), (0, 1)); lightray((1, 0), (1, 1))',
  // gaussian(x, y) under a metric.
  'ds^2 = 4(dx^2 + dy^2)/(1 - x^2 - y^2)^2; gaussian(x, y); x^2 + y^2 = 1; -gaussian(x, y); gaussian((0, 0))',
];

const text = (v: number) => String(v);

/** The window a document's metric rows are drawn over: its view(…) row's,
 *  or 12 across, 600 px each way. */
function viewOf(analysis: Analysis): ConeView {
  let [x0, x1, y0, y1] = [-6, 6, -6, 6];
  for (const row of analysis.rows)
    if (row.view?.kind === 'view' && !row.error) {
      if (row.view.x) [x0, x1] = row.view.x;
      if (row.view.y) [y0, y1] = row.view.y;
      break;
    }
  return { lo: [x0, y0], hi: [x1, y1], upp: (x1 - x0) / 600, uppY: (y1 - y0) / 600 };
}

/** A long list of numbers as its length and every `step`th pair. */
function thin(values: ArrayLike<number>, pairs = 24): unknown {
  const n = values.length / 2;
  const step = Math.max(1, Math.floor(n / pairs));
  const out: string[] = [];
  for (let k = 0; k < n; k += step) out.push(text(values[2 * k]), text(values[2 * k + 1]));
  return { count: values.length, step, values: out };
}

function drawnOf(plan: CpuPlan, env: Record<string, number>, view: ConeView): unknown {
  try {
    if (plan.type === 'geodesic') {
      if (!plan.metric) return null;
      const ended: GeodesicEnd = { length: 0, asked: 0, budget: false };
      const { type: _, ...spec } = plan;
      const pts = geodesicPath(spec, env, { window: traceWindow(view.lo, view.hi), ended });
      const xy: number[] = [];
      for (let k = 0; k + 2 < pts.length; k += 3) xy.push(pts[k], pts[k + 1]);
      return { path: thin(xy), end: xy.slice(-2).map(text), length: text(ended.length), note: geodesicCutNote(ended) };
    }
    if (plan.type === 'lightcone') {
      const read = metricValues(plan, env);
      const orient = metricOrientation(plan.future, env);
      const scale = plan.n === 3 ? { kappa: indicatrixScale(read, view), cut: behindHorizon(read, view) } : undefined;
      let at: [number, number][] | undefined;
      if (plan.at) {
        const out = new Float64Array(2);
        numericIn(plan.at, ['x', 'y'], env)(NaN, NaN, out);
        at = [[out[0], out[1]]];
      }
      const g = coneGlyphs(read, view, { ...(at ? { at } : {}), ...(scale ?? {}), ...(orient ? { orient } : {}) });
      return {
        kappa: scale ? text(scale.kappa) : null,
        rings: thin(g.rings),
        lines: thin(g.lines),
        dots: thin(g.dots),
      };
    }
    if (plan.type === 'tidal') {
      const read = tidalReader(plan, env);
      const cut = plan.n === 3 ? behindHorizon(metricValues(plan, env), view) : undefined;
      const scale = tidalScale(read, view, cut ? { skip: cut } : {});
      let at: [number, number][] | undefined;
      if (plan.at) {
        const out = new Float64Array(2);
        numericIn(plan.at, ['x', 'y'], env)(NaN, NaN, out);
        at = [[out[0], out[1]]];
      }
      const g = tidalGlyphs(read, view, { ...(at ? { at } : {}), scale, ...(cut ? { cut } : {}) });
      return { scale: text(scale), rings: thin(g.rings), lines: thin(g.lines) };
    }
  } catch (err) {
    return { error: (err as Error).message };
  }
  return null;
}

/**
 * What the site draws of each geodesic, light-cone and tidal row (a
 * family's members each) at t = 0 over the document's window: a geodesic's
 * path and note, a row's glyphs and the scale they share — thinned to a few
 * of their numbers.
 */
export function recordMetrics(analysis: Analysis): unknown {
  if (!analysis.rows.some(row => row.cls?.object.kind === 'metric')) return null;
  const view = viewOf(analysis);
  const env = { ...analysis.constEnv, t: 0 };
  return analysis.rows.map(row => {
    const cpu = row.cpu;
    if (!cpu || row.error) return null;
    if (cpu.type === 'family') return cpu.members.map(m => drawnOf(m.cpu, env, view));
    const drawn = drawnOf(cpu, env, view);
    return drawn && [drawn];
  });
}
