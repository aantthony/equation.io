/** Compatibility baseline for docs/typed-values-plan.md, before changing IR.
 * Packed columns need local bytes, so those two kinds are tested at classify().
 * Keep the expected strings explicit: deriving them from plots would hide an
 * accidental public rename. The Record makes new kinds require a fixture.
 */
import type { PublicKind } from '../lib/math-object.ts';

export const PUBLIC_KIND_ROWS = {
  implicit2d: ['y = x^2'],
  ineq2d: ['x^2 + y^2 < 4'],
  scalar2d: ['x + y'],
  implicit3d: ['x^2 + y^2 + z^2 = 4'],
  complex2d: ['w^2'],
  domain2d: ['domain(w^2)'],
  rgb2d: ['rgb(cos(x)^2, cos(y)^2, 0.5)'],
  hsl2d: ['hsl(arg(w), 1, 0.5)'],
  oklch2d: ['oklch(0.7, 0.15, arg(w))'],
  conformal2d: ['conformal(w^2)'],
  fractal2d: ['iter(z^2 + w)'],
  point: ['(1, 2)'],
  note: ['1 < 2'],
  value: ['2 + 3'],
  trail: ['trail((cos(t), sin(t)))'],
  polygon: ['segment((0, 0), (1, 1))'],
  spacecurve: ['(x^2 + y^2, z) = (1, 0)'],
  system: ['(x + y, x - y) = (3, 1)'],
  vfield3d: ['(-y, x, z)'],
  vfield2d: ['(-y, x)'],
  pcurve: ['(cos(u), sin(u), u)'],
  psurface: ['(u, v, u v)'],
  vlist: ['[1, 2, 3]'],
  plist: ['[(1, 2), (3, 4)]'],
  histogram: ['hist([1, 2, 2, 3])'],
  sequence: ['a_n = 1/(n + 1)^2'],
  cobweb: ['a_{n+1} = cos(a_n)'],
  bifurcation: ['a_{n+1} = x a_n (1 - a_n)'],
  automaton: ['c_{n+1}[i] = mod(c_n[i-1] + c_n[i+1], 2)'],
  density: ['X ~ Normal(0, 1)', 'X^2 + 1'],
  pmf: ['X ~ Binomial(4, 0.5)'],
  prob: ['X ~ Binomial(4, 0.5)', 'P(X <= 2)'],
  expect: ['X ~ Binomial(4, 0.5)', 'E(X)'],
  family: ['y = [1, 2] x'],
  orbit: ["q' = -q", 'q(0) = 1', 'q(0..3)'],
} satisfies Record<Exclude<PublicKind, 'dlist' | 'dscatter'>, string[]>;

/** Distribution rows deliberately retain MCP's descriptive presentation labels. */
export const DISTRIBUTION_MCP_KINDS = {
  density: 'random variable (density curve)',
  pmf: 'discrete random variable (pmf stems)',
  prob: 'probability (shaded area)',
  expect: 'expectation (mean readout)',
} as const;
