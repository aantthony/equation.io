import EquationCore
import Foundation

// The shaders of web/render3d.ts, kept as the site writes them: each
// constant and function here is the one of the same name there, its GLSL
// text copied and its ${…} holes filled the same way. GLSL3D.swift compiles
// a vertex and fragment pair as Metal. Keep them in step with the site by
// copying, not by rewriting.
//
// Two of the site's shaders are not here: SCATTER_FRAG and COMPOSITE_FRAG,
// a dozen lines each of texel fetches and integer vector tests, are written
// in Metal directly (Programs3D.swift), which is shorter than teaching the
// translator what they alone use.

/// A shared clip-space quad; every fragment-shader pass draws this (web/gl.ts).
let QUAD_VERT = """
  #version 300 es
  layout(location=0) in vec2 aPos;
  void main() { gl_Position = vec4(aPos, 0.0, 1.0); }

  """

let MARCH_COMMON = """

  uniform mat4 uInvVP;
  uniform mat4 uVP;
  uniform vec2 uRes;
  uniform vec2 uOrigin;
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

  """

let STEPS = 220
/// Halvings of a sign-change bracket (at most 1/MIN_SAMPLES of the span):
/// 12 leave it well under a pixel. Each is one more evaluation of the field,
/// which for an escape surface is a whole orbit.
let BISECT = 12
/// March samples spent bisecting onto an edge of a field's domain (where it
/// turns NaN).
let EDGE_BISECT = 6
/// Domain edges refined per ray: into the domain and out of it again.
let EDGE_BUDGET = 2
/// Coarsest step, as a fraction of the ray's span through the box.
let MIN_SAMPLES = 48
/// Finest step: STEPS × FINEST of them cover the span, so a ray that grinds
/// the whole way still reaches 1/FINEST of it.
let FINEST = 4
/// Fraction of the estimated distance-to-zero actually stepped.
let SAFETY = "0.6"
/// Sign changes per ray that may be refused as jumps (see JUMP_RATIO); past
/// the budget a field that jumps on most steps (floor(20 x) - z) is marched
/// without further refusals, as it always was.
let JUMP_BUDGET = 4
/// A sign change is a root only if its bracket closes: bisecting a continuous
/// crossing shrinks |F(b) - F(a)| with the bracket, while across a jump — the
/// ±π cut of atan2 in theta = pi/4, a floor step, a pole — it stays the size
/// it started. Refused when the bisected gap is still this fraction of it.
let JUMP_RATIO = "0.25"

/// Progressive refinement (Renderer3D.drawImplicits): with uChunk =
/// (grid, x, y), fragment (i, j) of a pass stands for full-resolution pixel
/// (grid i + x, grid j + y) — one cell of every grid × grid block, as a
/// dense image a grid-th the size. (Masking the full-size image down to
/// that cell instead saves nothing: GPUs shade 2×2 quads and wider groups,
/// which run the whole march for their one surviving pixel.) grid 0 is the
/// plain full-resolution pass.
let CHUNK_DECL = "uniform ivec3 uChunk;"
let CHUNK_PIXEL =
  "vec2 pix = uChunk.x > 0 ? floor(gl_FragCoord.xy) * float(uChunk.x) + vec2(uChunk.yz) + 0.5 : gl_FragCoord.xy;"
/// A sample's offset within its pixel, for antialiasing at rest.
let JITTER_DECL = "uniform vec2 uJitter;"

/// The one light every lit surface shares — implicit and parametric
/// surfaces, tubes and cones — so the same shape shades the same however it
/// is written: a fixed key light with a Blinn–Phong highlight, a sky term
/// brighter facing up, and a dim fill from the eye. The fill tells apart
/// faces the key light misses at the same height (two sides of a cube seen
/// corner-on), darkening toward the silhouette as a lit object does. The
/// weights sum to 1, so a surface facing every light shows its own colour.
/// `rd` runs from the eye; `facing` turns a normal toward it first.
let SHADE = """

  const vec3 LIGHT_DIR = vec3(0.3546, 0.4876, 0.7978); // normalize(0.4, 0.55, 0.9)
  vec3 facing(vec3 n, vec3 rd) {
    if (any(isnan(n))) return -rd;
    return dot(n, rd) > 0.0 ? -n : n;
  }
  vec3 shade(vec3 base, vec3 n, vec3 rd) {
    float diffuse = max(dot(n, LIGHT_DIR), 0.0);
    float sky = 0.5 + 0.5 * n.z;
    float fill = max(dot(n, -rd), 0.0);
    float spec = pow(max(dot(n, normalize(LIGHT_DIR - rd)), 0.0), 48.0);
    return base * (0.20 + 0.22 * sky + 0.46 * diffuse + 0.12 * fill) + vec3(0.35) * spec;
  }
  """

