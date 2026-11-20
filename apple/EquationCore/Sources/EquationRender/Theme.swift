import Foundation
import simd

public typealias RGB = SIMD3<Float>

/// The colors a graph is drawn in (web/theme.ts, lib/palette.ts). As on the
/// site, the shader passes bake them into their source, so switching theme
/// compiles a differently-colored variant.
public struct GraphTheme: Equatable, Sendable {
  public var dark: Bool
  /// Canvas background.
  public var bg: RGB
  /// 2D minor / major grid line colors and the axis line color.
  public var gridMinor: RGB
  public var gridMajor: RGB
  public var axis: RGB
  /// 3D reference-plane grid line color, and how strongly its lines and axes are drawn.
  public var plane: RGB
  public var planeGrid: Float
  /// Overlay: axis numerals and labels.
  public var label: RGB
  /// Overlay: the stroke around plotted points.
  public var pointOutline: RGB
  /// Row colors, in the order a document's rows take them.
  public var palette: [RGB]

  public static let light = GraphTheme(
    dark: false,
    bg: [1, 1, 1],
    gridMinor: [0.91, 0.91, 0.91],
    gridMajor: [0.8, 0.8, 0.8],
    axis: [0.25, 0.25, 0.25],
    plane: [0.25, 0.25, 0.25],
    planeGrid: 0.5,
    label: hex(0x555555),
    pointOutline: hex(0xffffff),
    palette: [
      [0.176, 0.439, 0.702],  // blue
      [0.78, 0.267, 0.251],  // red
      [0.22, 0.549, 0.275],  // green
      [0.376, 0.259, 0.651],  // purple
      [0.98, 0.494, 0.098],  // orange
      [0.0, 0.0, 0.0],  // black
    ])

  public static let dark = GraphTheme(
    dark: true,
    bg: [0.09, 0.1, 0.12],
    gridMinor: [0.19, 0.2, 0.23],
    gridMajor: [0.3, 0.31, 0.35],
    axis: [0.55, 0.56, 0.6],
    plane: [0.55, 0.56, 0.6],
    planeGrid: 1,
    label: hex(0x8b909a),
    pointOutline: hex(0x16181d),
    palette: [
      [0.4, 0.62, 0.92],  // blue
      [0.92, 0.45, 0.42],  // red
      [0.42, 0.78, 0.48],  // green
      [0.65, 0.52, 0.95],  // purple
      [0.98, 0.62, 0.28],  // orange
      [0.9, 0.91, 0.93],  // light (stands in for black)
    ])

  private static func hex(_ value: Int) -> RGB {
    RGB(Float((value >> 16) & 0xff), Float((value >> 8) & 0xff), Float(value & 0xff)) / 255
  }
}

/// A `vec3(r, g, b)` GLSL literal, for baking a color into shader source (web/theme.ts `glslVec3`).
func glslVec3(_ c: RGB) -> String {
  String(format: "vec3(%.4f, %.4f, %.4f)", c.x, c.y, c.z)
}
