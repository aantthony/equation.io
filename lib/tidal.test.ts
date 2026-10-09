import { describe, expect, it } from 'vitest';
import { analyzeRows } from './analysis.ts';
import { compileCpu, cpuStructureKey } from './compiler.ts';
import { type ConeView, coneCell, coneLattice } from './light-cone.ts';
import { add, mul } from './diff.ts';
import type { Expr } from './expr.ts';
import { countNodes } from './size.ts';
import { smoothPartial } from './surface-geometry.ts';
import {
  type TidalScaleMemory,
  type TidalSpec,
  TIDAL_CAP,
  TIDAL_REACH,
  heldTidalScale,
  memoTides,
  tidalGlyphs,
  tidalReader,
  tidalScale,
} from './tidal.ts';

/** Tidal forces of a panel's metric on a static observer (lib/tidal.ts). */

const EQUATORIAL = ['r = sqrt(x^2 + y^2)', 'phi = atan2(y, x)'];
const schwarzschild = (M: number) => [
  `M = ${M}`,
  ...EQUATORIAL,
  'ds^2 = -(1 - 2M/r) dt^2 + dr^2/(1 - 2M/r) + r^2 dphi^2',
];
/** The same, written in x and y alone: dr = (x dx + y dy)/r. */
const schwarzschildXY = (M: number) => [
  `M = ${M}`,
  'ds^2 = -(1 - 2M/sqrt(x^2 + y^2)) dt^2 + dx^2 + dy^2 + 2M/(sqrt(x^2 + y^2) - 2M) (x dx + y dy)^2/(x^2 + y^2)',
];
/** And mixing x and y with fields of them, pulled back to x and y first. */
const schwarzschildMixed = (M: number) => [
  `M = ${M}`,
  ...EQUATORIAL,
  'ds^2 = -(1 - 2M/sqrt(x^2 + y^2)) dt^2 + dr^2/(1 - 2M/r) + r^2 dphi^2',
];
const reissnerNordstrom = (M: number, Q: number) => [
  `M = ${M}`,
  `Q = ${Q}`,
  ...EQUATORIAL,
  'f = 1 - 2M/r + Q^2/r^2',
  'ds^2 = -f dt^2 + dr^2/f + r^2 dphi^2',
];
const deSitter = (L: number) => [
  `L = ${L}`,
  ...EQUATORIAL,
  'ds^2 = -(1 - r^2/L^2) dt^2 + dr^2/(1 - r^2/L^2) + r^2 dphi^2',
];
const kerr = (M: number, a: number) => [
  `M = ${M}`,
  `a = ${a}`,
  ...EQUATORIAL,
  'ds^2 = -(1 - 2M/r) dt^2 - 4 M a/r dt dphi + r^2/(r^2 - 2M r + a^2) dr^2 + (r^2 + a^2 + 2M a^2/r) dphi^2',
];
/** Kerr with its g_tt read from x and y: pulled back. */
const kerrMixed = (M: number, a: number) => [
  `M = ${M}`,
  `a = ${a}`,
  ...EQUATORIAL,
  'ds^2 = -(1 - 2M/sqrt(x^2 + y^2)) dt^2 - 4 M a/r dt dphi + r^2/(r^2 - 2M r + a^2) dr^2 + (r^2 + a^2 + 2M a^2/r) dphi^2',
];

const last = (rows: string[]) => analyzeRows(rows, { readouts: true }).rows.at(-1)!;
const errorOf = (rows: string[]) => last(rows).error;

/** The tidal spec of a document's last row (member `member`), the values
 *  it reads, and its reader. */
function tides(rows: string[], member = 0) {
  const analysis = analyzeRows(rows, { readouts: true });
  const r = analysis.rows.at(-1)!;
  if (r.error) throw new Error(r.error);
  let o = r.cls!.object;
  if (o.kind === 'family') o = o.members[member].object;
  if (o.kind !== 'tidal') throw new Error(o.kind);
  const { kind: _, ...spec } = o;
  const env = { ...analysis.constEnv, t: 0 };
  return { spec: spec as TidalSpec, env, read: tidalReader(spec, env) };
}

/** Eigenvalues (ascending) and eigenvectors (unit, in x and y) at a point. */
function at(read: ReturnType<typeof tidalReader>, x: number, y: number) {
  const t = read(x, y);
  if (!t) return null;
  const pairs = Array.from({ length: t.count }, (_, k) => {
    const [dx, dy] = [t.dir[2 * k], t.dir[2 * k + 1]];
    const n = Math.hypot(dx, dy);
    return { lambda: t.lambda[k], dir: [dx / n, dy / n] as [number, number] };
  });
  pairs.sort((p, q) => p.lambda - q.lambda);
  return pairs;
}

