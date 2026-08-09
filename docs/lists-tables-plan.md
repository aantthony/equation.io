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
- **Ingest**: drop anywhere (canvas or panel), or the file picker — pasting
  CSV *text* was dropped, see above. Read → parse → hash → persist → append
  `name = open(...)` row named from the sanitized filename stem.
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

## Review pass

Fifteen findings from the PR review, all real. The ones that changed
behaviour rather than tightening an edge:

- **A compact list is still a list.** `ages = person.age / 2` lowered to a
  `data` node, which the definition branch did not recognize as a list, so it
  landed among the scalar constants and was thrown out with "List in scalar
  context". `Defs.lists` now holds the sequence node in whichever
  representation it has, and naming a column no longer costs what reading it
  saved. Naming a *text* column works too: text is a value to name, and only
  drawing one has no meaning, so that check moved to plot rows alone.
- **A missing cell fails `!=` as well as `==`.** `NaN != 18` is true in
  JavaScript, so the one comparison written to exclude something was the one
  that quietly kept the gaps — against the documented rule directly above it.
- **A filter's shape is judged without the file.** `person[5]` and
  `person[person.age > t]` were accepted wherever the bytes were absent (a
  shared link, a server-side preview) and rejected on the author's own
  device. Only the per-row answer waits for the data now.
- **A 3D cloud says no instead of drawing a tenth of the file.** The draw
  loop silently stopped at 10 000 points, so a sorted CSV rendered a
  materially different cloud. The row now fails at compile time and names the
  number. A gap in `z` is skipped like a gap in `x` or `y`, rather than
  reaching projection and depth sorting as NaN.
- **The hash pins on the ordinary compile path**, not only after a load from
  storage — a row typed against a file already in memory was shared unpinned.
  The row being typed is left alone, so the write-back never fights the
  typist.
- **Every row that wants the file offers it.** The picker was on the
  `open(…)` row alone; the rows that read its columns said "drop the file
  here" and did nothing. It is also a real button now — focusable, and
  activated by Enter or Space.
- **Bytes moved out of the metadata record** (IndexedDB v2, migrating v1 in
  place). Listing the file menu at startup cloned every stored CSV to print
  its name.
- **A file name is stored as a row can quote it.** `sales "final".csv`
  produced a row that could not be parsed back; names are sanitized at
  ingest, so the record and the row agree.

Also: an unterminated quoted field is refused rather than swallowing the
rest of the file into one cell (`ingest` parses before it stores, so nothing
malformed is kept); one-argument `min`/`max` get the readout the other
reductions do; a value list's 1…n x coordinates are cached rather than
rebuilt every animated frame; and a file named while an IndexedDB read is in
flight is asked for when that read lands.

The "data files" section stays hidden until there is a file to manage — what
it was hiding was the way *in*, so that moved out to a **`+ csv`** link in
the panel's bottom row beside `github`, which is always there.

### Second pass

Four of these came out of the first round of fixes, three were older:

- **A 3-column data scatter never set `needs3D`.** The 2D pass deliberately
  skips a dim-3 cloud and `done()` only recognized `plist`, so a CSV 3D cloud
  drew *nothing* unless an unrelated row happened to turn 3D on. (Seen while
  verifying the 3D cap and wrongly written off as scene-framing.)
- **The filter shape check was too weak.** Rejecting bare leaves let
  `person[sin(person.age)]`, `person[person.age + 1]` and `person[1 < 2]`
  through on the missing-data path — the same divergence it was added to
  close. It now requires a comparison at the root *and* a list among its free
  variables.
- **A missing-data list definition erased its dependents.** With the file
  absent, `ages = person.age / 2` failed and `ages` went unregistered, so
  `mean(ages)` reported "ages is not a list defined above this row". Now
  `defs.missingLists` registers the name with its reason, exactly as
  `defs.tables` does for a column, and the worker maps those definition
  failures to `dataLocal` — so `create_graph` reports a device-local graph as
  valid with `preview_omits` instead of broken.
- **A hash prefix could be as short as 6 hex digits.** A row resolves by
  prefix, so 24 bits can match two stored files. `TABLE_RE` is built from
  `HASH_TOKEN_LEN` now, and a short token gets its own message rather than
  falling through to "quoted text only belongs in a data row".
- **Indexing lost to the function reading.** `isFnName` won before the list
  check, so a column headed `sin` (`person.sin[2]`) or a shadowing
  `mean = [3, 1, 4]` could never be indexed.
- **Dropping several files at once could name two of them the same.**
  `freeTableName` read `eq.def`, which the rows added moments earlier do not
  have yet — `sales.csv` and `sales.tsv` both became `sales`. It scans the
  row text now.
- **Delimiter sniffing always discarded the last record**, so a file with no
  trailing newline was judged on its header alone: `coords(x,y);value\na;2`
  picked the comma. The final counter is dropped only when it is the empty
  row after a newline, or a record the sample limit cut short.

### Third pass

Four of these six came out of the second:

