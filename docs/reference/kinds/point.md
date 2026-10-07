---
kind: point
title: Point
form: (1, 2)
short: point; A = (1, 2) names it and makes it draggable
---

A point. Named, `A = (1, 2)`, it is labelled and draggable, and every row
that uses A follows it.

## Forms

- `(x0, y0)` or `(x0, y0, z0)`.
- `A = (1, 2)`: a named point, drawn and draggable (see Point and Dragging,
  under Definitions).
- Moving with time: `(2cos(t), 2sin(t))`.
- A complex number: `1+2i` draws at (1, 2).

## Examples

- Point: `(2, 3)`
- Named draggable point: `A = (1, 2)`
- Point circling the origin: `A = (2cos(t), 2sin(t))` — moves with time; computed, so not draggable
- Point that slides along y = x² with a slider: `a = 1; (a, a^2)`
- Complex number as a point: `1+2i`

## Pitfalls

- Several points: one row each, with different names (`A = (1, 2)`,
  `B = (3, 4)`), or a list of them in one row: `[(1, 2), (3, 4), (5, 1)]`
  (see [Point list](#plist)). Redefining one name (`A = 1`, then `A = 2`)
  is an error.
- To make a point move, change its own row (`A = (cos(t), sin(t))`) rather
  than adding a moving copy beside it.

## Details

- Complex point: a constant complex expression such as `1+2i` draws at (1, 2).
  Constants and t may animate its real and imaginary components. A named
  one, `a = e^(i pi/3)`, is written in wherever `a` is read (`a^2`,
  `domain(w - a)`, `[1..|a|]`), and a real value reached through complex
  ones is a constant like any other (`b = re(a)`, `r = |3 + 4i|`).
