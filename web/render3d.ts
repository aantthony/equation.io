/**
 * 3D rendering: every equation is the zero set of F(x,y,z), rendered by
 * raymarching a bounding box in a fragment shader — sign-change detection
 * along the ray, bisection refinement, finite-difference normals, and
 * gl_FragDepth from the hit point so multiple surfaces intersect correctly.
 *
 * 2D-only equations (no z) still work here: F(x,y) extrudes to a vertical
 * sheet, which is exactly its locus in R^3.
 */
import { arrowConeInstances, buildUnitCone } from '../lib/cone.ts';
import { finiteRuns } from '../lib/curve3d.ts';
import { GLSL_PRELUDE, uniformName } from '../lib/glsl.ts';
import { ProgramCache, QUAD_VERT, compileProgram } from './gl.ts';
import { type Mat4, invert, lookAt, multiply, perspective } from './mat4.ts';
import { drawTextLabel, niceSpacing, paramDecls } from './render2d.ts';
import { glslVec3, theme } from './theme.ts';
import { RetainedGeometry } from './retained-geometry.ts';

export interface Camera3D {
  target: [number, number, number];
  radius: number;
  /** Azimuth around +Z. */
  theta: number;
  /** Elevation from the XY plane. */
  phi: number;
}

export interface Surface3D {
  uniforms?: Record<string, number>;
  /** GLSL expression for F(x,y,z) in terms of floats x, y, z. */
  field: string;
  color: [number, number, number];
  /** User-defined constants the field references (as u_<name> uniforms). */
  params?: string[];
}

/** Half-width of the axis-aligned box every 3D plot is clipped to. */
export const cameraBoxR = (cam: Camera3D): number => cam.radius * 0.85;

export function cameraEye(cam: Camera3D): [number, number, number] {
  const cp = Math.cos(cam.phi);
  return [
    cam.target[0] + cam.radius * cp * Math.cos(cam.theta),
    cam.target[1] + cam.radius * cp * Math.sin(cam.theta),
    cam.target[2] + cam.radius * Math.sin(cam.phi),
  ];
}

export function cameraMatrices(
  cam: Camera3D,
  aspect: number,
): { vp: Mat4; invVp: Mat4; eye: [number, number, number] } {
  const eye = cameraEye(cam);
  const view = lookAt(eye, cam.target, [0, 0, 1]);
  const proj = perspective(Math.PI / 4, aspect, cam.radius * 0.01, cam.radius * 100);
  const vp = multiply(proj, view);
  return { vp, invVp: invert(vp), eye };
}

/** Where a world point lands in a w×h viewport under `vp`, or null behind the camera. */
export function projectToScreen(vp: Mat4, p: readonly number[], w: number, h: number): [number, number] | null {
  const cx = vp[0] * p[0] + vp[4] * p[1] + vp[8] * p[2] + vp[12];
  const cy = vp[1] * p[0] + vp[5] * p[1] + vp[9] * p[2] + vp[13];
  const cw = vp[3] * p[0] + vp[7] * p[1] + vp[11] * p[2] + vp[15];
  if (cw <= 0) return null;
  return [((cx / cw) * 0.5 + 0.5) * w, (0.5 - (cy / cw) * 0.5) * h];
}

const MARCH_COMMON = `
uniform mat4 uInvVP;
uniform mat4 uVP;
uniform vec2 uRes;
uniform float uBoxR;
uniform float t;

vec3 unproject(vec3 ndc) {
  vec4 p = uInvVP * vec4(ndc, 1.0);
  return p.xyz / p.w;
}

// Ray/AABB intersection for the box [-uBoxR, uBoxR]^3.
vec2 boxSpan(vec3 ro, vec3 rd) {
  vec3 inv = 1.0 / rd;
  vec3 t1 = (vec3(-uBoxR) - ro) * inv;
  vec3 t2 = (vec3(uBoxR) - ro) * inv;
  vec3 tmin = min(t1, t2);
  vec3 tmax = max(t1, t2);
  return vec2(max(max(tmin.x, tmin.y), tmin.z), min(min(tmax.x, tmax.y), tmax.z));
}

float depthOf(vec3 p) {
  vec4 clip = uVP * vec4(p, 1.0);
  return clamp(clip.z / clip.w * 0.5 + 0.5, 0.0, 1.0);
}
`;

const STEPS = 220;
const BISECT = 24;
/** March samples spent bisecting onto an edge of a field's domain (where it
 *  turns NaN). */
const EDGE_BISECT = 6;
/** Domain edges refined per ray: into the domain and out of it again. */
const EDGE_BUDGET = 2;
/** Coarsest step, as a fraction of the ray's span through the box. */
const MIN_SAMPLES = 48;
/** Finest step: STEPS × FINEST of them cover the span, so a ray that grinds
 *  the whole way still reaches 1/FINEST of it. */
const FINEST = 4;
/** Fraction of the estimated distance-to-zero actually stepped. */
const SAFETY = 0.6;
/** Sign changes per ray that may be refused as jumps (see JUMP_RATIO); past
 *  the budget a field that jumps on most steps (floor(20 x) - z) is marched
 *  without further refusals, as it always was. */
const JUMP_BUDGET = 4;
/** A sign change is a root only if its bracket closes: bisecting a continuous
 *  crossing shrinks |F(b) - F(a)| with the bracket, while across a jump — the
 *  ±π cut of atan2 in theta = pi/4, a floor step, a pole — it stays the size
 *  it started. Refused when the bisected gap is still this fraction of it. */
const JUMP_RATIO = 0.25;

