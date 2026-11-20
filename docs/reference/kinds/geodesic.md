---
kind: geodesic
title: Geodesic
form: S = (cos(u), sin(u), v); geodesic(S, (0, 0.5), (1, 1))
short: straightest path on a surface
---

A geodesic of a parametric surface from a start point in a direction,
integrated along the surface.

## Forms

- `geodesic(S, (u0, v0), (du, dv))` on a surface S, with an optional length.
- `geodesic(P, (dx, dy))` on an `on(…)` panel, from a point of the panel.

## Examples

- Helix on a cylinder: `S = (cos(u), sin(u), v); geodesic(S, (0, 0.5), (1, 1))`
- Great circle on a sphere: `S = (cos(v) cos(u), cos(v) sin(u), sin(v)); geodesic(S, (0, 0), (1, 1))`

## Details

See Surfaces, under Syntax.
