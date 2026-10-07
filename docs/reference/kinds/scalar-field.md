---
kind: scalar2d
title: Scalar field
form: sin(x) cos(y)
short: expression in x, y, shaded by its value
---

A 2D scalar field: a bare expression in x and y, shaded by sign and size —
the row's colour where it is positive, its complement where negative.

## Examples

- Checkerboard waves: `sin(x) cos(y)`
- Animated ripples: `sin(x^2+y^2-4t)/2`
- Distance from a circle: `sqrt(x^2 + y^2) - 2`

## Pitfalls

- `sin(x)` alone is a field, constant along y: write `y = sin(x)` for the
  [curve](#implicit2d).

## Details

- Scalar field: a bare expression in x and/or y — `sin(x)cos(y)`, or `sin(x)`
  (constant along y) — shaded by value: the row color where it is positive,
  the color's complement where negative, stronger the larger it is. There is
  no implicit graph; a row in x alone reads out how to write its curve
  (`y = sin(x)`). A list of fields (`a = [1, 2]; sin(a x)`) is an error: write
  `y = sin(a x)` for the curves.
