/**
 * 2D graph rendering. Everything is a fullscreen-quad fragment shader:
 * the fragment position is mapped to math coordinates, the equation's field
 * F(x,y) is evaluated per pixel, and the curve F=0 is drawn where the
 * screen-space distance estimate |F| / |∇F| is under the line width.
 */
import { colorConversionGLSL } from './color-field.ts';
import type { ColorSpace } from '../lib/math-object.ts';
import { arrowHead } from '../lib/geom.ts';
import { GLSL_PRELUDE, uniformName } from '../lib/glsl.ts';
import { type Frame, ProgramCache, QUAD_VERT } from './gl.ts';
import { glslVec3, theme } from './theme.ts';
import { type AxisMap, type AxisMaps, toScreen as mapToScreen, toScreenOrEdge } from '../lib/axis-map.ts';
import {
  type PlaneInverse,
  type PlaneShape,
  type ScreenBox,
  planeInverse,
  planeLines,
  planeShapes,
} from '../lib/plane-map.ts';
import { type AxisTicks, axisTicks } from '../lib/axis-ticks.ts';

export interface View2D {
  cx: number;
  cy: number;
  /** Math units per device pixel. */
  upp: number;
  ratio?: number;
}

export interface Curve2D {
  /** GLSL expression for F(x,y) in terms of floats x, y. */
  field: string;
  /** A finite Fourier graph's value and analytic slope, evaluated together. */
  graphEval?: { glsl: string; slopeScale: number };
  color: [number, number, number];
  /** User-defined constants the field references (as u_<name> uniforms). */
  params?: string[];
  /** Extra per-item float uniforms set each draw (e.g. a recurrence seed). */
  uniforms?: Record<string, number>;
}

export const paramDecls = (params: string[] = []): string =>
  params.map(p => `uniform float ${uniformName(p)};`).join('\n');

export interface Ineq2D extends Curve2D {
  /** Fields whose zero sets get a solid boundary line (the <= / >= parts). */
  edges: string[];
}

/** A family over an interval (lib/plot.ts projectedRegion): `field` is
 *  F(x, y, u), with `slope` ∂F/∂u when it has one. */
export interface Projected2D extends Curve2D {
  relation: 'eq' | 'ineq';
  slope?: string;
}

export interface ColorField2D extends Curve2D {
  space: ColorSpace;
  /** Shared per-pixel calculations, evaluated before the vec3 field. */
  locals: string;
}

export interface VField2D {
  uniforms?: Record<string, number>;
  /** GLSL expressions for the components (Vx, Vy) in terms of floats x, y. */
  fx: string;
  fy: string;
  color: [number, number, number];
  params?: string[];
}

/** A 2×2 matrix field: GLSL for its entries, row-major, in floats x, y. */
export interface TField2D {
  uniforms?: Record<string, number>;
  entries: [string, string, string, string];
  color: [number, number, number];
  params?: string[];
  /** Streamlines of the major eigenvector (tlinesFrag) instead of glyphs. */
  streamlines?: boolean;
  /** On mapped axes, GLSL for the maps' Jacobian ∂(x, y)/∂(X, Y), row-major,
   *  with the entries read at the screen point (lib/math-object.ts
   *  tensor-field). */
  jacobian?: [string, string, string, string];
}

/** The tensor shaders' J(x, y): the axis maps' Jacobian, or none. */
const jacobianGLSL = (j?: [string, string, string, string]) =>
  `mat2 J(float x, float y) { return ${j ? `mat2(${j[0]}, ${j[2]}, ${j[1]}, ${j[3]})` : 'mat2(1.0)'}; }`;

export interface Fractal2D {
  uniforms?: Record<string, number>;
  /** GLSL vec2 expression for one iteration step, in terms of vec2 zc and floats x, y. */
  step: string;
  seed: 'pixel' | 'zero';
  maxIter: number;
  color: [number, number, number];
  params?: string[];
}

/** Cells on the integer lattice (lib/automaton.ts): `shades` holds `rows`
 *  rows of `width` cells, 0 empty to 255 solid; cell (i, k) is the unit
 *  square centred on (i, -k), in column i - x0 of row k - y0. `runs` says
 *  which edges run on past the texture (an automaton's background) rather
 *  than stop: a 1D diagram's columns, a board's columns and rows, a
 *  table's neither. */
export interface Cells2D {
  shades: Uint8Array;
  width: number;
  rows: number;
  x0: number;
  y0: number;
  runs: { x: boolean; y: boolean };
  color: [number, number, number];
}

/** An orbit diagram: field is f(a, x), iterated per pixel column from uSeed. */
export type Bif2D = Curve2D;

/** Everything drawable in a 2D frame, in back-to-front draw order. */
export interface Layers2D {
  /** Contour stacks of f for `f(x,y) = c` rows; drawn under the other layers. */
  levels?: LevelSpec[];
  cells?: Cells2D[];
  fractals?: Fractal2D[];
  domains?: Curve2D[];
  colors?: ColorField2D[];
  conformals?: Curve2D[];
  vfields?: VField2D[];
  tfields?: TField2D[];
  ineqs?: Ineq2D[];
  projections?: Projected2D[];
  bifs?: Bif2D[];
  /** `gain` multiplies F before it is shaded (0.6 without). */
  scalars?: (Curve2D & { gain?: number })[];
  complexes?: Curve2D[];
  curves?: Curve2D[];
}

/** Pick a "nice" grid spacing (1, 2, or 5 × 10^k) at least minPx pixels apart. */
export function niceSpacing(upp: number, minPx: number): { major: number; minor: number } {
  const target = upp * minPx;
  const k = Math.floor(Math.log10(target));
  const base = Math.pow(10, k);
  for (const [m, div] of [
    [1, 5],
    [2, 4],
    [5, 5],
    [10, 5],
  ] as const) {
    if (m * base >= target) return { major: m * base, minor: (m * base) / div };
  }
  return { major: 10 * base, minor: 2 * base };
}

/**
 * A lattice panel's grid: lines between cells, never through them. Cell
 * (i, k) spans x in [i - 1/2, i + 1/2] and y in [-k - 1/2, -k + 1/2], so the
 * edges are level sets of x + 1/2 and y - 1/2, and the axes are the edges
 * before column 0 and above row 0. Majors every 1, 2, 5 × 10^k cells; the
 * edge of every cell once cells are big enough to see apart.
 */
export function latticeSpacing(upp: number): { major: number; minor: number } {
  const major = Math.max(1, niceSpacing(upp, 90).major);
  return { major, minor: 1 / upp >= 6 ? 1 : major };
}

function latticeGrid(view: View2D): GridSpec[] {
  const sx = latticeSpacing(view.upp);
  const sy = latticeSpacing(view.upp / (view.ratio ?? 1));
  return [
    { glsl: '(x + 0.5)', gradGlsl: ['1.0', '0.0'], params: [], ...sx },
    { glsl: '(y - 0.5)', gradGlsl: ['0.0', '1.0'], params: [], ...sy },
  ];
}

/** One grid family: level sets of a coordinate field c(x, y). */
export interface GridSpec {
  /** GLSL for c(x, y) (constants as u_<name> uniforms). */
  glsl: string;
  /** GLSL for ∇c in math units; absent → screen derivatives (dFdx/dFdy). */
  gradGlsl?: [string, string];
  params: string[];
  major: number;
  minor: number;
}

/** A level-set family drawn in an equation's color (topographic map). */
export interface LevelSpec extends GridSpec {
  color: [number, number, number];
}

/**
 * Antialiased line at every multiple of `spacing` of a field value c, with
 * width from the distance estimate |c - k·s| / |∇c|, fading out where lines
 * crowd toward subpixel spacing (singularities, extreme zoom).
 */
const GRID_LINE_GLSL = `
float gridLine(float c, float lg, float spacing, float halfWidthPx) {
  // The screen-derivative fallback for lg reads neighbouring pixels, which may
  // lie outside the domain (floor, sqrt near its boundary), and an analytic
  // gradient can blow up on its own. A NaN alpha survives the caller's
  // "a < 0.004" discard — every comparison against NaN is false — and reaches
  // blending, so stop it at the source, for the grid and contour stacks alike.
  if (isnan(c) || isnan(lg) || isinf(lg)) return 0.0;
  float lgv = max(lg / spacing, 1e-24);  // |∇(c/spacing)| per pixel
  float v = c / spacing;
  float distPx = abs(v - round(v)) / lgv;
  float a = 1.0 - smoothstep(halfWidthPx, halfWidthPx + 1.0, distPx);
  return a * clamp((0.35 - lgv) / 0.25, 0.0, 1.0);
}
`;

/** A constant gradient — x and y, a lattice's x + 1/2 — is a linear field,
 *  whose distance estimate to a level is exact. */
const linear = (s: GridSpec) =>
  !!s.gradGlsl && s.gradGlsl.every(g => /^\(?-?\d+(\.\d*)?(e[-+]?\d+)?\)?$/.test(g.trim()));

/**
 * Whether the level c = L of family k really passes near p, and not only by
 * the distance estimate |c - L| / |∇c|. A field that creeps toward a level
 * without reaching it — the tail of exp(-x^2 - y^2) toward 0, whose estimate
 * is 1/(2r) everywhere, a pixel or so when zoomed out — would otherwise draw
 * that level over its whole tail, and where c and ∇c underflow to 0 the
 * estimate is 0 and paints it solid.
 *
 * A Newton step toward L, taken twice over, is compared with where it
 * started, both less L: landing past L or (nearly) on it, a ratio ≤ 1e-3,
 * is a crossing — double roots and saddles (x^2, x y) land on it, and so
 * does rounding on a real line — and so is jumping away (≥ 0.9), as atan2
 * does over its branch cut, where angular grids put a line. In between, c
 * moved toward L and fell short: no line, unless pr straddles L with c
 * nearer it than either and within a quarter pixel by the estimate (beside
 * a saddle, as of cos(x) + cos(y), where the step goes astray), or c turns
 * back within four
 * pixels either way along ∇c (pr, the field there), by at least how far it
 * is from L — an extreme value, sin(x) = 1 or the root of x^10. Exactly on L,
 * pr must straddle L or jump. Differences within 1e-30 of L are underflow,
 * not roots; zoomed to float's last digits the estimate is kept. The gradient
 * is scaled to its largest component so a tiny one is not squared to 0.
 */
const reachesGlsl = (k: number) => `vec2 probe${k}(vec2 p, vec2 g) {
  float m = max(abs(g.x), abs(g.y));
  vec2 u = m > 0.0 && !isinf(m) ? normalize(g / m) : vec2(1.0, 0.0);
  vec2 d = 4.0 * min(uUpp.x, uUpp.y) * u;
  return vec2(coord${k}(p.x + d.x, p.y + d.y), coord${k}(p.x - d.x, p.y - d.y));
}
bool reaches${k}(vec2 p, float c, vec2 g, float L, vec2 pr) {
  float m = max(abs(g.x), abs(g.y));
  if (isinf(m) || isnan(m)) return true;
  float px = min(uUpp.x, uUpp.y);
  if (px < 1e-6 * max(abs(p.x), abs(p.y)) || abs(c - L) < 1e-6 * abs(c)) return true;
  vec2 v = pr - L;
  if (c == L) {
    float jump = max(16.0 * m * px, 1e-30);
    return (v.x > 0.0 && v.y < 0.0) || (v.x < 0.0 && v.y > 0.0) || max(abs(v.x), abs(v.y)) > jump;
  }
  if (m > 0.0 && abs(c - L) > 1e-30) {
    vec2 n = g / m;
    vec2 q = p - 2.0 * ((c - L) / m) * n / dot(n, n);
    float r = (coord${k}(q.x, q.y) - L) / (c - L);
    if (!(r > 1e-3 && r < 0.9)) return true;
  }
  // Beside a saddle, where Newton's step goes astray: the probes straddle L,
  // the estimate puts L within a quarter pixel, and c is nearer L than
  // either probe (beside a pole, c is far larger than they are).
  if (((v.x > 0.0 && v.y < 0.0) || (v.x < 0.0 && v.y > 0.0)) && abs(c - L) <= 0.25 * length(g) * px &&
      abs(c - L) <= min(abs(v.x), abs(v.y))) return true;
  vec2 w = pr - c;
  return ((w.x > 0.0 && w.y > 0.0) || (w.x < 0.0 && w.y < 0.0)) && abs(c - L) <= abs(w.x + w.y);
}
`;

