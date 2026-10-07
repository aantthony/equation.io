---
kind: fractal2d
title: Escape-time fractal
form: iter(z^2 + w)
short: escape-time fractal
---

An escape-time fractal: `iter(step)` iterates z ↦ step for every point of
the plane, coloured by how fast it escapes.

## Examples

- Mandelbrot set: `iter(z^2 + w)`
- Julia set: `iter(z^2 - 0.7269 + 0.1889i)`
- Burning ship: `iter((|re(z)| - i |im(z)|)^2 + w)`

## Details

- Fractal: `iter(step)` iterates `z ↦ step`, coloring by escape time. Inside
  `iter` only, `z` is the iterate. If the step mentions the plane (`w`, `x`,
  `y`) iteration starts at 0, so `iter(z^2 + w)` is the Mandelbrot set; with a
  fixed constant the pixel is the starting point, so `iter(z^2 - 0.8 + 0.156i)`
  is a Julia set. An optional second argument sets the iteration count,
  `iter(z^2 + w, 600)` (default 250, max 5000). Any expression works:
  `iter((|re(z)| - i |im(z)|)^2 + w)` is the burning ship.
  `iter` is for the plane; an escape-time fractal in space (the Mandelbulb,
  a quaternion Julia set) is a recursive function — see Recursive
  function, under Definitions.
