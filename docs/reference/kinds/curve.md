---
kind: implicit2d
title: Curve
form: x^2 + y^2 = 9
short: 2D curve: y = f(x), or any equation in x, y
---

A 2D curve: the points (x, y) that satisfy an equation. `y = f(x)` is the
graph of a function; any other equation in x and y draws implicitly, with no
need to solve it for y.

## Forms

- `y = f(x)` (or `x = f(y)`): the graph of a function.
- Any equation in x and y: `x^2 + y^2 = 9`.
- A curve on part of its domain: `y = {0 < x < 2: x^2}` (see Piecewise,
  under Expression syntax).
- In polar coordinates, after the coordinate fields `r = sqrt(x^2+y^2)` and
  `theta = atan2(y,x)`: `r = 2(1 + cos(theta))`, drawn where r ≥ 0 (see
  Coordinate field, under Definitions). A polar curve that goes negative
  draws whole as a [parametric curve](#pcurve).

## Examples

- Parabola: `y = x^2`
- Circle of radius 3: `x^2 + y^2 = 9`
- Wave with an amplitude slider: `A = 2; y = A sin(x)` — drag A, or animate it
- Circle with a radius slider: `r = 2; x^2 + y^2 = r^2`
- Lemniscate: `(x^2+y^2)^2 = 8(x^2-y^2)`
- Travelling wave: `y = sin(x - 2t)`
- Cardioid in polar coordinates: `r = sqrt(x^2+y^2); theta = atan2(y,x); r = 2(1 + cos(theta))`
- Circle through a draggable point: `C = (0, 0); P = (2, 1); circle(C, |P - C|)` — `circle` and `line` (see [Geometric figure](#polygon)) draw as curves

## Pitfalls

- A bare expression, `sin(x)`, is a [scalar field](#scalar2d), not a curve:
  write `y = sin(x)`.
- `f(x) = x^3 - x` defines f and draws nothing: add `y = f(x)`.
- A number alone is a [readout](#value); write `y = 4` for the horizontal
  line.
- An equation that holds everywhere (`sin(x)^2 + cos(x)^2 = 1`) is read out
  as an identity, not drawn (see [True/false readout](#note)).
