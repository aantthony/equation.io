---
kind: density
title: Random variable
form: X ~ Normal(0, 1)
short: density curve of a random variable
---

A random variable, drawn as its probability density curve: `X ~ Normal(0, 1)`
declares X, and arithmetic over random variables declares new ones.

## Examples

- Standard normal: `X ~ Normal(0, 1)`
- Normal with sliders: `m = 1; s = 0.5; X ~ Normal(m, s)`
- Square of a normal: `X ~ Normal(0, 1); Y = X^2`

## Pitfalls

- `P(…)` and `E(…)` rows need the variable declared in a row of its own.

## Details

- Random variable: `X ~ Normal(mean, sd)` declares X and plots its density
  curve. Parameters may use sliders and t, so `X ~ Normal(0, a)` follows the
  slider live.
- Random variable: `X ~ Normal(mean, sd)` — also `Uniform(lo, hi)` and
  `Exponential(rate)`, with short aliases `N`, `U`, `Exp`; a bare name means
  the standard parameters (`X ~ N` is Normal(0, 1)). The row plots the exact
  density curve; parameters may use sliders and t.
- More continuous families, each with an exact density, exact `P(…)` and
  exact moments. Parameter order and meaning are fixed as follows:
  `Gamma(shape, rate)` — RATE, not scale: mean = shape/rate, and
  `Exponential(r)` is `Gamma(1, r)`; `Beta(a, b)` on [0, 1];
  `ChiSquared(df)` (aliases `ChiSq`, `Chi2`) = `Gamma(df/2, 1/2)`;
  `StudentT(df)` (alias `T`, so `X ~ T(5)`); `LogNormal(mu, sigma)` where
  ln X ~ Normal(mu, sigma); `Cauchy(location, scale)`;
  `Weibull(shape, scale)`. Only `LogNormal` and `Cauchy` have a bare standard
  form, (0, 1). Names are case-insensitive and live only right of the `~`,
  so a constant `T` or a function `gamma(x)` does not collide with them.
  Shape, rate, scale, sigma, df, a and b must be > 0: a written-out bad
  value, or a constant holding one, is an error on the row naming the
  parameter (`Gamma(shape, rate) needs shape > 0.`). Densities with a pole at
  the support edge (`Gamma` with shape < 1, `ChiSquared(1)`, `Beta` with
  a or b < 1, `Weibull` with shape < 1) draw and shade up to the pole.
- Discrete mixed with continuous (`N ~ Poisson(3); Z ~ Normal(0, 1);
  Y = N + Z`, `N Z`, `P(N > Z)`, `E(N + Z)`) is a continuous MIXTURE: a density
  row, estimated from the joint sample like any other sampled density (an
  atom such as `N Z = 0` stays a stem). A point event needs discrete
  variables throughout: `P(Y = 3)`, `P(N = Z)`, `P(Z = 1)` are errors naming
  the continuous variable (the value would be 0).
- Derived random variable: `Y = X^2`, `S = X1 + X2` — arithmetic over
  declared random variables declares a new one, including piecewise
  conditionals: `Y = {X > 0: X^2, 1}`. Distinct names are independent, so
  `S = X1 + X2` is the convolution; the same name stays dependent, so
  `X + X` is exactly 2X. A bare expression in random variables (`X + Y` as
  its own row) plots that density without naming it. Affine forms stay
  exact: combinations of normals (`Z = (X + Y)/2`) are the exact normal, a
  scaled/shifted uniform is a uniform, and sums of uniforms (`S = X1 + X2`,
  the central-limit demo) draw their exact piecewise-polynomial convolution —
  the triangle's apex is a true corner. Independent Gamma-family terms
  (Gamma, ChiSquared, Exponential) with positive number coefficients whose
  scaled rates agree sum to the exact Gamma (`X1 + X2` of two `Gamma(·, 3)`,
  `2X`, a sum of chi-squareds), and the square of a standard normal
  (`Z ~ Normal(0, 1); Z^2`) is the exact `ChiSquared(1)`. Any affine
  combination of independent Cauchys with nonzero number coefficients is the
  exact Cauchy (locations add, scales add through |c|: `X + 1`, `-3X`,
  `X + C`; a slider coefficient estimates instead, since at 0 the variable
  is a constant), and a LogNormal times a
  positive number is the LogNormal with mu + ln c. These rows report exact
  μ and σ where those exist.
  Everything else (products, nonlinear or piecewise transforms, mixed
  families) is estimated from 131072 joint samples and reports μ, σ as `≈`.
  A variable with heavy tails — anything that passes the tail of a `Cauchy`
  or a `StudentT` with df ≤ 2 through, like `X + 1` — reports
  `median ≈ …, IQR ≈ …` instead: its σ (and for df ≤ 1 its mean) does not
  exist, and a sample estimate of it would be noise. Whether the mean
  exists is read off the tails (it does when they decay faster than 1/x,
  with a two-standard-error margin — and a wider one over a `Cauchy` or
  `StudentT(df ≤ 1)` base — so a mean that only just exists reads as
  unstable), and a mean that numeric integration certifies always counts, so
  `E(X^2)` over `StudentT(3)` is 3 although its σ is infinite, while
  `E(X^2 + Y)` over `StudentT(2)` has no value.
  Point masses are detected and drawn as probability stems (height = mass):
  `Y = {X > 0: 1, 2}` is two stems, `floor(4X)` four, and a mixed result
  like `{X > 0: X^2, 1}` draws its stem plus the continuous density.
