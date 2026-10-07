---
kind: pcurve
title: Parametric curve
form: (cos(2pi u), sin(2pi u))
short: parametric curve, u from 0 to 1; 3 components for 3D
---

A curve traced by a point whose coordinates are functions of u, as u runs
from 0 to 1: two components draw in the plane, three in space.

## Forms

- `(f(u), g(u))` in the plane, `(f(u), g(u), h(u))` in space. u runs from 0
  to 1, so a whole turn is `2pi u`.
- A polar curve r = f(θ), traced with θ = 2πu:
  `(f(2pi u) cos(2pi u), f(2pi u) sin(2pi u))`. Unlike a polar coordinate
  field, this draws where r goes negative too.
- With `u = interval(0, 2pi)` defined above, u runs over that range instead.
- A named curve, `C = (…)` in u, draws nothing itself; a row `C` draws it.
- `tube((f(u), g(u), h(u)), r)`: a 3D curve as a solid tube.

## Examples

- Circle of radius 2: `(2cos(2pi u), 2sin(2pi u))`
- Helix: `(2cos(6pi u), 2sin(6pi u), 4u - 2)`
- Rose r = sin(4θ), all 8 petals: `(sin(8pi u) cos(2pi u), sin(8pi u) sin(2pi u))`
- Figure eight: `(2cos(2pi u), sin(4pi u))`
- Limaçon r = 1 + 2cos(θ): `((1 + 2cos(2pi u)) cos(2pi u), (1 + 2cos(2pi u)) sin(2pi u))`
- Circle with a radius slider: `r = 2; (r cos(2pi u), r sin(2pi u))`
- Trefoil knot as a tube: `tube((sin(2pi u) + 2sin(4pi u), cos(2pi u) - 2cos(4pi u), -sin(6pi u)))`

## Pitfalls

- u runs from 0 to 1, not 0 to 2π: `(cos(u), sin(u))` is only about a sixth of a
  circle. Multiply by `2pi`.
- t is time, not the parameter: `(cos(t), sin(t))` is a [point](#point)
  moving round a circle, not the circle.
- Two components in two parameters (u and v, or an interval) fill a
  [region](#pregion); three components in u and v draw a
  [surface](#psurface).
- Never write a bare `r = f(theta)` row for a polar curve without the
  coordinate fields above it: alone, `r = …` defines a constant r and draws
  nothing.

## Details

- Parametric curve: components in u — `(2cos(2pi u), sin(4pi u))`, or with
  `u = interval(0, 2pi)` above, `(2cos(u), sin(2u))`; three components make
  a 3D curve — `(2cos(6pi u), 2sin(6pi u), 4u - 2)`.
  A plane curve lifts the pen where it jumps (a step, a pole, a branch cut)
  rather than bridging the gap: `(u, floor(3u))`, `(4u - 2, tan(12u - 6))`.
- Tube: `tube((x(u), y(u), z(u)))` sweeps a 3D parametric curve into a lit
  solid tube — `tube((sin(2pi u) + 2sin(4pi u), cos(2pi u) - 2cos(4pi u),
  -sin(6pi u)))` is a trefoil knot. An optional last argument sets the radius
  (default 0.1): `tube((1+cos(4pi u), sin(4pi u), 2sin(2pi u)), 0.06)`. It
  must be the whole row; without it a 3D curve stays a thin line. The curve
  needs exactly three components: `tube((a, b), r)` does not tube a plane
  curve, it reads as the 3D curve (a, b, r).
- Complex path: a complex-valued expression whose only variable is u (constants,
  sliders and t aside) draws the path it traces over u, at
  (re, im) — the same plane as complex points and roots. `exp(i 2 pi u)` is
  the unit circle; with `f(w) = w^2 + w`, `f(exp(i 2 pi u))` is its image
  under f. Supported: arithmetic, powers, exp ln log sqrt, sin cos tan sinh
  cosh tanh, re im abs arg conj, user functions. Branch cuts (`sqrt`, `ln`,
  fractional powers) break the curve where the value jumps. An equation,
  inequality, or a use of v is an error, as is a path whose split into real
  and imaginary parts is too large (deeply nested products). An expression
  that mentions i but is real for every u (`abs(exp(i u))`) is not a path
  and says so.