function surfaceFrag(field: string, grad?: [string, string, string], params?: string[]): string {
  const gradFn = grad
    ? `
vec3 gradF(vec3 p, float h) {
  float x = p.x, y = p.y, z = p.z;
  return vec3(${grad[0]}, ${grad[1]}, ${grad[2]});
}`
    : `
vec3 gradF(vec3 p, float h) {
  return vec3(
    F(p + vec3(h, 0, 0)) - F(p - vec3(h, 0, 0)),
    F(p + vec3(0, h, 0)) - F(p - vec3(0, h, 0)),
    F(p + vec3(0, 0, h)) - F(p - vec3(0, 0, h)));
}`;
  return `#version 300 es
precision highp float;
uniform vec3 uColor;
uniform vec3 uEye;
${paramDecls(params)}
out vec4 outColor;
${GLSL_PRELUDE}
${MARCH_COMMON}

float F(vec3 p) {
  float x = p.x, y = p.y, z = p.z;
  return ${field};
}
${gradFn}

void main() {
  vec2 ndc = (gl_FragCoord.xy / uRes) * 2.0 - 1.0;
  vec3 ro = unproject(vec3(ndc, -1.0));
  vec3 far = unproject(vec3(ndc, 1.0));
  vec3 rd = normalize(far - ro);

  vec2 span = boxSpan(ro, rd);
  float t0 = max(span.x, 0.0);
  float t1 = span.y;
  if (t1 <= t0) discard;

  // Adaptive march. Uniform steps miss any zero set thinner than the step —
  // a high-degree surface seen edge-on, or a tube like Q^2 + R^2 = e^2, which
  // a uniform march renders as stipple. The secant through the last two
  // samples estimates the distance to the next zero ALONG THE RAY (|F| over
  // the directional derivative), which costs nothing: both samples are
  // already in hand. Steps stretch across empty space and collapse as the
  // field approaches zero. Overshoot is still caught by the sign change.
  float rayLen = t1 - t0;
  float dtMax = rayLen / float(${MIN_SAMPLES});
  float dtMin = rayLen / float(${STEPS * FINEST});
  float dt = rayLen / float(${STEPS});
  float tPrev = t0;
  float vPrev = F(ro + rd * t0);
  bool hit = false;
  float tHit = 0.0;
  // Domain edges. A no-default piecewise like {0 < x < 2: sqrt(x)} is NaN
  // outside its conditions, and a step that straddles that edge cannot be
  // tested for a crossing — so the surface within a step of the edge would be
  // lost ray by ray, and a restricted surface end in a ragged rim. Instead the
  // next EDGE_BISECT samples bisect onto the edge: leaving the domain, each
  // defined midpoint is an ordinary (short) step forward; entering it, the
  // march resumes from the first defined point. They are samples of this same
  // loop, so the common ray pays nothing, and they are budgeted per ray: a
  // field whose domain is shredded (sqrt(sin(20 x y))) flips on most steps,
  // and past the budget a straddling step is skipped as it always was.
  int edges = 0, refine = 0, jumps = 0;
  bool entering = false;
  float tEdge = 0.0, tIn = 0.0, vIn = 0.0;

  for (int i = 0; i < ${STEPS}; i++) {
    bool refining = refine > 0;
    float t = refining ? 0.5 * (tEdge + (entering ? tIn : tPrev)) : min(tPrev + dt, t1);
    float v = F(ro + rd * t);
    bool undef = isnan(v);
    if (refining) {
      refine--;
      if (undef) tEdge = t;
      else if (entering) { tIn = t; vIn = v; }
      if (entering || undef) {
        if (refine == 0) {
          if (entering) { tPrev = tIn; vPrev = vIn; dt = dtMin; } else { tPrev = tEdge; vPrev = v; dt = dtMax; }
        }
        continue;
      }
    } else if (undef != isnan(vPrev) && edges < ${EDGE_BUDGET}) {
      edges++;
      refine = ${EDGE_BISECT};
      entering = !undef;
      if (entering) { tEdge = tPrev; tIn = t; vIn = v; } else { tEdge = t; }
      continue;
    }
    bool finite = !isnan(v) && !isinf(v) && !isnan(vPrev) && !isinf(vPrev);
    if (finite && sign(v) != sign(vPrev)) {
      // Bisect to the crossing.
      float a = tPrev, b = t, va = vPrev, vb = v;
      for (int j = 0; j < ${BISECT}; j++) {
        float m = 0.5 * (a + b);
        float vm = F(ro + rd * m);
        if (sign(vm) == sign(va)) { a = m; va = vm; } else { b = m; vb = vm; }
      }
      // A bracket that did not close is a jump, not a root: step over it and
      // keep marching, since the real surface may lie beyond.
      bool jump = !(abs(vb - va) < ${JUMP_RATIO} * abs(v - vPrev));
      if (!jump || jumps >= ${JUMP_BUDGET}) {
        tHit = 0.5 * (a + b);
        hit = true;
        break;
      }
      jumps++;
      tPrev = b;
      vPrev = vb;
      dt = dtMin;
      if (b >= t1) break;
      continue;
    }
    // |dF/dt| from the secant; a flat or non-finite stretch steps at dtMax.
    float slope = finite ? abs(v - vPrev) / max(t - tPrev, 1e-20) : 0.0;
    dt = clamp(slope > 0.0 ? ${SAFETY} * abs(v) / slope : dtMax, dtMin, dtMax);
    tPrev = t;
    vPrev = v;
    if (refining && refine == 0) { tPrev = tEdge; vPrev = EQ_NAN; dt = dtMax; }
    if (t >= t1) break;
  }
  if (!hit) discard;

  vec3 p = ro + rd * tHit;
  float h = max(rayLen * 2e-3, uBoxR * 1e-4);
  vec3 n = normalize(gradF(p, h));
  if (any(isnan(n))) n = -rd;
  if (dot(n, rd) > 0.0) n = -n; // face the viewer

  vec3 lightDir = normalize(vec3(0.4, 0.55, 0.9));
  float diffuse = max(dot(n, lightDir), 0.0);
  float sky = 0.5 + 0.5 * n.z;
  vec3 halfway = normalize(lightDir - rd);
  float spec = pow(max(dot(n, halfway), 0.0), 48.0);

  // Subtle checker so the surface reads as a grid.
  float cs = uBoxR / 4.0;
  float checker = mod(floor(p.x / cs) + floor(p.y / cs) + floor(p.z / cs), 2.0);
  vec3 base = uColor * (0.92 + 0.08 * checker);

  vec3 col = base * (0.30 + 0.25 * sky + 0.50 * diffuse) + vec3(0.35) * spec;
  // Distance fade toward the box edge keeps clipped surfaces from popping.
  float edge = smoothstep(uBoxR, uBoxR * 0.96, max(max(abs(p.x), abs(p.y)), abs(p.z)));
  outColor = vec4(col, 0.6 + 0.4 * edge);
  gl_FragDepth = depthOf(p);
}
`;
}

