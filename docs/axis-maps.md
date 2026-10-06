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
     the window (and a quarter past it), or from a line's last point. A map
     may show a point more than once; a point is drawn at each, while a line
     follows the copy it started on and is cut just past the window's edge
     (FOLLOW_MARGIN). Where it is cut but its end is still on the screen
     (it crossed an angle's seam) it is traced back from there, so it
     re-enters at the other edge. On a window wider than a full turn, where
     two copies of a line are on screen at once, one is drawn.
   - The window is the screen's (X, Y), since a rectangle of x and y is no
     rectangle on it; the grid and labels are the screen's, and `grid(x, y)`
     or coordinate fields draw their level lines through the map.
   - Not drawn: histograms (refused) and integral shading (a readout only),
     both standing on y = 0, a curve here; hover intercepts and extrema,
     which are not features of the screen's curve.

## Later: equations on a surface

The same substitution, aimed at a 3D panel, would print a panel's 2D rows
onto a surface — the 2-sphere with x as longitude and y as latitude. This
already works by hand with coordinate fields and surface intersections:

```
rho = sqrt(x^2+y^2+z^2)
lon = atan2(y, x)
lat = asin(z/rho)
rho = 0.99
(rho, lat) = (1, sin(3 lon)/2)
(rho, lon^2 + (2lat)^2) = (1, 1)
```

`F(x, y) = c` becomes `(rho, F(lon, lat)) = (1, c)`, traced where the
sphere meets the surface F(lon, lat) = c. (The sphere is drawn at 0.99
because a curve exactly on a surface is hidden by it; a depth bias for
curves lying on a surface would fix that.)

What a panel row like `on(rho = 1, x = lon, y = lat)` would add:

- Curves: rewrite the panel's 2D equations into that system automatically.
  Cheap — the tracer exists.
- Regions and fields painted onto the surface: needs the 3D renderer to
  colour a surface by a field per pixel, which it does not do today.

Limits inherited from the tracer: numerical (at most 24 branches), not the
per-pixel exact rendering 2D curves get, and curves break where the chart
is singular (the poles, the atan2 cut at longitude ±π).
