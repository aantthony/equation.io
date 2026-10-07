---
kind: graph
title: Graph (network)
form: k = [0..5]; graph(k, mod(k + 1, 6))
short: node-link graph of (from, to) edges
---

A graph drawn node-link: one arrow per (from, to) element, parallel edges
counted, labels on edges, laid out automatically.

## Examples

- Cycle: `k = [0..5]; graph(k, mod(k + 1, 6))`
- Cayley graph of ℤ/12: `k = [0..11]; g = [1, 4]; graph(k, mod(k + g, 12), g)`
- Collatz arrows: `k = [1..40]; graph(k, {mod(k, 2) = 0: k/2, 3k + 1})`

## Details

- Graph: `graph(from, to)` or `graph(from, to, label)` draws arrows between
  numbered vertices, laid out automatically. Its arguments are read as one
  tuple whose elements are the arrows, so lists combine by the usual rule:
  with `k = [0..11]; g = [1, 4]`, `graph(k, mod(k + g, 12), g)` is the Cayley
  graph of ℤ/12 by 1 and 4 (both k's chosen together, g crossing them), and
  with `Q = [0..2]; S = [0, 1]` and a transition function `step(q, s)`,
  `graph(Q, step(Q, S), S)` is every transition of a state machine.
  `graph(P)` takes a list of pairs, `graph([(1, 2), (2, 3)])`. An arrow
  listed twice is drawn once with its count (×2); an undefined vertex drops
  its arrow, so a case keeps the ones wanted — composing two multisets of
  arrows (matrix multiplication, as paths): `graph({A.y = B.x: A.x}, B.y)`,
  or with the composition named as above, `graph(c(A, B))`.
  Cases in graph rows may test equality. A panel of graphs has no grid.
  A piecewise works inline over a list or through a function alike:
  `k = [1..40]; graph(k, {mod(k, 2) = 0: k/2, 3k + 1})`.
- `mark(v)` highlights vertex v in the graphs of its panel and reads v out;
  with a slider or t it walks, e.g. a state machine's run as a recurrence
  over a tuple of input symbols: `D = (1, 1, 0, 1); q_0 = 0;
  q_{n+1} = step(q_n, D[n + 1]); mark(q_N)`.
