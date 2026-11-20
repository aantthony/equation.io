import EquationCore
import Foundation
import Testing

@testable import EquationRender

private func number(_ v: Any?) -> Double? {
  if let n = v as? NSNumber { return n.doubleValue }
  return (v as? String).flatMap(Double.init)
}

private func window(_ v: Any?) -> View2D? {
  guard let o = v as? [String: Any], let cx = number(o["cx"]), let cy = number(o["cy"]), let upp = number(o["upp"])
  else { return nil }
  return View2D(cx: cx, cy: cy, upp: upp, ratio: number(o["ratio"]))
}

private func spec(_ v: Any?) -> WindowSpec {
  let o = v as! [String: Any]
  func pair(_ key: String) -> [Double]? { (o[key] as? [Any])?.compactMap(number) }
  return WindowSpec(x: pair("x"), y: pair("y"), ratio: number(o["ratio"]))
}

private func same(_ a: View2D, _ b: View2D?) -> Bool {
  guard let b else { return false }
  func close(_ p: Double, _ q: Double) -> Bool { p == q || abs(p - q) <= 1e-12 * max(abs(p), abs(q)) }
  return close(a.cx, b.cx) && close(a.cy, b.cy) && close(a.upp, b.upp) && close(a.ratio ?? 1, b.ratio ?? 1)
}

/// Split views: the windows lib/view.ts gives a panel (Scenes/Panels/windows.json,
/// which apple/corpus/panels.ts records), and a document drawn panel by panel.
@Suite struct Panels {
  @Test func windowsAsTheSiteFitsThem() throws {
    let url = try #require(Bundle.module.url(forResource: "Scenes/Panels/windows", withExtension: "json"))
    let fixture = try #require(try JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any])
    for c in fixture["fit"] as! [[String: Any]] {
      let got = fitView2D(spec(c["spec"]), number(c["w"])!, number(c["h"])!)
      #expect(same(got, window(c["out"])), "fitView2D \(c["spec"]!)")
      // (An absent ratio is 1 in every reader; fitView2D leaves it absent.)
      #expect((got.ratio != nil) == ((c["out"] as! [String: Any])["ratio"] != nil))
    }
    for c in fixture["linked"] as! [[String: Any]] {
      let shared = c["shared"] as! [String: Bool]
      let from = c["from"] as! [String: Any]
      let got = linkedWindow(
        window(c["own"])!, sharedX: shared["x"]!, sharedY: shared["y"]!, from: (window(from["x"]), window(from["y"])))
      #expect(same(got, window(c["out"])), "linkedWindow \(c)")
    }
    for c in fixture["panel"] as! [[String: Any]] {
      let shared = c["shared"] as! [String: Bool]
      let got = fitPanelWindow(
        spec(c["spec"]), number(c["w"])!, number(c["h"])!, sharedX: shared["x"]!, sharedY: shared["y"]!,
        linked: window(c["linked"])!)
      #expect(same(got, window(c["out"])), "fitPanelWindow \(c)")
    }
  }

  private func panels(_ rows: [String]) -> GraphPanels {
    let analysis = analyze(rows)
    let colors = Graph2D.colors(analysis, ids: Array(rows.indices), previous: [:], theme: .light).colors
    return GraphPanels(analysis, colors: colors)
  }

  @Test func oneDocumentOnePanelWithoutDividers() {
    let rows = ["a = 2", "y = a sin(x)", "view(x = -4..4)", "(1, 2)"]
    let document = panels(rows)
    #expect(document.panels.count == 1 && !document.split)
    let frame = document.scene(at: 0, width: 800, height: 600, dpr: 2)
    let analysis = analyze(rows)
    let graph = Graph2D(analysis, colors: document.colors)
    // The lone panel is the graph as it always drew: the whole frame, no box
    // (its window's ratio written out as the 1 it is, as lib/view.ts fitPanelWindow does).
    var alone = graph.scene(at: 0, width: 800, height: 600)
    alone.view?.ratio = 1
    #expect(frame.panels[0].scene == alone)
    #expect(frame.panels[0].layout.rect == PanelRect(x: 0, y: 0, w: 800, h: 600))
  }

  @Test func eachPanelDrawsItsOwnRows() {
    let document = panels([
      "f(x) = sin(x)", "y = f(x)", "A = (1, 2)", "--- below 40%, shared x", "y = d/dx f(x)", "view(y = -1..2)",
      "grid(axes)", "--- inset top left 30%", "x^2 + y^2 = 4", "view(x = -3..3, locked)",
    ])
    #expect(document.panels.map(\.rows) == [0..<3, 3..<7, 7..<10])
    #expect(document.panels.map { $0.graph.layers.curves?.count } == [1, 1, 1])
    #expect(document.panels.map(\.locked) == [false, false, true])
    #expect(document.panels.map(\.graph.grid) == [.on, .axes, .on])
    let frame = document.scene(at: 0, width: 1600, height: 1200, dpr: 2)
    // The named point is drawn in the panel its row is in.
    #expect(frame.panels.map { $0.scene?.overlay?.points.count } == [1, 0, 0])
    // Boxes from the top-left; a scene's own box counts up from the bottom, as GL does.
    #expect(frame.panels.map(\.layout.rect) == [
      PanelRect(x: 0, y: 0, w: 1600, h: 720), PanelRect(x: 0, y: 720, w: 1600, h: 480),
      PanelRect(x: 24, y: 744, w: 480, h: 144),
    ])
    #expect(frame.panels[1].scene?.frame?.vp == Frame2D.Box(x: 0, y: 0, w: 1600, h: 480))
    #expect(frame.panels[0].scene?.frame?.vp == Frame2D.Box(x: 0, y: 480, w: 1600, h: 720))
    // Sharing x: the lower panel has the upper one's center and scale across, and frames y itself.
    let views = frame.panels.compactMap { $0.scene?.view }
    #expect(views[1].cx == views[0].cx && views[1].upp == views[0].upp)
    #expect(views[1].cy == 0.5 && abs(views[1].uppY - 3.0 / 480) < 1e-15)
    #expect(views[2].upp == 6.0 / 480)
  }

  @Test func sharedAxesFollowAGesture() {
    let document = panels(["y = x", "--- below, shared x", "y = x^2", "--- right, shared y", "y = x^3"])
    let layout = document.layout(width: 1000, height: 800, dpr: 1)
    var views = document.opening(width: 1000, height: 800, dpr: 1)
    // Pan and zoom the middle panel: its x goes up to the first, its y across to the third.
    views[1].cx = 5
    views[1].cy = -2
    views[1].upp *= 2
    let changed = syncLinks(&views, layout, moved: 1)
    #expect(changed == [0, 2])
    #expect(views[0].cx == 5 && views[0].upp == views[1].upp && views[0].cy == 0)
    #expect(views[2].cy == -2 && views[2].uppY == views[1].uppY && views[2].cx == 0)
    // Moving the owner reaches the panel sharing it.
    views[0].cx = -1
    #expect(syncLinks(&views, layout) == [1])
    #expect(views[1].cx == -1)
  }

  @Test func aSplitFrameDraws() throws {
    let metal = try #require(MetalContext())
    let document = panels(["y = sin(x)", "--- right 40%", "x^2 + y^2 < 4", "--- inset bottom left", "(y, -x)"])
    let frame = document.scene(at: 0, width: 400, height: 300, dpr: 1)
    let image = try #require(metal.image(of: frame, width: 400, height: 300, dpr: 1, theme: .light))
    #expect(image.width == 400 && image.height == 300)
    #expect(metal.failures == 0)
  }
}
