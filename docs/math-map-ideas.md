# Ideas from the "Mathematics Universe" learning map

Notes, 2026-09-27. A survey of the concepts on the hand-drawn "Mathematics —
a learning map" poster against what equation.io already draws, checked
against web/public/llms.txt. Each idea below is a candidate, not a plan:
one that gets picked up should get its own doc (as docs/pga.md did).

Status: **ideas** — nothing here is agreed, except 1, 2 and 5, which are
implemented (the "suggested first three"; marked below).

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
have κ/τ combs). Deferred: surfaces coloured by Gaussian or mean curvature,
and geodesics.

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

**Implemented (Hamiltonian).** `hamiltonian(H)` takes H(x, y) with x as q
and y as p — the plane's axes, as in the existing phase portrait
`(x', y') = (y, -sin(x))` — and draws the flow as streamlines over the
level sets of H (lib/defs.ts, lib/plot.ts, and the link preview). Deferred:
`lagrangian(L)` (it needs the Euler–Lagrange equations solved for the
accelerations and run as states — not trivial), and Poincaré sections.

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

**Implemented.** `eigen(M)` for 2×2 and 3×3 reads out the eigenvalues in
closed form (a complex pair as a ± bi) and draws each real eigenvector's
invariant line with the arrow λv (lib/glyphs.ts). `transpose(M)` is new;
`det(M)` and `M^-1` already existed, so no `inverse`. Deferred: `svd(M)`
(`action(M)` already draws the circle-to-ellipse picture whose axes are the
singular vectors), and larger matrices.

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

- `fourier(f)` plots the spectrum of a function (or of a data column).
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
