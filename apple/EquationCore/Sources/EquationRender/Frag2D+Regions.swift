import EquationCore
import Foundation

// The shaders of web/render2d.ts that fill part of the plane: contour stacks
// (levelsFrag), scalar fields (scalarFrag), orbit diagrams (bifFrag),
// inequalities (ineqFrag) and families projected over an interval (projFrag).
// As in Frag2D.swift, each is the site's text with its holes filled the same
// way.

/// Whole-family level sets of one equation's field f(x,y): faint contours at
/// every multiple of uMinor, stronger at uMajor, in the equation's color. The
/// current level (f = c) stays the solid curve drawn by curveFrag on top.
func levelsFrag(glsl: String, gradGlsl: [String]? = nil, params: [String]) -> String {
  let grad = gradGlsl.map { "vec2 gradF(float x, float y) { return vec2(\($0[0]), \($0[1])); }\n" } ?? ""
  return """
    #version 300 es
    precision highp float;
    uniform vec2 uCenter;
    uniform vec2 uUpp;
    uniform vec2 uRes;
    uniform vec2 uOrigin;
    uniform vec3 uColor;
    uniform float uMajor;
    uniform float uMinor;
    uniform float t;
    \(paramDecls(params))
    out vec4 outColor;
    \(glslPrelude)
    float F(float x, float y) { return \(glsl); }
    \(grad)\(GRID_LINE_GLSL)
    void main() {
      vec2 p = uCenter + (gl_FragCoord.xy - uOrigin - 0.5 * uRes) * uUpp;
      float v = F(p.x, p.y);
      if (isnan(v) || isinf(v)) discard;
      float lg = \(gradGlsl != nil ? "length(gradF(p.x, p.y) * uUpp)" : "length(vec2(dFdx(v), dFdy(v)))");
      float a = max(gridLine(v, lg, uMinor, 0.5) * 0.18, gridLine(v, lg, uMajor, 0.5) * 0.45);
      if (a < 0.004) discard;
      outColor = vec4(uColor, a);
    }

    """
}

func levelsFrag(_ spec: LevelSpec) -> String {
  levelsFrag(glsl: spec.glsl, gradGlsl: spec.gradGlsl, params: spec.params)
}

func scalarFrag(_ field: String, params: [String]? = nil) -> String {
  """
  #version 300 es
  precision highp float;
  uniform vec2 uCenter;
  uniform vec2 uUpp;
  uniform vec2 uRes;
  uniform vec2 uOrigin;
  uniform vec3 uColor;
  uniform float uGain;
  uniform float t;
  \(paramDecls(params ?? []))
  out vec4 outColor;
  \(glslPrelude)
  float F(float x, float y) { return \(field); }
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

  """
}

func bifFrag(_ field: String, params: [String]? = nil) -> String {
  // Orbit diagram of the map a ← f(a, x): each pixel column fixes the
  // parameter x, iterates past the transient from the seed, then accumulates
  // how often the orbit lands within a pixel of this fragment's y. Stable
  // orbits saturate to solid branches; chaotic bands stay as light dust.
  """
  #version 300 es
  precision highp float;
  uniform vec2 uCenter;
  uniform vec2 uUpp;
  uniform vec2 uRes;
  uniform vec2 uOrigin;
  uniform vec3 uColor;
  uniform float t;
  uniform float uSeed;
  \(paramDecls(params ?? []))
  out vec4 outColor;
  \(glslPrelude)
  float f(float a, float x) { return \(field); }
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

  """
}

func ineqFrag(_ field: String, edges: [String], params: [String]? = nil) -> String {
  // Each non-strict comparison draws its boundary with the same two-scale
  // distance estimate as curveFrag, gated to the region's edge so a chain's
  // bound lines stop where the other comparisons cut them off.
  let edgeBlocks = edges.indices.map { i in
    """

      {
        float ev = E\(i)(p.x, p.y);
        if (!isnan(ev) && !isinf(ev) && v < 2.5 * aa) {
          vec2 g1 = vec2(E\(i)(p.x + h.x, p.y) - E\(i)(p.x - h.x, p.y),
                         E\(i)(p.x, p.y + h.y) - E\(i)(p.x, p.y - h.y)) / (2.0 * h);
          vec2 g2 = vec2(E\(i)(p.x + 0.5 * h.x, p.y) - E\(i)(p.x - 0.5 * h.x, p.y),
                         E\(i)(p.x, p.y + 0.5 * h.y) - E\(i)(p.x, p.y - 0.5 * h.y)) / h;
          float e1 = abs(ev) / max(length(g1 * h), 1e-24);
          float e2 = abs(ev) / max(length(g2 * h), 1e-24);
          if (!(isnan(e1) || isinf(e1) || isnan(e2) || isinf(e2))
            && !(e2 > 1.6 * e1 || e1 > 1.6 * e2)) {
            edge = max(edge, 1.0 - smoothstep(1.1, 2.1, max(e1, e2)));
          }
        }
      }
    """
  }.joined()
  return """
    #version 300 es
    precision highp float;
    uniform vec2 uCenter;
    uniform vec2 uUpp;
    uniform vec2 uRes;
    uniform vec2 uOrigin;
    uniform vec3 uColor;
    uniform float t;
    \(paramDecls(params ?? []))
    out vec4 outColor;
    \(glslPrelude)
    float F(float x, float y) { return \(field); }
    \(edges.enumerated().map { i, e in "float E\(i)(float x, float y) { return \(e); }" }.joined(separator: "\n"))
    void main() {
      vec2 p = uCenter + (gl_FragCoord.xy - uOrigin - 0.5 * uRes) * uUpp;
      float v = F(p.x, p.y);
      if (isnan(v) || isinf(v)) discard;
      float aa = max(fwidth(v), 1e-24);
      float fill = (1.0 - smoothstep(-aa, aa, v)) * 0.22;
      float edge = 0.0;
      vec2 h = uUpp;
    \(edgeBlocks)
      float alpha = max(fill, edge * 0.9);
      if (alpha < 0.004) discard;
      outColor = vec4(uColor, alpha);
    }

    """
}

