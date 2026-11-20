import CoreGraphics
import Foundation
import Testing

@testable import EquationRender

/// The overlay drawn alone into a bitmap `width` × `height` points at 2 pixels a point: RGBA, premultiplied.
private func draw(
  _ scene: Scene2D, width: Int = 400, height: Int = 300, theme: GraphTheme = .light, box: OverlayBox? = nil,
  before: (CGContext) -> Void = { _ in }
) -> [UInt8] {
  let dpr = 2.0
  let (w, h) = (width * 2, height * 2)
  var bytes = [UInt8](repeating: 0, count: w * h * 4)
  bytes.withUnsafeMutableBytes { raw in
    let ctx = CGContext(
      data: raw.baseAddress, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w * 4,
      space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
    ctx.translateBy(x: 0, y: CGFloat(h))
    ctx.scaleBy(x: dpr, y: -dpr)
    before(ctx)
    drawLabels2D(
      ctx, size: CGSize(width: width, height: height),
      view: scene.view ?? .opening(width: Double(w), height: Double(h)), dpr: dpr, theme: theme,
      extras: scene.overlay, numbers: scene.frame?.grid != .off, box: box, lattice: scene.lattice,
      maps: scene.maps ?? AxisMaps())
  }
  return bytes
}

/// How many pixels a drawing touched.
private func inked(_ bytes: [UInt8]) -> Int {
  stride(from: 3, to: bytes.count, by: 4).count { bytes[$0] != 0 }
}

private func alpha(_ bytes: [UInt8], x: Int, y: Int, width: Int = 400) -> UInt8 {
  bytes[(y * 2 * width * 2 + x * 2) * 4 + 3]
}

private func fixture(_ name: String) throws -> Data {
  try Data(contentsOf: try #require(Bundle.module.url(forResource: "Scenes/\(name)", withExtension: "json")))
}

private func scene(_ name: String) throws -> Scene2D {
  try JSONDecoder().decode(Scene2D.self, from: fixture(name))
}

private func close(_ a: Double, _ b: Double) -> Bool {
  a == b || (a.isNaN && b.isNaN) || abs(a - b) <= 1e-9 * max(1, abs(a), abs(b))
}

private func close(_ a: [Double], _ b: [Double]) -> Bool {
  a.count == b.count && zip(a, b).allSatisfy { close($0, $1) }
}

@Suite struct Overlay {
  /// Each scene under Scenes/ draws something, the same each time, in both themes.
  @Test(arguments: ["figures", "graph", "loglog", "lattice", "data"])
  func sceneDraws(name: String) throws {
    let scene = try scene(name)
    for theme in [GraphTheme.light, .dark] {
      let first = draw(scene, theme: theme)
      #expect(inked(first) > 2000)
      #expect(draw(scene, theme: theme) == first)
    }
  }

  /// What each part of the overlay draws is there, where the scene puts it.
  @Test func partsLandWhereTheyAre() throws {
    // 400 × 300 points over the opening window: 12 units down the frame, so 25 points a unit about (200, 150).
    func at(_ x: Double, _ y: Double) -> (Int, Int) { (Int(200 + 25 * x), Int(150 - 25 * y)) }
    let blue: CSSColor = "rgb(45, 112, 179)"
    let quiet = Frame2D(grid: .off)
    func ink(_ overlay: Overlay2D, _ x: Double, _ y: Double) -> UInt8 {
      let (px, py) = at(x, y)
      return alpha(draw(Scene2D(frame: quiet, overlay: overlay)), x: px, y: py)
    }
    #expect(ink(Overlay2D(points: [.init(x: 1, y: 2, color: blue)]), 1, 2) == 255)
    #expect(ink(Overlay2D(points: [.init(x: 1, y: 2, color: blue)]), 2, 2) == 0)
    #expect(ink(Overlay2D(points: [.init(x: .nan, y: 2, color: blue)]), 1, 2) == 0)
    #expect(ink(Overlay2D(clouds: [.init(xs: [1, .nan], ys: [2, 2], color: blue)]), 1, 2) == 255)
    // A big cloud is painted through a mask: the same squares, in the same places.
    let big = Overlay2D(clouds: [
      .init(xs: [Double](repeating: 1, count: 3000) + [-3], ys: [Double](repeating: 2, count: 3000) + [-1], color: blue)
    ])
    #expect(ink(big, 1, 2) == 255)
    #expect(ink(big, -3, -1) == 255)
    #expect(ink(big, 1, -2) == 0 && ink(big, -3, 1) == 0 && ink(big, 1.2, 2) == 0)
    #expect(ink(Overlay2D(polylines: [.init(pts: [-2, 1, 2, 1], color: blue)]), 0, 1) == 255)
    // A gap breaks a line, and a broken shape is not filled.
    let broken = Overlay2D(polylines: [
      .init(pts: [-2, -2, 2, -2, .nan, .nan, 2, 2, -2, 2], color: blue, closed: true, fill: blue)
    ])
    #expect(ink(broken, 0, 0) == 0)
    #expect(ink(broken, 0, 2) == 255)
    let whole = Overlay2D(polylines: [
      .init(pts: [-2, -2, 2, -2, 2, 2, -2, 2], color: blue, closed: true, fill: blue, noStroke: true)
    ])
    #expect(ink(whole, 0, 0) == 255)
    #expect(ink(whole, -2.1, 0) == 0)
    // An arrow's head is wider than its shaft: 2.5 points to the side of the line, 9 points short of the tip.
    let arrow = Overlay2D(polylines: [.init(pts: [0, 0, 4, 0], color: blue, arrow: true)])
    #expect(ink(arrow, 4 - 9.0 / 25, 2.5 / 25) == 255)
    #expect(ink(arrow, 2, 2.5 / 25) == 0)
    #expect(ink(Overlay2D(regions: [.init(tris: [0, 0, 2, 0, 0, 2], fill: blue)]), 0.5, 0.5) == 255)
    #expect(ink(Overlay2D(bars: [.init(x: 1, y: 2, halfWidth: 0.5, color: blue)]), 1, 1) == 77)
    #expect(ink(Overlay2D(bars: [.init(x: 1, y: 2, halfWidth: 0.5, color: blue, base: -.infinity)]), 1, -5.9) == 77)
    let glyph = Overlay2D.Glyph(
      rings: [0, 0, 2, 0, 2, 2, 0, 2, .nan, .nan], lines: [-2, -1, 2, -1], dots: [-1, 1], color: blue, fill: blue)
    #expect(ink(Overlay2D(glyphs: [glyph]), 1, 1) == 255)
    #expect(ink(Overlay2D(glyphs: [glyph]), -1, 1) == 255)
    #expect(ink(Overlay2D(glyphs: [glyph]), 0, -1) > 100)
    // A vertex is a ring: its rim is ink and so is its middle (the page's color, or its own when marked).
    #expect(ink(Overlay2D(nodes: [.init(x: 0, y: 0, text: "", color: blue)]), 13.0 / 25, 0) > 200)
    #expect(ink(Overlay2D(nodes: [.init(x: 0, y: 0, text: "7", color: blue, mark: true)]), 0.3, 0.3) == 255)
    // Text: a label beside its point, a tag on it.
    let block = Overlay2D.Text(x: 0, y: 0, text: "████", color: blue)
    let label = draw(Scene2D(frame: quiet, overlay: Overlay2D(texts: [block])))
    #expect(alpha(label, x: 200 + 8 + 10, y: 150 - 8 - 5) == 255)
    let tag = draw(Scene2D(frame: quiet, overlay: Overlay2D(tags: [block])))
    #expect(alpha(tag, x: 200, y: 150) == 255)
    #expect(inked(draw(Scene2D(frame: quiet, overlay: Overlay2D()))) == 0)
  }

  /// A panel's box moves the origin, clips to the box, and clears it: an inset hides what its host drew.
  @Test func aBoxClipsAndClears() {
    let blue: CSSColor = "rgb(45, 112, 179)"
    let overlay = Overlay2D(polylines: [.init(pts: [-100, 0, 100, 0], color: blue, width: 4)])
    let box = OverlayBox(x: 100, y: 50, w: 200, h: 100)
    let bytes = draw(Scene2D(frame: Frame2D(grid: .off), view: View2D(upp: 0.01), overlay: overlay), box: box) { ctx in
      ctx.setFillColor(CGColor(srgbRed: 1, green: 0, blue: 0, alpha: 1))
      ctx.fill(CGRect(x: 0, y: 0, width: 400, height: 300))
    }
    // Outside the box the host's drawing stays; inside it is cleared, but for the panel's own line across its middle.
    #expect(alpha(bytes, x: 50, y: 100) == 255)
    #expect(bytes[(100 * 2 * 800 + 50 * 2) * 4] == 255)
    #expect(alpha(bytes, x: 200, y: 70) == 0)
    #expect(alpha(bytes, x: 200, y: 100) == 255)
    #expect(bytes[(100 * 2 * 800 + 200 * 2) * 4] < 100)
    #expect(alpha(bytes, x: 350, y: 100) == 255)
    #expect(bytes[(100 * 2 * 800 + 350 * 2) * 4] == 255)
  }

  /// A CSV column is 100k points: a frame's worth of time is far more than a cloud may take.
  @Test func aCloudOfAHundredThousand() {
    var (xs, ys) = ([Double](), [Double]())
    var seed: UInt64 = 1
    func random() -> Double {
      seed = seed &* 6_364_136_223_846_793_005 &+ 1_442_695_040_888_963_407
      return Double(seed >> 11) / Double(1 << 53)
    }
    for _ in 0..<100_000 {
      xs.append(16 * random() - 8)
      ys.append(12 * random() - 6)
    }
    let scene = Scene2D(overlay: Overlay2D(clouds: [.init(xs: xs, ys: ys, color: "rgb(45, 112, 179)")]))
    _ = draw(scene)
    let clock = ContinuousClock()
    let took = clock.measure { _ = draw(scene) }
    print("100k cloud points: \(took)")
    // Generous: an unoptimized build on a busy machine. It takes a few milliseconds.
    #expect(took < .milliseconds(250))
  }

  @Test func colors() {
    #expect(CSSColor(css: "rgb(45, 112, 179)") == CSSColor(r: 45 / 255, g: 112 / 255, b: 179 / 255))
    #expect(CSSColor(css: "rgba(45, 112, 179, 0.16)")?.a == 0.16)
    #expect(CSSColor(css: "#fff") == CSSColor(r: 1, g: 1, b: 1))
    #expect(CSSColor(css: "#16181d") == CSSColor(r: 0x16 / 255, g: 0x18 / 255, b: 0x1d / 255))
    #expect(CSSColor(css: "blue") == nil)
    // web/main.ts cssColor and cssColorA.
    #expect(CSSColor(GraphTheme.light.palette[0]).css == "rgb(45, 112, 179)")
    #expect(CSSColor(GraphTheme.light.palette[2], alpha: 0.16).css == "rgba(56, 140, 70, 0.16)")
  }

  /// An overlay survives being written down, its gaps and edges included.
  @Test func roundTrip() throws {
    let overlay = Overlay2D(
      points: [.init(x: 1, y: 2, color: "rgb(1, 2, 3)", label: "A")],
      polylines: [.init(pts: [0, 0, .nan, .nan, 1, 1], color: "rgba(1, 2, 3, 0.5)", arrow: true)],
      bars: [.init(x: 1, y: 2, halfWidth: 0.5, color: "rgb(1, 2, 3)", base: -.infinity)])
    let data = try JSONEncoder().encode(overlay)
    let text = try #require(String(data: data, encoding: .utf8))
    #expect(text.contains("[0,0,null,null,1,1]"))
    #expect(text.contains("\"base\":\"-Infinity\""))
    #expect(text.contains("\"color\":\"rgba(1, 2, 3, 0.5)\""))
    let back = try JSONDecoder().decode(Overlay2D.self, from: data)
    #expect(back.points == overlay.points)
    #expect(back.bars == overlay.bars)
    #expect(close(back.polylines[0].pts, overlay.polylines[0].pts))
    #expect(markOverlay(back) == OverlayMark(points: 1, clouds: 0, polylines: 1, regions: 0, texts: 0, bars: 1))
  }

  @Test func axisNumerals() {
    #expect(axisLabel(0) == "0")
    #expect(axisLabel(-2) == "-2")
    #expect(axisLabel(0.30000000000000004) == "0.3")
    #expect(axisLabel(100000) == "1e5")
    #expect(axisLabel(0.00002) == "2e-5")
    #expect(latticeSpacing(0.01).major == 1)
    #expect(latticeSpacing(0.5) == (major: 50, minor: 50))
  }
}

/// The site's own answers (web/render2d.ts and lib/axis-ticks.ts, run in Node) for the log-log scene.
private struct Reference: Decodable {
  var view: View2D
  var overlay: Overlay2D
  var unmapped: Overlay2D
  var ticks: Ticks

  struct Ticks: Decodable {
    var x: Axis
    var y: Axis
  }
  struct Axis: Decodable {
    var major: [Major]
    var minor: [Double]
    var zero: Double?
  }
  struct Major: Decodable {
    var at: Double
    var value: Double
  }
}

@Suite struct MappedAxes {
  let maps = AxisMaps(x: try! parseAxisMap(.x, "10^X"), y: try! parseAxisMap(.y, "10^Y"))

  @Test func mapsAndTheirInverses() throws {
    let log = try parseAxisMap(.x, "10^X")
    #expect(close(toWorld(log, 2), 100))
    #expect(close(toScreen(log, 1000), 3))
    #expect(toScreen(log, -1).isNaN)
    #expect(toScreenOrEdge(log, 0) == -.infinity)
    // y = sqrt(Y) has Y = y^2, which a negative y never reaches.
    let root = try parseAxisMap(.y, "sqrt(Y)")
    #expect(close(toScreen(root, 3), 9))
    #expect(toScreen(root, -3).isNaN)
    let symlog = try parseAxisMap(.y, "sinh(Y)")
    #expect(close(toScreen(symlog, sinh(1.5)), 1.5))
    #expect(close(toScreen(try parseAxisMap(.x, "2 exp(X/3) - 1"), 2 * exp(2) - 1), 6))
    #expect(close(toWorld(try parseAxisMap(.x, "b^X", env: ["b": 2]), 5), 32))
    #expect(throws: AxisMapError.self) { try parseAxisMap(.x, "b^X") }
    #expect(throws: AxisMapError.self) { try parseAxisMap(.x, "-X") }
    #expect(throws: AxisMapError.self) { try parseAxisMap(.x, "sin(X)") }
    #expect(throws: AxisMapError.self) { try parseAxisMap(.x, "10^Y") }
    let range = try #require(shownRange(try parseAxisMap(.x, "ln(X)"), -1, 3))
    #expect(range.screen.0 > 0 && range.screen.1 == 3)
    // Written down as the row wrote it.
    let data = try JSONEncoder().encode(maps)
    #expect(try JSONDecoder().decode(AxisMaps.self, from: data) == maps)
  }

  @Test func niceNumbers() {
    #expect(nicestIn(-1, 3) == 0)
    #expect(nicestIn(3, 30) == 10)
    #expect(nicestIn(12, 18) == 15)
    #expect(nicestIn(0.21, 0.29) == 0.25)
    #expect(nicestIn(0.29, 0.31) == 0.3)
    #expect(nicestIn(3, 1) == nil)
    #expect(niceness(1) < niceness(5) && niceness(5) < niceness(2) && niceness(2) < niceness(0.25))
  }

  @Test func ticksAreTheSites() throws {
    let reference = try JSONDecoder().decode(Reference.self, from: fixture("loglog"))
    let ticks = mappedTicks(reference.view, 1600, 1200, maps)
    for (mine, site) in [(ticks.x, reference.ticks.x), (ticks.y, reference.ticks.y)] {
      let mine = try #require(mine)
      #expect(close(mine.major.map(\.at), site.major.map(\.at)))
      #expect(mine.major.map(\.value) == site.major.map(\.value))
      #expect(close(mine.minor, site.minor))
      #expect(mine.zero == site.zero)
    }
  }

  /// mapOverlay carries a row to the screen as the site's does: points dropped where the map
  /// cannot show them, straight runs cut where it bends them, bars standing on the window's edge.
  @Test func rowsAreCarriedAsTheSiteCarriesThem() throws {
    let reference = try JSONDecoder().decode(Reference.self, from: fixture("loglog"))
    var overlay = reference.unmapped
    mapOverlay(&overlay, mark: markOverlay(Overlay2D()), maps: maps)
    let site = reference.overlay
    #expect(overlay.points == site.points)
    #expect(overlay.points.count == 2)
    #expect(overlay.polylines.count == site.polylines.count)
    for (mine, theirs) in zip(overlay.polylines, site.polylines) {
      #expect(close(mine.pts, theirs.pts))
      #expect(mine.pts.count > 8)
    }
    for (mine, theirs) in zip(overlay.clouds ?? [], site.clouds ?? []) {
      #expect(close(mine.xs, theirs.xs) && close(mine.ys, theirs.ys))
    }
    for (mine, theirs) in zip(overlay.regions ?? [], site.regions ?? []) { #expect(close(mine.tris, theirs.tris)) }
    #expect(overlay.bars?.count == 5)
    for (mine, theirs) in zip(overlay.bars ?? [], site.bars ?? []) {
      #expect(close(mine.x, theirs.x) && close(mine.y, theirs.y) && close(mine.halfWidth, theirs.halfWidth))
      #expect(mine.base == -.infinity && theirs.base == -.infinity)
    }
    #expect(overlay.texts == site.texts)

    // What a row added before the mark stays where it was.
    var later = reference.unmapped
    mapOverlay(&later, mark: markOverlay(reference.unmapped), maps: maps)
    #expect(later.points == reference.unmapped.points)
    #expect(later.bars == reference.unmapped.bars)
  }

  /// A plane map's inverse is a parameter (lib/plane-map.ts is not ported): mapOverlay hands it every list.
  @Test func aPlaneInverseCarriesEveryList() {
    struct Shift: PlaneInverse {
      func all(_ x: Double, _ y: Double) -> [ScreenPoint] { [(x + 10, y), (x + 20, y)] }
      func first(_ x: Double, _ y: Double) -> ScreenPoint { (x + 10, y) }
      func triangles(_ tris: [Double]) -> [Double] { tris.map { $0 + 1 } }
      func lines(count: Int, vertex: (Int) -> ScreenPoint, closed: Bool, segment: Segment) -> [[Double]] {
        [(0..<count).flatMap { [vertex($0).0 + 10, vertex($0).1] }, [0, 0, .nan, .nan]]
      }
      func shapes(count: Int, vertex: (Int) -> ScreenPoint, segment: Segment) -> [PlaneShape] {
        [PlaneShape(pts: [0, 0, 1, 0, 1, 1], closed: true, stroke: false), PlaneShape(pts: [0, 0, 1, 1], closed: false)]
      }
    }
    let blue: CSSColor = "rgb(45, 112, 179)"
    var overlay = Overlay2D(
      points: [.init(x: 1, y: 2, color: blue)],
      clouds: [.init(xs: [1, 2], ys: [3, 4], color: blue)],
      polylines: [
        .init(pts: [0, 0, 1, 1, 2, 0], color: blue, closed: true),
        .init(pts: [0, 0, 1, 1, 2, 0], color: blue, closed: true, fill: blue),
      ],
      regions: [.init(tris: [0, 0, 1, 0, 0, 1], fill: blue)],
      texts: [.init(x: 1, y: 2, text: "a", color: blue)])
    mapOverlay(&overlay, mark: markOverlay(Overlay2D()), maps: AxisMaps(), plane: Shift())
    #expect(overlay.points.map(\.x) == [11, 21])
    #expect(overlay.clouds?[0].xs == [11, 12])
    #expect(overlay.regions?[0].tris == [1, 1, 2, 1, 1, 2])
    #expect(overlay.texts?[0].x == 11)
    // The line, on each copy the window shows; a piece that was cut no longer closes. Then the shape's pieces.
    #expect(overlay.polylines.count == 4)
    #expect(overlay.polylines[0].pts == [10, 0, 11, 1, 12, 0] && overlay.polylines[0].closed == true)
    #expect(overlay.polylines[1].noStroke == true && overlay.polylines[1].fill == blue)
    #expect(overlay.polylines[2].closed == false && overlay.polylines[2].fill == nil)
    #expect(overlay.polylines[3].closed == false && overlay.polylines[3].pts.count == 4)
  }
}
