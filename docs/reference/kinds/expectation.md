---
kind: expect
title: Expectation
form: X ~ Normal(0, 1); E(X)
short: expected value readout
---

An expected value: `E(…)` of an expression in random variables, read out and
marked on the density.

## Examples

- Mean of an exponential: `X ~ Exponential(2); E(X)`
- Mean of a sum of dice: `X ~ DiscreteUniform(1, 6); Y ~ DiscreteUniform(1, 6); E(X + Y)`

## Details

- Expectation: `E(X)`, `E(X^2 + Y)` — the mean of any expression in random
  variables, shown as a readout under the row and marked on the density.
- Expectation: `E(X)`, `E(2X + 3)`, `E(X^2 + Y)` — the mean of any
  expression in the declared variables, exact whenever the expression has an
  exact law (closed-form pdfs, affine combinations of normals, uniform sums)
  and the finite-sample mean otherwise. The row shows the value as a readout
  and draws a vertical marker at x = E under the expression's density. Where
  the mean does not exist (`E(X)` for a Cauchy or `StudentT(1)`, `E(X^2)`
  for a Cauchy) the readout is `no stable mean (heavy tails)` and no marker
  is drawn.
