# Discrete math: lattice panels, tables, automata and graphs

Prototype, 2026-09-27. Status per section: **built** (in this branch),
**sketch** (syntax decided here, not built).

The plane is continuous: x and y are reals, the grid has decimal ticks, and
an integer thing (a sequence, an automaton) is drawn by placing unit squares
or dots at whole coordinates of that plane. That works but reads wrong:
Rule 30 was framed with `view(x = -60..60, y = -80..2)`, its time axis
pointed down the *negative* y axis, and its axis numbers said `-40`, `-20`
where they meant step 40, step 20.

The proposal: discrete objects get viewports of their own, with two shapes.

| Viewport | Coordinates | Draws | Examples |
|---|---|---|---|
| **lattice** | integer cells, named by the document's index letters (`i`, `j`, `n`) | cells shaded by value; numbers in the cells when zoomed in | Rule 30, Game of Life, Cayley tables, Pascal mod p, multiplication tables |
| **graph** | none (positions come from a layout) | vertices, edges with multiplicity, a marked vertex | Cayley graphs, state machines, matrices as multisets of arrows |

Both are split-view panels (`---`, docs in lib/panels.ts), so a lattice or a
graph sits beside a continuous plot of the same definitions.

## 1. Lattice panels (built)

A panel is a **lattice** when its view row names index axes instead of x and
y, or when every row it draws is a lattice object (the way a panel becomes
3D when one of its rows is 3D):

```
view(i = -60..60, n = 0..80)
```

- The first axis runs across, the second **down**: row n + 1 is below row n,
  as in a table, a matrix, or a space-time diagram. Axis numbers are the
  indices themselves (`n = 40`, not `y = -40`).
- Cells are unit squares centred on whole coordinates. The grid draws cell
  edges once cells are big enough to see, and major lines at 1, 2, 5 × 10ᵏ
  cells, never fractional.
- Past ~26 px per cell each cell prints its value, so a Cayley table is
  readable as a table rather than a heat map.
- The axis letters come from the view row, or else from the rows drawn
  (`c_{n+1}[i]` names i across and n down; `T[i, j]` names i across, j down).
- Internally a lattice panel is a 2D panel whose y is minus the row index,
  so panning, zooming, shared axes and the view-row writeback are the 2D
  machinery unchanged; only the grid, the axis labels and the view row's
  names differ.

## 2. Tables: functions on ℤ² (built)

```
T[i, j] = mod(i + j, 6)
```

is a function on the integer lattice, drawn in a lattice panel: cell (i, j)
shaded by T's value, printed when zoomed in. The rows it is written in name
its axes. Undefined values (a piecewise with no case) are empty cells, so a
finite table is a domain restriction:

```
n = 6
T[i, j] = {0 <= i < n: {0 <= j < n: mod(i j, n)}}      # ℤ/6 under ×
```

Only the visible window (clamped to 512 × 512 cells) is evaluated, on the
CPU with the compiled VM, so a table is unbounded and costs what is on
screen.

Groups: a Cayley table is a table, `T[i, j] = mod(i + j, n)`. A non-cyclic
group is a table over an encoding: D₃ as k = a + 3b (rotation a, flip b),
`T[i, j] = mod(i + (-1)^floor(i/3) j, 3) + 3 mod(floor(i/3) + floor(j/3), 2)`
restricted to 0..5. The latin-square property (each row and column a
permutation) is visible at a glance.

## 3. Automata (built)

### 1D (moved)

`c_{n+1}[i] = …` is unchanged as syntax. It now draws in a lattice panel:
i across, n down, `view(i = -60..60, n = 0..80)` framing it. The old
`(i, -n)` placement is the lattice's internal coordinates, so the cells
shader did not change.

### 2D: Game of Life

```
L_{n+1}[i, j] = {s = 3: 1, s = 4: L_n[i, j], 0}
```

with `s` the 3 × 3 neighbourhood sum. A 2D rule reads the previous
generation at fixed offsets, `L_n[i+1, j-1]`; `sum(a=-1..1, …)` with
constant bounds unrolls, so the neighbourhood is written once:

