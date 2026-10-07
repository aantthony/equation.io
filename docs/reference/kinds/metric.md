---
kind: metric
title: Metric
form: ds^2 = (dx^2 + dy^2)/y^2
short: a panel's own ds² metric; draws nothing
---

A panel's own metric, `ds^2 = …` in the differentials of its coordinates. It
draws nothing; [geodesic](#geodesic), [light cone](#lightcone) and
[tidal](#tidal) rows in the panel follow it, and `gaussian(x, y)` paints its
curvature.

## Examples

- Poincaré half-plane: `ds^2 = (dx^2 + dy^2)/y^2`
- Schwarzschild, equatorial: `M = 1; r = sqrt(x^2 + y^2); phi = atan2(y, x); ds^2 = -(1 - 2M/r) dt^2 + dr^2/(1 - 2M/r) + r^2 dphi^2`
- Minkowski spacetime diagram: `ds^2 = -dy^2 + dx^2` — y up as time

## Pitfalls

- Define the coordinates first: `dr` and `dphi` with no `r = …` and
  `phi = …` rows are refused.
- One `ds^2` row a panel; a metric using t is refused (time-dependent
  metrics are not supported yet).

## Details

See Metrics, under Syntax.
