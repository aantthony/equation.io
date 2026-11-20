/**
 * Records the 3D scene the site builds for whole documents — their shader
 * strings and what is sampled, traced and solved on the CPU — so the Swift
 * scene builder (apple/EquationCore EquationRender/Document3D.swift) is
 * held to the same scene from the same rows.
 *
 *   node --experimental-transform-types --no-warnings apple/corpus/scenes3d.ts
 *
 * Writes Scenes/3D/documents.json beside the renderer's scene fixtures: per
 * document its rows, the time, and the Graph3D apple/tools/scene3d.ts makes
 * of them (which follows web/scene.ts renderPanel).
 */
import { writeFileSync } from 'node:fs';
import { splitStatements } from '../../lib/statements.ts';
import { graphJSON } from '../tools/scene3d.ts';

/** Documents drawn in space: one concern each, rows separated as the examples' are. */
const DOCUMENTS: Array<[text: string, time?: number]> = [
  // Surfaces, with constants, a camera row, and rows of the plane among them.
  ['z = sin(x) cos(y); camera(-pi/3, 0.5, 9)'],
  ['x^2 + y^2 + z^2 = 9; y = x; (1, 2); (cos(2 pi u), sin(2 pi u)); x^2 + y^2 < 1; x y; 1 + 1'],
  ['a = 2; z = a x y - t; A = (1, 2, 3); (a, 0, t); B = 2 A; grid(off)', 0.5],
  ['revolve(sqrt(x)); f(x) = cos(x) + 2; revolve(f, z); camera(0.4, 0.3, 12, (1, 0, 0), spin = 0.2)'],
  ['z = {x > 0: x, y}; z = floor(x) + abs(y) #e24; z = erf(x)'],
  // Clouds.
  ['x y z'],
  ['r = sqrt(x^2 + y^2 + z^2); e^(-r^2) cos(t); camera(0.3, 0.4, 6, (1, 0, 0))', 1],
  ['a = 3; sin(a x) + z; z'],
  // Parametric surfaces, curves and tubes.
  ['(u, v, u v); (cos(2 pi u) sin(pi v), sin(2 pi u) sin(pi v), cos(pi v)); a = 2; (a u, v, sin(t + u))', 2],
  ['(cos(6 pi u), sin(6 pi u), 4 u - 2); (u, u, floor(4 u)); (u, 1/(u - 0.5), 0)'],
  ['tube((2 cos(2 pi u), 2 sin(2 pi u), sin(6 pi u)), 0.2); tube((u, u^2, u^3)); a = 0.3; tube((u, 0, 1), a t)', 1],
  ['a = 0.3; tube((u, 0, 1), a t); tube((u, abs(u - 0.5), 1), 0.05); tube((1, 1, 1 + 0 u))'],
  // Curvature and torsion combs: toggles of the page, asked for here by a note.
  ['(cos(4 pi u), sin(4 pi u), 2 u - 1) # kappa tau; (2 u - 1, (2 u - 1)^2, 0) # kappa; (u, 2 u, 1 - u) # kappa tau'],
  ['a = 0.2; tube((2 cos(2 pi u), 2 sin(2 pi u), sin(6 pi u)), a) # tau; (u, abs(u - 0.5), u^3 + t) # kappa', 0.5],
  // Surfaces coloured by their curvature.
  ['S = (4 u - 2, 4 v - 2, (2 u - 1)^2 - (2 v - 1)^2); gaussian(S)'],
  ['a = 2; T = ((a + cos(2 pi v)) cos(2 pi u), (a + cos(2 pi v)) sin(2 pi u), sin(2 pi v) + t); meancurvature(T)', 1],
  ['P = (u, v, 0); gaussian(P); Q = (u, v, 1/(u - 0.5)); gaussian(Q)'],
  // Vector fields: integral curves, arrows, streamlines. (A moving field is
  // retraced on the twentieths of a second, as the page does: a time on one.)
  ['(y, -x, 0.2)'],
  ['(y, -x, z) # arrows; (-y, x, 0) # streamlines'],
  ["(x', y', z') = (y, -x, sin(t)); a = 2; (a, z, erf(x))", 0.35],
  // Curves of intersection and systems.
  ['(x^2 + y^2 + z^2, z) = (4, 1); (x + y + z, x - y) = (1, 0)'],
  ['a = 1; (x y, z) = (a, t); (atan2(y, x), z) = (1, 0); camera(0, 1, 8)', 0.25],
  ['(x + y + z, x - y, z) = (1, 0, 2); (x^2 + y^2 + z^2, x - y, z) = (4, 0, 1)'],
  ['(atan2(y, x), x^2 + y^2, z) = (1, 4, 0); (x - cos(2 pi u), y - sin(2 pi u), z - u) = (0, 0, 0)'],
  // Figures and labels in space, and ones of the plane beside them.
  [
    'A = (0, 0, 0); B = (3, 0, 1); C = (0, 2, 2); polygon(A, B, C); vector(A, (1, 1, 3)); segment(B, (3, 3, t)); ' +
      'label(C, "top"); polyline(A, (1, 0, 2), (2, 1, 2), (2, 2, 0))',
    0.5,
  ],
  ['hull((0, 0, 0), (2, 0, 0), (0, 2, 0), (0, 0, 2), (1, 1, 1)); hull((3, 0, 0), (3, 1, 0), (3, 0, 1)); z = -1'],
  ['z = x y / 4; polygon((0, 0), (2, 0), (2, 2), (0, 2)); segment((0, 0), (1, 3)); label((1, 2), "flat"); (1, 2)'],
  // Rows drawn on a surface: painted per pixel, and carried point by point.
  [
    'on((X, Y, Z) = (2cos(y) cos(x), 2cos(y) sin(x), 2sin(y)), x = -pi..pi, y = -pi/2..pi/2); 4cos(y)^3 cos(3x); ' +
      'sin((x - 4 asinh(tan(y)))/2) = 0; cos(y) cos(0.5) cos(x + 0.8) + sin(y) sin(0.5) > cos(0.35); camera(-0.5, 0.45, 8)',
  ],
  [
    'a = 0.5; P = (0.6, 0.5); on((X, Y, Z) = (x, y, a x y), x = -2..2, y = -2..2); (1, 1); (cos(2pi u), sin(2pi u) + t); ' +
      'segment((0, 0), P); polygon((0, 0), (1, 0), (0, 1)); label(P, "here"); [(0, -1), (1, -1)]; z = 2; (1, 1, 3)',
    0.25,
  ],
  [
    'on((X, Y, Z) = (2cos(y) cos(x), 2cos(y) sin(x), 2sin(y)), x = -pi..pi, y = -pi/2..pi/2); a = 0.6; (cos(a) - sin(a) tan(y) cos(x), sin(a) sin(x)); (x^2, 1/x); (0, pi/2 - a)',
  ],
  ['a = 0.5; on((X, Y, Z) = (x, y, x y), x = -1..1, y = -1..1); (u/2, v/2); (a u, v - 1); (x, a)'],
  ['z = 1; (u, v); a = 2; (a u cos(2 pi v), u sin(2 pi v))'],
  // A plane curve in a 3D panel is broken at its jumps.
  ['z = 0; (u, floor(4 u)/4); (4 u - 2, 1/(4 u - 2)); (cos(2 pi u), sin(2 pi u)); sqrt(e^(2 pi i u) - 1)'],
  // Positions in coordinates named on the left.
  [
    'rho = sqrt(x^2 + y^2 + z^2); theta = atan2(y, x); phi = acos(z/rho); (rho, theta, phi) = (2, pi/4, pi/3); ' +
      '(rho, theta, phi) = (2, 12 pi u, pi u)',
  ],
  // Multivectors, quaternions and projective geometry: glyphs, planes, lines of space, motors.
  [
    'camera(-pi/3, 0.6, 5); a = 0.8; R = e^(-(a/2) e_xy); p = (1, 0, 0.8); vector(p); vector(rotate(p, R)); R; e^(-(t/2) e_zx)',
    0.5,
  ],
  ['a = 0.6; p = plane((0, 0, 0), (0, sin(a), cos(a))); q = plane((1, 0, 0), (1, 0, 0.5)); p; q; meet(p, q)'],
  [
    '1 + e_xyz + e_x; e_xy + e_yz; quat(cos(0.4), sin(0.4) (1, 1, 1)/sqrt(3)); action(((1, 1, 0), (0, 1, 0), (0, 0, 2)))',
  ],
  [
    'A = (2.5, -2, -2); B = (2.5, 2, 2); L = line(A, B); L; th = 1; S = motor(L, th, th/4); S; rotate((1, 1, 1), S); [e_x, 2 e_y]; motor(L, t)',
    1,
  ],
  // Solids over three parameters, and curves and surfaces over the intervals u and v are defined as.
  [
    '(interval(0, 1), interval(0, 1), interval(0, 1)); r = interval(0.7, 1); (r cos(2 pi u), r sin(2 pi u), 2v) + (3, 0, 0); ' +
      's = interval(0, 1); (s, 2 s, 3 s); (s, u, s u - 2)',
  ],
  [
    'k = 0.75; r = interval(0, 1); p = interval(0, pi); q = interval(0, 2 pi k); (r sin(p) cos(q), r sin(p) sin(q), r cos(p) + t); ' +
      'a = interval(1, 2); y = a x; (a, a); (a u, v)',
    0.5,
  ],
  [
    'camera(-0.9, 0.7, 11); u = interval(0, 2pi); v = interval(0, 2pi); S = ((3 + cos(v)) cos(u), (3 + cos(v)) sin(u), sin(v)); ' +
      'gaussian(S); (cos(u), sin(u), 2); (u, v, -3)',
  ],
  // Named values that move with t: a point, a slider's dependent, a rotor, a motor's turn.
  [
    'a = 2 t; A = (cos(t), sin(t), a); A; z = a x; B = A/2; vector(A, B); hull(A, (0, 0, 0), (1, 0, 0), (0, 1, a))',
    0.75,
  ],
  ['camera(-pi/3, 0.6, 5); R = e^(-(t/2) e_xy); p = (1, 0, 0.8); vector(rotate(p, R)); R; q = rotate(p, R); q', 1.25],
  [
    'A = (2.5, -2, -2); B = (2.5, 2, 2); L = line(A, B); th = 2 pi sin(t/2); S = motor(L, th, th/4); S; rotate((1, 1, 1), S)',
    1.5,
  ],
  ['a = sin(t); P = (a, 0.5); on((X, Y, Z) = (x, y, x y), x = -1..1, y = -1..1); (a, a); segment((0, 0), P)', 0.5],
];

const recorded = DOCUMENTS.map(([text, time = 0]) => {
  const rows = splitStatements(text);
  const left: string[] = [];
  const graph: unknown = JSON.parse(graphJSON(rows, { time, warn: message => left.push(message) }));
  return { rows, time, graph, left };
});
writeFileSync(
  new URL('../EquationCore/Tests/EquationRenderTests/Scenes/3D/documents.json', import.meta.url),
  JSON.stringify(recorded) + '\n',
);
console.log(`${recorded.length} documents in space`);
