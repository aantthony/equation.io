# Mathematical objects: what renders as what

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
   (This invariant is currently truncated at one constraint; PR #36 and §6
   extend it — n constraints in n unknowns → a solved point set.)
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

## 2. Inventory: the objects we render today (master)

| Notation (after resolution) | Object | Renderer |
|---|---|---|
| equation in x, y (incl. `y = f(x)`, field names) | implicit curve | 2D distance-estimate shader |
| `f(x,y) = c`, c a slider (+ "all levels") | level-set family | contour-stack shader |
| inequality / chain in x, y | region (+ solid edges) | fill shader |
| bare scalar in x only | graph `y = expr` | implicit curve |
| bare scalar in x, y | scalar field | density shader |
| equation/bare scalar with z | implicit surface | raymarcher |
| complex-valued expr in w | field lines + equipotentials | level-curve shader |
| `domain(f)` / `conformal(f)` / `iter(step)` | domain coloring / conformal grid / escape-time fractal | dedicated shaders |
| tuple, no free vars (t ok) | point (2D/3D) | overlay dot / billboard |
| tuple in u (`tube(…)` opt-in) | parametric curve | polyline / tube + κ/τ combs |
| 3-tuple in u, v | parametric surface | Newton raymarcher |
| 2-tuple in x, y; `dy/dx =`, `y' =`, `(x', y') =` | vector field / slope field / phase portrait | LIC + click-to-trace RK4 |
| `a = 2`, `b = a² + t` | constant (slider / computed) | widget; uniform |
| `f(x) = …` | function | inlined |
| definition using x/y (`r = sqrt(x²+y²)`) | coordinate field | grid family (level sets) |
| `X ~ Normal(m, s)` (also Uniform, Exponential) | random variable | its exact density curve |
| `Y = X^2`, `S = X1 + X2`, bare `X + Y` (X random) | derived random variable | affine-in-normals: exact pdf (shader); 1–2 base variables: deterministic conditional-CDF curve (quadrature); otherwise sampled density estimate (KDE polyline); μ/σ readout, or median/IQR when the tails make those unstable |
| `P(X < b)` | probability | shaded area + exact numeric readout |
| `P(Y > 0.5)`, `P(Y > X)` (derived / joint) | probability | Monte Carlo readout (+ shaded density area when one-variable) |

Two consequences of invariant 4 worth naming because they already answer part
of "what should render as what" in custom coordinates, and should stay:

- **Scalar contexts already work in any coordinate system.** With polar fields
  defined, `r = 2(1+cos(theta))` (curve), `r < 1 + cos(theta)` (region), and
  `sin(3 theta)` (scalar field) all classify correctly via substitution.
- **A bare tuple of field names is a vector field** (`(r, theta)` → components
  r(x,y), θ(x,y)). Surprising at first sight but exactly what invariants 2+4
  compose to; keep it.

## 3. In flight: the open PRs