func surfaceFrag(_ field: String, _ grad: [String]? = nil, _ params: [String]? = nil) -> String {
  let gradFn =
    grad.map { grad in
      """

      vec3 gradF(vec3 p, float h) {
        float x = p.x, y = p.y, z = p.z;
        return vec3(\(grad[0]), \(grad[1]), \(grad[2]));
      }
      """
    }
    ?? """

      vec3 gradF(vec3 p, float h) {
        return vec3(
          F(p + vec3(h, 0, 0)) - F(p - vec3(h, 0, 0)),
          F(p + vec3(0, h, 0)) - F(p - vec3(0, h, 0)),
          F(p + vec3(0, 0, h)) - F(p - vec3(0, 0, h)));
      }
      """
  return """
    #version 300 es
    precision highp float;
    uniform vec3 uColor;
    uniform vec3 uEye;
    \(CHUNK_DECL)
    \(JITTER_DECL)
    \(paramDecls(params ?? []))
    out vec4 outColor;
    \(glslPrelude)
    \(MARCH_COMMON)
    \(SHADE)

    float F(vec3 p) {
      float x = p.x, y = p.y, z = p.z;
      return \(field);
    }
    \(gradFn)

    void main() {
      \(CHUNK_PIXEL)
      vec2 ndc = ((pix + uJitter - uOrigin) / uRes) * 2.0 - 1.0;
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
      float dtMax = rayLen / float(\(MIN_SAMPLES));
      float dtMin = rayLen / float(\(STEPS * FINEST));
      float dt = rayLen / float(\(STEPS));
      float tPrev = t0;
      float vPrev = F(ro + rd * t0);
      bool hit = false;
      float tHit = 0.0;
      float tErr = 0.0;
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

      for (int i = 0; i < \(STEPS); i++) {
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
        } else if (undef != isnan(vPrev) && edges < \(EDGE_BUDGET)) {
          edges++;
          refine = \(EDGE_BISECT);
          entering = !undef;
          if (entering) { tEdge = tPrev; tIn = t; vIn = v; } else { tEdge = t; }
          continue;
        }
        bool finite = !isnan(v) && !isinf(v) && !isnan(vPrev) && !isinf(vPrev);
        if (finite && sign(v) != sign(vPrev)) {
          // Bisect to the crossing.
          float a = tPrev, b = t, va = vPrev, vb = v;
          for (int j = 0; j < \(BISECT); j++) {
            float m = 0.5 * (a + b);
            float vm = F(ro + rd * m);
            if (sign(vm) == sign(va)) { a = m; va = vm; } else { b = m; vb = vm; }
          }
          // A bracket that did not close is a jump, not a root: step over it and
          // keep marching, since the real surface may lie beyond.
          bool jump = !(abs(vb - va) < \(JUMP_RATIO) * abs(v - vPrev));
          if (!jump || jumps >= \(JUMP_BUDGET)) {
            tHit = 0.5 * (a + b);
            tErr = 0.5 * (b - a);
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
        dt = clamp(slope > 0.0 ? \(SAFETY) * abs(v) / slope : dtMax, dtMin, dtMax);
        tPrev = t;
        vPrev = v;
        if (refining && refine == 0) { tPrev = tEdge; vPrev = EQ_NAN; dt = dtMax; }
        if (t >= t1) break;
      }
      if (!hit) discard;

      vec3 p = ro + rd * tHit;
      float h = max(rayLen * 2e-3, uBoxR * 1e-4);
      vec3 n = normalize(gradF(p, h));
      n = facing(n, rd);

      // Subtle checker so the surface reads as a grid: the product of each
      // axis's alternating ±1 cells, each box-filtered over what the pixel
      // covers along that axis — its footprint on the surface, and the march's
      // error along the ray. Unfiltered, a surface on a cell boundary flipped
      // cells with the sign of that error, in rings around the camera, and far
      // or grazing surfaces aliased into moiré; filtered, a boundary reads as an
      // even mean and fine cells fade out. Cell boundaries lie on the coordinate
      // planes, so a sphere splits along its equator and meridians like a globe;
      // a plane on a boundary (x = 0) reads flat, its mean.
      float cs = uBoxR / 4.0;
      // The footprint along each axis, from where the next pixels' rays (across
      // and up) meet the surface's tangent plane; a ray parallel to it covers
      // the whole axis.
      vec3 footprint = vec3(0.0);
      for (int k = 0; k < 2; k++) {
        vec2 ndcK = ndc + (k == 0 ? vec2(2.0 / uRes.x, 0.0) : vec2(0.0, 2.0 / uRes.y));
        vec3 roK = unproject(vec3(ndcK, -1.0));
        vec3 rdK = unproject(vec3(ndcK, 1.0)) - roK;
        vec3 dp = roK + rdK * (dot(p - roK, n) / dot(rdK, n)) - p;
        footprint += all(lessThan(abs(dp), vec3(1e6))) ? abs(dp) : vec3(1e6);
      }
      vec3 w = max((footprint + 16.0 * tErr * abs(rd)) / cs, 1e-4);
      vec3 q = p / cs;
      // The integral of the ±1 cells is a triangle wave; its difference across w is the box filter.
      vec3 cell = 2.0 * (abs(fract((q - 0.5 * w) * 0.5) - 0.5) - abs(fract((q + 0.5 * w) * 0.5) - 0.5)) / w;
      float checker = 0.5 - 0.5 * cell.x * cell.y * cell.z;
      vec3 base = uColor * (0.92 + 0.08 * checker);

      vec3 col = shade(base, n, rd);
      // Distance fade toward the box edge keeps clipped surfaces from popping.
      float edge = smoothstep(uBoxR, uBoxR * 0.96, max(max(abs(p.x), abs(p.y)), abs(p.z)));
      outColor = vec4(col, 0.6 + 0.4 * edge);
      gl_FragDepth = depthOf(p);
    }

    """
}

