---
kind: trail
title: Motion trail
form: A = (2cos(3t), 2sin(2t)); trail(A)
short: path behind a moving point
---

A live trail of a moving point's positions, with a dot where it is now.

## Forms

- `trail(A)` for a named point that moves with t, or a vector state.
- `trail((f(t), g(t)))` or `trail((f(t), g(t), h(t)))` for a tuple.

## Examples

- Point circling the origin, with its trail: `A = (cos(t), sin(t)); trail(A)`
- Rising spiral: `trail((cos(t), sin(t), t/5))`
- Lissajous path: `A = (2cos(3t), 2sin(2t)); trail(A)`

## Pitfalls

- The point must move with t (or be a state): a trail of a fixed point is a
  dot.
- For the whole path at once, draw it as a [parametric curve](#pcurve) in u.

## Details

`trail(A)` leaves a live trail of a point's observed positions, with a dot at
its current position. Use it as a whole row. Examples:

    A = (cos(t), sin(t))
    trail(A)

    trail((cos(t), sin(t), t/5))

A named 2D point, point arithmetic such as `trail(2A)`, or a 2D/3D vector state
can be traced. Components may use constants, sliders, states, and `t`; they
cannot use free x/y/z or u/v. `trail(cos(t), sin(t))` is equivalent to the
parenthesized tuple spelling. Matrix `trace(M)` keeps its existing meaning
(the sum of the diagonal), including inside other expressions.

The live browser retains at most 30 seconds and 2048 samples per trail,
sampling at most 60 times a second. Undefined positions or pauses over half a
second break the line instead of joining unobserved motion. Editing equations
or restarting the simulation clears history; framing/comment edits preserve
it. Trails start afresh on opening a graph and are not saved in shared URLs.
The MCP classifies these rows as `trail`; static previews use the fallback
card because a still image cannot reproduce accumulated live history.
