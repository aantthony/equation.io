# Axis maps: log scales and beyond (#71)

Status: **step 1 implemented** (lib/axis-map.ts); the rest are notes.

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
2. **Grid and labels.** lib/grid.ts draws level sets at even spacing, which
   on a log axis counts X (0, 1, 2, 3) rather than x (1, 10, 100, 1000).
   Needs a tick chooser that knows the map: decades with 2..9 minor lines,
   labels like 10³; for other maps, nice x values pulled back through the
   inverse.
3. **Points and parametric objects.** Points, parametric curves, segments,
   polygons, data and regressions, labels: apply the inverse to each
   produced position. Dragging writes back through the forward map; hover
   and intersection readouts report x, not X. Values outside the map's
   range (x ≤ 0 on a log axis) are hidden with a note.
4. **Sliders in maps** (`x = b^X`): the write-back reparses the row without
   constants today, so maps take numbers only.

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
