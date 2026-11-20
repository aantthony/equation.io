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
 * of them (which follows web/main.ts renderPanel).
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
  // Positions in coordinates named on the left.
  [
    'rho = sqrt(x^2 + y^2 + z^2); theta = atan2(y, x); phi = acos(z/rho); (rho, theta, phi) = (2, pi/4, pi/3); ' +
      '(rho, theta, phi) = (2, 12 pi u, pi u)',
  ],
  // Multivectors, quaternions and projective geometry: glyphs, planes, lines of space, motors.
  // (A named value's coefficients that move with t are constants, which the scene tool reads at t = 0:
  // what moves here is written on its own row.)
  ['camera(-pi/3, 0.6, 5); a = 0.8; R = e^(-(a/2) e_xy); p = (1, 0, 0.8); vector(p); vector(rotate(p, R)); R; e^(-(t/2) e_zx)', 0.5],
  ['a = 0.6; p = plane((0, 0, 0), (0, sin(a), cos(a))); q = plane((1, 0, 0), (1, 0, 0.5)); p; q; meet(p, q)'],
  ['1 + e_xyz + e_x; e_xy + e_yz; quat(cos(0.4), sin(0.4) (1, 1, 1)/sqrt(3)); action(((1, 1, 0), (0, 1, 0), (0, 0, 2)))'],
  ['A = (2.5, -2, -2); B = (2.5, 2, 2); L = line(A, B); L; th = 1; S = motor(L, th, th/4); S; rotate((1, 1, 1), S); [e_x, 2 e_y]; motor(L, t)', 1],
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
