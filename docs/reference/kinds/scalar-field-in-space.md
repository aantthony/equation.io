---
kind: scalar3d
title: Scalar field in space
form: exp(-(x^2 + y^2 + z^2))
short: expression in x, y, z, drawn as a cloud
---

A scalar field in space: a bare expression in x, y and z, drawn as a
translucent cloud, denser where the field is larger.

## Examples

- Gaussian blob: `exp(-(x^2 + y^2 + z^2))`
- Octants by sign: `x y z`
- Orbital: `z exp(-sqrt(x^2 + y^2 + z^2)/2)`

## Pitfalls

- For a surface, set the expression equal to something: `x y z = 1` is an
  [implicit surface](#implicit3d).

## Details

- Scalar field in space: a bare expression in x, y and z — `x y z`,
  `z exp(-sqrt(x^2 + y^2 + z^2)/2)` — is a translucent cloud, tinted the same
  way (row color positive, complement negative) and denser where the field is
  larger. The density is relative: the scale is what |f| typically reaches in
  the view, so `x y z` and a tiny orbital both show, and a slider that only
  multiplies the field changes nothing. The cloud fills a soft ball around
  the view's center, fading out before the camera; a field that dies away
  (an orbital) shows whole, and zooming out shows more of one that does not
  (`x y z`). An implicit surface in the same
  graph is seen through the cloud in front of it, so
  `f(x, y, z) = …; f(x, y, z); f(x, y, z) = 0.5` draws a level surface inside
  its field. For nested level surfaces instead, write
  `f(x, y, z) = [1..5]`.
