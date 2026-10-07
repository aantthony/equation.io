---
kind: psurface
title: Parametric surface
form: (sin(pi v)cos(2pi u), sin(pi v)sin(2pi u), cos(pi v))
short: parametric surface, u and v from 0 to 1
---

A surface traced by three components in u and v, each running from 0 to 1.

## Forms

- `(f(u, v), g(u, v), h(u, v))`: a bare triple, with no wrapper function.
- A sphere of radius R: `(R sin(pi v) cos(2pi u), R sin(pi v) sin(2pi u), R cos(pi v))`.
- A surface of revolution about z of a profile (r(v), z(v)):
  `(r(v) cos(2pi u), r(v) sin(2pi u), z(v))`.

## Examples

- Torus: `(cos(2pi u)(2+cos(2pi v)), sin(2pi u)(2+cos(2pi v)), sin(2pi v))`
- Sphere of radius 3: `(3sin(pi v)cos(2pi u), 3sin(pi v)sin(2pi u), 3cos(pi v))`
- Helicoid: `(2v cos(4pi u), 2v sin(4pi u), 3u)`

## Pitfalls

- There is no `surface(…)` or `plot3d(…)`: the triple is the whole row.
- u and v run from 0 to 1: scale them (`2pi u`) for angles.
- Two components in u and v fill a flat [region](#pregion), not a surface.

## Details

- Parametric surface: three components in u and v —
  `(cos(2pi u)(2+cos(2pi v)), sin(2pi u)(2+cos(2pi v)), sin(2pi v))`.
