/**
 * A row's kind as the tools report it: the MCP's rows (worker/mcp.ts) and
 * voice mode's get_graph (web/main.ts) share this one vocabulary.
 */
import type { CpuPlan } from './compiler.ts';
import type { Definition } from './defs.ts';
import type { PublicKind } from './math-object.ts';
import { type Classified, publicKind } from './plot.ts';
import type { ViewSpec } from './view.ts';
import type { Expr } from './expr.ts';
import { flatName, flatOfNode } from './pga.ts';

export interface KindSource {
  comment?: boolean;
  def?: Definition;
  view?: ViewSpec;
  dist?: 'density' | 'pmf' | 'probability' | 'expectation';
  /** Why the row can't be read here: it reads a data file on the author's device. */
  dataLocal?: string;
  cls?: Classified;
  cpu?: CpuPlan;
}

/** Probability rows classify as plain curves and regions; these say what they are. */
const DIST_KINDS = {
  density: 'random variable (density curve)',
  pmf: 'discrete random variable (pmf stems)',
  expectation: 'expectation (mean readout)',
} as const;

/** Names the document binds to something other than a number, so a `const`
 *  definition of one is not reported as though it were a slider. */
export interface KindNames {
  tables: { has(name: string): boolean };
  intervals?: { has(name: string): boolean };
  mats?: { has(name: string): boolean };
  tensors?: { has(name: string): boolean };
  multivectors?: { has(name: string): boolean; get?(name: string): Expr | undefined };
  lists?: { has(name: string): boolean };
  points?: { has(name: string): boolean };
}

export function rowKind(row: KindSource, names: KindNames): string | undefined {
  if (row.comment) return 'comment (group heading)';
  if (row.def) return `definition (${row.def.kind === 'const' ? constKind(row.def.name, names) : row.def.kind})`;
  if (row.view?.kind === 'split') return 'panel divider (the rows below it draw in a panel of their own)';
  if (row.view?.kind === 'grid') return "grid (what draws behind its panel's plots)";
  if (row.view) return `viewport (${row.view.kind})`;
  if (row.dist === 'probability') {
    // An event with no single-variable shape (P(X < Y)) is estimated, not drawn.
    return row.cpu?.type === 'prob' && !row.cpu.shade ? 'probability (readout only)' : 'probability (shaded area)';
  }
  if (row.dist) return DIST_KINDS[row.dist];
  if (row.dataLocal) return "data (reads a file on the author's device)";
  return row.cls ? publicKind(row.cls.object) : undefined;
}

/** What each drawn row kind looks like, for the voice agent: kind names like
 *  `implicit2d` are the MCP's public vocabulary, not words a model can reason
 *  about. The Record keeps it total — a new kind fails the typecheck here. */
