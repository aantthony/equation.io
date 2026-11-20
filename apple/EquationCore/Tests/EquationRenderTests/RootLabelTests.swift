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

/// A system's row with "certify search box" on (web/main.ts `rowToggle`,
/// web/trace-worker.ts): what it reads is the site's, for the box a graph
/// opens on (lib/certify.ts over [-12, 12] × [-9, 9]).
@Suite struct CertifiedSystems {
  private func certificate(_ row: String, certify: Bool = true) -> (points: Int, info: String?, error: String?) {
    let analysis = analyze([row])
    let colors = Graph2D.colors(analysis, ids: [0], previous: [:], theme: .light).colors
    var graph = Graph2D(analysis, colors: colors)
    if certify { graph.certified = [0] }
    let points = graph.overlay(at: 0, bounds: nil).points
    let report = graph.certificate(row: 0)
    return (points.count, report.info, report.error)
  }

  @Test func polynomialSystemsAreProvedComplete() {
    let conics = certificate("(x^2 + y^2 - 4, x y - 1) = (0, 0)")
    #expect(conics.points == 4 && conics.info == "Search box: 4 certified roots; complete")
    let cube = certificate("w^3 = 1")
    #expect(cube.points == 3 && cube.info == "Search box: 3 certified roots; complete")
  }

  @Test func whatTheIntervalTestCannotReadStaysUnresolved() {
    let waves = certificate("(sin(x) - y, cos(y) - x) = (0, 0)")
    #expect(waves.points == 1)
    #expect(waves.info == "Search box: 0 certified roots; 1039 unresolved regions (bounded search)")
    let touching = certificate("(x^2 - y, y - x^2) = (0, 0)")
    #expect(touching.info == "Search box: 0 certified roots; 375 unresolved regions (bounded search)")
  }

  @Test func aRowNotAskedIsOnlySolved() {
    let plain = certificate("(x^2 + y^2 - 4, x y - 1) = (0, 0)", certify: false)
    #expect(plain.points == 4 && plain.info == nil && plain.error == nil)
  }

  @Test func onlyPlainSystemsOfferIt() {
    func offers(_ rows: [String]) -> Bool {
      let analysis = analyze(rows)
      let colors = Graph2D.colors(analysis, ids: Array(rows.indices), previous: [:], theme: .light).colors
      return Graph2D(analysis, colors: colors).canCertify(row: rows.count - 1)
    }
    #expect(offers(["(x^2 + y^2 - 4, x y - 1) = (0, 0)"]))
    #expect(offers(["w^3 = 1"]))
    #expect(!offers(["(x - cos(u), y - sin(u)) = (0, 0)"]))
    #expect(!offers(["y = x^2"]))
  }
}
