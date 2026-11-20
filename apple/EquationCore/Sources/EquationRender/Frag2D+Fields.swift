import EquationCore
import Foundation

// web/render2d.ts's vector and matrix field shaders, as Frag2D.swift keeps the grid's and the curve's: the
// site's GLSL text, copied.

/// A vector field: its line integral convolution is drawn, drifting the way the field points.
public struct VField2D: Equatable, Codable, Sendable {
  public var uniforms: [String: Double]?
  /// GLSL expressions for the components (Vx, Vy) in terms of floats x, y.
  public var fx: String
  public var fy: String
  public var color: RGB
  public var params: [String]?

  public init(
    uniforms: [String: Double]? = nil, fx: String, fy: String, color: RGB, params: [String]? = nil
  ) {
    self.uniforms = uniforms
    self.fx = fx
    self.fy = fy
    self.color = color
    self.params = params
  }
}

/// A 2×2 matrix field: GLSL for its entries, row-major, in floats x, y.
public struct TField2D: Equatable, Codable, Sendable {
  public var uniforms: [String: Double]?
  /// Four entries: m00, m01, m10, m11.
  public var entries: [String]
  public var color: RGB
  public var params: [String]?
  /// Streamlines of the major eigenvector (tlinesFrag) instead of glyphs.
  public var streamlines: Bool?
  /// On mapped axes, GLSL for the maps' Jacobian ∂(x, y)/∂(X, Y), row-major,
  /// with the entries read at the screen point (lib/math-object.ts
  /// tensor-field).
  public var jacobian: [String]?

  public init(
    uniforms: [String: Double]? = nil, entries: [String], color: RGB, params: [String]? = nil,
    streamlines: Bool? = nil, jacobian: [String]? = nil
  ) {
    self.uniforms = uniforms
    self.entries = entries
    self.color = color
    self.params = params
    self.streamlines = streamlines
    self.jacobian = jacobian
  }
}

/// The tensor shaders' J(x, y): the axis maps' Jacobian, or none.
private func jacobianGLSL(_ j: [String]?) -> String {
  "mat2 J(float x, float y) { return \(j.map { "mat2(\($0[0]), \($0[2]), \($0[1]), \($0[3]))" } ?? "mat2(1.0)"); }"
}

func vfieldFrag(_ fx: String, _ fy: String, params: [String]? = nil) -> String {
  """
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
    vec2 V(float x, float y) { return vec2(\(fx), \(fy)); }

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

    """
}

/// A matrix field as a grid of glyphs: in each cell, the image of a circle
/// under M at the cell's centre, lightly filled, with a spoke to M e_x so a
/// turn or a reflection shows (a circle's image alone cannot). Cells are
/// anchored in the plane — a power-of-two size near CELL pixels — so panning
/// moves the glyphs with it. The glyph scale is lib/glyphs.ts glyphScale:
/// tanh(σ₁)/σ₁, true size while small, a cell at most. An orientation-
/// reversing matrix (det < 0) draws in the complement of the row colour.
/// Distances are taken in pixel space, where the ring is {A w : |w| = 1}
/// and |adj(A) q| − |det A| vanishes on it, so even a singular M (a segment)
/// draws.
func tfieldFrag(_ entries: [String], params: [String]? = nil, jacobian: [String]? = nil) -> String {
  """
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
    \(jacobianGLSL(jacobian))
    mat2 M(float x, float y) {
      // Column-major: mat2(m00, m10, m01, m11). On mapped axes, the same map in
      // screen coordinates: J⁻¹ M J, J the maps' Jacobian.
      mat2 j = J(x, y);
      return inverse(j) * mat2(\(entries[0]), \(entries[2]), \(entries[1]), \(entries[3])) * j;
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

    """
}

/// A matrix field as tensor streamlines: line integral convolution, as in
/// vfieldFrag, along the major eigenvector of the symmetric part of M (lib/
/// glyphs.ts majorAngle). An eigenvector has no sign, so the field is a line
/// field: each step takes whichever of ±e continues the previous one, and
/// with no direction to drift in, the texture holds still. Streaks fade
/// where they are cut short — at the degenerate points where S is isotropic
/// and the direction is undefined, and at the domain's edge. As with the
/// glyphs, det M < 0 draws in the complement of the row colour.
func tlinesFrag(_ entries: [String], params: [String]? = nil, jacobian: [String]? = nil) -> String {
  """
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
    // Row-major ((a, b), (c, d)) as a vec4.
    vec4 M(float x, float y) { return vec4(\(entries[0]), \(entries[1]), \(entries[2]), \(entries[3])); }
    \(jacobianGLSL(jacobian))

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

    """
}
