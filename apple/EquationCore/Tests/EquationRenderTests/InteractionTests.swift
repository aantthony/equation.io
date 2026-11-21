import CoreGraphics
import Foundation
import ImageIO
import Testing

@testable import EquationCore
@testable import EquationRender

/// What the app does to a graph under the hand, apart from its views: the
/// rows a moved window, camera or point writes, the panels' boxes, and the
/// arithmetic of zooming and easing. The expected texts and boxes
/// are what lib/view.ts and lib/panels.ts answer for the same arguments.
@Suite struct Interaction {
  @Test func viewRowsAreWrittenAsTheSiteWritesThem() {
    #expect(formatViewRow(x: (-5, 5), y: (-2, 2)) == "view(x = -5..5, y = -2..2)")
    #expect(
      formatViewRow(x: (-5.000000001, 4.9999999), y: (1e-12, 3.3333333333)) == "view(x = -5..5, y = 0..3.33333)")
    // A window zoomed deep at an offset takes the digits that tell its ends apart.
    #expect(formatViewRow(x: (99.99995, 100.00005), y: nil) == "view(x = 99.99995..100.00005)")
    // No exponents: the row language has none.
    #expect(
      formatViewRow(x: (-1e-7, 1e-7), y: (-2e25, 2e25), ratio: 2.5, locked: true)
        == "view(x = -0.0000001..0.0000001, y = -20000000000000001811939328..20000000000000001811939328, "
        + "ratio = 2.5, locked)")
    #expect(formatViewRow(x: nil, y: (0.1 + 0.2, 1.0 / 3), ratio: 1) == "view(y = 0.3..0.333333)")
  }

  @Test func aWindowWritesTheRowThatFramesIt() throws {
    let view = View2D(cx: 1, cy: -2, upp: 0.01, ratio: 2)
    #expect(formatViewRow(view, width: 800, height: 600) == "view(x = -3..5, y = -3.5..-0.5, ratio = 2)")
    // An axis another panel's row owns is left out, and the ratio with it.
    #expect(formatViewRow(view, width: 800, height: 600, sharedX: true) == "view(y = -3.5..-0.5)")
    #expect(formatViewRow(view, width: 800, height: 600, sharedX: true, sharedY: true) == nil)
    // The row reads back as the window it was written from.
    let row = try #require(formatViewRow(view, width: 800, height: 600))
    guard case .view(let x, let y, let ratio, false)? = analyze([row]).rows[0].view else {
      Issue.record("not a view row: \(row)")
      return
    }
    #expect(x == [-3, 5] && y == [-3.5, -0.5] && ratio == 2)
  }

  @Test func cameraRowsAreWrittenAsTheSiteWritesThem() {
    #expect(formatCameraRow(Camera3D()) == "camera(-1.0472, 0.571199, 14)")
    #expect(
      formatCameraRow(Camera3D(target: [1, 1e-12, -2.5], radius: 9, theta: 7, phi: 0.5), spin: 0.3)
        == "camera(0.716815, 0.5, 9, (1, 0, -2.5), spin = 0.3)")
    #expect(
      formatCameraRow(Camera3D(radius: 1e-4, theta: -.pi, phi: 1e-12), locked: true)
        == "camera(-3.14159, 0, 0.0001, locked)")
    #expect(
      formatCameraRow(Camera3D(target: [0.1234567, 0, 0], radius: 123_456_789, theta: 3 * .pi, phi: 0.25), spin: -0.25)
        == "camera(-3.14159, 0.25, 123457000, spin = -0.25)")
  }

  @Test func sharedAxesMoveTogether() {
    let splits = analyze(["--- below, shared x"]).rows.compactMap(\.view)
    let boxes = layoutPanels(splits, 800, 600)
    #expect(linkRoot(boxes, 1, .x) == 0 && linkRoot(boxes, 1, .y) == 1)
    var views = [View2D(cx: 0, cy: 0, upp: 0.01), View2D(cx: 3, cy: 4, upp: 0.05, ratio: 2)]
    // The lower panel follows the upper one's x, and keeps its own y and ratio.
    syncLinks(&views, boxes)
    #expect(views[1] == View2D(cx: 0, cy: 4, upp: 0.01, ratio: 2))
    // Panning the lower one pans the upper.
    views[1].cx = 7
    views[1].upp = 0.02
    #expect(syncLinks(&views, boxes, moved: 1) == [0])
    #expect(views[0] == View2D(cx: 7, cy: 0, upp: 0.02))
  }

  @Test func zoomingKeepsThePointUnderThePointer() {
    var view = View2D(cx: 1, cy: 2, upp: 0.01, ratio: 2)
    let before = view.point(px: 120, py: -40)
    view.zoom(by: 0.5, px: 120, py: -40)
    let after = view.point(px: 120, py: -40)
    #expect(view.upp == 0.005)
    #expect(abs(before.x - after.x) < 1e-12 && abs(before.y - after.y) < 1e-12)
    view.pan(dx: 100, dy: 100)
    #expect(abs(view.point(px: 220, py: -140).x - before.x) < 1e-12)
    #expect(abs(view.point(px: 220, py: -140).y - before.y) < 1e-12)
  }

  @Test func aWindowIsFittedToTheRangesAskedFor() {
    let view = View2D(cx: 1, cy: 2, upp: 0.01)
    let both = view.fitting(x: (0, 10), y: (0, 10), width: 800, height: 400)
    #expect(both == View2D(cx: 5, cy: 5, upp: 0.025))
    // One range alone keeps the other axis's center.
    #expect(view.fitting(x: (0, 8), y: nil, width: 800, height: 400) == View2D(cx: 4, cy: 2, upp: 0.01))
    let shown = both.visible(width: 800, height: 400)
    #expect(shown.x == [-5, 15] && shown.y == [0, 10])
    // Halfway, the scale is the geometric mean.
    #expect(abs(View2D(upp: 1).eased(to: View2D(upp: 100), 0.5).upp - 10) < 1e-9)
  }

  @Test func theCameraTurnsTheShortWayRound() {
    let from = Camera3D(radius: 10, theta: 0.1, phi: 0.2)
    let to = from.moved(CameraMove(theta: 2 * .pi - 0.1, phi: 5, radius: 40, target: [1, 2, 3]))
    #expect(abs(to.theta - -0.1) < 1e-12)
    #expect(to.phi == clampPhi(5) && to.radius == 40 && to.target == [1, 2, 3])
    let half = from.eased(to: to, 0.5)
    #expect(abs(half.theta) < 1e-12 && abs(half.radius - 20) < 1e-9 && half.target == [0.5, 1, 1.5])
    #expect(from.moved(CameraMove()) == from)
    #expect(abs(Camera3D(theta: 7).shownTheta - (7 - 2 * .pi)) < 1e-12)
  }

  @Test func aDraggedPointRewritesItsRow() throws {
    let rows = ["(1, 2) # here", "A = (a, 3)", "a = clamp(1, 0, 4)", "(2cos(t), a + 1)", "y = x"]
    let analysis = analyze(rows)
    let upp = (x: 0.01, y: 0.01)
    // A literal pair: both numbers, rounded to about a pixel, the note kept.
    #expect(
      analysis.movingPoint(row: 0, to: 2.34567, -1.00049, upp: upp, in: rows)?[0] == "(2.35, -1) # here")
    // A slider's name moves through its own row, held to its range.
    let moved = try #require(analysis.movingPoint(row: 1, to: 9, 0.5, upp: upp, in: rows))
    #expect(moved[1] == "A = (a, 0.5)" && moved[2] == "a = clamp(4, 0, 4)")
    // Computed coordinates have nothing to write back to; a curve is no point.
    #expect(analysis.movingPoint(row: 3, to: 0, 0, upp: upp, in: rows) == nil)
    #expect(analysis.movingPoint(row: 4, to: 0, 0, upp: upp, in: rows) == nil)
    // Nothing moved: nothing to write.
    #expect(analysis.movingPoint(row: 0, to: 1, 2, upp: upp, in: rows) == nil)
  }

  @Test func aDragKeepsAnExplicitDefinition() throws {
    // `:=` and the written name are kept; a redefined built-in's slider is found by the name rows write.
    let rows = ["A := (e, 3) # here", "e := clamp(0.6, 0, 4)", "P := (1, 2)"]
    let analysis = analyze(rows)
    let upp = (x: 0.01, y: 0.01)
    let moved = try #require(analysis.movingPoint(row: 0, to: 9, 0.5, upp: upp, in: rows))
    #expect(moved[0] == "A := (e, 0.5) # here" && moved[1] == "e := clamp(4, 0, 4)")
    #expect(analysis.movingPoint(row: 2, to: 2, 3, upp: upp, in: rows)?[2] == "P := (2, 3)")
    #expect(analysis.settingSlider(row: 1, to: 1.5, in: rows[1]) == "e := clamp(1.5, 0, 4)")
    // The point is labelled as written.
    var env = analysis.environment(at: 0)
    env["t"] = 0
    #expect(analysis.grabPoints(rows: 0..<rows.count, env: env).map(\.row) == [0, 2])
  }

  @Test func pointsThatCanMoveAreTheOnesGrabbed() {
    let rows = ["(1, 2)", "A = (a, 3)", "a = 1.5", "(2cos(t), 2sin(t))", "B = (1, 2, 3)"]
    let analysis = analyze(rows)
    var env = analysis.environment(at: 0)
    env["t"] = 0
    let points = analysis.grabPoints(rows: 0..<rows.count, env: env)
    #expect(points == [GrabPoint(row: 0, x: 1, y: 2), GrabPoint(row: 1, x: 1.5, y: 3)])
    // Within the grab radius, the nearest; beyond it, none.
    #expect(grabPoint(points, at: 1.3, 2.9, upp: 0.05, uppY: 0.05)?.row == 1)
    #expect(grabPoint(points, at: 1.05, 2.05, upp: 0.05, uppY: 0.05)?.row == 0)
    #expect(grabPoint(points, at: 5, 5, upp: 0.05, uppY: 0.05) == nil)
    // A panel's rows alone.
    #expect(analysis.grabPoints(rows: 1..<3, env: env).map(\.row) == [1])
  }

  @Test func pairsSplitAtTheirTopLevelComma() {
    #expect(splitPair("(1, 2)").map { [$0.0, $0.1] } == ["1", "2"])
    #expect(splitPair("(f(1, 2), [3, 4])").map { [$0.0, $0.1] } == ["f(1, 2)", "[3, 4]"])
    #expect(splitPair("(1, 2) + (3, 4)") == nil)
    #expect(splitPair("(1, 2, 3)") == nil)
    #expect(splitPair("x + 1") == nil)
    #expect(snapToPixel(1.23456, upp: 0.01) == 1.23 && snapToPixel(1234.5, upp: 5) == 1230)
  }
}

