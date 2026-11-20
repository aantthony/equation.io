/**
 * Targeted documents for apple/corpus/analysis.ts: plane maps
 * (lib/plane-map.ts, `view((x, y) = …)`), sums in a map (lib/defs.ts
 * expandMapSums) and what else a mapped panel draws or refuses
 * (lib/axis-map.ts axisMapping). One concern each, rows separated as the
 * examples' are.
 */
export const PLANE_CASES: string[] = [
  // The map, its window, and its errors.
  'view((x, y) = (Y cos(X), Y sin(X)), X = -pi..pi, Y = 0..4); x^2 + y^2 = 4; y = x; y = x^2; x = 1; y < x; x y',
  'view((x, y) = (exp(Y) cos(X), exp(Y) sin(X))); x^2 + y^2 = 1; ---; view((x, y) = (X^2 - Y^2, 2 X Y), X = -2..2); y = 1',
  'view((x, y) = (X + Y, X - Y), Y = 0..1, ratio = 2, locked); y = x; ---; view( ( x , y ) = (2X, 3Y), X = 0..1, Y = 1..2)',
  'view((x, y) = (X, Y), x = 0..1); ---; view((x, y) = (X, Y), y = 0..1); ---; view((x, y) = (X, Y), i = 0..1)',
  'view((x, y) = (X, Y), x = 10^X); ---; view((x, y) = (X, Y), y = sqrt(Y)); ---; view((x, y) = (X, Y), (x, y) = (Y, X))',
  'view((x, y) = (X, X)); ---; view((x, y) = (1, 2)); ---; view((x, y) = (X, Y, X)); ---; view((x, y) = X + Y)',
  'view((x, y) = (X + q, Y)); ---; view((x, y) = (X + t, Y)); ---; view((x, y) = (floor(X), Y)); ---; view((x, y) = (X +, Y))',
  'view((x, y) = (cos X, Y)); ---; view((x, y) = (abs(X), Y)); ---; view((x, y) = (X, 0 Y)); ---; view((x, y) =)',
  'b = 2; view((x, y) = (b X, Y/b), X = -b..b, Y = -1..1); y = x; (b, 1); c = t; ---; view((x, y) = (c X, Y))',
  'view((x, y) = (ln(X - 10), Y)); y = x; ---; view((x, y) = (X Y, Y)); y = x; ---; view((x, y) = (X, Y), X = 2..1)',
  'view((x, y) = (X, Y), X = 0..1, X = 2..3); ---; view((x, y) = (X, Y), ratio = 0); ---; view((x, y) = (x, y))',
  'view((x, y) = (X + Y, Y), X = 0..a); a = 3; y = a x; ---; view((x, y) = (X, Y), X = 0..q)',
  'view(x = -5..5); view((x, y) = (X, 2Y)); ---; y = x; view((x, y) = (X, 2Y)); view(y = 0..1); grid(off)',
  // What a plane-mapped panel draws: substituted, placed, read out, refused.
  'view((x, y) = (Y cos(X), Y sin(X)), X = -pi..pi, Y = 0..4); a = 2; y = a x; a x; (a, a); A = (1, 1); A; (2u, u); 1 + a; 2 < 1',
  "view((x, y) = (Y cos(X), Y sin(X)), Y = 0..4); (y, -x); y' = y/x; dy/dx = x; (x', y') = (x, y); (1, x); (-y, x, 1)",
  'view((x, y) = (X^2 - Y^2, 2 X Y)); r = sqrt(x^2 + y^2); r = 2; r < 3; r; th = atan2(y, x); th = 1; within = y > 1; {within: x}',
  'view((x, y) = (Y cos(X), Y sin(X))); k = 2; x^2 + y^2 = k; k = x y; y = d/dx x^3; y = {x > 1: 1, 0}; f(x) = x^2; y = f(x)',
  'view((x, y) = (X + Y, X - Y)); z = x y; (1, 2, 3); x^2 + y^2 + z^2 = 1; (u, v, u v); (cos(u), sin(u), u)',
  'view((x, y) = (Y cos(X), Y sin(X))); segment((1, 1), (2, 2)); label((1, 1), "one"); polygon((1, 0), (2, 0), (2, 1)); circle((0, 0), 2)',
  'view((x, y) = (Y cos(X), Y sin(X))); A = (1, 2); B = (3, 1); segment(A, B); vector(A, B); (1, 2, 3, 4); A + B; trail(A)',
  'view((x, y) = (Y cos(X), Y sin(X))); int[0..1] x^2 dx; 2 + 3; (u cos(2 pi v), u sin(2 pi v)); (u, v); u + v',
  'view((x, y) = (Y cos(X), Y sin(X))); (x, y) = (1, 2); (x^2 + y^2, x y) = (4, 1); w^3 = 1; w^2 = i; (x + u, y) = (1, u)',
  'view((x, y) = (Y cos(X), Y sin(X))); x + i y; (x + i y)^2; domain((x + i y)^2); e^(i u); 1 + i; iter(z^2 + c)',
  'view((x, y) = (Y cos(X), Y sin(X))); L = [1, 2, 3]; L; y = L x; (L, L^2); [(1, 2), (3, 4)]; hist([1, 2, 2, 3]); x^2 + y^2 = L',
  'view((x, y) = (Y cos(X), Y sin(X))); ((x, y), (y, x)); hessian(x^2 y); streamlines(((1, x), (x, -1))); rgb(x, y, 0.5); hsl(x, 1, 0.5)',
  'view((x, y) = (Y cos(X), Y sin(X))); r = sqrt(x^2 + y^2); th = atan2(y, x); grid(r, th); ---; view((x, y) = (X, 2 Y)); grid(x, y); y = x',
  "view((x, y) = (Y cos(X), Y sin(X))); r = sqrt(x^2 + y^2); th = atan2(y, x); (r', th') = (0, 1); (r, th) = (2, 1)",
  "view((x, y) = (Y cos(X), Y sin(X))); p' = v1; v1' = -p; p(0) = 1; (p, v1); (p, v1)(0..6); trail((p, v1)); y = p x",
  'view((x, y) = (Y cos(X), Y sin(X))); X1 ~ Normal(0, 1); X1; P(X1 < 1); E(X1); a_n = 1/n; a_n; mark(1)',
  // Sums in a map: written out term by term.
  'view(y = sum(n=1..3, Y^n/n)); y = x; ---; view(x = 2 sum[n=1..2] X^n); y = x; ---; view(x = X + sum(n=1..0, n))',
  'N = 3; view((x, y) = (X, sum(n=1..N, Y^(2n - 1)))); y = x; N; ---; view((x, y) = (X sum[k=1..2] k, Y prod(k=1..3, k)))',
  'view(x = sum(n=1..X, n)); ---; view(x = sum(n=1..2, )); ---; f(s) = s; view(x = sum(n=1..f, n X)); ---; view(x = sum(n=1..q, X))',
  'L = [1, 2]; view(x = sum(n=1..L, n X)); ---; view(x = sum(n=1..3000, X)); ---; view((x, y) = (sum(n=1..1500, X), sum(n=1..1500, Y)))',
  'N = 2; camera(1, 1); on((X, Y, Z) = (x, y, sum[n=1..N] sin(n x)/n), x = -3..3, y = -1..1); y = x; (1, 0); N',
  'camera(1, 1); on((X, Y, Z) = (x, y, sum(n=1..x, n)), x = 0..1, y = 0..1); ---; camera(1, 1); on((X, Y, Z) = (x, y, prod(k=1..3, x - k)), x = 0..1, y = 0..1); y = x',
  // What else mapped axes draw: matrices, lists, systems, parametric regions, complex kinds.
  'view(x = 1..100, x = 10^X); ((x, y), (y, x)); hessian(x^2 y); streamlines(((1, x), (x, -1))); ((1, 2), (3, 4))',
  'view(x = 10^X, y = 10^Y); ((x, 1), (1, y)); ---; view(y = sinh(Y)); ((x, y), (y, x)); a = 2; ((a, y), (x, a))',
  'view(x = 1..100, x = 10^X); L = [1, 10, 100]; L; (L, L/10); [(1, 2), (30, 4)]; y = L x; x = L; L + 1; (L, L, L)',
  'view(x = 1..100, x = 10^X); hist([1, 2, 2, 30]); ---; view(y = 10^Y); hist([1, 2, 2, 3]); [1, 2, 3]; e^(i [1, 2])',
  'view(x = 1..100, y = 1..100, x = 10^X, y = 10^Y); (x, y) = (10, 2); (x^2 + y^2, x y) = (400, 100); (x y, y) = (10, 2)',
  'view(x = 1..100, x = 10^X); w^3 = 1000; w^2 = 100 i; (x + u, y) = (10, u); (x, y, z) = (1, 2, 3)',
  'view(x = 1..100, x = 10^X); (10 u + 1, v); (u cos(2 pi v) + 10, u sin(2 pi v)); u + v; u; (u, v, 1)',
  'view(x = 1..100, x = 10^X); x + i y; domain(x + i y); e^(i u); 10 + i; 10 e^(i t); iter(z^2 + c); conformal((x + i y)^2)',
  'view(x = 1..100, x = 10^X); rgb(x/100, y, 0.5); hsl(x, 1, 0.5); oklch(0.7, 0.1, x); ---; view(y = 10^Y); rgb(x, y, 0)',
  'view(x = 1..100, x = 10^X); y = [1, 2] x; x^2 + y^2 = [100, 400]; [1, 2] x < y; (x, [1, 2] y); ([1, 2], 1)',
  "view(x = 1..100, x = 10^X); r = sqrt(x^2 + y^2); th = atan2(y, x); (r', th') = (0, 1); (r, th) = (20, 1); r = [10, 20]",
  'view(x = 1..100, x = 10^X); a_n = 1/n; a_n; b_(n+1) = b_n/2; b_0 = 1; b_n; X1 ~ Normal(10, 1); X1; P(X1 < 11); E(X1)',
  'view(x = 1..100, x = 10^X); int[1..10] 1/x dx; int[1..2] u du; z = x y; (cos(u), sin(u), u); tube((u, u, u))',
];

