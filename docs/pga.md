# Projective geometric algebra: points, lines and planes as values

Plan, 2026-09-27. Follows docs/clifford.md, which made multivectors of R²
and R³ a value type. This adds the projective algebras Cl(2,0,1) and
Cl(3,0,1) (PGA), so geometry is spelled with meet and join instead of
hand-written formulas, and rigid motions compose and interpolate.

Status: **agreed 2026-09-27** — the three open questions below were
settled as recommended: the algebra stays hidden behind meet/join,
`line(A, B)` becomes a value (consistent with docs/multisets.md), and
conformal GA is out of scope. **Phases 1–3 built 2026-10-05** (see "As
built" at the end); phases 4–5 (motors as user syntax, examples) remain.

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
  internal `[pga]` node (like `[mv]`) tagged with what it is. *Decided:*
  the degenerate basis (`e_0`, `e_0x`, …) is not exposed yet; the names
  clash with nothing and can be added later for people who want to
  compute in PGA directly.
- **Points stay tuples.** A 2D or 3D point converts to a PGA point on
  entry, and a finite PGA point converts back to a tuple, so every
  existing construction (`midpoint`, `polygon`, dragging) keeps working on
  the result of a meet.
- **`line(A, B)` becomes a line value that draws exactly as today.** In
  the plane it still renders as the implicit line; the change is that it
  can now be named and passed to meet, distance and reflect. In space it
  becomes possible at all (drawn as a segment across the view box).
  *Decided:* old links draw identically, and `line(A, B)` inside
  arithmetic changes from an error to a value — under the multiset rules
  below.
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
- **CGA is out of scope** (*decided*) for this plan (circles and spheres
  through points, inversion — Cl(4,1), 32 coefficients). PGA covers flats;
  round objects keep `circle(A, r)`. Revisit after PGA ships.

## Consistency with the multiset foundation (docs/multisets.md)

Lines and planes are values like any other, so every rule there applies
unchanged; phase 2 and 3 tests pin each one.

- **Names are identical, literals separate (§1).** With `P = [A, B]`,
  `join(P, C)` is two lines, and `L = join(P, C); meet(L, L)` pairs each
  line with itself (two lines back), never the four cross pairs;
  `meet(join(P, C), join(P, D))` crosses its separate literals as §1 says.
- **A multiset argument broadcasts** like any other: `meet(L, H)` for a
  line and a family of planes `H` is the multiset of crossing points,
  drawn as dots and reducible (`mean(meet(L, H))`, `count(…)`).
- **Drawn as its values (§5).** A line or plane has no x, y or z, so a row
  holding one draws it — the set of points it is — rather than being
  drawn per pixel as a filter. In the plane that picture is produced by
  the implicit-line shader, as today; that is a renderer detail, not a
  change of kind, so `L = line(A, B)` and `line(A, B)` draw the same.
- **A value means the same inside a figure and out (§9).** `polyline`,
  `polygon` and friends consume the tuples a finite meet converts to;
  a line or plane handed to a figure is an error that says what it is,
  as a matrix handed to a scalar function is.
- **Order lives in tuples (§3).** `join(A, B, C)` takes its points in
  order (the plane's orientation, hence the sign of a signed distance),
  so it takes separate arguments or a tuple, never a bracket.
- **Ideal points are values too.** Parallel lines meet at an ideal point,
  which a multiset holds like any other element; it draws nothing and
  reads out as a direction, and `count` includes it.

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

## As built (phases 1–3)

- **lib/pga.ts** holds the algebra (blades as bitmasks, e0 the bit above
  the axes), the complement J and the regressive product, points as
  J(x, y, z, 1), project, reflect, and the motor exp in closed form: for a
  bivector B with Euclidean size a and B² = −a² + π I, e^B = cos a +
  sinc(a) B + (π/2)(sinc(a) I + h(a) B I), the dual-number form of the screw
  (lib/pga.test.ts checks it against the series). Motors are not yet user
  syntax (phase 4).
- **Values.** A flat travels as `[pga](dim, grade, …coefficients)`; the
  grade comes from the construction, never from which coefficients are
  zero. lib/geom.ts `lowerFlat` builds them from `line`, `join`, `meet`,
  `plane`, `project`, `reflect` and written-in nodes; a point is converted
  to its tuple wherever a value is wanted (`flatValue`), so `midpoint`,
  `polygon` and naming (`X = meet(…)` names a point) all take it. A line or
  plane in arithmetic is an error that says what it is.
- **line(A, B) on a row of its own** keeps the old implicit-line path, and
  lib/pga-values.test.ts pins its GLSL against shader keys recorded on main
  (lib/pga-line-glsl.fixtures.ts). A named `L = line(A, B)` becomes a line
  value (lib/geom.ts `lowerLineValue`), so the row `L` draws the same line
  by the new formula. In space `line(A, B)` is now allowed.
- **Named lines and planes** are stored with the named multivectors
  (`defs.multivectors`, written in by name) — they are internal nodes the
  same way; row-kind and highlight label them by their grade.
- **Drawing** (lib/pga.ts `flatFigure`): a point its tuple; a line of the
  plane or a plane its implicit equation; a line of space the curve where
  two planes through it cross (the planes through the line and the axis it
  is least along, and through the line and that plane's normal), each
  term kept even when its coefficient is the literal 0, so a constant line
  still mentions z. Planes draw as the app's implicit surfaces, so the
  translucent quad of the table above is not built; the /g/ preview falls
  back to the static card for a plane, as for any implicit surface that is
  not z = f(x, y).
- **Readouts** (lib/pga.ts `flatText`) through a `flat` flag on the tuple
  readout; the public kind is `flat`.
- **Measures.** distance from a point to a line or plane, and between
  flats (0 where they cross, the gap where parallel, |L ∨ M|/|d × e| for
  skew lines); angle between lines and planes is the acute angle.
- **Examples** (web/examples.ts): the orthocentre and Desargues' theorem
  under "geometry", and a turning cube's shadow (`hull(project(W, G))`)
  under "matrices, rotations + hulls". The two planes' line waits for planes
  that draw translucent — opaque, they hide the line — and the screw motion
  for motors (phase 4).
- **Multisets** work through the existing object-list expansion: a list
  of lines or planes is a list of `[pga]` nodes, a name moves together
  (`L = join(P, C); meet(L, L)` gives two results), `count` takes lines and
  planes, `mean`/`total` take a multiset of meets as points, and other
  reductions refuse lines, planes and (newly) multivectors with a message.
