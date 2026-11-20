---
kind: label
title: Label
form: label((1, 2), "text")
short: text beside a point
---

Text written beside a point on the graph, in the row's colour.

## Forms

- `label(point, "text")`, as a whole row.

## Examples

- Label at a point: `label((2, 4), "the curves cross here")`
- Label on a named point: `A = (1, 1); label(A, "vertex")`
- Label that follows a slider: `a = 2; label((a, a^2), "moves with the slider")`

## Pitfalls

- Keep the text to a few words, and inside its quotes: the whole call is
  one row.

## Details

`label(point, "text")` writes text beside a point on the graph, in the row's
color. Use it as a whole row. Examples:

    label((2, 4), "the curves cross here")
    A = (1, 1)
    label(A, "vertex")
    a = 2
    label((a, a^2), "moves with the slider")

The point may be a tuple, a named point, or point arithmetic, in 2D or 3D, and
may use constants, sliders, states, and `t`; it cannot use free x/y/z or u/v.
The text is plain and fixed. The MCP classifies these rows as `label`.
