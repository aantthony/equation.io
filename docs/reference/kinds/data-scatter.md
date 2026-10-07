---
kind: dscatter
title: Data scatter
form: data = open("file.csv"); (data.age, data.height)
short: scatter plot of data
---

A scatter plot of data: two (or three) columns of one data file as points,
paired row by row.

## Examples

- Height against age: `person = open("people.csv", 3a7f9c1d2e4b); (person.age, person.height)`
- Hénon map orbit: `p_0 = (0, 0); p_{n+1} = (1 - 1.4 p_n[1]^2 + p_n[2], 0.3 p_n[1])`

## Pitfalls

- A three-column scatter draws in 3D, capped at 10 000 points (see Data
  file, under Definitions).