/// An image's pixels as RGBA bytes.
private func pixels(_ image: CGImage) -> [UInt8] {
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

/// The share of the pixels of columns `columns` two images differ in, by more than a few levels.
private func difference(_ a: CGImage, _ b: CGImage, columns: Range<Int>) -> Double {
  let (pa, pb) = (pixels(a), pixels(b))
  var differing = 0
  for y in 0..<a.height {
    for x in columns {
      let i = (y * a.width + x) * 4
      if (0..<3).contains(where: { abs(Int(pa[i + $0]) - Int(pb[i + $0])) > 8 }) { differing += 1 }
    }
  }
  return Double(differing) / Double(a.height * columns.count)
}

/// A frame of several panels: the app's picture of a split view.
@Suite struct PanelFrames {
  private func torus() throws -> Graph3D {
    let url = try #require(Bundle.module.url(forResource: "torus", withExtension: "json", subdirectory: "Scenes/3D"))
    return try Graph3D.decode(Data(contentsOf: url))
  }

  /// A 2D panel beside a 3D one is each renderer's own picture of its panel:
  /// the 3D one's multisampled pass, copied into the frame, loses nothing.
  @Test func aPlaneBesideASpaceIsEachOnesPicture() throws {
    let metal = try #require(MetalContext())
    let (width, height) = (400, 240)
    let boxes = layoutPanels(analyze(["--- right"]).rows.compactMap(\.view), 400, 240)
    #expect(boxes.map(\.rect.w) == [200, 200])
    let layers = Layers2D(curves: [Curve2D(field: "y - sin(x)", color: [0.8, 0.2, 0.2])])
    let view = View2D.opening(width: 200, height: 240)
    let graph = try torus()
    let camera = graph.camera ?? Camera3D()
    let renderer = FrameRenderer(metal)
    renderer.helpers = graph.helpers
    let panels = [
      PanelFrame(layout: boxes[0], content: .plane(Scene2D(layers: layers, view: view))),
      PanelFrame(
        layout: boxes[1], content: .space(camera: camera, scene: graph.scene, env: graph.env ?? [:], grid: .on)),
    ]
    let frame = try #require(renderer.image(of: panels, width: width, height: height, dpr: 1, theme: .light))
    #expect(renderer.space?.failures == 0)
    // EQ_FRAME_PNG=/tmp/frame.png swift test --filter PanelFrames: the frame, to look at.
    if let out = ProcessInfo.processInfo.environment["EQ_FRAME_PNG"] {
      let dest = CGImageDestinationCreateWithURL(URL(fileURLWithPath: out) as CFURL, "public.png" as CFString, 1, nil)!
      CGImageDestinationAddImage(dest, frame, nil)
      CGImageDestinationFinalize(dest)
    }
    #expect(renderer.refineIn() == nil)

    var plane = Scene2D(layers: layers, frame: Frame2D(vp: Frame2D.Box(x: 0, y: 0, w: 200, h: 240)))
    plane.view = view
    let left = try #require(metal.image(of: plane, width: width, height: height, dpr: 1, theme: .light))
    var space = graph
    space.frame = Frame2D(vp: Frame2D.Box(x: 200, y: 0, w: 200, h: 240))
    let right = try #require(metal.image(of: space, width: width, height: height, dpr: 1, theme: .light))
    // (The line where the panels meet is the frame's own.)
    #expect(difference(frame, left, columns: 0..<198) < 0.002)
    #expect(difference(frame, right, columns: 202..<400) < 0.002)
    // And the halves are not one another's.
    #expect(difference(frame, left, columns: 202..<400) > 0.02)
  }

  /// An inset is drawn over the panel it floats on, whichever renderer draws each.
  @Test func anInsetCoversItsHost() throws {
    let metal = try #require(MetalContext())
    let boxes = layoutPanels(analyze(["--- inset top left 50%"]).rows.compactMap(\.view), 320, 240)
    let graph = try torus()
    let renderer = FrameRenderer(metal)
    renderer.helpers = graph.helpers
    let plane = PanelFrame.Content.plane(Scene2D(view: View2D(upp: 0.05)))
    let space = PanelFrame.Content.space(
      camera: graph.camera ?? Camera3D(), scene: graph.scene, env: graph.env ?? [:], grid: .on)
    for (host, inset) in [(plane, space), (space, plane)] {
      let both = [PanelFrame(layout: boxes[0], content: host), PanelFrame(layout: boxes[1], content: inset)]
      let image = try #require(renderer.image(of: both, width: 320, height: 240, dpr: 1, theme: .dark))
      let alone = try #require(
        renderer.image(
          of: [PanelFrame(layout: boxes[0], content: host)], width: 320, height: 240, dpr: 1, theme: .dark))
      // Inside the inset the host's picture is gone; outside it stands.
      #expect(difference(image, alone, columns: 2..<158) > 0.05)
      #expect(difference(image, alone, columns: 170..<320) < 0.002)
    }
  }
}