/// Samples along each ray through a cloud: its chord through the cloud's
/// ball (to the nearest surface, if nearer) in equal steps, their start jittered per pixel
/// and per antialiasing pass so the steps band into noise that averages out.
let VOLUME_STEPS = 160
/// Optical depth across the cloud's full-density radius where |F| is at its
/// scale: a ray through that much of it is ~86% covered.
let VOLUME_DENSITY = "1.2"

/// A field in space as a cloud: emission–absorption along each ray, front to
/// back, with density (F / uScale)² — thin where the field is small, dense
/// where it is large — tinted like a field in the plane, the row colour where
/// F is positive and its complement where negative. The march stops at the
/// implicit surfaces' depth (uStopDepth), so a surface inside the cloud is
/// seen through the part in front of it.
///
/// The reference grid is the plane z = 0, and a cloud straddles it: each ray
/// is marched in two passes split where it crosses the plane, uBack choosing
/// the part beyond it, drawn before the grid, or the part before it, drawn
/// after. They share one step size, so together they cost one march. The depth
/// is where the cloud starts, only tested against what is already drawn —
/// never written, since a faint haze must not hide the grid behind it.
func volumeFrag(_ field: String, _ params: [String]? = nil) -> String {
  """
  #version 300 es
  precision highp float;
  uniform vec3 uColor;
  uniform float uScale;
  uniform sampler2D uStopDepth;
  uniform bool uStop;
  uniform bool uBack;
  uniform float uVolR;
  uniform vec3 uVolC;
  \(CHUNK_DECL)
  \(JITTER_DECL)
  \(paramDecls(params ?? []))
  out vec4 outColor;
  \(glslPrelude)
  \(MARCH_COMMON)

  float F(vec3 p) {
    float x = p.x, y = p.y, z = p.z;
    return \(field);
  }

  void main() {
    \(CHUNK_PIXEL)
    vec2 uv = (pix + uJitter - uOrigin) / uRes;
    vec2 ndc = uv * 2.0 - 1.0;
    vec3 ro = unproject(vec3(ndc, -1.0));
    vec3 far = unproject(vec3(ndc, 1.0));
    vec3 rd = normalize(far - ro);

    // The chord through the ball of radius 2 uVolR where the cloud has any density.
    vec3 oc = ro - uVolC;
    float b = dot(oc, rd);
    float disc = b * b - dot(oc, oc) + 4.0 * uVolR * uVolR;
    if (disc <= 0.0) discard;
    float t0 = max(-b - sqrt(disc), 0.0);
    float t1 = -b + sqrt(disc);
    if (uStop) {
      float d = texture(uStopDepth, uv).r;
      if (d < 1.0) t1 = min(t1, dot(unproject(vec3(ndc, d * 2.0 - 1.0)) - ro, rd));
    }
    if (t1 <= t0) discard;
    float dt = (t1 - t0) / float(\(VOLUME_STEPS));
    // Where the ray meets the grid's plane, or never if it runs parallel or away.
    float tPlane = rd.z != 0.0 && -ro.z / rd.z > 0.0 ? -ro.z / rd.z : 1e30;
    float from = uBack ? max(t0, tPlane) : t0;
    float to = uBack ? t1 : min(t1, tPlane);
    if (to <= from) discard;

    float offset = fract(sin(dot(pix + uJitter * 7.31, vec2(12.9898, 78.233))) * 43758.5453);
    vec3 comp = 1.0 - uColor;
    vec3 color = vec3(0.0);
    float alpha = 0.0;
    float tFront = to;
    for (int i = 0; i < \(VOLUME_STEPS); i++) {
      float t = t0 + (float(i) + offset) * dt;
      if (t < from) continue;
      if (t > to) break;
      vec3 p = ro + rd * t;
      float s = F(p) / uScale;
      if (isnan(s) || isinf(s)) continue;
      s = clamp(s, -1.0, 1.0);
      // Full density out to uVolR, thinning smoothly to none at twice that.
      float falloff = smoothstep(2.0 * uVolR, uVolR, length(p - uVolC));
      float a = 1.0 - exp(-\(VOLUME_DENSITY) * s * s * falloff * dt / uVolR);
      color += (1.0 - alpha) * a * (s >= 0.0 ? uColor : comp);
      alpha += (1.0 - alpha) * a;
      if (tFront == to && alpha > 0.0) tFront = t;
      if (alpha > 0.99) break;
    }
    if (alpha < 1.0 / 255.0) discard;
    outColor = vec4(color / alpha, alpha);
    gl_FragDepth = depthOf(ro + rd * tFront);
  }

  """
}