/** |cos| of the angle between two unit vectors: 1 when parallel either way. */
const along = (u: readonly number[], v: readonly number[]) => Math.abs(u[0] * v[0] + u[1] * v[1]);

const view = (x0: number, x1: number, y0: number, y1: number, px = 800): ConeView => {
  const upp = (x1 - x0) / px;
  return { lo: [x0, y0], hi: [x1, y1], upp, uppY: upp };
};

// An independent check: Riemann by finite differences of the Christoffel
// symbols (R^a_bcd = ∂_c Γ^a_db − ∂_d Γ^a_cb + Γ^a_ce Γ^e_db − Γ^a_de Γ^e_cb),
// themselves from finite differences of g — a different formula, and no
// symbolic derivatives.
type MetricFn = (X: readonly number[]) => number[][];

function inverse(g: number[][]): number[][] {
  const n = g.length;
  const a = g.map((row, i) => [...row, ...Array.from({ length: n }, (_, j) => (i === j ? 1 : 0))]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(a[r][c]) > Math.abs(a[p][c])) p = r;
    [a[c], a[p]] = [a[p], a[c]];
    const d = a[c][c];
    for (let k = 0; k < 2 * n; k++) a[c][k] /= d;
    for (let r = 0; r < n; r++)
      if (r !== c) {
        const f = a[r][c];
        for (let k = 0; k < 2 * n; k++) a[r][k] -= f * a[c][k];
      }
  }
  return a.map(row => row.slice(n));
}

/** d/dX_k of f at X, fourth-order central differences. */
function fd<T extends number[][] | number[][][]>(
  f: (X: readonly number[]) => T,
  X: readonly number[],
  k: number,
  h: number,
): T {
  const shift = (s: number) => f(X.map((v, i) => (i === k ? v + s * h : v)));
  const [a, b, c, d] = [shift(2), shift(1), shift(-1), shift(-2)];
  const combine = (p: unknown, q: unknown, r: unknown, s: unknown): unknown =>
    Array.isArray(p)
      ? p.map((_, i) => combine(p[i], (q as unknown[])[i], (r as unknown[])[i], (s as unknown[])[i]))
      : (-(p as number) + 8 * (q as number) - 8 * (r as number) + (s as number)) / (12 * h);
  return combine(a, b, c, d) as T;
}

function christoffel(g: MetricFn, X: readonly number[]): number[][][] {
  const n = X.length;
  const G = g(X);
  const inv = inverse(G);
  const dg = Array.from({ length: n }, (_, k) => fd(g, X, k, 1e-4));
  return Array.from({ length: n }, (_, a) =>
    Array.from({ length: n }, (_, b) =>
      Array.from({ length: n }, (_, c) => {
        let s = 0;
        for (let d = 0; d < n; d++) s += 0.5 * inv[a][d] * (dg[b][d][c] + dg[c][d][b] - dg[d][b][c]);
        return s;
      }),
    ),
  );
}

/** R_abcd, all lower, at X. */
function riemannFD(g: MetricFn, X: readonly number[]): (a: number, b: number, c: number, d: number) => number {
  const n = X.length;
  const G = g(X);
  const Gam = christoffel(g, X);
  const dGam = Array.from({ length: n }, (_, k) => fd(Y => christoffel(g, Y), X, k, 1e-3));
  const up = (a: number, b: number, c: number, d: number) => {
    let s = dGam[c][a][d][b] - dGam[d][a][c][b];
    for (let e = 0; e < n; e++) s += Gam[a][c][e] * Gam[e][d][b] - Gam[a][d][e] * Gam[e][c][b];
    return s;
  };
  return (a, b, c, d) => {
    let s = 0;
    for (let e = 0; e < n; e++) s += G[a][e] * up(e, b, c, d);
    return s;
  };
}

/** A static observer's tidal eigenvalues (ascending) from a 3 × 3 metric in
 *  (t, p, q) by finite differences. */
function staticTidesFD(g: MetricFn, X: readonly number[]): number[] {
  const R = riemannFD(g, X);
  const G = g(X);
  const gtt = G[0][0];
  const E = [1, 2].map(a => [1, 2].map(b => R(a, 0, b, 0) / -gtt));
  const h = [1, 2].map(a => [1, 2].map(b => G[a][b] - (G[a][0] * G[b][0]) / gtt));
  // Eigenvalues of h⁻¹E.
  const hi = inverse(h);
  const A = [0, 1].map(i => [0, 1].map(j => hi[i][0] * E[0][j] + hi[i][1] * E[1][j]));
  const tr = A[0][0] + A[1][1];
  const det = A[0][0] * A[1][1] - A[0][1] * A[1][0];
  const disc = Math.sqrt(Math.max(0, tr * tr - 4 * det));
  return [(tr - disc) / 2, (tr + disc) / 2];
}

