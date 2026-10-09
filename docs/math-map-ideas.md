# Ideas from the "Mathematics Universe" learning map

Notes, 2026-09-27. A survey of the concepts on the hand-drawn "Mathematics —
a learning map" poster against what equation.io already draws, checked
against web/public/llms.txt. Each idea below is a candidate, not a plan:
one that gets picked up should get its own doc (as docs/pga.md did).

Status: **ideas** — nothing here is agreed, except 1 and 5, which are
implemented (1 for curves and surfaces), and 2, which was tried and dropped in favour of existing rows
(the "suggested first three"; marked below).

## Already covered

Analytic geometry, graphing, polar coordinates (coordinate fields),
trigonometry, calculus (symbolic d/dx, integrals with shading), vector
calculus (grad, div, curl, laplacian, jacobian, hessian), differential
equations (states, slope fields, orbits), complex variables (domain
coloring, conformal maps, complex roots and paths), fractals (`iter`),
probability and statistics (random variables, `P`, `E`, `hist`,
regression), power series and Fourier series (via `sum`), matrices and
tensors, quaternions and Clifford algebra (docs/clifford.md), cellular
automata. Projective geometry is planned in docs/pga.md.

## Candidates

Ordered roughly by value for effort. "Builds on" names the existing
machinery that makes each one cheap.

### 1. Differential geometry of curves and surfaces

**Implemented (curves).** `curvature(C)`/`curvature(C, u0)` (signed in the
plane), `torsion(C)`/`torsion(C, u0)`, `osculating(C, u0)` and
`frame(C, u0)` expand symbolically in lib/curves.ts, called from lib/defs.ts
like grad. Without u0 the scalars are functions of u, plotted with
`(u, curvature(C))`; colouring the curve by κ is not done (3D curves already
have κ/τ combs).

**Implemented (surface curvature).** `gaussian(S)` and `meancurvature(S)`
expand in lib/surface-geometry.ts, called from lib/defs.ts as the curve
operators are: K = (L′N′ − M′²)/W⁴ and H = (EN′ − 2FM′ + GL′)/(2W³), with
n = S_u × S_v not made unit, L′ = S_uu · n (and so on) and W² = n · n taken
from the cross product rather than EG − F² (the reason curves.ts takes κ
from r′ × r″), so K needs no square root. H's sign is n's: negative where
the surface bends away from S_u × S_v. `gaussian(S, u0, v0)` reads a
number. `mean` was taken (the mean of a list), hence `meancurvature`.
Alone on a row, `gaussian(S)` is rewritten to `[paint](S, K)` (lib/geom.ts
PAINT_CALL), which classify unwraps into the parametric surface with a
`paint` scalar; the surface shader colours it on a diverging scale (row
colour for K > 0, its complement for K < 0, grey at 0) with a gain set on
the CPU from the 90th percentile of |K| over the surface, so any size of
surface reads. On an `on(…)` panel `gaussian(x, y)` is K of the panel's
surface, painted as a field with the same gain (docs/axis-maps.md).