export const KIND_MEANINGS: Record<PublicKind, string> = {
  implicit2d: '2D curve (the set of points satisfying an equation)',
  ineq2d: 'shaded 2D region (an inequality)',
  scalar2d: '2D scalar field, shaded by sign and size (row colour positive, its complement negative)',
  scalar3d:
    '3D scalar field, drawn as a translucent cloud denser where the field is larger in size (row colour positive, its complement negative)',
  implicit3d: '3D surface (the points satisfying an equation in x, y, z)',
  spacecurve: '3D curve where surfaces intersect',
  pcurve: 'parametric curve, traced as u runs from 0 to 1',
  psurface: 'parametric surface over u and v in 0..1',
  pregion: 'filled 2D region traced by two parameters (u, v, or intervals), each over its range',
  solid: 'solid in 3D filled by three parameters (u, v, or intervals), drawn as the faces of their range',
  projected2d: 'shaded 2D region swept by a family over an interval, like y = sin(a x) for a = interval(1, 2)',
  vfield2d: '2D vector field, drawn as flowing streamlines',
  tfield2d:
    '2D matrix (tensor) field, drawn as a grid of glyphs: each the image of a small circle under the matrix, with a spoke where e_x goes; streamlines(M), or a toggle, traces its major eigenvector instead',
  vfield3d: '3D vector field',
  point: 'a point',
  polygon: 'geometric figure (segment, polyline, vector arrow, polygon, circle, …)',
  label: 'text label at a point',
  trail: 'motion trail behind a moving point',
  orbit: 'path of a simulated state over a time range',
  geodesic:
    "geodesic from a start point in a direction, integrated along a parametric surface, or in the plane under its panel's ds^2 metric (a massive particle's path in a spacetime, or a light ray from lightray(…))",
  metric:
    'a panel’s own metric, ds^2 = … in the differentials of its coordinates: draws nothing; geodesic and lightray rows in the panel follow it',
  lightcone:
    'light cones of the panel’s ds^2 metric: lightcones draws them over the panel, lightcone(P) one at a point — on a spacetime diagram the two null directions as a wedge opening to the future, with a time beside x and y the ellipse of the coordinate velocities light can have',
  tidal:
    'tidal forces of the panel’s ds^2 metric on an observer held at rest: tidal draws them over the panel, tidal(P) at a point — crossed bars along the directions a small cloud of free particles is stretched (arrowheads out) or squeezed (arrowheads in), as long as the tide is strong',
  system: 'solutions of a system of equations (points or curves)',
  value:
    'number readout under the row; draws nothing on the graph, except a definite integral, which shades the area it measures',
  note: 'true/false readout under the row; draws nothing on the graph',
  tuple: 'tuple of more than 3 numbers, like sort(L) of 5 values: a readout under the row; draws nothing',
  family: 'one copy of the row per list element',
  multivector:
    'multivector or quaternion, like e_xy or quat(1, 2, 3, 4): its grades drawn as arrows, oriented discs and cubes (a rotor as the turn it makes), its value read out',
  flat: "point, line or plane of projective geometry, like join(A, B) or meet(L, M): drawn, with its equation (or an ideal point's direction) read out",
  action: 'action(M): where a matrix sends the unit square, circle and axes, with the matrix read out',
  complex2d: 'complex function shown on the plane',
  domain2d: 'domain colouring of a complex function',
  conformal2d: 'conformal map: the image of a grid under a complex function',
  fractal2d: 'escape-time fractal',
  rgb2d: 'colour field (RGB), filling the plane',
  hsl2d: 'colour field (HSL), filling the plane',
  oklch2d: 'colour field (OKLCH), filling the plane',
  sequence: 'sequence, drawn as dots at whole numbers n',
  cobweb: 'cobweb diagram of a recurrence',
  bifurcation: 'bifurcation / orbit diagram of a recurrence',
  vlist: 'list of numbers, a dot plot on the number line: each value at x = value, copies stacked upward',
  plist: 'list of points',
  dlist: 'data column, a dot plot on the number line: each value at x = value, copies stacked upward',
  dscatter: 'scatter plot of data',
  histogram: 'histogram',
  automaton:
    'cellular automaton on the integer lattice: a 1D rule draws its space-time diagram (cells across, steps down), a 2D rule one generation of its board, stepping with t',
  graph:
    'graph drawn node-link: one arrow per (from, to) element, parallel edges counted, labels on edges; laid out automatically',
  lattice: 'table of values on the integer lattice, one cell per (i, j), shaded by value and printed when zoomed in',
  density: 'probability density curve of a random variable',
  pmf: 'probability mass function (stems) of a discrete random variable',
  prob: 'probability, shaded under the density, with its value as a readout',
  expect: 'expected value readout, marked on the density',
};

/** Each kind's smallest form and what it draws in a few words: the Apple
 *  app's list_kinds (lib/assistant-tools.ts). A form of several rows splits
 *  on `;`, and its last row is the kind; assistant-tools.test.ts analyzes each.
 *  Common kinds first: the model reads this list top down. Plain shapes at
 *  unit size, so the model adapts a form rather than copying an answer. */
