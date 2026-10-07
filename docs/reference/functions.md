---
title: Functions
---

Every built-in function, with its signature. Names are case-insensitive
(`Sin(x)` is `sin(x)`), and arguments always take parentheses: `sin(x)`, not
`sin x`. Derivatives (`d/dx`), integrals (`int[a..b] … dx`), sums and
products have forms of their own (see Expression syntax). There is no
`plot(…)`, `surface(…)` or `plot3d(…)`: what a row draws comes from what it
is (see Row types).

## atan2

y first: `atan2(y, x)` is the angle of the point (x, y), in (−π, π].

## log

Base 10. `ln` is the natural logarithm.

## clamp

As a constant's whole value it sets the slider's range: `a = clamp(0.4, 0, 1)`
is a slider over [0, 1]. Anywhere else it is an ordinary function.

## interval

Every mention of one named interval is the same number; each written
`interval(…)` is a separate one. In a tuple it traces like u and v: with one
other parameter it fills a [region](#pregion), with two a [solid](#solid).
A list `[1..2]` is only the whole numbers 1 and 2.

## sort

Returns a tuple, which has an order and can be indexed: `sort(L)[2]`. A list
`[ … ]` has none.

## hist

A whole row, not a value: the one thing to do to it is scale it,
`hist(L, 40) / 800`.

## rotate

In 3D, `rotate(P, a)` turns about the z-axis; `rotate(P, a, axis)` about
another.

## circle

Planar: in 3D, draw a circle as a [parametric curve](#pcurve),
`(cos(2pi u), sin(2pi u), 0)`.

## polygon

Fills in 2D. In 3D only triangles fill; a solid is `hull(…)` of its corners
or a [parametric solid](#solid).

## hull

Interior and repeated points are ignored; up to 2000 points in 3D. Flat 3D
input draws a polygon.

## label

A whole row: `label((2, 4), "text")`, the text in quotes and a few words long.
The point may use sliders and t.

## trail

The point must move with t, or be a state: a fixed point's trail is a dot.

## tube

The whole row, around a curve of exactly three components; an optional last
argument is the radius (default 0.1).

## revolve

The whole row. The profile may use only its axis variable, sliders and t.

## action

A matrix alone on its row draws nothing; `action(M)` draws what it does.

## iter

Inside `iter` only, `z` is the iterate. With `w` (or x, y) in the step,
iteration starts at 0 (the Mandelbrot set); with a constant step each point
is its own start (a Julia set).

## domain

f is a complex expression in w, the point x + iy.

## conformal

f is a complex expression in w, the point x + iy.

## rgb

Channels run from 0 to 1, not 0 to 255. It fills the plane: to colour another
row, end that row with a hex colour instead (`y = x^2 #e24`).

## sum

Bounds must be numbers or constants defined in another row (not t); a
slider bound adds terms as it is dragged.

## int

The trailing `dx` names the variable. Alone on its row, a definite integral
also shades the area it measures.

## curvature

Without u0 it is a function of u, for other rows: `(u, curvature(C))`. Alone
on a row that is an error.

## frame

With t for u0 the frame rides along the curve: `C = (2cos(2pi u), sin(2pi u))`,
then `C` and `frame(C, t/10)`.

## fourier

The signal runs over an interval, its period: `s = interval(0, 1)`, then
`fourier(sin(2pi s))`. A signal in x is an error.

## open

The file stays on the device it was dropped on: a link carries its name and
hash, not its data.

## graph

Cases in a graph row may test equality: `{mod(k, 2) = 0: k/2, 3k + 1}`.

## P

Needs a random variable declared in its own row: `X ~ Normal(0, 1)`, then
`P(X < 1)`.

## E

Needs a random variable declared in its own row: `X ~ Normal(0, 1)`, then
`E(X^2)`.
