---
kind: tfield2d
title: Matrix field
form: jacobian((x^2 - y^2, 2x y))
short: 2D matrix field, as glyphs
---

A 2D matrix (tensor) field, drawn as a grid of glyphs: each the image of a
small circle under the matrix there, with a spoke where e_x goes;
`streamlines(M)`, or a toggle, traces its major eigenvector instead.

## Examples

- Matrix field: `((x, y), (y, -x))`
- Jacobian of a conformal map: `jacobian((x^2 - y^2, 2x y))`
- Hessian as streamlines: `streamlines(hessian(x^3 - 3 x y^2))`

## Details

A 2×2 matrix in x and y is a matrix field, `((x, y), (y, -x))`: a grid of
glyphs, each the image of a small circle under the matrix there with a
spoke to where e_x goes, drawn true size while small and a cell at most,
in the row colour's complement where det < 0. `streamlines(M)` (or the
row's `streamlines` toggle) draws it instead as streaks along the major
eigenvector of its symmetric part (M + Mᵀ)/2 — a line field, with no
arrowhead and no drift, fading at the degenerate points where that part
is a multiple of I: `streamlines(hessian(x^3 - 3 x y^2))`. See Matrix, under
Definitions.
