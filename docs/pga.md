# Projective geometric algebra: points, lines and planes as values

Plan, 2026-09-27. Follows docs/clifford.md, which made multivectors of R²
and R³ a value type. This adds the projective algebras Cl(2,0,1) and
Cl(3,0,1) (PGA), so geometry is spelled with meet and join instead of
hand-written formulas, and rigid motions compose and interpolate.

Status: **proposed** — the decisions marked *open* need a call before
phase 2.

## Why

Today:

- `line(A, B)` exists only in the plane, and lowers straight to an implicit
  equation: it cannot be named, intersected or measured.
- There is no plane, no line in space, and no intersection of anything
  with anything: the point where two lines cross has to be solved by hand
  (Cramer's rule in `solve`).
- Motions are `rotate` and `+ v` separately; a screw motion or an
  interpolated rigid motion has no spelling.

PGA fixes all three with one algebra. In 3D PGA a plane is a vector, a
line a bivector and a point a trivector; the outer product ∧ is the
**meet** (intersection) and the regressive product ∨ the **join** (the
span). `join(A, B)` is the line through two points, `meet(L, P)` where a
line crosses a plane, `join(A, B, C)` the plane through three points.
Parallel lines meet at an ideal point — a direction — rather than failing.
Rotations and translations are both rotors (motors), so `e^(θ/2 L)` turns
about any line in space, and slerp of motors interpolates a rigid motion.

## Decisions (proposed)

- **Geometric objects are values; the algebra stays underneath.** Users
  write points as the tuples they already are, and get lines and planes
  from constructors and from meet/join. The PGA element travels as an
  internal `[pga]` node (like `[mv]`) tagged with what it is. *Open:*
  whether to also expose the degenerate basis (`e_0`, `e_0x`, …) for
  people who want to compute in PGA directly. Recommendation: not in the
  first phase; the names clash with nothing and can be added later.
- **Points stay tuples.** A 2D or 3D point converts to a PGA point on
  entry, and a finite PGA point converts back to a tuple, so every
  existing construction (`midpoint`, `polygon`, dragging) keeps working on
  the result of a meet.
- **`line(A, B)` becomes a line value that draws exactly as today.** In
  the plane it still renders as the implicit line; the change is that it
  can now be named and passed to meet, distance and reflect. In space it
  becomes possible at all (drawn as a segment across the view box). *Open:*
  confirm this is acceptable — old links draw identically, but
  `line(A, B)` inside arithmetic changes from an error to a value.
- **New constructors:** `plane(A, B, C)`, `plane(P, n)` (through P,
  normal n), `line(P, v)`… is ambiguous with `line(A, B)`, so a direction
  line is `line(P, dir(v))` or simply `join(P, P + v)`; recommendation:
  no new line syntax, use join.
- **Operations:** `meet(a, b)`, `join(a, b[, c])`, `project(a, onto)`,
  `reflect(a, in)`, `distance(a, b)` and `angle(a, b)` extended to lines
  and planes, and `motor(…)` for rigid motions. `∧`/`∨` as operators only
  if the algebra is exposed (see above).
- **Ideal elements draw as nothing and read out as a direction:**
  `meet` of parallel lines `= at infinity, direction (1, 2)`.
- **CGA is out of scope** for this plan (circles and spheres through
  points, inversion — Cl(4,1), 32 coefficients). PGA covers flats; round
  objects keep `circle(A, r)`. Revisit after PGA ships.

## Algebra (lib/pga.ts)

The same machinery as lib/clifford.ts, with one more basis vector e0 whose
square is 0: 8 coefficients in 2D, 16 in 3D, blade bitmasks with e0 as its
own bit. The geometric and outer products need only the metric table
changed (e0² = 0 kills any product sharing e0).

- **Duality** cannot use the metric (it is degenerate): the join is the
  regressive product through the Poincaré/Hodge *complement* J (a blade to
  its complement blade, signed so that A ∧ J(A) = |A|² I). Unit tests pin
  J(J(A)) = ±A and join(A, B) through both points.
- **Normalisation:** a point's e0-complement coefficient is its weight; a
  finite point divides it out to give (x, y, z). Weight 0 is ideal.
- **Sandwich** X ↦ M X M̃ applies a motor; the matrix-free path is used,
  since a motor also translates.
- **Exp of a line** splits into rotation about it and translation along it
  (screw), closed form: e^B = cos|B_E| + … with the dual part linear.

## Drawing

| value | picture |
|---|---|
| finite point | a point (the tuple it converts to) |
| ideal point | nothing; readout gives the direction |
| 2D line | the existing implicit line shader |
| 3D line | a segment clipped to the view box, like a curve |
| plane | a translucent quad clipped to the view box, outlined |
| motor | its axis line and a sector of its turn, plus an arrow of its slide |

## Phases

1. **Algebra.** lib/pga.ts with products, complement, regressive product,
   normalisation, motors and their exp; unit tests of the classical
   identities (join of two points contains both, meet of two planes lies
   in both, a motor preserves distances, `e^(θ/2 L)` turns by θ).
2. **Values.** `[pga]` nodes, conversion to and from tuples, `line(A, B)`
   as a value in 2D and 3D, `plane(…)`, named lines and planes (written in
   like named multivectors), drawing per the table.
3. **Operations.** meet, join, project, reflect, distance and angle over
   points, lines and planes; ideal-point readouts; lists broadcast (the
   meets of a line with a family of planes).
4. **Motions.** `motor(L, θ, d)` (turn θ about L and slide d along it),
   `rotate(X, M)` accepting a motor, and slerp of motors for rigid-body
   interpolation.
5. **Examples and docs.** Constructions that are painful today: the
   orthocentre as the meet of two altitudes, Desargues' theorem with
   draggable points, the line where two planes cross, a screw motion, and
   the shadow of a polyhedron as projection onto a plane.

Each phase is a commit with its tests; phases 1–3 are the useful core and
could ship as one PR.

## Risks

- **Expression size.** 16-coefficient products are 256 multiplies before
  simplification; a chain of meets over draggable points could grow large.
  The figure-template trick (lib/glyphs.ts `over`) and structural zeros
  help; measure with the orthocentre and Desargues examples in phase 3.
- **Two meanings of ∧.** It is the tensor wedge on plain vectors and the
  outer product on multivectors already; PGA objects would make it the
  meet as well (the same product, geometrically read). Keeping the
  algebra hidden behind meet/join avoids a third reading in the syntax.
- **2D `line` regressions.** It is used in examples and saved links; the
  phase 2 tests must pin that every existing `line(A, B)` row draws the
  same GLSL.
