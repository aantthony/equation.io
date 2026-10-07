---
kind: vlist
title: Number list
form: [1, 2, 2, 3]
short: list of numbers, as a dot plot
---

A list of numbers, drawn as a dot plot on the number line: each value at
x = value, copies stacked upward.

## Examples

- Dot plot: `[3, 1, 4, 4]`
- Distribution of a long list: `L = [1..300]; sin(L)`

## Pitfalls

- A list has no order, so no index is drawn; a [sequence](#sequence) `a_n`
  draws at n.

## Details

- Data list: `[3, 1, 4, 4]` is a dot plot on the number line — a dot at each
  value on the x axis, copies stacked upward, so 4 has dots at (4, 1) and
  (4, 2). A list has no order, so no index is drawn (a sequence `a_n` does
  draw at n). Values closer than a dot's width at the current zoom share a
  column, so a long list (`sin(L)` for `L = [1..300]`, a CSV column of
  thousands) stacks into the shape of its distribution rather than one row of
  overlapping dots; zoom in and they separate. `[(1, 2), (3, 4)]` draws a
  scatter of points.
  Any list-valued expression plots the same way (`L^2 + 1`,
  `(L, L^2)` with `L` defined above, or a CSV column: `person.age`).