/// Vertices along each side of the (u, v) mesh a parametric surface is drawn with.
let GRID_N = 160

/// Parametric surface P(u,v), u,v in (0,1), the old surface3 way: a static
/// (u,v) grid mesh is displaced by P in the VERTEX shader (rasterization gives
/// depth for free), and the fragment shader lights with the symbolically
/// differentiated tangents ∂P/∂u × ∂P/∂v — finite differences only when a
/// component has no smooth derivative.
func psurfVert(_ comps: [String], _ params: [String]? = nil, _ lift: Bool = false) -> String {
  // A mesh that lies on another surface (SurfacePaint lift) is raised off
  // it toward the eye, along its normal, by more than its flat cells sag
  // below the curved surface between vertices: a quarter of the second
  // differences across a cell, along the normal (the sag is an eighth).
  let main =
    lift
    ? """

        const float h = \(String(format: "%.8f", 1 / Double(GRID_N - 1)));
        float u = aUV.x, v = aUV.y;
        vec3 p = P(u, v);
        vec3 pu = P(u + h, v), mu = P(u - h, v), pv = P(u, v + h), mv = P(u, v - h);
        vec3 n = cross(pu - mu, pv - mv);
        float len = length(n);
        if (len > 0.0 && !isinf(len)) {
          n /= len;
          if (dot(n, uEye - p) < 0.0) n = -n;
          float sag = abs(dot(pu + mu - 2.0 * p, n)) + abs(dot(pv + mv - 2.0 * p, n));
          if (!isnan(sag) && !isinf(sag)) p += 0.25 * sag * n;
        }
        vPos = p;
      """
    : """

        vPos = P(aUV.x, aUV.y);
      """
  return """
    #version 300 es
    layout(location=0) in vec2 aUV;
    uniform mat4 uVP;
    uniform float t;
    \(lift ? "uniform vec3 uEye;" : "")
    \(paramDecls(params ?? []))
    out vec2 vUV;
    out vec3 vPos;
    \(glslPrelude)
    vec3 P(float u, float v) {
      return vec3(\(comps[0]), \(comps[1]), \(comps[2]));
    }
    void main() {
      vUV = aUV;\(main)
      gl_Position = uVP * vec4(vPos, 1.0);
    }

    """
}

/// A surface's tangents: its symbolic derivatives, or central differences of P.
private func tangentsGlsl(_ comps: [String], _ du: [String]?, _ dv: [String]?) -> String {
  if let du, let dv {
    return """

      vec3 Pu(float u, float v) { return vec3(\(du[0]), \(du[1]), \(du[2])); }
      vec3 Pv(float u, float v) { return vec3(\(dv[0]), \(dv[1]), \(dv[2])); }
      """
  }
  return """

    vec3 P(float u, float v) { return vec3(\(comps[0]), \(comps[1]), \(comps[2])); }
    vec3 Pu(float u, float v) { return (P(u + 1e-3, v) - P(u - 1e-3, v)) * 500.0; }
    vec3 Pv(float u, float v) { return (P(u, v + 1e-3) - P(u, v - 1e-3)) * 500.0; }
    """
}

func psurfFrag(
  _ comps: [String], _ du: [String]? = nil, _ dv: [String]? = nil, _ params: [String]? = nil,
  _ paint: String? = nil
) -> String {
  let base =
    paint == nil
    ? "  vec3 base = uColor * (0.92 + 0.08 * checker);"
    : """
        // Coloured by a scalar (its curvature), diverging about 0 as a scalar
        // field is shaded: toward the row colour where it is positive, toward its
        // complement where negative, grey at 0 and where it is undefined. uGain
        // scales the surface's typical size of it to about 1.
        float k = K(vUV.x, vUV.y);
        float s = isnan(k) || isinf(k) ? 0.0 : eq_tanh(k * uGain);
        vec3 tint = s >= 0.0 ? uColor : vec3(1.0) - uColor;
        vec3 base = mix(vec3(0.8), tint, abs(s)) * (0.92 + 0.08 * checker);
      """
  return """
    #version 300 es
    precision highp float;
    uniform vec3 uColor;
    uniform vec3 uEye;
    uniform float t;
    \(paint != nil ? "uniform float uGain;" : "")
    \(paramDecls(params ?? []))
    in vec2 vUV;
    in vec3 vPos;
    out vec4 outColor;
    \(glslPrelude)
    \(SHADE)
    \(tangentsGlsl(comps, du, dv))
    \(paint.map { "float K(float u, float v) { return \($0); }" } ?? "")

    void main() {
      vec3 n = normalize(cross(Pu(vUV.x, vUV.y), Pv(vUV.x, vUV.y)));
      vec3 rd = normalize(vPos - uEye);
      n = facing(n, rd);

      // Faint parameter checker so the (u,v) mapping reads.
      float checker = mod(floor(vUV.x * 8.0) + floor(vUV.y * 8.0), 2.0);
    \(base)

      outColor = vec4(shade(base, n, rd), 1.0);
    }

    """
}

