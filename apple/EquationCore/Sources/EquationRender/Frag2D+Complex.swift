import EquationCore
import Foundation

// web/render2d.ts's shaders for complex functions: a potential's field lines, domain colouring, the
// pulled-back grid of a conformal map, and escape-time fractals. The site's GLSL text, copied.

/// An escape-time fractal: zc ← step(zc), counted until it leaves.
public struct Fractal2D: Equatable, Codable, Sendable {
  public var uniforms: [String: Double]?
  /// GLSL vec2 expression for one iteration step, in terms of vec2 zc and floats x, y.
  public var step: String
  public var seed: Seed
  public var maxIter: Int
  public var color: RGB
  public var params: [String]?

  public enum Seed: String, Codable, Sendable {
    case pixel, zero
  }

  public init(
    uniforms: [String: Double]? = nil, step: String, seed: Seed, maxIter: Int, color: RGB, params: [String]? = nil
  ) {
    self.uniforms = uniforms
    self.step = step
    self.seed = seed
    self.maxIter = maxIter
    self.color = color
    self.params = params
  }
}

func complexFrag(_ field: String, params: [String]? = nil) -> String {
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
    vec2 F(float x, float y) { return \(field); }

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
      const float S = \(String(format: "%.8f", Double.pi / 8));
      float fieldLines = contour(f.y, S);   // im = field lines
      float equipot = contour(f.x, S);      // re = equipotentials
      float a = max(fieldLines, equipot * 0.65);
      if (a < 0.01) discard;
      outColor = vec4(uColor, a);
    }

    """
}

func domainFrag(_ field: String, params: [String]? = nil) -> String {
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
    vec2 F(float x, float y) { return \(field); }
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

    """
}

func conformalFrag(_ field: String, params: [String]? = nil) -> String {
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
    vec2 F(float x, float y) { return \(field); }

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

    """
}

func fractalFrag(_ step: String, seed: Fractal2D.Seed, maxIter: Int, params: [String]? = nil) -> String {
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
    vec2 stepFn(vec2 zc, float x, float y) { return \(step); }
    void main() {
      vec2 p = uCenter + (gl_FragCoord.xy - uOrigin - 0.5 * uRes) * uUpp;
      vec2 zc = \(seed == .pixel ? "p" : "vec2(0.0)");
      float mu = -1.0;
      float m2 = dot(zc, zc);
      for (int k = 0; k < \(maxIter); k++) {
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
      float s = max(mu - log2(13.8155 / log(lp)) - \(seed == .zero ? "1.0" : "0.0"), 0.0);
      float aBase = 1.0 - exp(-0.18 * s * s);
      float a = aBase * (0.75 + 0.25 * cos(0.45 * mu));
      vec3 col = uColor * (0.72 + 0.28 * cos(0.16 * mu + vec3(0.0, 0.9, 1.8)));
      if (a < 0.004) discard;
      outColor = vec4(col, clamp(a, 0.0, 1.0));
    }

    """
}
