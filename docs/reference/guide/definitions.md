---
title: Definitions (extra rows that set up the others)
summary: Sliders, functions, named points, states, data files, lists, matrices, tensors and coordinate fields.
---

- Reserved names — never define these, use them as a constant, or put a
  slider on them: `t` is animation time in seconds (it plays on its own;
  any row using t animates), `x`, `y`, `z` are the plot axes, `w` is the
  complex variable x + iy, `i` is the imaginary unit, `e` is Euler's
  number, `pi` is π, and `d` is the derivative operator. `u` and `v` are
  the curve/surface parameters: they can't be numbers either, but they can
  be redefined as another interval (`u = interval(0, 2pi)`; the default is
  `interval(0, 1)`). None of these can name a function either: a reserved
  name followed by `(…)` multiplies, so `x(y - 1) = 1` is x·(y − 1) = 1,
  and `u(x, y) = x^2 + y^2` is u times a point ("u(x, y) reads as u times
  (x, y)"). Name your own functions f, g, h or a word, write
  `f(x, y) = …` and call f. Pick any other name for your own numbers:
  - Don't: `t = 3` then `(cos(2pi u), sin(2pi t u))` — t is time, so
    `t = 3` is rejected ("t is reserved for time") and the curve would keep
    changing as t counts up.
  - Do: `k = 3` then `(cos(2pi u), sin(2pi k u))` — a Lissajous figure with
    k lobes, and k becomes a draggable slider.
    (Good names: k, n, m, a, b, c, s, r, or a word like `twist`.)
  Only when you really mean to replace a built-in across the whole graph,
  define it with `:=` — `e := 0.6`, `pi := 3`, `i := 3`, `w := x - y`, or
  `t := 0.5`, which stops all animation — and the built-in meaning is gone
  from every row (`i := 3` makes `(1 + 2i)` the number 7). Only as a value:
  `e(x) := …` is rejected. `x`, `y`, `z` and `d` can't be redefined.
- Constant: `a = 2` — the UI shows a draggable slider for it. Computed
  constants allowed: `b = a^2 + t`. Every definition may be written with
  `:=` instead (`a := 2`, `f(x) := x^2`): the same row, said explicitly,
  and the only way to redefine e, pi, i, w or t (see Reserved names).
- Slider range and step: `a = clamp(0.4, 0, 1)` is a slider over [0, 1],
  and `n = round(5)` (or floor/ceil) steps by whole numbers; they combine,
  `r = round(clamp(30, 0, 255))`. The value is what the expression says —
  `clamp(5, 0, 1)` is 1 — and the range is part of the row, so it travels
  in the link. The ends may use other constants (`clamp(a, 0, b)`), not t.
  Dragging rewrites only the number; editing the slider's end boxes writes
  the clamp. `clamp(x, lo, hi)` is also an ordinary function anywhere.
- Function: `f(x) = x^3 - a x` — call it from other rows; calls inline
  symbolically, so `d/dx f(x)` works. A function of several variables also
  takes ONE point in their place: with `f(x,y) = (x + y/2, y)` and
  `A = (1, 2)`, `f(A)` is `f(A_x, A_y)`, and so is any computed point —
  `f(R A)`, `f(A + B)`, `f(rotate(A, 1))`, `f(f(A))`. A list of points maps:
  `P = (a, b); f(P)` is the image of the whole lattice (one point per point
  of P), so `vector(P, f(P))`, `hull(f(Q))`, `f(R P)` and `f(P + (1, 0))`
  all work; a scalar `g(x,y) = x y` gives `g(A)` a number (`y = g(A) x`) and
  `g(P)` a value list. The point must have exactly as many components as the
  function has parameters (3D: `F(x,y,z)` takes `F(B)`). A matrix argument
  is read as the list of its rows (a tuple of 2 points in 2D is a 2×2
  matrix, and `g(S)` maps it like any other point list). A point does not
  spread among other arguments, and built-ins (`atan2(A)`) do not take one.
- Recursive function: a function may call itself when every self-call is a
  whole case of its `{…}` (tail position), so the call runs as a loop —
  per pixel on the GPU, like `iter`. `f(n, a) = {n <= 0: a, f(n - 1, a + n)}`
  sums 1..n; `f(z) = {re(z) >= 1: 1, f(4 - 3(z^6)^(1/6))}` with
  `f(x i - |y|) >= 0` shades the Koch snowflake. At most 250 passes run —
  more, up to 5000, when a parameter every self-call advances by one is
  capped by a case with a plain number (`k >= 600: …` with `f(…, k + 1)`);
  past that, or once a value leaves the finite range, the result is
  undefined and nothing is drawn — a region shades exactly where the
  recursion terminates. `n f(n - 1)`, a call inside a condition, and two
  functions defined through each other are errors (they would need a
  stack), as is `d/dx` of a recursive function. Parameters are numbers,
  but a self-call's point (a tuple, a named point, or a helper's result)
  spreads into consecutive parameters, and a quaternion into four:
  `G(T(a, b, c) + (x, y, z), k + 1)` passes `G(a, b, c, k)` four values.
  A recursive function of x, y, z set equal to a constant is an implicit
  surface, raymarched per pixel. For an escape-time fractal in space,
  return the orbit's Green function ln|p|/nᵏ (degree n, k passes) rather
  than the escape count — the count jumps, which the raymarcher cannot
  draw — and draw a small level of it. The Mandelbulb, whose "triplex"
  power raises r to n and multiplies both spherical angles by n:
  `n = 8; S(R, t, p) = R (sin(t) cos(p), sin(t) sin(p), cos(t));
  r(a, b, c) = sqrt(a^2 + b^2 + c^2);
  T(a, b, c) = S(r(a, b, c)^n, n acos(c/r(a, b, c)), n atan2(b, a));
  G(a, b, c, k) = {r(a, b, c) > 2: ln(r(a, b, c))/n^k,
  k >= 12: ln(r(a, b, c))/n^k, G(T(a, b, c) + (x, y, z), k + 1)};
  G(x, y, z, 0) = 0.001`, framed with `camera(-pi/3, 0.4, 5)`; `+ C` for
  a fixed point C in place of `+ (x, y, z)` draws its Julia bulb. Thin
  detail finer than the raymarch step reads as dust at the edges.