export const KIND_FORMS: Record<PublicKind, readonly [form: string, meaning: string]> = {
  implicit2d: ['x^2 + y^2 = 9', '2D curve: y = f(x), or any equation in x, y'],
  ineq2d: ['y < x^2', 'shaded 2D region'],
  pcurve: ['(cos(2pi u), sin(2pi u))', 'parametric curve, u from 0 to 1; 3 components for 3D'],
  point: ['(1, 2)', 'point; A = (1, 2) names it and makes it draggable'],
  polygon: [
    'polygon((0, 0), (2, 0), (1, 2))',
    'figure: segment, vector, polygon, circle, …; hull of 3D points is a solid',
  ],
  label: ['label((1, 2), "text")', 'text beside a point'],
  value: ['int[0..pi] sin(x) dx', 'number readout; a definite integral also shades its area'],
  family: ['y = x^[1, 2, 3]', 'one copy of the row per list element'],
  implicit3d: ['z = sin(x) cos(y)', '3D surface: z = f(x, y), or an equation in x, y, z'],
  psurface: ['(sin(pi v)cos(2pi u), sin(pi v)sin(2pi u), cos(pi v))', 'parametric surface, u and v from 0 to 1'],
  solid: ['(interval(0, 1), interval(0, 2), interval(0, 3))', 'solid in 3D filled by three parameters or intervals'],
  spacecurve: ['(x^2 + y^2 + z^2, z) = (9, 1)', '3D curve where two surfaces meet'],
  vfield2d: ['(x, -y)', '2D vector field, as streamlines'],
  vfield3d: ['(-y, x, 0.5)', '3D vector field'],
  scalar2d: ['sin(x) cos(y)', 'expression in x, y, shaded by its value'],
  scalar3d: ['exp(-(x^2 + y^2 + z^2))', 'expression in x, y, z, drawn as a cloud'],
  trail: ['A = (2cos(3t), 2sin(2t)); trail(A)', 'path behind a moving point'],
  pregion: ['r = interval(1, 2); (r cos(2pi u), r sin(2pi u))', 'filled 2D region traced by two parameters'],
  projected2d: ['a = interval(1, 2); y = sin(a x)', 'region swept by a curve as a runs over an interval'],
  system: ['(x^2 + y^2, y) = (4, x)', 'solutions of simultaneous equations'],
  note: ['1 < 2', 'true/false readout'],
  tuple: ['sort([5, 3, 1, 4, 2])', 'readout of a tuple of more than 3 numbers'],
  sequence: ['a_n = 1/n', 'sequence, as dots at whole numbers n'],
  cobweb: ['a_0 = 0.2; a_{n+1} = 3.2 a_n (1 - a_n)', 'cobweb diagram of a recurrence'],
  bifurcation: ['a_{n+1} = x a_n (1 - a_n)', 'orbit diagram of a recurrence as x varies'],
  orbit: ["th' = om; om' = -sin(th); th(0) = 1; th(0..20)", 'a simulated state over a time range'],
  vlist: ['[1, 2, 2, 3]', 'list of numbers, as a dot plot'],
  plist: ['[(1, 2), (2, 3), (3, 5)]', 'list of points'],
  histogram: ['hist([1, 2, 2, 3])', 'histogram of a list'],
  dlist: ['data = open("file.csv"); data.height', 'data column, as a dot plot'],
  dscatter: ['data = open("file.csv"); (data.age, data.height)', 'scatter plot of data'],
  density: ['X ~ Normal(0, 1)', 'density curve of a random variable'],
  pmf: ['K ~ Binomial(10, 0.5)', 'stems of a discrete random variable'],
  prob: ['X ~ Normal(0, 1); P(X < 1)', 'probability, shaded, with its value'],
  expect: ['X ~ Normal(0, 1); E(X)', 'expected value readout'],
  complex2d: ['ln(w)', 'complex function of w = x + iy'],
  domain2d: ['domain(w^2 - 1)', 'domain colouring of a complex function'],
  conformal2d: ['conformal(w^2)', 'image of a grid under a complex function'],
  fractal2d: ['iter(z^2 + w)', 'escape-time fractal'],
  rgb2d: ['rgb(x/4, y/4, 0.5)', 'colour field (RGB) filling the plane'],
  hsl2d: ['hsl(atan2(y, x), 1, 0.5)', 'colour field (HSL) filling the plane'],
  oklch2d: ['oklch(0.7, 0.15, atan2(y, x))', 'colour field (OKLCH) filling the plane'],
  tfield2d: ['jacobian((x^2 - y^2, 2x y))', '2D matrix field, as glyphs'],
  multivector: ['gp(e_x, e_y)', 'multivector or quaternion, drawn by grade'],
  flat: ['join((0, 0), (1, 1))', 'projective point, line or plane'],
  action: ['action(((1, 1), (0, 1)))', 'what a matrix does to the unit square'],
  automaton: ['c_0[i] = {i = 0: 1, 0}; c_{n+1}[i] = mod(c_n[i-1] + c_n[i+1], 2)', 'cellular automaton'],
  graph: ['k = [0..5]; graph(k, mod(k + 1, 6))', 'node-link graph of (from, to) edges'],
  lattice: ['T[i, j] = {i > 0: {j > 0: gcd(i, j)}}', 'table of values on the integer lattice'],
};

function constKind(name: string, names: KindNames): string {
  // `adults = person[…]` scans as a constant, but what it defines is another data file.
  if (names.tables.has(name)) return 'filtered data';
  if (names.intervals?.has(name)) return 'interval';
  if (names.mats?.has(name)) return 'matrix';
  if (names.tensors?.has(name)) return 'tensor';
  if (names.multivectors?.has(name)) {
    // A line or plane is written in as a multivector is, but is not one.
    const flat = flatOfNode(names.multivectors.get?.(name) ?? { kind: 'num', value: 0 });
    return (flat && flatName(flat.dim, flat.grade)) ?? 'multivector';
  }
  if (names.points?.has(name)) return 'point';
  if (names.lists?.has(name)) return 'list';
  return 'const';
}
