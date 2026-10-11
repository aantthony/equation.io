---
title: Reference
---

> Free in-browser graphing calculator (WebGL). Plots 2D curves, inequality
> regions, scalar fields, vector fields and ODEs, complex functions (including
> domain coloring, conformal maps and escape-time fractals), 3D surfaces,
> parametric curves/surfaces, plane geometry (named draggable points,
> segments, polylines, vector arrows, polygons, squares, circles), symbolic
> derivatives and integrals,
> and random variables with shaded probabilities. No account, no server round-trips: the graph state
> lives in the URL fragment, so you can construct a link that opens the app
> with any set of equations already rendered.

A graph is a list of rows, and each row draws one kind of thing: a curve, a
shaded region, a surface, a point, a readout. The analyzer names that kind
(`implicit2d`, `psurface`, …); the MCP tools and the app's assistant report
it for every row, with what it means. Below, every kind by group: its name,
its kind, its smallest form and what it draws, then a section on each with
its forms, worked examples (each one shape) and pitfalls. Definitions
(sliders, functions, named points; see Definitions) set rows up and draw
nothing themselves.

## 2D curves and regions

- implicit2d
- ineq2d
- pcurve
- pregion
- projected2d
- system

## Points, figures and labels

- point
- polygon
- label
- trail

## Readouts and families

- value
- note
- family

## 3D

- implicit3d
- psurface
- solid
- spacecurve

## Fields

- vfield2d
- vfield3d
- scalar2d
- scalar3d

## Sequences and simulations (brief)

- sequence
- cobweb
- bifurcation
- orbit
- automaton

## Lists and data (brief)

- vlist
- plist
- histogram
- dlist
- dscatter
- tuple

## Probability (brief)

- density
- pmf
- prob
- expect

## Complex functions (brief)

- complex2d
- domain2d
- conformal2d
- fractal2d

## Colour fields (brief)

- rgb2d
- hsl2d
- oklch2d

## Algebra (brief)

- tfield2d
- multivector
- flat
- action
- graph
- lattice

## Curvature and spacetime (brief)

- geodesic
- metric
- lightcone
- tidal