**Implemented (geodesics).** `geodesic(S, (u0, v0), (du, dv)[, L])` is a
whole row, classified in lib/analysis.ts (as an orbit is) rather than
expanded, and traced in the trace worker — not run as a state, so it is a
whole curve at once and moves with sliders, t and a dragged start point.
Only S's first and second derivatives (15 components) are expanded
symbolically; at each point E, F, G, EG − F² and the Christoffel symbols
Γᵏ_ij = gᵏˡ (S_ij · S_l) are formed from those numbers in plain arithmetic
(connectionAt — the same as ½gᵏˡ(∂_i g_jl + ∂_j g_il − ∂_l g_ij), which the
tests check against christoffelOf). Compiling the six symbols separately
repeated the metric in each, and cost ~20× as much per step.
lib/surface-geometry.ts traceGeodesic integrates u″ = −Γᵘ_ij u′ⁱu′ʲ with
adaptive Dormand–Prince 5(4) steps, as long as the accuracy allows (a plane
is a handful), putting the velocity back to unit length in the metric after
each, so the arc length is the step variable and the drawn length is the
one asked for; each step is filled in for drawing by its cubic Hermite
interpolant (dense output, no more evaluations). It stops where it leaves
the parameter ranges (cut at the edge, along the interpolant), unless the
surface repeats across that range, found numerically (a torus, a sphere's
longitude), where it runs on; where det g falls below 1e-12 of max(E, G)²
or a step stops being finite (a pole), ending at its last good point; and
where its budget runs out. A family shares 200 000 steps, 1 s of worker
time and 48 000 drawn points among its members (at most 64), so a fan of
long geodesics comes out shorter rather than holding the worker, and the
row's note says where (geodesicCutNote). A trace is keyed by the plan as
well as the values it reads (geodesicPlanKey), so an edit to S, to a list
of directions or to the panel's surface traces it again. The last
traced geodesic keeps drawing until the next arrives, and a traced one asks
for a frame of its own only when none comes within 50 ms anyway, so a drag
or t does not pay for extra frames. The default length is twice the
diagonal of the surface's bounding box: a little more than once round a
sphere. On an `on(…)` panel `geodesic(P, d)` takes the panel's surface and
is traced in x and y; the worker places its points on the surface, so the
panel need not carry them. Deferred: geodesic circles and the exponential
map, parallel transport, and colouring a curve by κ.