/**
 * The grid is itself a field renderer: each family draws the level sets
 * c = k·spacing via gridLine. The Cartesian grid is the identity pair (x, y).
 */
function gridFrag(specs: GridSpec[], axesOnly = false): string {
  const params = [...new Set(specs.flatMap(s => s.params))];
  const decls = specs
    .map((s, k) => {
      const grad = s.gradGlsl
        ? `vec2 grad${k}(float x, float y) { return vec2(${s.gradGlsl[0]}, ${s.gradGlsl[1]}); }\n`
        : '';
      return (
        `float coord${k}(float x, float y) { return ${s.glsl}; }\n${grad}` +
        `uniform float uMajor${k};\nuniform float uMinor${k};\n` +
        (linear(s) ? '' : reachesGlsl(k))
      );
    })
    .join('');
  const blocks = specs
    .map(
      (s, k) => `
  {
    float c = coord${k}(p.x, p.y);
    if (!isnan(c) && !isinf(c)) {
      vec2 g = ${s.gradGlsl ? `grad${k}(p.x, p.y)` : 'vec2(dFdx(c), dFdy(c)) / uUpp'};
      float lg = length(g * uUpp);
      float minor = ${axesOnly ? '0.0' : `gridLine(c, lg, uMinor${k}, 0.5)`};
      float major = ${axesOnly ? '0.0' : `gridLine(c, lg, uMajor${k}, 0.5)`};
      float axis = 1.0 - smoothstep(0.9, 1.9, abs(c) / max(lg, 1e-24));
${
  linear(s)
    ? ''
    : // One check, inlined once: at the nearest minor level when a line is
      // near (a major level is one), else at 0 for the axis. An axis beside a
      // line at another level — lines crowded to a pixel or two — is left as
      // the estimate has it.
      `      bool lines = max(minor, major) > 0.0;
      float L = lines ? round(c / uMinor${k}) * uMinor${k} : 0.0;
      if ((lines || axis > 0.0) && !reaches${k}(p, c, g, L, probe${k}(p, g))) {
        minor = 0.0; major = 0.0;
        if (L == 0.0) axis = 0.0;
      }
`
}      minorA = max(minorA, minor);
      majorA = max(majorA, major);
      axisA = max(axisA, axis);
    }
  }`,
    )
    .join('');
  return `#version 300 es
precision highp float;
uniform vec2 uCenter;
uniform vec2 uUpp;
uniform vec2 uRes;
uniform vec2 uOrigin;
uniform float t;
${paramDecls(params)}
out vec4 outColor;
${GLSL_PRELUDE}
${decls}
${GRID_LINE_GLSL}
void main() {
  vec2 p = uCenter + (gl_FragCoord.xy - uOrigin - 0.5 * uRes) * uUpp;
  vec3 col = ${glslVec3(theme.bg)};
  float minorA = 0.0;
  float majorA = 0.0;
  float axisA = 0.0;
${blocks}
  col = mix(col, ${glslVec3(theme.gridMinor)}, minorA);
  col = mix(col, ${glslVec3(theme.gridMajor)}, majorA);
  col = mix(col, ${glslVec3(theme.axis)}, axisA);
  outColor = vec4(col, 1.0);
}
`;
}

/** Most lines a mapped axis draws (lib/axis-ticks.ts), per kind. Packed
 *  four to a vec4: a float array takes a whole uniform vector per entry,
 *  and WebGL2 promises only 224 vectors. Multiples of 4. */
const MAX_MAJOR_TICKS = 64;
const MAX_MINOR_TICKS = 192;

/**
 * Grid lines of mapped axes at the screen coordinates their ticks chose,
 * blended over the grid pass: on `x = 10^X` the lines are not evenly
 * spaced, so they are a list rather than a level set. Each axis also draws
 * its zero line where the map reaches 0.
 */
function tickFrag(axes: ReadonlyArray<'x' | 'y'>): string {
  const decls = axes
    .map(
      a => `uniform vec4 uMaj${a}[${MAX_MAJOR_TICKS / 4}];
uniform int uNMaj${a};
uniform vec4 uMin${a}[${MAX_MINOR_TICKS / 4}];
uniform int uNMin${a};
uniform float uZero${a};
uniform int uHasZero${a};`,
    )
    .join('\n');
  const blocks = axes
    .map(a => {
      const c = `p.${a}`;
      const px = `uUpp.${a}`;
      return `
  for (int i = 0; i < ${MAX_MINOR_TICKS}; i++) {
    if (i >= uNMin${a}) break;
    minorA = max(minorA, tickLine(abs(${c} - uMin${a}[i / 4][i % 4]) / ${px}));
  }
  for (int i = 0; i < ${MAX_MAJOR_TICKS}; i++) {
    if (i >= uNMaj${a}) break;
    majorA = max(majorA, tickLine(abs(${c} - uMaj${a}[i / 4][i % 4]) / ${px}));
  }
  if (uHasZero${a} == 1) axisA = max(axisA, 1.0 - smoothstep(0.9, 1.9, abs(${c} - uZero${a}) / ${px}));`;
    })
    .join('');
  return `#version 300 es
precision highp float;
uniform vec2 uCenter;
uniform vec2 uUpp;
uniform vec2 uRes;
uniform vec2 uOrigin;
${decls}
out vec4 outColor;
float tickLine(float distPx) { return 1.0 - smoothstep(0.5, 1.5, distPx); }
void main() {
  vec2 p = uCenter + (gl_FragCoord.xy - uOrigin - 0.5 * uRes) * uUpp;
  float minorA = 0.0;
  float majorA = 0.0;
  float axisA = 0.0;
${blocks}
  vec3 col = ${glslVec3(theme.gridMinor)};
  float a = minorA;
  if (majorA > 0.0) { col = mix(col, ${glslVec3(theme.gridMajor)}, majorA); a = max(a, majorA); }
  if (axisA > 0.0) { col = mix(col, ${glslVec3(theme.axis)}, axisA); a = max(a, axisA); }
  if (a < 0.004) discard;
  outColor = vec4(col, a);
}
`;
}

/** Each mapped axis's ticks in view, in screen units (lib/axis-ticks.ts). */
export function mappedTicks(view: View2D, w: number, h: number, maps: AxisMaps): Partial<Record<'x' | 'y', AxisTicks>> {
  const uppY = view.upp / (view.ratio ?? 1);
  const out: Partial<Record<'x' | 'y', AxisTicks>> = {};
  if (maps.x) out.x = axisTicks(maps.x, view.cx - (w / 2) * view.upp, view.cx + (w / 2) * view.upp, 1 / view.upp);
  if (maps.y) out.y = axisTicks(maps.y, view.cy - (h / 2) * uppY, view.cy + (h / 2) * uppY, 1 / uppY);
  return out;
}

/**
 * Whole-family level sets of one equation's field f(x,y): faint contours at
 * every multiple of uMinor, stronger at uMajor, in the equation's color. The
 * current level (f = c) stays the solid curve drawn by curveFrag on top.
 */
function levelsFrag(spec: { glsl: string; gradGlsl?: [string, string]; params: string[] }): string {
  const grad = spec.gradGlsl
    ? `vec2 gradF(float x, float y) { return vec2(${spec.gradGlsl[0]}, ${spec.gradGlsl[1]}); }\n`
    : '';
  return `#version 300 es
precision highp float;
uniform vec2 uCenter;
uniform vec2 uUpp;
uniform vec2 uRes;
uniform vec2 uOrigin;
uniform vec3 uColor;
uniform float uMajor;
uniform float uMinor;
uniform float t;
${paramDecls(spec.params)}
out vec4 outColor;
${GLSL_PRELUDE}
float F(float x, float y) { return ${spec.glsl}; }
${grad}${GRID_LINE_GLSL}
void main() {
  vec2 p = uCenter + (gl_FragCoord.xy - uOrigin - 0.5 * uRes) * uUpp;
  float v = F(p.x, p.y);
  if (isnan(v) || isinf(v)) discard;
  float lg = ${spec.gradGlsl ? 'length(gradF(p.x, p.y) * uUpp)' : 'length(vec2(dFdx(v), dFdy(v)))'};
  float a = max(gridLine(v, lg, uMinor, 0.5) * 0.18, gridLine(v, lg, uMajor, 0.5) * 0.45);
  if (a < 0.004) discard;
  outColor = vec4(uColor, a);
}
`;
}

/** Pixels within this distance of a curve are drawn (smoothstep's upper edge below). */
const CURVE_REACH_PX = 2.1;

export function curveFrag(field: string, params?: string[], graphEval?: Curve2D['graphEval']): string {
  return `#version 300 es
precision highp float;
uniform vec2 uCenter;
uniform vec2 uUpp;
uniform vec2 uRes;
uniform vec2 uOrigin;
uniform vec3 uColor;
uniform float t;
${paramDecls(params)}
out vec4 outColor;
${GLSL_PRELUDE}
float F(float x, float y) { return ${field}; }
${graphEval ? `vec4 G(float x, float reach) { return ${graphEval.glsl}; }` : ''}
void main() {
  vec2 p = uCenter + (gl_FragCoord.xy - uOrigin - 0.5 * uRes) * uUpp;
${
  graphEval
    ? `
  vec4 signal = G(p.x, ${CURVE_REACH_PX.toFixed(1)} * uUpp.x);
  float v = p.y - signal.x;
  if (isnan(v) || isinf(v)) discard;
  vec2 gradient = vec2(-signal.y * ${graphEval.slopeScale.toExponential()}, 1.0) * uUpp;
  float distPx = abs(v) / max(length(gradient), 1e-24);
  if (isnan(distPx) || isinf(distPx)) discard;
  // The slope's estimate trusts one slope across the pixel's reach, which
  // harmonics too fast to resolve at this zoom break: zoomed out, their
  // steep slope would put far pixels on the curve. Within the reach the
  // curve stays in [signal.z, signal.w], so a pixel outside that band is at
  // least that far away.
  distPx = max(distPx, max(signal.z - p.y, p.y - signal.w) / uUpp.y);
`
    : `
  float v = F(p.x, p.y);
  if (isnan(v) || isinf(v)) discard;

  // Distance estimate |F| / |grad F| in pixels, from central differences at
  // two step sizes. For a genuine zero crossing the two estimates agree; near
  // a pole (y=tan(x) asymptotes, y=1/x at x=0) the first-order estimate is a
  // lie that varies with step size, so disagreement rejects the fake line.
  vec2 h = uUpp;
  vec2 g1 = vec2(F(p.x + h.x, p.y) - F(p.x - h.x, p.y),
                 F(p.x, p.y + h.y) - F(p.x, p.y - h.y)) / (2.0 * h);
  vec2 g2 = vec2(F(p.x + 0.5 * h.x, p.y) - F(p.x - 0.5 * h.x, p.y),
                 F(p.x, p.y + 0.5 * h.y) - F(p.x, p.y - 0.5 * h.y)) / h;
  float e1 = abs(v) / max(length(g1 * h), 1e-24);
  float e2 = abs(v) / max(length(g2 * h), 1e-24);

  float distPx;
  if (isnan(e1) || isinf(e1) || isnan(e2) || isinf(e2)) {
    // Domain edges (sqrt, log): fall back to screen-space derivatives.
    float va = atan(v);
    vec2 g = vec2(dFdx(va), dFdy(va));
    distPx = abs(va) / max(length(g), 1e-24);
  } else {
    if (e2 > 1.6 * e1 || e1 > 1.6 * e2) discard;
    distPx = max(e1, e2);
  }
`
}

  float alpha = 1.0 - smoothstep(1.1, ${CURVE_REACH_PX.toFixed(1)}, distPx);
  if (alpha <= 0.0) discard;
  outColor = vec4(uColor, alpha);
}
`;
}

