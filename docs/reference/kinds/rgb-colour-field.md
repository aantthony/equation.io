---
kind: rgb2d
title: RGB colour field
form: rgb(x/4, y/4, 0.5)
short: colour field (RGB) filling the plane
---

A colour field filling the plane: red, green and blue (0 to 1) at every
point (x, y).

## Examples

- Gradient: `rgb(x/4, y/4, 0.5)`
- Colour wheel: `rgb(cos(arg(w)/2)^2, cos(arg(w)/2+1)^2, cos(arg(w)/2+2)^2)`
- Red glow fading out: `rgb(1, 0, 0, exp(-x^2-y^2))`

## Details

- RGB color field: `rgb(red, green, blue)` fills the 2D plane with a color at
  each (x, y). Channels are real expressions on the 0–1 scale (not CSS's
  0–255); values outside that range are clamped, so `rgb(255, 128, 0)` is
  white, not orange. `rgb(1, 0, 0)` fills the plane red. Expressions may
  use x, y, t, sliders, coordinate fields, and real projections of w such as
  `arg(w)` or `abs(w)`. For example,
  `rgb(cos(arg(w)/2)^2, cos(arg(w)/2+1)^2, cos(arg(w)/2+2)^2)`.
  This is a whole-row plot mode, not a color value for styling another row;
  it cannot be nested in arithmetic or lists and does not take u, v, or z.
  A pixel with any undefined or infinite channel is transparent, so a partial
  piecewise channel can restrict the field: `rgb({x>0:1}, 0, 0)`. An
  optional fourth argument is the opacity, 0–1 (clamped; default 1), so a
  field can fade into the graph paper: `rgb(1, 0, 0, exp(-x^2-y^2))`.
  RGB, HSL and OKLCH rows share the same layer and draw in row order;
  curves and regions draw over them.