- Point: `A = (0, 0)` — a named, labeled point drawn on the canvas; the user
  can drag it and every row using it follows. Points may be computed from
  other points defined above: `C = B + D`, `M = midpoint(A, B)`,
  `P = midpoint(A, B) - perp(B - A)/2`. Scalars over points work too:
  `n = cross(B, D)`, `L = |B - A|`. A named vector that uses x, y, or z is
  a vector field, not a pinned point: `s = (x, y)` is the position vector
  and draws nothing of its own; later rows treat it as a point, so
  `dot(s, s) = 1` and `|s| = 1` are the unit circle, `|s| < 1` the unit
  disk. `F = (y, -x)` is any field of the plane. In space,
  `s = (x, y, z); dot(s, s) = 1` is the unit sphere.
- Named curve or surface: a named vector that uses u or v is inlined the
  same way — `c = (cos(2pi u), sin(2pi u))` draws nothing of its own, and
  later rows use it as the point it traces: `c` draws the unit circle,
  `M c` its image under a matrix M, `2c + (1, 0)` a moved copy. A scalar
  works too (`k = u^2; (u, k)`) and goes wherever u itself could — so
  `y = k` is the same error as `y = u` — and so does a surface over u and v.
  A definition may use u, v or x, y, z, not both: `(x, u)` is an error.
- Dragging: a point (named or bare) is draggable only where the drag has
  somewhere to write the new value: a coordinate that is a plain number
  (`(2, 3)`) or a bare slider name (`(a, 3)` with `a = 1` above) moves;
  computed coordinates (`C = B + D`, `(a+1, cos(t))`) are pinned, and 3D
  graphs have no point dragging. The MCP encode_graph_url result marks each
  point row with `"draggable"` — write coordinates as literals or sliders
  when the user is meant to move the point.