function scalarFrag(field: string, params?: string[]): string {
  return `#version 300 es
precision highp float;
uniform vec2 uCenter;
uniform vec2 uUpp;
uniform vec2 uRes;
uniform vec2 uOrigin;
uniform vec3 uColor;
uniform float uGain;
uniform float t;
${paramDecls(params)}
out vec4 outColor;
${GLSL_PRELUDE}
float F(float x, float y) { return ${field}; }
void main() {
  vec2 p = uCenter + (gl_FragCoord.xy - uOrigin - 0.5 * uRes) * uUpp;
  float v = F(p.x, p.y);
  if (isnan(v) || isinf(v)) discard;
  // Signed shade, as in the static preview (worker/og.ts shadeScalar):
  // positive toward the row color, negative toward its complement, so a
  // field that changes sign (sin(x), or plain x) reads on both sides of 0.
  // uGain is 0.6, or what brings gaussian(x, y)'s typical size to ~1.
  float s = eq_tanh(v * uGain);
  float a = 0.55 * abs(s);
  if (a < 0.004) discard;
  outColor = vec4(s >= 0.0 ? uColor : vec3(1.0) - uColor, a);
}
`;
}

function complexFrag(field: string, params?: string[]): string {
  return `#version 300 es
precision highp float;
uniform vec2 uCenter;
uniform vec2 uUpp;
uniform vec2 uRes;
uniform vec2 uOrigin;
uniform vec3 uColor;
uniform float t;
${paramDecls(params)}
out vec4 outColor;
${GLSL_PRELUDE}
vec2 F(float x, float y) { return ${field}; }

// Contour lines of val at multiples of S, antialiased via screen derivatives.
// Spacing 2pi/16 divides the 2pi jump of ln branch cuts exactly, so cuts of
// complex potentials never show as spurious lines.
float contour(float val, float S) {
  float v = val / S;
  vec2 g = vec2(dFdx(v), dFdy(v));
  float lg = length(g);
  float d = abs(v - round(v)) / max(lg, 1e-12);
  float a = 1.0 - smoothstep(0.7, 1.8, d);
  // Fade before contours become subpixel-dense (near singularities).
  a *= clamp((0.4 - lg) / 0.15, 0.0, 1.0);
  return a;
}

void main() {
  vec2 p = uCenter + (gl_FragCoord.xy - uOrigin - 0.5 * uRes) * uUpp;
  vec2 f = F(p.x, p.y);
  if (any(isnan(f)) || any(isinf(f))) discard;
  const float S = ${(Math.PI / 8).toFixed(8)};
  float fieldLines = contour(f.y, S);   // im = field lines
  float equipot = contour(f.x, S);      // re = equipotentials
  float a = max(fieldLines, equipot * 0.65);
  if (a < 0.01) discard;
  outColor = vec4(uColor, a);
}
`;
}

function vfieldFrag(fx: string, fy: string, params?: string[]): string {
  return `#version 300 es
precision highp float;
uniform vec2 uCenter;
uniform vec2 uUpp;
uniform vec2 uRes;
uniform vec2 uOrigin;
uniform vec3 uColor;
uniform float t;
${paramDecls(params)}
out vec4 outColor;
${GLSL_PRELUDE}
vec2 V(float x, float y) { return vec2(${fx}, ${fy}); }

// White noise on a small screen-space grid; the convolution below smears it
// along streamlines so coherent streaks appear in the flow direction.
float vfNoise(vec2 spx) {
  return fract(sin(dot(floor(spx / 2.0), vec2(127.1, 311.7))) * 43758.5453);
}

const int   N      = 24;    // integration steps each direction
const float STEP   = 1.6;   // step length in pixels
const float LAMBDA = 34.0;  // drift-wave length in pixels
const float OMEGA  = 4.0;   // drift-wave angular speed (rad/s)

// Kernel weight at signed arc length s px: a Hann window times a traveling
// wave. The +OMEGA*t phase pulls the peak upstream over time, so the visible
// pattern advects downstream, in the direction the field points.
float weight(float s) {
  float hann = 0.5 + 0.5 * cos(3.14159265 * s / (float(N) * STEP));
  return hann * (0.62 + 0.38 * cos(6.2831853 * s / LAMBDA + OMEGA * t));
}

void main() {
  vec2 p = uCenter + (gl_FragCoord.xy - uOrigin - 0.5 * uRes) * uUpp;
  vec2 v0 = V(p.x, p.y);
  if (any(isnan(v0)) || any(isinf(v0))) discard;

  float w0 = weight(0.0);
  float sum = w0 * vfNoise(gl_FragCoord.xy - uOrigin);
  float wsum = w0;
  float travel = 0.0;
  float h = STEP;

  // Line integral convolution: midpoint-rule streamline integration forward
  // and backward from p, accumulating noise along the path.
  for (int side = 0; side < 2; side++) {
    float sgn = side == 0 ? 1.0 : -1.0;
    vec2 q = p;
    for (int i = 1; i <= N; i++) {
      vec2 v = V(q.x, q.y);
      float m = length(v / uUpp);
      if (isnan(m) || isinf(m) || m < 1e-24) break;
      vec2 d = (sgn / m) * v;
      vec2 qm = q + 0.5 * h * d;
      vec2 vm = V(qm.x, qm.y);
      float mm = length(vm / uUpp);
      if (!isnan(mm) && !isinf(mm) && mm > 1e-24) d = (sgn / mm) * vm;
      q += h * d;
      float w = weight(sgn * float(i) * STEP);
      sum += w * vfNoise((q - uCenter) / uUpp + 0.5 * uRes);
      wsum += w;
      travel += STEP;
    }
  }

  // Contrast-stretch the low-variance LIC mean; fade where streaks were cut
  // short (critical points, domain edges) rather than showing raw noise.
  float v = sum / max(wsum, 1e-6);
  float a = clamp(0.5 + (v - 0.5) * 6.0, 0.0, 1.0);
  a *= 0.45 * smoothstep(0.1, 0.55, travel / (2.0 * float(N) * STEP));
  if (a < 0.004) discard;
  outColor = vec4(uColor, a);
}
`;
}

/**
 * A matrix field as a grid of glyphs: in each cell, the image of a circle
 * under M at the cell's centre, lightly filled, with a spoke to M e_x so a
 * turn or a reflection shows (a circle's image alone cannot). Cells are
 * anchored in the plane — a power-of-two size near CELL pixels — so panning
 * moves the glyphs with it. The glyph scale is lib/glyphs.ts glyphScale:
 * tanh(σ₁)/σ₁, true size while small, a cell at most. An orientation-
 * reversing matrix (det < 0) draws in the complement of the row colour.
 * Distances are taken in pixel space, where the ring is {A w : |w| = 1}
 * and |adj(A) q| − |det A| vanishes on it, so even a singular M (a segment)
 * draws.
 */
function tfieldFrag(
  entries: [string, string, string, string],
  params?: string[],
  jacobian?: [string, string, string, string],
): string {
  return `#version 300 es
precision highp float;
uniform vec2 uCenter;
uniform vec2 uUpp;
uniform vec2 uRes;
uniform vec2 uOrigin;
uniform vec3 uColor;
uniform float t;
${paramDecls(params)}
out vec4 outColor;
${GLSL_PRELUDE}
${jacobianGLSL(jacobian)}
mat2 M(float x, float y) {
  // Column-major: mat2(m00, m10, m01, m11). On mapped axes, the same map in
  // screen coordinates: J⁻¹ M J, J the maps' Jacobian.
  mat2 j = J(x, y);
  return inverse(j) * mat2(${entries[0]}, ${entries[2]}, ${entries[1]}, ${entries[3]}) * j;
}
const float CELL = 72.0;
float sigma1(mat2 m) {
  float p = dot(m[0], m[0]), q = dot(m[1], m[1]), r = dot(m[0], m[1]);
  return sqrt(0.5 * (p + q) + sqrt(max(0.0, 0.25 * (p - q) * (p - q) + r * r)));
}
float segDist(vec2 q, vec2 b) {
  float h = clamp(dot(q, b) / max(dot(b, b), 1e-12), 0.0, 1.0);
  return length(q - b * h);
}
void main() {
  vec2 p = uCenter + (gl_FragCoord.xy - uOrigin - 0.5 * uRes) * uUpp;
  float wx = exp2(ceil(log2(CELL * uUpp.x)));
  vec2 w = vec2(wx, wx * uUpp.y / uUpp.x);
  vec2 c = (floor(p / w) + 0.5) * w;
  mat2 m = M(c.x, c.y);
  if (any(isnan(m[0])) || any(isnan(m[1])) || any(isinf(m[0])) || any(isinf(m[1]))) discard;
  float s1 = sigma1(m);
  float s = s1 < 1e-9 ? 1.0 : eq_tanh(s1) / s1;
  // The same map in pixels: D⁻¹ M D with D = diag(uUpp).
  mat2 mp = mat2(m[0][0], m[0][1] * uUpp.x / uUpp.y, m[1][0] * uUpp.y / uUpp.x, m[1][1]);
  float radius = 0.42 * wx / uUpp.x;
  mat2 a = radius * s * mp;
  vec2 q = (p - c) / uUpp;
  if (length(q) > radius * s * sigma1(mp) + 2.0) discard;
  mat2 adj = mat2(a[1][1], -a[0][1], -a[1][0], a[0][0]);
  float det = a[0][0] * a[1][1] - a[1][0] * a[0][1];
  vec2 g = adj * q;
  float lg = length(g);
  float f = lg - abs(det);
  vec2 grad = transpose(adj) * (lg > 1e-12 ? g / lg : vec2(0.0));
  float ring = abs(f) / max(length(grad), 1e-6);
  float alpha = max(1.0 - smoothstep(0.6, 1.6, ring), f < 0.0 ? 0.1 : 0.0);
  float spoke = segDist(q, a[0]);
  alpha = max(alpha, 0.85 * (1.0 - smoothstep(0.5, 1.4, spoke)));
  if (alpha < 0.004) discard;
  float sense = m[0][0] * m[1][1] - m[1][0] * m[0][1];
  outColor = vec4(sense < 0.0 ? vec3(1.0) - uColor : uColor, alpha);
}
`;
}

/**
 * A matrix field as tensor streamlines: line integral convolution, as in
 * vfieldFrag, along the major eigenvector of the symmetric part of M (lib/
 * glyphs.ts majorAngle). An eigenvector has no sign, so the field is a line
 * field: each step takes whichever of ±e continues the previous one, and
 * with no direction to drift in, the texture holds still. Streaks fade
 * where they are cut short — at the degenerate points where S is isotropic
 * and the direction is undefined, and at the domain's edge. As with the
 * glyphs, det M < 0 draws in the complement of the row colour.
 */
function tlinesFrag(
  entries: [string, string, string, string],
  params?: string[],
  jacobian?: [string, string, string, string],
): string {
  return `#version 300 es
precision highp float;
uniform vec2 uCenter;
uniform vec2 uUpp;
uniform vec2 uRes;
uniform vec2 uOrigin;
uniform vec3 uColor;
uniform float t;
${paramDecls(params)}
out vec4 outColor;
${GLSL_PRELUDE}
// Row-major ((a, b), (c, d)) as a vec4.
vec4 M(float x, float y) { return vec4(${entries[0]}, ${entries[1]}, ${entries[2]}, ${entries[3]}); }
${jacobianGLSL(jacobian)}

float tlNoise(vec2 spx) {
  return fract(sin(dot(floor(spx / 2.0), vec2(127.1, 311.7))) * 43758.5453);
}

const int   N    = 24;   // integration steps each direction
const float STEP = 1.6;  // step length in pixels

// The major eigenvector of (M + Mᵀ)/2 at q, scaled to one pixel of travel,
// signed to agree with prev; zero where it is undefined (an isotropic or
// non-finite tensor). Half the angle of (a − d, b + c) is its direction.
vec2 E(vec2 q, vec2 prev) {
  vec4 m = M(q.x, q.y);
  float h = 0.5 * (m.x - m.w);
  float o = 0.5 * (m.y + m.z);
  float r = length(vec2(h, o));
  if (isnan(r) || isinf(r) || !(r > 1e-5 * (abs(m.x) + abs(m.w) + abs(o)))) return vec2(0.0);
  float th = 0.5 * atan(o, h);
  // On mapped axes the direction is x and y's, carried to the screen.
  vec2 e = inverse(J(q.x, q.y)) * vec2(cos(th), sin(th));
  e /= length(e / uUpp);
  if (any(isnan(e)) || any(isinf(e))) return vec2(0.0);
  return dot(e, prev) < 0.0 ? -e : e;
}

float weight(float s) {
  return 0.5 + 0.5 * cos(3.14159265 * s / (float(N) * STEP));
}

void main() {
  vec2 p = uCenter + (gl_FragCoord.xy - uOrigin - 0.5 * uRes) * uUpp;
  vec4 m0 = M(p.x, p.y);
  if (any(isnan(m0)) || any(isinf(m0))) discard;
  vec2 e0 = E(p, vec2(1.0, 0.0));

  float w0 = weight(0.0);
  float sum = w0 * tlNoise(gl_FragCoord.xy - uOrigin);
  float wsum = w0;
  float travel = 0.0;

  // Midpoint rule forward (+e0) and backward (−e0), as in vfieldFrag, with
  // each direction oriented to continue the last.
  for (int side = 0; side < 2; side++) {
    vec2 d = side == 0 ? e0 : -e0;
    if (d == vec2(0.0)) break;
    vec2 q = p;
    for (int i = 1; i <= N; i++) {
      vec2 d1 = E(q, d);
      if (d1 == vec2(0.0)) break;
      vec2 dm = E(q + 0.5 * STEP * d1, d1);
      d = dm == vec2(0.0) ? d1 : dm;
      q += STEP * d;
      float w = weight(float(i) * STEP);
      sum += w * tlNoise((q - uCenter) / uUpp + 0.5 * uRes);
      wsum += w;
      travel += STEP;
    }
  }

  float v = sum / max(wsum, 1e-6);
  float a = clamp(0.5 + (v - 0.5) * 6.0, 0.0, 1.0);
  a *= 0.45 * smoothstep(0.1, 0.55, travel / (2.0 * float(N) * STEP));
  if (a < 0.004) discard;
  float sense = m0.x * m0.w - m0.y * m0.z;
  outColor = vec4(sense < 0.0 ? vec3(1.0) - uColor : uColor, a);
}
`;
}

