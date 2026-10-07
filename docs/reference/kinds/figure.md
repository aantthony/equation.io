---
kind: polygon
title: Geometric figure
form: polygon((0, 0), (2, 0), (1, 2))
short: figure: segment, vector, polygon, circle, …; hull of 3D points is a solid
---

A figure built from points: a segment, an open path, a vector arrow, a line,
a filled polygon, a square, a circle, or the convex hull of points (a solid
in 3D). Figures follow their points as they move or are dragged.

## Forms

- `segment(A, B)`, `polyline(A, B, C, …)`, `vector(A, B)` or `vector(V)`,
  `polygon(A, B, C, …)`, `square(A, B)`.
- `circle(center, radius)` and `line(A, B)` follow their points too, but
  draw (and report) as [curves](#implicit2d).
- `hull(A, B, C, …)` or `hull(P)` of a point list: a filled polygon in 2D,
  an opaque solid in 3D.
- Points may be named rows above, tuples, or point arithmetic.

## Examples

- Triangle: `A = (0, 0); B = (4, 0); C = (1, 3); polygon(A, B, C)`
- Vector arrow: `vector((2, 1))`
- Segment: `segment((0, 0), (3, 2))`
- Square on a side: `square((0, 0), (2, 0))`
- Solid cube, as a hull: `hull(([0,1],[0,1],[0,1]))`
- Icosahedron: `phi = (1+sqrt(5))/2; k = 2pi [0..2]/3; hull(rotate((0, [-1,1], [-phi,phi]), k, (1,1,1)))`

## Pitfalls

- `polygon` in 3D fills only triangles; a solid needs `hull` of its corners
  or a [parametric solid](#solid).
- `circle`, `square` and `perp` are planar.

## Details

- Geometry: with points defined in rows above (`A = (0, 0)`), `segment(A, B)`,
  `polyline(A, B, C, …)` (an open path through the points, not filled),
  `vector(A, B)` (an arrow from A to B; `vector(V)` draws V from the origin —
  the head keeps its size on screen), `line(A, B)` (the infinite line through
  A and B), `polygon(A, B, C, …)` (filled), `square(A, B)` (erected on side A→B, to the left of the direction
  A→B), and `circle(center, radius)` draw figures that follow their points. Point arithmetic works anywhere: `A + B`, `2A`,
  `(A + B)/2`, `midpoint(A, B)`, `perp(A)` (rotate 90° counterclockwise),
  `rotate(P, a)` (turn by a about the origin; `rotate(P, a, C)` about C; in
  3D `rotate(P, a)` turns about z and `rotate(P, a, axis)` about axis),
  `unit(A)`, `dot(A, B)`, `cross(A, B)`, `|A - B|` (distance). Measurements:
  `distance(A, B)` is `|A - B|`; `angle(A, B, C)` is the angle at B, turning
  from B→A to B→C — signed, counterclockwise positive, in radians in (−π, π]
  (`angle(A, B, C) 180/pi` for degrees; wrap it in `abs(…)` for the unsigned
  angle) — and `angle(U, V)` is the same from vector U to vector V. Both are
  plain numbers: a bare row reads out "= value" (nothing is drawn — no arc
  marker), and they work inside any expression (`circle(A, distance(A, B))`).
  A scalar list inside a point broadcasts as in any scalar math
  (`distance(A, (L, 0))` is a list of distances); a list of points as an
  argument broadcasts too, and `T[1]` of a tuple of points selects one. An angle with a zero-length arm (`angle(A, A, C)`) reads "undefined". A parametric
  point like `A + u(B - A)` traces the segment. Tuple literals work directly
  as arguments (`segment((0, 0), A)`) and as operands: `A + (1, 2)`,
  `((0, 0) + B)/2`, `|(3, 4)|`.
- Geometry in space: `A = (1, 2, 3)` defines a 3D point with scalar
  components `A_x`, `A_y`, `A_z`. `segment`, `polyline`, `polygon`, and
  `vector` accept matching 2D or 3D points, including tuple literals. 3D
  triangles fill; larger 3D polygons draw their outline. `cross` returns a
  vector in 3D. 3D `angle` is unsigned in [0, pi]; zero arms are undefined.
  `line(A, B)` of 3D points is the infinite line through them, drawn across
  the view box. `perp`, `square`, and `circle` remain planar; 3D dragging is not defined.
  Point lists draw as dots in space too: `[0,1] e_x + [0,1] e_y` is 4 points,
  `[e_x, e_z]` 2, and `([0,1],[0,1],[0,1])` the 8 corners of a cube.
- Convex hulls: `hull(A, B, C, …)` or `hull(P)` for a whole point list draws
  the convex hull — a filled polygon in 2D, a lit opaque solid with flat-shaded faces and outlined edges in 3D
  (coplanar facets merge, so a cube shows six squares). Interior and repeated
  points are ignored, the points may move with sliders or t (the hull is
  rebuilt each frame), and flat 3D input degrades to a polygon. Up to 2000
  points in 3D. Point figures transform as a whole — `R hull(P)`,
  `2 polygon(A, B, C) + (1, 0)`, `-segment(A, B)`, `rotate(hull(P), a)`,
  `e^(t cross(n)) hull(P)` — meaning the figure of the transformed points
  (the same as `hull(R P)`; works for segment, polyline, polygon, vector and
  hull). A LIST in the transform draws one figure per element:
  `th = 2pi [0..4]/5; rotate(hull(P), th)` is a rosette of 5 hulls, while
  `hull(rotate(P, th))` is the single hull of all 5 copies. Point lists also
  transform on their own: `R P`, `P + (1, 0)`, `rotate(P, a)`.
  It composes with crossing lists and rotations:
  `hull(([0,1],[0,1],[0,1]))` is a solid cube, `hull(([-1,1],[-2,2]))` a
  rectangle, and `phi = (1+sqrt(5))/2; k = 2pi [0..2]/3;
  hull(rotate((0, [-1,1], [-phi,phi]), k, (1,1,1)))` a solid icosahedron.