/// The app draws a document's 2D panels through `FrameRenderer`, metal-shot
/// through `MetalContext.image`: the same rows are the same picture.
@Suite struct FramesAreShots {
  private func both(_ rows: [String], time: Double) throws -> (frame: CGImage, shot: CGImage) {
    let metal = try #require(MetalContext())
    let analysis = analyze(rows)
    let colors = Graph2D.colors(analysis, ids: Array(rows.indices), previous: [:], theme: .light, sources: rows).colors
    let panels = GraphPanels(analysis, colors: colors)
    var run = StateStepper(analysis)
    run.play(to: time)
    let scene = panels.scene(at: time, width: 400, height: 300, dpr: 2, run: run)
    let frame = try #require(
      FrameRenderer(metal).image(of: scene.frames, width: 400, height: 300, dpr: 2, time: time, theme: .light))
    let shot = try #require(metal.image(of: scene, width: 400, height: 300, dpr: 2, theme: .light))
    return (frame, shot)
  }

  @Test(arguments: [
    (["y = sin(x - t)", "(cos(t), sin(t))"], 1.5),
    (["y = x^2", "A = (1, 2)", "--- right 40%, shared y", "y = sin(x)", "--- inset", "x^2 + y^2 = 4"], 0.0),
    (["view(x = 0.1..1000, y = 0.01..100, x = 10^X, y = 10^Y)", "y = sqrt(x)", "(10, 1)"], 0.0),
    (["th' = om", "om' = -sin(th)", "th(0) = 3", "(th, om)", "trail((th, om))"], 2.0),
  ] as [([String], Double)])
  func aDocumentIsTheSamePictureEitherWay(rows: [String], time: Double) throws {
    let (frame, shot) = try both(rows, time: time)
    #expect(difference(frame, shot, columns: 0..<400) == 0)
  }
}