function domainFrag(field: string, params?: string[]): string {
  return `#version 300 es
precision highp float;
uniform vec2 uCenter;
uniform vec2 uUpp;
uniform vec2 uRes;
uniform vec2 uOrigin;
uniform vec3 uColor;
uniform float t;
${paramDecls(params)}
out vec4 outColor;
${GLSL_PRELUDE}
vec2 F(float x, float y) { return ${field}; }
vec3 hsv2rgb(vec3 c) {
  vec3 rgb = clamp(abs(mod(c.x * 6.0 + vec3(0.0, 4.0, 2.0), 6.0) - 3.0) - 1.0, 0.0, 1.0);
  return c.z * mix(vec3(1.0), rgb, c.y);
}
void main() {
  vec2 p = uCenter + (gl_FragCoord.xy - uOrigin - 0.5 * uRes) * uUpp;
  vec2 f = F(p.x, p.y);
  if (any(isnan(f))) discard;
  // Hue = arg f (0 → red); a brightness ridge each factor of 2 in |f|;
  // black at zeros, white at poles, plain color at |f| = 1.
  float h = atan(f.y, f.x) * 0.15915494;
  // Work in octaves of |f|: L = 0 on the unit circle, and symmetric, so
  // zeros and poles are equally far from plain color. The clamp also
  // absorbs log2(0) = -inf at an exact zero.
  float L = clamp(log2(length(f)), -32.0, 32.0);
  vec3 col = hsv2rgb(vec3(h, 0.9, 1.0)) * (0.78 + 0.22 * fract(L));
  float shade = clamp(L / 8.0, -1.0, 1.0);
  col = mix(col, vec3(0.0), max(-shade, 0.0));  // → black over 8 octaves down
  col = mix(col, vec3(1.0), max(shade, 0.0));   // → white over 8 octaves up
  outColor = vec4(col, 1.0);
}
`;
}

function conformalFrag(field: string, params?: string[]): string {
  return `#version 300 es
precision highp float;
uniform vec2 uCenter;
uniform vec2 uUpp;
uniform vec2 uRes;
uniform vec2 uOrigin;
uniform vec3 uColor;
uniform float t;
${paramDecls(params)}
out vec4 outColor;
${GLSL_PRELUDE}
vec2 F(float x, float y) { return ${field}; }

// One image-plane grid line family: distance in pixels from v to the nearest
// multiple of s, given |grad v| per pixel.
float lineAt(float v, float s, float lg) {
  float q = v / s;
  float d = abs(q - round(q)) * s / max(lg, 1e-30);
  return 1.0 - smoothstep(0.6, 1.6, d);
}
float checker(vec2 f, float s) {
  vec2 q = floor(f / s);
  return mod(q.x + q.y, 2.0);
}
void main() {
  vec2 p = uCenter + (gl_FragCoord.xy - uOrigin - 0.5 * uRes) * uUpp;
  vec2 f = F(p.x, p.y);
  if (any(isnan(f)) || any(isinf(f))) discard;
  // Pullback of the Cartesian grid in the image plane: level curves of re f
  // and im f. Spacing adapts per pixel (powers of two, cross-faded) so the
  // grid stays ~uniform on screen however f stretches the plane.
  float lgx = length(vec2(dFdx(f.x), dFdy(f.x)));
  float lgy = length(vec2(dFdx(f.y), dFdy(f.y)));
  float lod = log2(max(0.5 * (lgx + lgy), 1e-30) * 76.0);
  float fr = fract(lod);
  float s0 = exp2(floor(lod));
  float s1 = 2.0 * s0;
  float lines = max(
    max(lineAt(f.x, s1, lgx), lineAt(f.x, s0, lgx) * (1.0 - fr)),
    max(lineAt(f.y, s1, lgy), lineAt(f.y, s0, lgy) * (1.0 - fr)));
  float ch = mix(checker(f, s0), checker(f, s1), fr);
  float a = max(lines * 0.85, ch * 0.055);
  if (a < 0.01) discard;
  outColor = vec4(uColor, a);
}
`;
}

function colorFrag(field: string, params: string[] | undefined, locals: string, space: ColorSpace): string {
  return `#version 300 es
precision highp float;
uniform vec2 uCenter;
uniform vec2 uUpp;
uniform vec2 uRes;
uniform vec2 uOrigin;
uniform float t;
${paramDecls(params)}
out vec4 outColor;
${GLSL_PRELUDE}
${colorConversionGLSL(space)}
vec4 F(float x, float y) {
${locals}
return ${field};
}
void main() {
  vec2 p = uCenter + (gl_FragCoord.xy - uOrigin - 0.5 * uRes) * uUpp;
  vec4 channels = F(p.x, p.y);
  if (any(isnan(channels)) || any(isinf(channels))) discard;
  float a = clamp(channels.w, 0.0, 1.0);
  if (a < 0.004) discard;
  outColor = vec4(eqColorToSRGB(channels.xyz), a);
}
`;
}

function fractalFrag(step: string, seed: 'pixel' | 'zero', maxIter: number, params?: string[]): string {
  return `#version 300 es
precision highp float;
uniform vec2 uCenter;
uniform vec2 uUpp;
uniform vec2 uRes;
uniform vec2 uOrigin;
uniform vec3 uColor;
uniform float t;
${paramDecls(params)}
out vec4 outColor;
${GLSL_PRELUDE}
vec2 stepFn(vec2 zc, float x, float y) { return ${step}; }
void main() {
  vec2 p = uCenter + (gl_FragCoord.xy - uOrigin - 0.5 * uRes) * uUpp;
  vec2 zc = ${seed === 'pixel' ? 'p' : 'vec2(0.0)'};
  float mu = -1.0;
  float m2 = dot(zc, zc);
  for (int k = 0; k < ${maxIter}; k++) {
    zc = stepFn(zc, p.x, p.y);
    float prev = m2;
    m2 = dot(zc, zc);
    if (isnan(m2) || isinf(m2)) {
      // For degree >= 4, |z|^(2d) can leave the float32 range inside the step
      // before the bailout test fires, yielding inf — or NaN, once inf - inf
      // appears in a complex multiply. An orbit already outside the escape
      // disc has escaped, and log2(inf) below would drive mu to -inf and
      // paint it as interior; only a step undefined near the origin is
      // genuinely bounded. No smooth term survives at this magnitude.
      if (prev > 4.0) mu = float(k);
      break;
    }
    if (m2 > 1.0e12) {
      // Smooth (fractional) escape count, assuming a roughly degree-2 map:
      // log2 of the bailout overshoot ratio, bailout radius 1e6.
      mu = float(k) + 1.0 - log2(max(0.5 * log2(m2), 1.0) / 19.93);
      break;
    }
  }
  if (mu < 0.0) {
    // Bounded orbit: inside the filled Julia / Mandelbrot set.
    outColor = vec4(uColor * 0.08, 1.0);
    return;
  }
  // Exterior: with a 1e6 bailout even distant points take a few iterations,
  // so subtract the "free escape" count log2(ln B / ln |p|) a point at this
  // radius needs with no dynamics — the excess measures closeness to the
  // set, and the far field fades fully so the plot sits on the graph paper.
  float lp = max(length(p), 2.72);
  float s = max(mu - log2(13.8155 / log(lp)) - ${seed === 'zero' ? '1.0' : '0.0'}, 0.0);
  float aBase = 1.0 - exp(-0.18 * s * s);
  float a = aBase * (0.75 + 0.25 * cos(0.45 * mu));
  vec3 col = uColor * (0.72 + 0.28 * cos(0.16 * mu + vec3(0.0, 0.9, 1.8)));
  if (a < 0.004) discard;
  outColor = vec4(col, clamp(a, 0.0, 1.0));
}
`;
}

function bifFrag(field: string, params?: string[]): string {
  // Orbit diagram of the map a ← f(a, x): each pixel column fixes the
  // parameter x, iterates past the transient from the seed, then accumulates
  // how often the orbit lands within a pixel of this fragment's y. Stable
  // orbits saturate to solid branches; chaotic bands stay as light dust.
  return `#version 300 es
precision highp float;
uniform vec2 uCenter;
uniform vec2 uUpp;
uniform vec2 uRes;
uniform vec2 uOrigin;
uniform vec3 uColor;
uniform float t;
uniform float uSeed;
${paramDecls(params)}
out vec4 outColor;
${GLSL_PRELUDE}
float f(float a, float x) { return ${field}; }
void main() {
  vec2 p = uCenter + (gl_FragCoord.xy - uOrigin - 0.5 * uRes) * uUpp;
  float a = uSeed;
  for (int k = 0; k < 150; k++) {
    a = f(a, p.x);
    if (isnan(a) || isinf(a) || abs(a) > 1e12) discard;
  }
  float acc = 0.0;
  for (int k = 0; k < 200; k++) {
    a = f(a, p.x);
    if (isnan(a) || isinf(a) || abs(a) > 1e12) break;
    float d = abs(a - p.y) / uUpp.y;
    acc += 0.35 * (1.0 - smoothstep(0.6, 1.4, d));
  }
  float alpha = min(acc, 1.0) * 0.92;
  if (alpha < 0.01) discard;
  outColor = vec4(uColor, alpha);
}
`;
}

function ineqFrag(field: string, edges: string[], params?: string[]): string {
  // Each non-strict comparison draws its boundary with the same two-scale
  // distance estimate as curveFrag, gated to the region's edge so a chain's
  // bound lines stop where the other comparisons cut them off.
  const edgeBlocks = edges
    .map(
      (_, i) => `
  {
    float ev = E${i}(p.x, p.y);
    if (!isnan(ev) && !isinf(ev) && v < 2.5 * aa) {
      vec2 g1 = vec2(E${i}(p.x + h.x, p.y) - E${i}(p.x - h.x, p.y),
                     E${i}(p.x, p.y + h.y) - E${i}(p.x, p.y - h.y)) / (2.0 * h);
      vec2 g2 = vec2(E${i}(p.x + 0.5 * h.x, p.y) - E${i}(p.x - 0.5 * h.x, p.y),
                     E${i}(p.x, p.y + 0.5 * h.y) - E${i}(p.x, p.y - 0.5 * h.y)) / h;
      float e1 = abs(ev) / max(length(g1 * h), 1e-24);
      float e2 = abs(ev) / max(length(g2 * h), 1e-24);
      if (!(isnan(e1) || isinf(e1) || isnan(e2) || isinf(e2))
        && !(e2 > 1.6 * e1 || e1 > 1.6 * e2)) {
        edge = max(edge, 1.0 - smoothstep(1.1, 2.1, max(e1, e2)));
      }
    }
  }`,
    )
    .join('');
  return `#version 300 es
precision highp float;
uniform vec2 uCenter;
uniform vec2 uUpp;
uniform vec2 uRes;
uniform vec2 uOrigin;
uniform vec3 uColor;
uniform float t;
${paramDecls(params)}
out vec4 outColor;
${GLSL_PRELUDE}
float F(float x, float y) { return ${field}; }
${edges.map((e, i) => `float E${i}(float x, float y) { return ${e}; }`).join('\n')}
void main() {
  vec2 p = uCenter + (gl_FragCoord.xy - uOrigin - 0.5 * uRes) * uUpp;
  float v = F(p.x, p.y);
  if (isnan(v) || isinf(v)) discard;
  float aa = max(fwidth(v), 1e-24);
  float fill = (1.0 - smoothstep(-aa, aa, v)) * 0.22;
  float edge = 0.0;
  vec2 h = uUpp;
${edgeBlocks}
  float alpha = max(fill, edge * 0.9);
  if (alpha < 0.004) discard;
  outColor = vec4(uColor, alpha);
}
`;
}