- State (simulation): `th' = -sin(th)` defines the time-derivative of `th`,
  integrated forward (RK4) as the graph animates, starting from `th(0) = 2`
  (0 if omitted). Everywhere else `th` then behaves exactly like a constant,
  so plot the system by drawing with it: `bob = (sin(th), -cos(th))` names
  the swinging bob and `segment((0, 0), bob)` draws its rod — points,
  segment() and polygon() all accept state-valued coordinates. Use this for
  anything with no closed form — coupled oscillators, a double pendulum,
  Lorenz.
  Name states for what they are (`th`/`om` for angle and angular velocity,
  `pos`/`vel` for a spring — the plane's own x/y/z are reserved). A
  derivative may use t, constants and other states (not x/y); an initial
  value must be constant, and gets a slider that relaunches the run when
  dragged. A ↻ button in the panel restarts it.
- Vector state: a state whose derivative (or starting value) is a 2- or
  3-vector integrates componentwise: `r' = vel; vel' = -r/|r|^3;
  r(0) = (1, 0); vel(0) = (0, 1)` is an orbit. Components are `r_1`, `r_2`
  (and `r_3`) — use them anywhere a scalar goes — and the bare name `r`
  draws as a moving point and works in point arithmetic (`perp(r)`,
  `dot(r, r)`, `r/|r|`, segment endpoints). 3-component states (Lorenz) plot
  through their components.
- State family: a LIST of starting values runs the system once per element
  (up to 1024 runs): `p(0) = ([0..99]/10, 0, 0)` is 100 runs, crossing and
  zipping like any list. States coupled to it (`r' = vel` with a list of
  r(0)) run per element too, from their own single starting value. `p`
  then draws one moving point per run, `p_1` the list of first components
  (`mean(p_1)`), and figures built from the state (`segment((0, 0), b1)`)
  draw one per run. Started from a tuple, `p(0) = (sort([0..99])/10, 0, 0)`,
  the runs are in order and `p[1]` is the first run.
- Data file: `person = open("people.csv", 3a7f9c1d2e4b)` names a CSV dropped
  onto the app. Drag a .csv/.tsv anywhere in the window and this row (plus a
  scatter of its first two numeric columns) is written for you; the file is
  parsed once and kept in the browser's local storage, pinned by the SHA-256
  prefix in the row. Each numeric column reads as a list under its dotted
  name (`person.age`); text columns read as lists of text, which filters can
  compare; missing cells become gaps the row's readout counts. The delimiter
  is sniffed (`,`, `;`, or a tab), a title line above the header is skipped,
  and comma-form numbers in a `;` or tab-separated column select decimal-comma
  parsing (`1,5` is 1.5). Columns without comma-form numbers keep dot decimals
  (`1.234` is 1.234). The readout reports decimal-comma interpretation.
  Because the bytes never
  enter the URL, opening the link on another device (or validating it
  server-side, as the MCP does) reports the data as
  device-local instead of drawing it; dropping the same file there restores
  it. The row's readout opens a preview of the first rows as they parsed.
  `adults = person[person.age >= 18]` names a filtered copy of a file (see the
  filters under Expression syntax). Size: a column and constant arithmetic over it (`col/2`,
  `sin(col)`, `(a, b)`, reductions, `hist`) stay a single array and plot to
  200 000 rows; combining a column with t, a slider, or a comparison needs
  one expression per row, and a row may build 100 000 of those in total —
  so `col t` reaches 100 000 rows (and so does `sin(col t) + 1`: a chain of
  operations over one list is built once, not once per operation). A three-column scatter
  (`(p.x, p.y, p.z)`) draws in 3D, where each point is a sprite, so it is
  capped at 10 000 and says so rather than drawing part of the file — filter
  it first, or plot two of the columns.
- Naming a column, or arithmetic over one, names a list:
  `ages = person.age / 2`, `who = person.name`. It stays a single array, so
  rows below it (`mean(ages)`, `(ages, person.height)`) cost no more than
  reading the column directly.
- List: `L = [3, 1, 4]` or `L = [1..100]` names a data list; rows below
  broadcast over it (`L^2`, `(L, L^2)`), reduce it (`mean(L)`), or filter
  it (`L[L > 2]`); to index it, sort it (`sort(L)[2]`, or `T = sort(L)`,
  then `T[2]`). Elements may use constants, states, t and i. A list of
  tuples names a scatter of points, whatever its shape: `[(1, 2), (3, 4)]`
  is two points, never a matrix.
- Matrix: a tuple of rows, `M = ((a, b), (c, d))` or
  `M = ((a, b, c), (d, e, f), (g, h, i))`, or of named points as rows
  (`M = (A, B)`), is a 2×2 or 3×3 matrix; it works unnamed too:
  `((0, -1), (1, 0)) (2, 1)`, `det(((1, 2), (3, 4)))`. A list in an entry
  makes one matrix per element: with `a = [1, 2]`, `M = ((a, 0), (0, 1))`
  is two matrices, `det(M)` is `[1, 2]`, and `M M P` is two points (both
  Ms are the one M). `det(M)`, `trace(M)`, the matvec `M v`, and
  `solve(M, v)` (Cramer's rule) expand symbolically, so entries
  may hold sliders, t, x/y, or states, and results work anywhere:
  `(x', y') = A (x, y)` is a linear phase portrait, and
  `th' = om; om' = solve(M, f)` integrates a system written in the
  Lagrangian form M(θ)ω′ = f — the natural shape for a double pendulum.
  Matrices combine — `2 M`, `M / 2`, `M + N`, `M N`, `M^2` (whole powers 0–8),
  `M^-1`, `transpose(M)` — and a row may name the result (`R = M N`). A matrix has no
  position, so on a row of its own it draws nothing and reads out its value,
  `= ((1, 2), (3, 4))`: apply it to a vector to draw, or write `action(M)`
  to draw what it does (see [Matrix action](#action)). A 2×2 matrix in x
  and y is a matrix field (see [Matrix field](#tfield2d)).
  Note `a/2J`, touching,
  reads as `a/(2J)`; write `a/2 J`.
- Tensors: a rank-k tensor is k-deep nested tuples, and its shape is part of
  its value — `((1, 2, 3), (4, 5, 6))` is 2×3, `(((1, 2), (3, 4)), ((5, 6),
  (7, 8)))` is 2×2×2. A value that is also a tuple of 2D or 3D points and
  not square draws as those points, however it was made — `(1, 2) ⊗ (3, 4, 5)`
  is the dots (3, 4, 5) and (6, 8, 10) — until a product reads it as a
  matrix: `T (1, 1)`. Operations act on coordinates:
  - `a ⊗ b` (`outer(a, b)`) is the outer product, `(a ⊗ b)_ij = a_i b_j`, for
    vectors, matrices or tensors: `e_x ⊗ e_y` is the 3×3 matrix with a 1 in
    row 1, column 2.
  - `contract(T, i, j)` sums T over its indices i and j (1-based, written as
    numbers), dropping both: `contract(M, 1, 2)` is `trace(M)`, and
    `contract(A ⊗ B, 2, 3)` is the product `A B`. Juxtaposition contracts
    the last index of the left with the first of the right, so `T v` and
    `A B` (2×3 by 3×2) work.
  - `a ∧ b` (`wedge(a, b)`) is `a ⊗ b − b ⊗ a`, a bivector, read out as its
    antisymmetric matrix; it is also a matrix, `(a ∧ b) v = a (b·v) − b (a·v)`.
    `e_x ∧ e_y ∧ e_z` is the rank-3 volume element (∧ is associative); in 3D
    `a × b` is the vector dual to `a ∧ b`.
  - `T[k]` of a named tensor is its k-th slice; `2 T`, `T + S` work
    entrywise. A tensor on its own row reads out; anywhere a number or point
    is needed it is an error until contracted.
  - Lists in entries work as for matrices: with `a = [1, 2]`,
    `a e_x ⊗ e_y` is two matrices, and with `M = ((a, 0), (0, 1))`, `M ⊗ M`
    is two rank-4 tensors, not four (both Ms are the one M).
  - `total`, `mean` and `count` take a multiset of tensors whole, entry by
    entry: with `P` a list of points, `C = mean((P - mean(P)) ⊗ (P - mean(P)))`
    is the covariance matrix, and `C (x, y)` applies it.
  - A bivector `a ∧ b` of 3D vectors, named or written out, generates the
    rotation in their plane: `e^(t a ∧ b) P`.
- Rotations are matrix exponentials: with `J = ((0, -1), (1, 0))`,
  `e^(a J) P` (or `exp(a J) P`) turns P by a, and in 3D `e^(a cross(n)) P`
  turns P by a about the axis n — `cross(n)` alone is the matrix of
  `v -> n × v`, scaled so |n| multiplies the angle (`rotate(P, a, n)`
  normalizes n for you). Both expand to exact cos/sin closed forms, so a may
  be a slider, t, or a LIST: `th = 2pi sort([0..4])/5; polygon(e^(th J) (1, 0))` is
  a regular pentagon (the turns sorted into a tuple, so the polygon has an order), `segment((0,0), rotate((1,0), th))` its 5 spokes, and
  `phi = (1+sqrt(5))/2; k = 2pi [0..2]/3;
  rotate((0, [-1,1], [-phi,phi]), k, (1,1,1))` the 12 vertices of an
  icosahedron (independent lists cross, the named turn list zips). `e^M` works
  for ANY 2×2 — `e^(t A) (x0, y0)` is the exact solution of
  `(x', y') = A (x, y)`, spiral, saddle or node — but a 3×3 must be a rotation
  generator (skew-symmetric).
- Coordinate field: a definition that depends on the plane, e.g.
  `r = sqrt(x^2+y^2); theta = atan2(y,x)`. Its level sets draw as a grid, and
  later rows may use it: adding `r = 2(1 + cos(theta))` plots a cardioid in
  polar coordinates. Here r is a distance, so a curve draws only where it is
  >= 0: `r = sin(4 theta)` shows 4 of the rose's 8 petals. For a polar curve
  that goes negative, trace it with theta = 2pi u instead:
  `(sin(8pi u) cos(2pi u), sin(8pi u) sin(2pi u))` is the whole 8-petal rose.
  A named pair or triple that uses x, y, or z is a vector field (see Point),
  not a grid. A field may be complex: `q = (x + i y)/2` (or `q = w^2`) is
  used wherever w is — `ln(q-2) - ln(q+2)`, `domain(q^3 - 1)`,
  `iter(z^2 + q)` — and draws no grid of its own.
- Coordinate fields in space: a field may use z, e.g. spherical
  `rho = sqrt(x^2+y^2+z^2); theta = atan2(y,x); phi = acos(z/rho)`. A z-using
  field only defines — it draws no grid and does not by itself make the graph
  3D; rows using it do: `rho = 2` is a sphere, `phi = pi/4` a cone,
  `rho = 1 + cos(3 theta)` a surface. Fields may be built from fields
  (`rho = sqrt(r^2 + z^2)`). Cylindrical needs no new field: r, theta and z.
  Angle surfaces cut at the branch of atan2: `theta = pi/4` is a half-plane,
  and a surface lying exactly on the cut (`theta = pi`) does not draw in 3D.
  `(rho, theta, phi) = (2, pi/4, pi/3)` is the point with those three
  coordinates (three coordinates in space, two in the plane; with a z-using
  field, two constraints trace a space curve). Only atan2-valued coordinates
  wrap modulo 2pi — an acos-valued polar angle lives in [0, pi] and does not.
  Where a chart is singular (theta on the z-axis) no point is reported.
  `(rho, theta, phi) = (2, 6 pi u, pi u)` traces a space curve in the chart.
  Points in space are not draggable. Three primed coordinates define a 3D
  chart flow, e.g. `(rho',theta',phi') = (0,1,0)`, transformed by the
  symbolic 3×3 Jacobian and drawn with trajectories or arrow glyphs.
