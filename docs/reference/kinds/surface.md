---
kind: implicit3d
title: Surface
form: z = sin(x) cos(y)
short: 3D surface: z = f(x, y), or an equation in x, y, z
---

A 3D surface: the points (x, y, z) satisfying an equation. Any row using z
makes the graph 3D.

## Forms

- `z = f(x, y)`: a graph over the plane.
- Any equation in x, y and z: `x^2 + y^2 + z^2 = 9`.
- `revolve(f)`: the surface of revolution of y = f(x) about the x-axis.
- In spherical coordinates defined above: `rho = 2` (see Coordinate fields
  in space, under Definitions).

## Examples

- Egg-crate surface: `z = sin(x) cos(y)`
- Sphere of radius 3: `x^2 + y^2 + z^2 = 9`
- Paraboloid: `z = (x^2 + y^2)/4`
- Surface of revolution: `revolve(sqrt(x))`
- Sphere in spherical coordinates: `rho = sqrt(x^2+y^2+z^2); rho = 3`

## Pitfalls

- A bare expression in x, y and z (`x y z`) is a
  [field in space](#scalar3d), drawn as a cloud: write `… = 0` for its
  surface.
- 2D-only rows (regions, 2D fields) are left out of a 3D graph.

## Details

- Surface of revolution: `revolve(f)` turns the curve y = f(x) about the
  x-axis — `revolve(sqrt(x))`, `revolve(sin(x) + 2)`, or `revolve(f)` with
  `f(x) = …` defined above. A second argument names another axis:
  `revolve(y^2, y)` revolves a profile in y about the y-axis (`z` likewise).
  The profile may use only its axis variable, plus sliders and t. It is
  exactly the implicit surface `y^2 + z^2 = f(x)^2`, so a negative f draws
  the same surface as |f|, and a piecewise f with no default bounds the
  solid: `revolve({0 < x < 3: sqrt(x)})`. It must be the whole row.