/** Samples of u per pixel when a family over an interval is projected. */
const PROJECTION_SAMPLES = 48;
/** Sub-steps between two samples that a member could cross between. */
const PROJECTION_REFINE = 8;

/**
 * The region a family over u ∈ [0, 1] sweeps: a pixel is kept when some u
 * satisfies the relation there, found by stepping u. For an equation that is
 * a sign change of F between neighbouring samples. Where F keeps its sign but
 * could still reach 0 between two samples at its slope ∂F/∂u (a member that
 * only grazes the pixel), that step is searched again finer — still for a
 * sign change, so a steep ∂F/∂u costs time, never extra fill. Outside, the
 * member nearest the pixel feathers the edge by its distance in pixels,
 * |F| / |∇F| (confirmed by a Newton step that crosses it), so the edge is an
 * antialiasing pixel wide at most and u never leaves [0, 1]. For inequalities,
 * the smallest max of the constraints below 0.
 */
export function projFrag(field: string, relation: 'eq' | 'ineq', slope?: string, params?: string[]): string {
  const R = PROJECTION_REFINE;
  const step =
    relation === 'eq'
      ? `
    float sl = ${slope ? 'abs(S(p.x, p.y, s))' : '2.0 * (had ? abs(f - prev) : 0.0)'};
    if (abs(f) < near) {
      near = abs(f);
      best = s;
    }
    if (f == 0.0 || (had && prev * f <= 0.0)) inside = true;
    else if (had && !inside && min(abs(f), abs(prev)) <= 0.5 * max(sl, prevSl) * du) {
      float q = prev;
      for (int j = 1; j < ${R}; j++) {
        float s2 = s - du + float(j) * (du / ${R}.0);
        float g = F(p.x, p.y, s2);
        if (isnan(g) || isinf(g)) continue;
        if (abs(g) < near) {
          near = abs(g);
          best = s2;
        }
        if (q * g <= 0.0) inside = true;
        q = g;
      }
    }
    prevSl = sl;`
      : `
    near = min(near, f);`;
  const cover =
    relation === 'eq'
      ? `
  float cover = 1.0;
  if (!inside) {
    // Distance in pixels to the nearest member, from its gradient on screen.
    vec2 h = uUpp;
    float f0 = F(p.x, p.y, best);
    vec2 g = 0.5 * vec2(F(p.x + h.x, p.y, best) - F(p.x - h.x, p.y, best), F(p.x, p.y + h.y, best) - F(p.x, p.y - h.y, best));
    float g2 = dot(g, g);
    float dist = abs(f0) / sqrt(max(g2, 1e-30));
    // Near a fold of F the straight line misleads: step 1.5x toward the
    // member and keep the feather only if F changes sign there.
    vec2 q = p - 1.5 * f0 / max(g2, 1e-30) * g * h;
    float f1 = F(q.x, q.y, best);
    cover = dist < 1.0 && f0 * f1 <= 0.0 ? 1.0 - dist : 0.0;
  }`
      : `
  float aa = max(fwidth(near), 1e-24);
  float cover = 1.0 - smoothstep(-aa, aa, near);`;
  return `#version 300 es
precision highp float;
uniform vec2 uCenter;
uniform vec2 uUpp;
uniform vec2 uRes;
uniform vec2 uOrigin;
uniform vec3 uColor;
uniform float t;
${paramDecls(params)}
out vec4 outColor;
${GLSL_PRELUDE}
float F(float x, float y, float u) { return ${field}; }
${slope ? `float S(float x, float y, float u) { return ${slope}; }` : ''}
void main() {
  vec2 p = uCenter + (gl_FragCoord.xy - uOrigin - 0.5 * uRes) * uUpp;
  const float du = 1.0 / float(${PROJECTION_SAMPLES - 1});
  bool inside = false;
  float near = 1e30;
  float best = 0.0;
  float prev = 0.0;
  float prevSl = 0.0;
  bool had = false;
  for (int k = 0; k < ${PROJECTION_SAMPLES}; k++) {
    float s = float(k) * du;
    float f = F(p.x, p.y, s);
    if (isnan(f) || isinf(f)) {
      had = false;
      continue;
    }${step}
    prev = f;
    had = true;
  }${cover}
  float alpha = cover * 0.22;
  if (alpha < 0.004) discard;
  outColor = vec4(uColor, alpha);
}
`;
}

const CELLS_FRAG = `#version 300 es
precision highp float;
uniform vec2 uCenter;
uniform vec2 uUpp;
uniform vec2 uRes;
uniform vec2 uOrigin;
uniform vec3 uColor;
uniform highp usampler2D uCells;
uniform vec2 uSize;
uniform vec2 uCorner;
uniform vec2 uRuns;
out vec4 outColor;
void main() {
  vec2 p = uCenter + (gl_FragCoord.xy - uOrigin - 0.5 * uRes) * uUpp;
  float row = floor(0.5 - p.y) - uCorner.y;
  float col = floor(p.x + 0.5) - uCorner.x;
  if (uRuns.y > 0.5) row = clamp(row, 0.0, uSize.y - 1.0);
  else if (row < 0.0 || row >= uSize.y) discard;
  if (uRuns.x > 0.5) col = clamp(col, 0.0, uSize.x - 1.0);
  else if (col < 0.0 || col >= uSize.x) discard;
  float v = float(texelFetch(uCells, ivec2(int(col), int(row)), 0).r) / 255.0;
  if (v <= 0.0) discard;
  // Once cells are big enough to count, a hairline gap keeps them apart.
  vec2 px = 1.0 / uUpp;
  vec2 edge = (0.5 - abs(fract(vec2(p.x, -p.y) + 0.5) - 0.5)) * px;
  float gap = min(px.x, px.y) >= 8.0 && min(edge.x, edge.y) < 0.75 ? 0.55 : 1.0;
  outColor = vec4(uColor, 0.92 * v * gap);
}
`;

export class Renderer2D {
  private cache: ProgramCache;
  /** Cell textures by the shade buffer they were uploaded from. */
  private cellTextures = new Map<Uint8Array, WebGLTexture>();
  /** Shade buffers drawn since the last endFrame. */
  private cellsDrawn = new Set<Uint8Array>();
  constructor(
    private gl: WebGL2RenderingContext,
    private quad: { draw(): void },
  ) {
    this.cache = new ProgramCache(gl);
  }

  /** The texture for these cells, uploaded once per buffer; textures no
   *  layer drew this frame are dropped (endFrame). */
  private cellTexture(c: Cells2D): WebGLTexture {
    const { gl } = this;
    let tex = this.cellTextures.get(c.shades);
    if (tex) return tex;
    tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8UI, c.width, c.rows, 0, gl.RED_INTEGER, gl.UNSIGNED_BYTE, c.shades);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    this.cellTextures.set(c.shades, tex);
    return tex;
  }

  render(
    view: View2D,
    layers: Layers2D,
    time = 0,
    env: Record<string, number> = {},
    gridSpecs?: GridSpec[],
    frame: Frame = {},
  ): void {
    const { gl } = this;
    const { x: ox, y: oy, w, h } = frame.vp ?? { x: 0, y: 0, w: gl.drawingBufferWidth, h: gl.drawingBufferHeight };
    gl.viewport(ox, oy, w, h);
    gl.disable(gl.DEPTH_TEST);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

    const grid = frame.grid ?? 'on';
    const maps = frame.maps ?? {};
    let specs = grid === 'off' ? [] : gridSpecs;
    if (grid !== 'off' && !specs?.length && frame.lattice) specs = latticeGrid(view);
    else if (grid !== 'off' && !specs?.length) {
      const spacing = niceSpacing(view.upp, 90);
      const spacingY = niceSpacing(view.upp / (view.ratio ?? 1), 90);
      // A mapped axis is gridded at its ticks below, not evenly here.
      const cartesian: GridSpec[] = [
        { glsl: 'x', gradGlsl: ['1.0', '0.0'], params: [], major: spacing.major, minor: spacing.minor },
        { glsl: 'y', gradGlsl: ['0.0', '1.0'], params: [], major: spacingY.major, minor: spacingY.minor },
      ];
      specs = cartesian.filter(s => !maps[s.glsl as 'x' | 'y']);
    }
    try {
      const gridSpecsDrawn = specs ?? [];
      const prog = this.cache.get(QUAD_VERT, gridFrag(gridSpecsDrawn, grid === 'axes'));
      gl.useProgram(prog);
      gl.uniform2f(gl.getUniformLocation(prog, 'uCenter'), view.cx, view.cy);
      gl.uniform2f(gl.getUniformLocation(prog, 'uUpp'), view.upp, view.upp / (view.ratio ?? 1));
      gl.uniform2f(gl.getUniformLocation(prog, 'uRes'), w, h);
      gl.uniform2f(gl.getUniformLocation(prog, 'uOrigin'), ox, oy);
      const tLoc = gl.getUniformLocation(prog, 't');
      if (tLoc) gl.uniform1f(tLoc, time);
      gridSpecsDrawn.forEach((s, k) => {
        gl.uniform1f(gl.getUniformLocation(prog, `uMajor${k}`), s.major);
        gl.uniform1f(gl.getUniformLocation(prog, `uMinor${k}`), s.minor);
        for (const p of s.params) {
          const loc = gl.getUniformLocation(prog, uniformName(p));
          if (loc) gl.uniform1f(loc, env[p] ?? 0);
        }
      });
      this.quad.draw();
      const mapped = (['x', 'y'] as const).filter(a => maps[a]);
      if (grid !== 'off' && mapped.length && !frame.lattice) {
        const ticks = mappedTicks(view, w, h, maps);
        const tp = this.cache.get(QUAD_VERT, tickFrag(mapped));
        gl.useProgram(tp);
        gl.uniform2f(gl.getUniformLocation(tp, 'uCenter'), view.cx, view.cy);
        gl.uniform2f(gl.getUniformLocation(tp, 'uUpp'), view.upp, view.upp / (view.ratio ?? 1));
        gl.uniform2f(gl.getUniformLocation(tp, 'uRes'), w, h);
        gl.uniform2f(gl.getUniformLocation(tp, 'uOrigin'), ox, oy);
        for (const a of mapped) {
          const t = ticks[a]!;
          const axesOnly = grid === 'axes';
          const major = axesOnly ? [] : t.major.slice(0, MAX_MAJOR_TICKS).map(m => m.at);
          const minor = axesOnly ? [] : t.minor.slice(0, MAX_MINOR_TICKS);
          // Padded to whole vec4s; entries past the count are never read.
          const packed = (v: number[]) => {
            const out = new Float32Array(Math.ceil(v.length / 4) * 4);
            out.set(v);
            return out;
          };
          if (major.length) gl.uniform4fv(gl.getUniformLocation(tp, `uMaj${a}`), packed(major));
          if (minor.length) gl.uniform4fv(gl.getUniformLocation(tp, `uMin${a}`), packed(minor));
          gl.uniform1i(gl.getUniformLocation(tp, `uNMaj${a}`), major.length);
          gl.uniform1i(gl.getUniformLocation(tp, `uNMin${a}`), minor.length);
          gl.uniform1f(gl.getUniformLocation(tp, `uZero${a}`), t.zero ?? 0);
          gl.uniform1i(gl.getUniformLocation(tp, `uHasZero${a}`), t.zero === null ? 0 : 1);
        }
        this.quad.draw();
      }
    } catch (e) {
      console.error(e);
    }

    const drawProgram = (
      frag: string,
      color: [number, number, number],
      params?: string[],
      uniforms?: Record<string, number>,
      extra?: (prog: WebGLProgram) => void,
    ) => {
      let prog: WebGLProgram;
      try {
        prog = this.cache.get(QUAD_VERT, frag);
      } catch (e) {
        console.error(e);
        return;
      }
      gl.useProgram(prog);
      gl.uniform2f(gl.getUniformLocation(prog, 'uCenter'), view.cx, view.cy);
      gl.uniform2f(gl.getUniformLocation(prog, 'uUpp'), view.upp, view.upp / (view.ratio ?? 1));
      gl.uniform2f(gl.getUniformLocation(prog, 'uRes'), w, h);
      gl.uniform2f(gl.getUniformLocation(prog, 'uOrigin'), ox, oy);
      gl.uniform3f(gl.getUniformLocation(prog, 'uColor'), ...color);
      const tLoc = gl.getUniformLocation(prog, 't');
      if (tLoc) gl.uniform1f(tLoc, time);
      for (const p of params ?? []) {
        const loc = gl.getUniformLocation(prog, uniformName(p));
        if (loc) gl.uniform1f(loc, env[p] ?? 0);
      }
      for (const [name, value] of Object.entries(uniforms ?? {})) {
        const loc = gl.getUniformLocation(prog, name);
        if (loc) gl.uniform1f(loc, value);
      }
      extra?.(prog);
      this.quad.draw();
    };
    const drawField = (item: Curve2D, frag: (f: string, params?: string[]) => string) =>
      drawProgram(frag(item.field, item.params), item.color, item.params, item.uniforms);

    // Contour stacks sit just above the grid, under everything else, so the
    // solid level and any other layer stay readable on top.
    for (const lv of layers.levels ?? []) {
      drawProgram(levelsFrag(lv), lv.color, lv.params, undefined, prog => {
        gl.uniform1f(gl.getUniformLocation(prog, 'uMajor'), lv.major);
        gl.uniform1f(gl.getUniformLocation(prog, 'uMinor'), lv.minor);
      });
    }
    for (const c of layers.cells ?? []) {
      this.cellsDrawn.add(c.shades);
      const tex = this.cellTexture(c);
      drawProgram(CELLS_FRAG, c.color, undefined, undefined, prog => {
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.uniform1i(gl.getUniformLocation(prog, 'uCells'), 0);
        gl.uniform2f(gl.getUniformLocation(prog, 'uSize'), c.width, c.rows);
        gl.uniform2f(gl.getUniformLocation(prog, 'uCorner'), c.x0, c.y0);
        gl.uniform2f(gl.getUniformLocation(prog, 'uRuns'), +c.runs.x, +c.runs.y);
      });
    }
    for (const f of layers.fractals ?? []) {
      drawProgram(fractalFrag(f.step, f.seed, f.maxIter, f.params), f.color, f.params);
    }
    for (const d of layers.domains ?? []) drawField(d, domainFrag);
    for (const c of layers.colors ?? []) drawField(c, (field, params) => colorFrag(field, params, c.locals, c.space));
    for (const c of layers.conformals ?? []) drawField(c, conformalFrag);
    for (const f of layers.vfields ?? []) drawProgram(vfieldFrag(f.fx, f.fy, f.params), f.color, f.params, f.uniforms);
    for (const f of layers.tfields ?? []) {
      const frag = (f.streamlines ? tlinesFrag : tfieldFrag)(f.entries, f.params, f.jacobian);
      drawProgram(frag, f.color, f.params, f.uniforms);
    }
    for (const q of layers.ineqs ?? []) drawField(q, (f, ps) => ineqFrag(f, q.edges, ps));
    for (const q of layers.projections ?? []) drawField(q, (f, ps) => projFrag(f, q.relation, q.slope, ps));
    for (const b of layers.bifs ?? []) drawField(b, bifFrag);
    for (const s of layers.scalars ?? [])
      drawProgram(scalarFrag(s.field, s.params), s.color, s.params, s.uniforms, prog =>
        gl.uniform1f(gl.getUniformLocation(prog, 'uGain'), s.gain ?? 0.6),
      );
    for (const c of layers.complexes ?? []) drawField(c, complexFrag);
    for (const c of layers.curves ?? []) drawField(c, (field, params) => curveFrag(field, params, c.graphEval));
  }

  /** Drop cell textures no render drew since the last call: once per frame,
   *  after every panel of a split view has rendered. */
  endFrame() {
    for (const [shades, tex] of this.cellTextures) {
      if (!this.cellsDrawn.has(shades)) {
        this.gl.deleteTexture(tex);
        this.cellTextures.delete(shades);
      }
    }
    this.cellsDrawn.clear();
  }
}