// --- the way back through a plane map ---

/** Maps and the screen windows their way back is recorded over. */
const INVERSES: Array<[map: string, lo: [number, number], hi: [number, number]]> = [
  // The examples' maps on their windows.
  ['(Y cos(X), Y sin(X))', [-Math.PI, 0], [Math.PI, 4]],
  ['(exp(Y) cos(X), exp(Y) sin(X))', [-Math.PI, -2], [Math.PI, 2]],
  ['(X^2 - Y^2, 2 X Y)', [-2, -1.5], [2, 1.5]],
  ['(X/(X^2 + Y^2), Y/(X^2 + Y^2))', [-2, -1.5], [2, 1.5]],
  // More than one turn, and many (the seeds move onto one turn).
  ['(Y cos(X), Y sin(X))', [0, 0.5], [4 * Math.PI, 4]],
  ['(Y cos(X), Y sin(X))', [-20 * Math.PI, 0], [20 * Math.PI, 4]],
  ['(Y cos(X), Y sin(X))', [1, 1], [2.5, 3]],
  // No fold and no turn; a fold along a curve; turns both ways; a twist.
  ['(X + Y, X - Y)', [-5, -5], [5, 5]],
  ['(X + Y^2, Y)', [-3, -2], [3, 2]],
  ['(X, Y^2)', [-3, -2], [3, 2]],
  ['(cos(X) + Y/10, sin(Y) + X/10)', [-8, -8], [8, 8]],
  ['(X^3 - 3 X Y^2, 3 X^2 Y - Y^3)', [-1.5, -1.5], [1.5, 1.5]],
  ['(exp(Y) cos(X + 6 sin(Y)), exp(Y) sin(X + 6 sin(Y)))', [-Math.PI, -2], [Math.PI, 2]],
  ['(ln(X), Y)', [-1, -2], [5, 2]],
];

