import CoreGraphics
import Foundation
import Metal
import Testing

@testable import EquationRender

/// Scenes written out from the site's own plans (lib/compiler.ts `compileGpu`
/// for the rows named in each test), so the shaders are compiled with the
/// field strings the site gives them.
private func scene(_ name: String) throws -> Scene2D {
  let url = try #require(Bundle.module.url(forResource: name, withExtension: "json", subdirectory: "Scenes"))
  return try JSONDecoder().decode(Scene2D.self, from: Data(contentsOf: url))
}

private func bytes(_ metal: MetalContext, _ scene: Scene2D, dark: Bool = false) throws -> Data {
  let image = try #require(metal.image(of: scene, width: 240, height: 180, dpr: 1, theme: dark ? .dark : .light))
  return try #require(image.dataProvider?.data) as Data
}

/// The scene's layers one kind at a time: each with only that kind's items.
private func kinds(_ layers: Layers2D) throws -> [(name: String, layers: Layers2D)] {
  let all = try #require(try JSONSerialization.jsonObject(with: JSONEncoder().encode(layers)) as? [String: Any])
  return try all.keys.sorted().map { key in
    let only = try JSONSerialization.data(withJSONObject: [key: all[key]!])
    return (key, try JSONDecoder().decode(Layers2D.self, from: only))
  }
}

@Suite struct FieldScenes {
  /// Every layer of every scene compiles and changes the picture: drawn
  /// alone, it differs from the grid it is drawn over, in both themes.
  @Test(arguments: [
    "vector-field",  // (sin(y), sin(x))
    "jacobian-glyphs",  // jacobian((x^2 - y^2, 2 x y)/4)
    "hessian-streamlines",  // f(x, y) = x^3 - 3 x y^2; streamlines(hessian(f))
    "log-axis-jacobian",  // view(x = 0.1..1000, y = -3..3, x = 10^X); jacobian((x^2/100, y)); y = log(x)
    "dipole",  // ln(w-2) - ln(w+2)
    "domain-coloring",  // domain((w^3 - 1)/w)
    "joukowski",  // conformal(w + 1/w)
    "oklch-wheel",  // oklch(0.72, 0.16, arg(w)+t/3)
    "hsl-wheel",  // hsl(arg(w)+t/3, 1, 0.5)
    "rgb-field",  // rgb(sin(x-t)^2, sin(y-t)^2, sin(x+y+t)^2)
    "mandelbrot",  // view(x = -2.2..0.8, y = -1.3..1.3); iter(z^2 + w)
    "burning-ship",  // view(x = -2.4..1.7, y = -1.2..1.9); iter((|re(z)| - i |im(z)|)^2 + w)
    "rule-30",  // rule 30's first 81 rows, 121 cells wide; view(i = -60..60, n = 0..80)
  ])
  func eachLayerDraws(name: String) throws {
    let metal = try #require(MetalContext())
    let whole = try scene(name)
    let layers = try kinds(whole.layers)
    #expect(!layers.isEmpty)
    for dark in [false, true] {
      var empty = whole
      empty.layers = Layers2D()
      let grid = try bytes(metal, empty, dark: dark)
      for (kind, only) in layers {
        var one = whole
        one.layers = only
        #expect(try bytes(metal, one, dark: dark) != grid, "\(name): \(kind) drew nothing")
      }
    }
    // Nothing failed to compile on the way.
    #expect(metal.failures == 0)
  }

  /// A vector field's streaks drift with t; a tensor field's hold still.
  @Test func onlyTheVectorFieldMoves() throws {
    let metal = try #require(MetalContext())
    var flow = try scene("vector-field")
    var lines = try scene("hessian-streamlines")
    let (flow0, lines0) = (try bytes(metal, flow), try bytes(metal, lines))
    flow.time = 0.25
    lines.time = 0.25
    #expect(try bytes(metal, flow) != flow0)
    #expect(try bytes(metal, lines) == lines0)
  }

  /// A mapped axis is gridded at its ticks, in place of the even grid.
  @Test func mappedAxesAreGriddedAtTheirTicks() throws {
    let metal = try #require(MetalContext())
    var mapped = try scene("log-axis-jacobian")
    mapped.layers = Layers2D()
    #expect(mapped.frame?.ticks?.x != nil)
    var even = mapped
    even.frame?.ticks = nil
    var none = mapped
    none.frame?.ticks?.x = AxisTicks()
    let lines = try bytes(metal, mapped)
    #expect(lines != (try bytes(metal, even)))
    #expect(lines != (try bytes(metal, none)))
    #expect(metal.failures == 0)
  }

  /// A cell texture is uploaded once per shade buffer, and dropped at the
  /// end of the first frame that doesn't draw it.
  @Test func cellTexturesFollowTheirBuffers() throws {
    let metal = try #require(MetalContext())
    let cells = try #require(try scene("rule-30").layers.cells?.first)
    let textures = CellTextures()
    let first = try #require(textures.texture(cells, device: metal.device))
    #expect(first.pixelFormat == .r8Uint)
    #expect(first.width == cells.width && first.height == cells.rows)
    var recoloured = cells
    recoloured.color = [1, 0, 0]
    #expect(textures.texture(recoloured, device: metal.device) === first)
    textures.endFrame()
    #expect(textures.count == 1)

    // Another buffer of the same cells is another texture.
    var copy = cells
    copy.shades = CellShades(cells.shades.bytes)
    #expect(textures.texture(copy, device: metal.device) !== first)
    #expect(textures.count == 2)
    textures.endFrame()
    #expect(textures.count == 1)
    textures.endFrame()
    #expect(textures.count == 0)

    // Shades that are not width × rows cells are not drawn.
    copy.width += 1
    #expect(textures.texture(copy, device: metal.device) == nil)
  }
}
