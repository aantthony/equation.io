---
kind: vfield2d
title: Vector field
form: (x, -y)
short: 2D vector field, as streamlines
---

A 2D vector field, drawn as animated streamlines: a pair of expressions in x
and y, a slope field `y' = f(x, y)`, or a system `(x', y') = (…)`.

## Forms

- `(P(x, y), Q(x, y))`: the field (P, Q).
- `y' = f(x, y)` (or `dy/dx = …`): the slope field (1, f).
- `(x', y') = (P, Q)`: the phase portrait of a system.
- `grad(f)` of a scalar f in x and y.

## Examples

- Saddle flow: `(x, -y)`
- Slope field: `y' = x - y`
- Pendulum phase portrait: `(x', y') = (y, -sin(x))`
- Field with a slider: `a = 1; (y, -a x)`
- Gradient field: `grad(x^2 - y^2)`

## Pitfalls

- A prime on x, y or z makes a field; a prime on a name of your own makes a
  simulated state (see State, under Definitions).

## Details

- Vector field: a 2-tuple in x, y — `(-y, x)` — drawn as animated streamlines
  (line-integral convolution); clicking the canvas traces integral curves.
- ODE / slope field: `dy/dx = x y` or `y' = sin(x) - y` plots the direction
  field (1, f); a system `(x', y') = (y, -sin(x))` plots its phase portrait.
  (Primes on x/y/z mean this. A prime on a name of your own is a state — see
  State, under Definitions — so `y' = -y` is a slope field while `th' = -th` is a simulation.)
  A system that conserves an energy H(x, y) flows along its level sets, so
  a row `H = c` draws an orbit: beside the pendulum `(x', y') = (y, -sin(x))`,
  `y^2/2 - cos(x) = 1` is its separatrix, the level through the saddles at
  ±π, with swinging inside and spinning outside.
- Coordinate flows: `(r', theta') = (r(1-r), 1)` draws a polar limit cycle.
  Both distinct coordinate names must have primes. Velocities are transformed
  through the coordinate Jacobian; singular chart locations are undefined.
  In 2D, click to trace trajectories just as for Cartesian vector fields. A lone
  prime on a field is invalid; an otherwise unbound name still defines a state.
  Static previews draw direction arrows for vector fields and points/curves
  for coordinate and complex-root systems.
