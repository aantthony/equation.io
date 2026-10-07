---
kind: pregion
title: Parametric region
form: r = interval(1, 2); (r cos(2pi u), r sin(2pi u))
short: filled 2D region traced by two parameters
---

A filled 2D region: two components in two parameters (u and v, or
intervals), each over its range, fill everything they trace.

## Forms

- `(f(u, v), g(u, v))`, u and v each from 0 to 1.
- With an interval, `s = interval(a, b)`, in place of one parameter.

## Examples

- Unit disc: `(u cos(2 pi v), u sin(2 pi v))`
- Annulus: `r = interval(1, 2); (r cos(2 pi u), r sin(2 pi u))`
- Area under a sine arch: `s = interval(0, pi); (s, u sin(s))`

## Pitfalls

- One parameter traces a [curve](#pcurve); three components in two
  parameters draw a [surface](#psurface) in 3D.

## Details

- Parametric region: two components in two parameters fill the region they
  trace — `(u cos(2 pi v), u sin(2 pi v))` is the unit disc, and with
  `r = interval(1, 2)`, `(r cos(2 pi u), r sin(2 pi u))` an annulus. In a 3D
  scene it lies in the plane z = 0.
