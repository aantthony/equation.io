---
kind: value
title: Value readout
form: int[0..pi] sin(x) dx
short: number readout; a definite integral also shades its area
---

A number, read out under the row: a row with no plot coordinate draws
nothing on the graph, except a lone definite integral, which also shades the
area it measures.

## Forms

- Any expression with no x, y or z: `2+2`, `sqrt(a)`, `|A - B|`.
- `int[a..b] f(x) dx`: the value, and the area shaded between f and the axis
  over [a, b].
- Reductions and measurements: `mean(L)`, `distance(A, B)`, `angle(A, B, C)`.

## Examples

- Arithmetic: `2+2`
- Area under one arch of sin: `int[0..pi] sin(x) dx`
- Distance between two points: `A = (0, 0); B = (3, 4); |A - B|`
- Mean of a list: `L = [2, 4, 9]; mean(L)`

## Pitfalls

- A number is not assumed to mean `y = number`: write `y = 4` for the line.
- Shading needs the integral alone on its row: `2 int[0..1] x dx`, a sum of
  integrals or a definition (`A = int[0..1] x^2 dx`) is a plain number.

## Details

- Value: a bare expression with no plot coordinate — `2+2`, `sqrt(a)` with a
  slider a, `|A - B|` between named points, `int[0..1] x^2 dx`, `sin(t)` —
  draws nothing (a lone definite integral shades its area) and reads out `= 4` (or `≈ 1.41421`) under the row, live as
  sliders, states and t move. The tool result reports it as kind `value`
  with the number in `value`. A number is not assumed to mean `y = number`:
  write `y = 4` for the horizontal line.
