import EquationCore
import Testing

@testable import EquationRender

/// What Graph2D draws of a definite integral's row (Graph2D+Integrals.swift):
/// the area it measures, a filled polygon and its outline per run, in the
/// row's color where it adds to the value and its complement where it
/// subtracts.
@Suite struct IntegralOverlay {
  private let color = RGB(0.2, 0.4, 0.8)

  private func graph(_ rows: [String]) -> Graph2D {
    let analysis = analyze(rows)
    return Graph2D(analysis, colors: analysis.rows.map { _ in color })
  }

  @Test func theAreaInTwoTints() {
    let g = graph(["int[-1..2] x dx"])
    #expect(g.analysis.rows[0].info == "= 1.5" && g.analysis.rows[0].takesColor)
    let window = Graph2D.Bounds(xmin: -4, xmax: 4, ymin: -3, ymax: 3)
    let lines = g.overlay(at: 0, bounds: window).polylines
    // Two runs, each a fill then a stroke: below the axis over [-1, 0], above it over [0, 2].
    #expect(lines.count == 4)
    #expect(lines[0].closed == true && lines[0].noStroke == true && lines[0].fill?.a == 0.16)
    // (The crossing is found by bisection: within a millionth of a sample's width.)
    #expect(lines[0].pts.prefix(4) == [-1, 0, -1, -1] && lines[0].pts.suffix(2).allSatisfy { abs($0) < 1e-6 })
    #expect(lines[1].closed == nil && lines[1].fill == nil)
    #expect(lines[0].color == CSSColor(RGB(0.8, 0.6, 0.2)) && lines[2].color == CSSColor(color))
    #expect(lines[3].pts.suffix(4) == [2, 2, 2, 0])
  }

  @Test func theWindowCutsNoEdge() {
    let g = graph(["b = 9", "int[0..b] 1 dx"])
    let lines = g.overlay(at: 0, bounds: .init(xmin: 1, xmax: 3, ymin: -3, ymax: 3)).polylines
    #expect(lines.count == 2)
    // The fill reaches the axis at both cuts; the stroke is the curve alone.
    #expect(lines[0].pts.prefix(2) == [1, 0] && lines[0].pts.suffix(2) == [3, 0])
    #expect(lines[1].pts.prefix(2) == [1, 1] && lines[1].pts.suffix(2) == [3, 1])
    // A pole's spike is held to a window's height beyond the window.
    let pole = graph(["int[0..1] 1/x dx"]).overlay(at: 0, bounds: .init(xmin: -1, xmax: 2, ymin: -1, ymax: 1))
    #expect(pole.polylines[0].pts.max() == 3)
  }

  @Test func whatDoesNotShade() {
    for row in ["2 int[0..1] x dx", "int[0..1] x dx + 1", "y = int[0..x] t dt", "int[0..0] x dx"] {
      let g = graph([row])
      #expect(g.overlay(at: 0).polylines.isEmpty, "\(row)")
    }
  }
}
