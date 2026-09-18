# Mathematical objects: what renders as what

Status (refreshed 2026-09-18, main at 3c55dbd; row claims re-run through
`analyze()` in worker/graph.ts, interaction claims read off the code): phases 1 and 1.5 are shipped — coordinate
points with angular residuals, parametric system continuation, chart flows,
complex constants as Argand points, complex equations as real systems, 2D
coordinate-point drag writeback, "= value" readouts. So is most of phases 2–3
and the seed of 5: named draggable points and vector arithmetic,
`segment`/`polyline`/`vector`/`line`/`polygon`/`square`/`circle`, `|A-B|`,
`distance` and `angle` readouts, piecewise and restrictions, integrals (value, `int[0..x]` as a function, iterated),
Normal/Uniform/Exponential and the continuous zoo (Gamma, Beta, ChiSquared,
StudentT, LogNormal, Cauchy, Weibull) with derived arithmetic, scalar list broadcasting,
CSV tables, regression, Lorenz via a 3-component state, and `revolve(f)`
surfaces of revolution. Static previews
include system points/curves and direction fields. **What remains, and the PR
order for it, is in [objects-finish-plan.md](objects-finish-plan.md).**
Solving/tracing remains numerical and bounded; exact complex-root labels and
certified branch completeness are not implemented. §§3–6 below keep the
original design context (the PRs they call "open" have since landed, except
where marked); §2, the "Here" column of §4, and §7 are current.

A design survey and plan. It fixes the principle that decides how a row of
notation becomes a rendered object, inventories the objects we have against
what comparable tools (Desmos, Wolfram|Alpha) render, and designs the largest
missing piece: positional objects — points, parametric curves, flows — inside
user-defined coordinate systems. Behavior claims about the current code were
verified against `classify()` on master, and the open-PR inventory is as of
2026-07-23. Open PRs are treated throughout as **options under consideration,
not decisions**: §3 says where each would slot and where they collide.

## 1. The principle

