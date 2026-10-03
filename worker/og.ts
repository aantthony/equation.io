/**
 * Legacy preview metadata retained while the MCP app is in ChatGPT review.
 * The tool descriptions, schemas, and responses remain unchanged; OG image
 * generation has been removed. This module only classifies preview gaps.
 */
import { LOOP_LIMIT } from '../lib/expr.ts';
import type { PublicKind } from '../lib/math-object.ts';
import type { RowInfo } from './graph.ts';

export const MAX_PLOTS = 6;

export const OG_COVERAGE: Record<PublicKind, 'draws' | 'fallback'> = {
  spacecurve: 'draws',
  note: 'draws',
  tuple: 'draws',
  family: 'draws',
  // Drawn member by member, like a family: their glyphs are figures.
  multivector: 'draws',
  action: 'draws',
  // Its faces, as a family of parametric surfaces (wireframes in the preview).
  solid: 'draws',
  vfield3d: 'draws',
  implicit2d: 'draws',
  ineq2d: 'draws',
  // Filled on the CPU in the app too: the union of the sampled triangles.
  pregion: 'draws',
  // The app searches along the interval per pixel; so does this, more coarsely.
  projected2d: 'draws',
  scalar2d: 'draws',
  point: 'draws',
  // A readout: nothing on the canvas in the app either — except a definite
  // integral, whose shaded area is a CPU polygon here as there.
  value: 'draws',
  trail: 'fallback',
  // The rasterizer has no font, so the text is left out — but a label only
  // annotates what the other rows draw, and losing the whole preview to the
  // site card over it would hide the graph itself. mcp.ts discloses the gap.
  label: 'draws',
  // Integrated in the app's worker; the preview would have to integrate too.
  orbit: 'fallback',
  pcurve: 'draws',
  psurface: 'draws',
  implicit3d: 'draws',
  polygon: 'draws',
  // Pure polyline work — the map's curve, the y = x diagonal, the iterated
  // path — so the scanline renderer draws the full figure.
  cobweb: 'draws',
  // Cells computed on the CPU in the app too (lib/automaton.ts), one lookup per pixel.
  automaton: 'draws',
  lattice: 'draws',
  // Laid out by a force simulation in the app (lib/graph.ts); not yet here.
  graph: 'fallback',
  // Each of these needs a per-pixel shader — domain coloring, conformal grids,
  // escape-time iteration, line-integral convolution — that a scanline
  // rasterizer cannot reproduce faithfully at preview size. They get the
  // static site card instead of a wrong picture.
  complex2d: 'fallback',
  domain2d: 'fallback',
  rgb2d: 'fallback',
  hsl2d: 'fallback',
  oklch2d: 'fallback',
  conformal2d: 'fallback',
  fractal2d: 'fallback',
  // A cloud is a raymarched integral per pixel, too costly for the preview.
  scalar3d: 'fallback',
  vfield2d: 'draws',
  tfield2d: 'draws',
  // The rest of the sequence family (term dots, orbit diagrams) and data
  // lists have no scanline path here yet; the site card beats a blank grid.
  vlist: 'fallback',
  // Dots, like a point row's, in 2D or in space.
  plist: 'draws',
  // Typed-array lists reach the worker only from a data file, whose bytes
  // never travel in the link — so there is nothing to draw here anyway.
  dlist: 'fallback',
  dscatter: 'fallback',
  histogram: 'fallback',
  sequence: 'fallback',
  // Stems are lines and discs, like a sampled density's atoms.
  pmf: 'draws',
  bifurcation: 'fallback',
  // Solution marks require running the numeric solver, which is not wired
  // into this backend yet.
  system: 'draws',
  // Sampled densities run the same lib/dist.ts estimator on the CPU: the
  // curve is a polyline, a shaded P(…) a filled polygon, an E(…) row a
  // vertical mean marker. A readout-only P(…) row (no shade) draws nothing,
  // matching the app's canvas.
  density: 'draws',
  prob: 'draws',
  expect: 'draws',
};

