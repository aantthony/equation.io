---
kind: flat
title: Line or plane
form: join((0, 0), (1, 1))
short: projective point, line or plane
---

A point, line or plane of projective geometry, like `join(A, B)` or
`meet(L, M)`: drawn, with its equation (or an ideal point's direction) read
out.

## Examples

- Line through two points: `join((0, 0), (1, 1))`
- Plane through three points: `A = (0, 0, 0); B = (1, 0, 0); C = (0, 1, 1); plane(A, B, C)`
- Where two lines cross: `meet(join((0, 0), (1, 1)), join((0, 2), (2, 0)))`

## Details

- Projective geometry (lines and planes as values): `join(A, B)` (or
  `line(A, B)`) is the line through two points, in the plane or in space;
  `join(A, B, C)` (or `plane(A, B, C)`) the plane through three points of
  space, and `plane(P, n)` the plane through P with normal n. `meet(L, M)`
  is where two lines of the plane cross, and in space where a line goes
  through a plane (a point) or two planes cross (a line); two lines of space
  do not meet. A meet is a point like any other — `X = meet(L, M)` names it,
  `polygon(meet(…), B, C)` and `midpoint(meet(…), A)` take it. Parallel
  lines meet at an ideal point, which draws nothing and reads out `at
  infinity, direction (1, 2)`. `project(P, L)` is the point of the line or
  plane L nearest P (or a line's shadow on a plane), and `reflect(P, L)`
  mirrors P in a line, a plane or a point. `distance(P, L)` measures from a
  point to a line or plane, and between lines or planes (0 where they cross);
  `angle(L, M)` is the acute angle between two lines or planes, in [0, π/2].
  A row holding a line or plane draws it — a line of the plane as its
  implicit line, a line of space across the view box, a plane as a surface —
  and reads out its equation: `= y = 2x + 1`, `= z = -x - y + 1`, or `=
  through (0, 0, 1), direction (1, 1, 0)` for a line of space. Name one
  (`L = join(A, B)`) to pass it on; the definition itself draws nothing, the
  row `L` does. A line or plane is no number or point, so `2 L` is an error.
  Lists broadcast as everywhere else: with `P = [A, B]`, `join(P, C)` is two
  lines, `L = join(P, C); meet(L, L)` pairs each line with itself, and
  `meet(K, H)` for a line K and a list of planes H is the list of crossing
  points, which `count`, `mean` and `total` take. A plane draws as a
  translucent sheet, outlined where it meets the view box, so a line in it
  or behind it shows through.
- Rigid motions (motors): `motor(L, th, d)` turns by th about the line L of
  space — right-handed about L's direction, A → B for `line(A, B)` — while
  sliding d along it (a screw; d may be left out); `motor(P, th)` turns the
  plane counterclockwise about the point P. `rotate(X, M)` moves a point, a
  list of points, a line, a plane or a figure by it:
  `rotate(hull(([0,1],[0,1],[0,1])), motor(line(A, B), t, t/4))` screws a
  cube along the axis through A and B, which stay draggable.
  `slerp(M1, M2, s)` is the rigid motion s of the way from M1 to M2, at
  constant speed along the screw between them — for motors that stay fixed
  (fixed axes, turns and slides), with the motion in s:
  `rotate(X, slerp(M1, M2, (1 - cos(t))/2))`. A row holding a motor draws
  its axis (or its centre, in the plane) and reads out what it does: `=
  turn 1.5708 about the line through (0, 0, 0), direction (0, 0, 1), slide
  2`, `turn 1.5708 about (1, 1)` or `slide (0, 0, 3)` — a motor and its
  opposite are one motion, read the shorter way round. A motor is no number
  or point: name it (`M = motor(L, t, 1)`) and pass it to rotate or slerp.