const POINTS: Array<[number, number]> = [
  [0, 0],
  [1, 0],
  [0, 2],
  [-1, 1],
  [2, 1.5],
  [3, 3],
  [-2, -0.5],
  [0.3, -0.7],
  [10, 10],
  [0.001, 0],
  [-3, 0],
  [1, 1],
  [NaN, 1],
];

const sampled = (n: number, at: (u: number) => [number, number]): number[] =>
  Array.from({ length: n }, (_, k) => at(k / (n - 1))).flat();
const ring = (n: number, at: (u: number) => [number, number]): number[] =>
  Array.from({ length: n }, (_, k) => at(k / n)).flat();
const turn = 2 * Math.PI;

/** Polylines carried as lines (PlaneInverse.lines). */
const LINES: Array<{ name: string; closed: boolean; pts: number[] }> = [
  {
    name: 'spiral',
    closed: false,
    pts: sampled(200, u => [3 * u * Math.cos(2 * turn * u), 3 * u * Math.sin(2 * turn * u)]),
  },
  { name: 'segment', closed: false, pts: [-3, -2, 3, 2] },
  { name: 'sampled segment', closed: false, pts: sampled(65, u => [-3 + 6 * u, 1 - u]) },
  { name: 'chord', closed: false, pts: [-50, 1, 50, 1] },
  { name: 'circle', closed: true, pts: ring(96, u => [1 + 2 * Math.cos(turn * u), 2 * Math.sin(turn * u)]) },
  { name: 'square about the origin', closed: true, pts: [-1, -1, 1, -1, 1, 1, -1, 1] },
  { name: 'square', closed: true, pts: [1, 1, 2, 1, 2, 2, 1, 2] },
  { name: 'from the origin', closed: false, pts: [0, 0, 1, 2, 2, 2] },
  { name: 'one point', closed: false, pts: [1, 1] },
  { name: 'none', closed: false, pts: [] },
];

