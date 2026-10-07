---
kind: action
title: Matrix action
form: action(((1, 1), (0, 1)))
short: what a matrix does to the unit square
---

`action(M)`: where a matrix sends the unit square, the unit circle and the
axes, with the matrix read out.

## Examples

- Shear: `action(((1, 1), (0, 1)))`
- Rotation with time: `J = ((0, -1), (1, 0)); action(e^(t J))`
- Three stretches: `a = [1, 2, 3]; action(((a, 0), (0, 1)))`

## Details

A matrix on a row of its own draws nothing (see Matrix, under Definitions);
`action(M)` draws what it does — the image of the unit square (filled; its
signed area is det M), of the unit circle (an ellipse whose axes are the
singular vectors) and the arrows M e_x, M e_y, its columns; for a 3×3, the
image of the unit cube and three arrows. `action(e^(t J))` turns the square
with t. Over a list of matrices it draws each one's picture and reads each
out: with `a = [1, 2, 3]`, `action(((a, 0), (0, 1)))` draws three stretches.