const kerrMetric =
  (M: number, a: number): MetricFn =>
  ([, r]) => {
    const gtp = (-2 * M * a) / r;
    return [
      [-(1 - (2 * M) / r), 0, gtp],
      [0, (r * r) / (r * r - 2 * M * r + a * a), 0],
      [gtp, 0, r * r + a * a + (2 * M * a * a) / r],
    ];
  };

describe('a static observer’s tides', () => {
  it('stretch radially by 2M/r³ and squeeze round by M/r³ around Schwarzschild, however it is written', () => {
    for (const M of [0.5, 1, 3])
      for (const rows of [schwarzschild(M), schwarzschildXY(M), schwarzschildMixed(M)]) {
        const { read } = tides([...rows, 'tidal']);
        for (const r of [3 * M, 5 * M, 12 * M, 40 * M])
          for (const th of [0.3, 2, -2.5]) {
            const [x, y] = [r * Math.cos(th), r * Math.sin(th)];
            const p = at(read, x, y)!;
            expect(p).toHaveLength(2);
            expect(p[0].lambda / ((-2 * M) / r ** 3)).toBeCloseTo(1, 8);
            expect(p[1].lambda / (M / r ** 3)).toBeCloseTo(1, 8);
            // Stretched along the radius, squeezed across it.
            expect(along(p[0].dir, [Math.cos(th), Math.sin(th)])).toBeCloseTo(1, 8);
            expect(along(p[1].dir, [-Math.sin(th), Math.cos(th)])).toBeCloseTo(1, 8);
          }
      }
  });

  it('match an independent finite-difference Riemann', () => {
    // Schwarzschild, in t, r, phi.
    const M = 1.3;
    const g = kerrMetric(M, 0);
    for (const r of [4, 7, 15]) {
      const [lo, hi] = staticTidesFD(g, [0, r, 0.4]);
      expect(lo / ((-2 * M) / r ** 3)).toBeCloseTo(1, 5);
      expect(hi / (M / r ** 3)).toBeCloseTo(1, 5);
    }
  });

  it('are nothing in flat space, in x and y or in polar coordinates', () => {
    for (const rows of [
      ['ds^2 = -dt^2 + dx^2 + dy^2'],
      [...EQUATORIAL, 'ds^2 = -dt^2 + dr^2 + r^2 dphi^2'],
      // Pulled back to x and y: only rounding, which is not drawn.
      [...EQUATORIAL, 'ds^2 = -dt^2 + dr^2 + (x^2 + y^2) dphi^2'],
    ]) {
      const { read } = tides([...rows, 'tidal']);
      for (const [x, y] of [
        [1, 2],
        [-3, 0.5],
        [40, -7],
      ])
        expect(read(x, y)?.count).toBe(0);
      const v = view(-10, 10, -6, 6);
      expect(tidalScale(read, v)).toBeNaN();
      expect(tidalGlyphs(read, v)).toEqual({ rings: [], lines: [], dots: [] });
    }
  });

  it('are −2M/r³ + 3Q²/r⁴ along the radius of a charged hole, M/r³ − Q²/r⁴ round', () => {
    for (const [M, Q] of [
      [1, 0.5],
      [1, 0.9],
      [2, 1.5],
    ]) {
      const { read } = tides([...reissnerNordstrom(M, Q), 'tidal']);
      const g: MetricFn = ([, r]) => {
        const f = 1 - (2 * M) / r + (Q * Q) / (r * r);
        return [
          [-f, 0, 0],
          [0, 1 / f, 0],
          [0, 0, r * r],
        ];
      };
      for (const r of [2.5 * M, 4 * M, 9 * M]) {
        const radial = (-2 * M) / r ** 3 + (3 * Q * Q) / r ** 4;
        const round = M / r ** 3 - (Q * Q) / r ** 4;
        // The formula, checked against finite differences first…
        const fdt = staticTidesFD(g, [0, r, 1]).sort((p, q) => p - q);
        expect(fdt[0]).toBeCloseTo(Math.min(radial, round), 6);
        expect(fdt[1]).toBeCloseTo(Math.max(radial, round), 6);
        // …then the glyphs' reader against it.
        const p = at(read, r * Math.cos(1), r * Math.sin(1))!;
        const radialPair = p.find(e => along(e.dir, [Math.cos(1), Math.sin(1)]) > 0.999)!;
        const roundPair = p.find(e => e !== radialPair)!;
        expect(radialPair.lambda / radial).toBeCloseTo(1, 8);
        expect(roundPair.lambda / round).toBeCloseTo(1, 8);
      }
    }
  });

  it('match finite differences round a spinning hole, and are not drawn in its ergoregion', () => {
    for (const [M, a] of [
      [1, 0.5],
      [1, 0.9],
      [2, -1.2],
    ]) {
      const { read } = tides([...kerr(M, a), 'tidal']);
      for (const r of [2.3 * M, 3 * M, 6 * M, 14 * M])
        for (const th of [0.2, 2.4]) {
          const fdt = staticTidesFD(kerrMetric(M, a), [0, r, th]);
          const p = at(read, r * Math.cos(th), r * Math.sin(th))!;
          expect(p[0].lambda / fdt[0]).toBeCloseTo(1, 5);
          expect(p[1].lambda / fdt[1]).toBeCloseTo(1, 5);
          // Equatorial symmetry keeps the axes radial and round; the
          // stretch is radial.
          expect(along(p[0].dir, [Math.cos(th), Math.sin(th)])).toBeCloseTo(1, 6);
          // Spin makes it differ from Schwarzschild's.
          expect(Math.abs(p[0].lambda / ((-2 * M) / r ** 3) - 1)).toBeGreaterThan(1e-4);
        }
      // Inside the ergoregion (r+ < r < 2M) and the horizon: no static observer.
      const rPlus = M + Math.sqrt(M * M - a * a);
      for (const r of [(rPlus + 2 * M) / 2, 1.99 * M, 0.9 * rPlus]) expect(read(r, 0)).toBeNull();
    }
  });

  it('stretch isotropically by 1/L² in de Sitter’s static patch', () => {
    for (const L of [1, 5, 40]) {
      const { read } = tides([...deSitter(L), 'tidal']);
      for (const r of [0.1 * L, 0.5 * L, 0.9 * L]) {
        const p = at(read, r * Math.cos(0.7), r * Math.sin(0.7))!;
        expect(p.map(e => e.lambda * L * L)).toEqual([expect.closeTo(-1, 8), expect.closeTo(-1, 8)]);
      }
      // Beyond its horizon, no static observer.
      expect(read(1.1 * L, 0)).toBeNull();
    }
  });
});