/**
 * Parametric surface P(u,v), u,v in (0,1), the old surface3 way: a static
 * (u,v) grid mesh is displaced by P in the VERTEX shader (rasterization gives
 * depth for free), and the fragment shader lights with the symbolically
 * differentiated tangents ∂P/∂u × ∂P/∂v — finite differences only when a
 * component has no smooth derivative.
 */
function psurfVert(comps: [string, string, string], params?: string[]): string {
  return `#version 300 es
layout(location=0) in vec2 aUV;
uniform mat4 uVP;
uniform float t;
${paramDecls(params)}
out vec2 vUV;
out vec3 vPos;
${GLSL_PRELUDE}
vec3 P(float u, float v) {
  return vec3(${comps[0]}, ${comps[1]}, ${comps[2]});
}
void main() {
  vUV = aUV;
  vPos = P(aUV.x, aUV.y);
  gl_Position = uVP * vec4(vPos, 1.0);
}
`;
}

function psurfFrag(
  comps: [string, string, string],
  du?: [string, string, string],
  dv?: [string, string, string],
  params?: string[],
): string {
  const tangents =
    du && dv
      ? `
vec3 Pu(float u, float v) { return vec3(${du[0]}, ${du[1]}, ${du[2]}); }
vec3 Pv(float u, float v) { return vec3(${dv[0]}, ${dv[1]}, ${dv[2]}); }`
      : `
vec3 P(float u, float v) { return vec3(${comps[0]}, ${comps[1]}, ${comps[2]}); }
vec3 Pu(float u, float v) { return (P(u + 1e-3, v) - P(u - 1e-3, v)) * 500.0; }
vec3 Pv(float u, float v) { return (P(u, v + 1e-3) - P(u, v - 1e-3)) * 500.0; }`;
  return `#version 300 es
precision highp float;
uniform vec3 uColor;
uniform vec3 uEye;
uniform float t;
${paramDecls(params)}
in vec2 vUV;
in vec3 vPos;
out vec4 outColor;
${GLSL_PRELUDE}
${tangents}

void main() {
  vec3 n = normalize(cross(Pu(vUV.x, vUV.y), Pv(vUV.x, vUV.y)));
  vec3 rd = normalize(vPos - uEye);
  if (any(isnan(n))) n = -rd;
  if (dot(n, rd) > 0.0) n = -n;

  vec3 lightDir = normalize(vec3(0.4, 0.55, 0.9));
  float diffuse = max(dot(n, lightDir), 0.0);
  float sky = 0.5 + 0.5 * n.z;
  vec3 halfway = normalize(lightDir - rd);
  float spec = pow(max(dot(n, halfway), 0.0), 96.0);
  float fresnel = pow(1.0 - max(dot(n, -rd), 0.0), 3.0);

  // Faint parameter checker so the (u,v) mapping reads.
  float checker = mod(floor(vUV.x * 8.0) + floor(vUV.y * 8.0), 2.0);
  vec3 base = uColor * (0.92 + 0.08 * checker);

  vec3 col = base * (0.22 + 0.22 * sky + 0.42 * diffuse)
           + vec3(1.0) * spec * 0.85
           + vec3(0.35, 0.4, 0.5) * fresnel * 0.35;
  outColor = vec4(col, 1.0);
}
`;
}

/** CPU-built tube meshes (curve framing): position+normal lighting with a
 * material checker in (arclength × ring angle) coordinates, the same faint
 * grid parametric surfaces get — but painted on the tube's own material. */
const TUBE_VERT = `#version 300 es
layout(location=0) in vec3 aPos;
layout(location=1) in vec3 aNormal;
layout(location=2) in vec2 aUV;
uniform mat4 uVP;
out vec3 vPos;
out vec3 vNormal;
out vec2 vUV;
void main() {
  vPos = aPos;
  vNormal = aNormal;
  vUV = aUV;
  gl_Position = uVP * vec4(aPos, 1.0);
}
`;

const TUBE_FRAG = `#version 300 es
precision highp float;
uniform vec3 uColor;
uniform vec3 uEye;
uniform vec2 uCells;
in vec3 vPos;
in vec3 vNormal;
in vec2 vUV;
out vec4 outColor;
void main() {
  vec3 n = normalize(vNormal);
  vec3 rd = normalize(vPos - uEye);
  if (any(isnan(n))) n = -rd;
  if (dot(n, rd) > 0.0) n = -n;

  vec3 lightDir = normalize(vec3(0.4, 0.55, 0.9));
  float diffuse = max(dot(n, lightDir), 0.0);
  float sky = 0.5 + 0.5 * n.z;
  vec3 halfway = normalize(lightDir - rd);
  float spec = pow(max(dot(n, halfway), 0.0), 96.0);
  float fresnel = pow(1.0 - max(dot(n, -rd), 0.0), 3.0);

  // Material checker: cells are square-ish in world units and follow the
  // rotation-minimizing frame, so the pattern reads as painted on the tube.
  float checker = mod(floor(min(vUV.x, 0.9999) * uCells.x) + floor(min(vUV.y, 0.9999) * uCells.y), 2.0);
  // Fade to the average shade once cells shrink toward pixel size, so distant
  // or thin tubes don't moiré.
  vec2 cw = fwidth(vUV * uCells);
  checker = mix(checker, 0.5, clamp(max(cw.x, cw.y) * 1.5 - 0.25, 0.0, 1.0));
  // Slightly stronger than the psurface checker: tube cells are far smaller.
  vec3 base = uColor * (0.88 + 0.12 * checker);

  vec3 col = base * (0.26 + 0.22 * sky + 0.46 * diffuse)
           + vec3(1.0) * spec * 0.7
           + vec3(0.35, 0.4, 0.5) * fresnel * 0.3;
  outColor = vec4(col, 1.0);
}
`;

/** Instanced unit cone: local +z along the shaft, tip at the origin.
 *  Lighting uses the analytic radial normal (from interpolated local xy),
 *  so a coarse tessellation still shades as a smooth cone. aNormal.z < 0
 *  marks the base cap, whose normal is just −local z. */