```
s(i, j) = …                      # not needed: write the sum inline
L_{n+1}[i, j] = {sum(a=-1..1, sum(b=-1..1, L_n[i+a, j+b])) = 3: 1,
                 sum(a=-1..1, sum(b=-1..1, L_n[i+a, j+b])) = 4: L_n[i, j], 0}
```

The seed is an expression in i and j, `L_0[i, j] = …`, or a **multiset of
live cells**, `L_0 = [(0, 0), (1, 0), (2, 0), (2, 1), (1, 2)]` (a glider):
a configuration is a multiset of cells, a cell's value its multiplicity.

The rule row draws one generation, stepping with t (8 per second), and reads
out which generation it is showing. The board is 256 × 256 cells around the
seed; outside it every cell is the background, which steps by the rule
applied to itself (as the 1D lattice does), so a glider leaving the board
leaves cleanly.

## 4. Graphs (sketch)

```
k = [0..11]
graph(k, mod(k + 1, 12))            # the cycle C₁₂: Cayley graph of ℤ/12 by 1
graph(k, mod(k + [1, 4], 12))       # generators 1 and 4 (separate list → both)
```

`graph(from, to)` and `graph(from, to, label)` take multisets of vertices
and the multiset rule (docs/multisets.md §1) does the combinatorics: names
are chosen together, separate literals cross. So the edges of a Cayley graph
are one expression, not a loop.

A graph panel lays its vertices out (a seeded force layout, stable across
edits that keep the vertex set), draws directed edges as arrows, parallel
edges as one edge with its multiplicity, and labels vertices by value.

### State machines

A transition function is an ordinary function of two variables, and its
diagram is its graph over states × symbols:

```
Q = [0..2]; S = [0, 1]
d(q, s) = mod(2q + s, 3)          # divisibility by 3 of a binary number
graph(Q, d(Q, S), S)              # Q and S are separate: every (q, s) pair
w = (1, 1, 0, 1)                  # 13 in binary
q_0 = 0
q_{n+1} = d(q_n, w[n+1])          # the run
mark(q_N)                          # highlight the state after N symbols
```

The run is a recurrence (sequences already exist); `mark` highlights a
vertex. The accepted/rejected readout is `q_4 = 0`.

### Pushdown automata

A PDA is a state machine plus a stack. The stack is a tuple, so it needs
tuple-valued recurrences (`s_{n+1} = push(s_n, a)`), which sequences do not
have yet. Drawn as a graph panel (control) beside a lattice panel whose
columns are the stack over time (`S[n, h]` = symbol at height h after n
steps) — which is exactly a table, so once tuple recurrences exist the
drawing is free.

## 5. Matrices as multisets (sketch)

Wildberger's reading: a matrix A is a multiset of arrows i → j, A_ij of
them. Multiplication is composition: every arrow i → j of A followed by
every arrow j → k of B is an arrow i → k of AB, so (AB)_ik counts the
two-step paths.

```
A = [(1, 1), (1, 2), (2, 2), (2, 2)]       # [[1 1] [0 2]] as arrows
B = [(1, 2), (2, 1), (2, 2)]               # [[0 1] [1 1]]
AB = (A.x, B.y)[A.y == B.x]               # A and B separate: all pairs, kept where they meet
graph(A.x, A.y) --- graph(AB.x, AB.y)
```

The multiset rule already computes AB: A and B are separate names, so the
tuple crosses them; the filter keeps composable pairs; multiplicities add.
The graph panel draws the three layers (i, j, k) with A's arrows on the
left and B's on the right, and AB's arrows with their counts beside it. Then
`matrix(AB)` (a multiset of pairs as a matrix) closes the loop with the
matrix readout.

## Order of work

1. Lattice panels, tables, 2D automata (this branch).
2. `graph(…)` rows and graph panels; `mark(…)`.
3. `matrix(P)` from a multiset of pairs, and pairs from a matrix.
4. Tuple-valued recurrences, then PDAs.
