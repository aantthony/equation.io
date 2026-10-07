---
title: Grid rows
summary: grid(…) rows: what draws behind a panel.
---

`grid(…)` sets what draws behind its panel's plots (one per panel):

- `grid(off)` — nothing: no grid lines, axes or numbers (a pendulum, a
  diagram). In 3D it hides the axes and the floor grid.
- `grid(axes)` — just the two axes and their numbers.
- `grid(r, theta)` — exactly these coordinates' level sets, e.g. after
  `r = sqrt(x^2+y^2); theta = atan2(y,x)`. `grid(x, y)` keeps the Cartesian
  grid even where coordinate fields are defined.
- Without a grid row, coordinate fields defined in a panel replace that
  panel's Cartesian grid (so `grid(x, y)` is how to define r and theta for
  later rows without drawing them).