describe('tides on a spacetime diagram', () => {
  it('are −K along space, for Schwarzschild’s r and t and through Eddington–Finkelstein', () => {
    const rt = tides(['M = 1', 'ds^2 = -(1 - 2M/x) dy^2 + dx^2/(1 - 2M/x)', 'tidal']).read;
    const ef = tides(['M = 1', 'ds^2 = -(1 - 2M/x) dy^2 + 2 dy dx', 'tidal']).read;
    for (const r of [3, 5, 20]) {
      const p = at(rt, r, 1.5)!;
      expect(p).toHaveLength(1);
      expect(p[0].lambda / (-2 / r ** 3)).toBeCloseTo(1, 8);
      expect(along(p[0].dir, [1, 0])).toBeCloseTo(1, 12);
      const q = at(ef, r, -4)!;
      expect(q[0].lambda / (-2 / r ** 3)).toBeCloseTo(1, 8);
      // Orthogonal to ∂v: g(w, ∂v) = -(1 - 2M/r) w_v + w_r = 0.
      const [wr, wv] = q[0].dir;
      expect(-(1 - 2 / r) * wv + wr).toBeCloseTo(0, 12);
    }
    // Inside the horizon no observer stands still.
    expect(rt(1.5, 0)).toBeNull();
    expect(ef(1.5, 0)).toBeNull();
  });

  it('follow the written time, stretch in de Sitter, and are nothing in Minkowski or Rindler', () => {
    // Time along x: space is y.
    const tx = tides(['M = 1', 'ds^2 = -(1 - 2M/y) dx^2 + dy^2/(1 - 2M/y)', 'tidal']).read;
    const p = at(tx, 0.5, 4)!;
    expect(p[0].lambda / (-2 / 64)).toBeCloseTo(1, 8);
    expect(along(p[0].dir, [0, 1])).toBeCloseTo(1, 12);
    const ds = tides(['L = 2', 'ds^2 = -(1 - x^2/L^2) dy^2 + dx^2/(1 - x^2/L^2)', 'tidal']).read;
    expect(at(ds, 0.7, 0)![0].lambda).toBeCloseTo(-1 / 4, 10);
    for (const rows of [['ds^2 = -dy^2 + dx^2'], ['ds^2 = -x^2 dy^2 + dx^2']]) {
      const { read } = tides([...rows, 'tidal']);
      expect(read(1.5, 2)?.count).toBe(0);
    }
  });
});

