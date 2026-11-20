---
title: Split views (panels)
summary: --- rows split the graph into panels.
---

A row of three or more dashes, `---`, splits the graph into panels. Rows
below it draw in a new panel with its own x, y and z, its own 2D-or-3D mode,
and its own `view(…)`, `camera(…)` and `grid(…)` rows. Definitions (sliders,
`f(x) = …`, states) are shared by every panel. Dragging pans or orbits the
panel under the pointer.

- Placement follows the dashes: `--- below`, `--- above`, `--- right`,
  `--- left`, or `--- inset top left` (picture in picture, floating in a
  corner of the panel above; corners: top/bottom with left/right, default
  top right). A bare `---` splits along the longer side.
- A size gives the new panel's share: `--- below 30%` (default 50%; an
  inset defaults to 35% of its host's width and height).
- Each split divides the most recent tiled panel, so a 3D scene with two 2D
  panels stacked on its right is `--- right 40%` then `--- below`.
- `shared x` locks the panel's x axis to the panel it split from: same center
  and scale, so stacked plots line up column for column, and panning either
  pans both. Its `view(y = lo..hi)` then frames y alone. `shared y` does the
  same for rows (side-by-side panels at the same height).
- A function over its derivative:
  `f(x) = x^3 - 3x; y = f(x); --- below 40%, shared x; view(y = -4..10); y = d/dx f(x)`
- A 3D surface beside its contour map:
  `z = sin(x) cos(y); --- right; view(x = -4..4, y = -4..4); sin(x) cos(y)`
- At most 8 panels. Options: order is free, commas optional
  (`--- below 40%, shared x`).
