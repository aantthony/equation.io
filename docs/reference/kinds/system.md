---
kind: system
title: System of equations
form: (x^2 + y^2, y) = (4, x)
short: solutions of simultaneous equations
---

The solutions of a system of equations: two equations in x and y written as
one tuple equation draw their common points; with u they trace a curve.
Complex equations in w draw their roots.

## Forms

- `(f, g) = (a, b)`: f = a and g = b together.
- An equation in w, the complex plane point: `w^3 = 1`.
- In coordinates defined above: `(r, theta) = (2, pi/4)`.

## Examples

- Where a circle meets a line: `(x^2 + y^2, y) = (4, x)`
- Cube roots of unity: `w^3 = 1`
- A point in polar coordinates: `r = sqrt(x^2+y^2); theta = atan2(y,x); (r, theta) = (2, pi/4)`
- Spiral in polar coordinates: `r = sqrt(x^2+y^2); theta = atan2(y,x); (r, theta) = (3u, 6pi u)`

## Pitfalls

- Two separate rows `x^2 + y^2 = 4` and `y = x` draw the circle and the
  line; the tuple form draws only where they meet.

## Details

- Complex roots: `w^3 = 1` draws three solution points; equations in w become
  two real constraints. This is a numerical search over the visible window,
  with exact labels for rational/quadratic polynomial factors and a defining-
  polynomial label for remaining algebraic roots. The optional certification
  control proves completeness only when every region in its search box is settled.
- Coordinate points: after defining r and theta above, `(r, theta) = (2, pi/4)`
  draws the point satisfying both coordinates. Angles in atan2-valued left
  components wrap modulo 2pi, so 9pi/4 and pi/4 name the same position.
  Bare tuples remain Cartesian. Non-injective charts draw multiple points:
  `p = x y; q = (x^2-y^2)/2; (p, q) = (1, 0)` draws two.
  In 2D, RHS literals or slider names can be dragged; the pointer position
  is evaluated in the named coordinates and written back to those values.
- Parametric systems: `(r, theta) = (3u, 6pi u)` traces a three-turn spiral,
  u in [0,1]. General square systems with u work too, including in 3D.
  A bounded numerical continuation follows branches, periodically searches
  for others, and breaks lines at missing/discontinuous solutions. Small
  branches can be missed; this is not certified exhaustive tracing.
- Certified point solving: a square system's “certify search box” control
  runs outward-rounded interval subdivision and Krawczyk tests in the worker.
  Its readout distinguishes proved roots, unresolved regions, and completeness
  of that finite search box. Existing numeric points remain visible.
  Certification currently supports finite constants, +, −, ×, / away from
  zero denominators, and integer powers up to 32; other functions, singular
  roots and exhausted budgets remain unresolved. Wrapped angular systems
  are excluded. Proofs concern real arithmetic on the input binary64 literals
  and parameter values, not a claim of completeness over all space.
