# Axis maps: log scales and beyond (#71)

Status: **steps 1–8 implemented** (lib/axis-map.ts, lib/axis-ticks.ts, web/render2d.ts mapOverlay); the rest are notes.

## The idea

A log axis is a substitution, the way `u = interval(0, 2pi)` rescales u.
`view(x = 1..1000, x = 10^X)` makes x equal 10^X, where X is the panel's
linear screen coordinate (Y for y) — what panning and zooming move evenly.
Every row in that panel is drawn with the map put in for x, so `y = x^2`
draws as `Y = log((10^X)^2)`: shaders, gradients and antialiasing see an
ordinary expression in screen coordinates and need nothing new.

The map lives in the panel's `view(…)` row because definitions are
document-wide and a log axis is a property of one panel. It must be
invertible (the window is written in x units, and a graph y = f stays a
graph as Y = g⁻¹(f)); the inverse is found by peeling exp/ln/log, powers,
sqrt, sinh and arithmetic. This keeps §8 of docs/math-objects.md: no axis
mode, a coordinate system the user writes down — log, log-log, sqrt and
symlog (`y = sinh(Y)`) all come from one feature.

## Steps

1. **Done.** Forward substitution for what is drawn per pixel: graphs,
   implicit curves, regions, scalar and colour fields. The window reads and
   writes back in x units. Anything that places points is refused in a
   mapped panel rather than drawn in the wrong place; integral shading is
   dropped there.
2. **Done.** Grid and labels. lib/axis-ticks.ts picks ticks where they
   land on screen: from the nicest number in view, each next tick is the
   nicest (0, fewest significant digits, a last digit of 5 or even, a
   leading 1, 5, 2) between 90 and 225 px on. That is decades on a log
   axis, 1, 2, 3, 5, 10 zoomed in, and even steps on a near-linear map;
   panning at one zoom keeps them put. render2d draws them as a list of
   lines (a log axis is not a level set at even spacing), and a mapped
   panel draws no coordinate-field grid, since fields are written in x and
   y rather than its screen coordinates.
3. **Done.** Points and parametric objects. lib/axis-map.ts axisMapping
   sorts what a row draws: per-pixel kinds are rewritten (step 1); kinds
   that place things — points, parametric curves and regions, figures,
   point lists, labels — are computed in x and y as
   anywhere else, and web/render2d.ts mapOverlay carries what each such row
   adds to the overlay through the inverse as it is drawn. A figure's
   straight segments are cut adaptively first, since a straight run in x
   and y is curved on a log axis. Grabbed points are carried the same way,
   and a drag writes back through the forward map. Positions the map
   cannot show are dropped (points) or break the line. The link preview
   (worker/og.ts) carries placed rows and draws the ticks' grid the same
   way. 3D is not drawn on mapped axes; the rest came in step 7.
4. **Done.** Hover and systems. A real system is rewritten like a curve, so
   its solver searches the window in screen coordinates (evenly, as a log
   axis needs) and its solutions land there; a mapped panel offers no
   certificate, which would prove roots in screen coordinates, and its
   solutions are not dragged. Hover points are found on the rewritten row,
   on the screen and so evenly on a log axis (lib/special.ts
   mappedSpecialPoints): intercepts are roots where the screen shows x = 0
   or y = 0, wherever the map puts them (a log axis shows neither), with
   their multiplicity where the map has a slope; extrema are the drawn
   curve's local minima and maxima, which an increasing map keeps, while
   its inflections are the screen's bends and are not shown. The tooltip
   reads x and y, in decimals (exact forms like √2 are of screen values).
   The curve tracer projects on the screen and reads off x and y, rounded
   to the pixel there.
5. **Done.** Sliders in maps (`x = b^X`). parseAxisMap reads a slider at
   its value through the view row's constants, so the map is numbers from
   there on, and reading it marks the slider structural (a move reanalyses
   rather than only updating a uniform). The window stays in x units, so a
   new b is a new screen window for the same x; the app reframes on it
   (web/main.ts viewKey), and parses write-backs with its constants. A
   value that stops the map increasing (b ≤ 1) is the view row's error.
