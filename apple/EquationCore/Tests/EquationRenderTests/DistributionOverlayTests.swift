import EquationCore
import Testing

@testable import EquationRender

/// What Graph2D draws of a random variable's rows (Graph2D+Distributions.swift):
/// closed-form densities and the regions under them as shader layers, stems,
/// selections, uniform-sum curves and markers on the overlay.
@Suite struct DistributionOverlay {
  private func graph(_ rows: [String]) -> Graph2D {
    let analysis = analyze(rows)
    return Graph2D(analysis, colors: analysis.rows.map { _ in RGB(0.2, 0.4, 0.6) })
  }

  @Test func closedFormLawsAreShaderLayers() {
    let g = graph(["X ~ Normal(0, 1)", "P(X > 1)", "E(X)"])
    #expect(g.layers.curves?.count == 1 && g.layers.ineqs?.count == 1)
    let overlay = g.overlay(at: 0)
    // The marker: a stroke from the axis up to the density at the mean, capped by a dot.
    #expect(overlay.polylines.map(\.pts) == [[0, 0, 0, 0.3989422804014327]])
    #expect(overlay.points.map(\.x) == [0] && overlay.points[0].r == 4)
  }

  @Test func stemsAndTheirSelection() {
    let g = graph(["N ~ Binomial(4, 0.5)", "P(N <= 1)", "E(N)"])
    let window = Graph2D.Bounds(xmin: 0.5, xmax: 10, ymin: -1, ymax: 1)
    let overlay = g.overlay(at: 0, bounds: window, pointsPerUnit: 40)
    // The stems in view, the two selected ones drawn heavy over them, and the marker's stem at 2.
    #expect(overlay.polylines.count == 3)
    #expect(overlay.polylines[0].pts.count == 4 * 6 && overlay.polylines[0].width == 2)
    #expect(overlay.polylines[1].pts.prefix(3) == [1, 0, 1] && overlay.polylines[1].color.a == 0.45)
    #expect(abs(overlay.polylines[1].pts[3] - 0.25) < 1e-12)
    #expect(overlay.polylines[2].pts.prefix(3) == [2, 0, 2] && abs(overlay.polylines[2].pts[3] - 0.375) < 1e-12)
    // Whole numbers a pixel apart draw no dots.
    let crowded = g.overlay(at: 0, bounds: .init(xmin: -1, xmax: 10, ymin: -1, ymax: 1), pointsPerUnit: 1)
    #expect(crowded.points.count == 1 && crowded.polylines[0].width == 1)
  }

  @Test func uniformSumsDrawTheirPolynomial() {
    let g = graph(["X ~ Uniform(0, 1)", "Y ~ Uniform(0, 1)", "X + Y", "P(X + Y > 1.5)"])
    let overlay = g.overlay(at: 0)
    #expect(overlay.polylines.count == 2)
    #expect(overlay.polylines[0].width == 2 && overlay.polylines[0].pts.prefix(2) == [0, 0])
    #expect(overlay.polylines[1].closed == true && overlay.polylines[1].pts.prefix(4) == [1.5, 0, 1.5, 0.5])
  }
}
