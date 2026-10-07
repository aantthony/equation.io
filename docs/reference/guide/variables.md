---
title: Variables (what a row means)
summary: What x, y, z, t, u, v, intervals and w mean in a row.
---

- `x`, `y`: the 2D plane. `y = f(x)`, or any implicit equation in x and y
  (`x^2+y^2=4`), renders as a curve. A row is drawn per pixel when it
  depends on x or y, so a bare expression like `sin(x)` is a scalar field,
  not a curve: write `y = sin(x)` for the graph.
- `z`: using z switches to 3D. `z = sin(x)cos(y)` is a surface;
  `x^2+y^2+z^2=9` is an implicit 3D surface. A bare expression in x, y, z is
  a field in space, drawn as a translucent cloud (see [Scalar field in space](#scalar3d)); write
  `… = 0` for its surface.
- `t`: time in seconds. Any row mentioning `t` animates, e.g.
  `y = sin(x - 2t)`.
- `u`, `v`: the parametric parameters, two intervals (below) that are
  `u = interval(0, 1)` and `v = interval(0, 1)` unless a row redefines them
  as another: with `u = interval(0, 2pi)`, `(cos(u), sin(u))` is the whole
  circle. A row whose value is a point traces curves and surfaces, however
  it is written: `(u, u^2)`, `(0,0,1) u` and `u e_z` are all curves; a
  complex expression in u alone is a path (`exp(i 2 pi u)`). A bare real row
  in u and v alone draws the values it takes as a density curve: `u^2` has
  density 1/(2√x), `u v` has −ln(x).
- `interval(a, b)`: every real number from a to b (a < b; the bounds may use
  sliders and t). `[1..2]` is only the whole numbers 1 and 2. Every mention
  of one name is the same number, so with `r = interval(1, 2)`, `r + r` is
  2r; each written `interval(…)` is a separate one, so
  `interval(0, 1) + interval(0, 1)` is the sum of two. In a tuple it traces
  with u and v:
  `(r cos(2 pi u), r sin(2 pi u))` is a filled annulus, `(r, r^2)` a curve
  over [1, 2]. With a list it crosses into one curve per member, as u does:
  `(interval(0, 1), 0) + (0, [1, 2])` is two segments, at heights 1 and 2.
  A row in x and y over one interval is a family, drawn as the
  region its members sweep: with `a = interval(1, 2)`, `y = sin(a x)` shades
  every point some a from 1 to 2 puts on its curve, and `y < a x` every point
  below some member. At most one interval in such a row, and a bare field
  (`sin(a x)`) is an error: set it equal to something. Alone, an interval row
  draws its values against length: `interval(0, 10)` is the line at height 1
  over [0, 10].
- Reductions over continuous sets are integrals: `count` is the measure,
  `total` the integral, `mean` their ratio. Over u, v and intervals the
  measure is length: `total(u^2)` is 1/3, `count(interval(1, 3))` is 2,
  `count((u, u^2))` is 1 (a parametric set carries its parameter's length).
  Over x (all of ℝ) `total(exp(-x^2))` is √π, `count(x)` is ∞, and a total
  that does not converge is an error. A filter is the set it keeps, measured
  in its own dimension: `count(x^2 + y^2 < 1)` is the area π,
  `count(x^2 + y^2 = 1)` the length 2π, `count(x^2 = 2)` the 2 roots; other
  reductions take its members, so `total(0 < x < 1)` is 1/2 (a region's
  members are points: use `count` for its area). Reduce
  a value over a set with `{conditions: value}`, the conditions joined by
  "and" (only here may one be an equation): `total({x^2 + y^2 < 1: x y})`,
  `mean({y = x^2, 0 < x < 1: y})`. The measure depends on the set, not the
  spelling (`2y = 2x^2` agrees with `y = x^2`), and never on the view: an
  unbounded region counts ∞, and a count of roots that cannot all be found
  (`sin(x) = 0`) is an error — restrict it, `count({-10 < x < 10, sin(x) = 0})`.
  `min`/`max` work over u, v and intervals and over points; `stdev`,
  `median` and `hist` of a continuous set, sets in space (x, y, z) and totals
  over unbounded plane regions are errors. A list in the argument keeps the
  list reduction: with `L = [1, 2, 3]`, `y = total(L x)` is the line y = 6x.
- `w`: the complex plane point x + iy. A complex-valued expression in `w`
  (e.g. `ln(w-2) - ln(w+2)`) draws field lines and equipotentials. Wrapping it
  in `domain(…)` or `conformal(…)` picks a different view of the same function.
- `z` inside `iter(…)`: the iterate being fed back through the step. Outside
  `iter`, `z` is the 3D axis as above.
