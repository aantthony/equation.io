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
expanded: the Christoffel symbols Γᵏ_ij = gᵏˡ (S_ij · S_l) are expanded
symbolically (the same as ½gᵏˡ(∂_i g_jl + ∂_j g_il − ∂_l g_ij), which the
tests check) and the curve is traced as it is drawn — not run as a state,
so it is a whole curve at once and moves with sliders, t and a dragged
start point. lib/surface-geometry.ts traceGeodesic integrates
u″ = −Γᵘ_ij u′ⁱu′ʲ with adaptive Dormand–Prince 5(4) steps, putting the
velocity back to unit length in the metric after each, so the arc length is
the step variable and the drawn length is the one asked for; steps are at
most L/400 so it draws smoothly. It stops where it leaves the parameter
ranges (cut at the edge), unless the surface repeats across that range,
found numerically (a torus, a sphere's longitude), where it runs on; and
where det g falls below 1e-12 of max(E, G)² or a step stops being finite (a
pole), ending at its last good point. The default length is twice the
diagonal of the surface's bounding box: a little more than once round a
sphere. A list of starts, directions or lengths draws a family (at most 64).
On an `on(…)` panel `geodesic(P, d)` takes the panel's surface and is
traced in x and y, then carried onto it. Deferred: geodesic circles and the
exponential map, parallel transport, and colouring a curve by κ.

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
