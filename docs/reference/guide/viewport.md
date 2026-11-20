---
title: Viewport rows (framing)
summary: view(…) and camera(…) rows: the window, log axes and the 3D camera.
---

- `view(x = -10..10, y = -1..1, ratio = 5)` uses five times as many pixels
  per y unit as per x unit. `ratio` must be positive and defaults to 1;
  bounds are fitted while preserving this ratio across screen sizes.
  Option/Alt + drag scales axes independently and creates/updates this row.
  Set `ratio = 1` to restore equal axis units.
- `view(x = -5..5, y = -2..2)` sets the 2D window; either axis alone works
  (`view(x = 0..0.01)`), the other is centered at 0 and sized by the canvas
  aspect. The whole box is always visible (uniform scale).
- A log axis is a map from the screen: `view(x = 1..1000, x = 10^X)` makes x
  equal 10^X, where X is the panel's linear screen coordinate (Y for y), so
  `view(x = 0.1..100, y = 0.01..10000, x = 10^X, y = 10^Y)` is log-log and a
  power law draws as a straight line. The window stays in x units. Any
  increasing map built from exp, ln, log, powers, sqrt, sinh and arithmetic
  works (`y = sinh(Y)` is a symlog axis). A map may use sliders: with
  `b = 10`, `x = b^X` is a log axis whose base slides, and the window keeps
  its x range as b moves. It applies to its own panel only.
  The grid and its labels follow the map: decades on a log axis (1, 2, 3, 5
  between them when zoomed in), and a zero line where the map reaches 0.
  Graphs, implicit curves, regions and fields are drawn through the map;
  points, parametric curves and regions, segments and polygons (bent as a
  straight line in x and y is on a log axis), point lists and labels are
  placed through it, and named points drag in x and y. Real systems are
  solved through it too (not certified or dragged there); a complex system
  like `w^3 = 8i` is solved in x and y and its roots placed. Hovering shows local
  minima and maxima and any intercepts with x = 0 or y = 0 the map shows,
  read in x and y (no inflection points), and traces curves in x and y. What the map cannot
  show (x <= 0 on a log axis) is left out. 2D vector fields, slope fields
  and `(x', y') = (P, Q)` flows are carried through it too: their arrows,
  streamlines and traced trajectories follow x and y (Lotka-Volterra's
  orbits close on log-log axes), coordinate flows like `(r', theta') = …`
  included. A 2×2 matrix field's glyphs are the matrix as it acts on the
  screen, and its streamlines follow its major eigenvector in x and y.
  Histogram bars and a definite integral's shaded area stand on y = 0, or
  rise from the bottom edge of a log y axis, which cannot show y = 0. 3D is
  not drawn on mapped axes, and a mapped panel shows no coordinate-field grid.
- A plane map writes x and y together from the screen's X and Y:
  `view((x, y) = (Y cos(X), Y sin(X)), X = -pi..pi, Y = 0..5)` unrolls the
  plane in polar form — angle across, radius up — so circles about the
  origin are level lines and spirals rise in steps;
  `(x, y) = (exp(Y) cos(X), exp(Y) sin(X))` is log-polar, where equiangular
  spirals are straight. The window is the screen's, X and Y (not x and y).
  Any smooth map works, with sliders, and sums or products over fixed
  bounds (`sum(n=1..3, Y^n/n)`). Write functions with parentheses: `cos(X)`,
  not `cos X`. Every row is drawn through it:
  curves, regions, fields, flows and matrix fields (carried by its
  Jacobian), real systems, and points, parametric curves, figures, labels
  and complex roots, placed wherever the screen shows them (every copy, on
  an angle range wider than 2π; a line picks up at the other edge where it
  crosses the seam; a shape round the origin unrolls into an open curve and
  is filled down to Y = 0). Named points drag in x and y, and hovering shows
  a curve's intercepts and extrema in x and y where the screen shows them.
  The grid is the screen's; `grid(x, y)` or coordinate fields (r, theta)
  draw their level lines through the map. Histograms are refused, and
  integrals are readouts without shading.
- `on((X, Y, Z) = (3cos(y) cos(x), 3cos(y) sin(x), 3sin(y)), x = -pi..pi,
  y = -pi/2..pi/2)` draws its panel's 2D rows on a surface in space — here
  the sphere, x as longitude and y as latitude. The panel is 3D (frame it
  with `camera(…)`, not `view(…)`). Curves and inequalities in x and y
  (and families of them) and scalar fields are painted on the surface per pixel;
  points, parametric curves, point lists, labels, figures and geodesics
  (`geodesic(P, (1, 0))`) are carried onto it, figures as outlines (paint an area with an inequality); a
  parametric region `(u cos(2 pi v)/2, u sin(2 pi v)/2)` is carried whole, as a
  fill. A vector field `(-y, x)` draws as a lattice of direction arrows
  tangent to the surface (the field (u, v) at (x, y) is the tangent
  u ∂P/∂x + v ∂P/∂y), each about a lattice cell long. 3D rows draw as usual;
  other 2D rows (e.g. matrix fields, complex rows, colour fields,
  histograms) are refused. Hovering the surface reads x and y there,
  with scalar and vector fields' values; near a painted curve it traces it
  ("on curve"), near a point it reads that point; named points drag along
  the surface. Any
  smooth surface works, with sliders and sums over fixed bounds: a torus is
  `on((X, Y, Z) = ((3 + cos(y)) cos(x), (3 + cos(y)) sin(x), sin(y)), x = -pi..pi, y = -pi..pi)`.
- `camera(theta, phi, radius, (tx, ty, tz))` aims the 3D orbit camera —
  angles in radians (`camera(-pi/3, 0.6)`), radius and target optional.
  A trailing `spin = rate` keeps it orbiting about the vertical axis at that
  many radians per second (`camera(-pi/3, 0.6, spin = 0.3)`; negative turns
  the other way). theta is where the orbit starts: the row stays put while
  the view turns, and dragging pauses the spin.
- Binding is two-way in the app: panning, zooming, or orbiting rewrites the
  row the way dragging a slider rewrites its constant, so the URL always
  names the exact picture on screen. Without a viewport row, interaction
  stays ephemeral and the default framing applies.
- Bounds and angles may use `pi` and defined constants, evaluated at load.
- A trailing `locked` pins a window or camera (`view(x = -1..1, y = -1..1,
  locked)`, `camera(0.4, 0.3, 8, locked)`): dragging and zooming leave it
  where the row puts it.