6. **Done.** Vector fields. A velocity in x is one on the screen times the
   map's slope (x = g(X) moves at g'(X) dX/dt), so a 2D field, slope field
   or `(x', y') = (P, Q)` flow is rewritten as (P / gₓ'(X), Q / gᵧ'(Y)) in
   screen coordinates (lib/axis-map.ts mapRowExpr), and its arrows,
   streamlines and traced trajectories run on the screen as anywhere else.
   A coordinate flow (`(r', theta') = …`) is lowered to `(x', y')` through
   its fields' Jacobian first, so it is carried the same way. Analysis
   tells the rewrite the row is a flow, so one that arrives in another
   shape is an error rather than drawn without the slope. Seeds dropped by
   clicking are kept on the screen, so moving a slider in the map moves
   them in x and y.
7. **Done.** The rest of 2D.
   - Tensor fields. A matrix M acting on x and y is J⁻¹ M J on the screen,
     J = diag(gₓ'(X), gᵧ'(Y)), so the entries are read at the screen point
     and the maps' slopes ride along (tensor-field `slope`): the glyphs draw
     J⁻¹ M J, and streamlines follow the major eigenvector e of M's
     symmetric part in x and y, shown as J⁻¹e. (The symmetric part of
     J⁻¹ M J has other eigenvectors: a stress's principal directions are
     those of x and y, not of the screen.)
   - Histograms and integral shading stand on y = 0. Where the map cannot
     show y = 0 (a log axis), they rise from the edge it lies past, which
     is the usual picture of a histogram on log axes (lib/axis-map.ts
     toScreenOrEdge). Bars are placed like points; an integral's area is
     sampled along the screen, so evenly on a log x axis, its signs read
     before y is mapped (lib/intshade.ts shadeRuns).
   - Complex systems solve in w, which no rewrite of x and y reaches, so
     they solve in x and y over the part of the window the maps show and
     their roots are placed (and can be certified and dragged, as
     anywhere).
