# Tensors, multivectors and quaternions: values drawn by what they do

Design and implementation record, 2026-09-26 (branch `clifford`, on top of
`multisets`). Phase 6 of docs/multisets.md made tensors a value type; this
adds the pictures they lacked, the Clifford algebra of the plane and of
space, and quaternions as its even part.

Decisions locked:

- **A value with no position is drawn by what it does**, alongside its
  readout: a matrix by the image of the unit square, circle and axes
  (`action(M)`), a matrix field by the image of a small circle per cell, a
  multivector by its grades. Everything drawn is an ordinary figure (or, for
  fields, one shader), so the app, the static preview and the MCP widget
  draw the same thing.
- **Multivectors are a value type, not a mode**, like complex numbers: a
  subtree becomes one only through a blade (`e_xy`), `⟑`/`gp`, `quat` or a
  multivector function. A row with none pays nothing (`mvIn`).
- **`⟑` is the geometric product.** Juxtaposition already contracts tensors
  and is an error between two vectors, so it cannot silently become the
  geometric product there. Once one side is a multivector, juxtaposition is
  the geometric product and `∧` the outer product; `∧` between plain
  vectors stays the tensor wedge.
- **A multivector written only as a number or a vector is that number or
  vector** (structurally: its other coefficients are the literal 0).
  `e_x ⟑ e_x` is 1, `grade(A, 1)` and a rotor sandwich in the plane are
  points. Structure never depends on slider values — constants stay names —
  so a row never changes kind while a slider moves.
- **Blades are always 3D**, as `e_x` is; `(1, 0) ⟑ (0, 1)` is the plane's own
  `e_xy`. Bivectors are spelled cyclically in readouts (`e_xy`, `e_yz`,
  `e_zx`), the duals of `e_z`, `e_x`, `e_y`; input takes any order with its
  sign.
- **Division by a multivector is refused**, as by a matrix: `a/2e_xy`
  (touching) reads as `a/(2e_xy)` and `e_xy⁻¹ = −e_xy` would flip it without
  a word; `a/2 e_xy`, with a space, is `(a/2) e_xy`. `B^-1`
  is the inverse, exact for every invertible multivector (below).
- **`e^A` of a bivector stays a rotor; `e^(θ B)` of a tensor bivector stays a
  matrix.** Both are the same rotation, so existing links keep their meaning.
- **Quaternions are `quat(w, x, y, z)`**, not reserved `j`/`k` (common
  slider names). i = e_zy, j = e_xz, k = e_yx, so i² = j² = k² = ijk = −1 and
  `quat(cos(θ/2), sin(θ/2) n)` is the rotor that turns by θ about n. A
  product of quaternions reads out in i, j, k while it stays even.
- **Bivector rows draw their disc by default**; `a ∧ b` of plain vectors is
  a tensor and still only reads out, as before.

## Algebra (lib/clifford.ts)

A multivector is 2ⁿ symbolic coefficients indexed by blade bitmask (bit 0
e_x, bit 1 e_y, bit 2 e_z). Products sum `bladeSign(i, j) aᵢ bⱼ` into blade
`i ^ j` (Euclidean metric), filtered for the outer product (`i & j = 0`) and
the left contraction (`i ⊆ j`). Reversion and Clifford conjugation flip
grades by sign patterns.

- **Inverse.** In the plane A Ā is a number. In space it lies in the centre,
  s + p I with I² = −1, so A⁻¹ = Ā (s − p I)/(s² + p²) for every invertible
  A, not only versors. Only s and p of A Ā are read; the other grades cancel
  identically.
- **Exponential.** The scalar and the pseudoscalar of space commute with
  everything and split off (e^s, cos p + I sin p). What remains must be a
  bivector (every bivector of R² or R³ is a blade, B² = −|B|²: cos|B| +
  B sinc|B|) or a vector (v² = |v|²: cosh|v| + v sinh|v|/|v|, its r = 0 limit
  written in). One blade is written cos b + B̂ sin b, with no magnitude.
- **slerp** normalises both ends, turns the second to the first's side (q
  and −q are one rotation), and writes sin(uΩ)/sin Ω as u sinc(uΩ)/sinc Ω,
  finite as the ends meet.
