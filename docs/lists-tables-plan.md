# Lists, tables, and CSV files

Plan agreed 2026-08-08. Decisions locked: **1-based list indexing**, **raw hash
token in the row for v1**, **warnings (not silence) for skipped rows**, and
**`open` is reserved** (not shadowable).

The goal, end to end:

```
person = open("people.csv", a1b2c3d4e5f6)
(person.age, person.height)        # scatter plot
mean(person.age)                   # readout
adults = person[person.age >= 18]  # derived table
```

## Design stance

**The URL stays the whole document; data is pinned by content hash.** A CSV
cannot live in the URL, but its identity can. `open("people.csv", a1b2c3d4e5f6)`
names bytes by SHA-256 prefix; the bytes live in IndexedDB. On another device
the row fails loud — *"people.csv (a1b2c3…) isn't on this device — drop the
file here"* — and dropping a matching file heals it. Dropping a same-named
file with a different hash offers to rewrite the hash in the row (precedent:
sliders, drag write-back, `view(...)` rows are all two-way bound). A shared
graph never silently renders against different data than its author saw.

**Zero runtime deps stays true.** Own RFC-4180 CSV parser, `crypto.subtle`
for hashing, raw IndexedDB.

**Lists never reach GLSL.** Like Σ/Π/∫, `d/dx`, points, and matrices, lists
are eliminated symbolically during lowering (phase 1) or evaluated to typed
arrays on the CPU (phases 2+). `toGLSL`, `diff`, and the integrator never see
a list.

## Phase 1 — lists as values, by symbolic lowering

A new lowering pass (`lib/list.ts`) runs in the row pipeline after
`lowerGeom` (web/main.ts:1196 and the matching spot in worker/graph.ts), and
inside `buildDefs`' const branch so list defs can reference earlier lists.
No new plot types: everything normalizes to the existing `vlist`/`plist`
rows or to scalar expressions.

- **List defs**: `L = [1, 4, 2]`. In `buildDefs`, a lowered list that
  `matrixFromList` declines (flat data list) becomes a list definition
  instead of today's error. Caveat kept for compatibility: a *named* list of
  2–3 same-length tuples is still a **matrix** (`M = [(1,2),(3,4)]`); a bare
  (unnamed) row of tuples is still a scatter.
- **Ranges**: `[1..20]`, `[0, 0.5..10]` (first two elements set the step),
  `[10..1]` counts down. Bounds must be constants/sliders, like Σ bounds;
  expansion happens at resolve time where const values are known.
