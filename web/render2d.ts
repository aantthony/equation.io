/**
 * 2D graph rendering. Everything is a fullscreen-quad fragment shader:
 * the fragment position is mapped to math coordinates, the equation's field
 * F(x,y) is evaluated per pixel, and the curve F=0 is drawn where the
 * screen-space distance estimate |F| / |∇F| is under the line width.
 */
import { GLSL_PRELUDE } from '../lib/glsl.ts';
import { ProgramCache, QUAD_VERT } from './gl.ts';
import { glslVec3, theme } from './theme.ts';

export interface View2D {
  cx: number;
  cy: number;
  /** Math units per device pixel. */
  upp: number;
}

export interface Curve2D {
  /** GLSL expression for F(x,y) in terms of floats x, y. */
  field: string;
  color: [number, number, number];
  /** User-defined constants the field references (as u_<name> uniforms). */
  params?: string[];
  /** Extra per-item float uniforms set each draw (e.g. a recurrence seed). */
  uniforms?: Record<string, number>;
}

export const paramDecls = (params: string[] = []): string =>
  params.map(p => `uniform float u_${p};`).join('\n');

export interface Ineq2D extends Curve2D {
  /** Fields whose zero sets get a solid boundary line (the <= / >= parts). */
  edges: string[];
}

export interface VField2D {
  /** GLSL expressions for the components (Vx, Vy) in terms of floats x, y. */
  fx: string;
  fy: string;
  color: [number, number, number];
  params?: string[];
}

export interface Fractal2D {
  /** GLSL vec2 expression for one iteration step, in terms of vec2 zc and floats x, y. */
  step: string;
  seed: 'pixel' | 'zero';
  maxIter: number;
  color: [number, number, number];
  params?: string[];
}

/** An orbit diagram: field is f(a, x), iterated per pixel column from uSeed. */
export type Bif2D = Curve2D;

/** Everything drawable in a 2D frame, in back-to-front draw order. */
export interface Layers2D {
  /** Contour stacks of f for `f(x,y) = c` rows; drawn under the other layers. */
  levels?: LevelSpec[];
  fractals?: Fractal2D[];
  domains?: Curve2D[];
  conformals?: Curve2D[];
  vfields?: VField2D[];
  ineqs?: Ineq2D[];
  bifs?: Bif2D[];
  scalars?: Curve2D[];
  complexes?: Curve2D[];
  curves?: Curve2D[];
}

