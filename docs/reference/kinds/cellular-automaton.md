---
kind: automaton
title: Cellular automaton
form: c_0[i] = {i = 0: 1, 0}; c_{n+1}[i] = mod(c_n[i-1] + c_n[i+1], 2)
short: cellular automaton
---

A cellular automaton on the integer lattice: a 1D rule draws its space-time
diagram (cells across, steps down), a 2D rule one generation of its board,
stepping with t.

## Examples

- Rule 90: `c_0[i] = {i = 0: 1, 0}; c_{n+1}[i] = mod(c_n[i-1] + c_n[i+1], 2)`
- Every elementary rule on a slider: `r = 30; c_{n+1}[i] = mod(floor(r / 2^(4 c_n[i-1] + 2 c_n[i] + c_n[i+1])), 2)`
- Conway's Life, from a glider: `life(c, s) = {s = 3: 1, s = 4: c, 0}; L_0 = [(0, 1), (1, 2), (2, 0), (2, 1), (2, 2)]; L_{n+1}[i, j] = life(L_n[i, j], sum(a=-1..1, sum(b=-1..1, L_n[i+a, j+b])))`

## Details

- Cellular automaton (1D): `c_{n+1}[i] = …` is a rule for a row of cells,
  reading the previous row at fixed offsets — `c_n[i-1]`, `c_n[i]`,
  `c_n[i+2]` — plus n, t and constants (not i itself). `c_0[i] = …` is the
  starting row as any expression in i; without it the start is a single 1
  at i = 0 on a background of 0s. The rule row draws the space-time diagram
  in a lattice panel (see [Table](#lattice)): i across, n down, for 1000 steps. The lattice
  is unbounded: each side's background steps by the rule too, so rule 1
  (000 → 1) flips the whole background every row. Values shade the row's
  colour from 0 (empty) to the largest value (solid), so k-state rules work
  too. Every elementary rule on one slider:
  `r = 30; c_{n+1}[i] = mod(floor(r / 2^(4 c_n[i-1] + 2 c_n[i] + c_n[i+1])), 2)`
  (frame it with `view(i = -60..60, n = 0..80)`). In automaton and table rows
  a piecewise case may test equality — `{s = 3: 1, 0}` — since cells are
  whole numbers; so may a function those rows call.
- Cellular automaton (2D): `L_{n+1}[i, j] = …` reads the previous generation
  at fixed offsets, row first as in a matrix (`L_n[i+1, j]` is the cell
  below). A Σ with number bounds unrolls, so a neighbourhood is written once.
  The seed is `L_0[i, j] = …`, or the live cells as (row, column) points,
  `L_0 = [(0, 1), (1, 2), (2, 0), (2, 1), (2, 2)]` (a glider). The rule row
  draws one generation, 8 per second as t runs, on a board of cells
  -256..256 each way (a pattern reaching its edge is cut off there), with
  the generation read out in the corner. Conway's Life:
  `life(c, s) = {s = 3: 1, s = 4: c, 0}` then
  `L_{n+1}[i, j] = life(L_n[i, j], sum(a=-1..1, sum(b=-1..1, L_n[i+a, j+b])))`
  (s counts the cell itself).