/// Samples of u per pixel when a family over an interval is projected.
let PROJECTION_SAMPLES = 48
/// Sub-steps between two samples that a member could cross between.
let PROJECTION_REFINE = 8

/// The region a family over u ∈ [0, 1] sweeps: a pixel is kept when some u
/// satisfies the relation there, found by stepping u. For an equation that is
/// a sign change of F between neighbouring samples. Where F keeps its sign but
/// could still reach 0 between two samples at its slope ∂F/∂u (a member that
/// only grazes the pixel), that step is searched again finer — still for a
/// sign change, so a steep ∂F/∂u costs time, never extra fill. Outside, the
/// member nearest the pixel feathers the edge by its distance in pixels,
/// |F| / |∇F| (confirmed by a Newton step that crosses it), so the edge is an
/// antialiasing pixel wide at most and u never leaves [0, 1]. For inequalities,
/// the smallest max of the constraints below 0.
func projFrag(
  _ field: String, relation: Projected2D.Relation, slope: String? = nil, params: [String]? = nil
) -> String {
  let R = PROJECTION_REFINE
  let step =
    relation == .eq
    ? """

          float sl = \(slope != nil ? "abs(S(p.x, p.y, s))" : "2.0 * (had ? abs(f - prev) : 0.0)");
          if (abs(f) < near) {
            near = abs(f);
            best = s;
          }
          if (f == 0.0 || (had && prev * f <= 0.0)) inside = true;
          else if (had && !inside && min(abs(f), abs(prev)) <= 0.5 * max(sl, prevSl) * du) {
            float q = prev;
            for (int j = 1; j < \(R); j++) {
              float s2 = s - du + float(j) * (du / \(R).0);
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
          prevSl = sl;
      """
    : """

          near = min(near, f);
      """
  let cover =
    relation == .eq
    ? """

        float cover = 1.0;
        if (!inside) {
          // Distance in pixels to the nearest member, from its gradient on screen.
          vec2 h = uUpp;
          float f0 = F(p.x, p.y, best);
          vec2 g = 0.5 * vec2(F(p.x + h.x, p.y, best) - F(p.x - h.x, p.y, best),
                              F(p.x, p.y + h.y, best) - F(p.x, p.y - h.y, best));
          float g2 = dot(g, g);
          float dist = abs(f0) / sqrt(max(g2, 1e-30));
          // Near a fold of F the straight line misleads: step 1.5x toward the
          // member and keep the feather only if F changes sign there.
          vec2 q = p - 1.5 * f0 / max(g2, 1e-30) * g * h;
          float f1 = F(q.x, q.y, best);
          cover = dist < 1.0 && f0 * f1 <= 0.0 ? 1.0 - dist : 0.0;
        }
      """
    : """

        float aa = max(fwidth(near), 1e-24);
        float cover = 1.0 - smoothstep(-aa, aa, near);
      """
  return """
    #version 300 es
    precision highp float;
    uniform vec2 uCenter;
    uniform vec2 uUpp;
    uniform vec2 uRes;
    uniform vec2 uOrigin;
    uniform vec3 uColor;
    uniform float t;
    \(paramDecls(params ?? []))
    out vec4 outColor;
    \(glslPrelude)
    float F(float x, float y, float u) { return \(field); }
    \(slope.map { "float S(float x, float y, float u) { return \($0); }" } ?? "")
    void main() {
      vec2 p = uCenter + (gl_FragCoord.xy - uOrigin - 0.5 * uRes) * uUpp;
      const float du = 1.0 / float(\(PROJECTION_SAMPLES - 1));
      bool inside = false;
      float near = 1e30;
      float best = 0.0;
      float prev = 0.0;
      float prevSl = 0.0;
      bool had = false;
      for (int k = 0; k < \(PROJECTION_SAMPLES); k++) {
        float s = float(k) * du;
        float f = F(p.x, p.y, s);
        if (isnan(f) || isinf(f)) {
          had = false;
          continue;
        }\(step)
        prev = f;
        had = true;
      }\(cover)
      float alpha = cover * 0.22;
      if (alpha < 0.004) discard;
      outColor = vec4(uColor, alpha);
    }

    """
}
