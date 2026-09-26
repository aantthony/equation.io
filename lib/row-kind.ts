/**
 * A row's kind as the tools report it: the MCP's rows (worker/mcp.ts) and
 * voice mode's get_graph (web/main.ts) share this one vocabulary.
 */
import type { CpuPlan } from './compiler.ts';
import type { Definition } from './defs.ts';
import type { PublicKind } from './math-object.ts';
import { type Classified, publicKind } from './plot.ts';
import type { ViewSpec } from './view.ts';

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

export function rowKind(row: KindSource, tables: { has(name: string): boolean }): string | undefined {
  if (row.comment) return 'comment (group heading)';
  // `adults = person[…]` scans as a constant, but what it defines is another data file.
  if (row.def)
    return `definition (${row.def.kind === 'const' && tables.has(row.def.name) ? 'filtered data' : row.def.kind})`;
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
  implicit3d: '3D surface (the points satisfying an equation in x, y, z)',
  spacecurve: '3D curve where surfaces intersect',
  pcurve: 'parametric curve, traced as u runs from 0 to 1',
  psurface: 'parametric surface over u and v in 0..1',
  pregion: 'filled 2D region traced by two parameters (u, v, or intervals), each over its range',
  projected2d: 'shaded 2D region swept by a family over an interval, like y = sin(a x) for a = interval(1, 2)',
  vfield2d: '2D vector field, drawn as flowing streamlines',
  vfield3d: '3D vector field',
  point: 'a point',
  polygon: 'geometric figure (segment, polyline, vector arrow, polygon, circle, …)',
  label: 'text label at a point',
  trail: 'motion trail behind a moving point',
  orbit: 'path of a simulated state over a time range',
  system: 'solutions of a system of equations (points or curves)',
  value:
    'number readout under the row; draws nothing on the graph, except a definite integral, which shades the area it measures',
  note: 'true/false readout under the row; draws nothing on the graph',
  tuple: 'tuple of more than 3 numbers, like sort(L) of 5 values: a readout under the row; draws nothing',
  family: 'one copy of the row per list element',
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
  automaton: 'cellular automaton grid',
  density: 'probability density curve of a random variable',
  pmf: 'probability mass function (stems) of a discrete random variable',
  prob: 'probability, shaded under the density, with its value as a readout',
  expect: 'expected value readout, marked on the density',
};
