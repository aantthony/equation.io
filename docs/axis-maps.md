# Axis maps: log scales and beyond (#71)

Status: **steps 1–5 implemented** (lib/axis-map.ts, lib/axis-ticks.ts, web/render2d.ts mapOverlay); the rest are notes.

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
   way. Still not drawn on mapped axes: vector and tensor fields (their
   arrows need the map's Jacobian), histograms (bars stand on y = 0),
   complex systems, 3D and integral shading.
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