describe('tidal glyphs', () => {
  it('scale by one power of two for the panel, the median a part of a cell, the strong ones shrunk whole', () => {
    const { read } = tides([...schwarzschild(1), 'tidal']);
    const v = view(-16, 16, -10, 10);
    const s = tidalScale(read, v);
    expect(Math.log2(s) % 1).toBe(0);
    const cellPx = coneCell(v.upp) / v.upp;
    // The median glyph's longer bar within √2 of TIDAL_REACH of a cell.
    // (The reader's result is its own: read it at once.)
    const sizes = coneLattice(v)
      .map(([x, y]) => {
        const t = read(x, y);
        return t && t.count ? Math.max(Math.abs(t.lambda[0]), Math.abs(t.lambda[1])) : NaN;
      })
      .filter(s => s > 0)
      .sort((p, q) => p - q);
    const reach = (s * sizes[Math.floor(sizes.length / 2)]) / (TIDAL_REACH * cellPx);
    expect(reach).toBeGreaterThan(Math.SQRT1_2 - 1e-9);
    expect(reach).toBeLessThan(Math.SQRT2 + 1e-9);
    const glyphs = tidalGlyphs(read, v, { scale: s });
    // Every bar within the cap, and centred on a lattice point outside the
    // horizon; two triangles a bar.
    const bars = glyphs.lines.filter(Number.isNaN).length / 2;
    expect(bars).toBeGreaterThan(50);
    expect(glyphs.rings.filter(Number.isNaN).length / 2).toBe(2 * bars);
    for (let i = 0; i < glyphs.lines.length; i += 6) {
      const [x0, y0, x1, y1] = glyphs.lines.slice(i, i + 4);
      expect(Math.hypot(x1 - x0, y1 - y0) / 2 / v.upp).toBeLessThan(TIDAL_CAP * cellPx + 1e-6);
      expect(Math.hypot((x0 + x1) / 2, (y0 + y1) / 2)).toBeGreaterThan(2);
    }
    // Pans keep the scale they had while the median allows it (within a
    // factor of two), here where it sits near the edge between two.
    for (let dx = -3; dx <= 3; dx += 0.25) {
      const panned = view(-16 + dx, 16 + dx, -10 + dx / 2, 10 + dx / 2);
      expect(tidalScale(read, panned, { previous: s })).toBe(s);
    }
    // Zoomed far out, it changes.
    expect(tidalScale(read, view(-160, 160, -100, 100), { previous: s })).not.toBe(s);
  });

  it('point out where they stretch and in where they squeeze, the radial bar twice the round one', () => {
    const { read } = tides([...schwarzschild(1), 'tidal']);
    const v = view(-20, 20, -12, 12);
    const glyphs = tidalGlyphs(read, v, { at: [[10, 0]], scale: 2 ** 20 });
    // Two bars: radial (along x) and round (along y).
    expect(glyphs.lines.filter(Number.isNaN).length / 2).toBe(2);
    const half = (k: number) => {
      const [x0, y0, x1, y1] = glyphs.lines.slice(6 * k, 6 * k + 4);
      return { dx: Math.abs(x1 - x0) / 2, dy: Math.abs(y1 - y0) / 2 };
    };
    const [a, b] = [half(0), half(1)];
    const radial = a.dx > a.dy ? a : b;
    const round = radial === a ? b : a;
    expect(radial.dx / round.dy).toBeCloseTo(2, 9);
    // A lone glyph's longer bar is within its cap.
    expect(radial.dx / v.upp).toBeCloseTo(60, 9);
    // Each triangle: its tip (first point) further from the point than its
    // base for the stretch, nearer for the squeeze.
    const tris: number[][] = [];
    let cur: number[] = [];
    for (const val of glyphs.rings) {
      if (Number.isNaN(val)) {
        if (cur.length) tris.push(cur);
        cur = [];
      } else cur.push(val);
    }
    expect(tris).toHaveLength(4);
    for (const t of tris) {
      const tip = Math.hypot(t[0] - 10, t[1]);
      const base = Math.hypot((t[2] + t[4]) / 2 - 10, (t[3] + t[5]) / 2);
      // The radial bar's heads lie off x = 10, the round bar's on it.
      if (Math.abs(t[0] - 10) > 1e-9) expect(tip).toBeGreaterThan(base);
      else expect(tip).toBeLessThan(base);
    }
  });

  it('leave out lattice points with no static observer, and use the panel scale for a lone one', () => {
    const { read } = tides([...kerr(1, 0.9), 'tidal']);
    const v = view(-6, 6, -4, 4);
    const glyphs = tidalGlyphs(read, v, { scale: tidalScale(read, v) });
    for (let i = 0; i < glyphs.lines.length; i += 6) {
      const [x0, y0, x1, y1] = glyphs.lines.slice(i, i + 4);
      expect(Math.hypot((x0 + x1) / 2, (y0 + y1) / 2)).toBeGreaterThan(2);
    }
    // The lone one with no scale takes its own.
    const lone = tidalGlyphs(read, v, { at: [[4, 1]] });
    expect(lone.lines.filter(Number.isNaN).length / 2).toBe(2);
    expect(tidalGlyphs(read, v, { at: [[1.5, 0]] }).lines).toEqual([]);
  });

  it('evaluate a 1080p lattice quickly, once a point', () => {
    const { spec, env } = tides([...kerr(1, 0.9), 'tidal']);
    const v = view(-20, 20, -11.25, 11.25, 1920);
    const n = coneLattice(v).length;
    expect(n).toBeGreaterThan(1000);
    // Warmed on another view, as the app is after its first frame.
    const warm = memoTides(tidalReader(spec, env));
    tidalGlyphs(warm, view(-7, 9, -3, 6, 1920), { scale: tidalScale(warm, view(-7, 9, -3, 6, 1920)) });
    let reads = 0;
    const plain = tidalReader(spec, env);
    const read = memoTides((x, y) => (reads++, plain(x, y)));
    const t0 = performance.now();
    const s = tidalScale(read, v);
    tidalGlyphs(read, v, { scale: s });
    const ms = performance.now() - t0;
    // The scale and the glyphs share one read a point…
    expect(reads).toBe(n);
    // …and a pan by a cell reads only the new column.
    const w = coneCell(v.upp);
    const panned = view(-20 + w, 20 + w, -11.25, 11.25, 1920);
    tidalGlyphs(read, panned, { scale: tidalScale(read, panned, { previous: s }) });
    expect(reads - n).toBeLessThan(40);
    // ~6 ms in Node (generous here for a slow runner).
    expect(ms).toBeLessThan(100);
  });

  it('remember a point’s tides as they were read', () => {
    const { read: plain } = tides([...schwarzschild(1), 'tidal']);
    const read = memoTides(plain);
    const a = read(5, 1)!;
    const b = read(-7, 2)!;
    expect(read(5, 1)).toBe(a);
    expect(a.lambda[0]).not.toBe(b.lambda[0]);
    expect([...a.lambda]).toEqual([...plain(5, 1)!.lambda]);
    expect(read(0.5, 0)).toBeNull();
  });
});