A row's meaning comes from its notation alone: **value type × free variables ×
top-level shape**. There are no modes, no per-row type pickers, and no hidden
state that changes what an expression denotes. Widgets (sliders, combs, "all
levels") may *style* an object or bind a constant, but never change its kind.
Everything unsupported fails loudly on its own row, never silently.

From that principle, the invariants the classifier implements (and every new
object must respect):

1. **An equation denotes its solution set; an inequality its region.** The
   solution set's dimension is ambient minus constraints, and the renderer
   follows the dimension: in 2D, one constraint → curve; in 3D, one → surface.
   (Square systems complete it: n constraints in n unknowns → a solved
   point set, §6. Non-square systems — a space curve from 2 of 3 — remain.)
2. **A tuple is positional.** With k parametric variables (u, v) it is a
   k-dimensional parametric object: 0 → point, 1 → curve, 2 → surface. As a
   function of position (x, y) it is a vector field.
3. **`t` animates; it never changes kind.** Constants (sliders) never change
   kind either — they compile to uniforms precisely so dragging can't
   reclassify or recompile.
4. **A defined name used where a scalar fits means substitution.** Functions
   inline symbolically; coordinate fields compose with position, so
   `r = 1 + cos(theta)` *is* `sqrt(x²+y²) = 1 + cos(atan2(y,x))`. (PR #36
   extends the flip side: a second row over an already-bound name is a plot
   in terms of it, generalizing what coordinate fields already do.)
5. **Complex is a value type, not a mode.** `i`/`w` make a subtree complex;
   `re`/`im`/`arg`/`abs` bring it back to ℝ and the result flows through the
   real paths.

## 2. Inventory: the objects we render today (main)

| Notation (after resolution) | Object | Renderer |
|---|---|---|
| equation in x, y (incl. `y = f(x)`, field names) | implicit curve | 2D distance-estimate shader |
| `f(x,y) = c`, c a slider (+ "all levels") | level-set family | contour-stack shader |
| inequality / chain in x, y | region (+ solid edges) | fill shader |
| bare scalar in x only | graph `y = expr` | implicit curve |
| bare scalar in x, y | scalar field | density shader |
| equation/bare scalar with z | implicit surface | raymarcher |
| `revolve(f)`, `revolve(f, y)` | surface of revolution, lowered to the implicit surface `y^2 + z^2 = f(x)^2` | raymarcher |
| complex-valued expr in w | field lines + equipotentials | level-curve shader |
| `domain(f)` / `conformal(f)` / `iter(step)` | domain coloring / conformal grid / escape-time fractal | dedicated shaders |
| tuple, no free vars (t ok) | point (2D/3D) | overlay dot / billboard; draggable where its literals/constants can be written back |
| `A = (1,2)`; `A + 2B`, `midpoint(A,B)`, `perp(A)` | named point (2 components) / point arithmetic | point; `A_x`, `A_y` are scalars |
| `segment` / `polyline` / `polygon` / `square` (points) | polygon (open or closed) | CPU polyline / fill |
| `vector(A, B)`, `vector(V)` | arrow (an open polygon with a head) | CPU polyline + screen-space arrowhead |
| `line(A,B)`, `circle(A, r)` | lowered to an implicit curve | 2D distance-estimate shader |
| tuple-equation, square (`(r, theta) = (2, pi/4)`, `F(x,y,z) = (a,b,c)`, RHS in u) | system: solved point set / traced curve | lib/solve.ts Newton + continuation; overlay dots / polyline |
| complex equation `f(w) = c` | root point set (as a 2×2 real system) | same solver; numeric positions |
| `(r', theta') = (F, G)` over coordinate fields | chart flow, lowered to a vector field | LIC + click-to-trace |
| complex constant (`1+2i`) | Argand point | overlay dot |
| complex-valued expr in u alone (`exp(i 2 pi u)`, `f(exp(i 2 pi u))`) | path in the Argand plane | split by `complexParts` into a 2D parametric curve `(re, im)`; CPU polyline, pen up at branch cuts |
| bare expression with no plot coordinate (`2+2`, `\|A-B\|`, `dot(A,B)`, `distance(A,B)`, `angle(A,B,C)`, `int[0..1] x^2 dx`) | value readout | "= 4" on the row, nothing drawn |
| a row that is exactly one definite integral (`int[0..b] sin(x) dx`) | value readout + signed area | CPU-sampled polygons between the integrand and the axis, two tints by contribution to the value (lib/intshade.ts); a readout that shades, like `P(X < b)` |
| `y = int[0..x] …` / `f(x) = int[0..x] …` | integral as a function | quadrature sum inlined into the ordinary paths |
| `{cond: val, …}`; no default = restriction | piecewise value | flows through every renderer (NaN outside the cases) |
| `a_n = …`; `a_{n+1} = …` | sequence dots (+ Σ toggle); cobweb / bifurcation | CPU overlay |
| `[…]`, `[1..5]`, `L^2`; `(L, L^2)`; `hist(L)` | scalar list (dots/bars); zipped scatter; histogram | CPU overlay |
| `data = open("file.csv")`, `data.col` | table; a numeric column is a list | definition |
| `Y ~ m X + b` | regression: binds the fitted parameters | fit readout on the row |
| `a' = f(…)`, `a(0) = …`; `r' = (…, …, …)` | time-integrated state (scalar or 2/3-vector) | RK4 between frames; a constant to every consumer |
| `trail(point)` | motion trail | polyline (2D/3D) |
| tuple in u (`tube(…)` opt-in) | parametric curve | polyline / tube + κ/τ combs |
| 3-tuple in u, v | parametric surface | Newton raymarcher |
| 2-tuple in x, y; `dy/dx =`, `y' =`, `(x', y') =` | vector field / slope field / phase portrait | LIC + click-to-trace RK4 |
| `a = 2`, `b = a² + t` | constant (slider / computed) | widget; uniform |
| `f(x) = …` | function | inlined |
| definition using x/y (`r = sqrt(x²+y²)`) | coordinate field | grid family (level sets) |
| `X ~ Normal(m, s)` (also Uniform, Exponential, Gamma, Beta, ChiSquared, StudentT, LogNormal, Cauchy, Weibull) | random variable | its exact density curve |
| `X ~ Binomial(n, p)` (also Poisson, Geometric, NegativeBinomial, Bernoulli, DiscreteUniform) | discrete random variable | its pmf as stems at the whole numbers in view (CPU overlay; past 1024 in view, the envelope of the same exact heights) |
| `Y = X^2`, `S = X1 + X2`, bare `X + Y` (X random) | derived random variable | affine-in-normals: exact pdf (shader); 1–2 base variables: deterministic conditional-CDF curve (quadrature); otherwise sampled density estimate (KDE polyline); μ/σ readout, or median/IQR when the tails make those unstable |
| `S = X + Y`, `D^2`, `D / 2`, bare `X Y` (every base discrete) | derived discrete random variable | its pmf as stems at the atoms' true locations (not only whole numbers): exact by enumerating the joint of the bases, closure laws where a family is closed (Poisson sums, Binomial/NegativeBinomial sums with one p), a sampled pmf (stems, or a histogram on the values' lattice) past the joint cap — never a KDE; `N + Z` with a continuous base is a mixture and a density row |
| `P(X < b)` | probability | shaded area + exact numeric readout |
| `P(X <= 3)`, `P(2 < X <= 5)`, `P(X = 3)`, `P(X != 3)` (X discrete) | probability | the selected stems highlighted + exact readout; strictness decides the boundary stem |
| `P(Y > 0.5)`, `P(Y > X)` (derived / joint) | probability | Monte Carlo readout (+ shaded density area when one-variable) |
| `P(S <= 5)`, `P(X > Y)`, `P(X >= Y)`, `P(X = Y)` (all discrete) | probability | exact by enumeration, ties counted by strictness (+ the selected stems when one-variable); sampled to 3 places past the joint cap |

