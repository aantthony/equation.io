---
kind: sequence
title: Sequence
form: a_n = 1/n
short: sequence, as dots at whole numbers n
---

A sequence, drawn as dots at the whole numbers n: an explicit `a_n = …`, or
a recurrence whose step reads n or other sequences.

## Examples

- Harmonic sequence: `a_n = 1/n`
- Primes: `a_n = isprime(n)`
- Factorials: `a_0 = 1; a_{n+1} = (n + 1) a_n`

## Pitfalls

- A recurrence that steps from its own term alone draws a
  [cobweb](#cobweb), or with x a [bifurcation diagram](#bifurcation).

## Details

- Sequence values: `a_n = 1/n` defines `a_3` as a scalar and `a_[1..10]`
  as a list, usable in sums, scatters, histograms and regression. `a_k`
  reads the term at a slider `k`, and `a_N` one term per element of a list
  `N`. A term may use another sequence at its own index —
  `a_n = b_n + 1`, `b_[n+1] - b_n`, `sum(k=1..n, b_k)` — including a
  recurrence's terms (`d_n = a_{n+1} - a_n`, up to index 1000). A
  recurrence that steps from its own term alone draws a cobweb (or, with x,
  a bifurcation diagram). One whose step also reads n, another sequence at
  n, or a tuple at a position in n draws its terms as dots instead:
  `a_{n+1} = (n + 1) a_n` (factorials), `q_{n+1} = step(q_n, D[n + 1])`
  with `D = (1, 1, 0, 1)` (a state machine's run over the digits of D). Its
  terms stop where the tuple does. Two recurrences may read each other at n
  (`q_{n+1} = q_n + r_n` beside `r_{n+1} = r_n + q_n`), and a case in a
  sequence row may test equality (`{mod(n, 2) = 0: 1, 0}`). A sequence's
  index may also go in braces or parens, as its recurrence row is written: `b_{n+1}`, `a_(n-1)`,
  and the rows `a_{n} = 1/n` and `a_{0} = 1`. Each letter is one sequence: beside
  `a_n = 1/n`, `a_k = 7` is a constant named a_k. Indices
  must be whole numbers from 0 to 1000. Recurrences use their `a_0` seed
  (default 0.5); terms compute as a bounded chain of scalar constants, so
  sliders and t remain live. A recurrence using x as a bifurcation parameter
  cannot also supply constant terms without binding that parameter.
- Tuple-valued recurrences: a recurrence whose step calls `push(s, a)` (s
  with a appended) or `pop(s)` (s without its last element), or whose value
  is a tuple, has tuples as terms — a stack. `top(s)` reads the last
  element. `s_0 = ()` starts it from the empty tuple (the default), and any
  tuple may be its seed; a tuple seed with a step that makes no tuple
  (`a_0 = (0.1, 0.2); a_{n+1} = 3 a_n (1 - a_n)`) steps each element instead.
  `count(s_n)` is its length and `s_n[h]` its h-th element; a number with a
  tuple applies to each element (`1 + p_n`, `s_n/2`). Only the case that holds is run,
  so cases may differ in length: with `D = (1, 1, 2, 2)`,
  `s_{n+1} = {D[n + 1] = 1: push(s_n, 1), pop(s_n)}`. The run stops where
  it pops or reads the top of the empty tuple, or where no case holds (a
  machine with no move). The row draws its terms as rows of a lattice: row
  n, position h. A pushdown automaton is a state recurrence and a stack
  recurrence reading each other: `q_{n+1} = step(q_n, D[n + 1], top(s_n))`.
  One that starts from a point (`p_0 = (0, 0)`,
  `p_{n+1} = (1 - 1.4 p_n[1]^2 + p_n[2], 0.3 p_n[1])`, the Hénon map) and
  stays one draws its orbit as points. Other rows read its terms at a number
  or a slider (`s_3`, `top(s_k)`); an explicit sequence `d_n = count(s_n)`
  cannot (read it in a recurrence's step instead). Its terms are computed
  once, so its step cannot read t.
