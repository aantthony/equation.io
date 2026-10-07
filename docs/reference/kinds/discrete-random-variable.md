---
kind: pmf
title: Discrete random variable
form: K ~ Binomial(10, 0.5)
short: stems of a discrete random variable
---

A discrete random variable, drawn as its probability mass function: a stem
at each value it takes.

## Examples

- Binomial: `K ~ Binomial(10, 0.5)`
- Poisson with a slider: `m = 4; X ~ Poisson(m)`
- Sum of two dice: `X ~ DiscreteUniform(1, 6); Y ~ DiscreteUniform(1, 6); X + Y`

## Details

- Discrete random variable: `X ~ Binomial(n, p)`, `Poisson(mean)`,
  `Geometric(p)`, `NegativeBinomial(r, p)`, `Bernoulli(p)`,
  `DiscreteUniform(a, b)` (aliases `Binom`, `Pois`, `Geom`, `NegBin`;
  case-insensitive, no bare standard form). The row draws the pmf as stems —
  a dot at (k, P(X = k)) on a thin line from the axis — at the whole numbers
  in view. Conventions, fixed: `Geometric(p)` is the TRIAL of the first
  success, support 1, 2, 3, … (mean 1/p); `NegativeBinomial(r, p)` counts
  FAILURES before the r-th success, support 0, 1, 2, … (mean r(1 − p)/p), and
  r > 0 need not be whole — so `NegativeBinomial(1, p)` is `Geometric(p)`
  shifted down by 1; `DiscreteUniform(a, b)` includes both whole-number ends,
  a ≤ b; `Bernoulli(p)` is `Binomial(1, p)`. Valid parameters: `n` a whole
  number ≥ 0; 0 ≤ p ≤ 1 for Binomial/Bernoulli (p = 0, p = 1 and n = 0 are a
  single stem of height 1, not errors); 0 < p ≤ 1 for Geometric and
  NegativeBinomial; `mean` > 0 (`Poisson(0)` is an error). A bad value —
  written out or held by a slider, e.g. n = 2.5 — is an error on the row
  naming the parameter (`Binomial(n, p) needs a whole number n ≥ 0 (n = 2.5).`);
  use `round(n)` for a slider with fractional steps. A parameter animated
  with t is not judged: at instants where it is invalid nothing is drawn.
  `P(…)` over one discrete variable with constant bounds is exact (closed-form
  cdf, any size of n or mean) and highlights the selected stems, and strict
  and non-strict bounds are different events: `P(X < 3)` stops at 2,
  `P(X <= 3)` includes 3, `P(2 < X <= 5)` is 3, 4, 5, `P(X < 2.5)` is
  `P(X <= 2)`. A bound within rounding of a whole number is that number
  (`a = 0.1*3*10` is 3), as for the parameters. Point events exist only here: `P(X = 3)` (also `==`) is that
  stem's height and `P(X != 3)` its complement; over a continuous variable
  they are an error (the value would be 0). `E(X)` is the exact closed-form
  mean, marked on the axis. Zoomed out past 1024 whole numbers in view
  (`Poisson(1000000)`, `DiscreteUniform(-1000000, 1000000)`) the stems merge
  into the filled outline of the same exact heights.
- Arithmetic over discrete variables: `S = X + Y`, `D^2`, `D / 2`, `1 / N`,
  `{X > Y: X, Y}`, a bare `X + Y` row, `E(X Y)`, `P(X + Y = 7)`, `P(X > Y)`,
  `P(X = Y)`. A variable built ONLY on discrete bases is discrete: its row
  draws a pmf as stems — never a smoothed curve — at its atoms' true
  locations, which need not be whole numbers (`D / 2` stands on the halves,
  `D^2` on the squares, `sin(D)` wherever it lands); values equal up to
  rounding are one atom (`0.1 X + 0.2 Y` at X = Y = 1 is the atom 0.3). It is
  EXACT: the joint of the independent bases is enumerated (each unbounded base
  cut where its tails hold < 1e-12; independent parts convolve, so ten dice are
  cheap), the readout is `μ = …, σ = …`, and `E(…)` prints 4 places. The joint
  is over the BASES, so dependence is kept: `X + X` is 2X (even numbers only),
  `X - X` is the atom 0, `P(X > X)` is 0, and with `A = X + Y; B = X - Y`,
  `P(A > B)` is `P(Y > 0)`. Every `P(…)` keeps its strictness, joint events
  included — ties have mass: `P(X > Y)` + `P(X = Y)` = `P(X >= Y)` — and a
  bound is matched to an atom up to rounding (`P(S <= 0.1 + 0.2)` includes the
  atom 0.3). Where g is undefined or infinite (`1 / N` at N = 0) that mass is
  no value: the readout adds `P(defined) ≈ …`, as for densities. A mean whose
  sum diverges (`2^G` over `Geometric(0.3)`) reads `no stable mean (heavy
  tails)` / median and IQR instead of a truncated sum. Closed families answer
  through the law itself, at any size: a plain sum of independent Poissons is
  Poisson, of Binomials/Bernoullis sharing one p is Binomial, of
  NegativeBinomials sharing one p is NegativeBinomial (`X + X`, `2X`, `X + 1`
  are not — they enumerate). When the joint is too large to enumerate (more
  than 131072 points in one step: `A B C` over three `Poisson(30)`, anything
  over `Geometric(0.00001)`) the row falls back to the joint sample, says so —
  `μ ≈ …, σ ≈ … (sampled)`, `P(…)` to 3 places; a sampled moment whose tail
  cannot be certified is not printed (`σ unstable`, `σ = ∞`, or median and
  IQR with `no stable mean`) — and still draws a pmf: the
  frequency of each sampled value as stems, or past 1024 distinct values a
  histogram on the values' own lattice with heavy atoms (the 0 of
  `L B`, B Bernoulli) kept as stems; values on no lattice read `(sampled: too
  many distinct values to resolve the pmf)`.