8. **Done.** Plane maps (lib/plane-map.ts): `view((x, y) = (Y cos(X),
   Y sin(X)), X = -pi..pi, Y = 0..5)`, one map for both coordinates, so
   the screen can show the plane in polar or log-polar form.
   - Per pixel it is the same substitution, x and y both from (X, Y). A
     graph is no longer a graph on the screen (y = x² unrolled is no
     function of X), so every row is substituted whole.
   - Flows and matrices are carried by the Jacobian J = ∂(x, y)/∂(X, Y):
     J⁻¹ (P, Q), J⁻¹ M J and J⁻¹e, the diagonal J of step 6–7 in general
     (tensor-field `jacobian`, row-major).
   - The way back has no peeling in general, so it is numerical:
     Levenberg–Marquardt from the nearest of a 25 × 25 grid of samples over
     the window (and a quarter past it), or from a neighbour already carried
     (PlaneInverse). A map may show a point more than once:
     - a point is drawn at each place;
     - a line is drawn on each copy, each run once: the places the screen
       shows a vertex are searched for every few vertices and carried on
       from the vertex before along each run, so a copy one search missed
       comes from its neighbour, and one with nothing leading into it is
       traced back to where it came onto the screen; each is cut just past
       the window's edge (PlaneInverse.lines, FOLLOW_MARGIN);
     - a shape to fill is followed well off the screen, whole, from each
       place the screen shows a vertex where the map does not fold
       (planeShapes); one round a point the map folds at (a square about
       the polar origin) unrolls into a curve across a full turn, its
       outline drawn as a line and what it encloses filled down to the line
       the fold is shown along, a turn at a time (foldFills, foldPoints);
     - a region's corners are carried once each, on the copy their
       neighbour is on and at the offsets between copies found by
       searching now and then; a corner where the map folds is placed per
       triangle, and that triangle becomes the quad it is on the screen
       (PlaneInverse.triangles).
     A search starts from the nearest samples and from the best of each
     block of the window they do not reach; the shifts that show the same
     plane (2π along X, on the polar screen) are found once per window
     (PlaneInverse.turns, checked by PlaneInverse.symmetric), and every
     copy a turn from one found is added, so a search that misses a copy
     finds it from another. A line's copy a turn from one already carried
     is that run moved. A fill round a fold is repeated a turn on only when
     the map really shows the same plane there, and each other branch
     (polar's copy at (X + π, −Y)) is filled from its own start. The fold
     points are where the Jacobian's determinant changes sign, or touches
     0 (a branch point: z², at 0); a fill goes round one only when it is
     the shape's only one and the map does not fold all round it
     (PlaneInverse.isolated). Where a line runs exactly through a fold, it
     may leave on either branch.
   - The window is the screen's (X, Y), since a rectangle of x and y is no
     rectangle on it; the grid and labels are the screen's, and `grid(x, y)`
     or coordinate fields draw their level lines through the map.
   - Hover finds a curve's intercepts and extrema in x and y, as the row
     is written (Classified.world), over what the window shows, and places
     each wherever the screen shows it.
   - Not drawn: histograms (refused) and integral shading (a readout only),
     both standing on y = 0, a curve here.

## Equations on a surface

A panel row `on((X, Y, Z) = (…), x = lo..hi, y = lo..hi)` prints the panel's
2D rows onto a surface in space (lib/surface-map.ts):

```
on((X, Y, Z) = (3cos(y) cos(x), 3cos(y) sin(x), 3sin(y)), x = -pi..pi, y = -pi/2..pi/2)
y = sin(3x)/2
x^2 + (2y)^2 < 1
```

is the sphere with x as longitude and y as latitude, a sine wave round it
and a filled ellipse on it. X, Y and Z are the scene's coordinates; x and y
are the rows'. The panel is 3D and framed with `camera(…)` (a `view(…)` in
it is refused); the surface itself is drawn as a parametric surface over
the ranges given, and sliders in it are read at their value.

- **Painted**: what 2D draws per pixel from x and y — implicit curves,
  regions and scalar fields — is drawn per pixel on the surface's mesh: the
  fragment shader (web/render3d.ts paintFrag) reads x and y from the mesh's
  (u, v) and draws a line where |F| over its change across a pixel
  (sampled along the screen's two directions) is small, but not where F
  jumps sign at a pole; a fill where the inequality holds; a colour scale
  for a field. Exact at any zoom, through
  the poles and seams, with no tracing.
- **Carried**: what places things — points, parametric curves, figures,
  point lists, labels and named points — is carried point by point through
  the surface (surfacePoint), lifted a little toward the eye so the surface
  does not hide it; straight edges are cut into pieces first so they bend
  with the surface. Figures (polygons, hulls) draw as outlines: a flat fill
  would cut through the surface rather than lie on it, and an inequality
  paints the same area exactly. Where the surface is undefined (1/x at
  x = 0) nothing carried is drawn.
- Families draw as their members.
- Paints draw after the surface with a polygon offset and no depth writes,
  so they sit on it without fighting it.
- Rows in space (3D) draw in the panel as in any 3D panel. Other 2D rows
  have no picture on a surface yet (among them vector and matrix fields,
  complex rows, colour fields, parametric and projected regions,
  histograms, sequences and systems) and are refused with a
  message saying so.
- The surface is drawn by the GPU, so it must be written in what the
  shaders take; a surface they cannot draw is refused at its row. Its
  tangents are exact where they are cheap and finite differences otherwise
  (mod, gamma).
- Not drawn: hover readouts on the painted rows, and link previews (a panel
  on a surface gets the generic card).
