---
kind: geodesic
title: Geodesic
form: S = (cos(u), sin(u), v); geodesic(S, (0, 0.5), (1, 1))
short: straightest path on a surface, or under a ds² metric
---

A geodesic from a start point in a direction: integrated along a parametric
surface, or in the plane under its panel's `ds^2` metric (a massive
particle's path in a spacetime, or a light ray from `lightray(…)`).

## Forms

- `geodesic(S, (u0, v0), (du, dv))` on a surface S, with an optional length.
- `geodesic(P, (dx, dy))` and `lightray(P, (dx, dy))` in a panel with a
  `ds^2` row ([Metric](#metric)), or on an `on(…)` panel.

## Examples

- Helix on a cylinder: `S = (cos(u), sin(u), v); geodesic(S, (0, 0.5), (1, 1))`
- Great circle on a sphere: `S = (cos(v) cos(u), cos(v) sin(u), sin(v)); geodesic(S, (0, 0), (1, 1))`
- Poincaré half-plane: `ds^2 = (dx^2 + dy^2)/y^2; geodesic((0, 1), (1, 0))` — the unit circle
- Orbit round a black hole: `M = 1; r = sqrt(x^2 + y^2); phi = atan2(y, x); ds^2 = -(1 - 2M/r) dt^2 + dr^2/(1 - 2M/r) + r^2 dphi^2; geodesic((10, 0), (0, sqrt(1/10)))` — a circular orbit
- Bent light: `M = 1; r = sqrt(x^2 + y^2); phi = atan2(y, x); ds^2 = -(1 - 2M/r) dt^2 + dr^2/(1 - 2M/r) + r^2 dphi^2; lightray((-30, 6), (1, 0))` — passes the hole, bent

## Details

See Surfaces and Metrics, under Syntax.
