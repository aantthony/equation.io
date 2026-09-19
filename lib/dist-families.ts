/**
 * The one table of distribution families: every name a `~` row accepts, its
 * parameters, and how it reads in help. lib/dist.ts parses and validates from
 * it, lib/regression.ts decides "declaration or model?" from it, and
 * lib/syntax-help.ts builds its signatures from it — so a family or alias
 * added here is known to all three, and one missed elsewhere cannot silently
 * turn `X ~ NewName(…)` into a regression. No imports: everything may use it.
 */

export type BaseKind =
  | 'normal' | 'uniform' | 'exponential'
  | 'gamma' | 'beta' | 'chisquared' | 'studentt' | 'lognormal' | 'cauchy' | 'weibull'
  // Laws on the whole numbers (`discrete` in the table): a pmf drawn as stems.
  | 'binomial' | 'poisson' | 'geometric' | 'negbinomial' | 'bernoulli' | 'discreteuniform';

/** What a parameter's value must satisfy, beyond being a finite number. */
export interface DistParam {
  name: string;
  /** Must be > 0. */
  positive?: boolean;
  /** Must be a whole number (`count`: and ≥ 0). A value within rounding of a
   *  whole number is one — `n = 0.1 * 30` is 3 — see wholeNumber in specfn.ts. */
  whole?: boolean | 'count';
  /** A probability: '[0,1]' may be degenerate (an atom), '(0,1]' may not be 0. */
  unit?: '[0,1]' | '(0,1]';
}

export interface DistFamily {
  kind: BaseKind;
  /** The canonical spelling; matching is case-insensitive. */
  name: string;
  aliases: string[];
  /** True for a law on the integers (a pmf, drawn as stems). */
  discrete?: boolean;
  /** Parameters in order, each with what its value must satisfy. */
  params: DistParam[];
  /** Standard parameters a bare name takes (`X ~ N`); absent where the
   *  family has no standard member (`X ~ Gamma` must say which). */
  defaults?: number[];
  /** Spellings that are ALSO a function or an everyday coefficient name: over
   *  a declared data list `Y ~ exp(a X)`, `Y ~ gamma(a X)`, `Y ~ beta (X - 1)`
   *  are regression models; with an undeclared left side they declare. */
  modelNames?: string[];
  /** Completes "Declare …" in syntax help. */
  help: string;
}

