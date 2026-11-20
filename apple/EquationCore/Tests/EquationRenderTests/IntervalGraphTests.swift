import Foundation
import Testing

@testable import EquationCore
@testable import EquationRender

/// What Graph2D and Document3D make of rows over an interval
/// (Graph2D+Intervals.swift), held to what web/scene.ts draws of the same
/// rows: the scenes RegionScenesTests draws were written down from it.
@Suite struct IntervalGraph {
  private func graph(_ rows: [String]) -> Graph2D {
    let analysis = analyze(rows)
    let colors = Graph2D.colors(analysis, ids: Array(rows.indices), previous: [:], theme: .light).colors
    return Graph2D(analysis, colors: colors)
  }

  @Test func aFamilyOverAnIntervalIsAProjection() throws {
    // The layer Scenes/proj-eq.json holds: the member's curve, searched along u.
    let swept = graph(["a = interval(1, 2)", "y = sin(a x)"])
    let wanted = try RegionScenes.scene("proj-eq").layers.projections
    let projection = try #require(swept.layers.projections?.first)
    #expect(swept.layers.projections?.count == 1)
    #expect(projection.relation == .eq)
    #expect(projection.field == wanted?.first?.field)
    #expect(projection.slope == wanted?.first?.slope)
    #expect(swept.layers.curves?.isEmpty != false && swept.layers.ineqs?.isEmpty != false)
    // An inequality has no slope to follow, and reads its sliders as any shader does.
    let region = graph(["a = interval(0, 3)", "b = 1", "x^2 + y^2 < b a"])
    let filled = try #require(region.layers.projections?.first)
    #expect(filled.relation == .ineq && filled.slope == nil)
    #expect(filled.params == ["b"])
    #expect(filled.field == (try RegionScenes.scene("proj-ineq-param")).layers.projections?.first?.field)
    // No derivative in u: the shader estimates the slope from neighbouring samples.
    let stepped = graph(["a = interval(0, 3)", "y = floor(x + a) / 2"])
    #expect(stepped.layers.projections?.first?.slope == nil)
    #expect(
      stepped.layers.projections?.first?.field
        == (try RegionScenes.scene("proj-noslope")).layers.projections?.first?.field)
  }

  @Test func aFamilyOfFamiliesIsAProjectionPerMember() {
    let layers = graph(["a = interval(1, 2)", "y = [1, 3] a x", "y = x"]).layers
    #expect(layers.projections?.count == 2)
    // Each member a shade lighter, as a family's are.
    #expect(layers.projections?[0].color != layers.projections?[1].color)
    #expect(layers.curves?.count == 1)
  }

  @Test func anIntervalInATupleTracesAsUDoes() {
    // One interval is a curve, sampled over its own bounds; with u it fills a region.
    let curve = graph(["s = interval(0, 2)", "(s, s^2)"]).overlay(at: 0)
    let line = curve.polylines.first?.pts ?? []
    #expect(line.count == Graph2D.curveSamples * 2)
    #expect(line.first == 0 && line.last == 4)
    let analysis = analyze(["r = interval(1, 2)", "(r cos(2 pi u), r sin(2 pi u))", "u = interval(0, 2pi)"])
    #expect(analysis.rows[1].classified?.rowKind == "pregion")
    #expect(analysis.rows[2].error == nil && analysis.rows[2].unsupported == nil)
  }

  @Test func threeParametersInSpaceAreASolid() throws {
    let rows = ["r = interval(0.7, 1)", "(r cos(2 pi u), r sin(2 pi u), 2v)"]
    let analysis = analyze(rows)
    let solid = try #require(analysis.rows[1].classified)
    #expect(solid.rowKind == "solid" && solid.needs3D)
    // Its six faces, each a parametric surface in u and v.
    guard case .family(let members)? = analysis.rows[1].gpu?.shader else {
      Issue.record("a solid is a family of its faces")
      return
    }
    #expect(members.count == 6 && members.allSatisfy { $0.type == "psurface" })
    // A map that folds inside its box has faces that do not bound it.
    let folded = analyze(["a = interval(-1, 1)", "(a^2, u, v)"]).rows[1]
    #expect(folded.error == "This solid folds over itself inside its parameter box, so its faces do not bound it.")
  }
}
