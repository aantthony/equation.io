---
kind: ineq2d
title: Region
form: y < x^2
short: shaded 2D region
---

A shaded 2D region: the points where an inequality in x and y holds.

## Forms

- An inequality: `y < f(x)`, `x^2 + y^2 <= 9`.
- A chain: `4 <= x^2 + y^2 <= 9`, `-1 <= y - x/2 < 1`.
- Non-strict comparisons (`<=`, `>=`) draw a solid boundary.

## Examples

- Below a line: `y < x/2 + 1`
- Annulus: `4 <= x^2 + y^2 <= 9`
- Band between two lines: `-1 <= y - x/2 < 1`
- Koch snowflake: `f(z) = {re(z) >= 1: 1, f(4 - 3(z^6)^(1/6))}; f(x i - |y|) >= 0` — a tail-recursive function shades where its recursion terminates (see Recursive function, under Definitions)

## Pitfalls

- Shade under a curve between two x values with a definite integral,
  `int[0..pi] sin(x) dx`, which also reads out the area (see
  [Value readout](#value)), or with a chain: `0 < y < sin(x)`.