/// A 2D row painted on a surface (lib/surface-map.ts): the surface's own mesh
/// (psurfVert), with x and y read at each fragment from its (u, v) — `xy` is
/// their GLSL in u and v — and the row shaded there as the 2D renderer
/// shades it: a curve as a line about two pixels wide (|F| over its change
/// across a pixel, so it stays that wide however the surface turns), a
/// region as a tint with its edges, a field signed toward the row colour or
/// its complement. Lit as the surface is, so it reads as printed on it.
func paintFrag(
  _ comps: [String], _ du: [String]?, _ dv: [String]?, _ xy: [String], _ paint: SurfacePaint.Paint,
  _ params: [String]? = nil
) -> String {
  let edges = paint.kind == .region ? paint.edges ?? [] : []
  let body: String
  switch paint.kind {
  case .curve:
    body = """

        // |F| over its change across a pixel, from samples a pixel and half a
        // pixel either way along the screen's two directions — stepping x and y
        // as they change from pixel to pixel there, so exact for an F linear
        // across it however the surface is turned. The two steps agree at a true
        // zero, as in the 2D curve shader; a step off F's domain (past sqrt's
        // edge, onto a pole) is left out, the slope coming from the other side.
        float ax[5] = float[5](F(x - jx.x, y - jx.y), F(x - 0.5 * jx.x, y - 0.5 * jx.y), f,
                               F(x + 0.5 * jx.x, y + 0.5 * jx.y), F(x + jx.x, y + jx.y));
        float ay[5] = float[5](F(x - jy.x, y - jy.y), F(x - 0.5 * jy.x, y - 0.5 * jy.y), f,
                               F(x + 0.5 * jy.x, y + 0.5 * jy.y), F(x + jy.x, y + jy.y));
        if (pole(ax) || pole(ay)) discard;
        vec2 g1 = vec2(slope(ax[0], f, ax[4], 1.0), slope(ay[0], f, ay[4], 1.0));
        vec2 g2 = vec2(slope(ax[1], f, ax[3], 0.5), slope(ay[1], f, ay[3], 0.5));
        float e1 = abs(f) / max(length(g1), 1e-24);
        float e2 = abs(f) / max(length(g2), 1e-24);
        if (e2 > 1.6 * e1 || e1 > 1.6 * e2) discard;
        float d = max(e1, e2);
        float alpha = 1.0 - smoothstep(0.6, 1.6, d);
        vec3 base = uColor;
      """
  case .region:
    let edgeBlocks = edges.indices.map { i in
      """
        {
          float w = abs(ev[\(i)]) / max(ew[\(i)], 1e-24);
          // An edge undefined here (log(x) at x <= 0) draws nothing here.
          if (!isnan(w) && !isinf(w))
            alpha = max(alpha, 0.9 * (1.0 - smoothstep(0.5, 1.5, w)) * (1.0 - smoothstep(-aa, aa, f - 1e-6 * aa)));
        }
      """
    }.joined(separator: "\n")
    body = """

        float aa = max(fw, 1e-24);
        float alpha = (1.0 - smoothstep(-aa, aa, f)) * 0.35;
      \(edgeBlocks)
        vec3 base = uColor;
      """
  case .scalar:
    body = """

        float s = eq_tanh(f * uGain);
        float alpha = 0.7 * abs(s);
        vec3 base = s >= 0.0 ? uColor : vec3(1.0) - uColor;
      """
  }
  let edgeValues =
    edges.isEmpty
    ? ""
    : "  float ev[\(edges.count)] = float[\(edges.count)]("
      + edges.indices.map { "E\($0)(x, y)" }.joined(separator: ", ")
      + ");\n  float ew[\(edges.count)] = float[\(edges.count)]("
      + edges.indices.map { "fwidth(ev[\($0)])" }.joined(separator: ", ") + ");"
  return """
    #version 300 es
    precision highp float;
    uniform vec3 uColor;
    uniform vec3 uEye;
    uniform float t;
    \(paint.kind == .scalar ? "uniform float uGain;" : "")
    \(paramDecls(params ?? []))
    in vec2 vUV;
    in vec3 vPos;
    out vec4 outColor;
    \(glslPrelude)
    \(SHADE)
    \(tangentsGlsl(comps, du, dv))
    float F(float x, float y) { return \(paint.field); }
    // F's change over a pixel from samples a step s (in pixels) either side of
    // f: central where both are defined, one-sided where only one is.
    float slope(float fm, float f, float fp, float s) {
      bool m = !isnan(fm) && !isinf(fm), p = !isnan(fp) && !isinf(fp);
      return m && p ? (fp - fm) / (2.0 * s) : p ? (fp - f) / s : m ? (f - fm) / s : 0.0;
    }
    // Whether F changes sign between samples s (in order across the pixel) by
    // a pole, not a zero: toward a zero |F| falls from both sides, toward a
    // pole (tan(x) at π/2, 1/x at 0) it rises.
    bool pole(float s[5]) {
      for (int i = 0; i < 4; i++)
        if (s[i] * s[i + 1] < 0.0 || isinf(s[i]) || isinf(s[i + 1]))
          return (i == 0 || abs(s[i]) > abs(s[i - 1])) && (i == 3 || abs(s[i + 1]) > abs(s[i + 2]));
      return false;
    }
    \(edges.enumerated().map { i, e in "float E\(i)(float x, float y) { return \(e); }" }.joined(separator: "\n"))

    void main() {
      float u = vUV.x, v = vUV.y;
      float x = \(xy[0]);
      float y = \(xy[1]);
      float f = F(x, y);
      // Derivatives before any discard, in uniform flow: how x and y change
      // from pixel to pixel, and F and the region's edges across one.
      vec2 jx = vec2(dFdx(x), dFdx(y)), jy = vec2(dFdy(x), dFdy(y));
      float fw = fwidth(f);
    \(edgeValues)
      if (isnan(f) || isinf(f)) discard;
    \(body)
      if (alpha < 0.004) discard;
      vec3 n = normalize(cross(Pu(u, v), Pv(u, v)));
      vec3 rd = normalize(vPos - uEye);
      n = facing(n, rd);
      outColor = vec4(shade(base, n, rd), alpha);
    }

    """
}

