import EquationCore
import Foundation

// Colour fields: web/color-field.ts, and colorFrag of web/render2d.ts. The site's GLSL text, copied.

/// The space a colour field's channels are in (lib/math-object.ts `ColorSpace`).
public enum ColorSpace: String, Codable, Sendable {
  case rgb, hsl, oklch
}

/// A colour for every pixel: `field` is a vec4 of the three channels and alpha.
public struct ColorField2D: Equatable, Codable, Sendable {
  public var field: String
  public var color: RGB
  public var params: [String]?
  public var uniforms: [String: Double]?
  public var space: ColorSpace
  /// Shared per-pixel calculations, evaluated before the vec3 field.
  public var locals: String

  public init(
    field: String, color: RGB, params: [String]? = nil, uniforms: [String: Double]? = nil, space: ColorSpace,
    locals: String
  ) {
    self.field = field
    self.color = color
    self.params = params
    self.uniforms = uniforms
    self.space = space
    self.locals = locals
  }
}

/// Convert channel values to encoded sRGB, the canvas's output color space.
/// RGB convention: 0–1 channels.
/// HSL convention: hue in radians, 0–1 saturation, 0–1 lightness.
/// OKLCH convention: 0–1 lightness, nonnegative chroma, hue in radians.
/// Every channel is a unit interval except hue (radians, like trig, arg and
/// angle) and chroma. This is a math tool, not CSS: no 0–255 or percent scales.
/// Sources: https://www.w3.org/TR/css-color-4/#hsl-to-rgb and the public-domain
/// Oklab matrices at https://bottosson.github.io/posts/oklab/ .
func colorConversionGLSL(_ space: ColorSpace) -> String {
  switch space {
  case .rgb:
    return """

      vec3 eqColorToSRGB(vec3 c) { return clamp(c, 0.0, 1.0); }

      """
  case .hsl:
    return """

      vec3 eqColorToSRGB(vec3 c) {
        float h = mod(c.x * (6.0 / 3.141592653589793), 12.0);
        float s = clamp(c.y, 0.0, 1.0);
        float l = clamp(c.z, 0.0, 1.0);
        vec3 k = mod(h + vec3(0.0, 8.0, 4.0), 12.0);
        vec3 wave = clamp(min(k - 3.0, 9.0 - k), -1.0, 1.0);
        return clamp(l - s * min(l, 1.0 - l) * wave, 0.0, 1.0);
      }

      """
  case .oklch:
    return """

      vec3 eqOklabToLinear(float lightness, vec2 ab) {
        vec3 lms = vec3(
          lightness + dot(ab, vec2(0.3963377774, 0.2158037573)),
          lightness + dot(ab, vec2(-0.1055613458, -0.0638541728)),
          lightness + dot(ab, vec2(-0.0894841775, -1.2914855480)));
        lms = lms * lms * lms;
        return vec3(
          dot(lms, vec3(4.0767416621, -3.3077115913, 0.2309699292)),
          dot(lms, vec3(-1.2684380046, 2.6097574011, -0.3413193965)),
          dot(lms, vec3(-0.0041960863, -0.7034186147, 1.7076147010)));
      }
      bool eqInSRGB(vec3 c) {
        // Roundoff at a primary must not start gamut reduction: GLSL's sin, cos and
        // the cubic matrix conversion drift well past float32 epsilon on some GPUs,
        // and the blue boundary has a narrow cusp at fixed L and hue. 1e-4 linear
        // is under a third of an 8-bit step even on the steep dark end of sRGB.
        return all(greaterThanEqual(c, vec3(-0.0001))) && all(lessThanEqual(c, vec3(1.0001)));
      }
      vec3 eqColorToSRGB(vec3 c) {
        float l = clamp(c.x, 0.0, 1.0);
        if (l <= 0.0) return vec3(0.0);
        if (l >= 1.0) return vec3(1.0);
        float h = mod(c.z, 6.283185307179586);
        vec2 direction = vec2(cos(h), sin(h));
        // sRGB's maximum Oklab chroma is below 1; bounding the search also keeps
        // arbitrary finite inputs from overflowing the cubic matrix conversion.
        float chroma = clamp(c.y, 0.0, 1.0);
        vec3 linear = eqOklabToLinear(l, chroma * direction);
        if (!eqInSRGB(linear)) {
          // Strict chroma reduction at fixed L and hue (not CSS's local-MINDE
          // algorithm). Fourteen bisections give chroma precision better than 1e-4.
          float lo = 0.0, hi = chroma;
          for (int k = 0; k < 14; k++) {
            float mid = (lo + hi) * 0.5;
            if (eqInSRGB(eqOklabToLinear(l, mid * direction))) lo = mid;
            else hi = mid;
          }
          linear = eqOklabToLinear(l, lo * direction);
        }
        linear = clamp(linear, 0.0, 1.0);
        return mix(12.92 * linear, 1.055 * pow(linear, vec3(1.0 / 2.4)) - 0.055,
          step(vec3(0.0031308), linear));
      }

      """
  }
}

func colorFrag(_ field: String, params: [String]?, locals: String, space: ColorSpace) -> String {
  """
    #version 300 es
    precision highp float;
    uniform vec2 uCenter;
    uniform vec2 uUpp;
    uniform vec2 uRes;
    uniform vec2 uOrigin;
    uniform float t;
    \(paramDecls(params ?? []))
    out vec4 outColor;
    \(glslPrelude)
    \(colorConversionGLSL(space))
    vec4 F(float x, float y) {
    \(locals)
    return \(field);
    }
    void main() {
      vec2 p = uCenter + (gl_FragCoord.xy - uOrigin - 0.5 * uRes) * uUpp;
      vec4 channels = F(p.x, p.y);
      if (any(isnan(channels)) || any(isinf(channels))) discard;
      float a = clamp(channels.w, 0.0, 1.0);
      if (a < 0.004) discard;
      outColor = vec4(eqColorToSRGB(channels.xyz), a);
    }

    """
}
