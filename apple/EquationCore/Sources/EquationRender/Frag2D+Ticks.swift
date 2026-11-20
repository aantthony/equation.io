import Foundation

// The grid lines of mapped axes: web/render2d.ts's tickFrag. The site's GLSL text, copied.

/// A mapped axis's lines in view, in screen units (lib/axis-ticks.ts).
public struct AxisTicks: Equatable, Codable, Sendable {
  /// Screen coordinates of the labelled lines, with their world values.
  public var major: [Major]
  /// Screen coordinates of the faint lines between them.
  public var minor: [Double]
  /// Screen coordinate where the world value is 0, when the map reaches it.
  public var zero: Double?

  public struct Major: Equatable, Codable, Sendable {
    public var at: Double
    public var value: Double

    public init(at: Double, value: Double) {
      self.at = at
      self.value = value
    }
  }

  public init(major: [Major] = [], minor: [Double] = [], zero: Double? = nil) {
    self.major = major
    self.minor = minor
    self.zero = zero
  }
}

/// Each mapped axis's ticks in view: what web/render2d.ts `mappedTicks`
/// answers. Until lib/axis-map.ts and lib/axis-ticks.ts are ported, a frame
/// is given these in place of the maps they come from.
public struct MappedTicks: Equatable, Codable, Sendable {
  public var x: AxisTicks?
  public var y: AxisTicks?

  public init(x: AxisTicks? = nil, y: AxisTicks? = nil) {
    self.x = x
    self.y = y
  }
}

/// Most lines a mapped axis draws (lib/axis-ticks.ts), per kind. Packed
/// four to a vec4, as the site packs them (WebGL2 promises only 224 uniform
/// vectors; here they are floats in a buffer either way). Multiples of 4.
let MAX_MAJOR_TICKS = 64
let MAX_MINOR_TICKS = 192

/// Grid lines of mapped axes at the screen coordinates their ticks chose,
/// blended over the grid pass: on `x = 10^X` the lines are not evenly
/// spaced, so they are a list rather than a level set. Each axis also draws
/// its zero line where the map reaches 0.
func tickFrag(_ axes: [String], theme: GraphTheme) -> String {
  let decls = axes.map { a in
    """
    uniform vec4 uMaj\(a)[\(MAX_MAJOR_TICKS / 4)];
    uniform int uNMaj\(a);
    uniform vec4 uMin\(a)[\(MAX_MINOR_TICKS / 4)];
    uniform int uNMin\(a);
    uniform float uZero\(a);
    uniform int uHasZero\(a);
    """
  }.joined(separator: "\n")
  let blocks = axes.map { a in
    let c = "p.\(a)"
    let px = "uUpp.\(a)"
    return """

        for (int i = 0; i < \(MAX_MINOR_TICKS); i++) {
          if (i >= uNMin\(a)) break;
          minorA = max(minorA, tickLine(abs(\(c) - uMin\(a)[i / 4][i % 4]) / \(px)));
        }
        for (int i = 0; i < \(MAX_MAJOR_TICKS); i++) {
          if (i >= uNMaj\(a)) break;
          majorA = max(majorA, tickLine(abs(\(c) - uMaj\(a)[i / 4][i % 4]) / \(px)));
        }
        if (uHasZero\(a) == 1) axisA = max(axisA, 1.0 - smoothstep(0.9, 1.9, abs(\(c) - uZero\(a)) / \(px)));
      """
  }.joined()
  return """
    #version 300 es
    precision highp float;
    uniform vec2 uCenter;
    uniform vec2 uUpp;
    uniform vec2 uRes;
    uniform vec2 uOrigin;
    \(decls)
    out vec4 outColor;
    float tickLine(float distPx) { return 1.0 - smoothstep(0.5, 1.5, distPx); }
    void main() {
      vec2 p = uCenter + (gl_FragCoord.xy - uOrigin - 0.5 * uRes) * uUpp;
      float minorA = 0.0;
      float majorA = 0.0;
      float axisA = 0.0;
    \(blocks)
      vec3 col = \(glslVec3(theme.gridMinor));
      float a = minorA;
      if (majorA > 0.0) { col = mix(col, \(glslVec3(theme.gridMajor)), majorA); a = max(a, majorA); }
      if (axisA > 0.0) { col = mix(col, \(glslVec3(theme.axis)), axisA); a = max(a, axisA); }
      if (a < 0.004) discard;
      outColor = vec4(col, a);
    }

    """
}
