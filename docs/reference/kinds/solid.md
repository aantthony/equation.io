---
kind: solid
title: Parametric solid
form: (interval(0, 1), interval(0, 2), interval(0, 3))
short: solid in 3D filled by three parameters or intervals
---

A solid in 3D: three components in three parameters (intervals, u and v)
fill the solid they trace, drawn opaque as the faces of their parameter box.

## Forms

- `(interval(a, b), interval(c, d), interval(e, f))`: a box.
- Named intervals for curved solids: `r = interval(0, 1)` above, then a
  triple in r, u and v.

## Examples

- Unit cube: `(interval(0, 1), interval(0, 1), interval(0, 1))`
- Unit ball: `r = interval(0, 1); p = interval(0, pi); q = interval(0, 2pi); (r sin(p) cos(q), r sin(p) sin(q), r cos(p))`
- Solid cylinder: `r = interval(0, 1); h = interval(0, 2); (r cos(2pi u), r sin(2pi u), h)`

## Pitfalls

- The convex hull of the corners, `hull(([0,1],[0,1],[0,1]))`, is also a
  solid cube (see [Geometric figure](#polygon)).

## Details

- Parametric solid: three components in three parameters (intervals, u and
  v) fill the solid they trace — `(interval(0, 1), interval(0, 1),
  interval(0, 1))` is the unit cube, and with `r = interval(0, 1)`,
  `p = interval(0, pi)` and `q = interval(0, 2pi)`,
  `(r sin(p) cos(q), r sin(p) sin(q), r cos(p))` the unit ball. It is drawn
  opaque, as the faces of its parameter box. A map that folds over itself
  inside the box (`s = interval(-1, 1)`; `(s^2, u, v)`) is an error: write
  it over a range where it does not, like `interval(0, 1)`. So is one
  undefined in part of the box (a `{…}` with no default, `sqrt(s)` over
  negative s): give the `{…}` a default, or split it into solids over the
  parts where it is defined.
