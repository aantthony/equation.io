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
- **No `{kind: 'data'}` typed-array leaf yet**, so a column expanded to
  ordinary number expressions and rows were capped at 5000
  (`TABLE_MAX_ROWS`). Phase 4 added the leaf and raised the cap to 200 000.

Still phase 3: filters (`person[person.age >= 18]`), string columns
(recognized and named, but plotting one is an error), and the preview grid.
Ingest is drag-and-drop and a file picker; pasting CSV *text* is not
implemented (too easy to confuse with pasting equations).

Dense scatters lost their per-dot outline (>200 points): at CSV densities the
outlines of later dots painted over the fill of earlier ones, turning a
3000-point trace the outline colour.

As planned:

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

## Phase 3 — tables and filters *(built, except text)*

- ~~**Member access**~~ — built in phase 2, as a name-joining `.` operator
  rather than a `{ kind: 'member' }` node.
- ~~**Row-wise math**~~ — falls out of phase 1 broadcasting; same-table
  columns are always the same length, so they zip.
- **Filters** *(built)*: a comparison over a list lowers to a *mask* — a list
  of comparisons — and only `[ ]` consumes one; a mask that escapes says so
  rather than plotting nothing. `L[L > 2]`, `person.height[person.age > 30]`,
  chains (`person.age[30 <= person.age < 40]`), and
  `adults = person[person.age >= 18]`, which cuts every column of the file
  together and registers the result as another table. Masks are decided at
  lowering time (constants and sliders, never t) because the result is a
  list literal, and a list whose length moved with t could not be one.
  NaN comparisons are false, so filtering drops gaps.
- **Preview UI** *(built)*: the data row's readout is a `<details>` summary;
  opening it shows the first 8 rows as parsed, with missing cells as "—".
  Editable Desmos-style tables stay out (small literal data is already
  `[(1,2),(3,4)]`).
- **Text** *(built, after phase 4)*: `{kind: 'str'}` for a literal and
  `{kind: 'text'}` for a text column — the counterpart of `data`. `==` and
  `!=` parse to `[eq]`/`[ne]` call nodes rather than joining IneqOp, because
  equality is not a relation the plane can shade; zipped over a list they
  become mask elements, and anywhere else they say where they belong (`!=`
  still rescuing the factorial reading of `x! = 2`). Text compares as text
  and numbers as numbers, so `city == 3` matches nothing rather than
  coercing. `count()` is the one reduction text answers.
- **Columns are still ASTs.** The `{ kind: 'data' }` typed-array leaf moves
  to phase 4, where it belongs: what it buys is per-frame rendering cost,
  and only instanced rendering cashes that in.

## Phase 4 — scale and polish *(built)*

- **`{ kind: 'data' }`, a typed-array list.** Semantically a list of numbers;
  the point is that a 120k-row column costs two objects instead of 120k.
  `lower` has a fast path (`fastMap`) taken when every operand is a typed
  array or a *literal* number, and `expand` falls back to one expression per
  element otherwise. The line is deliberate: a **slider** stays symbolic,
  because folding its value in would turn a shader uniform into a constant
  and recompile the shader on every drag. So `col/2`, `sin(col)`,
  `(a, b)`, reductions and `hist` stay compact; `col·t` and `col > 3` expand.
- Two caps, for two different costs: `TABLE_MAX_ROWS` = 200 000 rows (what
  the renderer will draw) and `ITEMS_MAX` = 100 000 (what may become
  expressions). Both fail loud and name the number.
- **Not a GPU buffer after all.** The plan said instanced rendering; the
  goal was 100k points at frame rate, and the renderer has no vertex-buffer
  path at all (every layer is a fullscreen-quad shader; points live on the
  canvas-2D overlay). Batching there — one `fillStyle`, one `fillRect` per
  point, off-screen points skipped — hits the goal in the layer points
  already live in. Measured with 120 000 points: 8.3 ms frames (no drops on
  a 120 Hz display) and 8.3 ms per keystroke including a full recompile. A
  VBO path can come if 3D clouds or 10⁶ points ever need it.
- **`hist(L)`**, `hist(L, bins)`. Bins default to ≈√n (5…60); NaNs are left
  out; one repeated value is one bar. It is a whole row, not a value — the
  one thing you may do is scale it (`hist(L, 40)/800`), because the plane
  has a single scale for both axes and counts in the thousands otherwise
  cannot share a view with values in the units.

Text filters landed right after this phase — see phase 3.

## Testing

- lib: parser (ranges, indexing, strings, member), broadcasting incl.
  mismatch errors, reduction lowering, CSV edge cases (quotes, CRLF, BOM,
  ragged rows, sniffing), hash stability, cap behavior.
- web: IndexedDB behind a small interface, faked in tests; e2e via browser
  pane with a synthesized DataTransfer drop.
- llms.txt gains a Lists/Data section in each phase (lib/llms-txt.test.ts
  keeps it honest).
