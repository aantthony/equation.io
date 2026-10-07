---
kind: plist
title: Point list
form: [(1, 2), (2, 3), (3, 5)]
short: list of points
---

A list of points, drawn as dots: written out, built from crossing lists, or
a list of complex numbers.

## Examples

- Three points: `[(1, 2), (3, 4), (5, 1)]`
- Grid of four points: `[0,1] e_x + [0,1] e_y`
- Fifth roots of unity: `n = 5; e^(2 pi i [0..n-1]/n)`
- Amplitude spectrum: `fourier((0, 1, 0, -1))`

## Pitfalls

- Two separately defined lists cross: with `X = [1, 2]` and `Y = [3, 4]`,
  `(X, Y)` is 4 points. Pair values by writing the points out.

## Details

- Complex list: one complex member makes a list complex — `1` in
  `[1, i, -1]` is 1 + 0i — and it draws each member as a complex point:
  `n = 5; e^(2 pi i [0..n-1]/n)` is the fifth roots of unity, n on a
  slider. Name it like any list (`S = e^(i pi [0..5]/5)`); `re(S)`,
  `abs(S)` and `(re(S), im(S))` are real. `total`, `mean` and `count`
  reduce it; `sort`, `median`, `stdev`, `min`, `max` and `hist` need real
  numbers, so take `abs`, `re` or `im` first (filters and sort keys too:
  `S[re(S) > 0]`; equality needs neither, `S[S == 1]`). `sort(S, re(S))`
  is S's members in order, a tuple, which has no picture yet: `T[k]` picks
  one. Members are drawn split into
  real and imaginary parts, 2^21 nodes in all: constant members are two
  numbers each, but thousands of members of a slider-dependent polynomial
  are too many. A list cannot mix complex numbers with points, and a
  point's coordinates stay real (`(S, 1)` is an error).