/** The old way of pulling a mixed metric back to x and y, symbolically
 *  (Jᵀ g J, then its second derivatives): a reference for the reader's
 *  numeric chain rule. */
function symbolicPullback(spec: TidalSpec): TidalSpec {
  const { n, components, jacobian } = spec;
  const num = (value: number): Expr => ({ kind: 'num', value });
  const o = n - 2;
  const at = (a: number, b: number) => {
    const [i, j] = a <= b ? [a, b] : [b, a];
    return components[i * n - (i * (i - 1)) / 2 + (j - i)];
  };
  const J = (c: number, k: number): Expr => (c < o || k < o ? num(c === k ? 1 : 0) : jacobian![2 * (c - o) + (k - o)]);
  const g: Expr[] = [];
  for (let i = 0; i < n; i++)
    for (let j = i; j < n; j++) {
      let sum: Expr = num(0);
      for (let a = 0; a < n; a++) for (let b = 0; b < n; b++) sum = add(sum, mul(mul(J(a, i), J(b, j)), at(a, b)));
      g.push(sum);
    }
  const d = smoothPartial;
  const dx = g.map(e => d(e, 'x'));
  const dy = g.map(e => d(e, 'y'));
  const curvature = [
    ...g,
    ...dx,
    ...dy,
    ...dx.map(e => d(e, 'x')),
    ...dx.map(e => d(e, 'y')),
    ...dy.map(e => d(e, 'y')),
  ];
  return { n, time: spec.time, params: ['x', 'y'], curvature, components, ...(jacobian ? { jacobian } : {}) };
}