- **The short-hash message never reached the row.** `scanDefinition` fell
  through to `CONST_RE`, so the row was a definition and the row validator —
  the only thing that could explain the hash — never ran on it; the reader
  got "p_x can only depend on other constants and t (found open)". Any
  `name = open("…` row that does not parse as a table is now left to
  `badTableRow`, which also has a general message for the other malformations.
- **The filter shape check still let a reduced list through.**
  `person[mean(person.age) > 0]` mentions a column but compares one scalar.
  `staysList` now asks whether a list actually *reaches* the comparison:
  arithmetic and scalar functions map over one, a reduction or an index
  collapses it.
- **Column paths parse the same with or without the file.** `person.age[2]`
  read as a product where the bytes were absent, because `listNamesOf` cannot
  enumerate the columns of a file it does not have — so the same row meant two
  different things. Indexing now accepts a dotted path whose *head* is known.
- **Leaving a row did not pin it.** `pinTableHashes` skips the caret's row,
  and nothing ran when the caret left, so the exception outlived the editing:
  type an unpinned row, click away, share, and the link was unpinned. The
  `selectionchange` handler pins on a line change.
- **A missing text cell now fails every comparison**, `!=` included, like the
  numeric side: blanks and `N/A` in a text column are stored as `""` and
  counted as missing, rather than comparing as ordinary text.
- **A stepped range takes its step from a constant.** `a = 0; b = 0.5;
  [a, b..2]` threw, though the documented rule gives bounds and step the same
  standing.

And the guarantee in the design stance above is now actually enforced:
**dropping a same-named file no longer repoints a row pinned to other bytes.**
Only unpinned rows and matching hashes are re-pinned; the new bytes arrive as
a row of their own, with a notice, so nothing is substituted silently and
nothing is a dead end.

### Fourth pass

- **A reduction over a big column overflowed the stack.** `total`/`mean`/
  `min`/`max` folded LEFT, nesting one node per element, and every consumer
  of an Expr recurses — a 30 000-row column crossed with `t` blew the stack
  well inside the advertised expansion limit. `fold` pairs neighbours and
  halves, so the depth is log₂ n (17 at 100 000) for the same arithmetic.
- **A dropped file that could not be stored said nothing.** `ingest`
  discarded the write result, so with IndexedDB unavailable the row promised
  bytes that would not survive a reload. The notice says so at the drop.
- **The 3D cap covered one representation of two.** Crossing a column with a
  slider or `t` expands the cloud into a symbolic `plist`, which bypassed
  `CLOUD_3D_MAX` — and that is the more expensive form, re-evaluated per
  frame. Both are capped.
