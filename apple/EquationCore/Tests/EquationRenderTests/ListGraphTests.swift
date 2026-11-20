import Foundation
import Testing

@testable import EquationCore
@testable import EquationRender

/// What Graph2D makes of the list plans (Graph2D+Lists.swift), held to what
/// web/main.ts draws of the same rows.
@Suite struct ListGraph {
  private func graph(_ rows: [String]) -> Graph2D {
    let analysis = analyze(rows)
    let colors = Graph2D.colors(analysis, ids: Array(rows.indices), previous: [:], theme: .light).colors
    return Graph2D(analysis, colors: colors)
  }

  @Test func aListOfNumbersIsADotPlot() {
    // Each value at x = value, its copies stacked upward.
    let dots = graph(["[3, 1, 4, 1, 5, 1]"]).overlay(at: 0, pointsPerUnit: 100).points
    #expect(dots.map(\.x) == [3, 1, 4, 1, 5, 1])
    #expect(dots.map(\.y) == [1, 1, 1, 2, 1, 3])
    #expect(dots.allSatisfy { $0.r == 4 })
    // Values closer than a dot share a column at this zoom.
    let crowded = graph(["[1, 1.01, 3]"]).overlay(at: 0, pointsPerUnit: 100).points
    #expect(crowded.map(\.y) == [1, 2, 1])
    #expect(crowded[0].x == crowded[1].x)
    // Past 400 values, a cloud.
    let cloud = graph(["L = [1..500]/100", "L"]).overlay(at: 0, pointsPerUnit: 100)
    #expect(cloud.points.isEmpty)
    #expect(cloud.clouds?.first?.xs.count == 500)
  }

  @Test func aListOfPointsIsItsPoints() {
    let overlay = graph(["s = [0, 1, 2]", "(s, s^2)", "[(1, 2), (1/0, 0)]"]).overlay(at: 0)
    #expect(overlay.points.map(\.x) == [0, 1, 2, 1])
    #expect(overlay.points.map(\.y) == [0, 1, 4, 2])
    let dense = graph(["s = [1..300]", "(s, s)"]).overlay(at: 0).points
    #expect(dense.count == 300 && dense.allSatisfy { $0.r == 2 && $0.bare == true })
  }

  @Test func aHistogramIsItsBars() {
    let bars = graph(["hist([1, 2, 2, 3, 3, 3], 2)"]).overlay(at: 0).bars ?? []
    #expect(bars.map(\.x) == [1.5, 2.5])
    #expect(bars.map(\.y) == [1, 5])
    #expect(bars.map(\.halfWidth) == [0.5, 0.5])
  }

  @Test func aFamilyIsALayerPerMember() {
    // Curves share one program, each member choosing itself by a uniform,
    // and lighten with their place in the family.
    let g = graph(["y = [1, 2, 3] x"])
    let curves = g.layers.curves ?? []
    #expect(curves.count == 3)
    #expect(Set(curves.map(\.field)).count == 1)
    #expect(curves.map { $0.uniforms?["u_eqioFamilyIndex"] } == [0, 1, 2])
    #expect(curves[0].color == GraphTheme.light.palette[0])
    #expect(curves[2].color == Graph2D.familyColor(GraphTheme.light.palette[0], member: 2, of: 3))
    #expect(graph(["a = [1, 2]", "y < a"]).layers.ineqs?.count == 2)
    // Points, curves in u and figures are drawn on the CPU, member by member.
    let overlay = graph(["a = [1, 2]", "(cos(a u), sin(u))", "segment((0, 0), (a, 1))"]).overlay(at: 0)
    #expect(overlay.polylines.count == 4)
    #expect(overlay.polylines[2].pts == [0, 0, 1, 1])
    #expect(overlay.polylines[1].color != overlay.polylines[0].color)
  }
}
