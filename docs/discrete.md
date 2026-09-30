# Discrete math: lattice panels, tables, automata and graphs

Prototype, 2026-09-27. Each section says whether it is **built** (in this
branch, with tests and examples) or a **sketch** (syntax proposed, not built).

The plane is continuous: x and y are reals, the grid has decimal ticks, and
an integer thing (a sequence, an automaton) was drawn by placing unit squares
or dots at whole coordinates of that plane. That worked but read wrong: Rule
30 was framed with `view(x = -60..60, y = -80..2)`, its time axis pointed down
the _negative_ y axis, and its axis numbers said `-40`, `-20` where they meant
step 40, step 20.

The proposal: discrete objects get viewports of their own, in two shapes.

| Viewport    | Coordinates                                                   | Draws                                                   | Examples                                                 |
| ----------- | ------------------------------------------------------------- | ------------------------------------------------------- | -------------------------------------------------------- |
| **lattice** | integer cells, named by the rows' own indices (`i`, `j`, `n`) | cells shaded by value; values printed when zoomed in    | Rule 30, Game of Life, Pascal mod m, Cayley tables, gcd  |
| **graph**   | none: positions come from a layout                            | vertices, arrows with labels and counts, marked vertices | Cayley graphs, state machines, matrices as arrows, Collatz |

Both are split-view panels (`---`, lib/panels.ts), so a lattice or a graph
sits beside a continuous plot, or beside each other, over the same
definitions: the D₃ example draws its Cayley table and Cayley graph from one
function `m(i, j)`.

## 1. Lattice panels (built)

A panel is a **lattice** when every row it draws is an automaton or a table,
the way a panel becomes 3D when one of its rows is 3D, or when its view row
names index axes instead of x and y:

```
view(i = -60..60, n = 0..80)
```

- Two indices read as a matrix's do: the first is the row (**down**), the
  second the column (across). `c_{n+1}[i]` is row n, column i; `T[i, j]` and
  `L_n[i, j]` are row i, column j. So row n + 1 sits below row n, and a
  Cayley table reads the way it is printed in a book.
- The view row names the axes in either order (`view(i = …, j = …)` frames a
  table either way round) and panning rewrites it in the order it was written.
- The grid runs between cells: edges at half-integers once cells are 6 device
  px, majors at 1, 2, 5 × 10ᵏ cells, never fractional. Edges are numbered by
  index along the top and left; the axis names (`i → n ↓`) and a board's
  generation sit bottom left.
