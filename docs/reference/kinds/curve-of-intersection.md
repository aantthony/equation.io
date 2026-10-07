---
kind: spacecurve
title: Curve of intersection
form: (x^2 + y^2 + z^2, z) = (9, 1)
short: 3D curve where two surfaces meet
---

A 3D curve where surfaces meet: two equations in x, y and z, written as one
tuple equation.

## Examples

- Where a sphere meets a plane: `(x^2+y^2+z^2, z) = (9, 1)`
- Where two cylinders meet: `(x^2 + y^2, x^2 + z^2) = (1, 1)`

## Pitfalls

- Two separate rows draw the two surfaces; the tuple form draws only the
  curve they share.

## Details

- Surface intersections: `(x^2+y^2+z^2,z) = (9,1)` traces the circle where
  the sphere meets the plane. Bounded predictor–corrector continuation
  follows the Jacobian null space, with at most 24 branches and 512 steps
  per direction. Singularities stop a trace; tiny or isolated branches may
  be missed. This numerical tracing does not certify branch completeness.