describe('a metric mixing x and y with fields of them', () => {
  /** g_tt read from x and y in a form that is not r's definition. */
  const unfolded = (rows: string[]) =>
    rows.map(r => r.replace('-(1 - 2M/sqrt(x^2 + y^2)) dt^2', '-(1 - 2M (x^2 + y^2)^(-1/2)) dt^2'));

  it('reads as its symbolic pull-back to x and y does, by the chain rule, and stays small', () => {
    for (const rows of [unfolded(schwarzschildMixed(1.5)), unfolded(kerrMixed(1, 0.8))]) {
      const { spec, env, read } = tides([...rows, 'tidal']);
      expect(spec.symbols).toEqual(['x', 'y', 'r', 'phi']);
      expect(spec.chart).toHaveLength(14);
      const ref = tidalReader(symbolicPullback(spec), env);
      for (const [x, y] of [
        [4, 1],
        [-6, 3],
        [2, -9],
        [15, 15],
      ]) {
        const a = at(read, x, y)!;
        const b = at(ref, x, y)!;
        expect(a.map(e => e.lambda)).toEqual(b.map(e => expect.closeTo(e.lambda, Math.abs(e.lambda) * 1e-9)));
        a.forEach((e, k) => expect(along(e.dir, b[k].dir)).toBeCloseTo(1, 9));
      }
      // The symbolic pull-back is many times the nodes.
      const nodes = (s: TidalSpec) => countNodes({ kind: 'vec', items: [...s.curvature, ...(s.chart ?? [])] });
      expect(nodes(spec) * 4).toBeLessThan(nodes(symbolicPullback(spec)));
    }
  });

  it('folds a coordinate spelled out in x and y back into its name', () => {
    for (const rows of [schwarzschildMixed(1.5), kerrMixed(1, 0.8)]) {
      const { spec } = tides([...rows, 'tidal']);
      expect(spec.symbols).toBeUndefined();
      expect(spec.params).toEqual(['r', 'phi']);
    }
  });

  it('takes a diagram’s time from the written coordinates, carried to x and y', () => {
    // T and R are y and x, the metric reading x as well as R (folded).
    const plain = tides(['T = y', 'R = x', 'ds^2 = -(1 - 2/x) dT^2 + dR^2/(1 - 2/R)', 'tidal']);
    for (const r of [3, 5, 9]) {
      const p = at(plain.read, r, 1)!;
      expect(p[0].lambda / (-2 / r ** 3)).toBeCloseTo(1, 8);
      expect(along(p[0].dir, [1, 0])).toBeCloseTo(1, 10);
    }
    expect(plain.read(1.5, 0)).toBeNull();
    // A sheared time, T = y + x/2, and R = 2x, defined either way round, the
    // metric reading x itself (Schwarzschild, M = 1, in T and R): ∂T at
    // fixed R is (0, 1) in x and y, and space (∂R at fixed T) is (2, −1).
    for (const fields of [
      ['T = y + 0.5 x', 'R = 2x'],
      ['R = 2x', 'T = y + 0.5 x'],
    ]) {
      const { spec, read } = tides([...fields, 'ds^2 = -(1 - 1/x) dT^2 + dR^2/(1 - 2/R)', 'tidal']);
      expect(spec.symbols).toBeDefined();
      for (const R of [3, 6]) {
        const p = at(read, R / 2, -2)!;
        expect(p[0].lambda / (-2 / R ** 3)).toBeCloseTo(1, 8);
        expect(along(p[0].dir, [2 / Math.sqrt(5), -1 / Math.sqrt(5)])).toBeCloseTo(1, 10);
      }
      expect(read(0.75, 0)).toBeNull();
    }
  });
});

