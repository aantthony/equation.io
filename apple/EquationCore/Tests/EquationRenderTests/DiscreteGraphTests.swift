import Foundation
import Testing

@testable import EquationCore
@testable import EquationRender

/// What Graph2D makes of the discrete plans (Graph2D+Discrete.swift), held to
/// what web/main.ts draws of the same rows.
@Suite struct DiscreteGraph {
  private func graph(_ rows: [String]) -> Graph2D {
    let analysis = analyze(rows)
    let colors = Graph2D.colors(analysis, ids: Array(rows.indices), previous: [:], theme: .light).colors
    return Graph2D(analysis, colors: colors)
  }

  private let window = Graph2D.Bounds(xmin: -2.5, xmax: 6.5, ymin: -3, ymax: 3)

  @Test func aSequenceIsDotsAtTheWholeNumbersInView() {
    var g = graph(["a_n = 1/n", "s_n = sum(k=1..n, k)"])
    let dots = g.overlay(at: 0, bounds: window).points
    // 1/0 is skipped; n runs from 0 to floor(xmax).
    #expect(dots.filter { $0.color == dots[0].color }.map(\.x) == [1, 2, 3, 4, 5, 6])
    #expect(dots.first?.y == 1 && dots.first?.r == 3.5)
    #expect(dots.suffix(7).map(\.y) == [0, 1, 3, 6, 10, 15, 21])
    // Partial sums accumulate from n = 0, whatever the window starts at.
    g.partialSums = [0]
    let sums = g.overlay(at: 0, bounds: .init(xmin: 2.5, xmax: 4.5, ymin: -3, ymax: 3)).points
    #expect(sums.prefix(2).map(\.x) == [3, 4])
    #expect(abs(sums[0].y - (1 + 0.5 + 1.0 / 3)) < 1e-12)
  }

  @Test func aCobwebIsItsCurveItsDiagonalAndItsPath() {
    let g = graph(["r = 2", "a_0 = 0.25", "a_{n+1} = r a_n (1 - a_n)"])
    #expect(g.layers.curves?.count == 1)
    let overlay = g.overlay(at: 0, bounds: window)
    #expect(overlay.polylines.count == 2)
    #expect(overlay.polylines[0].pts == [-2.5, -2.5, 3, 3])
    // From the seed up to the curve, across to the diagonal, and on.
    #expect(Array(overlay.polylines[1].pts.prefix(8)) == [0.25, 0.25, 0.25, 0.375, 0.375, 0.375, 0.375, 0.46875])
    #expect(overlay.polylines[1].pts.count == 2 + 80 * 4)
    #expect(overlay.points.map(\.x) == [0.25])
  }

  @Test func anOrbitDiagramStartsFromItsSeed() {
    #expect(graph(["a_{n+1} = x a_n (1 - a_n)"]).layers.bifs?.first?.uniforms == ["uSeed": 0.5])
    let seeded = graph(["a_0 = 0.2", "a_{n+1} = x a_n (1 - a_n)"]).layers.bifs?.first
    #expect(seeded?.uniforms == ["uSeed": 0.2])
    #expect(seeded?.field == "((x * a) * (1.0 - a))")
    #expect(seeded?.params == ["a_0"])
  }
}