/** Pick a "nice" grid spacing (1, 2, or 5 × 10^k) at least minPx pixels apart. */
export function niceSpacing(upp: number, minPx: number): { major: number; minor: number } {
  const target = upp * minPx;
  const k = Math.floor(Math.log10(target));
  const base = Math.pow(10, k);
  for (const [m, div] of [[1, 5], [2, 4], [5, 5], [10, 5]] as const) {
    if (m * base >= target) return { major: m * base, minor: (m * base) / div };
  }
  return { major: 10 * base, minor: 2 * base };
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

/**
 * The grid is itself a field renderer: each family draws the level sets
 * c = k·spacing via gridLine. The Cartesian grid is the identity pair (x, y).
 */
function gridFrag(specs: GridSpec[]): string {
  const params = [...new Set(specs.flatMap(s => s.params))];
  const decls = specs.map((s, k) => {
    const grad = s.gradGlsl
      ? `vec2 grad${k}(float x, float y) { return vec2(${s.gradGlsl[0]}, ${s.gradGlsl[1]}); }\n`
      : '';
    return `float coord${k}(float x, float y) { return ${s.glsl}; }\n${grad}`
      + `uniform float uMajor${k};\nuniform float uMinor${k};\n`;
  }).join('');
  const blocks = specs.map((s, k) => `
  {
    float c = coord${k}(p.x, p.y);
    if (!isnan(c) && !isinf(c)) {
      float lg = ${s.gradGlsl ? `length(grad${k}(p.x, p.y)) * uUpp` : 'length(vec2(dFdx(c), dFdy(c)))'};
      minorA = max(minorA, gridLine(c, lg, uMinor${k}, 0.5));
      majorA = max(majorA, gridLine(c, lg, uMajor${k}, 0.5));
      axisA = max(axisA, 1.0 - smoothstep(0.9, 1.9, abs(c) / max(lg, 1e-24)));
    }
  }`).join('');
  return `#version 300 es
precision highp float;
uniform vec2 uCenter;
uniform float uUpp;
uniform vec2 uRes;
uniform float t;
${paramDecls(params)}
out vec4 outColor;
${GLSL_PRELUDE}
${decls}
${GRID_LINE_GLSL}
void main() {
  vec2 p = uCenter + (gl_FragCoord.xy - 0.5 * uRes) * uUpp;
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
uniform float uUpp;
uniform vec2 uRes;
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
  vec2 p = uCenter + (gl_FragCoord.xy - 0.5 * uRes) * uUpp;
  float v = F(p.x, p.y);
  if (isnan(v) || isinf(v)) discard;
  float lg = ${spec.gradGlsl ? 'length(gradF(p.x, p.y)) * uUpp' : 'length(vec2(dFdx(v), dFdy(v)))'};
  float a = max(gridLine(v, lg, uMinor, 0.5) * 0.18, gridLine(v, lg, uMajor, 0.5) * 0.45);
  if (a < 0.004) discard;
  outColor = vec4(uColor, a);
}
`;
}

function curveFrag(field: string, params?: string[]): string {
  return `#version 300 es
precision highp float;
uniform vec2 uCenter;
uniform float uUpp;
uniform vec2 uRes;
uniform vec3 uColor;
uniform float t;
${paramDecls(params)}
out vec4 outColor;
${GLSL_PRELUDE}
float F(float x, float y) { return ${field}; }
void main() {
  vec2 p = uCenter + (gl_FragCoord.xy - 0.5 * uRes) * uUpp;
  float v = F(p.x, p.y);
  if (isnan(v) || isinf(v)) discard;

  // Distance estimate |F| / |grad F| in pixels, from central differences at
  // two step sizes. For a genuine zero crossing the two estimates agree; near
  // a pole (y=tan(x) asymptotes, y=1/x at x=0) the first-order estimate is a
  // lie that varies with step size, so disagreement rejects the fake line.
  float h = uUpp;
  vec2 g1 = vec2(F(p.x + h, p.y) - F(p.x - h, p.y),
                 F(p.x, p.y + h) - F(p.x, p.y - h)) / (2.0 * h);
  vec2 g2 = vec2(F(p.x + 0.5 * h, p.y) - F(p.x - 0.5 * h, p.y),
                 F(p.x, p.y + 0.5 * h) - F(p.x, p.y - 0.5 * h)) / h;
  float e1 = abs(v) / max(length(g1) * h, 1e-24);
  float e2 = abs(v) / max(length(g2) * h, 1e-24);

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

  float alpha = 1.0 - smoothstep(1.1, 2.1, distPx);
  if (alpha <= 0.0) discard;
  outColor = vec4(uColor, alpha);
}
`;
}

function scalarFrag(field: string, params?: string[]): string {
  return `#version 300 es
precision highp float;
uniform vec2 uCenter;
uniform float uUpp;
uniform vec2 uRes;
uniform vec3 uColor;
uniform float t;
${paramDecls(params)}
out vec4 outColor;
${GLSL_PRELUDE}
float F(float x, float y) { return ${field}; }
void main() {
  vec2 p = uCenter + (gl_FragCoord.xy - 0.5 * uRes) * uUpp;
  float v = F(p.x, p.y);
  if (isnan(v) || isinf(v)) discard;
  // Density map: positive values fade the color in, like the old scalar2.
  float a = 0.62 * clamp(v, 0.0, 1.0);
  if (a < 0.004) discard;
  outColor = vec4(uColor, a);
}
`;
}

function complexFrag(field: string, params?: string[]): string {
  return `#version 300 es
precision highp float;
uniform vec2 uCenter;
uniform float uUpp;
uniform vec2 uRes;
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
  vec2 p = uCenter + (gl_FragCoord.xy - 0.5 * uRes) * uUpp;
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
uniform float uUpp;
uniform vec2 uRes;
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
  vec2 p = uCenter + (gl_FragCoord.xy - 0.5 * uRes) * uUpp;
  vec2 v0 = V(p.x, p.y);
  if (any(isnan(v0)) || any(isinf(v0))) discard;

  float w0 = weight(0.0);
  float sum = w0 * vfNoise(gl_FragCoord.xy);
  float wsum = w0;
  float travel = 0.0;
  float h = STEP * uUpp;

  // Line integral convolution: midpoint-rule streamline integration forward
  // and backward from p, accumulating noise along the path.
  for (int side = 0; side < 2; side++) {
    float sgn = side == 0 ? 1.0 : -1.0;
    vec2 q = p;
    for (int i = 1; i <= N; i++) {
      vec2 v = V(q.x, q.y);
      float m = length(v);
      if (isnan(m) || isinf(m) || m < 1e-24) break;
      vec2 d = (sgn / m) * v;
      vec2 qm = q + 0.5 * h * d;
      vec2 vm = V(qm.x, qm.y);
      float mm = length(vm);
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

function domainFrag(field: string, params?: string[]): string {
  return `#version 300 es
precision highp float;
uniform vec2 uCenter;
uniform float uUpp;
uniform vec2 uRes;
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
  vec2 p = uCenter + (gl_FragCoord.xy - 0.5 * uRes) * uUpp;
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
uniform float uUpp;
uniform vec2 uRes;
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
  vec2 p = uCenter + (gl_FragCoord.xy - 0.5 * uRes) * uUpp;
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

function fractalFrag(step: string, seed: 'pixel' | 'zero', maxIter: number, params?: string[]): string {
  return `#version 300 es
precision highp float;
uniform vec2 uCenter;
uniform float uUpp;
uniform vec2 uRes;
uniform vec3 uColor;
uniform float t;
${paramDecls(params)}
out vec4 outColor;
${GLSL_PRELUDE}
vec2 stepFn(vec2 zc, float x, float y) { return ${step}; }
void main() {
  vec2 p = uCenter + (gl_FragCoord.xy - 0.5 * uRes) * uUpp;
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
uniform float uUpp;
uniform vec2 uRes;
uniform vec3 uColor;
uniform float t;
uniform float uSeed;
${paramDecls(params)}
out vec4 outColor;
${GLSL_PRELUDE}
float f(float a, float x) { return ${field}; }
void main() {
  vec2 p = uCenter + (gl_FragCoord.xy - 0.5 * uRes) * uUpp;
  float a = uSeed;
  for (int k = 0; k < 150; k++) {
    a = f(a, p.x);
    if (isnan(a) || isinf(a) || abs(a) > 1e12) discard;
  }
  float acc = 0.0;
  for (int k = 0; k < 200; k++) {
    a = f(a, p.x);
    if (isnan(a) || isinf(a) || abs(a) > 1e12) break;
    float d = abs(a - p.y) / uUpp;
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
  const edgeBlocks = edges.map((_, i) => `
  {
    float ev = E${i}(p.x, p.y);
    if (!isnan(ev) && !isinf(ev) && v < 2.5 * aa) {
      vec2 g1 = vec2(E${i}(p.x + h, p.y) - E${i}(p.x - h, p.y),
                     E${i}(p.x, p.y + h) - E${i}(p.x, p.y - h)) / (2.0 * h);
      vec2 g2 = vec2(E${i}(p.x + 0.5 * h, p.y) - E${i}(p.x - 0.5 * h, p.y),
                     E${i}(p.x, p.y + 0.5 * h) - E${i}(p.x, p.y - 0.5 * h)) / h;
      float e1 = abs(ev) / max(length(g1) * h, 1e-24);
      float e2 = abs(ev) / max(length(g2) * h, 1e-24);
      if (!(isnan(e1) || isinf(e1) || isnan(e2) || isinf(e2))
        && !(e2 > 1.6 * e1 || e1 > 1.6 * e2)) {
        edge = max(edge, 1.0 - smoothstep(1.1, 2.1, max(e1, e2)));
      }
    }
  }`).join('');
  return `#version 300 es
precision highp float;
uniform vec2 uCenter;
uniform float uUpp;
uniform vec2 uRes;
uniform vec3 uColor;
uniform float t;
${paramDecls(params)}
out vec4 outColor;
${GLSL_PRELUDE}
float F(float x, float y) { return ${field}; }
${edges.map((e, i) => `float E${i}(float x, float y) { return ${e}; }`).join('\n')}
void main() {
  vec2 p = uCenter + (gl_FragCoord.xy - 0.5 * uRes) * uUpp;
  float v = F(p.x, p.y);
  if (isnan(v) || isinf(v)) discard;
  float aa = max(fwidth(v), 1e-24);
  float fill = (1.0 - smoothstep(-aa, aa, v)) * 0.22;
  float edge = 0.0;
  float h = uUpp;
${edgeBlocks}
  float alpha = max(fill, edge * 0.9);
  if (alpha < 0.004) discard;
  outColor = vec4(uColor, alpha);
}
`;
}

export class Renderer2D {
  private cache: ProgramCache;
  constructor(private gl: WebGL2RenderingContext, private quad: { draw(): void }) {
    this.cache = new ProgramCache(gl);
  }

  render(
    view: View2D,
    layers: Layers2D,
    time = 0,
    env: Record<string, number> = {},
    gridSpecs?: GridSpec[],
  ): void {
    const { gl } = this;
    const w = gl.drawingBufferWidth;
    const h = gl.drawingBufferHeight;
    gl.viewport(0, 0, w, h);
    gl.disable(gl.DEPTH_TEST);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

    let specs = gridSpecs;
    if (!specs?.length) {
      const spacing = niceSpacing(view.upp, 90);
      specs = [
        { glsl: 'x', gradGlsl: ['1.0', '0.0'], params: [], major: spacing.major, minor: spacing.minor },
        { glsl: 'y', gradGlsl: ['0.0', '1.0'], params: [], major: spacing.major, minor: spacing.minor },
      ];
    }
    try {
      const grid = this.cache.get(QUAD_VERT, gridFrag(specs));
      gl.useProgram(grid);
      gl.uniform2f(gl.getUniformLocation(grid, 'uCenter'), view.cx, view.cy);
      gl.uniform1f(gl.getUniformLocation(grid, 'uUpp'), view.upp);
      gl.uniform2f(gl.getUniformLocation(grid, 'uRes'), w, h);
      const tLoc = gl.getUniformLocation(grid, 't');
      if (tLoc) gl.uniform1f(tLoc, time);
      specs.forEach((s, k) => {
        gl.uniform1f(gl.getUniformLocation(grid, `uMajor${k}`), s.major);
        gl.uniform1f(gl.getUniformLocation(grid, `uMinor${k}`), s.minor);
        for (const p of s.params) {
          const loc = gl.getUniformLocation(grid, 'u_' + p);
          if (loc) gl.uniform1f(loc, env[p] ?? 0);
        }
      });
      this.quad.draw();
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
      gl.uniform1f(gl.getUniformLocation(prog, 'uUpp'), view.upp);
      gl.uniform2f(gl.getUniformLocation(prog, 'uRes'), w, h);
      gl.uniform3f(gl.getUniformLocation(prog, 'uColor'), ...color);
      const tLoc = gl.getUniformLocation(prog, 't');
      if (tLoc) gl.uniform1f(tLoc, time);
      for (const p of params ?? []) {
        const loc = gl.getUniformLocation(prog, 'u_' + p);
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
    for (const f of layers.fractals ?? []) {
      drawProgram(fractalFrag(f.step, f.seed, f.maxIter, f.params), f.color, f.params);
    }
    for (const d of layers.domains ?? []) drawField(d, domainFrag);
    for (const c of layers.conformals ?? []) drawField(c, conformalFrag);
    for (const f of layers.vfields ?? []) drawProgram(vfieldFrag(f.fx, f.fy, f.params), f.color, f.params);
    for (const q of layers.ineqs ?? []) drawField(q, (f, ps) => ineqFrag(f, q.edges, ps));
    for (const b of layers.bifs ?? []) drawField(b, bifFrag);
    for (const s of layers.scalars ?? []) drawField(s, scalarFrag);
    for (const c of layers.complexes ?? []) drawField(c, complexFrag);
    for (const c of layers.curves ?? []) drawField(c, curveFrag);
  }
}

export interface Overlay2D {
  /** hot: pointer is over it (or dragging it) — drawn with a grab halo.
   *  label: text drawn beside the point (a named point's name).
   *  r: dot radius in CSS px (sequence/list dots draw slightly smaller).
   *  bare: no outline — in a dense scatter the outlines of later dots paint
   *  over the fill of earlier ones, turning the whole trace the outline
   *  colour. */
  points: Array<{ x: number; y: number; color: string; hot?: boolean; label?: string; r?: number; bare?: boolean }>;
  /** closed joins the last vertex back to the first; fill (a CSS color,
   *  usually translucent) paints the enclosed region when every vertex is
   *  finite. */
  polylines: Array<{ pts: number[]; color: string; closed?: boolean; fill?: string; width?: number }>;
  /** Vertical bars from y = 0, halfWidth in math units (data-list bar mode). */
  bars?: Array<{ x: number; y: number; halfWidth: number; color: string }>;
}

/** Axis labels plus CPU-sampled geometry (points, parametric curves).
 *  numbers=false skips the axis numerals (custom coordinate grids have no
 *  straight axes to label them along). */
export function drawLabels2D(ctx: CanvasRenderingContext2D, view: View2D, dpr: number, extras?: Overlay2D, numbers = true): void {
  const w = ctx.canvas.width / dpr;
  const h = ctx.canvas.height / dpr;
  ctx.save();
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, w, h);
  ctx.font = '11px ui-sans-serif, system-ui';
  ctx.fillStyle = theme.label;

  const upp = view.upp * dpr; // math units per CSS pixel
  const { major } = niceSpacing(view.upp, 90);
  const toScreenX = (x: number) => (x - view.cx) / upp + w / 2;
  const toScreenY = (y: number) => h / 2 - (y - view.cy) / upp;

  const fmt = (v: number) => {
    if (v === 0) return '0';
    const a = Math.abs(v);
    if (a >= 1e5 || a < 1e-4) return v.toExponential(0).replace('e+', 'e');
    return String(parseFloat(v.toPrecision(10)));
  };

  if (numbers) {
    const axisY = Math.min(Math.max(toScreenY(0), 12), h - 6);
    const axisX = Math.min(Math.max(toScreenX(0), 4), w - 30);

    const x0 = Math.ceil((view.cx - (w / 2) * upp) / major) * major;
    const x1 = view.cx + (w / 2) * upp;
    for (let x = x0; x <= x1; x += major) {
      if (Math.abs(x) < major / 2) continue;
      ctx.fillText(fmt(x), toScreenX(x) + 2, axisY + 13 <= h ? axisY + 13 : axisY - 4);
    }
    const y0 = Math.ceil((view.cy - (h / 2) * upp) / major) * major;
    const y1 = view.cy + (h / 2) * upp;
    for (let y = y0; y <= y1; y += major) {
      if (Math.abs(y) < major / 2) continue;
      ctx.fillText(fmt(y), axisX + 4, toScreenY(y) - 3);
    }
  }

  if (extras) {
    for (const bar of extras.bars ?? []) {
      const sx = toScreenX(bar.x);
      const sy0 = toScreenY(0);
      const sy = toScreenY(bar.y);
      if (!isFinite(sx) || !isFinite(sy)) continue;
      const hw = bar.halfWidth / upp;
      ctx.globalAlpha = 0.3;
      ctx.fillStyle = bar.color;
      ctx.fillRect(sx - hw, Math.min(sy0, sy), hw * 2, Math.abs(sy - sy0));
      ctx.globalAlpha = 1;
      ctx.strokeStyle = bar.color;
      ctx.lineWidth = 1.5;
      ctx.strokeRect(sx - hw, Math.min(sy0, sy), hw * 2, Math.abs(sy - sy0));
    }
    for (const line of extras.polylines) {
      ctx.strokeStyle = line.color;
      ctx.lineWidth = line.width ?? 2.25;
      ctx.lineJoin = 'round';
      ctx.beginPath();
      let pen = false;
      let broken = false;
      for (let i = 0; i + 1 < line.pts.length; i += 2) {
        const sx = toScreenX(line.pts[i]);
        const sy = toScreenY(line.pts[i + 1]);
        if (!isFinite(sx) || !isFinite(sy)) { pen = false; broken = true; continue; }
        if (pen) ctx.lineTo(sx, sy);
        else { ctx.moveTo(sx, sy); pen = true; }
      }
      if (line.closed && pen && !broken) ctx.closePath();
      if (line.fill && !broken) {
        ctx.fillStyle = line.fill;
        ctx.fill();
      }
      ctx.stroke();
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
  ctx.restore();
}
