---
kind: family
title: Family
form: y = x^[1, 2, 3]
short: one copy of the row per list element
---

One copy of the row per element of a list: a list in a number's place
draws a family of curves, figures or surfaces.

## Forms

- A list in the row: `y = [1,2,3] x`, `circle((0,0), [1,2,3])`.
- A named list, which every use shares: `m = [1, 2]` then `y = m x + m`.

## Examples

- Three lines through the origin: `y = [1,2,3] x`
- Concentric circles: `circle((0,0), [1,2,3])`
- Powers of x: `y = x^[1, 2, 3]`
- Two sine waves from a named list: `m = [1, 2]; y = sin(m x)`

## Pitfalls

- A family is one row drawing several shapes on purpose. To draw two
  different shapes, write two rows: a circle and a line are
  `x^2 + y^2 = 4` and `y = x`, not one row holding both.
- A single slider, `a = 2`, makes one curve that moves; a list makes a fixed
  set of copies.

## Details

- Object families: a list in a scalar position draws one object per element:
  `y = [1,2,3] x`, `circle((0,0), [1,2,3])`, `(cos(u),sin(u),[1,2,3])`.
  Uses of the same named list move together (`m = [1,2]`, `y = m x + m` is 2
  lines); independent lists cross (`y = [1,2] x + [0,1]` is 4 lines,
  `circle(([0,1],[0,1]), 1)` is 4 circles). Limit 32 objects, in 2D or 3D,
  or 8 implicit surfaces, curves of intersection or fields in space (each
  is raymarched or traced on its own) — except
  point figures (segment, vector, polyline, polygon, hull), which are cheap
  and allow 1024: a deformation drawn as
  arrows is `a = [0..20]; b = [0..20]; P = (a, b);
  f(x,y) = (x + y/2, y + sin(x)/2); vector(P, f(P))`. Shader members share
  one program with per-draw uniforms. Scalar fields/RGB fields/domain coloring/fractals cannot superimpose as
  families; use a selected list element. Point-list arithmetic works:
  `Q = P + (1,0)`, `2P`. `polyline(T)` / `polygon(T)` walk a whole tuple of
  points in order, `T = ((0, 0), (2, 0), (1, 1))`, and a list only once it
  is sorted: `polyline(sort(P, P.x))`, a CSV scatter
  `polyline(sort((data.x, data.y), data.x))`; a list `[ … ]` has no order to
  walk. `hull(P)` takes any list.
  Range bounds may use sliders, but not t; families re-expand on bound changes.