Two consequences of invariant 4 worth naming because they already answer part
of "what should render as what" in custom coordinates, and should stay:

- **Scalar contexts already work in any coordinate system.** With polar fields
  defined, `r = 2(1+cos(theta))` (curve), `r < 1 + cos(theta)` (region), and
  `sin(3 theta)` (scalar field) all classify correctly via substitution.
- **A bare tuple of field names is a vector field** (`(r, theta)` → components
  r(x,y), θ(x,y)). Surprising at first sight but exactly what invariants 2+4
  compose to; keep it.

## 3. In flight: the open PRs

*Status, 2026-09-18:* the features of #1, #6, #17, #25, #31 (extended to
vector states in #55), and #32 are on main, and #36's solve engine landed
with the coordinate objects in #94. #35's decided comparisons are **not** on
main: `e = 2` and `2+2=4` still classify as (empty or degenerate) implicit
curves with no note. The prime dispatch below is implemented (a lone primed field errors, though
its message does not yet point at the tuple form); the
`[…]` collision is settled (bare list of points = dots; connectedness is
`polyline(…)`, shipped as finish-plan #1). The table is kept as written, for the
reasoning about where each piece sits.

Eight branches exist and render; none is merged. Adopting or rejecting any of
them changes the roadmap below, not the principle. (#36 stacks on #1; #25
stacks on the since-merged #5.)

| PR | Adds | Where it sits in the model |
|---|---|---|
| #1 hover roots/intercepts | exact polynomial root enumeration (bigint rationals, Yun/Descartes), numeric fallback, hover markers with exact labels (√2, (1+√5)/2, "root of x⁷−x−2") | a *readout*, not a new object: the row still denotes its curve; hovering reveals derived points. Introduces the app's first exact-symbolic layer — the natural labeler for §6's solved points and phase 2's measurements |
| #6 sequences, recurrences, lists, piecewise, number theory | `a_n = …` dot plots + Σ partial-sum toggle; `a_{n+1} = …` cobwebs, and bifurcation diagrams when x is free on the right; `[…]` list literals (scatter / bar toggle); `{cond: val, …}` piecewise; gcd/isprime | several genuinely new object kinds at once. Piecewise is a value-type addition that flows through every renderer. Its `[…]` semantics collide with #31's follow-up, and its Σ/bar toggles bend invariant 3 — both resolved below |
| #17 /mcp, /g/ links, og images | MCP server validating rows through parse/classify; share pages; CPU-rendered og previews | orthogonal to the object model, with one obligation created: new row forms must keep validating through the same parse/classify pipeline (encode_graph_url then inherits them), and each new renderer eventually needs a path in the CPU og rasterizer |
| #25 tube material checker | arclength × RMF-angle checker on tubes | styling of an existing object; taxonomy-neutral |
| #31 time-integrated states | `a' = f(…)` defines da/dt, RK4-integrated between frames, `a(0) = …` seeds; states flow into uniforms exactly like constants | a new *definition* kind, not a plot: a named scalar whose value has history (the first object the hash doesn't fully determine at time t). Claims prime syntax on non-coordinate names — see the dispatch rule below |
| #32 drag points | per-axis writeback of dragged points into the literals/constants that define them; ODE seed dragging | interaction, not taxonomy — but its writeback model is what §6 needs for dragging solved points and phase 2 needs for named points |
| #35 decided comparisons | `e = 2` → "Never true (2.71828 ≠ 2)"; `2+2=4` → "Always true (4 = 4)"; a PlotNote channel (muted note, distinct from errors) | strengthens "fails loudly" into "explains itself". The PlotNote channel is the right home for every readout this document proposes (constant-row values, measurements) |
| #36 systems and fibers (stacked on #1) | vector equations `F(x,y,z) = (a,b,c)` classified as square **systems**, solved by a new `lib/solve.ts` (damped Newton, seeded lattice, symbolic Jacobian with FD fallback, deterministic seeds, backward-error convergence), solutions marked; 2D curve intersections the same way; level-set rows for defined functions; adaptive raymarching | **the largest overlap with this document**: invariant 1 at codimension n, plus the solve engine §6 specifies. If adopted, §6 reduces to deltas on top of it |

Three collisions to resolve whenever the PRs above are decided:

**Prime dispatch.** Three meanings of `'` are in play: `y' = x - y` (slope
field, master), `a' = -a` (integrated state, #31), and `(r', theta') = (F, G)`
(flow in a chart, §6). The coherent rule is that the *base name's role*
decides: x/y → Cartesian ODE, as today; a tuple of primed **coordinate
fields** → chart flow (§6); an otherwise-undefined name → #31 state. A lone
primed field (`r' = -r` with r a field) is an error pointing at the tuple
form — a single chart component doesn't determine a plane field. This is the
same dispatch principle the rest of the classifier uses (what a name *is*
decides what notation over it means), so all three can coexist.

**The `[…]` collision.** #6 renders a list of points as a scatter; #31's
stated follow-up wants a polyline literal (`[(0,0), (x1,y1)]` collapsing a
pendulum's rods to one row). The same notation cannot mean both. Recommended
resolution, matching the `tube(…)` precedent (bare stays minimal, solids are
asked for): a bare list of points is **dots**, as #6 has it; connectedness is
opt-in via a wrapper — `polyline(…)` now, joining `segment`/`polygon` in the
phase-2 geometry family.

**Widget semantics.** #6's Σ and bar toggles, like "all levels" and the κ/τ
combs, make a widget change what's drawn. Pin the rule when #6 lands: a
widget may *derive* a related object from the row (partial sums, bars,
families, combs) but never *reinterpret* the notation — connectivity, kind,
and coordinates always come from the text, so the hash stays the document.

## 4. What Desmos and Wolfram|Alpha render that we don't

Feature classes, not product snapshots. ✓ = has it, ~ = partial/indirect.
"Here" reflects main as of 2026-09-18; "plan #n" is the PR number in
[objects-finish-plan.md](objects-finish-plan.md).

| Object / capability | Desmos | W\|A | Here | Disposition |
|---|---|---|---|---|
| points in polar / user coordinates | ~ (polar curves only) | ✓ | ✓ | **shipped** (§6, phase 1): `(r, theta) = (2, 9pi/4)`, chart parametrics, non-injective preimages |
| solutions/roots marked, exact labels | ~ (click) | ✓ | ✓ (hover roots with exact labels; systems marked numerically) | shipped; exact labels for *complex* roots remain (plan tail) |
| intersection points of curves | ✓ | ✓ | ✓ (as systems) | shipped: `(x, y) = (y, -sin(x))` |
| ODEs / flows in non-Cartesian coordinates | — | ✓ | ✓ | **shipped** (§6), with the prime dispatch of §3 |
| time-integrated simulation (no closed form) | ~ (tickers) | — | ✓ (scalar and 2/3-vector states) | shipped; composes with §6 (a simulated point in a chart) |
| named points, vector arithmetic (`A = (1,2)`, `\|A-B\|`) | ✓ | ✓ | ✓ (2 components only) | shipped; 3-component named points are plan #10 |
| draggable points | ✓ | — | ✓ | shipped, including writeback for 2D coordinate points (§6) |
| segments, polygons, circles, vectors-as-arrows | ✓ | ✓ | ✓ `segment`/`polyline`/`vector`/`line`/`polygon`/`square`/`circle` | done (plan #1; `polyline(…)` also resolved the `[…]` collision, §3). Lists of points inside them wait for plan #13, 3-component points for #10 |
| midpoint/distance/angle readouts | ✓ | ✓ | ✓ `midpoint`, `\|A-B\|`, `dot`, `cross`, `distance(A, B)`, `angle(A, B, C)` / `angle(U, V)` | done (plan #2). `angle` is signed, in (−π, π], and undefined on a zero-length arm; no arc marker — if wanted it is a wrapper (`arc(A, B, C)`), not a side effect of the readout. Lists of points wait for plan #13; 3-component `angle` for #10. Readouts ride the `value` row, not #35's PlotNote channel (which never landed) |
| domain restrictions `{a < x < b}` | ✓ | ~ | ✓ (as piecewise) | **done, no new grammar**: a piecewise with no default is undefined outside its cases, so `y = {a < x < b: f(x)}` restricts any row kind. A Desmos-style trailing `f(x) {a < x < b}` suffix is not planned — it would collide with brace grouping (`2{x + 1}`) for nothing the case form lacks |
| piecewise functions | ✓ | ✓ | ✓ (#6) | shipped |
| definite integrals (value + `∫₀ˣ` as a function) | ✓ | ✓ | ✓ (value, `int[0..x]` as a function, iterated) | shipped, incl. signed-area shading when the row is exactly one definite integral (`value.shade`, CPU polygon in both renderers) |
| distribution zoo (uniform, exponential, t, binomial, Poisson…) | ✓ | ✓ | Normal, Uniform, Exponential, Gamma, Beta, ChiSquared, StudentT, LogNormal, Cauchy, Weibull (+ derived arithmetic; median/IQR readouts where σ does not exist); discrete: Binomial, Poisson, Geometric, NegativeBinomial, Bernoulli, DiscreteUniform as stems with exact `P(…)`/`E(X)`; discrete variables in derived arithmetic (exact pmfs by enumeration, closure rules, a sampled pmf past the joint cap, discrete × continuous as a sampled mixture density) | — |
| value readout for constant rows (`2+2` → "= 4") | ✓ | ✓ | ✓ | **done**: a bare expression with no plot coordinate is a `value` row — it reads out "= 4" live and draws nothing (it no longer assumes `y =`). This is also the measurement readout: `\|A-B\|` reads the distance |
| complex constants as Argand points (`1+2i`) | ✓ | ✓ | ✓ | shipped (phase 1.5) |
| complex root sets (`w³ = 1`) | ~ | ✓ | ✓ (numeric positions) | shipped (§6); exact labels when polynomial remain (plan tail) |
| sequences (stem plots), recurrences, cobwebs, bifurcation | ~ | ✓ | ✓ (#6) | shipped; sequence terms as values (`a_3`, `a_[1..10]`) are plan #15 |
| lists / families of objects | ✓ | ~ | scalar list math, ranges, zipped scatters, `hist` only | a list inside an equation, geometry statement, or point arithmetic errors; families are plan #13–#14 |
| complex parametric curves (image of a path under f) | ~ | ✓ | ✓ | shipped (plan #8): a bare complex expression in u alone is split by `complexParts` into a real 2D `pcurve` (no complex CPU evaluator needed); every 2D parametric curve shares one sampler (lib/path.ts) that lifts the pen at jumps — branch cuts, steps, poles |
| 3D vector fields / 3D ODE flows (Lorenz) | — | ✓ | fields 2D only; Lorenz runs as one 3-component state (a 3D point + `trail`) | plan #11–#12 (auto-seeded trajectories; click is ambiguous in 3D) |
| spherical/cylindrical coordinate systems | — | ✓ | fields reject z (a 2D field used in a z equation already works) | plan #9 (substitution already suffices for surfaces) |
| surfaces of revolution | — | ✓ | ✓ `revolve(f)`, `revolve(f, y)` / `(f, z)` | done (plan #7): desugars at classify time to the implicit `y^2 + z^2 = f(x)^2`, so it costs no shader kind and a no-default piecewise f bounds the solid. A list of profiles waits for plan #14 |
| space curves as intersections of two surfaces | — | ✓ | — ("2 equations in 3 unknowns") | plan tail — the non-square (2-of-3) extension of systems, which are square-only |
| tables / data / regressions | ✓ | ✓ | ✓ CSV via `open(…)`, columns as lists, `Y ~ m X + b` | **shipped** — the rejection was revisited once lists gave it a data model (docs/lists-tables-plan.md) |
| actions, tickers, scripting | ✓ | — | — | **rejected**: #31 delivers the legitimate mathematical core (simulation) declaratively, without a scripting model |
| a "polar mode" grid toggle | ✓ | ✓ | — | **rejected** (§7: coordinate systems are user-defined math, not app modes) |

## 5. The decision procedure, restated with the additions

Row-level forms first (they bind names): definition (`a = …`, `f(x) = …`,
field; plus #31's `a' = …` states and `a(0) = …` seeds if adopted),
distribution (`X ~ …`), probability (`P(…)`). Then expression rows, top-level
shape before value type:

1. Prime forms, dispatched by the base name's role (§3): `dy/dx = f`,
   `y' = f`, `(x', y') = (P, Q)` → Cartesian direction field; primed
   coordinate-field tuple `(c₁', c₂') = (F, G)` → chart flow (§6).
2. Tuple-equations → simultaneous **systems** (#36; §6): coordinate names on
   the left are the readable special case, arbitrary components the general
   one. RHS constant → solved point set; RHS in u → parametric solution
   curve (§6).
3. Whole-expression forms: `domain` / `conformal` / `iter` / `tube` / `revolve` (and the
   phase-2/3 wrappers: `polyline`, `segment`, `polygon`, `circle`,
   restrictions).
4. Tuples by free vars: none → point; u(,v) → parametric; x,y → vector field.
5. Inequalities → regions; equations → implicit curve/surface; a comparison
   with no free variables → decided note (#35, not shipped); complex
   equations → root point set (§6, shipped).
6. Bare scalars: x → graph; x,y → scalar field; complex → field lines;
   constant → a **"= value" readout, nothing drawn** (`y = 4` is the line); constant complex
   → Argand point.

Everything else keeps failing loudly with a suggestion.

## 6. Design: positional objects in user coordinate systems

### The gap

*(Closed: everything in this section shipped in phase 1 except exact labels
on complex roots. The text is kept as the design record.)*

Coordinate fields make every *scalar* context chart-aware (§2), but tuples are
axis-bound: with polar defined, `(2, pi/4)` is the Cartesian point x=2,
y=π/4 — there is no way to write *the point r=2, θ=π/4*, nor a parametric
curve given in (r, θ), nor an ODE whose components are polar velocities.
Verified on master: `(r, theta) = (2, pi/4)`, `(x, y) = (2, 3)`, and
`(r', theta') = (0, 1)` are all errors today — the syntax space is free, and
stays free under every open PR except where noted.

### The decision: name the coordinates on the left

A positional row declares its coordinate system by naming coordinates in a
tuple on the left of `=`. No global "active chart", no inference from which
fields happen to be defined: the row says which functions it pins. Axis
variables x, y are themselves coordinates (the identity chart), so Cartesian
is the same syntax, not a special case; mixed pairs like `(r, y) = (2, 1)`
are legal. This extends the pattern `(x', y') = (P, Q)` already established.

**Position rows** — `(c₁, c₂) = (a, b)`, each cᵢ ∈ {x, y} ∪ fields, distinct:
the row denotes the solution set of the simultaneous system
{c₁(x,y) = a, c₂(x,y) = b} (invariant 1 at two constraints → dimension 0):

- RHS constant (t allowed): a **solved point set**, rendered as overlay dots.
  `(r, theta) = (2, pi/4)` is the polar point; `(r, theta) = (2, t)` orbits.
  Non-injective charts render their whole preimage — with the hyperbolic
  chart `p = x y; q = (x²-y²)/2`, the row `(p, q) = (1, 0)` is *two* dots,
  which is the mathematically honest Point object in that system (and
  exactly the fiber semantics #36 demonstrates on Alpöge's map).
- RHS depending on x, y: still the same reading — `(x, y) = (y, -sin(x))`
  marks the **intersection points** of x = y and y = -sin(x).
- RHS in u: a **parametric curve in the chart**, u ∈ (0,1) as everywhere.
  `(r, theta) = (3u, 6pi u)` is a three-turn spiral. This *fixes* the known
  limitation that implicit polar spirals (`r = theta + pi`) only draw the
  principal branch of atan2: the parametric form tracks θ continuously.

**Flow rows** — `(c₁', c₂') = (F, G)`: the ODE ċ₁ = F, ċ₂ = G in chart
coordinates. By the chain rule ċᵢ = ∇cᵢ · v, so the Cartesian field is
v = J⁻¹(F, G) with J the Jacobian of (c₁, c₂) — built *symbolically* (a 2×2
inverse via `diff()`, like the grid's gradients), then fed to the existing
LIC renderer and RK4 click-to-trace untouched. `(r', theta') = (r(1-r), 1)`
is a textbook limit cycle in one line. Where det J = 0 the field is
undefined and the LIC fades, matching how singularities already behave.
Requires the §3 prime dispatch if #31 lands. Note the duality with #31,
which is why both belong: a flow row is Eulerian (the whole field, every
trajectory); a #31 state is Lagrangian (one integrated trajectory other rows
reference by name). They compose — `(r, theta) = (A, B)` with A, B states
renders a *simulated* point in a chart.

**Complex root rows** — `f(w) = c` with f complex-valued: a holomorphic
equation is a 2×2 real system, so the same engine renders `w^3 = 1` as three
dots on the Argand plane (today: an error suggesting re/im). When f is a
polynomial, #1's exact enumerator can label the roots symbolically.

### The engine — and how the open PRs change the work

**PR #36 already builds most of this.** Its `lib/solve.ts` (damped Newton,
seeded lattice over the view, symbolic Jacobian with finite-difference
fallback, deterministic hashed seeds, backward-error convergence, per
(text, constants, box) caching) is the engine this design needs, and its
generic vector-equation → system classification composes with the existing
field substitution to make `(r, theta) = (2, pi/4)` a solved point set with
**no coordinate-specific code at all**. If #36 is adopted, phase 1 is these
deltas on top of it:

1. **Angular residuals.** θ(x,y) − 9π/4 has no zero in atan2's principal
   branch, so `(r, theta) = (2, 9pi/4)` would find nothing. Wrap residuals
   whose component contains atan2 (the same `hasAtan2` test behind
   `GridField.angular`) to (−π, π] before Newton — no named-coordinate
   detection needed, it works post-substitution.
2. **Parametric systems.** Allow u in the RHS: solve per u-sample with
   continuation (warm-start from the previous sample, re-seed on divergence,
   NaN breaks the polyline — the overlay renderer already pen-lifts on NaN).
   This is a general object (any moving constraint traces a curve), not a
   polar special case.
3. **Flow rows** as above (a lowering to `vfield2d`, not a solver feature),
   plus the §3 prime dispatch against #31.
4. **Complex root routing** for `f(w) = c`, with #1's exact labels when
   polynomial.
5. **Drag writeback** (if #32 lands): dragging a solved point evaluates the
   named fields at the pointer and writes those values into the RHS
   literals — per-axis, exactly #32's model, and non-injective branches
   follow the pointer for free.

If #36 is *not* adopted, phase 1 ships the same engine standalone, scoped to
the named-tuple form: seeds scaled to the view (~24×24 plus margin),
tolerance relative to `view.upp`, solutions deduped by a few pixels and
capped (~64), static rows solved once per recompile/slider change, animated
rows warm-started per frame. Either way the solver stays honest the way #36
frames it: it reports what it finds; certified exhaustiveness (interval
subdivision + Krawczyk) is a later, separable upgrade behind the same
interface.

### Implementation notes

- **Classify with the definitions in view.** `main.ts` currently substitutes
  fields into the whole parsed row before `classify()`. Position rows survive
  this (substituted LHS components still form residuals), but flow rows and
  good error messages need the names: pass `defs` into `classify(parsed,
  defs)` and move the substitution inside. The "second `r = …` row is a
  plot" rule in `recompileAll` — and #36's generalization of it — is
  unaffected.
- **Errors are part of the design**: undefined name in an LHS tuple → "theta
  is not a coordinate — define theta = atan2(y, x)"; repeated name → "(r, r)
  does not determine a point"; lone primed field → point at the tuple form;
  non-square systems name the mismatch (#36 already does).
- **Definition of done** (repo convention): `lib` tests for classifier and
  solver; examples-menu entries under *coordinates* (polar point, spiral,
  polar limit cycle, hyperbolic two-dot point); `llms.txt` row-type docs;
  an about-page shot if it earns one; a perf guard if the per-frame solve
  path grows.

## 7. Roadmap

Status as of 2026-09-18. Struck-through items are on main; what is left of
phases 2–5 is ordered, PR by PR, in
[objects-finish-plan.md](objects-finish-plan.md) ("plan #n" below).

| Phase | Contents | Size |
|---|---|---|
| 1 — coordinate objects | ~~position rows, chart parametrics, flow rows~~ — **shipped** (the five deltas of §6 on the #36 engine) | done |
| 1.5 — coherence wins | ~~complex roots `f(w) = c`~~ (numeric; exact labels → plan tail); ~~Argand points for complex constants~~; ~~"= value" readouts on constant rows~~ — **shipped** | done |
| 2 — geometry | ~~tuple-valued constants + vector arithmetic (`A = (1,2)`, `\|A-B\|`)~~, ~~named draggable points~~, ~~`segment`/`line`/`polygon`/`square`/`circle`~~, ~~`\|A-B\|`/`midpoint`/`dot`/`cross` readouts~~, ~~`polyline` and `vector` arrows (plan #1, settling §3's `[…]` collision)~~, ~~`distance`/`angle` measurements (plan #2)~~ — **shipped** | done |
| 3 — analysis | ~~restrictions~~ and ~~piecewise~~ (a no-default piecewise *is* the restriction, see §4), ~~definite integrals: value, `int[0..x]` as a function, iterated~~, ~~Uniform/Exponential and derived-variable arithmetic~~. ~~area shading on a definite-integral row~~, ~~continuous distribution zoo~~, ~~discrete distributions with a stem renderer~~, ~~discrete variables in derived arithmetic (plan #6)~~ — **shipped**. Dropped: "`∫₀ˣ` via CPU LUT texture" — `y = int[0..x] …` already plots through the quadrature sum; revisit only if a perf guard trips | done |
| 4 — space | ~~Lorenz~~ as a 3-component state with `trail` (one trajectory). ~~`revolve()`~~ (plan #7, shipped). ~~complex parametric curves~~ (plan #8, shipped). Remaining: fields over z + 3D coordinate points (plan #9), 3D named points and geometry (plan #10), 3D vector fields with auto-seeded trajectories (plan #11), 3D chart flows + arrow glyphs (plan #12) | L |
| 5 — families | ~~scalar list math, ranges, zipped scatters, `hist`, CSV tables, regression~~. Remaining: lists broadcasting over any object kind (plan #13 CPU objects and point lists, #14 shader rows), sequences-as-lists interop (plan #15) | XL |
| tail | exact complex-root labels; space curves from 2-of-3 systems; certified solving (plan #16+) | M each |

The independent decision tracks have all resolved except one: #31 (states,
with the §3 prime dispatch), #1/#32 (readouts and dragging), and #17/#25
(infrastructure and styling) are on main — #17's obligation stands, every
new renderer needs an og-rasterizer path or an explicit fallback. #35
(decided comparisons and its PlotNote channel) is still open and nothing in
the finish plan depends on it; the readouts it was wanted for shipped as
`value` rows instead.

Phase 1 went first because it was the user-visible gap this document exists
for and *completes* invariant 1. The remaining order — object kinds before
families, so the family path is a one-time sweep — is argued in the finish
plan.

## 8. Rejected designs

- **A polar/coordinate mode or grid toggle.** Desmos's polar is a built-in
  special case. Here a coordinate system is itself a mathematical object the
  user writes down; the reward is that log-polar, hyperbolic, or any
  invertible chart is equally first-class. A mode would fork every renderer
  and break "notation alone decides".
- **Inferring "the" chart from the defined fields** (e.g. first two fields in
  definition order form the system, making bare `(2, pi/4)` polar). Order-
  sensitive spooky action; breaks Cartesian tuples the moment any field is
  defined; ambiguous with ≠2 fields. Naming the coordinates per row costs a
  few characters and is self-documenting.
- **Symbolic chart inversion** (solve (r,θ)→(x,y) in closed form). Fragile
  outside textbook charts; the numeric engine handles every chart uniformly,
  including non-injective ones, and matches the app's existing "analytic when
  possible, numeric when not" posture (gradients, Frenet frames, #36's
  solver, #1's numeric fallback).
- **A geometry sub-app.** Segments and polygons will be expressions
  (phase 2), not a separate tool with different semantics.
- **Scripting/tickers for motion.** #31's declarative states cover
  simulation without an imperative model; combined with §6's flows, both the
  one-trajectory and whole-field views exist as notation.
