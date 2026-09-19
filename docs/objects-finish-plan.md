# Finishing geometry, analysis, space, and families

**Implementation status — 2026-09-19:** items #0–#15 and the tail now have
implementations in the working tree. This is a code status, not a deployment
claim. The “Today” paragraphs below preserve the original starting point.

- #10: named 3D points, vector arithmetic/measurements, segments, paths,
  arrows, and polygons (triangles fill; larger 3D polygons outline).
- #11–#12: background 3D flow tracing, symbolic 3D chart conversion, direction
  fade and an arrow-lattice control. Fixed budgets; moving traces throttle.
- #13–#14: zipped object families, point-list values and paths, one shared
  shader program per family; limits 32 members / 8 in 3D.
- #15: scalar/list sequence indexing and a bounded recurrence-constant chain,
  including statistics and regression inputs; indices 0–1000.
- Tail: exact rational/quadratic complex-root labels with algebraic fallback;
  numerical two-surface continuation; opt-in interval/Krawczyk certificates
  for a finite box. Certification supports arithmetic and bounded integer
  powers; unsupported functions, singularities and exhausted budgets remain
  explicitly unresolved. It never certifies arbitrary branch completeness.
- The separate decided-comparison work (#35) is implemented as `note` rows.

Validation lives in `lib/objects-finish.test.ts` and `scripts/objects-test.ts`,
with existing classifier, geometry, coordinate and preview tests updated for
newly supported forms. Examples and `llms.txt` document the same limits.

A PR order for what remains of `math-objects.md` §7 (phases 2–5). Written
2026-09-18 against main at 3c55dbd. Every "today" below was verified by
running the rows through `analyze()` (worker/graph.ts), not read off the docs.

Already shipped and out of scope: phases 1 and 1.5, named draggable points,
vector arithmetic, `segment`/`line`/`polygon`/`square`/`circle`, `|A-B|`
readouts, piecewise/restrictions, integrals (value, `int[0..x]` as a
function, iterated), Normal/Uniform/Exponential with derived arithmetic,
scalar list broadcasting, CSV tables, regression, Lorenz via 3-vector states.

## Ground rules for every PR

- One object kind (or one tightly coupled pair) per PR; each leaves main
  shippable. Nothing here needs a flag.
- The principle holds: notation alone decides. New wrappers are asked for
  (`polyline`, `vector`, `revolve`), bare forms stay minimal, widgets derive
  but never reinterpret (§3 of math-objects.md).
- Definition of done, per the repo convention: `lib` tests; `analyze()` in
  worker/graph.ts recognizes the row (MCP validation inherits it); a path in
  the CPU og rasterizer (worker/og.ts) or an explicit site-card fallback;
  examples-menu entry; `llms.txt` + syntax-help rows; a perf guard when a
  per-frame CPU path or a shader count grows; an /about shot if it earns one.
- Replace today's error with the feature — and keep a loud, specific error
  for whatever the PR still doesn't cover.

## The order

| # | PR | Phase | Size | Depends on |
|---|---|---|---|---|
| 0 | Refresh `math-objects.md` status | — | S | — |
| 1 | `polyline(…)` and `vector(…)` arrows | geometry | S | — |
| 2 | `distance` / `angle` measurements | geometry | S | — |
| 3 | Shade the area of a definite-integral row | analysis | S | — |
| 4 | Continuous distribution zoo | analysis | M | — |
| 5 | Discrete distributions + stem renderer | analysis | M | 4 |
| 6 | Discrete variables in derived arithmetic | analysis | M | 5 |
| 7 | `revolve(f)` | space | S | — |
| 8 | Complex parametric curves | space | S | — |
| 9 | Coordinate fields over z + 3D coordinate points | space | M | — |
| 10 | 3D named points and 3D geometry | space | M | 1 |
| 11 | 3D vector fields and flows | space | L | — |
| 12 | 3D chart flows + arrow glyphs | space | M | 9, 11 |
| 13 | Families I: the family plot, CPU objects, point lists | families | L | 1 |
| 14 | Families II: shader rows | families | L | 13 |
| 15 | Sequences as lists | families | M | 13 |
| 16+ | Tail: exact complex-root labels; space curves from 2-of-3 systems | — | M each | 11 for the latter |

Geometry closes after #2, analysis after #6, space after #12, families after
#15. The three small openers (#1–#3) and the two small space PRs (#7, #8)
are independent of everything and can be pulled forward or parallelized;
the hard ordering constraints are only 4→5→6, 9+11→12, and 13→14/15.

Why this order rather than phase 5 first (the most visible): families
multiply every object kind, so each kind added *after* #13 costs a second
pass through the family path. Landing the object kinds first makes #13–#14
a one-time sweep.

---

## Geometry

### 1. `polyline(…)` and `vector(…)`

Today: `polyline((0,0),(1,1),(2,0))` → "A point cannot be a component of a
vector."; `vector(A, B)` → "A pair of points — did you mean segment(A, B)?".

- `polyline(P1, …, Pn)`, n ≥ 2: add to `GEOM_STATEMENTS` (lib/geom.ts:26);
  lowers to the existing `{ type: 'polygon', closed: false }` — `segment` is
  already the n = 2 case, so render2d and og.ts need nothing.
- `vector(A, B)` draws an arrow from A to B; `vector(V)` from the origin.
  Add `arrow?: boolean` to the polygon plot; the head is drawn in screen
  space at the last vertex (render2d + og.ts), so it doesn't scale with zoom.
- Endpoints accept everything `segment` does: literals, named points, point
  arithmetic, state-valued coordinates. Drag writeback comes free where the
  endpoints are named points.
- Settles the §3 `[…]` collision for good: bare list of points = dots,
  connectedness = `polyline`. (#13 extends it to take a list.)

### 2. `distance` / `angle` measurements

Today: `distance(A, B)` and `angle(A, B, C)` both error; `|A - B|` works.

- Scalar helpers lowered in `lowerGeom` next to `dot`/`cross`:
  `distance(A, B)` ≡ `|A - B|`; `angle(A, B, C)` is the angle at B,
  `atan2(cross, dot)` of `A - B` and `C - B`, in (−π, π]; `angle(U, V)`
  between two vectors. As bare rows they are `value` readouts already.
- Deliberately *no* arc-marker object in this PR. If wanted later it is a
  wrapper (`arc(A, B, C)`), not a side effect of the readout.

## Analysis

### 3. Shade the area of a definite-integral row

Today: `int[0..1] x^2 dx` → `value` readout, nothing drawn.

- When the row is exactly one definite integral of a real integrand in one
  variable with constant (slider/`t` ok) bounds, also fill between the
  integrand and the axis over [a, b], signed areas in two tints. Precedent:
  `P(X < b)` is a readout that shades (`prob.shade`). This is a widget-free
  derivation — the notation still denotes the number.
- Implementation: `value` gains `shade?: { body, v, lo, hi }`; CPU-sampled
  polygon like `shadePolygon` (lib/dist.ts:1158). Anything more complex
  (iterated, integral inside a larger expression) stays a plain readout.
- Not planned: the doc's "`∫₀ˣ` via CPU LUT texture". `y = int[0..x] …`
  already plots through `quadratureSum`; revisit only if a perf guard trips.

### 4. Continuous distribution zoo

Today: `X ~ Gamma(2, 1)`, `X ~ T(5)` → "Unknown distribution".

- Add Gamma, Beta, ChiSquared, StudentT, LogNormal, Cauchy, Weibull to
  `BaseKind` (lib/dist.ts:52–82). Each needs: `pdfExpr` (closed form —
  `gamma` is already in special.ts), a CDF for the exact `P(…)` readout, a
  sampler for the derived-variable tiers, and support bounds.
- CDFs: add regularized incomplete gamma and beta to lib/special.ts (they
  cover Gamma/ChiSquared/Beta/StudentT); the rest are elementary.
- The readout already falls back to median/IQR for unstable tails — Cauchy
  and low-df StudentT must land in that branch; test it.
- Exact closure rules (lib/dist.ts:1616–1640) grow only where cheap and
  true: sum of independent Gammas with equal rate, scaled Gamma, square of
  a standard Normal → ChiSquared(1). Everything else uses the existing
  quadrature/sampling tiers unchanged.

### 5. Discrete distributions + stem renderer

Today: `X ~ Binomial(10, 0.3)`, `X ~ Poisson(3)` → "Unknown distribution".

- Binomial, Poisson, Geometric, NegativeBinomial, Bernoulli,
  DiscreteUniform. `BaseDist` gains a `discrete` flag; pmf as an Expr over
  integer k.
- New plot `{ type: 'pmf'; rv }` drawn as stems (dot + thin line) at the
  integers of the support within view — reuse the bar/dot code paths behind
  `vlist` and `histogram`, plus their og.ts rasterization.
- `P(…)` over a single discrete variable is an exact finite/truncated sum;
  shading highlights the selected stems. `E(X)` exact from the closed form.
- Parameters may be sliders; non-integer `n` fails loudly on the row.

### 6. Discrete variables in derived arithmetic

- `S = X1 + X2`, `Y = X^2`, `P(X > Y)` with discrete bases. Exact pmf by
  convolution/enumeration when every base is discrete with small truncated
  support; otherwise the sampling tier, rendered as a **pmf histogram on
  the integer lattice**, never a KDE polyline (a KDE over atoms is wrong).
- Mixed discrete × continuous (`N ~ Poisson(3); Y = N + Z`) is a continuous
  mixture: route to the existing sampled-density tier and test that the
  conditional-CDF quadrature tier declines it rather than mis-integrating.
- Closure rules: sum of Poissons, sum of Binomials with equal p.

This is split from #5 because it touches the tier-selection logic in
`buildRVSystem` (lib/dist.ts:2058), which is the riskiest code in the file.

## Space

### 7. `revolve(f)`

Today: "Unknown variable: revolve".

- `revolve(f)` with f real in x desugars at classify time to the implicit
  surface `y^2 + z^2 = f(x)^2` (about the x-axis); `revolve(f, y)` for an
  expression in y about the y-axis. A whole-expression form beside
  `tube`/`domain` (§5 step 3). The raymarcher and symbolic gradient need
  nothing. A no-default piecewise f restricts the extent for free.

### 8. Complex parametric curves (shipped)

Today: `exp(i 2 pi u)` → "Complex expressions plot in 2D only (x, y, w)."

- A complex-valued expression whose only free variable is u is the image
  of a path: split with `complexParts` (lib/complex-parts.ts, already used
  to turn complex equations into real systems) into a 2D `pcurve`
  `(re, im)`. Relax the guard at lib/plot.ts:313 for exactly this case.
  The doc assumed this needed a complex CPU evaluator; it doesn't.
- `f(path(u))` with f a user function works by inlining before the split.
  Expressions `complexParts` can't split keep a loud error.

### 9. Coordinate fields over z + 3D coordinate points (shipped)

Today: `rho = sqrt(x^2+y^2+z^2)` → "rho defines a coordinate … may only use
x, y, t, and constants (found z)". (A 2D field used in a z equation already
works: `s = sqrt(x^2+y^2); s = 1 + z^2` → `implicit3d`.)

- Lift the restriction at lib/defs.ts:1623: a field may use x, y, z. It
  substitutes exactly as now, so `rho = 2`, `phi = pi/4`, and
  `rho = 1 + cos(3 theta)` become surfaces with no renderer work. A
  z-using field draws no grid family of its own (there is no 3D analogue
  worth the clutter); it only defines.
- The "second row over a bound name is a plot" rule must see 3D fields.
- `(rho, theta, phi) = (2, pi/4, pi/3)` is then a square 3-system —
  `system` already has `dim: 3`. Extend the `angular` wrap test to 3
  components; RHS in u gives a space curve in the chart via `traceSystem`.
- Examples: spherical and cylindrical charts under *coordinates*.

Shipped notes. `(r, theta, z) = (…)` and the 3-component `angular` test
already worked (the wrap test maps over the left tuple, keyed on a top-level
atan2 / `[angle]`, so an acos-valued polar angle is never wrapped); the work
was the definition side, `coordinateRow` taking three names, and one thing
the plan did not foresee: the raymarcher treats any sign change as a root,
so `theta = pi/4` in a 3D scene drew a second sheet along the ±π cut of
atan2. A sign change whose bisected bracket does not close is now refused
as a jump (budgeted per ray). That is general, not chart-specific: it also
opens the risers of `z = floor(x)` — only the first few a ray meets, within
the budget, so far risers still draw — and should treat a pole's sign flip
the same way (not checked in a render). Still open: a surface lying exactly on the cut (`theta = pi`)
has no sign change and does not draw in 3D; 3D chart flows are #12 and say
so; atan2(0, 0) is 0 on the CPU, as it always was in 2D.

### 10. 3D named points and 3D geometry (implemented)

Today: `A = (1, 2, 3)` → "A named point needs exactly 2 components."

- Named 3-points: components `A_x, A_y, A_z` (extend `pointComps`,
  lib/geom.ts:29; `vecStateComps` already handles 3). Vector arithmetic
  over them; `cross` returns a vector in 3D, `perp` stays 2D-only with a
  clear error.
- `segment`/`polyline`/`polygon`/`vector` with 3-points: polygon plot gains
  `dim`. render3d draws line strips (the 3D `pcurve` line path) and a
  billboarded arrowhead; filled 3D polygons only when planar-by-
  construction (triangle), else outline.
- No 3D drag in this PR — a pointer ray doesn't determine a point. Named
  3-points move via sliders/states.

### 11. 3D vector fields and flows (implemented)

Today: `(y-x, x(3-z)-y, x y - z)` → "Vector fields are 2D only";
`(x', y', z') = (…)` → "Use two distinct coordinates…".

- New plot `vfield3d { comps: [Expr, Expr, Expr] }` from a 3-tuple in
  x, y, z or the primed Cartesian triple.
- Rendering: auto-seeded trajectories, since a click is ambiguous in 3D.
  Deterministic hashed seeds over the view box (the solve.ts seeding
  idiom). The 2D streamline RK4 lives inline in web/main.ts (~:574); lift
  it into a dimension-generic `lib` function first, then run the 3D traces
  off the main thread by giving web/trace-worker.ts (today: `traceSystem`
  only) a second message kind. Drawn as 3D polylines with a head-to-tail
  fade for direction. Bounded: seed count ×
  step cap fixed, with a perf guard. Animated (`t`-dependent) fields
  re-trace on a throttle, not per frame.
- og.ts: project the same trajectories; fall back to the site card if the
  budget is exceeded.
- The Lorenz example gains a one-row form next to the state-based one —
  the Eulerian/Lagrangian duality §6 describes, now in 3D.

### 12. 3D chart flows + arrow glyphs (implemented)

- `(rho', theta', phi') = (F, G, H)`: v = J⁻¹(F, G, H) with the symbolic
  3×3 Jacobian — reuse lib/mat.ts's small-matrix solve rather than
  hand-expanding the inverse; lowers to `vfield3d`. Singular chart
  locations are undefined, as in 2D.
- Arrow glyphs on a lattice as a *widget-derived* view of a `vfield3d` row
  (like combs on a curve): same notation, same object.

## Families

Today: every list-in-an-object position fails — `y = [1,2,3] x` and
`x^2+y^2 = [1,4,9]` → "Cannot put a list in an equation"; `circle((0,0),
[1,2,3])` → same; `segment((0,0), (L, 1))` → "Lists cannot appear inside
segment(…)"; `[(0,0),(1,1)] + (1,0)` → "Cannot add a point and a number".
Only scalar math and zipped scatters (`(L, L^2)` → `plist`) broadcast.

The rule to pin before any code: **a list where a scalar fits means one
object per element.** Lists in several positions zip (equal lengths, as
list math already requires) — no cross products. The family is one row,
one colour ramp, one legend entry.

### 13. Families I — the family plot, CPU objects, point lists (implemented)

- New plot `{ type: 'family'; members: Plot[] }`. In lib/list.ts, replace
  the throws at :712 and :753 with element-wise expansion of the *row*: N
  copies with the k-th element substituted, each classified through the
  unchanged pipeline. All members must classify to the same plot type or
  the row errors naming the odd element. Cap N (32) with a loud error.
- This PR enables only CPU-rendered member kinds: points, geometry
  statements, `pcurve`, `system`, `value` (a list-valued readout). Shader
  kinds keep today's error until #14.
- Point lists as values: point ± point-list, scalar × point-list;
  `polyline(P)` / `polygon(P)` taking a list of points (a CSV path in one
  row: `polyline((d.x, d.y))`).
- Ranges with slider bounds make animated/interactive families; members
  are re-expanded on bound change, not per frame.
- og.ts and `analyze()` iterate members.

### 14. Families II — shader rows (implemented)

- `implicit2d`, `ineq2d`, `implicit3d`, `psurface`, `vfield2d` members.
  Strategy, in order of preference: (a) when the list occurs only as
  `f(x,y) = L`, reuse the contour-stack shader behind "all levels" — one
  program, N levels; (b) otherwise compile **one** program with the list
  element as a uniform and draw N passes, which the constants-as-uniforms
  design already supports; never N programs.
- 3D: N raymarch passes are expensive — lower cap (8) and a perf guard.
- `scalar2d`/`domain2d`/fractals don't superimpose meaningfully: error
  suggesting an index (`L[k]` with a slider k).

### 15. Sequences as lists (implemented)

Today: `a_n = 1/n; [a_1, a_2, a_3]` → "Unknown variable: a_1".

- A defined sequence is indexable: `a_3` is a scalar, `a_[1..10]` a list
  (index broadcast) — so sums, scatters, `hist`, and regression work over
  sequence terms, and recurrences iterate on the CPU up to a capped index.
- Decided (2026-09-18): the subscript form `a_[1..10]`, matching how the
  sequence was defined — not `a([1..10])`, which would read as a function
  call.

## Tail (unordered, each optional)

- **Exact complex-root labels.** `w^3 = 1` draws dots with numeric
  positions only. For polynomials in w with rational coefficients, factor
  over ℚ via lib/poly.ts and label roots of linear/quadratic factors
  exactly, "root of …" otherwise — the #1 labeler extended off the real
  line.
- **Space curves from 2-of-3 systems.** `(x^2+y^2+z^2, z) = (9, 1)` →
  today "2 equations in 3 unknowns". Predictor–corrector continuation along
  the null space from seeded points; same honesty caveat as `traceSystem`
  (bounded, not certified). Needs #11's trajectory renderer.
- **Certified solving** (interval subdivision + Krawczyk) stays a separable
  upgrade behind the solve.ts interface; nothing above depends on it.
