---
kind: multivector
title: Multivector
form: gp(e_x, e_y)
short: multivector or quaternion, drawn by grade
---

A multivector or quaternion: its grades drawn as arrows, oriented discs and
cubes (a rotor as the turn it makes), its value read out.

## Examples

- Bivector: `gp(e_x, e_y)`
- Quaternion: `quat(1, 2, 3, 4)`
- Rotor making a quarter turn: `e^(-(pi/4) e_xy)`

## Details

- Multivectors (geometric algebra, Cl(2) and Cl(3), Euclidean): `a ⟑ b`
  (type `\gp`, or `gp(a, b)`) is the geometric product, `e_x ⟑ e_y` is the
  bivector `e_xy`, and `e_x ⟑ e_x` is 1. The blades are built in, like
  `e_x`: `e_xy`, `e_yz`, `e_zx` (and any reordering, `e_yx = −e_xy`) and
  `e_xyz`; they are always 3D, while `(1, 0) ⟑ (0, 1)` is the plane's own
  e_xy. Once one side is a multivector, juxtaposition is the geometric
  product too (`R p rev(R)`), `∧` is the outer product, and `+`, `−`, whole
  powers (`A^-1`, `A^3`) and `e^A` work; two plain vectors still need `⟑`
  (`e_x e_y` stays an error, `e_x ∧ e_y` the tensor wedge). Dividing by a
  multivector is refused — `a/2e_xy`, touching, would read as `a/(2e_xy)` —
  so write `a/2 e_xy`, and `A B^-1`. `rev(A)` reverses, `conj(A)` is
  the Clifford conjugate, `dual(A)` is `A I⁻¹` (`dual(e_xy)` is `e_z`),
  `grade(A, k)` is the grade-k part, and `|A|` its size. A row that is a
  multivector draws it grade by grade — its vector an arrow, its bivector an
  oriented disc of that area in its plane with an arrow round the rim, its
  trivector a cube of that volume — and reads out `= 1 + 2 e_xy`. A
  quaternion, or a rotor (a scalar and a bivector), draws as the rotation it
  makes: an arrow along the axis, |q| long, and a sector of radius |q|
  sweeping the angle 2 atan2(|v|, w), so its scalar part moves the picture. A result
  written only as a number or a vector is that number or vector
  (`grade(R ⟑ v ⟑ rev(R), 1)` is a point), and a row may name a multivector
  (`R = e^(-(t/2) e_xy)`). Rotors: `e^(-(th/2) B)` for a unit bivector B
  turns by th in B's plane, `R p rev(R)` applies it, and `rotate(X, R)` turns
  a point, a list of points or a figure by it: `rotate(hull(P), R)`.
- Quaternions: `quat(w, x, y, z)` (or `quat(w, v)` with v a 3D vector) is
  w + x i + y j + z k, read out that way. They are the even multivectors of
  space (i = e_zy, j = e_xz, k = e_yx), so they multiply by juxtaposition
  (`quat(0,1,0,0) quat(0,0,1,0)` is `k`), invert with `q^-1`, conjugate
  with `conj(q)`, and the unit quaternion `quat(cos(th/2), sin(th/2) n)`
  turns by th about the unit axis n: `rotate(P, q)`. `grade(q, 0)` is its
  w, and `vec(q)` its vector part (x, y, z), a point. `slerp(q1, q2, s)`
  runs the shorter arc between two rotations at constant speed, s from 0 to
  1: `rotate(hull(P), slerp(q1, q2, (1 - cos(t))/2))` rocks a solid between
  two orientations. A quaternion passed to a recursive function's self-call
  spreads into four parameters, so an orbit is written in quaternion
  algebra — the quaternion Julia set of C, sliced at k = s (see Recursive
  function, under Definitions): `C = quat(-0.2, 0.8, 0, 0); s = 0;
  Q(a, b, c, d, k) = {|quat(a, b, c, d)| > 2: ln(|quat(a, b, c, d)|)/2^k,
  k >= 12: ln(|quat(a, b, c, d)|)/2^k, Q(quat(a, b, c, d)^2 + C, k + 1)};
  Q(x, y, z, s, 0) = 0.001`, framed with `camera(-pi/3, 0.5, 3)`. Older
  links write the same surface as `qjulia(C, s)`; it still draws, but new
  graphs should spell the orbit out as above.
