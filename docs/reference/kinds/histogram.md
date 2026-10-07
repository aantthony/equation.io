---
kind: histogram
title: Histogram
form: hist([1, 2, 2, 3])
short: histogram of a list
---

A histogram: a list's values binned into a bar chart.

## Examples

- Histogram of a few values: `hist([1, 2, 2, 3, 3, 3, 4])`
- Histogram with 20 bins: `L = [1..200]; hist(sin(L), 20)`

## Details

- `hist(L)` bins a list into a bar chart — `hist(L, 40)` sets the bin count
  (default ≈ √n, between 5 and 60). It is a whole row, not a value, and the
  one thing you may do to it is scale it: the plane has a single scale for
  both axes, so counts in the thousands need `hist(L, 40) / 800` to share a
  view with values in the units. Missing values are left out.