- **Broadcasting**: scalar ⊕ list maps; list ⊕ list zips, and mismatched
  lengths are an **error** (Desmos truncates silently; we don't mis-plot).
  `(A, B)` with list components zips into a list of points → scatter.
  Scalar builtins map elementwise (`sin(L)`).
- **Reductions**: `mean, total, count, stdev, median, sort` (new shadowable
  builtins) plus `min(L)`/`max(L)`. `mean`/`total`/`count`/`min`/`max` lower
  symbolically, so `mean([sin(t), 2])` animates; `stdev/median/sort` need a
  constant list in v1. A row that wrote a reduction and resolved to a
  constant gets a `≈` readout (same pattern as ∫ rows, web/main.ts:1204).
- **Indexing**: `L[2]`, **1-based** (`L[0]` explains itself). Only *named*
  lists index — parseExpr learns list names the way it learns function names,
  so `x[2]` keeps meaning `2x` and `[1,2,3][2]` stays implicit
  multiplication (documented in llms.txt).
- **Caps**: 10 000 materialized elements per row, fail-loud beyond. (CSV
  columns do NOT go through symbolic expansion — see phase 2.)

## Phase 2 — `open()`, drag-and-drop, IndexedDB *(built)*

Two departures from the plan below, both deliberate:

- **Member access came forward from phase 3.** Without `person.age`, phase 2
  renders nothing, so it shipped here — and much more cheaply than planned:
  `.` is an operator that joins two names (`person.age` is one variable
  name), and buildDefs answers such a name with the column's elements. So
  columns ARE lists, and every phase-1 behaviour (broadcasting, zipping into
  a scatter, reductions, 1-based indexing, length-mismatch errors) applies
  with no new code. No `{kind: 'member'}` node exists.
- **No `{kind: 'data'}` typed-array leaf yet**, so a column expands to
  ordinary number expressions, and rows are capped at 5000 (`TABLE_MAX_ROWS`)
  — measured at ~8 ms per keystroke and no dropped frames with 3000 points.
  Lifting that cap is phase 4's instanced rendering, not a tweak.

Still phase 3: filters (`person[person.age >= 18]`), string columns
(recognized and named, but plotting one is an error), and the preview grid.
Ingest is drag-and-drop and a file picker; pasting CSV *text* is not
implemented (too easy to confuse with pasting equations).

Dense scatters lost their per-dot outline (>200 points): at CSV densities the
outlines of later dots painted over the fill of earlier ones, turning a
3000-point trace the outline colour.


- **Grammar**: string literals (double or single quotes), legal only as
  `open()`'s first argument. `open` joins RESERVED. The hash argument is a
  bare 12-hex token, shown raw in the row for v1 (a chip widget can come
  later). Note `'` is LINK_UNSAFE in lib/link.ts — canonical serialization
  uses double quotes.
- **Definition kind**: `person = open("people.csv", hash)` matches CONST_RE;
  `scanDefinition` recognizes the `open(` head and emits a new
  `{ kind: 'table' }` definition, resolved against the file store.
- **Ingest**: drop anywhere (canvas or panel), paste CSV text, or file
  picker. Read → parse → hash → persist → append `name = open(...)` row
  named from the sanitized filename stem.
- **CSV parser** (lib, pure): RFC-4180 — quoted fields, escaped quotes,
  CRLF, embedded commas/newlines — plus delimiter sniffing (`,` `;` `\t`)
  and BOM stripping. Header row → column keys sanitized to identifiers
  (spaces → `_`, deduped). Column type inference: all numeric-or-blank →
  `num` (blank = NaN), else `str`. Dates deferred.
- **Skipped rows warn**: cells that fail to parse or NaN out are skipped at
  plot time with a per-row warning count ("3 rows skipped"), never silently.
- **IndexedDB**: db `equation-io`, store `files`, key = full sha256 hex.
  Value: `{ name, blob, size, addedAt, parsed: { rowCount, columns } }` —
  raw blob for fidelity, columnar Float64Array/string[] parsed once at
  ingest. `navigator.storage.persist()` on first write. A small local-files
  manager (list/delete) behind the menu.
- **Server surfaces**: `/api/og` and MCP previews can't reach IndexedDB —
  data rows go through the existing `preview_omits` mechanism; MCP
  `create_graph` validates `open()` rows syntactically and reports data as
  device-local. Later option (not now): `open("https://…/x.csv", hash)`
  remote fetch with the same hash pin.

## Phase 3 — tables and filters

- ~~**Member access**~~ — built in phase 2, as a name-joining `.` operator
  rather than a `{ kind: 'member' }` node.
- **Columns are data-backed, not ASTs**: a new leaf (`{ kind: 'data' }`)
  wraps a typed array so a 100k-row column never expands symbolically.
  Broadcasting/zip from phase 1 gains a fast path over data leaves;
  reductions of constant columns fold numerically at resolve time.
- **Row-wise math**: `person.weight / person.height^2` — same-table columns
  are always aligned.
- **Filters**: `adults = person[person.age >= 18]` (derived table),
  `L[L > 2]`, string equality `person[person.city == "NYC"]`.
- **Preview UI**: collapsible read-only grid under an `open()` row — first
  ~8 rows, column names/types, row count. Editable Desmos-style tables stay
  out (small literal data is already `[(1,2),(3,4)]`).

## Phase 4 — scale and polish

- Constant column scatters upload typed arrays straight to a GPU buffer
  (instanced), no per-point Expr eval; t-dependent list rows re-evaluate per
  frame under a perf-guard cap.
- `hist(L)` as the first stats renderer (reuses the KDE binner's bucketing
  in lib/dist.ts) — the bridge to regressions
  (`fit(person.height ~ a*person.age + b)`), which is its own plan on top of
  this foundation.

## Testing

- lib: parser (ranges, indexing, strings, member), broadcasting incl.
  mismatch errors, reduction lowering, CSV edge cases (quotes, CRLF, BOM,
  ragged rows, sniffing), hash stability, cap behavior.
- web: IndexedDB behind a small interface, faked in tests; e2e via browser
  pane with a synthesized DataTransfer drop.
- llms.txt gains a Lists/Data section in each phase (lib/llms-txt.test.ts
  keeps it honest).
