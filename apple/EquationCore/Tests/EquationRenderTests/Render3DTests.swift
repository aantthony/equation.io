import CoreGraphics
import Foundation
import Metal
import Testing

@testable import EquationCore
@testable import EquationRender

/// A scene of the fixtures in Scenes/3D: what apple/tools/scene3d.ts writes for
/// some rows, so the shader strings and geometry are the site's own.
private func fixture(_ name: String) throws -> Graph3D {
  let url = try #require(Bundle.module.url(forResource: name, withExtension: "json", subdirectory: "Scenes/3D"))
  return try Graph3D.decode(Data(contentsOf: url))
}

/// An image's pixels as RGBA bytes.
private func bytes(_ image: CGImage) -> [UInt8] {
  var bytes = [UInt8](repeating: 0, count: image.width * image.height * 4)
  bytes.withUnsafeMutableBytes { raw in
    let ctx = CGContext(
      data: raw.baseAddress, width: image.width, height: image.height, bitsPerComponent: 8,
      bytesPerRow: image.width * 4, space: CGColorSpace(name: CGColorSpace.sRGB)!,
      bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
    ctx.draw(image, in: CGRect(x: 0, y: 0, width: image.width, height: image.height))
  }
  return bytes
}

/// The share of pixels two images of one size differ in, by more than a few levels.
private func difference(_ a: CGImage, _ b: CGImage) -> Double {
  let (pa, pb) = (bytes(a), bytes(b))
  var differing = 0
  for i in stride(from: 0, to: pa.count, by: 4) {
    if (0..<3).contains(where: { abs(Int(pa[i + $0]) - Int(pb[i + $0])) > 8 }) { differing += 1 }
  }
  return Double(differing) / Double(pa.count / 4)
}

@Suite struct Render3D {
  /// Each fixture compiles every shader it asks for, and draws something
  /// over the empty scene's axes and grid, in both themes.
  @Test(arguments: ["surfaces", "torus", "figures", "cloud", "flow", "globe"])
  func sceneDraws(_ name: String) throws {
    let metal = try #require(MetalContext())
    let graph = try fixture(name)
    let renderer = Renderer3D(metal)
    for theme in [GraphTheme.light, .dark] {
      let image = try #require(
        metal.image(of: graph, width: 320, height: 240, dpr: 1, theme: theme, renderer: renderer))
      let empty = try #require(
        metal.image(of: Graph3D(camera: graph.camera), width: 320, height: 240, dpr: 1, theme: theme))
      #expect(renderer.failures == 0)
      #expect(difference(image, empty) > 0.02)
      // At rest, with nothing left to refine.
      #expect(renderer.refineIn() == nil)
    }
  }

  /// Every layer a scene can hold is in some fixture, so `sceneDraws` compiles every shader.
  @Test func fixturesCoverTheLayers() throws {
    let scenes = try ["surfaces", "torus", "figures", "cloud", "flow", "globe"].map { try fixture($0).scene }
    #expect(scenes.contains { !$0.implicits.isEmpty })
    #expect(scenes.contains { !$0.psurfaces.isEmpty })
    #expect(scenes.contains { !$0.tubes.isEmpty })
    #expect(scenes.contains { !$0.segments.isEmpty })
    #expect(scenes.contains { !$0.points.isEmpty })
    #expect(scenes.contains { $0.curves.contains { $0.arrow == true } })
    #expect(scenes.contains { $0.curves.contains { $0.fill == true } })
    #expect(scenes.contains { $0.curves.contains { $0.pts.contains { $0.isNaN } } })
    #expect(scenes.contains { $0.planes?.isEmpty == false })
    #expect(scenes.contains { $0.texts?.isEmpty == false })
    #expect(scenes.contains { $0.volumes?.isEmpty == false })
    #expect(scenes.contains { $0.streamlines?.isEmpty == false })
    for kind in [SurfacePaint.Paint.Kind.curve, .region, .scalar] {
      #expect(scenes.contains { $0.paints?.contains { $0.paint.kind == kind } == true })
    }
  }

  /// A slider's drag changes a uniform, not a shader: nothing compiles again.
  @Test func aSliderCompilesNothing() throws {
    let metal = try #require(MetalContext())
    var graph = try fixture("surfaces")
    let renderer = Renderer3D(metal)
    let draw = { metal.image(of: graph, width: 160, height: 120, dpr: 1, theme: .light, renderer: renderer) }
    let before = try #require(draw())
    let compiles = renderer.compiles
    #expect(compiles > 0)
    graph.env = ["a": 1]
    let after = try #require(draw())
    #expect(renderer.compiles == compiles)
    #expect(difference(before, after) > 0.01)
  }

  /// A panel's box: nothing is drawn outside it.
  @Test func aPanelKeepsToItsBox() throws {
    let metal = try #require(MetalContext())
    var graph = try fixture("cloud")
    graph.frame = Frame2D(vp: .init(x: 160, y: 0, w: 160, h: 240))
    let image = try #require(metal.image(of: graph, width: 320, height: 240, dpr: 1, theme: .light))
    let pixels = bytes(image)
    var left = 0
    var right = 0
    for y in 0..<240 {
      for x in 0..<320 where (0..<3).contains(where: { pixels[(y * 320 + x) * 4 + $0] < 240 }) {
        if x < 160 { left += 1 } else { right += 1 }
      }
    }
    #expect(left == 0)
    #expect(right > 2000)
  }

  @Test func theCameraLooksAtItsTarget() throws {
    let cam = Camera3D(target: [1, 2, 3], radius: 9, theta: 0.4, phi: 0.3)
    let (vp, invVp, eye) = cameraMatrices(cam, 4.0 / 3)
    let center = try #require(projectToScreen(vp, cam.target, 800, 600))
    #expect(abs(center.x - 400) < 1e-3 && abs(center.y - 300) < 1e-3)
    #expect(abs(viewDepth(vp, cam.target) - 9) < 1e-4)
    // +z is up the screen.
    let above = try #require(projectToScreen(vp, cam.target + [0, 0, 1], 800, 600))
    #expect(above.y < center.y && abs(above.x - center.x) < 1e-3)
    // Behind the eye there is nowhere to land.
    #expect(projectToScreen(vp, eye + (eye - cam.target), 800, 600) == nil)
    let product = multiply(vp, invVp)
    for i in 0..<16 { #expect(abs(product[i] - (i % 5 == 0 ? 1 : 0)) < 1e-3) }
  }

  @Test func programsTranslate() {
    let program = translateProgram(
      vertex: """
        #version 300 es
        layout(location=1) in vec3 aColor;
        layout(location=0) in vec2 aPos;
        uniform mat4 uVP;
        out vec3 vColor;
        void main() { vColor = aColor; gl_Position = uVP * vec4(aPos, 0.0, 1.0); gl_PointSize = 4.0; }
        """,
      fragment: """
        #version 300 es
        precision highp float;
        uniform vec3 uColor;
        uniform bool uOn;
        uniform ivec3 uChunk;
        uniform sampler2D uStopDepth;
        in vec3 vColor;
        out vec4 outColor;
        void main() {
          float a[3] = float[3](1.0, max(2.0, 3.0), 4.0);
          if (all(lessThan(vColor, uColor))) discard;
          outColor = vec4(vColor, texture(uStopDepth, vec2(0.5)).r);
          gl_FragDepth = 0.5;
        }
        """)
    #expect(program.slots[targetHeightUniform]?.offset == 0)
    #expect(program.slots["uVP"]?.offset == 1 && program.slots["uVP"]?.count == 16)
    #expect(program.slots["uColor"]?.offset == 17)
    #expect(program.slots["uOn"]?.offset == 20)
    #expect(program.slots["uChunk"]?.count == 3)
    #expect(program.count == 24)
    #expect(program.textures == ["uStopDepth"])
    #expect(program.attributes.map(\.location) == [0, 1])
    #expect(program.attributes.map(\.size) == [2, 3])
    #expect(program.source.contains("float a[3] = {1.0, max(2.0, 3.0), 4.0};"))
    #expect(program.source.contains("eq3_lessThan(vColor, uColor)"))
    #expect(program.source.contains("[[point_size]]"))
    #expect(program.source.contains("[[depth(any)]]"))
    #expect(program.source.contains("depth2d<float> eq_texture0 [[texture(0)]]"))
  }

  /// The shaders that are the same for every scene, and the lifted and
  /// painted variants of a surface's no fixture asks for.
  @Test func everyFixedShaderCompiles() throws {
    let metal = try #require(MetalContext())
    let pairs = [
      (AXES_VERT, AXES_FRAG), (LINE_VERT, LINE_FRAG), (POINT_VERT, POINT_FRAG), (TUBE_VERT, TUBE_FRAG),
      (CONE_VERT, CONE_FRAG), (QUAD_VERT, planeFrag(theme: .light)),
      (psurfVert(["u", "v", "0.0"], nil, true), psurfFrag(["u", "v", "0.0"], nil, nil, nil, "u * v")),
    ]
    for (vertex, fragment) in pairs {
      _ = try metal.makeLibrary(translateProgram(vertex: vertex, fragment: fragment).source)
    }
    _ = try metal.makeLibrary(supportSource)
  }

  @Test func pointsSortFarthestFirst() {
    let cam = Camera3D()
    let vp = cameraMatrices(cam, 1).vp
    let eye = cameraEye(cam)
    let toward = eye / 14
    // A lone point, then a cloud of three along the line of sight.
    let points =
      [Scene3D.Point(pos: toward * 5, color: [1, 0, 0], group: 0)]
      + [-2.0, 0, 2].map { Scene3D.Point(pos: toward * $0, color: [0, 0, 1], group: 1) }
    let verts = pointVertices(vp, points, loneD: 0.5, minD: 0.1, minSpan: 1, spacings: SpacingCache())
    #expect(verts.count == 4 * POINT_STRIDE)
    let depths = (0..<4).map { k in
      viewDepth(vp, [Double(verts[k * 9]), Double(verts[k * 9 + 1]), Double(verts[k * 9 + 2])])
    }
    #expect(depths == depths.sorted(by: >))
    // The lone point is nearest, drawn last, full size and unfaded.
    #expect(verts[3 * 9 + 3] == 1 && verts[3 * 9 + 6] == 0.5 && verts[3 * 9 + 8] == 0)
    // The cloud's dots are half its spacing across, capped, and fade over its depth.
    #expect(verts[6] == 0.5 && abs(verts[8] - 4) < 1e-4 && abs(verts[7] - 12) < 1e-4)
  }

  @Test func helpers() {
    #expect(finiteRuns([0, 0, 0, 1, 1, 1, .nan, 0, 0, 2, 2, 2, 3, 3, 3, 4, 4, 4]).map(\.first) == [0, 3])
    #expect(finiteRuns([0, 0, 0, .nan, 0, 0, 1, 1, 1]).isEmpty)
    #expect(ditherOrder(2).map { [$0.x, $0.y] } == [[0, 0], [1, 1], [1, 0], [0, 1]])
    #expect(ditherOrder(4).count == 16 && ditherOrder(1).count == 1)
    #expect(haltonJitter(1) == SIMD2(0, Float(1.0 / 3 - 0.5)))
    #expect(pointSpacing([0, 0, 0, 1, 0, 0, 3, 0, 0][...]) == 1)
    let arrow = arrowConeInstances([0, 0, 0, 0, 0, 2], [(0, 2)], 10)
    #expect(arrow.count == 1 && arrow.shafts[5] == 1.5 && arrow.instances[7] == 0.5)
    #expect(buildUnitCone().indices.count == CONE_SIDES * 6)
  }
}