export const DIST_FAMILIES: readonly DistFamily[] = [
  {
    kind: 'normal', name: 'Normal', aliases: ['N'], defaults: [0, 1],
    params: [{ name: 'mean' }, { name: 'sd', positive: true }],
    help: 'a normal random variable',
  },
  {
    kind: 'uniform', name: 'Uniform', aliases: ['U'], defaults: [0, 1],
    params: [{ name: 'lo' }, { name: 'hi' }],
    help: 'a uniform random variable',
  },
  {
    kind: 'exponential', name: 'Exponential', aliases: ['Exp'], defaults: [1], modelNames: ['exp'],
    params: [{ name: 'rate', positive: true }],
    help: 'an exponential random variable',
  },
  {
    kind: 'gamma', name: 'Gamma', aliases: [], modelNames: ['gamma'],
    params: [{ name: 'shape', positive: true }, { name: 'rate', positive: true }],
    help: 'a gamma random variable (rate, not scale: mean = shape/rate)',
  },
  {
    kind: 'beta', name: 'Beta', aliases: [], modelNames: ['beta'],
    params: [{ name: 'a', positive: true }, { name: 'b', positive: true }],
    help: 'a beta random variable on [0, 1]',
  },
  {
    kind: 'chisquared', name: 'ChiSquared', aliases: ['ChiSq', 'Chi2'],
    params: [{ name: 'df', positive: true }],
    help: 'a chi-squared random variable (alias ChiSq)',
  },
  {
    kind: 'studentt', name: 'StudentT', aliases: ['T'], modelNames: ['t'],
    params: [{ name: 'df', positive: true }],
    help: 'a Student t random variable (alias T)',
  },
  {
    kind: 'lognormal', name: 'LogNormal', aliases: [], defaults: [0, 1],
    params: [{ name: 'mu' }, { name: 'sigma', positive: true }],
    help: 'a log-normal random variable: ln X ~ Normal(mu, sigma)',
  },
  {
    kind: 'cauchy', name: 'Cauchy', aliases: [], defaults: [0, 1],
    params: [{ name: 'location' }, { name: 'scale', positive: true }],
    help: 'a Cauchy random variable (no mean: readouts use median/IQR)',
  },
  {
    kind: 'weibull', name: 'Weibull', aliases: [],
    params: [{ name: 'shape', positive: true }, { name: 'scale', positive: true }],
    help: 'a Weibull random variable',
  },
  // --- discrete: laws on the integers. The conventions below are the ones
  // scipy uses, and each `help` says so, because two are genuinely contested
  // (Geometric counts TRIALS, from 1; NegativeBinomial counts FAILURES, from
  // 0 — so NegativeBinomial(1, p) is Geometric(p) − 1). None of these
  // spellings is a builtin function or an everyday coefficient name, so none
  // is a modelName: `Y ~ Poisson(3)` declares whatever is on the left.
  {
    kind: 'binomial', name: 'Binomial', aliases: ['Binom'], discrete: true,
    params: [{ name: 'n', whole: 'count' }, { name: 'p', unit: '[0,1]' }],
    help: 'a binomial random variable: successes in n trials (alias Binom)',
  },
  {
    kind: 'poisson', name: 'Poisson', aliases: ['Pois'], discrete: true,
    params: [{ name: 'mean', positive: true }],
    help: 'a Poisson random variable (alias Pois)',
  },
  {
    kind: 'geometric', name: 'Geometric', aliases: ['Geom'], discrete: true,
    params: [{ name: 'p', unit: '(0,1]' }],
    help: 'a geometric random variable: the TRIAL of the first success, 1, 2, 3, … (alias Geom)',
  },
  {
    kind: 'negbinomial', name: 'NegativeBinomial', aliases: ['NegBin'], discrete: true,
    params: [{ name: 'r', positive: true }, { name: 'p', unit: '(0,1]' }],
    help: 'a negative binomial random variable: FAILURES before the r-th success, 0, 1, 2, …; r > 0 need not be whole (alias NegBin)',
  },
  {
    kind: 'bernoulli', name: 'Bernoulli', aliases: [], discrete: true,
    params: [{ name: 'p', unit: '[0,1]' }],
    help: 'a Bernoulli random variable: 1 with probability p, else 0',
  },
  {
    kind: 'discreteuniform', name: 'DiscreteUniform', aliases: [], discrete: true,
    params: [{ name: 'a', whole: true }, { name: 'b', whole: true }],
    help: 'a uniform random variable on the whole numbers a, a + 1, …, b (both included)',
  },
];

const BY_NAME = new Map<string, DistFamily>(
  DIST_FAMILIES.flatMap(f => [f.name, ...f.aliases].map((n): [string, DistFamily] => [n.toLowerCase(), f])),
);
const BY_KIND = new Map<BaseKind, DistFamily>(DIST_FAMILIES.map(f => [f.kind, f]));

/** The family a name or alias spells, in any capitalization. */
export const distFamily = (name: string): DistFamily | undefined => BY_NAME.get(name.toLowerCase());

export const familyOf = (kind: BaseKind): DistFamily => BY_KIND.get(kind)!;

/** `Gamma(shape, rate)`. */
export const distUsage = (f: DistFamily): string => `${f.name}(${f.params.map(p => p.name).join(', ')})`;

/** True when this spelling doubles as a regression model over declared data. */
export const isModelName = (name: string): boolean =>
  !!distFamily(name)?.modelNames?.includes(name.toLowerCase());