**Implemented (metrics on a plane panel).** A row `ds^2 = …` gives a plane
panel a metric of its own, which need not come from an embedding
(lib/metric.ts): a quadratic form in the differentials of the panel's two
coordinates — x and y, or two coordinate fields such as
`r = sqrt(x^2 + y^2)` and `phi = atan2(y, x)` — and of at most one more
coordinate τ that no component depends on (a static or stationary
spacetime's time). `d<name>` is a differential only in that row, so `d/dx`,
`∫ … dx` and a slider named `dr` mean what they did. The components are
taken as ½ ∂²Q/∂dᵢ∂dⱼ of the right side with the differentials renamed out of
reach of the resolver, and checked at sample points (with sliders at their
values) for being the whole form, for the coordinates' Jacobian, and for a
signature a geodesic can be traced in. `geodesic(P, d)` then follows the
metric (unit speed with no τ; a massive particle with coordinate velocity
d(x, y)/dτ with one, refused faster than light), and `lightray(P, d)` is its
null geodesic, affine parameter normalised to dτ/dλ = 1 at the start.

The metric is pulled back to x and y through the Jacobian of the written
coordinates rather than integrated in them and mapped back, which would need
the inverse of r, phi(x, y) that the document never states; the pullback
g_xy = Jᵀ g J and its derivatives are formed in numbers at each point
(metricReader), several times cheaper than writing them out symbolically.
The integrator is lib/surface-geometry.ts traceGeodesic, generalised to a
GeodesicFlow (a surface's connection, or a metric's) whose state may carry
more than position and velocity: a metric with τ carries U^τ (τ itself is
never needed). After each step U is put back on g(U, U) = κ (1, −1 or 0):
rescaled for unit speed or a massive particle, U^τ re-solved for light.
Solving U^τ from the conserved energy E = −g_τμ U^μ instead (a first
version) divides by g_ττ, so it stopped at a spinning hole's ergosurface,
where g_ττ = 0, rather than its horizon. Orbits precess as they should (tests:
2π((1 − 6M/r)^−½ − 1) per orbit near a circle, which is 6πM/r to first
order; the photon sphere; 4M/b deflection; Poincaré geodesics on the unit
circle; equatorial Kerr into its ergoregion and down to its horizon). It
stops where the metric stops being Riemannian, or stops having x and y as
space with det g < 0 — checked at every stage of a step, as a horizon is
finite but wrong inside — or grows or shrinks 10⁸ times, where it makes no
headway (a ray crawling into a horizon, toward y = 0 in the half-plane), at
a box round the window (traceWindow: four times the window, on a lattice,
so small pans and zooms keep the trace) grown to take in the start, and,
with no length given, once it has drawn as far as that is across, or once
32 steps move it less than a thousandth of the most any of the four
stretches of 32 before did (a crawl into a horizon, whatever the zoom), or
once dτ/dλ has grown 10³-fold while the metric degenerates (|det g|/size³
down 10⁴-fold) — the coordinates freezing at a horizon, round which a ray
falling into a spinning hole would otherwise creep for tens of thousands of
steps; a rate that grows where the metric stays sound (a conformally flat
metric's light ray far out) runs on — or once a whole turn of its velocity
ends within a hundredth of the turn's length of where it began after the
rate has grown tenfold (winding round a near-extremal hole's horizon; a
stable orbit keeps its rate). The 10⁸ range is relative to the metric at
the start, not to the window: the half-plane's geodesic from y = 1 ends at
y ≈ 10⁻⁴, which shows only zoomed in close to the boundary. Inside
the window's box steps are held to 1/400 of it, so none strides over a
black hole between stages, and points are drawn finely; outside it, eight
times coarser, and further off coarser still in proportion to the distance
(steps a fiftieth of it), so a ray sent from 10⁵ away arrives in a few
hundred steps. The reader allocates nothing per point. It runs in the trace
worker; a metric's family member gets at least 150 ms, unless that would
make the family take over 3 s. Its points are a real cap on the family
(48 000, shared; a lone orbit may use them all), met by giving up points
where the line runs straight: walking it, one is kept once the line has
turned more than θ since the last kept, or run on a set length, with the
smallest θ that fits (decimate) — so tight turns keep theirs. A metric is checked
at sample points over scales from 0.001 to 100 000 round the origin, so a
disc of radius 0.1 and a hole of mass 10 000 both pass; a small feature far
from the origin could still be missed. Follow-ups: tidal glyphs (the
geodesic deviation tensor), time-dependent metrics (τ not cyclic: a third coordinate in the
state, and t meaning both), more coordinates (3D slices, Kerr off the
equator), metrics on mapped (`view`) panels, hover readouts along a
geodesic, and the link preview, which falls back for these rows.

**Implemented (spacetime diagrams and light cones).** A ds² row with no
third coordinate may now be Lorentzian in the panel's own two, making the
panel a spacetime diagram: `-dy^2 + dx^2`, Schwarzschild's r and t
(`-(1 - 2M/x) dy^2 + dx^2/(1 - 2M/x)`), ingoing Eddington–Finkelstein
(`-(1 - 2M/x) dy^2 + 2 dy dx`). The sample check counts positive definite
and Lorentzian points; a metric Lorentzian anywhere is a diagram, one that
is positive definite too is of mixed signature (a uniform field
`-(1 + 2 g x) dy^2 + dx^2`, `-cos(x) dy^2 + dx^2`), and each geodesic takes
the kind at its start, stopping where it changes — so a metric positive
definite everywhere checked (Poincaré's) traces exactly as before. One that
is neither anywhere (−dx² − dy²) is refused. Which coordinate is time is
the metric's business. `geodesic(P, v)` is a
particle with coordinate direction v, U = v/√(−g(v, v)) and proper time
its length, refused as the row's note when v is not inside the cone;
`lightray(P, d)` snaps d to the nearest of the four null half-lines by
angle in x and y (rather than asking for d near null: the null lines move
as P is dragged, and any tolerance would make a row fail somewhere), with U
of unit length in the panel at the start. After each step U is rescaled to
g(U, U) = −1 or projected onto its null line. It stops where det g ≥ 0, the
metric grows 10⁸-fold, or U runs 10³-fold while |det g|/size² falls
10⁴-fold — Schwarzschild's t freezing at r = 2M (the particle creeps up the
line x = 2M to the box's edge); EF carries it through to r → 0 in proper
time π(r³/8M)^½ from rest (tested).

`lightcones` (a row) and `lightcone(P)` (lib/light-cone.ts) draw light
cones on the CPU once per view change, as one Path2D per row (a fill and
two strokes, however many glyphs), on a lattice anchored in the plane like
the tensor-field glyphs (power of two nearest 56 px). On a diagram, the null
angles are (φ ± α)/2 from g(e_θ, e_θ) = A + R cos(2θ − φ), and the future
half is the one along which the time coordinate τ increases, dτ(axis) > 0,
τ being the coordinate of the first term written as a squared
differential with a minus sign (subtracted, or a unary minus or negative
number among its factors; signs inside a sum factor do not count), else y.
Inferring τ from the metric's values failed: a vote by counts turned with a
slider's scale (de Sitter's static patch), and a flatness score could not
decide `-k x dy^2 + dx^2/(k x)` (two equally flat points) — the values
cannot tell -f dt² + dr²/f from the same metric with f → −1/f. How the row
is written can, and is the physics convention. An orientation by the sign of
g(axis, ∂τ) fails inside Eddington–Finkelstein's horizon, where ∂_v is
spacelike; dτ does not, since v increases on every future cone there. It
changes only where a cone straddles dτ = 0, and where the axis is exactly
along it (inside Schwarzschild's horizon in r and t) the other coordinate
decreasing is the future: smaller r. A fixed 15 px wedge to the future and
strokes to the past. With a time, the coordinate light-speed indicatrix: (v − c)ᵀ h
(v − c) = K with c = −h⁻¹β, K = βᵀh⁻¹β − g_tt, drawn round a dot at one
power-of-two scale per panel from the median ellipse in view (a third of a
cell), so sizes compare: light slows toward a horizon (1 − 2M/r across,
√(1 − 2M/r) round, tested), Kerr's ellipses are dragged in +φ for a > 0
and leave their dots inside the ergoregion. A lone lightcone(P) uses the
same scale (its own, when no lattice ellipse is in view); a lattice
ellipse wider than its cell is left out, and so is one behind a horizon:
a grid at half the lattice spacing (at most 2000 nodes) is flood-filled
from seeds known to be outside — its corners and side middles from which a
ray out to a thousand times the view, in steps growing 30%, meets no
horizon — through nodes where x and y are space and along edges with no
horizon inside them: an edge where x and y's metric is large (4× the
grid's median) or doubles is checked at 31 points between, so a nearly
extremal hole's band (a = 0.9999: 0.03 wide) is not leaked through, and a
view wholly inside r₋ is cut off whole. A sweep of 180 views (pans and
zooms from ±0.8 to ±12 at 400–1920 px) at a = 0.9 … 0.9999 drew no
ellipse inside r₋; the cut-off takes 6–8 ms (median, 13–17 at the 90th
percentile) in Node and is recomputed only when the lattice cells in view
change. The metric is compiled once per panel for all its light-cone
rows, and the scale, the cut-off and a lattice's glyphs are kept while the
zoom and the lattice cells in view stay, so a pan within a cell recomputes
nothing (a pan across one: ~5 ms of metric reads in Node for 1080p Kerr,
from ~1.2 s with a march per point). A geodesic that stops where a mixed
metric's signature changes (by a failed step, or crawling up to the line
where it degenerates, as a uniform field's light ray does) says so in the
row's note. Follow-ups:
light cones in 3D panels (not drawn there yet) and on mapped panels, a
time orientation the user can choose (`lightcones(T)` with a future
direction), the cone's tilt as a readout on hover, the link preview
(falls back), and drawing the past half of an indicatrix's cone.

**Implemented (curvature of a metric).** On a panel with a ds^2 row,
`gaussian(x, y)` alone on a row paints the metric's Gaussian curvature K on
the diverging scale of #255's surfaces, per pixel, with a gain from the
90th percentile of |K| over the view (kept until the view or a value it
reads changes); hovering where no curve is near reads K. `gaussian(P)` is
the number at a point (lib/metric-curvature.ts). K is Brioschi's formula,
from E, F, G and their first and second derivatives with no square root,
which is R₁₂₁₂/det g for any signature: for a 2D Lorentzian metric K = R/2
(de Sitter-like positive, 2M/r³ for Schwarzschild's (t, r) plane). It is
taken in the coordinates the metric is written in (r and phi, with other
coordinate fields written in them) and then composed with the coordinate
map, since K is a scalar: the pull-back to x and y would need the map's
third derivatives, and in float32 a flat `dr^2 + r^2 dphi^2` read that way
is noise. Only a metric mixing x and y with fields of them is pulled back
first. With a time it is K of the slice t = constant (g's spatial block),
the curvature of space at one instant — Flamm's −M/r³ for Schwarzschild —
masked where the slice is not positive definite (inside a horizon). The
gain counts only samples where K is real: above 10⁻⁶ of the terms it is
the difference of (carried as `rounding` beside the field), and — for a K
pulled back to x and y, whose terms can be as small as its K — above
10⁻⁹·min(1/R, 1/R²), R the view's half-size or its distance from the
origin if more (so zooming in at r = 1000 still shows K = −10⁻⁹). Known
limit: below R ≈ 10⁻⁶ a pulled-back K's rounding beats that floor (a flat
mixed metric at ±10⁻⁶ reads K ≈ −0.001 on hover, though nothing visible is
painted); a fix would take the terms' size from the written g and J. Where
under 1% of samples are real the gain is 0 (nothing painted, hover reads
0); the typical size is at least a thousandth of the largest, so a local
bump's thin tail does not saturate (lib/metric-curvature.ts curvatureGain;
divergingGain applies that cap only to a metric's K, so #255's surfaces
are as they were). A constant K is one even tint. In the app the
evaluators are compiled once per row and gainRead schedules reads: a K in
its own coordinates is read finely (25 × 25, ~5 ms) at most every 120 ms
as things move; a pulled-back one on 13 × 13 then, finely at least every
500 ms, or ten times a fine read's cost if more (so t-animated metrics
settle without taking over the main thread), and once things stand still. The
link preview shades with the same gain, sampling K every 4 pixels (each
pixel where a cell meets an undefined part, like a horizon's disc), and
falls back for a pulled-back K. `-gaussian(x, y)` and `c gaussian(x, y)`
are shaded the same way, the row's note saying which colour is which. Follow-ups: the Riemann and
Ricci tensors for 3+ dimensions (a 3D slice, Kerr off the equator), tidal
glyphs (the geodesic deviation tensor, from R^a_bcd). On a spacetime
diagram (a 2D Lorentzian panel) `gaussian(x, y)` is K = R/2 where the
metric is Lorentzian, the plane's K where a mixed metric is positive
definite, and undefined where it degenerates (tested: 2M/r³ in
Schwarzschild's r and t and in Eddington–Finkelstein's, 0 for Rindler,
±1/L² for de Sitter and anti-de Sitter).

- `curvature(C)` and `torsion(C)` of a parametric curve in u, as a
  scalar along the curve (color the curve by it, or read out at a point).
- `osculating(C, u0)` draws the osculating circle; `frame(C, u0)` the
  Frenet frame (T, N, B), animatable with t as u0.
- Surfaces colored by Gaussian or mean curvature.
- Geodesics on a parametric surface, run as a state (the geodesic
  equation is an ODE in the surface parameters).
- Builds on: parametric curves/surfaces, symbolic derivatives, states.
- Map nodes: Differential Geometry, Riemannian Manifolds, Metric Spaces.

### 2. Hamiltonian and Lagrangian mechanics

**Tried, then dropped: `hamiltonian(H)`.** A first version drew the flow
(∂H/∂y, −∂H/∂x) as streamlines, which is exactly the vector-field row
`(x', y') = (y, -sin(x))`, plus H's level sets. Even with the levels drawn
over the flow and the separatrices found and drawn bold, it added one
spelling for what two existing rows already say: the flow, and `H = c` as
an implicit curve for the orbit that matters. The examples now do that
(`y^2/2 - cos(x) = 1` beside the pendulum). Deferred: `lagrangian(L)` (it
needs the Euler–Lagrange equations solved for the accelerations and run as
states — not trivial), and Poincaré sections.

- `hamiltonian(H)` in (q, p) draws the level sets of H and the flow
  (q' = ∂H/∂p, p' = −∂H/∂q) as streamlines.
- `lagrangian(L)` derives the Euler–Lagrange equations symbolically and
  runs them as states, so a double pendulum is one row plus sliders.
- Phase portraits and Poincaré sections as a view on existing orbits.
- Builds on: states, vector fields, symbolic d/dx.
- Map nodes: Classical Mechanics, Symplectic Manifolds, Calculus of
  Variations.

### 3. Complex integrals and residues

- A contour integral along a complex path in u,
  `int(f(w) dw, path)`, read out as a complex number and drawn with the
  path.
- `winding(path, w0)` and `residue(f, w0)`; poles marked with their
  residues, so Cauchy's residue theorem can be checked by dragging the
  contour.
- Builds on: complex paths, integrals (quadrature fallback), complex
  roots (for locating poles).
- Map nodes: Complex Variables, The Complex Integral, Cauchy's Integral
  Theorem, Residues.

### 4. Riemann surfaces

- Multi-valued functions (`sqrt(w)`, `log(w)`, `w^(1/3)`) drawn as a 3D
  surface over the w-plane — height re or im — with the sheets joined
  across the branch cut instead of a jump.
- Builds on: 3D parametric surfaces, complex evaluation.
- Map nodes: Riemann Surfaces, Complex Manifolds.

### 5. Eigenvalues and matrix theory

**`eigen(M)` moved to a follow-up (branch eigen-numeric).** The closed-form
symbolic 3×3 blows the node cap and rounding decides real vs complex, so it
will be redone numerically. `transpose(M)` is in; `det(M)` and `M^-1`
already existed, so no `inverse`. Deferred: `svd(M)` (`action(M)` already
draws the circle-to-ellipse picture whose axes are the singular vectors),
and larger matrices.

- `eigen(M)` returning eigenvalues (readout, complex where needed) and
  eigenvectors; eigenvectors drawn as the invariant lines of the matrix
  field.
- `det(M)` shown as the signed area (volume) of the transformed unit
  square (cube); `inverse(M)`, `transpose(M)`, `svd(M)` as the
  circle-to-ellipse picture.
- Builds on: matrix values, matrix fields, rotations via `exp`.
- Map nodes: Linear Algebra, Matrix Theory.

### 6. Non-Euclidean geometry

- A view mode, e.g. `view(model = poincare)` or `halfplane`, in which
  `segment`, `line` and `circle` are hyperbolic geodesics and circles,
  and distances/angles read out hyperbolically.
- Hyperbolic tilings {p, q} as a follow-up.
- Bigger than the others: it is a new metric on the plane, not only new
  functions. Interacts with docs/pga.md (the projective model).
- Partly there: `ds^2 = (dx^2 + dy^2)/y^2` makes a panel the half-plane
  model, and `geodesic(P, d)` draws its geodesics (see 1); segments,
  circles and distances in the metric are not done.
- Map nodes: Non-Euclidean Geometry, Hyperbolic, Riemannian.

### 7. Fourier analysis

**Implemented (spectrum and reconstruction).** `fourier(signal, samples)`
draws a one-sided amplitude spectrum, and `reconstruct(signal, N, samples)`
returns a periodic expression in x with the signed mean and first N
harmonics. A continuous signal is read over the one interval in it, which is
its variable and period (`s = interval(0, 1); fourier(f(s))`), so no name is
bound implicitly; ordered samples (including CSV columns sorted by row
position) span [0, 1) or a given interval. The examples show linked
original/reconstructed signals and a spectrum. Deferred: epicycles and
wavelets.

- `fourier(f(s))` plots the spectrum of a function over an interval s (or of a data column).
- Epicycles: a closed path in u drawn by its chain of rotating circles,
  with N terms on a slider.
- Wavelets as a later extension (a scalogram is a scalar field).
- Builds on: `sum`, integrals, complex values, lists.
- Map nodes: Fourier Analysis, Wavelets, Functional Analysis.

### 8. Graph theory

- `graph(E)` from an edge list of named points or index pairs, with a
  force-directed layout when positions are not given.
- `adjacency(G)` as a matrix value, so spectral readouts come from #5.
- Standard families (`complete(n)`, `cycle(n)`, `petersen`) as examples.
- Builds on: named points, `segment`, lists, matrices.
- Map nodes: Graph Theory, Combinatorics, Matroids.

### 9. Special functions and orthogonal polynomials

- `legendre(n, x)`, `chebyshev(n, x)`, `hermite(n, x)`, `laguerre(n, x)`,
  `besselj(n, x)`, `zeta(s)` (complex), `beta`, `digamma`.
- Plain library additions; `zeta` under `domain(...)` is a good example
  and a way into analytic number theory.
- Map nodes: Orthogonal Polynomials, Analytic Number Theory.

### 10. Numerical analysis

- `taylor(f, a, n)` as a symbolic polynomial, n on a slider.
- Newton's method: a trail of iterates from a draggable start, and the
  Newton fractal (basins of attraction) via `iter`.
- Error readouts for quadrature/finite differences as teaching aids.
- Builds on: symbolic derivatives, `iter`, trails, recursive functions.
- Map nodes: Numerical Analysis, Power Series.

### 11. Optimisation and linear programming

- Feasible regions already work as inequality rows.
- `maximize(objective, region)` / `minimize(...)` marks the optimal
  point (vertex for a linear program) with its value as a readout.
- Gradient descent as a state with a motion trail.
- Map nodes: Linear Programming, Combinatorial Optimization, Convex
  Analysis.

### 12. Number theory helpers

- `cf(x)` continued-fraction expansion, and its convergents drawn as the
  best rational approximations (lattice points near y = x·slope).
- Ulam spiral and modular "times-table" circles as examples — mostly
  possible with lists and `isprime` today.
- Lattice points on Diophantine curves (`x^2 - 2y^2 = 1`).
- Map nodes: Number Theory, Continued Fractions, Diophantine Equations.

### 13. Group actions and symmetry

- `dihedral(n)`, `cyclic(n)` and wallpaper groups acting on a shape,
  drawing its orbit.
- Cayley graphs (with #8).
- Lie groups: SO(3) and SU(2) are partly there through quaternions and
  matrix `exp`; a one-parameter subgroup drawn as a path.
- Map nodes: Groups, Group Representations, Lie Groups, Lie Algebras.

## Smaller items

- Conics: `conic(A, B, C, D, E)` through five points, with a readout of
  its type (ellipse/parabola/hyperbola). Fits docs/pga.md.
- Cubic and quartic solving: closed-form root readouts beside the
  certified solver.
- Metric spaces: unit balls of p-norms, `norm(v, p)`.
- Topology: Möbius strip, Klein bottle and knot examples (tube already
  draws knots); winding number shared with #3.
- PDEs (heat, wave, Schrödinger in 1D) on a grid, reusing the cellular
  automaton machinery; |ψ|² for Quantum Mechanics.
- Markov chains: a transition matrix drawn as a graph (#8) with the
  stationary distribution (#5).

## Poor fits

Logic and Boolean algebra, Kripke and Chomsky theory, formal languages
and automata, Kolmogorov complexity, theory of computation, category
theory, cohomology, spectral sequences, K-theory and string theory. They
are symbolic or structural rather than something plotted; at most they
would be readouts.

## Suggested first three

1 (curvature and frames), 2 (Hamiltonian flows) and 5 (eigen): each is
small, very visual, and built almost entirely on existing engines.