/// CPU-built tube meshes (curve framing): position+normal lighting with a
/// material checker in (arclength × ring angle) coordinates, the same faint
/// grid parametric surfaces get — but painted on the tube's own material.
let TUBE_VERT = """
  #version 300 es
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

  """

let TUBE_FRAG = """
  #version 300 es
  precision highp float;
  uniform vec3 uColor;
  uniform vec3 uEye;
  uniform vec2 uCells;
  in vec3 vPos;
  in vec3 vNormal;
  in vec2 vUV;
  out vec4 outColor;
  \(SHADE)
  void main() {
    vec3 n = normalize(vNormal);
    vec3 rd = normalize(vPos - uEye);
    n = facing(n, rd);

    // Material checker: cells are square-ish in world units and follow the
    // rotation-minimizing frame, so the pattern reads as painted on the tube.
    float checker = mod(floor(min(vUV.x, 0.9999) * uCells.x) + floor(min(vUV.y, 0.9999) * uCells.y), 2.0);
    // Fade to the average shade once cells shrink toward pixel size, so distant
    // or thin tubes don't moiré.
    vec2 cw = fwidth(vUV * uCells);
    checker = mix(checker, 0.5, clamp(max(cw.x, cw.y) * 1.5 - 0.25, 0.0, 1.0));
    // Slightly stronger than the psurface checker: tube cells are far smaller.
    vec3 base = uColor * (0.88 + 0.12 * checker);

    outColor = vec4(shade(base, n, rd), 1.0);
  }

  """

/// Instanced unit cone: local +z along the shaft, tip at the origin.
/// Lighting uses the analytic radial normal (from interpolated local xy),
/// so a coarse tessellation still shades as a smooth cone. aNormal.z < 0
/// marks the base cap, whose normal is just −local z.
let CONE_VERT = """
  #version 300 es
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

  """

let CONE_FRAG = """
  #version 300 es
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
  \(SHADE)
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
    n = facing(n, rd);
    outColor = vec4(shade(uColor, n, rd), 1.0);
  }

  """

let LINE_VERT = """
  #version 300 es
  layout(location=0) in vec3 aPos;
  uniform mat4 uVP;
  uniform float uCount;
  out float vProgress;
  void main() { gl_Position = uVP * vec4(aPos, 1.0); vProgress = float(gl_VertexID) / max(1.0, uCount - 1.0); }

  """

let LINE_FRAG = """
  #version 300 es
  precision highp float;
  uniform vec3 uColor;
  out vec4 outColor;
  uniform float uAlpha;
  uniform float uFade;
  in float vProgress;
  void main() { outColor = vec4(uColor, uAlpha * mix(1.0, 0.15 + 0.85 * vProgress, uFade)); }

  """