/** Closed shapes carried to fill (planeShapes). */
const SHAPES: Array<{ name: string; pts: number[] }> = [
  { name: 'square about the origin', pts: [-1, -1, 1, -1, 1, 1, -1, 1] },
  { name: 'disc', pts: ring(64, u => [1 + Math.cos(turn * u), Math.sin(turn * u)]) },
  { name: 'triangle', pts: [2, 1, 3, 1, 2.5, 2] },
  { name: 'round the screen', pts: [-100, -100, 100, -100, 100, 100, -100, 100] },
  { name: 'corner at the origin', pts: [0, 0, 2, 0, 2, 2, 0, 2] },
];

/** Regions' triangles (PlaneInverse.triangles): a fan round (1, 0), and a grid over a square. */
const MESHES: Array<{ name: string; tris: number[] }> = [
  {
    name: 'fan',
    tris: Array.from({ length: 24 }, (_, k) => {
      const at = (i: number) => [1 + Math.cos((turn * i) / 24), Math.sin((turn * i) / 24)];
      return [1, 0, ...at(k), ...at(k + 1)];
    }).flat(),
  },
  {
    name: 'grid',
    tris: Array.from({ length: 36 }, (_, k) => {
      const [i, j] = [k % 6, Math.floor(k / 6)];
      const at = (a: number, b: number) => [-1 + (2 * a) / 6, -1 + (2 * b) / 6];
      return [...at(i, j), ...at(i + 1, j), ...at(i + 1, j + 1), ...at(i, j), ...at(i + 1, j + 1), ...at(i, j + 1)];
    }).flat(),
  },
];

/**
 * What lib/plane-map.ts answers for each map and window: the turns and fold
 * points it finds, every and the first place it shows each point, and lines,
 * shapes and triangles carried to the screen (by their ends only: the
 * renderer's cutting of a run, web/render2d.ts mappedSegment, needs a browser
 * to load). Asked in this order, which the Swift test follows.
 */
export function recordPlanes(lib: typeof import('../../lib/plane-map.ts')): unknown {
  const { parsePlaneMap, PlaneInverse, planeLines, planeShapes, planeWorldBox, pixelSpan } = lib;
  return INVERSES.map(([text, lo, hi]) => {
    const map = parsePlaneMap(text);
    const box = { lo, hi };
    const inverse = new PlaneInverse(map, box);
    const vertex =
      (pts: number[]) =>
      (k: number): [number, number] => [pts[2 * k], pts[2 * k + 1]];
    const mid: [number, number] = [(lo[0] + hi[0]) / 2 + 0.1, (lo[1] + hi[1]) / 2 + 0.2];
    return {
      map: text,
      lo,
      hi,
      world: lib.planeToWorld(map, ...mid),
      jacobian: lib.planeJacobian(map, ...mid),
      pixel: pixelSpan(map, ...mid, 0.01, 0.02),
      worldBox: planeWorldBox(map, box),
      turns: inverse.turns(),
      folds: inverse.foldPoints(),
      symmetric: [inverse.symmetric([turn, 0]), inverse.symmetric([1, 0])],
      points: POINTS.map(p => ({
        p,
        mayShow: inverse.mayShow(...p),
        all: inverse.all(...p),
        first: inverse.first(...p),
        solve: inverse.solve(...p, mid),
        follow: inverse.follow(...p, mid, 1),
      })),
      lines: LINES.map(l => ({ ...l, out: planeLines(inverse, l.pts.length / 2, vertex(l.pts), l.closed) })),
      shapes: SHAPES.map(s => ({ ...s, out: planeShapes(inverse, s.pts.length / 2, vertex(s.pts)) })),
      meshes: MESHES.map(m => ({ ...m, out: Array.from(inverse.triangles(m.tris)) })),
    };
  });
}