- **rotate(X, R)** applies the matrix of v ↦ ⟨R v R⁻¹⟩₁ with R⁻¹ = R̃/|R|²,
  so it reaches every figure and point list through the existing transform
  pushing (object-lists.ts `pushTransforms`).

## Lowering and drawing

`lowerMv` (geom.ts) builds a multivector from a subtree, memoised per node
like `lowerTensor`, and steps ahead of tensor and matrix algebra wherever
one appears. A named multivector (`R = …`) is stored as its internal `[mv]`
node and written into every row that names it during resolution, as a
named interval is (`ResolveOpts.multivector`). At the root a multivector is
the `[mv]` node; classify turns it into a family of figures with a
`readout` (a `tuple` with `blades`):

- vector — an arrow from the origin;
- bivector — a disc of area |B| in its plane, with an arrow round an inner
  arc for its sense; in space the plane's basis is the closed-form
  orthonormal pair of Duff et al. (2017) about the dual normal;
- trivector — a cube of volume |p|;
- a quaternion, or any rotor (a scalar and a bivector, nothing odd) —
  instead, the rotation it makes: an arrow along the axis |q| long and a
  filled sector of radius |q| sweeping θ = 2 atan2(|v|, w). The disc of the
  bivector alone would ignore w, so a slider on a quaternion's scalar part
  moved nothing. A pure bivector keeps its disc (unless written with quat).

The rim and the arc are one vertex template over columns of cos θ and
sin θ (`over`), so a large coefficient (a slerp's) is written once rather
than per vertex.

`action(M)` lowers to `[action]`, drawn as the filled image of the unit
square (cube), the image of the unit circle and the columns as arrows; a
multiset of matrices (`action(M)` with a list in an entry) draws each one's
glyphs in one figure family and reads each matrix out. A
2×2 matrix in x and y is a `tensor-field` (public kind `tfield2d`): the
shader (render2d.ts `tfieldFrag`) finds each fragment's cell — a power of
two in plane units, so glyphs pan with the plane — and tests the ring
|adj(A) q| = |det A| in pixel space, which also draws a singular matrix's
segment. The glyph scale is tanh(σ₁)/σ₁ (glyphs.ts `glyphScale`): true size
while small, one cell at most; det < 0 draws in the complement colour.
`streamlines(M)` (lowered to `[streamlines]`, unwrapped in classify) or
the row's toggle swaps the glyphs for tensor streamlines
(render2d.ts `tlinesFrag`): the vector-field LIC, along the major eigenvector
of the symmetric part, half the angle of (a − d, b + c) (glyphs.ts
`majorAngle`). An eigenvector has no sign, so each step takes the ±e that
continues the last; streaks fade where the part is isotropic.
`jacobian` and `hessian` expand beside grad/div/curl.

The quaternion Julia set is written in user space: a recursive function
whose self-call passes a quaternion, which spreads into its four parameters
(lib/geom.ts, case `loop`) — `Q(a, b, c, d, k) = {|quat(a, b, c, d)| > 2:
ln(|quat(a, b, c, d)|)/2^k, k >= 12: …, Q(quat(a, b, c, d)^2 + C, k + 1)}`
and `Q(x, y, z, s, 0) = 0.001`. It returns the Green function
G = ln|qₙ|/2ⁿ rather than an escape count: G is continuous, while escape
counts jump and the raymarcher refuses a crossing whose bracket does not
close. `qjulia(c, s)` built the same surface in; it is kept, undocumented,
so links that use it still open.

## Not done

Planned in docs/geometry-next.md (PGA itself in docs/pga.md).

- Multivector fields (a multivector in x, y, z, u or v) have no picture;
  take a part (`grade(A, 1)`) to draw a field or curve.
- A 3×3 matrix field (ellipsoid glyphs).
- Conformal geometric algebra (circles and spheres as blades). Projective
  geometry — points, lines and planes with meet and join — is built
  (docs/pga.md); its motors are not yet user syntax.
- A multiset of multivectors reads out but draws nothing.
- `⟑` needs a math font for its dot: style.css maps U+27D1 alone to STIX
  Two Math / Cambria Math / Noto Sans Math where the system has one.