/// A point's dot is depth-tested POINT_LIFT of its radii nearer the eye than
/// the point — moved along its own sight line, so it lands on the same pixel.
/// A surface the point lies on (a plane, or three meeting at a system's
/// solution) used to cut the flat dot in half or hide it. Seen at an angle α
/// to the view, a plane through the point comes r / tan α nearer the eye
/// across the dot, so a lift of L radii clears every plane steeper than
/// atan(1 / L) (14° for 4); a shallower one draws as a thin band and covers
/// little. A surface more than the lift in front of the point still hides it.
/// In perspective a dot of px pixels has a radius in world units that is a
/// fixed fraction of the distance to the eye, px tan(fov/2) / viewport height,
/// so the lift is that fraction (uLiftK × px) of the way to the eye, at most
/// half of it.
///
/// The lift is a screen-space stand-in for deciding visibility at the dot's
/// centre alone: a surface in front of the point but within the lift (a
/// sphere under ~4 dot radii on screen around it) does not hide it, and a
/// thin object that close in front is drawn behind the dot.
///
/// A dot is a ball of fixed size in the world, aDot.x across, so in
/// perspective it is aDot.x × uPxK / depth pixels: bigger nearer the eye,
/// smaller farther off, and growing as the camera zooms in. A cloud's dots
/// are POINT_SPACING of its points' spacing (see pointVertices), so a dense
/// cloud's dots stay apart and its shape shows; a lone point's, and any dot's
/// at most, are POINT_PX at the camera's target distance, as before.
///
/// A cloud's dots fade with depth across (aDot.y, aDot.y + aDot.z): full at
/// its nearest point's depth, down to POINT_FAR_ALPHA at the far end, so it
/// reads front to back. A lone point is drawn solid wherever it is, until it
/// is under POINT_MIN_PX and fades by area like any dot.
///
/// Translucent dots are drawn farthest first without writing depth, so each
/// blends over what is behind it — other dots included — and still hides
/// behind surfaces. A second pass (uDepthPass) then writes depth for the
/// mostly-opaque core of each dot alone, so what is drawn later (the grid)
/// stays behind a solid dot but shows through a faint one or its soft edge.
let POINT_VERT = """
  #version 300 es
  layout(location=0) in vec3 aPos;
  layout(location=1) in vec3 aColor;
  layout(location=2) in vec3 aDot;
  uniform mat4 uVP;
  uniform vec3 uEye;
  uniform float uLiftK;
  uniform float uPxK;
  uniform float uMaxPx;
  out vec3 vColor;
  out float vAlpha;
  out float vSize;
  void main() {
    float depth = max((uVP * vec4(aPos, 1.0)).w, 1e-6);
    float size = clamp(aDot.x * uPxK / depth, \(String(format: "%.1f", POINT_MIN_PX)), uMaxPx);
    float px = min(aDot.x * uPxK / depth, size);
    float cover = px * px / (size * size);
    float far = aDot.z > 0.0 ? smoothstep(0.0, 1.0, (depth - aDot.y) / aDot.z) : 0.0;
    vColor = aColor;
    vAlpha = cover * mix(1.0, \(String(format: "%.2f", POINT_FAR_ALPHA)), far);
    vSize = size;
    gl_Position = uVP * vec4(mix(aPos, uEye, min(uLiftK * size, 0.5)), 1.0);
    gl_PointSize = size;
  }

  """

let POINT_FRAG = """
  #version 300 es
  precision highp float;
  uniform bool uDepthPass;
  in vec3 vColor;
  in float vAlpha;
  in float vSize;
  out vec4 outColor;
  void main() {
    vec2 q = gl_PointCoord - 0.5;
    float r = length(q);
    if (r > 0.5) discard;
    // Edges a pixel wide at any size. The white rim is part of the dot's look
    // up close; on a dot a few pixels across it would be all rim, so it goes.
    float px = 1.0 / vSize;
    float edge = 1.0 - smoothstep(0.5 - px, 0.5, r);
    float rim = vSize < 4.0 ? 1.0 : 1.0 - smoothstep(0.38 - px, 0.5 - px, r);
    vec3 col = mix(mix(vec3(1.0), vColor, rim), vColor, 1.0 - smoothstep(4.0, 10.0, vSize));
    float alpha = vAlpha * edge;
    if (uDepthPass && alpha < 0.5) discard;
    outColor = vec4(col, alpha);
  }

  """

/// How opaque a plane's sheet is: enough to read as a surface, little
/// enough that a line in it or behind it shows.
let PLANE_ALPHA = 0.22

/// A plane a x + b y + c z + d = 0, met analytically along each ray: a
/// translucent sheet clipped to the box, its rim — where it crosses the
/// box's faces — drawn solid, with the depth of the point hit so what lies in
/// front of it hides it. It writes no depth, so whatever lies behind it — the
/// line where two planes cross, a point in it — shows through.
func planeSheetFrag(_ coeffs: [String], _ params: [String]? = nil) -> String {
  """
  #version 300 es
  precision highp float;
  uniform vec3 uColor;
  \(paramDecls(params ?? []))
  out vec4 outColor;
  \(glslPrelude)
  \(MARCH_COMMON)

  void main() {
    vec2 ndc = ((gl_FragCoord.xy - uOrigin) / uRes) * 2.0 - 1.0;
    vec3 ro = unproject(vec3(ndc, -1.0));
    vec3 far = unproject(vec3(ndc, 1.0));
    vec3 rd = normalize(far - ro);
    vec3 n = vec3(\(coeffs[0]), \(coeffs[1]), \(coeffs[2]));
    float d = \(coeffs[3]);
    float den = dot(n, rd);
    if (!(abs(den) > 1e-12 * length(n))) discard;
    float hitT = -(dot(n, ro) + d) / den;
    vec2 span = boxSpan(ro, rd);
    if (!(hitT >= max(span.x, 0.0) && hitT <= span.y)) discard;
    vec3 p = ro + rd * hitT;
    // How far inside the box, against a width that stays about constant on screen.
    float inside = uBoxR - max(max(abs(p.x), abs(p.y)), abs(p.z));
    float w = hitT * 0.0015;
    float rim = 1.0 - smoothstep(w, 2.0 * w, inside);
    // Seen edge-on a sheet thins to nothing, so it takes a touch more colour.
    float facing = abs(den) / length(n);
    float a = mix(\(String(format: "%.3f", PLANE_ALPHA)) + 0.12 * (1.0 - facing), 0.95, rim);
    outColor = vec4(uColor, a);
    gl_FragDepth = depthOf(p);
  }

  """
}