const CONE_VERT = `#version 300 es
layout(location=0) in vec3 aPos;
layout(location=1) in vec3 aNormal;
layout(location=2) in vec3 aTip;
layout(location=3) in vec3 aDir;
layout(location=4) in vec2 aScale;
uniform mat4 uVP;
out vec3 vPos;
out vec3 vLocal;
out vec3 vX;
out vec3 vY;
out vec3 vZ;
out vec2 vScale;
out float vCap;
void main() {
  vec3 z = aDir;
  vec3 h = abs(z.z) < 0.9 ? vec3(0.0, 0.0, 1.0) : vec3(1.0, 0.0, 0.0);
  vec3 x = normalize(cross(h, z));
  vec3 y = cross(z, x);
  vec3 p = aTip + x * aPos.x * aScale.x + y * aPos.y * aScale.x + z * aPos.z * aScale.y;
  vPos = p;
  vLocal = aPos;
  vX = x; vY = y; vZ = z;
  vScale = aScale;
  vCap = aNormal.z < 0.0 ? 1.0 : 0.0;
  gl_Position = uVP * vec4(p, 1.0);
}
`;

const CONE_FRAG = `#version 300 es
precision highp float;
uniform vec3 uColor;
uniform vec3 uEye;
in vec3 vPos;
in vec3 vLocal;
in vec3 vX;
in vec3 vY;
in vec3 vZ;
in vec2 vScale;
in float vCap;
out vec4 outColor;
void main() {
  vec3 localN;
  if (vCap > 0.5) {
    localN = vec3(0.0, 0.0, -1.0);
  } else {
    float rl = length(vLocal.xy);
    localN = rl > 1e-8 ? normalize(vec3(vLocal.xy / rl, 1.0)) : vec3(0.0, 0.0, 1.0);
  }
  vec3 n = normalize(vX * localN.x / vScale.x + vY * localN.y / vScale.x + vZ * localN.z / vScale.y);
  vec3 rd = normalize(vPos - uEye);
  if (any(isnan(n))) n = -rd;
  if (dot(n, rd) > 0.0) n = -n;
  vec3 lightDir = normalize(vec3(0.4, 0.55, 0.9));
  float diffuse = max(dot(n, lightDir), 0.0);
  float sky = 0.5 + 0.5 * n.z;
  vec3 halfway = normalize(lightDir - rd);
  float spec = pow(max(dot(n, halfway), 0.0), 96.0);
  float fresnel = pow(1.0 - max(dot(n, -rd), 0.0), 3.0);
  vec3 col = uColor * (0.26 + 0.22 * sky + 0.46 * diffuse)
           + vec3(1.0) * spec * 0.7
           + vec3(0.35, 0.4, 0.5) * fresnel * 0.3;
  outColor = vec4(col, 1.0);
}
`;

const LINE_VERT = `#version 300 es
layout(location=0) in vec3 aPos;
uniform mat4 uVP;
uniform float uCount;
out float vProgress;
void main() { gl_Position = uVP * vec4(aPos, 1.0); vProgress = float(gl_VertexID) / max(1.0, uCount - 1.0); }
`;

const LINE_FRAG = `#version 300 es
precision highp float;
uniform vec3 uColor;
out vec4 outColor;
uniform float uAlpha;
uniform float uFade;
in float vProgress;
void main() { outColor = vec4(uColor, uAlpha * mix(1.0, 0.15 + 0.85 * vProgress, uFade)); }
`;

const POINT_VERT = `#version 300 es
layout(location=0) in vec3 aPos;
uniform mat4 uVP;
void main() {
  gl_Position = uVP * vec4(aPos, 1.0);
  gl_PointSize = 14.0;
}
`;

const POINT_FRAG = `#version 300 es
precision highp float;
uniform vec3 uColor;
out vec4 outColor;
void main() {
  vec2 q = gl_PointCoord - 0.5;
  float r = length(q);
  if (r > 0.5) discard;
  float rim = smoothstep(0.5, 0.38, r);
  vec3 col = mix(vec3(1.0), uColor, rim);
  outColor = vec4(col, 1.0);
}
`;

/** The z=0 reference plane with the same adaptive grid as the 2D view. */
const planeFrag = (): string => `#version 300 es
precision highp float;
uniform float uMajor;
uniform float uMinor;
out vec4 outColor;
${MARCH_COMMON}

float lineAlpha(float coord, float spacing, float halfWidth) {
  float d = abs(coord - spacing * round(coord / spacing));
  return 1.0 - smoothstep(halfWidth, halfWidth * 2.0, d);
}

void main() {
  vec2 ndc = (gl_FragCoord.xy / uRes) * 2.0 - 1.0;
  vec3 ro = unproject(vec3(ndc, -1.0));
  vec3 far = unproject(vec3(ndc, 1.0));
  vec3 rd = normalize(far - ro);
  if (abs(rd.z) < 1e-9) discard;
  float t = -ro.z / rd.z;
  if (t <= 0.0) discard;
  vec3 p = ro + rd * t;
  if (max(abs(p.x), abs(p.y)) > uBoxR) discard;

  // Line width proportional to distance so it stays roughly screen-constant.
  float w = t * 0.0015;
  float minor = max(lineAlpha(p.x, uMinor, w), lineAlpha(p.y, uMinor, w));
  float major = max(lineAlpha(p.x, uMajor, w * 1.4), lineAlpha(p.y, uMajor, w * 1.4));
  float axis = max(lineAlpha(p.x, 1e30, w * 2.2), lineAlpha(p.y, 1e30, w * 2.2));
  float a = max(max(minor * 0.18, major * 0.34), axis * 0.6);
  float fade = 1.0 - smoothstep(uBoxR * 0.6, uBoxR, length(p.xy));
  if (a * fade < 0.01) discard;
  outColor = vec4(${glslVec3(theme.plane)}, a * fade);
  gl_FragDepth = depthOf(p);
}
`;

const AXES_VERT = `#version 300 es
layout(location=0) in vec3 aPos;
layout(location=1) in vec3 aColor;
uniform mat4 uVP;
uniform float uBoxR;
out vec3 vColor;
void main() {
  vColor = aColor;
  gl_Position = uVP * vec4(aPos * uBoxR, 1.0);
}
`;

const AXES_FRAG = `#version 300 es
precision highp float;
in vec3 vColor;
out vec4 outColor;
void main() { outColor = vec4(vColor, 0.9); }
`;

/** Lattice cells per axis: an N×N×N jittered lattice fills the camera box. */
const STREAMLINE_CELLS_N = 13;
/** Streamlines seeded in each lattice cell. */
const STREAMLINES_PER_CELL = 8;
/** Integration steps each way from a streamline's seed. */
const STREAMLINE_STEPS = 24;
/** Integration step as a fraction of the box half-width: a streamline spans
 *  about one half-width, long enough to read as flow. */