- **`missingData` distinguishes a missing list from a missing number.**
  Registering every failed constant as a missing *list* (last round's fix)
  made `avg = mean(person.age)` index like a list and let a filter over it
  pass — on the device without the bytes only. The shape decides now.
- **`hist` is not list-shaped** for the filter check: it is a whole plot, and
  list.ts refuses it in a filter once the data is there.
- **A slider only snaps to whole numbers where a whole number is required.**
  `constVal` recorded every variable it touched, so `b = 0.5; [0, b..2]` and
  even `median([b, 2])` forced `b` to integer steps. Only an index and a bin
  count do that now — a range bound does not, since `[1..3.5]` is legal and
  in `[0, b..2]` the bound IS the step.
- Smaller: a filtered table recounts gaps in its text columns; the notice is
  a live region (it is the only feedback a drop gets, and it disappears); the
  file-delete button has a name beyond `✕`; and the MCP preview no longer
  reports "no plot rows to draw" for a graph whose every plot row reads a
  local file, which contradicted its own `preview_omits`.

### Fifth pass

- **`d/dx` over a list answered 0.** Derivatives expand at resolve time,
  before list.ts substitutes, so `L = [sin(t), t^2]` then `d/dt L`
  differentiated `L` as an opaque name and quietly became zero. `ResolveOpts`
  carries an `isList` predicate now and the expansion refuses, naming the
  list. (Elementwise differentiation would mean reordering the pipeline; the
  wrong answer was the thing worth removing.)
- **`durable` was reported before the transaction committed**, and the blob
  write was never observed at all — so an abort after the metadata `put`
  succeeded would still have claimed the file was saved. `withStores` waits
  for `oncomplete`.
- **`""` is a record, not a blank line.** `parseCsv('v\n""\n1\n')` reported
  one row and lost a missing value; RFC CSV distinguishes an empty physical
  line from a record holding an empty quoted field.
- **A missing scalar keeps its provenance too.** Last round's `list` flag
  gated the error as well as the parsing, so `avg = mean(person.age)` then
  `avg + 1` said "unknown variable". The flag decides how a name parses;
  every recorded name reports its file.
- **`hist(L, 2.5)` is refused rather than rounded to 3** — an index in the
  same position already refuses a fraction.
- **The 100 000 budget was half that in practice.** `expand` charged for the
  elements and the consumer charged again for the result, so `col t` failed
  at 50 001 rows. Expansion is free now (it is separately bounded), so one
  mapped operation reaches the documented number; llms.txt says plainly that
  each further operation spends its length again.
- The phase-2 notes claimed pasting CSV text was an ingest path, three
  paragraphs after recording that it was dropped.

### Sixth pass

Two findings, both about the same thing from opposite ends: **this phase gave
the grammar strings, and `statements.ts` had written down, in advance, what
that would break.**

> the grammar has no strings, comments, or other tokens that can contain
> bracket or separator characters. If such tokens are ever added, rebuild this
> on the tokenizer.

- **A `;` in quoted text destroyed the row on reload.** `t =
  open("sales;2026.csv")` with `y = t.v` came back as *three* rows, split
  mid-name. The link joins rows with `;` and percent-encodes the quotes, so by
  the time `decodePayload` runs there is nothing left to tell an in-row `;`
  from a separator — the ambiguity is unresolvable in the payload, which is
  why llms.txt already promised the invariant ("never put a literal `;` inside
  an equation"). The fix keeps the promise instead of weakening the codec:
  `rowSafeFileName` strips `;` at ingest, `TABLE_RE` excludes it from a file
  name, and `createLeaf` refuses it in any text literal. Copilot reported this
  only as an MCP-surface nuisance (`create_graph` rejects rows containing
  `;`); the link corruption underneath it was the real finding.
- **Brackets inside text skewed the editor's split.** `open("a(b.csv");y = 2
  x` merged into one row, because the `(` in the name left the scan at depth
  one and the separator never fired. `splitStatements` now tracks
  double-quoted text — the rebuild the file asked for. A newline always ends a
  string, so a half-typed `y = "` cannot swallow the rows below it; single
  quotes are deliberately left alone, since `f'(x)` is prime notation.
- **"The graph itself is fine" was told to documents that had no graph.**
  `dataOmits` collects every data-local row, definitions included, so
  `person = open(…)` plus `ages = person.age / 2` and nothing that draws
  reported "every plot row reads a data file on the author's device" — sending
  the caller away satisfied with a document that plots nothing anywhere. The
  reassurance is now earned by a data-local row that would have *drawn*
  something. Worth noting that neither branch of this message had a test; both
  do now.

One thing the fix does not do: a `;` typed into text is refused with an error,
but the row is still written to the URL verbatim (as every unparseable row
is), so reloading that link still splits it. Prevention lives at ingest, where
the app controls the name; for a hand-typed one the guarantee is only that you
are told immediately, while the text is still on screen.

### Seventh pass

- **Single-quoted text was still invisible to the splitter.** Last round
  tracked `"` and left `'` alone on the grounds that `f'(x)` is prime — but
  `open('a b.csv')` is supported syntax too, so `open('a(b.csv');y = 2 x`
  merged into one row. Both quotes are tracked now, with `'` opening text only
  where a token could start: the tokenizer's own rule, which is what keeps
  `f'(x)` and `a' = -a` whole. Half a fix is its own bug.
- **A row could be valid in a link and broken for its author.**
  `person.age[person.age]` is a slice, refused once the bytes are here — but
  on a device without them the column threw `MissingDataError` first, so the
  row was reported device-local and `valid: true`. Whether an index is a slice
  is a question about shape, so `isSliceIndex` answers it before anything is
  lowered, exactly as `checkFilterShape` already did for the other half of the
  `[…]` syntax. This is the device-parity invariant the whole phase rests on,
  and it had a hole in it.
- **The filtered definition was the one row in the chain that said nothing.**
  `adults = person[…]` over a missing file registered its null table and
  returned quietly, so the source above it asked for the file and every use
  below it did, while the cut itself showed no error and offered no file
  picker. It now reports what its source reports. (Left deliberately silent in
  the worker, matching the `open()` row it derives from: a table definition is
  not a preview omission on either device.)
- **Consistency now outranks count when sniffing a delimiter.** In
  `notes, with, commas;value` the prose commas outnumber the `;` that
  separates the fields but do not line up, and preferring them threw away
  every data row as ragged — the file parsed to zero rows. Count decides only
  among candidates that are equally (in)consistent.
- **`[.5..2]` did not parse.** The number scan is greedy, so it took the first
  dot of the range operator (`.` `5.` `.` `2`) and the repair that reassembles
  `..` never saw a pair. Leading-dot decimals worked everywhere else, which is
  what made it easy to miss.
- **`count` over a list of points is 3, not an error.** The point guard ran
  ahead of the reduction switch, but counting never looks inside an element.

## Testing

- lib: parser (ranges, indexing, strings, member), broadcasting incl.
  mismatch errors, reduction lowering, CSV edge cases (quotes, CRLF, BOM,
  ragged rows, sniffing), hash stability, cap behavior.
- web: IndexedDB behind a small interface, faked in tests; e2e via browser
  pane with a synthesized DataTransfer drop.
- llms.txt gains a Lists/Data section in each phase (lib/llms-txt.test.ts
  keeps it honest).