/// The z=0 reference plane with the same adaptive grid as the 2D view.
func planeFrag(theme: GraphTheme) -> String {
  let strength = { (k: Double) in String(format: "%.3f", k * Double(theme.planeGrid)) }
  return """
    #version 300 es
    precision highp float;
    uniform float uMajor;
    uniform float uMinor;
    out vec4 outColor;
    \(MARCH_COMMON)

    float lineAlpha(float coord, float spacing, float halfWidth) {
      float d = abs(coord - spacing * round(coord / spacing));
      return 1.0 - smoothstep(halfWidth, halfWidth * 2.0, d);
    }

    void main() {
      vec2 ndc = ((gl_FragCoord.xy - uOrigin) / uRes) * 2.0 - 1.0;
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
      float a = max(max(minor * \(strength(0.18)), major * \(strength(0.34))), axis * \(strength(0.6)));
      float fade = 1.0 - smoothstep(uBoxR * 0.6, uBoxR, length(p.xy));
      if (a * fade < 0.01) discard;
      outColor = vec4(\(glslVec3(theme.plane)), a * fade);
      gl_FragDepth = depthOf(p);
    }

    """
}

let AXES_VERT = """
  #version 300 es
  layout(location=0) in vec3 aPos;
  layout(location=1) in vec3 aColor;
  uniform mat4 uVP;
  uniform float uBoxR;
  out vec3 vColor;
  void main() {
    vColor = aColor;
    gl_Position = uVP * vec4(aPos * uBoxR, 1.0);
  }

  """

let AXES_FRAG = """
  #version 300 es
  precision highp float;
  in vec3 vColor;
  out vec4 outColor;
  void main() { outColor = vec4(vColor, 0.9); }

  """

/// Lattice cells per axis: an N×N×N jittered lattice fills the camera box.
let STREAMLINE_CELLS_N = 13
/// Streamlines seeded in each lattice cell.
let STREAMLINES_PER_CELL = 8
/// Integration steps each way from a streamline's seed.
let STREAMLINE_STEPS = 24
/// Integration step as a fraction of the box half-width: a streamline spans
/// about one half-width, long enough to read as flow.
let STREAMLINE_STEP = "0.02"

/// A 3D vector field as dense short streamlines, the space counterpart of the
/// 2D line-integral convolution (render2d vfieldFrag): each seed integrates
/// the unit field forward and back in the vertex shader, and alpha carries
/// the same Hann window times a travelling wave, so dashes drift downstream.
/// One instanced LINE_STRIP per seed; vertex i is i − N steps from the seed.
func streamlineVert(_ comps: [String], _ params: [String]? = nil) -> String {
  """
  #version 300 es
  layout(location=0) in vec4 aSeed;
  uniform mat4 uVP;
  uniform float uBoxR;
  uniform vec3 uTarget;
  uniform vec3 uEye;
  uniform float t;
  \(paramDecls(params ?? []))
  out float vAlpha;
  \(glslPrelude)
  vec3 V(float x, float y, float z) { return vec3(\(comps[0]), \(comps[1]), \(comps[2])); }
  vec3 dir(vec3 q) {
    vec3 v = V(q.x, q.y, q.z);
    float m = length(v);
    return (isnan(m) || isinf(m) || m < 1e-24) ? vec3(0.0) : v / m;
  }
  const int N = \(STREAMLINE_STEPS);
  const float LAMBDA = 10.0; // wave length in steps
  const float OMEGA = 4.0;   // wave angular speed (rad/s), as in 2D
  void main() {
    int i = gl_VertexID - N;
    float h = uBoxR * \(STREAMLINE_STEP) * (i < 0 ? -1.0 : 1.0);
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

  """
}

let STREAMLINE_FRAG = """
  #version 300 es
  precision highp float;
  uniform vec3 uColor;
  in float vAlpha;
  out vec4 outColor;
  void main() {
    if (vAlpha < 0.01) discard;
    outColor = vec4(uColor, vAlpha);
  }

  """