- Past 18 CSS px per cell every visible cell prints its value (a table's all,
  an automaton's non-zero ones).
- A new lattice panel with no view row opens on its cells: a 1D diagram from
  its first row, a board around its origin, a table fitted to the cells it
  defines near the origin.
- Internally a lattice panel is a 2D panel whose y is minus the row index, so
  panning, zooming, shared axes and view-row writeback are the 2D machinery
  unchanged; the renderer's cells shader gained a row origin and per-axis
  edge behaviour, nothing else.

## 2. Tables: functions on ℤ² (built)

```
n = 6
T[i, j] = {0 <= i < n: {0 <= j < n: mod(i + j, n)}}     # ℤ/n under +
```

Row i, column j holds T's value, shaded from faint (smallest) to solid
(largest). An undefined value (a piecewise with no case) is an empty cell, so
nested cases bound a table. Only the cells in view (at most 512 × 512) are
computed, on the CPU with the compiled VM, so a table may be unbounded:
`T[i, j] = gcd(i, j)`.

Groups: a Cayley table is a table. A non-cyclic group is a table over an
encoding: D₃ as k = a + 3b (rotation rᵃ, then flip sᵇ):

```
rot(k) = mod(k, 3); flip(k) = floor(k/3)
m(i, j) = mod(rot(i) + (-1)^flip(i) rot(j), 3) + 3 mod(flip(i) + flip(j), 2)
T[i, j] = {0 <= i < 6: {0 <= j < 6: m(i, j)}}
```

Row r, column s holds rs = 4; row s, column r holds sr = 5: not abelian, at a
glance. The unit group of ℤ/n is one more case, `{gcd(i, n) = 1: …}`.

**Equality in cases.** Discrete rules need `{s = 3: 1, …}`, which elsewhere
is refused (an equation as a condition is a reduction's filter). In
automaton, table and graph rows, and in the functions they call, a case may
test equality; it becomes `r − ε < l < r + ε`, exact on whole numbers
(lib/automaton.ts exactCase; ResolveOpts.exactConditions).

## 3. Automata (built)

### 1D (moved)

`c_{n+1}[i] = …` is unchanged as syntax and now draws in a lattice panel,
framed `view(i = -60..60, n = 0..80)`. Pascal's triangle mod m is a 1D rule:
`p_{n+1}[k] = mod(p_n[k-1] + p_n[k], m)`, whose cells print their residues
when zoomed in.

### 2D: Game of Life

```
life(c, s) = {s = 3: 1, s = 4: c, 0}          # s counts the cell itself
L_0 = [(0, 1), (1, 2), (2, 0), (2, 1), (2, 2)]  # a glider, (row, column)
L_{n+1}[i, j] = life(L_n[i, j], sum(a=-1..1, sum(b=-1..1, L_n[i+a, j+b])))
```

- A 2D rule reads the previous generation at fixed offsets, row first
  (`L_n[i+1, j]` is the cell below). A Σ/Π whose bounds are numbers unrolls,
  so the neighbourhood is written once.
- The seed is an expression, `L_0[i, j] = …`, or a **multiset of live
  cells**: a configuration is a multiset of cells, a cell's value its
  multiplicity (a cell listed twice is worth 2).
- The rule row draws one generation, 8 per second as t runs, stepping on from
  the last one drawn (and from the seed again when t goes back). The
  generation is read out in the corner.
- The board is cells −256..256 each way. Outside it every cell is the
  background, which steps by the rule applied to itself, as the 1D lattice's
  sides do. Unlike the 1D row the board does not grow, so a pattern reaching
  its edge is cut off there: a glider crashes into it and settles as a block.
  It is exact until then — about 1000 generations for a glider from the
  origin. A growing board (or a sparse set of live cells) is the fix when
  guns and breeders matter.
- Cost: a 40 × 40 random soup is ~5 ms a generation once it spreads
  (neighbourhoods are memoised, and only the box that can change is stepped).

## 4. Graphs (built)

```
n = 12; k = [0..n-1]; g = [1, 4]
graph(k, mod(k + g, n), g)          # Cayley graph of ℤ/12 by 1 and 4, labelled by generator
```

`graph(from, to)` and `graph(from, to, label)` read their arguments as one
tuple, `(from, to, label)`, and each element of its multiset is an arrow. So
the multiset rule (docs/multisets.md §1) does the combinatorics: the two uses
of `k` are chosen together, and `g`, a separate list, crosses them. `graph(P)`
takes a list of pairs as it is.

- Vertices are the numbers the arrows meet, drawn as rings with their value.
- The same arrow listed twice is one arrow with its count (`×2`): a multiset
  of arrows. Labels on one arrow are listed together (`0, 1`).
- An arrow whose reverse is also drawn bends to its own side; a loop hangs
  above its vertex.
- Layout: Fruchterman–Reingold from a circle in vertex order (so a cycle
  stays a circle), with a pull toward the centre so components stay
  together, fitted to a radius growing with √n. Deterministic, and re-run
  from the previous positions when an edit keeps the vertex set.
- A panel of graphs draws no grid unless it has a `grid(…)` row.
- `mark(v)` highlights vertex v in its panel's graphs, and reads out v.

### State machines

A transition function is an ordinary function, and its diagram is its graph
over states × symbols:

```
Q = [0..2]; S = [0, 1]
step(q, s) = mod(2q + s, 3)                  # remainder mod 3 of a binary number
graph(Q, step(Q, S), S)                      # Q and S separate: every transition
digit(k) = mod(floor(13 / 2^(3 - k)), 2)     # 13 = 1101, one digit at a time
run(q, k, m) = {k >= m: q, run(step(q, digit(k)), k + 1, m)}
N = floor(clamp(0, 0, 4))
mark(run(0, 0, N))                           # the state after N digits
```

The run is a tail-recursive function (a bounded loop), so dragging N walks the
marked state through the machine; `run(0, 0, 4)` reads 1 (13 mod 3).

A recurrence would read better, `q_{n+1} = step(q_n, w[n+1])`, but sequences
do not allow that yet: a recurrence may not use n, and its parameters must
be scalars (not the tuple `w`). Lifting both is the natural next step.

### Pushdown automata (sketch)

A PDA is a state machine plus a stack. The stack is a tuple, so it needs
tuple-valued recurrences (`s_{n+1} = push(s_n, a)`), which sequences do not
have. Drawn as a graph panel (the control, with `mark` on the state) beside a
lattice panel of the stack over time — `S[n, h]`, the symbol at height h after
n steps, which is a table, so the drawing is free once tuple recurrences exist.

## 5. Matrices as multisets (built as graphs; readout a sketch)

Wildberger's reading: a matrix A is a multiset of arrows i → j, A_ij of them.
Multiplication is composition: each arrow i → j of A followed by each arrow
j → k of B is an arrow i → k of AB, so (AB)_ik counts the two-step paths.

```
A = [(1, 1), (1, 2), (2, 2), (2, 2)]      # [[1 1] [0 2]] as arrows
B = [(1, 2), (2, 1), (2, 2)]              # [[0 1] [1 1]]
graph(A)
--- right
graph(B)
--- below
c(p, q) = {p.y = q.x: (p.x, q.y)}         # i → j, then j → k, where they meet
AB = c(A, B)                              # [[1 2] [2 2]], counts on the arrows
graph(AB)
```

A and B are separate names, so `c(A, B)` takes every pair; a pair that does
not meet is no member (docs/multisets.md, guards), so AB is a multiset of 7
arrows and `count(AB)` is 7; equal arrows count. `c(A, A)` would pair each
arrow with itself, one name being one choice; A composed with itself, two
independent draws from A, waits for binders (`p ∈ A`, `q ∈ A`,
docs/multisets.md §0). The graph-only spelling `graph({A.y = B.x: A.x}, B.y)`
still works.
Still to do: `matrix(P)` (a multiset of pairs as a matrix readout) and its
inverse, so both readings sit side by side.

## Found along the way

- **List lowering, comparisons mixing two lists.** Over lists, a condition
  whose one side mixes two separate lists loses its comparison:
  `{abs(A.y - B.x) < 0.5: A.x}` or `{A.y - B.x < 0.5: …}` lowers to the bare
  difference. `A.y < B.x` (one list a side) is fine, which is why exactCase
  is written as a chain. Pre-existing (lib/list.ts lowerCond).
- **Inline cases over a list.** `graph(k, {mod(k, 2) = 0: k/2, 3k + 1})`
  (and the same with `<`) gives 800 elements for 40, with broken conditions;
  through a function, `c(m) = {…}; graph(k, c(k))`, it is right. Also in
  list lowering, and not specific to graphs.
- **Function parameters and document lists.** With a list `k` defined, a
  function `run(q, k, m)` sees the list, not its parameter.

## Order of work

1. Lattice panels, tables, 2D automata — built.
2. `graph(…)` rows, graph panels, `mark(…)` — built.
3. Recurrences that read n and tuples (state machine runs as sequences).
4. `matrix(P)` from a multiset of pairs, and pairs from a matrix.
5. Tuple-valued recurrences, then PDAs.
6. A growing 2D board; draggable graph vertices; graphs in the /g/ preview.
