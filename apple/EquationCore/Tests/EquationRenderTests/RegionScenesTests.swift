import CoreGraphics
import Foundation
import Metal
import Testing

@testable import EquationCore
@testable import EquationRender

/// The layers that fill part of the plane (Frag2D+Regions.swift), drawn from
/// scenes written down as the site builds them: Scenes/*.json hold the fields
/// lib/compiler.ts emits for a row, in the layers web/main.ts puts them in.
@Suite struct RegionScenes {
  static let scenes = [
    "ineq-band",  // -1 <= y - sin(x) < 1
    "ineq-annulus",  // 1 < x^2 + y^2 < 4
    "ineq-param",  // a = 0.5; y <= a x^2
    "scalar",  // sin(x) + cos(y)
    "levels-xy",  // c = 1; x y = c, with all levels shown
    "bif",  // a_{n+1} = x a_n (1 - a_n)
    "proj-eq",  // a = interval(1, 2); y = sin(a x)
    "proj-noslope",  // a = interval(0, 3); y = floor(x + a) / 2
    "proj-ineq-param",  // a = interval(0, 3); b = 1; x^2 + y^2 < b a
  ]

  static func scene(_ name: String) throws -> Scene2D {
    let url = try #require(Bundle.module.url(forResource: name, withExtension: "json", subdirectory: "Scenes"))
    return try JSONDecoder().decode(Scene2D.self, from: Data(contentsOf: url))
  }

  /// Every shader a scene's layers of these kinds draw with.
  static func fragments(_ layers: Layers2D) -> [String] {
    (layers.levels ?? []).map { levelsFrag($0) }
      + (layers.ineqs ?? []).map { ineqFrag($0.field, edges: $0.edges, params: $0.params) }
      + (layers.projections ?? []).map {
        projFrag($0.field, relation: $0.relation, slope: $0.slope, params: $0.params)
      }
      + (layers.bifs ?? []).map { bifFrag($0.field, params: $0.params) }
      + (layers.scalars ?? []).map { scalarFrag($0.field, params: $0.params) }
  }

  /// A scene's picture, 320 × 240 with the opening window (so 20 pixels to a
  /// unit), without the grid: sRGB RGBA bytes, rows from the top.
  static func draw(_ scene: Scene2D, _ metal: MetalContext, theme: GraphTheme = .light) throws -> [UInt8] {
    var scene = scene
    scene.frame = Frame2D(grid: .off)
    let image = try #require(metal.image(of: scene, width: 320, height: 240, dpr: 1, theme: theme))
    var bytes = [UInt8](repeating: 0, count: 320 * 240 * 4)
    bytes.withUnsafeMutableBytes { raw in
      let ctx = CGContext(
        data: raw.baseAddress, width: 320, height: 240, bitsPerComponent: 8, bytesPerRow: 320 * 4,
        space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
      ctx.draw(image, in: CGRect(x: 0, y: 0, width: 320, height: 240))
    }
    return bytes
  }

  /// The color drawn at a point of the plane, in the picture `draw` makes.
  static func color(_ bytes: [UInt8], at x: Double, _ y: Double) -> SIMD3<Int> {
    let i = (Int(120 - y * 20) * 320 + Int(160 + x * 20)) * 4
    return SIMD3(Int(bytes[i]), Int(bytes[i + 1]), Int(bytes[i + 2]))
  }

  /// Pixels that aren't the background's color.
  static func drawn(_ bytes: [UInt8], theme: GraphTheme = .light) -> Int {
    let bg = SIMD3<Int>(theme.bg * 255)
    return stride(from: 0, to: bytes.count, by: 4).count { i in
      let d = SIMD3(Int(bytes[i]), Int(bytes[i + 1]), Int(bytes[i + 2])) &- bg
      return max(abs(d.x), abs(d.y), abs(d.z)) > 4
    }
  }

  @Test(arguments: scenes) func compilesAndDraws(_ name: String) throws {
    let metal = try #require(MetalContext())
    let scene = try Self.scene(name)
    let fragments = Self.fragments(scene.layers)
    #expect(!fragments.isEmpty)
    for fragment in fragments {
      _ = try metal.makeLibrary(translateFragment(fragment).source)
    }
    for theme in [GraphTheme.light, .dark] {
      #expect(try Self.drawn(Self.draw(scene, metal, theme: theme), theme: theme) > 200, "\(name) drew nothing")
    }
  }

  /// A contour stack with no gradient given measures its lines by screen derivatives.
  @Test func levelsWithoutAGradient() throws {
    let metal = try #require(MetalContext())
    let level = LevelSpec(glsl: "(x * y)", major: 5, minor: 1, color: [0, 0, 0])
    _ = try metal.makeLibrary(translateFragment(levelsFrag(level)).source)
    #expect(try Self.drawn(Self.draw(Scene2D(layers: Layers2D(levels: [level])), metal)) > 200)
  }

  /// The annulus is filled between its circles and nowhere else, at the fill's strength.
  @Test func anInequalityFillsItsRegion() throws {
    let metal = try #require(MetalContext())
    let bytes = try Self.draw(Self.scene("ineq-annulus"), metal)
    let white = SIMD3<Int>(255, 255, 255)
    #expect(Self.color(bytes, at: 0.2, 0.2) == white)
    #expect(Self.color(bytes, at: 2.5, 2.5) == white)
    // 22% of the row's blue over white.
    let fill = Self.color(bytes, at: 1.1, 1.1)
    #expect(abs(fill.x - 209) <= 2 && abs(fill.y - 224) <= 2 && abs(fill.z - 238) <= 2)
    // Above the x axis as well as below it: the picture is the right way up.
    let band = try Self.draw(Self.scene("ineq-band"), metal)
    #expect(Self.color(band, at: 1.5, 1.5) != white)
    #expect(Self.color(band, at: 1.5, -1.5) == white)
  }

  /// A scalar field is shaded toward the row's color where it is positive
  /// and toward the complement where it is negative, by tanh(gain · F).
  @Test func aScalarFieldIsShadedBySignAndGain() throws {
    let metal = try #require(MetalContext())
    func shade(gain: Double?, at x: Double) throws -> SIMD3<Int> {
      let field = Scalar2D(field: "(u_a * x)", color: [1, 0, 0], params: ["a"], gain: gain)
      let scene = Scene2D(layers: Layers2D(scalars: [field]), env: ["a": 1])
      return try Self.color(Self.draw(scene, metal), at: x, 0.5)
    }
    // Red over white keeps its red and loses green and blue; cyan, the other way.
    let positive = try shade(gain: nil, at: 1)
    let negative = try shade(gain: nil, at: -1)
    #expect(positive.x == 255 && positive.y < 215)
    #expect(negative.x < 215 && negative.y == 255)
    // A larger gain shades the same value more strongly.
    #expect(try shade(gain: 3, at: 1).y < positive.y - 20)
  }

  /// The orbit diagram reads its seed: from 0 the logistic map stays at 0,
  /// from 0.5 it settles on the branch 1 - 1/x.
  @Test func theOrbitDiagramStartsFromItsSeed() throws {
    let metal = try #require(MetalContext())
    var scene = try Self.scene("bif")
    let white = SIMD3<Int>(255, 255, 255)
    // At x = 2 the orbit is at 1 - 1/2.
    #expect(try Self.color(Self.draw(scene, metal), at: 2, 0.5) != white)
    scene.layers.bifs?[0].uniforms = ["uSeed": 0]
    let fromZero = try Self.draw(scene, metal)
    #expect(Self.color(fromZero, at: 2, 0.5) == white)
    #expect(Self.color(fromZero, at: 2, 0.01) != white)
  }
}
