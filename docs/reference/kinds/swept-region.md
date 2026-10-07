---
kind: projected2d
title: Swept region
form: a = interval(1, 2); y = sin(a x)
short: region swept by a curve as a runs over an interval
---

A shaded 2D region swept by a family: a row in x and y that reads one
interval draws every point some member of the family puts on its curve (or,
for an inequality, in its region).

## Forms

- `a = interval(lo, hi)` above, then an equation or inequality in x, y and a.
- At most one interval in the row.

## Examples

- Band of sine curves: `a = interval(1, 2); y = sin(a x)`
- Fan of lines: `a = interval(1, 2); y < a x`
- Parabolas shifted up by up to 1: `c = interval(0, 1); y = x^2 + c`

## Pitfalls

- A bare field over an interval (`sin(a x)`) is an error: set it equal to
  something.
- For a few separate curves, a list (`a = [1, 2]`) draws one curve each:
  see [Family](#family).

## Details

See `interval(a, b)` under Variables: with `a = interval(1, 2)`, `y = sin(a x)`
shades every point some a from 1 to 2 puts on its curve, and `y < a x` every
point below some member.