/**
 * A lattice panel's labels: cell values in their cells, the column indices
 * along the top edge and the row indices down the left (cell centres, at
 * the grid's major spacing), and the axis names in the corner.
 */
function drawLatticeLabels(
  ctx: CanvasRenderingContext2D,
  lattice: LatticeLabels,
  numbers: boolean,
  view: View2D,
  w: number,
  h: number,
  upp: number,
  uppY: number,
  toScreenX: (x: number) => number,
  toScreenY: (y: number) => number,
) {
  const cell = Math.min(1 / upp, 1 / uppY);
  if (lattice.values?.length && cell >= LATTICE_VALUE_PX) {
    const size = Math.min(15, Math.max(9, cell * 0.38));
    ctx.save();
    ctx.font = `${size}px ui-sans-serif, system-ui`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineWidth = 3;
    ctx.lineJoin = 'round';
    ctx.strokeStyle = cssRgb(theme.bg);
    ctx.fillStyle = theme.label;
    for (const v of lattice.values) {
      const sx = toScreenX(v.i),
        sy = toScreenY(-v.k);
      if (sx < -cell || sx > w + cell || sy < -cell || sy > h + cell) continue;
      ctx.strokeText(v.text, sx, sy);
      ctx.fillText(v.text, sx, sy);
    }
    ctx.restore();
  }
  const [across, down] = lattice.axes;
  const corner = `${across} → ${down} ↓`;
  ctx.save();
  ctx.font = '11px ui-sans-serif, system-ui';
  ctx.fillStyle = theme.label;
  ctx.lineWidth = 3;
  ctx.lineJoin = 'round';
  ctx.strokeStyle = cssRgb(theme.bg);
  const label = (text: string, x: number, y: number) => {
    ctx.strokeText(text, x, y);
    ctx.fillText(text, x, y);
  };
  // The corner note sits bottom left, clear of the equation panel.
  if (numbers) {
    // The grid's own spacing (device px), so every number sits on a major line.
    const { major } = latticeSpacing(view.upp);
    const majorY = latticeSpacing(view.upp / (view.ratio ?? 1)).major;
    const left = Math.ceil(invX(toScreenX, 0) / major) * major;
    ctx.textAlign = 'center';
    for (let i = left; toScreenX(i) < w; i += major) {
      const sx = toScreenX(i);
      if (sx > 24) label(String(i), sx, 13);
    }
    ctx.textAlign = 'left';
    const top = Math.ceil(-invY(toScreenY, 0) / majorY) * majorY;
    for (let k = top; toScreenY(-k) < h; k += majorY) {
      const sy = toScreenY(-k);
      if (sy > 24 && sy < h - 24) label(String(k), 4, sy + 4);
    }
  }
  ctx.textAlign = 'left';
  label(lattice.status ? `${corner}    ${lattice.status}` : corner, 6, h - 8);
  ctx.restore();
}

/** The plane coordinate at a screen coordinate, for a linear toScreen map. */
const invX = (to: (x: number) => number, s: number) => {
  const a = to(0),
    b = to(1);
  return (s - a) / (b - a);
};
const invY = invX;

const cssRgb = ([r, g, b]: readonly number[]) =>
  `rgb(${Math.round(r * 255)}, ${Math.round(g * 255)}, ${Math.round(b * 255)})`;

/** Arrowhead length for vector(…) rows, in CSS px. */
const ARROW_HEAD_PX = 12;

export interface Overlay2D {
  /** hot: pointer is over it (or dragging it) — drawn with a grab halo.
   *  label: text drawn beside the point (a named point's name).
   *  r: dot radius in CSS px (sequence/list dots draw slightly smaller).
   *  bare: no outline — in a dense scatter the outlines of later dots paint
   *  over the fill of earlier ones, turning the whole trace the outline
   *  colour. */
  points: Array<{ x: number; y: number; color: string; hot?: boolean; label?: string; r?: number; bare?: boolean }>;
  /** Bulk scatters backed by typed arrays (CSV columns): drawn as plain
   *  squares under everything else, since at these counts a dot is a pixel. */
  clouds?: Array<{ xs: Float64Array; ys: Float64Array; color: string; r?: number }>;
  /** closed joins the last vertex back to the first; fill (a CSS color,
   *  usually translucent) paints the enclosed region when every vertex is
   *  finite. arrow puts a head at the last vertex, sized in CSS px so it does
   *  not scale with zoom. noStroke fills only (the outline is its own entry). */
  polylines: Array<{
    pts: number[];
    color: string;
    closed?: boolean;
    fill?: string;
    width?: number;
    arrow?: boolean;
    noStroke?: boolean;
  }>;
  /** Filled parametric regions: triangles [x0, y0, x1, y1, x2, y2, …], all
   *  counter-clockwise (lib/path.ts regionSampler), filled as one path by the
   *  nonzero rule, so overlaps show once. No outline. */
  regions?: Array<{ tris: Float64Array; fill: string }>;
  /** Vertical bars from y = 0, or from `base` (±Infinity: the window's
   *  bottom or top edge), halfWidth in math units (histograms). */
  bars?: Array<{ x: number; y: number; halfWidth: number; color: string; base?: number }>;
  /** `label(point, "text")` rows: text beside a math point, drawn above everything. */
  texts?: Array<{ x: number; y: number; text: string; color: string }>;
  /** A graph's vertices (lib/graph.ts): a ring of GRAPH_NODE_PX with the
   *  vertex's value in it, filled in its colour when marked (`mark(v)`). */
  nodes?: Array<{ x: number; y: number; text: string; color: string; mark?: boolean }>;
  /** Small text centred on a math point, haloed: a graph edge's labels. */
  tags?: Array<{ x: number; y: number; text: string; color: string }>;
  /** Many small glyphs, each list one path (light cones, lib/light-cone.ts
   *  coneGlyphs): `rings` closed, filled with `fill` and outlined; `lines`
   *  stroked thinly; runs of both end with NaN, NaN. `dots` are x, y pairs,
   *  drawn as discs. `lineWidth` and `lineAlpha` make the strokes bolder
   *  (tidal glyphs, lib/tidal.ts: solid bars). */
  glyphs?: Array<{
    rings: number[];
    lines: number[];
    dots: number[];
    color: string;
    fill: string;
    lineWidth?: number;
    lineAlpha?: number;
  }>;
}

/** Where an overlay's lists end, so what one row adds can be told apart. */
export interface OverlayMark {
  points: number;
  clouds: number;
  polylines: number;
  regions: number;
  texts: number;
  bars: number;
}

export function markOverlay(o: Overlay2D): OverlayMark {
  return {
    points: o.points.length,
    clouds: o.clouds?.length ?? 0,
    polylines: o.polylines.length,
    regions: o.regions?.length ?? 0,
    texts: o.texts?.length ?? 0,
    bars: o.bars?.length ?? 0,
  };
}

/** A straight segment is cut until each mapped piece strays from its chord
 *  by under this fraction of the segment's mapped length (a straight run in
 *  x and y is a curve on a log axis), into at most 2^depth pieces. A sampled
 *  curve's short segments are already straight on screen, so most cost one
 *  extra evaluation. */
const MAPPED_BEND = 0.0005;
const MAPPED_DEPTH = 12;

/** Carries a point to the screen; a plane map follows on from `hint`, the
 *  screen point of a neighbour, so a line stays on one copy of the plane. */
type Carry = (x: number, y: number, hint?: readonly [number, number]) => [number, number];

/** Mapped points of the straight segment a → b, a included, b not, and b
 *  mapped, to follow the next segment on from. `from` is a's neighbour. */