const STREAMLINE_STEP = 0.02;

/**
 * A 3D vector field as dense short streamlines, the space counterpart of the
 * 2D line-integral convolution (render2d vfieldFrag): each seed integrates
 * the unit field forward and back in the vertex shader, and alpha carries
 * the same Hann window times a travelling wave, so dashes drift downstream.
 * One instanced LINE_STRIP per seed; vertex i is i − N steps from the seed.
 */
function streamlineVert(comps: [string, string, string], params?: string[]): string {
  return `#version 300 es
layout(location=0) in vec4 aSeed;
uniform mat4 uVP;
uniform float uBoxR;
uniform vec3 uTarget;
uniform vec3 uEye;
uniform float t;
${paramDecls(params)}
out float vAlpha;
${GLSL_PRELUDE}
vec3 V(float x, float y, float z) { return vec3(${comps[0]}, ${comps[1]}, ${comps[2]}); }
vec3 dir(vec3 q) {
  vec3 v = V(q.x, q.y, q.z);
  float m = length(v);
  return (isnan(m) || isinf(m) || m < 1e-24) ? vec3(0.0) : v / m;
}
const int N = ${STREAMLINE_STEPS};
const float LAMBDA = 10.0; // wave length in steps
const float OMEGA = 4.0;   // wave angular speed (rad/s), as in 2D
void main() {
  int i = gl_VertexID - N;
  float h = uBoxR * ${STREAMLINE_STEP} * (i < 0 ? -1.0 : 1.0);
  vec3 p = uTarget + aSeed.xyz * uBoxR;
  bool alive = true;
  for (int k = 0; k < N; k++) {
    if (k >= abs(i)) break;
    vec3 d = dir(p);
    vec3 dm = dir(p + 0.5 * h * d);
    if (dot(d, d) == 0.0 || dot(dm, dm) == 0.0) { alive = false; break; }
    p += h * dm;
  }
  float s = float(i);
  float hann = 0.5 + 0.5 * cos(3.14159265 * s / float(N + 1));
  float wave = 0.5 + 0.5 * cos(6.2831853 * s / LAMBDA - OMEGA * t + aSeed.w);
  vec3 u = abs(p - uTarget) / uBoxR;
  float inBox = 1.0 - smoothstep(0.85, 1.0, max(u.x, max(u.y, u.z)));
  // Depth cue: full strength up to halfway between the near face and the
  // centre of the box, down to an eighth at the far face, so near flow
  // reads over the far side.
  float near = length(uEye - uTarget) - 0.5 * uBoxR;
  float depth = clamp((length(p - uEye) - near) / (1.5 * uBoxR), 0.0, 1.0);
  vAlpha = alive ? hann * wave * wave * inBox * mix(1.0, 0.125, depth) : 0.0;
  gl_Position = uVP * vec4(p, 1.0);
}
`;
}

const STREAMLINE_FRAG = `#version 300 es
precision highp float;
uniform vec3 uColor;
in float vAlpha;
out vec4 outColor;
void main() {
  if (vAlpha < 0.01) discard;
  outColor = vec4(uColor, vAlpha);
}
`;

export interface Scene3D {
  implicits: Array<Surface3D & { grad?: [string, string, string] }>;
  psurfaces: Array<{
    uniforms?: Record<string, number>;
    comps: [string, string, string];
    du?: [string, string, string];
    dv?: [string, string, string];
    color: [number, number, number];
    params?: string[];
  }>;
  curves: Array<{
    pts: Float32Array;
    color: [number, number, number];
    arrow?: boolean;
    triangle?: boolean;
    fade?: boolean;
  }>;
  /** Disconnected segments (comb teeth, hull edges), drawn as vertex pairs.
   * Retained arrays are immutable and can keep their GPU buffers. */
  segments: Array<{ pts: Float32Array; color: [number, number, number]; retained?: boolean }>;
  /** Indexed position+normal meshes (curve tubes, hull solids) with material UVs. */
  tubes: Array<{
    positions: Float32Array;
    normals: Float32Array;
    /** Per-vertex (arclength fraction, ring-angle fraction). */
    uvs: Float32Array;
    indices: Uint32Array;
    /** Checker cell counts along (length, circumference). */
    cells: [number, number];
    color: [number, number, number];
    /** All four geometry arrays are immutable and can keep their GPU buffers. */
    retained?: boolean;
  }>;
  points: Array<{ pos: [number, number, number]; color: [number, number, number]; label?: string }>;
  /** `label(point, "text")` rows: text only, no point sprite. */
  texts?: Array<{ pos: [number, number, number]; text: string; color: [number, number, number] }>;
  /** 3D vector fields drawn as animated streamlines (see streamlineVert). */
  streamlines?: Array<{
    comps: [string, string, string];
    color: [number, number, number];
    params?: string[];
    uniforms?: Record<string, number>;
  }>;
}

const GRID_N = 160;

export class Renderer3D {
  private geometry: RetainedGeometry;
  private cache: ProgramCache;
  private axesProgram: WebGLProgram;
  private axesVao: WebGLVertexArrayObject;
  private lineProgram: WebGLProgram;
  private pointProgram: WebGLProgram;
  private tubeProgram: WebGLProgram;
  private dynVao: WebGLVertexArrayObject;
  private dynBuf: WebGLBuffer;
  private tubeVao: WebGLVertexArrayObject;
  private tubePosBuf: WebGLBuffer;
  private tubeNrmBuf: WebGLBuffer;
  private tubeUvBuf: WebGLBuffer;
  private tubeIdxBuf: WebGLBuffer;
  private coneProgram: WebGLProgram;
  private coneVao: WebGLVertexArrayObject;
  private coneInstBuf: WebGLBuffer;
  private coneIndexCount: number;
  private gridVao: WebGLVertexArrayObject;
  private gridIndexCount: number;
  private streamlineVao!: WebGLVertexArrayObject;
  private streamlineSeeds = 0;

  constructor(
    private gl: WebGL2RenderingContext,
    private quad: { draw(): void },
  ) {
    this.geometry = new RetainedGeometry(gl);
    this.cache = new ProgramCache(gl);
    this.axesProgram = compileProgram(gl, AXES_VERT, AXES_FRAG);
    this.lineProgram = compileProgram(gl, LINE_VERT, LINE_FRAG);
    this.pointProgram = compileProgram(gl, POINT_VERT, POINT_FRAG);
    this.dynVao = gl.createVertexArray()!;
    this.dynBuf = gl.createBuffer()!;
    gl.bindVertexArray(this.dynVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.dynBuf);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);

