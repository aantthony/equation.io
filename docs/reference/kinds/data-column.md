---
kind: dlist
title: Data column
form: data = open("file.csv"); data.height
short: data column, as a dot plot
---

A column of a data file, drawn as a dot plot on the number line like any
[number list](#vlist).

## Examples

- Ages from a CSV file: `person = open("people.csv", 3a7f9c1d2e4b); person.age`

## Pitfalls

- The data stays on the device that dropped the file: elsewhere the row
  reports it as device-local (see Data file, under Definitions).
