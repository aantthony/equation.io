---
kind: tuple
title: Tuple readout
form: sort([5, 3, 1, 4, 2])
short: readout of a tuple of more than 3 numbers
---

A tuple of more than 3 numbers, or a matrix or tensor on its own row: read
out under the row; draws nothing.

## Examples

- Sorted values: `sort([5, 3, 8, 1, 2])`
- A matrix: `M = ((1, 2), (3, 4)); M`

## Pitfalls

- A tuple of 2 or 3 numbers is a [point](#point): `sort([3, 1, 2])` draws
  (1, 2, 3).

## Details

See Order lives in tuples, under Expression syntax.
