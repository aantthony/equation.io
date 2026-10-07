---
kind: note
title: True/false readout
form: 1 < 2
short: true/false readout
---

A true/false readout under the row: a comparison with no plot coordinate,
or an identity that holds everywhere. Draws nothing on the graph.

## Examples

- Decided comparison: `1 < 2`
- Comparison that follows a slider: `a = 2; a^2 > 3`
- Identity: `sin(x)^2 + cos(x)^2 = 1`

## Pitfalls

- An identity is checked numerically at random points: evidence, not a
  proof. An equation that does not quite hold (`= 1.0001`) stays an
  (empty) implicit [curve](#implicit2d).

## Details

- Decided comparisons: `2+2=4` reads “Always true (4 = 4)”; `e=2` reads
  “Never true (2.71828 ≠ 2)”. Comparisons involving sliders/time say
  “True now” or “False now”. They draw no degenerate implicit curve.
- Identities: an equation in x, y, z and t whose two sides agree everywhere
  reads “Holds everywhere (checked numerically)” instead of drawing a curve.
  The check compares both sides at many random points, for any slider
  values, so it is evidence, not a proof. `sin(x)^2 + cos(x)^2 = 1` holds;
  `sin(x)^2 + cos(x)^2 = 1.0001` does not, and stays an (empty) implicit
  curve. The wave equation for d'Alembert's solution:
  `c = 1; g(s) = exp(-s^2); f(x, t) = (g(x - c t) + g(x + c t))/2;
  y = f(x, t); d^2/dt^2 f(x, t) = c^2 ∇^2 f(x, t)`. The pulse splits in two
  and the last row holds everywhere. (u and w are the parametric and
  complex variables, so they cannot name the solution.)
