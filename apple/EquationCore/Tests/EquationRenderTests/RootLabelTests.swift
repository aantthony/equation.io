import Foundation
import Testing

@testable import EquationCore
@testable import EquationRender

/// The names a complex equation's roots are drawn with (web/scene.ts, the
/// 'system' case of the overlay, over lib/complex-label.ts).
@Suite struct RootLabels {
  private func labels(_ rows: [String]) -> [String?] {
    let analysis = analyze(rows)
    let colors = Graph2D.colors(analysis, ids: Array(rows.indices), previous: [:], theme: .light).colors
    let window = Graph2D.Bounds(xmin: -2, xmax: 2, ymin: -1.5, ymax: 1.5)
    let points = Graph2D(analysis, colors: colors).overlay(at: 0, bounds: window).points
    return points.sorted { ($0.x, $0.y) < ($1.x, $1.y) }.map(\.label)
  }

  @Test func exactRootsAreNamed() {
    #expect(labels(["w^3 = 1"]) == ["-1/2 − √3/2 i", "-1/2 + √3/2 i", "1"])
    #expect(labels(["w^2 + 1 = 0"]) == ["-i", "i"])
  }

  @Test func aSliderIsReadAtItsValue() {
    #expect(labels(["a = 4", "w^2 = -a"]) == ["-2 i", "2 i"])
  }

  @Test func rootsWithNoRadicalFormNameTheirPolynomial() {
    let named = labels(["w^5 - w - 1 = 0"])
    #expect(named.count == 5)
    #expect(named.contains("root of w⁵ - w - 1 (≈ 0.1812 + 1.084i)"))
    #expect(named.contains("root of w⁵ - w - 1 (≈ -0.7649 − 0.3525i)"))
  }

  @Test func otherSystemsAreBareDots() {
    #expect(labels(["exp(w) = 1"]).allSatisfy { $0 == nil })
    #expect(labels(["(x^2 + y^2 - 1, x - y) = (0, 0)"]) == [nil, nil])
  }
}