    // Dynamic indexed mesh (curve tubes): separate position/normal/uv buffers.
    this.tubeProgram = compileProgram(gl, TUBE_VERT, TUBE_FRAG);
    this.tubeVao = gl.createVertexArray()!;
    this.tubePosBuf = gl.createBuffer()!;
    this.tubeNrmBuf = gl.createBuffer()!;
    this.tubeUvBuf = gl.createBuffer()!;
    this.tubeIdxBuf = gl.createBuffer()!;
    gl.bindVertexArray(this.tubeVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.tubePosBuf);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.tubeNrmBuf);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.tubeUvBuf);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 2, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.tubeIdxBuf);
    gl.bindVertexArray(null);

    const cone = buildUnitCone();
    this.coneProgram = compileProgram(gl, CONE_VERT, CONE_FRAG);
    this.coneVao = gl.createVertexArray()!;
    this.coneInstBuf = gl.createBuffer()!;
    this.coneIndexCount = cone.indices.length;
    gl.bindVertexArray(this.coneVao);
    const conePos = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, conePos);
    gl.bufferData(gl.ARRAY_BUFFER, cone.positions, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
    const coneNrm = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, coneNrm);
    gl.bufferData(gl.ARRAY_BUFFER, cone.normals, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.coneInstBuf);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 3, gl.FLOAT, false, 32, 0);
    gl.vertexAttribDivisor(2, 1);
    gl.enableVertexAttribArray(3);
    gl.vertexAttribPointer(3, 3, gl.FLOAT, false, 32, 12);
    gl.vertexAttribDivisor(3, 1);
    gl.enableVertexAttribArray(4);
    gl.vertexAttribPointer(4, 2, gl.FLOAT, false, 32, 24);
    gl.vertexAttribDivisor(4, 1);
    const coneIdx = gl.createBuffer()!;
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, coneIdx);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, cone.indices, gl.STATIC_DRAW);
    gl.bindVertexArray(null);

    // Static (u,v) unit-square grid, displaced per-surface in the vertex shader.
    const uvs = new Float32Array(GRID_N * GRID_N * 2);
    for (let j = 0; j < GRID_N; j++) {
      for (let i = 0; i < GRID_N; i++) {
        uvs[(j * GRID_N + i) * 2] = i / (GRID_N - 1);
        uvs[(j * GRID_N + i) * 2 + 1] = j / (GRID_N - 1);
      }
    }
    const indices = new Uint32Array((GRID_N - 1) * (GRID_N - 1) * 6);
    let k = 0;
    for (let j = 0; j < GRID_N - 1; j++) {
      for (let i = 0; i < GRID_N - 1; i++) {
        const a = j * GRID_N + i;
        indices[k++] = a;
        indices[k++] = a + 1;
        indices[k++] = a + GRID_N;
        indices[k++] = a + 1;
        indices[k++] = a + GRID_N + 1;
        indices[k++] = a + GRID_N;
      }
    }
    this.gridIndexCount = indices.length;
    this.gridVao = gl.createVertexArray()!;
    gl.bindVertexArray(this.gridVao);
    const uvBuf = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, uvBuf);
    gl.bufferData(gl.ARRAY_BUFFER, uvs, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    const idxBuf = gl.createBuffer()!;
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, idxBuf);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, indices, gl.STATIC_DRAW);
    gl.bindVertexArray(null);
    this.initStreamlineSeeds();
    this.axesVao = gl.createVertexArray()!;
    const axes = new Float32Array([
      // x axis: red-ish
      -1, 0, 0, 0.75, 0.3, 0.3, 1, 0, 0, 0.75, 0.3, 0.3,
      // y axis: green-ish
      0, -1, 0, 0.3, 0.65, 0.3, 0, 1, 0, 0.3, 0.65, 0.3,
      // z axis: blue-ish
      0, 0, -1, 0.3, 0.4, 0.8, 0, 0, 1, 0.3, 0.4, 0.8,
    ]);
    gl.bindVertexArray(this.axesVao);
    const buf = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, axes, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 24, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 24, 12);
    gl.bindVertexArray(null);
  }

  clearGeometry() {
    this.geometry.clear();
  }

  /** Jittered lattice seeds in the unit box, each with a wave phase. */
  private initStreamlineSeeds(): void {
    const { gl } = this;
    const n = STREAMLINE_CELLS_N;
    const seeds = new Float32Array(n * n * n * STREAMLINES_PER_CELL * 4);
    let hash = 0x2545f491;
    const random = () => {
      hash ^= hash << 13;
      hash ^= hash >>> 17;
      hash ^= hash << 5;
      return (hash >>> 0) / 4294967296;
    };
    let o = 0;
    for (let k = 0; k < n; k++)
      for (let j = 0; j < n; j++)
        for (let i = 0; i < n; i++)
          for (let c = 0; c < STREAMLINES_PER_CELL; c++) {
            seeds[o++] = -1 + (2 * (i + random())) / n;
            seeds[o++] = -1 + (2 * (j + random())) / n;
            seeds[o++] = -1 + (2 * (k + random())) / n;
            seeds[o++] = 2 * Math.PI * random();
          }
    this.streamlineSeeds = n * n * n * STREAMLINES_PER_CELL;
    this.streamlineVao = gl.createVertexArray()!;
    gl.bindVertexArray(this.streamlineVao);
    const buf = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, seeds, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 4, gl.FLOAT, false, 0, 0);
    gl.vertexAttribDivisor(0, 1);
    gl.bindVertexArray(null);
  }

  render(cam: Camera3D, scene: Scene3D, time = 0, env: Record<string, number> = {}): void {
    const surfaces = scene.implicits;
    const { gl } = this;
    const w = gl.drawingBufferWidth;
    const h = gl.drawingBufferHeight;
    gl.viewport(0, 0, w, h);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.clear(gl.DEPTH_BUFFER_BIT);

    const { vp, invVp, eye } = cameraMatrices(cam, w / h);
    const boxR = cameraBoxR(cam);

    const setCommon = (prog: WebGLProgram) => {
      gl.useProgram(prog);
      gl.uniformMatrix4fv(gl.getUniformLocation(prog, 'uVP'), false, vp);
      const inv = gl.getUniformLocation(prog, 'uInvVP');
      if (inv) gl.uniformMatrix4fv(inv, false, invVp);
      const res = gl.getUniformLocation(prog, 'uRes');
      if (res) gl.uniform2f(res, w, h);
      const box = gl.getUniformLocation(prog, 'uBoxR');
      if (box) gl.uniform1f(box, boxR);
      const tLoc = gl.getUniformLocation(prog, 't');
      if (tLoc) gl.uniform1f(tLoc, time);
    };
    const setParams = (prog: WebGLProgram, params?: string[], uniforms?: Record<string, number>) => {
      for (const p of params ?? []) {
        const loc = gl.getUniformLocation(prog, uniformName(p));
        if (loc) gl.uniform1f(loc, uniforms?.[uniformName(p)] ?? env[p] ?? 0);
      }
    };

    // Axes lines.
    setCommon(this.axesProgram);
    gl.bindVertexArray(this.axesVao);
    gl.drawArrays(gl.LINES, 0, 6);
    gl.bindVertexArray(null);

    for (const s of surfaces) {
      let prog: WebGLProgram;
      try {
        prog = this.cache.get(QUAD_VERT, surfaceFrag(s.field, s.grad, s.params));
      } catch (e) {
        console.error(e);
        continue;
      }
      setCommon(prog);
      setParams(prog, s.params, s.uniforms);
      gl.uniform3f(gl.getUniformLocation(prog, 'uColor'), ...s.color);
      gl.uniform3f(gl.getUniformLocation(prog, 'uEye'), ...eye);
      this.quad.draw();
    }

    for (const s of scene.psurfaces) {
      let prog: WebGLProgram;
      try {
        prog = this.cache.get(psurfVert(s.comps, s.params), psurfFrag(s.comps, s.du, s.dv, s.params));
      } catch (e) {
        console.error(e);
        continue;
      }
      setCommon(prog);
      setParams(prog, s.params, s.uniforms);
      gl.uniform3f(gl.getUniformLocation(prog, 'uColor'), ...s.color);
      gl.uniform3f(gl.getUniformLocation(prog, 'uEye'), ...eye);
      gl.bindVertexArray(this.gridVao);
      gl.drawElements(gl.TRIANGLES, this.gridIndexCount, gl.UNSIGNED_INT, 0);
      gl.bindVertexArray(null);
    }

    // CPU-built lit meshes: tubes and hull solids. Pushed a hair back so a
    // hull's edge lines, which lie exactly in its faces, stay on top of them.
    gl.enable(gl.POLYGON_OFFSET_FILL);
    gl.polygonOffset(1, 1);
    for (const tube of scene.tubes) {
      setCommon(this.tubeProgram);
      gl.uniform3f(gl.getUniformLocation(this.tubeProgram, 'uColor'), ...tube.color);
      gl.uniform3f(gl.getUniformLocation(this.tubeProgram, 'uEye'), ...eye);
      gl.uniform2f(gl.getUniformLocation(this.tubeProgram, 'uCells'), ...tube.cells);
      if (tube.retained) {
        this.geometry.bind(
          tube.positions,
          [
            { data: tube.positions, size: 3 },
            { data: tube.normals, size: 3 },
            { data: tube.uvs, size: 2 },
          ],
          tube.indices,
        );
      } else {
        gl.bindVertexArray(this.tubeVao);
        gl.bindBuffer(gl.ARRAY_BUFFER, this.tubePosBuf);
        gl.bufferData(gl.ARRAY_BUFFER, tube.positions, gl.DYNAMIC_DRAW);
        gl.bindBuffer(gl.ARRAY_BUFFER, this.tubeNrmBuf);
        gl.bufferData(gl.ARRAY_BUFFER, tube.normals, gl.DYNAMIC_DRAW);
        gl.bindBuffer(gl.ARRAY_BUFFER, this.tubeUvBuf);
        gl.bufferData(gl.ARRAY_BUFFER, tube.uvs, gl.DYNAMIC_DRAW);
        gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, tube.indices, gl.DYNAMIC_DRAW);
      }
      gl.drawElements(gl.TRIANGLES, tube.indices.length, gl.UNSIGNED_INT, 0);
      gl.bindVertexArray(null);
    }
    gl.disable(gl.POLYGON_OFFSET_FILL);

    // CPU-sampled parametric curves and points.
    gl.bindVertexArray(this.dynVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.dynBuf);
    for (const c of scene.curves) {
      setCommon(this.lineProgram);
      gl.uniform3f(gl.getUniformLocation(this.lineProgram, 'uColor'), ...c.color);
      const cones = c.arrow ? arrowConeInstances(c.pts, finiteRuns(c.pts), boxR) : null;
      const pts = cones ? cones.shafts : c.pts;
      gl.bufferData(gl.ARRAY_BUFFER, pts, gl.DYNAMIC_DRAW);
      gl.uniform1f(gl.getUniformLocation(this.lineProgram, 'uAlpha'), 1);
      gl.uniform1f(gl.getUniformLocation(this.lineProgram, 'uFade'), c.fade ? 1 : 0);
      gl.uniform1f(gl.getUniformLocation(this.lineProgram, 'uCount'), pts.length / 3);
      if (c.triangle) {
        gl.uniform1f(gl.getUniformLocation(this.lineProgram, 'uAlpha'), 0.18);
        gl.depthMask(false);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
        gl.depthMask(true);
        gl.uniform1f(gl.getUniformLocation(this.lineProgram, 'uAlpha'), 1);
      }
      // One strip per finite run: a NaN vertex inside a strip is undefined
      // behaviour in GL, not a pen lift. A lattice of 2-point glyphs packs
      // as LINES so hundreds of arrows are one draw.
      const runs = finiteRuns(pts);
      const glyphLattice = c.arrow && runs.length > 1 && runs.every(([, n]) => n === 2);
      if (glyphLattice) {
        const packed = new Float32Array(runs.length * 6);
        let o = 0;
        for (const [first] of runs) {
          const i = first * 3;
          packed[o++] = pts[i];
          packed[o++] = pts[i + 1];
          packed[o++] = pts[i + 2];
          packed[o++] = pts[i + 3];
          packed[o++] = pts[i + 4];
          packed[o++] = pts[i + 5];
        }
        gl.bufferData(gl.ARRAY_BUFFER, packed, gl.DYNAMIC_DRAW);
        gl.drawArrays(gl.LINES, 0, runs.length * 2);
      } else {
        for (const [first, count] of runs) gl.drawArrays(gl.LINE_STRIP, first, count);
      }
      if (cones && cones.count) {
        setCommon(this.coneProgram);
        gl.uniform3f(gl.getUniformLocation(this.coneProgram, 'uColor'), ...c.color);
        gl.uniform3f(gl.getUniformLocation(this.coneProgram, 'uEye'), ...eye);
        gl.bindVertexArray(this.coneVao);
        gl.bindBuffer(gl.ARRAY_BUFFER, this.coneInstBuf);
        gl.bufferData(gl.ARRAY_BUFFER, cones.instances, gl.DYNAMIC_DRAW);
        gl.drawElementsInstanced(gl.TRIANGLES, this.coneIndexCount, gl.UNSIGNED_SHORT, 0, cones.count);
        gl.bindVertexArray(this.dynVao);
        gl.bindBuffer(gl.ARRAY_BUFFER, this.dynBuf);
      }
    }
    for (const s of scene.segments) {
      setCommon(this.lineProgram);
      gl.uniform1f(gl.getUniformLocation(this.lineProgram, 'uAlpha'), 1);
      gl.uniform1f(gl.getUniformLocation(this.lineProgram, 'uFade'), 0);
      gl.uniform3f(gl.getUniformLocation(this.lineProgram, 'uColor'), ...s.color);
      if (s.retained) this.geometry.bind(s.pts, [{ data: s.pts, size: 3 }]);
      else {
        gl.bindVertexArray(this.dynVao);
        gl.bindBuffer(gl.ARRAY_BUFFER, this.dynBuf);
        gl.bufferData(gl.ARRAY_BUFFER, s.pts, gl.DYNAMIC_DRAW);
      }
      gl.drawArrays(gl.LINES, 0, s.pts.length / 3);
    }
    gl.bindVertexArray(this.dynVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.dynBuf);
    if (scene.points.length) {
      // One draw per run of same-coloured points: a row pushes its whole
      // point list with one colour, so a 10 000-point cloud is one upload and
      // one draw, not 10 000. The dots are opaque, so order does not matter.
      setCommon(this.pointProgram);
      const uColor = gl.getUniformLocation(this.pointProgram, 'uColor');
      const pos = new Float32Array(scene.points.length * 3);
      let start = 0;
      for (let k = 0; k <= scene.points.length; k++) {
        const p = scene.points[k];
        const run = scene.points[start];
        if (p && p.color.every((c, i) => c === run.color[i])) {
          pos.set(p.pos, k * 3);
          continue;
        }
        gl.uniform3f(uColor, ...run.color);
        gl.bufferData(gl.ARRAY_BUFFER, pos.subarray(start * 3, k * 3), gl.DYNAMIC_DRAW);
        gl.drawArrays(gl.POINTS, 0, k - start);
        if (p) pos.set(p.pos, k * 3);
        start = k;
      }
    }
    gl.bindVertexArray(null);

    // Streamlines blend over everything opaque but write no depth, so the
    // dense cloud never hides itself.
    for (const f of scene.streamlines ?? []) {
      let prog: WebGLProgram;
      try {
        prog = this.cache.get(streamlineVert(f.comps, f.params), STREAMLINE_FRAG);
      } catch (e) {
        console.error(e);
        continue;
      }
      setCommon(prog);
      setParams(prog, f.params, f.uniforms);
      gl.uniform3f(gl.getUniformLocation(prog, 'uTarget'), ...cam.target);
      gl.uniform3f(gl.getUniformLocation(prog, 'uEye'), ...eye);
      gl.uniform3f(gl.getUniformLocation(prog, 'uColor'), ...f.color);
      gl.depthMask(false);
      gl.bindVertexArray(this.streamlineVao);
      gl.drawArraysInstanced(gl.LINE_STRIP, 0, 2 * STREAMLINE_STEPS + 1, this.streamlineSeeds);
      gl.bindVertexArray(null);
      gl.depthMask(true);
    }

    // Reference grid plane at z=0, last and without writing depth so its
    // translucent lines never occlude surfaces.
    const spacing = niceSpacing(boxR / 300, 60);
    const plane = this.cache.get(QUAD_VERT, planeFrag());
    setCommon(plane);
    gl.uniform1f(gl.getUniformLocation(plane, 'uMajor'), spacing.major);
    gl.uniform1f(gl.getUniformLocation(plane, 'uMinor'), spacing.minor);
    gl.depthMask(false);
    this.quad.draw();
    gl.depthMask(true);
    this.geometry.endFrame();
  }
}

