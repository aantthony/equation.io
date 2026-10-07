---
kind: prob
title: Probability
form: X ~ Normal(0, 1); P(X < 1)
short: probability, shaded, with its value
---

A probability: `P(…)` of an event, shaded under the density (or the stems
it counts highlighted) with its value as a readout.

## Examples

- Normal between 0 and 2: `X ~ Normal(1, 0.5); P(0 < X < 2)`
- Poisson at most 3: `X ~ Poisson(4); P(X <= 3)`

## Details

- Probability: `P(X < 2)`, `P(X > 0)` or `P(0 < X < 2)` shades that area
  under X's density and shows the numeric probability (normal CDF) as a
  readout under the row.
- Probability: `P(X < 2)`, `P(-1 < X < 2)`, and bounds around one expression
  like `P(0.5 < X + Y < 1.5)` — exact (closed-form CDF or polynomial
  integration) with the area under the density shaded, whenever the bounded
  variable or expression has an exact law. Any other inequality —
  `P(Y > 0.5)` for a nonlinear Y, `P(Y > X)` — is estimated from the joint
  samples; the row shows the value as `≈`.