Eight branches exist and render; none is merged. Adopting or rejecting any of
them changes the roadmap below, not the principle. (#36 stacks on #1; #25
stacks on the since-merged #5.)

| PR | Adds | Where it sits in the model |
|---|---|---|
| #1 hover roots/intercepts | exact polynomial root enumeration (bigint rationals, Yun/Descartes), numeric fallback, hover markers with exact labels (√2, (1+√5)/2, "root of x⁷−x−2") | a *readout*, not a new object: the row still denotes its curve; hovering reveals derived points. Introduces the app's first exact-symbolic layer — the natural labeler for §6's solved points and phase 2's measurements |
| #6 sequences, recurrences, lists, piecewise, number theory | `a_n = …` dot plots + Σ partial-sum toggle; `a_{n+1} = …` cobwebs, and bifurcation diagrams when x is free on the right; `[…]` list literals (scatter / bar toggle); `{cond: val, …}` piecewise; gcd/isprime | several genuinely new object kinds at once. Piecewise is a value-type addition that flows through every renderer. Its `[…]` semantics collide with #31's follow-up, and its Σ/bar toggles bend invariant 3 — both resolved below |
| #17 /mcp, /g/ links, og images | MCP server validating rows through parse/classify; share pages; CPU-rendered og previews | orthogonal to the object model, with one obligation created: new row forms must keep validating through the same parse/classify pipeline (create_graph then inherits them), and each new renderer eventually needs a path in the CPU og rasterizer |
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
"Here" reflects master; open PRs appear as pending.

| Object / capability | Desmos | W\|A | Here | Disposition |
|---|---|---|---|---|
| points in polar / user coordinates | ~ (polar curves only) | ✓ | — | **adopt, §6** — #36 + field substitution already cover the base case; §6 adds the deltas |
| solutions/roots marked, exact labels | ~ (click) | ✓ | PRs #1, #36 pending | pending PRs; §6 routes complex roots through the same engine |
| intersection points of curves | ✓ | ✓ | PR #36 pending (as systems) | pending #36; §6 named-tuple form is sugar over it |
| ODEs / flows in non-Cartesian coordinates | — | ✓ | — | **adopt, §6** (needs the prime dispatch of §3) |
| time-integrated simulation (no closed form) | ~ (tickers) | — | PR #31 pending | its own decision track; composes with §6 (a simulated point in a chart) |
| named points, vector arithmetic (`A = (1,2)`, `\|A-B\|`) | ✓ | ✓ | — (defs are scalar-only) | adopt, phase 2 |
| draggable points | ✓ | — | PR #32 pending | pending #32; extend its writeback to solved points (§6) |
| segments, polygons, circles, vectors-as-arrows | ✓ | ✓ | — | adopt, phase 2 (`polyline(…)` also resolves the `[…]` collision, §3) |
| midpoint/distance/angle readouts | ✓ | ✓ | — | adopt, phase 2, via #35's PlotNote channel + #1's exact labels |
| domain restrictions `{a < x < b}` | ✓ | ~ | — | adopt, phase 3; grammar must be designed jointly with #6's `{cond: val}` braces |
| piecewise functions | ✓ | ✓ | PR #6 pending | pending #6 |
| definite integrals (value + `∫₀ˣ` as a function) | ✓ | ✓ | — | adopt, phase 3 |
| distribution zoo (uniform, exponential, t, binomial, Poisson…) | ✓ | ✓ | Normal only | adopt, phase 3; #6's bar rendering is the seed of the discrete stem/bar renderer |
| value readout for constant rows (`2+2` → "= 4") | ✓ | ✓ | plots y = 4 silently | adopt, small; #35's decided-equation notes are the sibling and its channel |
| complex constants as Argand points (`1+2i`) | ✓ | ✓ | degenerate render | adopt, small (phase 1.5) |
| complex root sets (`w³ = 1`) | ~ | ✓ | error | adopt, §6 (same solver; exact labels via #1 when polynomial) |
| sequences (stem plots), recurrences, cobwebs, bifurcation | ~ | ✓ | PR #6 pending | pending #6 |
| lists / families of objects | ✓ | ~ | PR #6 pending (literals only) | #6 covers literal scatter/bars; broadcasting families over any object remain phase 5 |
| complex parametric curves (image of a path under f) | ~ | ✓ | rejected by classifier | adopt, phase 4 (needs a complex CPU evaluator) |
| 3D vector fields / 3D ODE flows (Lorenz) | — | ✓ | 2D only (#31 states can already animate a 3D point row) | adopt, phase 4 (auto-seeded trajectories; click is ambiguous in 3D) |
| spherical/cylindrical coordinate systems | — | ✓ | fields reject z | adopt, phase 4 (substitution already suffices for surfaces) |
| surfaces of revolution | — | ✓ | — | adopt, phase 4 (`revolve(f)` desugars to an implicit) |
| space curves as intersections of two surfaces | — | ✓ | — | later — the non-square (2-of-3) extension of #36's systems, which are square-only |
| tables / data / regressions | ✓ | ✓ | — | **rejected for now** (no data model; #6's list literals edge toward it — revisit then) |
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
3. Whole-expression forms: `domain` / `conformal` / `iter` / `tube` (and the
   phase-2/3 wrappers: `polyline`, `segment`, `polygon`, `circle`,
   restrictions).
4. Tuples by free vars: none → point; u(,v) → parametric; x,y → vector field.
5. Inequalities → regions; equations → implicit curve/surface; a comparison
   with no free variables → decided note (#35); complex equations → root
   point set (§6) instead of today's error.
6. Bare scalars: x → graph; x,y → scalar field; complex → field lines;
   constant → horizontal line **plus a "= value" readout**; constant complex
   → Argand point.

Everything else keeps failing loudly with a suggestion.

## 6. Design: positional objects in user coordinate systems

### The gap

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

Phases assume nothing about the open PRs; each line says what changes if the
relevant PR is adopted first.

| Phase | Contents | Size |
|---|---|---|
| 1 — coordinate objects | position rows, chart parametrics, flow rows. On #36: the five deltas of §6. Without it: §6's standalone engine, named-tuple form only | M (S if #36 lands) |
| 1.5 — coherence wins | complex roots `f(w) = c` (+ #1 labels); Argand points for complex constants; "= value" readouts on constant rows through #35's PlotNote channel | S |
| 2 — geometry | tuple-valued constants + vector arithmetic (`A = (1,2)`, `\|A-B\|`), named draggable points (on #32's writeback), `polyline`/`segment`/`polygon`/`circle`/`vector` arrows (settling §3's `[…]` collision), measurement readouts | M–L |
| 3 — analysis | restrictions `{a < x < b}` (grammar designed jointly with #6's piecewise braces), piecewise (or adopt #6's), definite integrals (value, `∫₀ˣ` via CPU LUT texture, area shading), distribution zoo with discrete stem/bar rendering (seeded by #6's bars) | L |
| 4 — space | fields over z (spherical/cylindrical surfaces by substitution), 3D flows with auto-seeded trajectories (Lorenz), 3D arrow fields, `revolve()` | L |
| 5 — families | lists broadcasting over any object kind (#6's literals are the seed); then sequences-as-lists interop, scatter/data | XL |

Independent decision tracks, orthogonal to the phases: #31 (simulation
states — a definition kind; decide the §3 prime dispatch with it), #35
(decided comparisons — adopt early; later phases want its PlotNote channel),
#1/#32 (readouts and dragging — phase 1.5/2 build on them but don't require
them), #17/#25 (infrastructure and styling; #17 obliges new renderers to
add an og-rasterizer path).

Phase 1 first: it is the user-visible gap this document exists for, it
*completes* invariant 1 rather than complicating the model, and — with #36
in flight — it is the cheapest it will ever be.

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