describe('the panel’s tidal scale', () => {
  it('is the same for the same values and view, whatever the sliders did before', () => {
    const v = view(-8, 8, -6, 6);
    const scaleAt = (M: number) => {
      const { read } = tides([...kerr(M, 0.9), 'tidal']);
      return read;
    };
    const fresh = heldTidalScale({}, scaleAt(2), v, 'M=2');
    const memory: TidalScaleMemory = {};
    heldTidalScale(memory, scaleAt(1), v, 'M=1');
    expect(heldTidalScale(memory, scaleAt(2), v, 'M=2')).toBe(fresh);
    // Through a pan, at the same values, it is held.
    const panned = view(-7.5, 8.5, -6, 6);
    const held = heldTidalScale(memory, scaleAt(2), panned, 'M=2');
    expect(held).toBe(fresh);
  });

  it('holds a scale down by at most 2^1.5 and up by at most 2^1, so held glyphs stay under the cap', () => {
    const { read } = tides([...schwarzschild(1), 'tidal']);
    const v = view(-16, 16, -10, 10);
    const s = tidalScale(read, v);
    const cellPx = coneCell(v.upp) / v.upp;
    const sizes: number[] = [];
    for (const [x, y] of coneLattice(v)) {
      const t = read(x, y);
      if (t && t.count) sizes.push(Math.max(Math.abs(t.lambda[0]), Math.abs(t.lambda[1])));
    }
    sizes.sort((p, q) => p - q);
    const median = sizes[Math.floor(sizes.length / 2)];
    for (let k = -4; k <= 4; k++) {
      const held = tidalScale(read, v, { previous: s * 2 ** k });
      const reach = (held * median) / (TIDAL_REACH * cellPx);
      expect(reach).toBeLessThanOrEqual(2 + 1e-9);
      expect(reach).toBeGreaterThanOrEqual(2 ** -1.5 - 1e-9);
    }
    expect(TIDAL_REACH * 2).toBeLessThan(TIDAL_CAP);
  });
});

describe('tidal and tidal(P) rows', () => {
  it('say what they need', () => {
    expect(errorOf(['tidal'])).toMatch(/this panel has none/);
    expect(errorOf(['tidal((1, 2))'])).toMatch(/this panel has none/);
    expect(errorOf(['ds^2 = (dx^2 + dy^2)/y^2', 'tidal'])).toMatch(
      /Tidal forces need a time: write the ds\^2 with a dt term/,
    );
    expect(errorOf(['ds^2 = dx^3 + dy^2', 'tidal'])).toMatch(/has an error/);
    const flat = 'ds^2 = -dt^2 + dx^2 + dy^2';
    expect(errorOf([flat, 'tidal(1)'])).toMatch(/a pair/);
    expect(errorOf([flat, 'tidal((x, 1))'])).toMatch(/, not x/);
    expect(errorOf([flat, 'tidal((1, 2), (1, 0))'])).toMatch(/tidal\(P\) draws/);
    expect(errorOf([flat, '2 tidal((1, 2))'])).toMatch(/whole row/);
    expect(errorOf([flat, '---', 'tidal'])).toMatch(/this panel has none/);
    expect(errorOf(['S = (u, v, u v)', 'on(S)', 'tidal'])).toMatch(/this panel has none/);
    // A document's own tidal is its own.
    expect(errorOf(['tidal = 2', 'y = tidal x'])).toBeUndefined();
    expect(errorOf(['tidal(q) = q^2', 'y = tidal(x)'])).toBeUndefined();
  });

  it('draw as tides, a point a member, a list a family', () => {
    const row = last([...schwarzschild(1), 'tidal']);
    expect(row.cls!.object).toMatchObject({ kind: 'tidal', n: 3, time: 0, params: ['r', 'phi'] });
    expect(row.cpu).toMatchObject({ type: 'tidal', n: 3 });
    const one = last([...schwarzschild(1), 'P = (6, 0)', 'tidal(P)']);
    expect(one.cls!.object).toMatchObject({ kind: 'tidal', at: [{ name: 'P_x' }, { name: 'P_y' }] });
    const fan = last([...schwarzschild(1), 'R = [3..8]', 'tidal((R, 0))']);
    expect(fan.cls!.object.kind).toBe('family');
    if (fan.cls!.object.kind === 'family') expect(fan.cls!.object.members).toHaveLength(6);
    // A diagram's time, as it is written.
    expect(last(['ds^2 = -dx^2 + dy^2', 'tidal']).cls!.object).toMatchObject({ n: 2, time: 0 });
    expect(last(['ds^2 = dx^2 - dy^2', 'tidal']).cls!.object).toMatchObject({ n: 2, time: 1 });
    // A slider the metric reads is a parameter.
    expect(row.cls!.params).toEqual(['M']);
  });

  it('key their plan by the metric and the point', () => {
    const key = (rows: string[]) => cpuStructureKey(compileCpu(last(rows).cls!));
    const a = key([...schwarzschild(1), 'tidal']);
    expect(key([...schwarzschild(1), 'tidal'])).toBe(a);
    expect(key([...kerr(1, 0.5), 'tidal'])).not.toBe(a);
    expect(key([...schwarzschild(1), 'tidal((6, 0))'])).not.toBe(a);
    expect(key([...schwarzschild(1), 'tidal((7, 0))'])).not.toBe(key([...schwarzschild(1), 'tidal((6, 0))']));
  });
});
