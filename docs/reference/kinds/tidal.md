---
kind: tidal
title: Tidal forces
form: M = 1; r = sqrt(x^2 + y^2); phi = atan2(y, x); ds^2 = -(1 - 2M/r) dt^2 + dr^2/(1 - 2M/r) + r^2 dphi^2; tidal
short: tidal stretch and squeeze of the panel's ds² metric
---

Tidal forces of the panel's `ds^2` metric ([Metric](#metric)) on an observer
held at rest: `tidal` draws them over the panel, `tidal(P)` at a point —
crossed bars along the directions a small cloud of free particles is
stretched (arrowheads out) or squeezed (arrowheads in), as long as the tide
is strong.

## Examples

- Round a black hole: `M = 1; r = sqrt(x^2 + y^2); phi = atan2(y, x); ds^2 = -(1 - 2M/r) dt^2 + dr^2/(1 - 2M/r) + r^2 dphi^2; tidal`
- At a point: `M = 1; r = sqrt(x^2 + y^2); phi = atan2(y, x); ds^2 = -(1 - 2M/r) dt^2 + dr^2/(1 - 2M/r) + r^2 dphi^2; P = (5, 0); tidal(P)`

## Pitfalls

- Refused with no metric, or a Riemannian one: tidal forces need a time, so
  write the ds² with a dt term.

## Details

See Tidal forces, under Syntax.
