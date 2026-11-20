import Foundation
import Testing

@testable import EquationCore
@testable import EquationRender

/// What the app does to a graph under the hand, apart from its views: the
/// rows a moved window, camera or point writes, the panels' boxes, and the
/// arithmetic of zooming, easing and coasting. The expected texts and boxes
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

  private func boxes(_ rows: [String], margin: Double = 24) -> [[Double]] {
    let splits = analyze(rows).rows.compactMap(\.view)
    return panelBoxes(splits, width: 1001, height: 701, margin: margin).map {
      [$0.x, $0.y, $0.w, $0.h, Double($0.host), $0.inset ? 1 : 0, $0.sharedX ? 1 : 0, $0.sharedY ? 1 : 0]
    }
  }

  @Test func panelsAreLaidOutAsTheSiteLaysThemOut() {
    #expect(boxes(["---"]) == [[0, 0, 500, 701, 0, 0, 0, 0], [500, 0, 501, 701, 0, 0, 0, 0]])
    #expect(
      boxes(["--- below 40%, shared x"]) == [[0, 0, 1001, 421, 0, 0, 0, 0], [0, 421, 1001, 280, 0, 0, 1, 0]])
    #expect(
      boxes(["--- right 40%", "--- below", "--- inset top left 30%"]) == [
        [0, 0, 601, 701, 0, 0, 0, 0], [601, 0, 400, 350, 0, 0, 0, 0], [601, 350, 400, 351, 1, 0, 0, 0],
        [625, 374, 120, 105, 2, 1, 0, 0],
      ])
    #expect(
      boxes(["--- inset", "--- left 25% shared x y", "--- above"]) == [
        [250, 0, 751, 701, 0, 0, 0, 0], [714, 24, 263, 245, 0, 1, 0, 0], [0, 351, 250, 350, 0, 0, 1, 1],
        [0, 0, 250, 351, 2, 0, 0, 0],
      ])
  }

  @Test func aPointerIsInTheTopmostPanel() {
    let splits = analyze(["--- right 40%", "--- below", "--- inset top left 30%"]).rows.compactMap(\.view)
    let boxes = panelBoxes(splits, width: 1001, height: 701, margin: 24)
    #expect(panelAt(boxes, 10, 10) == 0)
    #expect(panelAt(boxes, 700, 100) == 1)
    #expect(panelAt(boxes, 900, 600) == 2)
    // The inset floats over the panel it is in.
    #expect(panelAt(boxes, 630, 380) == 3)
    // Outside every box: the first.
    #expect(panelAt(boxes, -5, 2000) == 0)
    // A box counts up from the bottom for the renderers.
    #expect(boxes[3].frame(in: 701) == Frame2D.Box(x: 625, y: 701 - 374 - 105, w: 120, h: 105))
  }

  @Test func sharedAxesMoveTogether() {
    let splits = analyze(["--- below, shared x"]).rows.compactMap(\.view)
    let boxes = panelBoxes(splits, width: 800, height: 600)
    #expect(linkRoot(boxes, 1, x: true) == 0 && linkRoot(boxes, 1, x: false) == 1)
    var views = [View2D(cx: 0, cy: 0, upp: 0.01), View2D(cx: 3, cy: 4, upp: 0.05, ratio: 2)]
    // The lower panel follows the upper one's x, and keeps its own y and ratio.
    syncLinkedWindows(&views, boxes)
    #expect(views[1] == View2D(cx: 0, cy: 4, upp: 0.01, ratio: 2))
    // Panning the lower one pans the upper.
    views[1].cx = 7
    views[1].upp = 0.02
    syncLinkedWindows(&views, boxes, moved: 1)
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

  @Test func aThrowCoastsToRest() {
    var coast = Coast()
    for k in 0...5 { coast.track(x: Double(k) * 10, y: 0, at: Double(k) * 0.016) }
    let thrown = coast.release(at: 0.081)
    #expect(thrown)
    #expect(abs(coast.velocity.x - 625) < 1e-6 && coast.velocity.y == 0)
    var moved = 0.0
    var steps = 0
    while let step = coast.step(1.0 / 60) {
      moved += step.x
      steps += 1
    }
    // It carries about the speed times the decay time, and stops.
    #expect(moved > 150 && moved < 625 * 0.325 && steps < 200)
    #expect(coast.velocity == .zero)
    // A hand that rested before lifting throws nothing.
    for k in 0...5 { coast.track(x: Double(k) * 10, y: 0, at: Double(k) * 0.016) }
    let rested = coast.release(at: 0.5)
    #expect(!rested)
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

  @Test func pointsThatCanMoveAreTheOnesGrabbed() {
    let rows = ["(1, 2)", "A = (a, 3)", "a = 1.5", "(2cos(t), 2sin(t))", "B = (1, 2, 3)"]
    let analysis = analyze(rows)
    var env = analysis.environment(at: 0)
    env["t"] = 0
    let points = analysis.grabPoints(sources: rows, rows: 0..<rows.count, env: env)
    #expect(points == [GrabPoint(row: 0, x: 1, y: 2), GrabPoint(row: 1, x: 1.5, y: 3)])
    // Within the grab radius, the nearest; beyond it, none.
    #expect(grabPoint(points, at: 1.3, 2.9, upp: 0.05, uppY: 0.05)?.row == 1)
    #expect(grabPoint(points, at: 1.05, 2.05, upp: 0.05, uppY: 0.05)?.row == 0)
    #expect(grabPoint(points, at: 5, 5, upp: 0.05, uppY: 0.05) == nil)
    // A panel's rows alone.
    #expect(analysis.grabPoints(sources: rows, rows: 1..<3, env: env).map(\.row) == [1])
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
