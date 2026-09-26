# Multisets: one rule for lists, families, variables and random variables

Design agreed 2026-09-26. Source: N J Wildberger, *A new look at multisets*
(2003); section numbers below (§4, §5, §6) refer to it.

Decisions locked:

- **A bracket is a multiset**, a multi-value that sits in place in an
  expression. Order is a representation detail, not part of the value.
- **Names are identical, literals are separate** (§1). `L + L` pairs each
  element with itself; `[1,2] + [1,2]` takes every pair.
- **Referencing a multiset unpacks it** into one of its elements, except
  inside `[ … ]` and as the argument of a reduction.
- **No legacy compatibility.** Where this framework and the current syntax
  clash (bracket matrices, below), the framework wins and old links break.
- **Order lives in tuples** (§3). Multisets are strictly unordered.
- **A row that depends on x, y or z is drawn per pixel** (§5): a filter
  keeps pixels, a scalar is a scalar field, a tuple a vector field. Anything
  else is drawn as its values. No implicit graph.
- **Reductions over a filter use the geometric measure** (§5).
- **A continuous interval is `interval(a, b)`** (§5).

## 1. The rule: equal vs identical

Wildberger (§6) separates two things that are **equal** (the same objects,
but separate elements) from two that are **identical** (the very same
elements). That is the whole combination rule:

> A row is evaluated once for every combination of choices from its
> *separate* multisets. Identical multisets are chosen together.

Every list literal is its own multiset, so two literals are separate. Every
mention of one name is identical, so a name is chosen once per row.