function mappedSegment(
  a: [number, number],
  b: [number, number],
  map: Carry,
  from?: readonly [number, number],
): [number[], [number, number]] {
  const out: number[] = [];
  const shown = (p: readonly [number, number]) => isFinite(p[0]) && isFinite(p[1]);
  const pa = map(a[0], a[1], from && shown(from) ? from : undefined);
  const pb = map(b[0], b[1], shown(pa) ? pa : undefined);
  const tol = MAPPED_BEND * Math.hypot(pb[0] - pa[0], pb[1] - pa[1]);
  const split = (t0: number, p0: [number, number], t1: number, p1: [number, number], depth: number) => {
    const t = (t0 + t1) / 2;
    const hint: [number, number] | undefined =
      shown(p0) && shown(p1) ? [(p0[0] + p1[0]) / 2, (p0[1] + p1[1]) / 2] : shown(p0) ? p0 : shown(p1) ? p1 : undefined;
    const pm = map(a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, hint);
    // Where the map stops (one end shown, one not) the piece is cut as far
    // as depth allows, so the line breaks close to the edge; a piece shown
    // at both ends is cut while it bends; one shown at neither is a gap.
    let cut: boolean;
    if (shown(p0) !== shown(p1)) cut = true;
    else if (!shown(p0)) cut = false;
    else {
      const [dx, dy] = [p1[0] - p0[0], p1[1] - p0[1]];
      const off = Math.abs((pm[0] - p0[0]) * dy - (pm[1] - p0[1]) * dx) / (Math.hypot(dx, dy) || 1);
      // With an end past the map the segment has no mapped length: the
      // piece's own stands in, which shrinks as it is cut.
      cut = !shown(pm) || off > (isFinite(tol) ? tol : 4 * MAPPED_BEND * Math.hypot(dx, dy));
    }
    if (depth < MAPPED_DEPTH && cut) {
      split(t0, p0, t, pm, depth + 1);
      split(t, pm, t1, p1, depth + 1);
    } else out.push(...p0);
  };
  split(0, pa, 1, pb, 0);
  return [out, pb];
}

/** A cloud's mapped columns, kept while its arrays and the map are the same
 *  (a CSV column is reused frame after frame). */
const mappedColumns = new WeakMap<Float64Array, { map: AxisMap | undefined; out: Float64Array }>();
function mappedColumn(col: Float64Array, map: AxisMap | undefined): Float64Array {
  if (!map) return col;
  const hit = mappedColumns.get(col);
  if (hit?.map === map) return hit.out;
  const out = col.map(v => mapToScreen(map, v));
  mappedColumns.set(col, { map, out });
  return out;
}

/**
 * Carry what a row added to the overlay since `mark` from x and y to a mapped
 * panel's screen coordinates (lib/axis-map.ts). Positions the map cannot
 * show (x ≤ 0 on a log axis) become NaN: points there are dropped, and lines
 * break there, as they do at any other gap.
 */
export function mapOverlay(o: Overlay2D, mark: OverlayMark, maps: AxisMaps, box?: ScreenBox): void {
  if (maps.plane) {
    // Its way back is built over the window: without one, nothing could be
    // placed, and drawing x and y as the screen's X and Y would be wrong.
    if (!box) throw new Error('mapOverlay needs the screen window to carry rows through a plane map.');
    planeOverlay(o, mark, planeInverse(maps.plane, box));
    return;
  }
  const mx = maps.x ? (v: number) => mapToScreen(maps.x!, v) : (v: number) => v;
  const my = maps.y ? (v: number) => mapToScreen(maps.y!, v) : (v: number) => v;
  const kept = o.points.slice(mark.points).flatMap(p => {
    const [x, y] = [mx(p.x), my(p.y)];
    return isFinite(x) && isFinite(y) ? [{ ...p, x, y }] : [];
  });
  o.points.splice(mark.points, Infinity, ...kept);
  for (const c of o.clouds?.slice(mark.clouds) ?? []) {
    c.xs = mappedColumn(c.xs, maps.x);
    c.ys = mappedColumn(c.ys, maps.y);
  }
  const both = (x: number, y: number): [number, number] => [mx(x), my(y)];
  mapPolylines(o, mark, both);
  for (const r of o.regions?.slice(mark.regions) ?? []) {
    const tris = new Float64Array(r.tris.length);
    for (let k = 0; k + 1 < tris.length; k += 2) {
      tris[k] = mx(r.tris[k]);
      tris[k + 1] = my(r.tris[k + 1]);
    }
    r.tris = tris;
  }
  for (const t of o.texts?.slice(mark.texts) ?? []) {
    t.x = mx(t.x);
    t.y = my(t.y);
  }
  // A bar keeps its edges, and stands on y = 0 where the map shows it; a log
  // axis does not, so there it rises from the window's edge, as y = 0 lies
  // past every value the axis shows.
  for (const b of o.bars?.slice(mark.bars) ?? []) {
    const [l, r] = [mx(b.x - b.halfWidth), mx(b.x + b.halfWidth)];
    b.x = (l + r) / 2;
    b.halfWidth = (r - l) / 2;
    if (maps.y) b.base = toScreenOrEdge(maps.y, b.base ?? 0);
    b.y = my(b.y);
  }
}

/** Carry each polyline added since `mark`, its straight runs cut where the
 *  map bends them, each segment followed on from the last. */
function mapPolylines(o: Overlay2D, mark: OverlayMark, map: Carry): void {
  for (const l of o.polylines.slice(mark.polylines)) {
    const { pts } = l;
    const n = pts.length / 2;
    const out: number[] = [];
    const vertex = (k: number): [number, number] => [pts[(2 * k) % pts.length], pts[(2 * k + 1) % pts.length]];
    let last: [number, number] | undefined;
    for (let k = 0; k < (l.closed ? n : n - 1); k++) {
      const [piece, end] = mappedSegment(vertex(k), vertex(k + 1), map, last);
      out.push(...piece);
      last = end;
    }
    // The last vertex, unless closing back to the first draws it.
    if (!l.closed && n) out.push(...(n > 1 && last ? last : map(...vertex(n - 1))));
    l.pts = out;
  }
}

/**
 * mapOverlay through a plane map (lib/plane-map.ts), whose way back is found
 * numerically. A point is drawn wherever the screen shows it (twice, on an
 * angle range wider than 2π); a line, a region's triangle and a cloud's dot
 * at one place, a line followed along from its start and cut where it
 * cannot be (the seam of an angle).
 */
function planeOverlay(o: Overlay2D, mark: OverlayMark, inverse: PlaneInverse): void {
  const kept = o.points.slice(mark.points).flatMap(p => inverse.all(p.x, p.y).map(([x, y]) => ({ ...p, x, y })));
  o.points.splice(mark.points, Infinity, ...kept);
  for (const c of o.clouds?.slice(mark.clouds) ?? []) [c.xs, c.ys] = planeCloud(c.xs, c.ys, inverse);
  for (const l of o.polylines.slice(mark.polylines)) {
    const { pts } = l;
    const vertex = (k: number): [number, number] => [pts[2 * k], pts[2 * k + 1]];
    const fill = !!(l.fill && l.closed);
    const key = `${fill}${!!l.closed}`;
    let shapes = planeLineCache.get(pts);
    if (shapes?.inverse !== inverse || shapes.key !== key) {
      shapes = {
        inverse,
        key,
        // A shape to fill stays one shape, on each copy of the plane it shows on.
        // A line on each copy the window shows.
        out: fill
          ? planeShapes(inverse, pts.length / 2, vertex, mappedSegment)
          : planeLines(inverse, pts.length / 2, vertex, !!l.closed, mappedSegment).map(line => ({
              pts: line,
              // Cut into pieces, it no longer closes on itself.
              closed: !!l.closed && line.every(Number.isFinite),
            })),
      };
      planeLineCache.set(pts, shapes);
    }
    const [first, ...more] = shapes.out.map(shape =>
      !fill
        ? { ...l, pts: shape.pts, closed: shape.closed }
        : !shape.closed
          ? { ...l, pts: shape.pts, closed: false, fill: undefined }
          : shape.stroke === false
            ? { ...l, pts: shape.pts, noStroke: true }
            : { ...l, pts: shape.pts },
    );
    Object.assign(l, first ?? { pts: [] });
    o.polylines.push(...more);
  }
  for (const r of o.regions?.slice(mark.regions) ?? []) r.tris = planeTriangles(r.tris, inverse);
  for (const t of o.texts?.slice(mark.texts) ?? []) [t.x, t.y] = inverse.first(t.x, t.y);
}

/** Lines and shapes through a plane map, kept while their points and the
 *  window stay (a sampled curve's points are reused frame after frame). */
const planeLineCache = new WeakMap<number[], { inverse: PlaneInverse; key: string; out: PlaneShape[] }>();

/** A cloud's columns through a plane map, kept while the columns and the
 *  window stay (a CSV column is reused frame after frame). */
const planeClouds = new WeakMap<
  Float64Array,
  { ys: Float64Array; inverse: PlaneInverse; out: [Float64Array, Float64Array] }
>();
function planeCloud(xs: Float64Array, ys: Float64Array, inverse: PlaneInverse): [Float64Array, Float64Array] {
  const hit = planeClouds.get(xs);
  if (hit?.ys === ys && hit.inverse === inverse) return hit.out;
  const out: [Float64Array, Float64Array] = [new Float64Array(xs.length), new Float64Array(xs.length)];
  for (let k = 0; k < xs.length; k++) [out[0][k], out[1][k]] = inverse.first(xs[k], ys[k]);
  planeClouds.set(xs, { ys, inverse, out });
  return out;
}

/** A region's triangles through a plane map (PlaneInverse.triangles), kept
 *  while the triangles and the window stay. */
const planeRegions = new WeakMap<Float64Array, { inverse: PlaneInverse; out: Float64Array }>();
function planeTriangles(tris: Float64Array, inverse: PlaneInverse): Float64Array {
  const hit = planeRegions.get(tris);
  if (hit?.inverse === inverse) return hit.out;
  const out = inverse.triangles(tris);
  planeRegions.set(tris, { inverse, out });
  return out;
}

/** A graph vertex's radius in CSS px. */
export const GRAPH_NODE_PX = 13;

/** A panel's box on the overlay, in CSS pixels from the top-left corner. */
export interface OverlayBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Save the overlay and set it up for one panel: CSS-pixel units, the panel's
 * corner at the origin and everything clipped to its box. Without a box the
 * whole overlay is the panel and is cleared first. A split view clears the
 * overlay once per frame, before its panels draw, and each panel clears its
 * own box too, so an inset hides what its host drew beneath it.
 */
export function beginOverlay(ctx: CanvasRenderingContext2D, dpr: number, box?: OverlayBox): { w: number; h: number } {
  ctx.save();
  ctx.scale(dpr, dpr);
  if (!box) {
    const w = ctx.canvas.width / dpr;
    const h = ctx.canvas.height / dpr;
    ctx.clearRect(0, 0, w, h);
    return { w, h };
  }
  ctx.translate(box.x, box.y);
  ctx.beginPath();
  ctx.rect(0, 0, box.w, box.h);
  ctx.clip();
  ctx.clearRect(0, 0, box.w, box.h);
  return { w: box.w, h: box.h };
}

/** A label's text beside its anchor, haloed in the page background so it
 *  stays legible across curves and gridlines. Shared with the 3D overlay. */
export function drawTextLabel(ctx: CanvasRenderingContext2D, text: string, sx: number, sy: number, color: string) {
  ctx.save();
  ctx.font = '600 13px ui-sans-serif, system-ui';
  ctx.lineJoin = 'round';
  ctx.lineWidth = 4;
  ctx.strokeStyle = `rgb(${theme.bg.map(c => Math.round(c * 255)).join(',')})`;
  ctx.strokeText(text, sx + 8, sy - 8);
  ctx.fillStyle = color;
  ctx.fillText(text, sx + 8, sy - 8);
  ctx.restore();
}

/** What a lattice panel labels (docs/discrete.md). */
export interface LatticeLabels {
  /** The index names across and down, as the view row or the rows name them. */
  axes: readonly [string, string];
  /** Values to print in their cells (cell (i, k)), once cells are big enough to read. */
  values?: Array<{ i: number; k: number; text: string }>;
  /** A corner note, like which generation a board shows. */
  status?: string;
}

/** Below this many CSS px per cell, lattice values are not printed. */
export const LATTICE_VALUE_PX = 18;

