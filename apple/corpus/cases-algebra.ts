/**
 * Targeted documents for multivectors (lib/clifford.ts), projective geometry
 * (lib/pga.ts) and their glyphs (lib/glyphs.ts): one concern each, rows
 * separated as the examples' are. Recorded by analysis.ts with the rest.
 */
export const ALGEBRA_CASES: string[] = [
  // Unit vectors and blades.
  'e_x; e_y + e_z; 2 e_x; [0, 1] e_x; e_xy; e_yx; e_zx; e_xz; e_xyz; e_xx; e_x = 3; e_x',
  'e_y = (0, 2); e_y; e_x; f(e_x) = e_x^2; f(3); y = e_x; e_x ⊗ e_y; e_x ∧ e_y; e_x · e_y; e_x × e_y; |e_x|',
  // Multivectors: ⟑, gp, sums, products, powers, parts.
  'a = (2, 0); b = (1, 1.5); a ⟑ b; gp(a, b); grade(a ⟑ b, 2); grade(a ⟑ b, 0); b ⟑ a; a ⟑ a; a ⟑ b ⟑ a; gp(a); gp(a, b, a)',
  '1 + e_xy; 1 + e_x + e_xy; e_xy e_xy; e_xy^2; e_xy^-1; e_xy^3; e_xy^9; e_xy^0.5; -e_xy; 2 e_xy; e_xy 2; e_xy/2; 1/e_xy; e_xy/e_xy',
  'e_xy + e_yz + e_zx; e_xyz; 1 + e_xyz; e_x + e_xyz; 2 + 3 e_xy - e_zx; e_xy e_yz; e_x e_xy; e_xy e_x; (1, 0, 0) e_xy; e_xy ∧ e_z; e_xy · e_z; e_xy × e_z',
  'rev(e_xy); rev(1 + e_xy); dual(e_xy); dual(e_x); dual((1, 2)); conj(1 + e_x + e_xy); grade(e_xy, 5); grade(e_xy, x); grade(e_xy); rev(); dual(1, 2); |e_xy|; |1 + e_xy|; abs(3 e_xyz)',
  'e^(e_xy); e^(t e_xy); exp(e_xy); e^(e_x); e^(e_x + e_y); e^(e_xy + e_yz); e^(1 + e_xy); e^(e_xyz); e^(e_x + e_xy); 2^e_xy; e^((1, 0) ⟑ (0, 1))',
  'a = 0.7; R = e^(-(a/2) e_xy); R; p = (1, 0, 0.8); R p rev(R); rotate(p, R); vector(rotate(p, R)); gp(R, p, rev(R)); R p; p R; R + 1; R = 2',
  'a = (2, 0.5); b = (0.5, 1.5); b ⟑ a; rotate(a, b ⟑ a); vector(rotate(a, b ⟑ a)); rotate((1, 0, 0), b ⟑ a); rotate(a, e_xyz); rotate(1, b ⟑ a); (b ⟑ a) a rev(b ⟑ a)',
  'A = e_xy + 2; A; A + A; A A; 2 A; grade(A, 0); grade(A, 2); y = grade(A, 0) x; sin(A); A < 1; (A, 1); {x > 0: A}; A = 1; f(q) = q A; f(2)',
  'B = t e_xy; B; C = 1 + B; C; k = 2; D = k e_x + e_xy; D; D ⟑ D; [e_xy, e_x ⟑ e_x]; [e_xy, 2 e_zx, 1 + e_xyz]; [(1, 0) ⟑ (0, 1), 3]',
  'e_xy x; x e_xy; u e_x + e_xy; grade(x e_x + y e_xy, 1); J = ((0, -1), (1, 0)); J grade((1, 0) ⟑ (0, 1) + (1, 2), 1); J e_xy',
  // Quaternions.
  'quat(1, 2, 3, 4); quat(1, (2, 3, 4)); quat(1, 2, 3); quat(1, (2, 3)); q = quat(0, 1, 0, 0); q; q q; q^2; q^-1; 2 q; q + 1; q + e_x; vec(q); grade(q, 0); |q|',
  'i2 = quat(0, 1, 0, 0); j2 = quat(0, 0, 1, 0); i2 j2; j2 i2; i2 i2; i2 j2 i2 j2; rev(i2); conj(i2); i2/2; i2/j2; vec(i2, j2); vec(i2) + (1, 1, 1)',
  'q1 = quat(1, 0, 0, 0); q2 = quat(cos(1), sin(1) (1, 1, 1)/sqrt(3)); slerp(q1, q2, 0.5); slerp(q1, q2, t); slerp(q1, q2); slerp(q1, q2, (1, 2)); rotate((1, 0, 0), slerp(q1, q2, 0.3)); rotate((1, 0), q2)',
  'h = 0.4; q = quat(cos(h), 0, sin(h), 0) quat(cos(2 pi u), sin(2 pi u), 0, 0); vec(q)/(1 - grade(q, 0)); vec(q); q',
  // Quaternion state in recursive functions, and qjulia.
  'C = quat(-0.2, 0.8, 0, 0); Q(a, b, c, d, k) = {|quat(a, b, c, d)| > 2: k, k >= 6: k, Q(quat(a, b, c, d)^2 + C, k + 1)}; Q(0.1, 0.2, 0, 0, 0); Q(x, y, 0, 0, 0)',
  'F(a, b, c, d, k) = {k > 2: a, F(e_xy, k + 1)}; F(1, 0, 0, 0, 0); G(a, b, c, d, k) = {k > 2: a, G(quat(a, b, c, d), k + 1, 1)}; G(1, 0, 0, 0, 0)',
  'qjulia(quat(-0.2, 0.8, 0, 0)); s = 0.1; qjulia(quat(-0.2, 0.8, 0, 0), s); qjulia(); qjulia(1); qjulia(quat(1, 0, 0, 0), (1, 2)); 1 + qjulia(quat(1, 0, 0, 0))',
  // action(M).
  'action(((1, 1), (0, 1))); J = ((0, -1), (1, 0)); action(e^(t J) ((1.5, 0), (0, 0.6))); action(J); a = 2; action(a J); action(((1, 0, 0), (0, 2, 0), (0, 0, 3)))',
  'action(); action(1); action((1, 2)); action(((x, 0), (0, 1))); 1 + action(((1, 1), (0, 1))); M = ((2, 1), (1, 2)); action(M); action(M M); c = action(M)',
  // Projective geometry in the plane: join, meet, line as a value.
  'A = (0, 0); B = (4, 0); C = (1, 3); join(A, B); join(A, C); meet(join(A, B), join(B, C)); L = join(A, C); L; M = line(B, C); M; meet(L, M); X = meet(L, M); X; segment(A, X)',
  'A = (0, 0); B = (4, 0); C = (1, 3); ha = join(A, A + perp(C - B)); hb = join(B, B + perp(A - C)); ha; hb; meet(ha, hb); [join(A, B), join(B, C), join(C, A)]; [A, meet(ha, hb)]',
  'A = (1, 2); B = (3, 1); join(A, A); meet(join(A, B), join(A, B)); meet(join(A, B), join(A + (0, 1), B + (0, 1))); join(A); join(A, B, A); meet(A, B); meet(join(A, B)); join(A, (1, 2, 3))',
  'A = (1, 2); B = (3, 1); L = join(A, B); L + 1; 2 L; y = L; (L, 1); distance(A, L); distance(L, (0, 0)); distance(L, L); angle(L, join(A, (0, 0))); angle(A, L); sin(L); L = 2',
  'A = (1, 2); B = (3, 1); L = line(A, B); L; line(A, B); meet(line(A, B), line(A, (0, 0))); distance(A, line(B, (0, 0))); project(A, line(B, (0, 0))); reflect(A, line(B, (0, 0))); line(0, 0, 1, 2)',
  'A = (1, 2); B = (3, 1); O = (0, 0); project(A, join(O, B)); reflect(A, join(O, B)); reflect(A, B); reflect(join(O, A), join(O, B)); project(join(O, A), B); project(A); reflect(A, 1)',
  'a = 1; A = (a, 2); B = (3, t); join(A, B); meet(join(A, B), join((0, 0), (1, 1))); P = project(A, join((0, 0), B)); P; segment(A, P); join((x, 0), A); join((u, 0), A)',
  // Motors in the plane.
  'P = (1, 1); M = motor(P, pi/2); M; rotate((2, 1), M); rotate(join((0, 0), (1, 0)), M); N = motor(P, t); N; rotate((2, 1), N); motor(P); motor(P, 1, 2); motor(1, 2)',
  'P = (1, 1); Q = (3, 0); M1 = motor(P, 1); M2 = motor(Q, 2); slerp(M1, M2, 0.5); S = slerp(M1, M2, (1 - cos(t))/2); S; rotate((0, 0), S); slerp(M1, 2, 0.5); M1 + 1; join(M1, P)',
  // Projective geometry in space: planes, lines, their meets and measures.
  'p = plane((0, 0, 0), (0, 0, 1)); p; q = plane((1, 0, 0), (1, 0, 0.5)); q; meet(p, q); angle(p, q); distance((1, 2, 3), p); plane((0, 0, 0), (1, 0, 0), (0, 1, 0)); plane((0, 0), (1, 1)); plane(1)',
  'A = (2.5, -2, -2); B = (2.5, 2, 2); L = line(A, B); L; line(A, B); join(A, B); join(A, B, (0, 0, 0)); meet(L, plane((0, 0, 0), (0, 0, 1))); meet(L, L); distance((0, 0, 0), L); distance(L, join((0, 0, 0), (0, 0, 1)))',
  'a = 0.6; p = plane((0, 0, 0), (0, sin(a), cos(a))); p; [p, plane((0, 0, 1), (0, 0, 1))]; angle(p, join((0, 0, 0), (0, 0, 1))); project((1, 2, 3), p); reflect((1, 2, 3), p); project(join((0, 0, 0), (1, 1, 1)), p)',
  'A = (2.5, -2, -2); B = (2.5, 2, 2); L = line(A, B); th = 1; S = motor(L, th, th/4); S; rotate((0, 0, 0), S); rotate(L, S); rotate(plane((0, 0, 0), (0, 0, 1)), S); motor(L, t); motor(L); motor(A, 1)',
  'L = join((0, 0, 0), (0, 0, 1)); K = join((1, 0, 0), (1, 1, 0)); M1 = motor(L, 1, 0.5); M2 = motor(K, 2); S = slerp(M1, M2, 0.25); S; rotate((1, 1, 1), S); slerp(M1, M2, t)',
  'W = [(0, 0, 1), (1, 0, 2), (0, 1, 3)]; G = plane((0, 0, 0), (0, 0, 1)); project(W, G); hull(project(W, G)); Q = [(0, 0), (1, 2)]; reflect(Q, join((0, 0), (1, 1))); N = line(Q, (3, 3)); N',
  // Volume element, and a tensor fed vectors.
  'a = (1, 0, 0); b = (0, 2, 0); c = (0, 0, 3); V = e_x ∧ e_y ∧ e_z; V; V c b a; det((a, b, c)); e_x ⊗ e_y; e_x ⊗ e_y ⊗ e_z',
];
