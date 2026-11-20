import EquationCore
import Foundation

// The 2D fragment shaders of web/render2d.ts, kept as the site writes them:
// each function here is the function of the same name there, its GLSL text
// copied and its ${…} holes filled the same way. GLSL.swift compiles them as
// Metal. Keep them in step with the site by copying, not by rewriting.
//
// The grid and the curve are here; the other layers' shaders are in the
// Frag2D+….swift files beside this one.

func paramDecls(_ params: [String] = []) -> String {
  params.map { "uniform float \(uniformName($0));" }.joined(separator: "\n")
}

/// Antialiased line at every multiple of `spacing` of a field value c, with
/// width from the distance estimate |c - k·s| / |∇c|, fading out where lines
/// crowd toward subpixel spacing (singularities, extreme zoom).
let GRID_LINE_GLSL = """

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

  """

private nonisolated(unsafe) let numberLiteral = try! Regex(#"^\(?-?\d+(\.\d*)?(e[-+]?\d+)?\)?$"#)

/// A constant gradient — x and y, a lattice's x + 1/2 — is a linear field,
/// whose distance estimate to a level is exact.
private func linear(_ s: GridSpec) -> Bool {
  guard let grad = s.gradGlsl else { return false }
  return grad.allSatisfy { $0.trimmingCharacters(in: .whitespaces).wholeMatch(of: numberLiteral) != nil }
}

/// Whether the level c = L of family k really passes near p, and not only by
/// the distance estimate |c - L| / |∇c| (see web/render2d.ts `reachesGlsl`
/// for the cases it tells apart).
private func reachesGlsl(_ k: Int) -> String {
  """
  vec2 probe\(k)(vec2 p, vec2 g) {
    float m = max(abs(g.x), abs(g.y));
    vec2 u = m > 0.0 && !isinf(m) ? normalize(g / m) : vec2(1.0, 0.0);
    vec2 d = 4.0 * min(uUpp.x, uUpp.y) * u;
    return vec2(coord\(k)(p.x + d.x, p.y + d.y), coord\(k)(p.x - d.x, p.y - d.y));
  }
  bool reaches\(k)(vec2 p, float c, vec2 g, float L, vec2 pr) {
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
      float r = (coord\(k)(q.x, q.y) - L) / (c - L);
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

  """
}

/// The grid is itself a field renderer: each family draws the level sets
/// c = k·spacing via gridLine. The Cartesian grid is the identity pair (x, y).
func gridFrag(_ specs: [GridSpec], axesOnly: Bool = false, theme: GraphTheme) -> String {
  var params: [String] = []
  for p in specs.flatMap(\.params) where !params.contains(p) { params.append(p) }
  let decls = specs.enumerated().map { k, s in
    let grad =
      s.gradGlsl.map { "vec2 grad\(k)(float x, float y) { return vec2(\($0[0]), \($0[1])); }\n" } ?? ""
    return "float coord\(k)(float x, float y) { return \(s.glsl); }\n\(grad)"
      + "uniform float uMajor\(k);\nuniform float uMinor\(k);\n" + (linear(s) ? "" : reachesGlsl(k))
  }.joined()
  let blocks = specs.enumerated().map { k, s in
    // One check, inlined once: at the nearest minor level when a line is
    // near (a major level is one), else at 0 for the axis. An axis beside a
    // line at another level — lines crowded to a pixel or two — is left as
    // the estimate has it.
    let check =
      linear(s)
      ? ""
      : """
              bool lines = max(minor, major) > 0.0;
              float L = lines ? round(c / uMinor\(k)) * uMinor\(k) : 0.0;
              if ((lines || axis > 0.0) && !reaches\(k)(p, c, g, L, probe\(k)(p, g))) {
                minor = 0.0; major = 0.0;
                if (L == 0.0) axis = 0.0;
              }

        """
    return """

        {
          float c = coord\(k)(p.x, p.y);
          if (!isnan(c) && !isinf(c)) {
            vec2 g = \(s.gradGlsl != nil ? "grad\(k)(p.x, p.y)" : "vec2(dFdx(c), dFdy(c)) / uUpp");
            float lg = length(g * uUpp);
            float minor = \(axesOnly ? "0.0" : "gridLine(c, lg, uMinor\(k), 0.5)");
            float major = \(axesOnly ? "0.0" : "gridLine(c, lg, uMajor\(k), 0.5)");
            float axis = 1.0 - smoothstep(0.9, 1.9, abs(c) / max(lg, 1e-24));
      \(check)      minorA = max(minorA, minor);
            majorA = max(majorA, major);
            axisA = max(axisA, axis);
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
    uniform float t;
    \(paramDecls(params))
    out vec4 outColor;
    \(glslPrelude)
    \(decls)
    \(GRID_LINE_GLSL)
    void main() {
      vec2 p = uCenter + (gl_FragCoord.xy - uOrigin - 0.5 * uRes) * uUpp;
      vec3 col = \(glslVec3(theme.bg));
      float minorA = 0.0;
      float majorA = 0.0;
      float axisA = 0.0;
    \(blocks)
      col = mix(col, \(glslVec3(theme.gridMinor)), minorA);
      col = mix(col, \(glslVec3(theme.gridMajor)), majorA);
      col = mix(col, \(glslVec3(theme.axis)), axisA);
      outColor = vec4(col, 1.0);
    }

    """
}

/// Pixels within this distance of a curve are drawn (smoothstep's upper edge below).
let CURVE_REACH_PX = "2.1"

func curveFrag(_ field: String, params: [String]? = nil, graphEval: Curve2D.GraphEval? = nil) -> String {
  let estimate =
    graphEval.map { graph in
      """

        vec4 signal = G(p.x, \(CURVE_REACH_PX) * uUpp.x);
        float v = p.y - signal.x;
        if (isnan(v) || isinf(v)) discard;
        vec2 gradient = vec2(-signal.y * \(graph.slopeScale), 1.0) * uUpp;
        float distPx = abs(v) / max(length(gradient), 1e-24);
        if (isnan(distPx) || isinf(distPx)) discard;
        // The slope's estimate trusts one slope across the pixel's reach, which
        // harmonics too fast to resolve at this zoom break: zoomed out, their
        // steep slope would put far pixels on the curve. Within the reach the
        // curve stays in [signal.z, signal.w], so a pixel outside that band is at
        // least that far away.
        distPx = max(distPx, max(signal.z - p.y, p.y - signal.w) / uUpp.y);

      """
    }
    ?? """

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
    float F(float x, float y) { return \(field); }
    \(graphEval.map { "vec4 G(float x, float reach) { return \($0.glsl); }" } ?? "")
    void main() {
      vec2 p = uCenter + (gl_FragCoord.xy - uOrigin - 0.5 * uRes) * uUpp;
    \(estimate)
      float alpha = 1.0 - smoothstep(1.1, \(CURVE_REACH_PX), distPx);
      if (alpha <= 0.0) discard;
      outColor = vec4(uColor, alpha);
    }

    """
}