/** Project axis-end labels (x, y, z) onto the overlay canvas. */
export function drawLabels3D(
  ctx: CanvasRenderingContext2D,
  cam: Camera3D,
  dpr: number,
  points: Scene3D['points'] = [],
  texts: NonNullable<Scene3D['texts']> = [],
): void {
  const w = ctx.canvas.width / dpr;
  const h = ctx.canvas.height / dpr;
  ctx.save();
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, w, h);
  const { vp } = cameraMatrices(cam, w / h);
  const boxR = cameraBoxR(cam);
  ctx.font = 'italic 13px ui-sans-serif, system-ui';
  const labels: Array<[string, number[], string]> = [
    ['x', [boxR * 1.04, 0, 0], '#a44'],
    ['y', [0, boxR * 1.04, 0], '#4a4'],
    ['z', [0, 0, boxR * 1.04], '#46a'],
    ...points
      .filter(p => p.label)
      .map(
        p => [p.label!, p.pos, `rgb(${p.color.map(c => Math.round(c * 255)).join(',')})`] as [string, number[], string],
      ),
  ];
  for (const [text, p, color] of labels) {
    const at = projectToScreen(vp, p, w, h);
    if (!at) continue;
    ctx.fillStyle = color;
    ctx.fillText(text, at[0] + 7, at[1] - 7);
  }
  for (const { pos, text, color } of texts) {
    const at = projectToScreen(vp, pos, w, h);
    if (!at) continue;
    const css = `rgb(${color.map(c => Math.round(c * 255)).join(',')})`;
    drawTextLabel(ctx, text, at[0], at[1], css);
  }
  ctx.restore();
}