/** Axis labels plus CPU-sampled geometry (points, parametric curves).
 *  numbers=false skips the axis numerals (custom coordinate grids have no
 *  straight axes to label them along). A lattice panel numbers its cells
 *  instead, along the top and left edges. */
export function drawLabels2D(
  ctx: CanvasRenderingContext2D,
  view: View2D,
  dpr: number,
  extras?: Overlay2D,
  numbers = true,
  box?: OverlayBox,
  lattice?: LatticeLabels,
  maps: AxisMaps = {},
): void {
  const { w, h } = beginOverlay(ctx, dpr, box);
  ctx.font = '11px ui-sans-serif, system-ui';
  ctx.fillStyle = theme.label;

  const upp = view.upp * dpr; // math units per CSS pixel
  const { major } = niceSpacing(view.upp, 90);
  const uppY = upp / (view.ratio ?? 1);
  const majorY = niceSpacing(view.upp / (view.ratio ?? 1), 90).major;
  const toScreenX = (x: number) => (x - view.cx) / upp + w / 2;
  const toScreenY = (y: number) => h / 2 - (y - view.cy) / uppY;

  const fmt = (v: number) => {
    if (v === 0) return '0';
    const a = Math.abs(v);
    if (a >= 1e5 || a < 1e-4) return v.toExponential(0).replace('e+', 'e');
    return String(parseFloat(v.toPrecision(10)));
  };

  if (lattice) drawLatticeLabels(ctx, lattice, numbers, view, w, h, upp, uppY, toScreenX, toScreenY);
  else if (numbers) {
    // A mapped axis is labelled at its ticks, in its own units; its zero
    // (none on a log axis) is where the other axis's labels run, or else
    // they run along the panel's edge.
    const ticks = mappedTicks(view, w * dpr, h * dpr, maps);
    const zeroX = maps.x ? (ticks.x!.zero ?? -Infinity) : 0;
    const zeroY = maps.y ? (ticks.y!.zero ?? -Infinity) : 0;
    const axisY = Math.min(Math.max(toScreenY(zeroY), 12), h - 6);
    const axisX = Math.min(Math.max(toScreenX(zeroX), 4), w - 30);
    const xLabel = (x: number, at: number) =>
      ctx.fillText(fmt(x), toScreenX(at) + 2, axisY + 13 <= h ? axisY + 13 : axisY - 4);
    const yLabel = (y: number, at: number) => ctx.fillText(fmt(y), axisX + 4, toScreenY(at) - 3);

    if (ticks.x) {
      for (const t of ticks.x.major) if (t.value !== 0) xLabel(t.value, t.at);
    } else {
      const x0 = Math.ceil((view.cx - (w / 2) * upp) / major) * major;
      const x1 = view.cx + (w / 2) * upp;
      for (let x = x0; x <= x1; x += major) if (Math.abs(x) >= major / 2) xLabel(x, x);
    }
    if (ticks.y) {
      for (const t of ticks.y.major) if (t.value !== 0) yLabel(t.value, t.at);
    } else {
      const y0 = Math.ceil((view.cy - (h / 2) * uppY) / majorY) * majorY;
      const y1 = view.cy + (h / 2) * uppY;
      for (let y = y0; y <= y1; y += majorY) if (Math.abs(y) >= majorY / 2) yLabel(y, y);
    }
  }

  if (extras) {
    // Data clouds first and in bulk: one fillStyle, one rect per point, and
    // off-screen points skipped. A CSV column can be 100k points, where the
    // per-point beginPath/arc/fill/stroke of a named point would not survive
    // a single frame — and at that density outlined dots would merge into a
    // white smear anyway (see .points below).
    for (const cloud of extras.clouds ?? []) {
      ctx.fillStyle = cloud.color;
      const r = cloud.r ?? 1.5;
      const d = r * 2;
      const { xs, ys } = cloud;
      for (let i = 0; i < xs.length; i++) {
        const sx = toScreenX(xs[i]);
        const sy = toScreenY(ys[i]);
        // NaN fails every comparison, so gaps in the data fall out here too.
        if (!(sx > -d && sx < w + d && sy > -d && sy < h + d)) continue;
        ctx.fillRect(sx - r, sy - r, d, d);
      }
    }
    for (const bar of extras.bars ?? []) {
      const sx = toScreenX(bar.x);
      // A base past the window's edge (a log axis's y = 0) is just beyond it.
      const sy0 = Math.min(Math.max(toScreenY(bar.base ?? 0), -2), h + 2);
      const sy = toScreenY(bar.y);
      if (!isFinite(sx) || !isFinite(sy) || !isFinite(sy0)) continue;
      const hw = bar.halfWidth / upp;
      ctx.globalAlpha = 0.3;
      ctx.fillStyle = bar.color;
      ctx.fillRect(sx - hw, Math.min(sy0, sy), hw * 2, Math.abs(sy - sy0));
      ctx.globalAlpha = 1;
      ctx.strokeStyle = bar.color;
      ctx.lineWidth = 1.5;
      ctx.strokeRect(sx - hw, Math.min(sy0, sy), hw * 2, Math.abs(sy - sy0));
    }
    for (const region of extras.regions ?? []) {
      const path = new Path2D();
      const { tris } = region;
      for (let i = 0; i + 5 < tris.length; i += 6) {
        path.moveTo(toScreenX(tris[i]), toScreenY(tris[i + 1]));
        path.lineTo(toScreenX(tris[i + 2]), toScreenY(tris[i + 3]));
        path.lineTo(toScreenX(tris[i + 4]), toScreenY(tris[i + 5]));
        path.closePath();
      }
      ctx.fillStyle = region.fill;
      ctx.fill(path, 'nonzero');
    }
    for (const glyph of extras.glyphs ?? []) {
      // One path each, so a lattice of hundreds costs a fill and two strokes.
      // A ring is closed by a line back to its start, not closePath, which
      // costs Chromium time in proportion to the path so far (quadratic over
      // a lattice of rings).
      const trace = (pts: readonly number[], close: boolean) => {
        const path = new Path2D();
        let pen = false;
        let [x0, y0] = [0, 0];
        for (let i = 0; i + 1 < pts.length; i += 2) {
          if (Number.isNaN(pts[i])) {
            if (pen && close) path.lineTo(x0, y0);
            pen = false;
            continue;
          }
          const sx = toScreenX(pts[i]);
          const sy = toScreenY(pts[i + 1]);
          if (pen) path.lineTo(sx, sy);
          else {
            path.moveTo(sx, sy);
            [x0, y0] = [sx, sy];
          }
          pen = true;
        }
        if (pen && close) path.lineTo(x0, y0);
        return path;
      };
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      if (glyph.rings.length) {
        const rings = trace(glyph.rings, true);
        ctx.fillStyle = glyph.fill;
        ctx.fill(rings);
        ctx.strokeStyle = glyph.color;
        ctx.lineWidth = 1.25;
        ctx.stroke(rings);
      }
      if (glyph.lines.length) {
        ctx.globalAlpha = glyph.lineAlpha ?? 0.55;
        ctx.strokeStyle = glyph.color;
        ctx.lineWidth = glyph.lineWidth ?? 1;
        ctx.stroke(trace(glyph.lines, false));
        ctx.globalAlpha = 1;
      }
      if (glyph.dots.length) {
        const dots = new Path2D();
        for (let i = 0; i + 1 < glyph.dots.length; i += 2) {
          const sx = toScreenX(glyph.dots[i]);
          const sy = toScreenY(glyph.dots[i + 1]);
          dots.moveTo(sx + 1.75, sy);
          dots.arc(sx, sy, 1.75, 0, Math.PI * 2);
        }
        ctx.fillStyle = glyph.color;
        ctx.fill(dots);
      }
      ctx.lineCap = 'butt';
    }
    for (const line of extras.polylines) {
      ctx.strokeStyle = line.color;
      ctx.lineWidth = line.width ?? 2.25;
      ctx.lineJoin = 'round';
      ctx.beginPath();
      let pen = false;
      let broken = false;
      const n = line.pts.length;
      const head =
        line.arrow && n >= 4
          ? arrowHead(
              toScreenX(line.pts[n - 4]),
              toScreenY(line.pts[n - 3]),
              toScreenX(line.pts[n - 2]),
              toScreenY(line.pts[n - 1]),
              ARROW_HEAD_PX,
            )
          : null;
      for (let i = 0; i + 1 < n; i += 2) {
        // The shaft stops inside the head, so the tip stays sharp.
        const last = head && i + 2 >= n;
        const sx = last ? head.shaftEnd[0] : toScreenX(line.pts[i]);
        const sy = last ? head.shaftEnd[1] : toScreenY(line.pts[i + 1]);
        if (!isFinite(sx) || !isFinite(sy)) {
          pen = false;
          broken = true;
          continue;
        }
        if (pen) ctx.lineTo(sx, sy);
        else {
          ctx.moveTo(sx, sy);
          pen = true;
        }
      }
      if (line.closed && pen && !broken) ctx.closePath();
      if (line.fill && !broken) {
        ctx.fillStyle = line.fill;
        ctx.fill();
      }
      if (!line.noStroke) ctx.stroke();
      if (head) {
        ctx.beginPath();
        ctx.moveTo(head.tip[0], head.tip[1]);
        ctx.lineTo(head.left[0], head.left[1]);
        ctx.lineTo(head.right[0], head.right[1]);
        ctx.closePath();
        ctx.fillStyle = line.color;
        ctx.fill();
      }
    }
    for (const pt of extras.points) {
      const sx = toScreenX(pt.x);
      const sy = toScreenY(pt.y);
      if (!isFinite(sx) || !isFinite(sy)) continue;
      if (pt.hot) {
        // A ring, not a wash: a translucent disc in the point's own color
        // disappears into a field drawn in that same color.
        ctx.beginPath();
        ctx.arc(sx, sy, 10, 0, Math.PI * 2);
        ctx.lineWidth = 2;
        ctx.strokeStyle = theme.pointOutline;
        ctx.stroke();
        ctx.lineWidth = 1.5;
        ctx.strokeStyle = pt.color;
        ctx.stroke();
      }
      const r = pt.r ?? 5;
      ctx.beginPath();
      ctx.arc(sx, sy, r, 0, Math.PI * 2);
      ctx.fillStyle = pt.color;
      ctx.fill();
      if (!pt.bare) {
        ctx.lineWidth = r < 4 ? 1.25 : 2;
        ctx.strokeStyle = theme.pointOutline;
        ctx.stroke();
      }
      if (pt.label) {
        ctx.font = 'bold 12px ui-sans-serif, system-ui';
        ctx.fillStyle = pt.color;
        ctx.fillText(pt.label, sx + 8, sy - 8);
        ctx.font = '11px ui-sans-serif, system-ui';
      }
    }
  }
  if (extras?.nodes?.length || extras?.tags?.length) {
    ctx.save();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineJoin = 'round';
    const bg = cssRgb(theme.bg);
    ctx.font = '12px ui-sans-serif, system-ui';
    for (const tag of extras.tags ?? []) {
      const sx = toScreenX(tag.x),
        sy = toScreenY(tag.y);
      if (!isFinite(sx) || !isFinite(sy)) continue;
      ctx.lineWidth = 4;
      ctx.strokeStyle = bg;
      ctx.strokeText(tag.text, sx, sy);
      ctx.fillStyle = tag.color;
      ctx.fillText(tag.text, sx, sy);
    }
    ctx.font = '600 12px ui-sans-serif, system-ui';
    for (const node of extras.nodes ?? []) {
      const sx = toScreenX(node.x),
        sy = toScreenY(node.y);
      if (!isFinite(sx) || !isFinite(sy)) continue;
      ctx.beginPath();
      ctx.arc(sx, sy, GRAPH_NODE_PX, 0, Math.PI * 2);
      ctx.fillStyle = node.mark ? node.color : bg;
      ctx.fill();
      ctx.lineWidth = node.mark ? 3 : 1.75;
      ctx.strokeStyle = node.color;
      ctx.stroke();
      ctx.fillStyle = node.mark ? bg : node.color;
      ctx.fillText(node.text, sx, sy + 0.5);
    }
    ctx.restore();
  }
  for (const label of extras?.texts ?? []) {
    const sx = toScreenX(label.x);
    const sy = toScreenY(label.y);
    if (isFinite(sx) && isFinite(sy)) drawTextLabel(ctx, label.text, sx, sy, label.color);
  }
  ctx.restore();
}
