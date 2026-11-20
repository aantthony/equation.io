/**
 * Probability distribution rows.
 *
 * - `X ~ Normal(mean, sd)` (also Uniform, Exponential, Gamma, Beta,
 *   ChiSquared, StudentT, LogNormal, Cauchy, Weibull — lib/dist-families.ts)
 *   declares a random variable; the row plots its exact density. Parameters
 *   may reference constants (sliders) and t, so `X ~ Normal(0, a)` responds
 *   to the slider.
 * - `X ~ Binomial(n, p)` (also Poisson, Geometric, NegativeBinomial, Bernoulli,
 *   DiscreteUniform) declares a DISCRETE variable: the row plots its pmf as
 *   stems, `P(…)` with constant bounds is the exact mass of the whole numbers
 *   it selects (so `<` and `<=` differ, and `P(X = 3)` is a number), `E(X)`
 *   the closed-form mean. Arithmetic over discrete variables (`S = X1 + X2`,
 *   `X^2`, `X/2`, `P(X > Y)`, `P(X = Y)`, `E(g(X))`) is EXACT by enumerating
 *   the joint of the independent bases while that joint is small (JOINT_MAX),
 *   and sampled — still as a pmf, never a KDE — past it; see "derived discrete
 *   variables" below. A discrete base mixed with a continuous one
 *   (`N + Z`) is a continuous mixture and takes the sampled-density tier.
 * - `Y = g(X, …)` where the right side references random variables declares a
 *   *derived* random variable — arithmetic on distributions. `S = X1 + X2` is
 *   the convolution of independent summands, `X Y` the product distribution,
 *   and piecewise conditionals work too: `Y = {X > 0: X^2, 1}`. Derived rows
 *   (and bare expressions like `X + Y`) plot a density estimated from samples.
 * - `P(…)` takes any inequality over the declared variables: `P(X < b)`,
 *   `P(a < X < b)`, `P(Y > 0.5)`, even `P(Y > X)`. Single-variable bounds on a
 *   base distribution stay exact (closed-form CDF + shaded region); everything
 *   else is estimated from the same joint samples.
 * - `E(…)` takes any expression over the declared variables: `E(X)`,
 *   `E(X^2 + Y)`. The mean is exact when the law is (closed-form pdfs and
 *   uniform sums), the finite-sample mean otherwise, and the row draws a
 *   vertical marker at x = E under the expression's density.
 *
 * Sampling model: every base variable owns a deterministic stratified stream
 * of standard uniforms (equal-mass quantile midpoints, shuffled by a hash of
 * its name — a Latin-hypercube pairing across variables). Samples are the
 * quantile transform of that stream, so distinct names are independent while
 * a derived variable, evaluated per-sample over its dependencies, preserves
 * the joint distribution exactly: `X + X` is 2X, `P(Y > X)` sees the
 * dependence of Y on X. Streams are fixed, so results are reproducible and
 * respond continuously to slider drags (common random numbers).
 *
 * Parsing and exact base laws live in dist-base.ts, continuous sampling in
 * dist-sample.ts, discrete laws in dist-discrete.ts, and the random-variable
 * system in dist-system.ts. This file re-exports the public surface.
 */
export {
  isDiscrete,
  paramProblem,
  scanDistribution,
  parseDistribution,
  pmfExpr,
  pdfExpr,
  densityExpr,
  variableRow,
  momentsReadout,
  readoutNumber,
  NO_MEAN_INFO,
  matchProbability,
  matchExpectation,
  lowerProbBody,
  toProbability,
  toExpectation,
  regionExpr,
  integerBounds,
  probabilityValue,
  scanRandomRows,
  randomNameIn,
  checkDerived,
} from './dist-base.ts';
export type { BaseKind, BaseDist, ProbBounds, ProbSpec, ExpectSpec } from './dist-base.ts';
export {
  SAMPLE_COUNT,
  scaleCurve,
  TAIL_POOL_SIZE,
  TAIL_POOL_STATS,
  quantileClosure,
  QUANTILE_STATS,
  densityAt,
  shadePolygon,
} from './dist-sample.ts';
export type { RV, DensityCurve, Robust } from './dist-sample.ts';
export {
  discreteLaw,
  STEM_MAX,
  STEM_STATS,
  scaleStems,
  stemGeometry,
  markerHeight,
  stemDotRadius,
  selectStems,
  JOINT_MAX,
  ENUM_STATS,
} from './dist-discrete.ts';
export type { DiscreteLaw, PmfStems, StemGeometry, DiscretePmf } from './dist-discrete.ts';
export { RVSystem, buildRVDeclarations, buildRVSystem } from './dist-system.ts';
export type { Law, BuildRVOpts, BuiltRVs } from './dist-system.ts';
