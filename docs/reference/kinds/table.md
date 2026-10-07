---
kind: lattice
title: Table
form: T[i, j] = {i > 0: {j > 0: gcd(i, j)}}
short: table of values on the integer lattice
---

A table of values on the integer lattice: one cell per (i, j), shaded by
value and printed when zoomed in.

## Examples

- Greatest common divisors: `T[i, j] = {i > 0: {j > 0: gcd(i, j)}}`
- Addition table of ℤ/6: `n = 6; T[i, j] = {0 <= i < n: {0 <= j < n: mod(i + j, n)}}`

## Details

- Table: `T[i, j] = …` is a function on the integer lattice, drawn as cells
  shaded by value: row i, column j, as a Cayley table or a matrix is read.
  Undefined values leave a cell empty, so nested cases bound it:
  `n = 6; T[i, j] = {0 <= i < n: {0 <= j < n: mod(i + j, n)}}` is the
  addition table of ℤ/n. Only the cells in view are computed, so a table
  may be unbounded (`T[i, j] = gcd(i, j)`).
- Lattice panels: a panel whose rows are all automata, tables and stacks (or whose
  view row names index axes) is a lattice. Its grid runs between cells, its
  edges are numbered by index (whole numbers only), and zoomed in far enough
  each cell prints its value. `view(i = -60..60, n = 0..80)` frames one by
  its index names, in either order; panning rewrites it in those names.