/**
 * The preview evaluates every pixel on the CPU, ~180k of them: one
 * recursion of LOOP_LIMIT passes is about a second, and a counted loop may
 * ask for 5000 (lib/defs.ts counterCap) — minutes. Past this many passes
 * per pixel, nested loops multiplied, the row gets no preview.
 */
const OG_LOOP_PASSES = LOOP_LIMIT + 8;

/** The most passes per evaluation any loop in a plan can run. Inlined
 *  definitions share subtrees, so each node is visited once. */
function loopPasses(value: unknown, seen = new WeakMap<object, number>()): number {
  if (typeof value !== 'object' || value === null || ArrayBuffer.isView(value)) return 1;
  const known = seen.get(value);
  if (known !== undefined) return known;
  seen.set(value, 1);
  const inner = Object.values(value).reduce<number>((m, v) => Math.max(m, loopPasses(v, seen)), 1);
  const passes = (value as { kind?: unknown }).kind === 'loop' ? (value as { limit: number }).limit * inner : inner;
  seen.set(value, passes);
  return passes;
}

/**
 * Why this renderer cannot draw a classified row — null when it draws.
 *
 * OG_COVERAGE is the type-level map; this is the row-level truth, because two
 * gaps live WITHIN types it marks 'draws': implicit3d only draws the
 * z = f(x, y) heightmap form, and a 3D scene draws none of the 2D-only rows.
 * Without this, a sphere gets preview "attached" with a picture of an empty
 * grid — which reads as "the graph failed" when only the preview did.
 *
 * The wording matters as much as the verdict: these strings are shown to
 * assistants deciding whether the graph WORKS, so each says what the live app
 * does with the row, and never implies the row itself is broken.
 */
export function previewGap(row: RowInfo, needs3D: boolean): string | null {
  // Preview coverage is determined by the CPU plan, without shader compilation.
  const { cls, cpu } = row;
  if (!cls || !cpu) return null;
  if (cpu.type === 'family') {
    for (const m of cpu.members) {
      const gap = previewGap({ ...row, cls: m.cls, cpu: m.cpu }, needs3D);
      if (gap) return gap;
    }
    return null;
  }
  const type = cpu.type;
  if (type === 'trail') return 'trail(point) accumulates live motion history; no static preview is available';
  if (loopPasses(cpu) > OG_LOOP_PASSES)
    return 'a recursive function here may run thousands of passes per pixel, too slow for a static preview; the live app runs them on the GPU';
  if (!needs3D) {
    return OG_COVERAGE[type] === 'draws'
      ? null
      : `no static preview for ${type} rows; the live app renders them (WebGL)`;
  }
  switch (type) {
    case 'note':
    case 'tuple':
    case 'value':
    // Its text is left out in 3D as in 2D (OG_COVERAGE); the app draws it in both.
    case 'label':
    case 'psurface':
    case 'pregion':
    case 'vfield3d':
    case 'spacecurve':
      return null;
    case 'implicit3d':
      return cpu.type === 'implicit3d' && cpu.heightmap
        ? null
        : 'the static preview draws only z = f(x, y) surfaces; the live app renders general implicit surfaces in full';
    case 'plist':
      return null;
    case 'pcurve':
    case 'point':
      return cpu.dim === 3
        ? null
        : 'the static preview skips 2D rows in a 3D scene; the live app draws them on the z = 0 plane';
    case 'system':
    case 'polygon':
      return null;
    case 'implicit2d':
      return 'the static preview skips 2D curves in a 3D scene; the live app extrudes them as vertical sheets';
    default:
      // scalar2d, ineq2d, polygon and the shader families have no 3D locus — the live
      // app skips them in a 3D scene too (web/main.ts), so say that, not
      // "renders in the app", which would be false here.
      return `${type} rows are not drawn in a 3D scene (the live app skips them there too)`;
  }
}
