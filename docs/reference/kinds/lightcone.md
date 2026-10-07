---
kind: lightcone
title: Light cone
form: ds^2 = -dy^2 + dx^2; lightcones
short: light cones of the panel's ds² metric
---

Light cones of the panel's `ds^2` metric ([Metric](#metric)): `lightcones`
draws them over the panel, `lightcone(P)` one at a point. On a spacetime
diagram each is the two null directions, a wedge opening to the future; with
a time beside x and y, the ellipse of the coordinate velocities light can
have.

## Examples

- Minkowski: `ds^2 = -dy^2 + dx^2; lightcones`
- Closing up at a horizon: `M = 1; ds^2 = -(1 - 2M/x) dy^2 + dx^2/(1 - 2M/x); lightcones`
- One cone at a point: `M = 1; r = sqrt(x^2 + y^2); phi = atan2(y, x); ds^2 = -(1 - 2M/r) dt^2 + dr^2/(1 - 2M/r) + r^2 dphi^2; P = (4, 0); lightcone(P)`

## Pitfalls

- Refused with no metric, or a Riemannian one.

## Details

See Light cones, under Syntax.