| Row | Value | Why |
|---|---|---|
| `[1,2] + [3,4]` | `[4 5 5 6]` | separate: all 4 pairs (Wildberger's direct product, then `+`) |
| `[1,2] * [0,1]` | `[0 1 0 2]` | separate |
| `[1,2] * 3`, `[1,2] + 1` | `[3 6]`, `[2 3]` | `3 == [3]`: a one-element multiset changes nothing |
| `L = [1,2]`; `L + L` | `[2 4]` | identical: `[1+1, 2+2]` |
| `f(x) = x*x`; `f([1,2])` | `[1 4]` | the argument is one multiset, used twice inside `f` |
| `2 + 0[1..3]` | `[2 2 2]` | Wildberger's `3[2]`, from the product |
| `[1,2] + []` | `[]` | `A × [] = []` |

Here `==` means "replacing one with the other in a document draws the same
thing". It holds when a **literal** is replaced by its value. It does not hold
when a name is replaced by the text of its definition: `L + L` is not
`[1,2] + [1,2]`.

Functions are Wildberger's map (§5), `f(A) = [f(a) | a ∈ A]`, which keeps
multiplicities: `|f(A)| = |A|`. A function of several arguments,
`f(A, B)`, is applied to each combination the rule above gives. So every
operation is defined once, on single values, and works on multisets for free.

## 2. Brackets are sums

Inside `[ … ]`, items are **not** unpacked. A bracket is Wildberger's sum (§4),
which adds multiplicities:

```
[A, B, c] = A + B + [c]      (Wildberger's +, not ours)
```

So nesting flattens:

```
n = [1,2]
a = [n, 3, 5]        # a = [1 2 3 5]
y = sin(a x)         # four curves
```

If `n` were unpacked inside the bracket, `a` would instead be two multisets,
`[1 3 5]` and `[2 3 5]`, and the row would draw six curves with 3 and 5
twice.

Identity through brackets:

- **Several items make a new multiset.** `a = [n, 3, 5]` is *equal* to
  `n + [3 5]` but not *identical* to `n`, so `n + a` has 2 × 4 = 8 values.
  (The alternative, where `a`'s copy of `n` stays tied to `n`, is coherent but
  not a product; not pursued.)
- **One item is that item unchanged.** `[n] ≡ n`, so `[n] + [n]` has the same
  2 values as `n + n`, and `1 == [1]` holds for names as well as numbers.

Our `+` is not Wildberger's `+`. His adds multiplicities (the bracket above);
ours is his direct product followed by addition of the elements.

## 3. Where the whole multiset is used

Two places see a multiset as a whole rather than one element at a time:

1. items of a bracket (§2);
2. reductions: `count`, `total`, `mean`, `min`, `max`, `stdev`, `median`,
   `hist`, `hull`. All of them ignore order and count duplicates, so they
   respect `==`. `count([1,2] + [10,20,30]) = 6` is `|A × B| = |A| |B|`.

### Order lives in tuples

Wildberger's lists (commas, ordered) are our tuples, so anything that needs
order takes a tuple:

- `polyline`, `segment` chains and indexing `T[k]` (1-based) take tuples
  only. On a multiset they are errors that point at `sort`.
- `sort(L)` and `sort(P, key)` are the bridge from a multiset to a tuple. The
  key is an expression in the same multiset, so it is identical to it:
  `polyline(sort(P, P.x))` draws a time series in x order.
- A tuple of points is a rank-2 tensor, which is also a matrix. The consumer
  decides the reading: `polyline(T)` walks the rows as points; `T Q` uses it
  as a matrix.

A table fits without a special case: `person` is a multiset of records, and
`person.age`, `person.height` both refer to the one `person`, so they are
identical and line up record by record. File order is not part of the
multiset. Every record gets a `row` property, its 1-based position in the
file, so `polyline(sort(P, person.row))` draws a series in file order. (A file
column already named `row` wins; the position is then `row_index`.)

## 4. Vectors, matrices, tensors

The multiset layer is independent of value type. Every expression is a
multiset of values of **one** type: scalar, vector, matrix, or rank-k tensor.
Operations are defined on single values and extend by §1.

Constructors follow Wildberger's convention that commas and order mean a
list, which in our syntax is a tuple `( )`. Brackets mean copies; tuples mean
coordinates.

| Type | Constructor | A multiset of them |
|---|---|---|
| vector | `(1,0,0)`, `e_x`, `e_y`, `e_z` | `([0,1],0,0) == [0,1] e_x` is two vectors; `[e_x, e_z]` is two vectors |
| matrix | tuple of rows: `((a,0),(0,1))` | with `a = [1,2]`, two matrices; every row using `M` doubles |
| rank-k tensor | k-deep nested tuples; the shape is part of the type | the same |

With `a = [1,2]`, `M = ((a,0),(0,1))`, `P = (1,1)`:

- `M P` is 2 points;
- `M M P` is 2 points, not 4, because the two `M`s are identical;
- `det(M)` is `[1 2]`.

Tensor operations act on coordinates, not multiplicities:

- outer product, `(A ⊗ B)_ij = A_i B_j`. This is the same formula as
  Wildberger's `m_{A×B}([a,b]) = m_A(a) m_B(b)` (§4), one level down;
- contraction. Matrix multiplication is `(MN)_ik = Σ_j M_ij N_jk`;
- wedge, `a ∧ b = a ⊗ b − b ⊗ a`, a new value type (a bivector; its 3D dual
  is the cross product). Its negative coefficients are Wildberger's integral
  multisets (§5), so antisymmetry fits the framework.

**Do not adopt Wildberger's linear notation for vectors.** In his notation
`3[e_x] + 2[e_y]` is a multiset whose multiplicities act as coefficients. In
ours `[e_x, e_x]` is two copies of one point, not `2 e_x`.

**Syntax clash.** Today a named square `[(1,2),(3,4)]` is a matrix. Under this
framework it is a multiset of two points, and the matrix is
`((1,2),(3,4))`. The bracket form stops being a matrix; no legacy reading is
kept.

## 5. Infinite multisets

`x`, `y`, `z`, `u`, `v` are continuous multisets: all reals, or the parameter
interval. The rule in §1 does not change.

- Every mention of `x` is identical, so `x^2 + x` is `[a² + a | a ∈ x]`, the
  `L + L` rule.
- `x` and `y` are separate, so together they are the plane, `x × y`.
- **An equation filters.** `y = x^2` keeps the pairs `(a, b)` of `x × y` with
  `b = a²`: the infinite version of `L[L > 2]`. An inequality is the same
  filter and leaves a region.
- **A tuple over one identical variable traces a graph.** `(u, u^2)` is the
  parabola as a multiset of points.
- Finite and infinite combine: `a = [1,2]`, `y = sin(a x)` is the plane's
  filter crossed with `a`, which is two curves.

### What a row draws

`x`, `y` and `z` are the **screen's own multisets**: the plane is `x × y`
(space is `x × y × z`), and each pixel is one choice. So there are two ways a
row is drawn, decided by its type and whether it depends on those choices:

- **It depends on `x`, `y` or `z`: it is drawn per pixel**, at the choice it
  came from. A comparison (a filter) keeps or drops the pixel; a scalar is a
  scalar field; a tuple is a vector field.
- **Otherwise it is drawn as its values.** A point is drawn at its position;
  numbers are drawn on the number line. There is no implicit graph.

| Row | Depends on x, y? | Value | Drawn as |
|---|---|---|---|
| `y = x^2` | yes | a filter | the parabola |
| `x^2 + y^2 < 1` | yes | a filter | the disc |
| `sin(x y)` | yes | a scalar | a scalar field |
| `sin(x)`, `x` | yes | a scalar | a scalar field, constant along y |
| `(y, -x)`, `(x, x^2)` | yes | a tuple | a vector field |
| `(u, u^2)` | no | points | the parabola |
| `(1,2)`, `[0,1] e_x` | no | points | dots |
| `[1,2,3]`, `[1,2] + [1,2]` | no | numbers | a dot plot on the number line, duplicates stacked (no bars by index: an index is an order) |
| `X ~ Normal(0,1)` | no | numbers with a probability density | its density curve (as today) |
| `u^2` | no | numbers in `[0, 1]`, density `1/(2√b)` | its density curve |
| `u` | no | numbers in `[0, 1]`, density 1 | the line at height 1 over `[0, 1]` |
| `2 + 2` | no | one number | a readout |

This removes "a bare scalar in x means `y = expr`": `sin(x)` is a field, and
the graph is `y = sin(x)`. A bare scalar in `x, y, z` is a field in space,
which needs a volume renderer; until there is one it is an error that points
at `f = 0`.

A number-line picture follows the logic even where it looks odd (`u` is a
flat line); the rule is kept to see how it turns out.

The dimension of a result is the number of separate continuous multisets
minus the number of filters. That is invariant 1 of
[math-objects.md](math-objects.md), derived rather than stated.

The renderer already works this way: a shader evaluates the expression once
per pixel, which goes through every element of `x × y` at pixel resolution.
This section reframes the app; it does not replace it.

`t` is not a multiset. It is one value that changes with time.

### Random variables are infinite multisets already

`X ~ Normal(0,1)` is an infinite multiset whose multiplicity is a probability
density, and the distribution code already follows §1:

- `X + X` is `2X` (identical, one choice);
- `X + Y` for independent variables takes every combination (convolution);
- `P(X < b)` and `E(X)` are reductions.

`x` is the same kind of object with length (Lebesgue) measure instead of
probability.

### Multiplicity becomes measure

Wildberger does not define infinite multisets (§5 warns that subtraction does
not extend to them). The standard extension is measures: multiplicity becomes
a density, and pushing a density through a function is well defined.

- `x^2` holds each positive value **twice**, once from each of `±√b`, with
  density `1/(2√b)` per copy.
- Reductions become integrals: `total(f(x))` is `∫ f`, `count` is length,
  `mean` is the average. List reductions and `int[a..b] … dx` rows are the
  same operation.
- Signed measures carry wedge's negatives, as integral multisets do for finite
  ones.

**A filter has the geometric measure of its dimension:** area for a region,
arc length for a curve, surface area for a surface, counting for points. So
`count` of a solved point set is its number of roots, and `total` over a curve
is a line integral. The measure depends only on the set: `y = x^2` and
`2y = 2x^2` agree. The alternative, integrating against `δ(g)` (the literal
limit of filtering), was rejected because it does not: those two spellings
give measures a factor of 2 apart.

### Continuous intervals

`[1..2]` already means the integers 1 and 2. A continuous interval is
`interval(1, 2)`. (`[1 ... 2]` was rejected: Desmos's `[1...5]` means
integers, and one dot is easy to miss.)

- `r = interval(1, 2)`; `(r cos(2πu), r sin(2πu))` is a filled annulus,
  drawn by sampling `r` and `u` directly;
- `a = interval(1, 2)`; `y = sin(a x)` is the region
  `{(x,y) : some a ∈ [1,2] has y = sin(a x)}`. Drawing it means removing `a`
  per pixel, which is a solve, not a draw call per element.

## 6. Current state vs target

Checked 2026-09-26 against `lowerLists` (lib/list.ts) and the MCP validator.

| Row | Today | Target |
|---|---|---|
| `[1,2] + [3,4]`, `[1,2] * [0,1]` | every pair | same |
| `L + L` with `L = [1,2]` | `[2 4]` | same |
| `f([1,2])` with `f(x) = x*x` | `[1 4]` | same |
| `a = [1,2]`; `y = sin(a x)` | family of 2 curves | same |
| `A = (1,0,0)`; `[0,1] A`, `[A, B]`, `[0,1]A + [0,1]B` | point list | same |
| `([0,1],[0,1],[0,1])` | 8 cube corners | same |
| `a = [1,2]`; `M = [(a,0),(0,1)]`; `M P` | 2 points (multiset of points, phase 2) | 2 points (multiset of points, not a matrix) |
| `M = ((a,0),(0,1))` | a matrix (phase 2) | a matrix |
| `b = [n, 3, 5]` | bracket sum (phase 1) | bracket sum |
| `[1,2] + []` | `[]` (phase 1) | `[]` |
| point lists in a 3D scene | drawn as dots (phase 3: the app already did; the link preview and MCP validator now do too) | drawn |
| `e_x`, `e_y`, `e_z` | built in (phase 3) | built in |
| `sort(L)` | a tuple: `sort([3,1,2])` is the point (1, 2, 3) (phase 4) | a tuple |
| `sort(P, P.x)`, `sort((s, sin(s)), s)` | a tuple, ordered by the key (phase 4) | same |
| `polyline(P)`, `polygon(P)`, `L[2]` over a list `[ … ]` | an error that points at `sort` (phase 4) | error |
| `polyline(((0,0),(1,1),(2,0)))`, `T[2]` of a tuple | walked / indexed in order (phase 4) | same |
| `person.row` | each record's position in the file (phase 4) | same |
| `e_x ⊗ e_y`, `a ∧ b`, `contract(T, 1, 2)` | outer product, bivector, contraction; a tensor alone on a row reads out (phase 6) | same |
| `(((1,2),(3,4)),((5,6),(7,8)))`, `((1,2,3,4),(5,6,7,8))` | a 2×2×2 and a 2×4 tensor (phase 6) | same |
| `r = interval(1, 2)`; `(r cos(2πu), r sin(2πu))` | a filled annulus (phase 7) | same |
| `(u cos(2πv), u sin(2πv))` | a filled disc (phase 7; was an error) | same |
| `a = interval(1, 2)`; `y = sin(a x)` | the region the family sweeps, searched along a per pixel (phase 7) | same |
| `interval(0, 10)` | its density against length: height 1 over [0, 10] (phase 7) | same |
| `total(u^2)`, `count(interval(1, 3))`, `total(exp(-x^2))` | 1/3, 2, √π: integrals against length (phase 8) | same |
| `count(x^2 + y^2 < 1)`, `count(x^2 + y^2 = 1)`, `count(x^2 = 2)` | π, 2π, 2: area, length, points (phase 8) | same |
| `mean({y = x^2, 0 < x < 1: y})` | the mean over the arc by length; `2y = 2x^2` agrees (phase 8) | same |
| volume or surface area (`count(x^2 + y^2 + z^2 < 1)`) | error (phase 8 cut) | the measure |

[lists-tables-plan.md](lists-tables-plan.md) still says lists of different
lengths are an error; they have taken every combination since the axis model
landed.

## 7. Phases

1. **Bracket sums.** Nested brackets flatten (§2); `[]` is the empty multiset;
   a one-item bracket keeps identity.
2. **Tuple matrices.** `((a,b),(c,d))` and the 3×3 form become matrices;
   `[(…),(…)]` becomes a multiset of points everywhere, named or not.
   Update llms.txt, syntax help and every example that spells a matrix with
   brackets.
3. **Vectors in 3D.** Built-in `e_x`, `e_y`, `e_z`; draw point lists in a 3D
   scene.
4. **Order.** `sort` returns a tuple; `polyline`, `segment` chains and
   `T[k]` take tuples only; tables drop file order and gain `row`.
5. **Display.** Remove the implicit graph (`sin(x)` becomes a field, not a
   curve); draw non-positional numbers on the number line (dot plots, density
   curves). Rewrite every example, landing page and llms.txt graph that
   relies on a bare row in x.
6. **Tensors.** Rank-k tuples as a value type; `⊗`, contraction, `∧`.
7. **Continuous intervals.** `interval(a, b)`, parametric sampling, then the
   per-pixel projection for continuous families.
8. **Measures.** Reductions over filters with the geometric measure.

## 8. Open questions

None open. Settled 2026-09-26:

- fields: a row that depends on x, y or z is drawn per pixel (§5);
- file order: every record has a `row` property (§3);
- the number line: follow the logic and review it once built (§5).

## 9. Assumptions made while implementing

The decisions above are agreed. The points below are **not**: they are
choices made during implementation (2026-09-26) where the design is silent,
recorded so they can be reviewed and reversed. Progress notes live in
[multisets-progress.md](multisets-progress.md).

- **Empty multiset reductions.** `count([])` and `total([])` are 0 (a sum over
  nothing); `mean`, `min`, `max`, `median`, `stdev` of `[]` are errors, since
  there is no value to pick. `sort([])` is `[]`.
- **Flattening a column.** `[person.age, 3]` flattens the column's values like
  any other multiset; the result is a new multiset, so it no longer lines up
  with `person`.
- **A tuple argument to a matrix function is one matrix.** `det`, `trace`,
  `solve` and `exp` no longer spread a tuple literal into separate
  arguments, so `det(((a, b), (c, d)))` is the determinant of one matrix.
  (`solve(M, 1, 0)` still reads its right-hand side from loose scalars.)
- **A tuple of points that is not a square matrix is a tuple of points**
  (phase 4; phase 2 made it an error). `((1, 2), (3, 4), (5, 6))` and two 3D
  points are walked by `polyline`/`polygon`, indexed by `T[k]`, and drawn as
  dots on a row of their own. A square one is also a matrix, and alone on a
  row reads out as one since phase 6 (a pair of named 2D points still names
  `segment(A, B)`).
- **Nested brackets are never a matrix.** `[[1, 2], [3, 4]]` is the multiset
  `[1 2 3 4]` (phase 1 flattening), not the old nested-list matrix spelling.
- **Unit vectors are 3D.** `e_x`, `e_y`, `e_z` are always `(1,0,0)`, `(0,1,0)`,
  `(0,0,1)`, so any row using one is a 3D scene, even `[0,1] e_x` alone. The
  alternative, 2-component `e_x`, `e_y` while nothing else in the document is
  3D, would make a row's value depend on the other rows; not pursued. In 2D,
  write `(1,0)`.
- **A document's own `e_x` wins.** Unlike `e` and `pi`, which may not be
  redefined, `e_x = 3` (or a list, function or random variable of that name)
  replaces the built-in for the whole document, so graphs that already used
  the name keep their meaning. `e_1`, `e_n` and a sequence `e` are untouched.
- **Tuples are an `ordered` axis** (phase 4). A tuple is stored like any list
  (`list`, `data`, `lazy`), with its positions as one axis marked `ordered`;
  anything built from it carries the mark. Every tuple axis in one
  combination is the same axis of positions (tuples never cross), and it is
  stored innermost, so a multiset of tuples is tuple by tuple. So sorting a
  column stays a typed array, and `sort(template, key)` permutes the packed
  columns of one template.
- **A tuple of 2 or 3 numbers is a point, on its own row too.** `sort([3,1,2])`
  draws the point (1, 2, 3), which makes the scene 3D. A longer tuple of
  numbers has no picture: its row reads out `= (1, 2, 3, 5, 8)` (a new
  `tuple` row kind) and draws nothing. A multiset of short tuples is a
  multiset of points; of longer ones, an error.
- **Tuple literals may be any length.** `(1, 2, 3, 5, 8)` is a tuple of five
  numbers (it was a parse error). A tuple of tuples is a tensor (phase 6).
- **`sort(P, key)` details.** The key has to run over P's instances or
  some of them (`sort(L + M, L)`: each element takes the key of the L it
  came from, ties in order), a number per element, and constant (sliders yes, t no). The
  sort is stable, and an element whose key is missing is left out, as
  `sort(L)` leaves gaps out. `sort(P)` of points, with no key, is an error
  that suggests `sort(P, P.x)`. `P_x` is not a key spelling: it is already
  a subscripted name (a named point's component); `P.x` is.
- **Indexing details.** A slice `T[2..4]` is a tuple; a list of indices,
  `T[N]`, runs over N (a multiset) as before; a filter keeps a tuple's order.
  On a multiset of tuples, `T[k]` is position k of each. Besides a name, a
  `sort(…)` call indexes, `sort(L)[2]`, and so does a list literal written
  right against its brackets, `[3, 1, 2][2]`, which is the needs-order
  error (with a space, `[1, 2] [3]`, it still multiplies). Other calls and
  parenthesised expressions still multiply.
- **A matrix's rows are a tuple.** `M[2]` is its second row and `polyline(M)`
  walks the rows, so `g(M)` for `g(x, y) = x y` and a 2×2 M is a tuple of
  2 numbers — a point — where `g([(1,2),(3,4)])` is a multiset of 2 numbers.
- **State families are numbered only when they start from a tuple.**
  `p(0) = (sort([0..99])/10, 1, 20)` makes `p[1]` the first run; from a list
  `[0..99]/10` the runs are a multiset, and `p[1]` is an error that says so.
- **`row` is a position among the parsed records.** 1 is the first record
  after the header; records skipped as ragged do not count. A filtered table
  (`adults = person[…]`) keeps the positions its rows had. Indexing a column
  (`person.age[2]`) is refused by its shape, so a device without the file
  says the same; a named list derived from an absent file cannot be judged
  that way and still reports the file.
- **Point lists draw in the link preview too.** §6 said point lists in a 3D
  scene were not drawn; the app did draw them, but the static preview did
  not, and the MCP validator told assistants the app skipped them. Both now
  draw them as dots, in the plane and in space.
- **Scalar field shading is signed.** A field is shaded in the row color
  where it is positive and in the color's complement where negative, with
  opacity `0.55·|tanh(0.6 v)|` (the static preview already did this), so
  `x` and `sin(x)` read on both sides of 0. A field in x alone (or y alone)
  reads out "scalar field — for the curve write y = …" under the row.
- **u and v alone are Uniform(0, 1) draws, also next to random variables.**
  `X + u` is the density of X plus an independent uniform. A row the random
  variable engine cannot take (`u + L` for a list `L`, `u < 0.5`) keeps the
  classifier's error, which says u and v trace curves in a tuple.
- **A matrix or tensor alone on a row reads out** (phase 6), as nested tuples:
  `2 M` is `= ((2, 4), (6, 8))`, where it used to be an error, and a
  multiset of them lists each, `= [((1, 0), (0, 1)), ((2, 0), (0, 1))]`.
  Three readings of the old rules are kept: a tuple of 2D or 3D points that
  is not square is still drawn as dots, and so is any tensor of that shape
  however it was made (`(1,2) ⊗ (3,4,5)` draws what
  `((3,4,5),(6,8,10))` draws, so `==` holds); a pair of named points `(A, B)` still
  says it is not a figure (it was most likely meant as the segment); and in
  x, y or z a matrix is an error, not a field of matrices.
- **The wedge is the graded one.** On vectors it is `a ⊗ b − b ⊗ a`; in
  general `(p+q)!/(p! q!) Alt(A ⊗ B)`, so `(a ∧ b) ∧ c = a ∧ (b ∧ c)` is the
  volume element, and a scalar wedges as multiplication (`2 ∧ 3 = 6`,
  `x ∧ y` is the field x y). A bivector is stored as its antisymmetric
  rank-2 tensor, with no tag of its own: it is also a matrix, so
  `(a ∧ b) v = a (b·v) − b (a·v)`, `det` and `e^(th B)` apply. In 3D its
  dual is `a × b`, which stays the vector it was.
- **Contraction is `contract(T, i, j)`**, indices 1-based and written as
  numbers (a slider would change the result's shape). It names which two
  indices meet, which is all Einstein notation says, without index syntax
  the parser does not have; with ⊗ it gives every other contraction.
  Juxtaposition contracts the last index of the left with the first of the
  right (matvec, `M N`, `T v`, `(1, 1) T`), except that a vector on the left
  of a square matrix stays the error it was (`M v` is the one order).
- **A tuple of points is a matrix to a product on its right.** `A (1, 1, 1)`
  and `A B` for 2×3 and 3×2 tuples of points multiply as matrices (the
  consumer decides, §3). `2 T` still scales the points, and `M T` still
  moves each point of T.
- **`T[k]` of a named tensor is its k-th slice** along the first index.
  `T[2][1]` is `T[2]` times the one-element multiset `[1]`, since only a name
  indexes; name the slice first.
- **Cut from phase 6.** A bracket of tensors (`[M, N]`) is an error rather
  than a multiset of matrices; a multiset of tensors cannot be named when it
  comes from a list of vectors (`B = p ∧ e_z` with `p = [e_x, e_y]`; unnamed,
  the row expands element by element and works, and a list in an entry,
  `M = ((a, 0), (0, 1))`, can always be named); a tuple is read as a tensor
  when it is written out or named (`L = sort(K)`, then `L ⊗ L`), while
  `sort(K) ⊗ v` unnamed is expanded element by element (the same values,
  but it cannot be named); a tensor has at most 729 entries; no transpose,
  symmetrisation or Hodge star beyond `×`.
- **An interval's density is drawn against length.** A row of intervals
  alone draws its pushforward of length measure, not a probability:
  `interval(0, 10)` is height 1, the density times the product of the
  intervals' lengths (`r + r` for `r = interval(0, 2)` is 1/2 over [0, 4]).
  Readouts (μ, σ) stay those of the uniform draw.
- **Intervals take the free parameter slots.** Without x, y or z, each
  interval becomes u or v, whichever the row leaves free, swept over [0, 1]
  as `lo + (hi − lo) u`; with u and v both used, one more is an error. Two
  parameters and two components fill a region, so `(u, v)` and the disc
  `(u cos(2πv), u sin(2πv))`, errors before, are filled regions. It is drawn
  without an outline, at the inequality fill's opacity; in a 3D scene it lies
  in z = 0.
- **A definition built from an interval is that interval.** `s = 2 r` is
  written into rows as r's own parameter, so `(r, s)` is a curve. A function
  parameter named r shadows it. A literal in a function body is written once,
  so every call shares it, as a list literal in a body does.
- **A swept region is a union over one interval.** Beside x and y, the row
  keeps a pixel when some value of its one interval satisfies the relation;
  for a chain, one value must satisfy every comparison. Two intervals, z, a
  bare field (`sin(a x)`) or a vector field are errors. (How the shader and
  preview search the interval is in the bullet on sign changes below.)
- **An interval is not a list item.** `[interval(0, 1), 2]` is an error for
  now: a bracket of an interval and a number is a mixed measure, which has no
  picture yet. A state, sequence or other place that needs one number reports
  that an interval is a range of numbers.
- **A multiset of tuples draws one figure per element.** `polyline(T)`,
  `polygon(T)` and `hull(T)` walk T's tuple axis; each other axis (a list
  inside T, `polyline(sort(P, P.x) + (a, 0))`, a named `M = ((a, 0), (0, 1))`)
  is a family, as the tuple written out is, up to 1024 figures.
- **A figure moves a square tuple of points point by point.** In
  `polygon(T + (0, 0, 1))`, `polyline(2 T)`, `polygon(R T)` and
  `polygon(rotate(T, a))`, a named square T is read as its rows (the
  consumer decides, §3), so each point moves; a matrix on the left of a
  product stays the matrix. On a row of its own `T + (1, 0)` is still an
  error (a matrix and a point do not add), `2 T` and `R T` matrix algebra.
- **A multiset of matrices pairs with points built from it.** With
  `M = ((a, 0), (0, 1))` and `Q = M (1, 1)`, `M Q` and `R = M Q` choose M
  once per element of a, so they are 2 points (M M (1, 1)). A definition
  that uses a named list of points is never a matrix.
- **A filter may keep nothing.** `L[L > 5]` is `[]`, so `count` of it is 0
  and the other reductions say the list is empty.
- **count, total and mean take computed point lists.** `count(2 P)`,
  `count([0,1] e_x)`; `total` and `mean` of points are taken coordinate by
  coordinate (a point). `min`, `max`, `median`, `stdev` of points stay errors.
- **A long tuple's readout is cut.** Past 8 values it shows the first 8 and
  `…`, like a list's; a sorted column stays a typed array however long.
- **A function parameter shadows e_x, e_y, e_z**, as it shadows a named
  interval: `f(e_x) = e_x^2` squares its argument. So does an open Σ index.
- **Every number list stacks by dot width, not only CSV columns.** A list
  whose distinct values lie closer than a dot at the current zoom (`sin(L)`
  for `L = [1..300]`, `[1..2000]/1000`) gathers into columns one dot wide
  (8 CSS px as outlined points; 3 px past 400 values, drawn as a cloud) and
  stacks there; a list whose values are all a dot apart stacks exact copies
  only (`[1,2,2,3,3,3]`). Unit spacing is kept, so a stack's height in
  pixels is the same at every zoom and a long list stands taller than the
  screen: its outline shows only with a stretched y axis (`view(…, ratio)`).
- **A swept region's edge is at most a pixel wide.** The app keeps a pixel
  on a sign change of F between steps of the interval, and only searches
  finer (8 sub-steps) where ∂F/∂a says a member could cross between two; a
  near miss is feathered by its distance on screen, |F|/|∇F|, never by a step
  in a. The link preview steps 64 values on 8-px blocks and judges only edge
  blocks per pixel. A member narrower than a pixel that grazes between
  steps can still be missed at the tangent edge of a band.
- **A list in a reduction keeps the list meaning** (phase 8). A reduction
  integrates over the continuous multisets in its argument (x, y, z, u, v,
  intervals) only when the argument holds no finite multiset. With
  `L = [1, 2, 3]`, `y = total(L x)` stays the line y = 6x — the sum over L
  at each x — as graphs have always used it; the strict reading (a total over
  L × x) would make every polynomial written with `total` diverge. A
  function's parameters are never integrated: in `f(x) = count(…)`, x is the
  argument.
- **`{c1, c2: f}` in a reduction is a conjunction.** As a reduction's
  argument, conditions written before the last one without values restrict
  together: f where c1 and c2 hold. Elsewhere `{c1, c2: f}` keeps Desmos's
  reading (1 where c1 holds, else f where c2 does); the parser marks bare
  conditions so the two can be told apart. Only there may a condition be an
  equation (`{y = x^2, 0 < x < 1: y}`); elsewhere `y = x^2` as a condition is
  an error that points at reductions. A lone filter reduces with value 1:
  `total(x^2 + y^2 < 1)` is the area. A comparison as the value
  (`{A: x > 0}`) is an error.
- **How a set is measured** (phase 8). A comparison of one variable with a
  constant (`0 < x < 1`, `u < a`) narrows that variable's range. What is left
  decides the route. Nothing left, or one equation `y = g(x)` over a bounded
  range of the other variable: symbolic integrals through the ∫ machinery
  (arc length ∫ f √(1 + g'²) for the graph), so sliders stay symbolic and the
  row is live. Anything else (a region or implicit curve in one or two
  variables, roots) is numeric: the set is first proved bounded by interval
  arithmetic on the far strips (R = 2⁻⁸ … 2²⁰), then measured on a quadtree of
  depth 12 over that box (cells proved in count whole, proved out drop,
  boundary cells by marching squares — corner values for a single open
  comparison, an 8×8 sample for several). A cell budget (100k) steps the
  depth down to 8 before giving up. Its sliders are read when the row
  resolves, like Σ bounds: moving one re-resolves the row (no runtime-slider
  fast path), and t is an error. Results are memoized per set and values.
- **Unbounded sets.** A far strip proved inside the set (`x > 0`) makes the
  count ∞. When neither boundedness nor a strip is proved (`y > x^2`,
  `y = sin(x)`), the set is measured in the squares of half-size 1024 and
  2048: growth by more than 1.5× reads as ∞, otherwise the row is an error
  (unbounded but thin sets, like `|y| < exp(-x^2)`, are not measured). This
  is a heuristic, not a proof. Over x alone, `total`/`mean` need ∫|f| to
  converge (a Lebesgue integral), so `total(x)` is an error rather than 0 by
  symmetry; `mean` over any infinite measure is an error, `count` is ∞, and
  two unbounded variables with no filter (`total(x y)`) are an error.
- **Counting points.** A polynomial in one variable counts its distinct real
  roots exactly (`count(x^2 = 0)` = 1). Otherwise the roots are sought in the
  proved box: in one variable by dense sampling and refinement
  (lib/roots.ts; not certified, so a root narrower than the sampling can be
  missed), in two by Krawczyk-certified subdivision, where an incomplete
  search is an error rather than a short count (so systems beyond +, −, ×, ÷
  and whole powers, which the certificate cannot enclose, are errors). An
  unbounded set of roots (`sin(x) = 0`) is an error that suggests a range.
  A curve with no sign change (`(x^2 + y^2 - 1)^2 = 0`) measures 0, as
  marching squares sees no crossing. For points, `<` and `≤` differ.
- **min and max** of a continuous set search a dense grid (4097 points in 1D,
  257² in 2D) and refine by pattern search; over points they read the
  roots' values. Over a region or curve they are errors for now, as are
  `stdev`, `median` and `hist` of any continuous set (cut), and volumes and
  surface areas in space (cut).
- **A parametric set carries its parameter's measure.** `count((u, u^2))` is
  1, the length of u's range, not the parabola's arc length; `total` and
  `mean` of a tuple act componentwise (`mean((u, u^2))` is the point
  (1/2, 1/3)).
