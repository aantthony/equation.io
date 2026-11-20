import Foundation
import Testing

@testable import EquationCore
@testable import EquationRender

/// What the renderers are handed of the kinds apple/corpus/cases-rest.ts
/// records: graphs and marks, a tuple-valued recurrence's rows, trails in space.
@Suite struct RestScenes {
  static func colors(_ analysis: DocumentAnalysis, _ rows: [String]) -> [RGB?] {
    Graph2D.colors(analysis, ids: Array(rows.indices), previous: [:], theme: .light, sources: rows).colors
  }

  static func graph2D(_ rows: [String]) -> Graph2D {
    let analysis = analyze(rows)
    return Graph2D(analysis, colors: colors(analysis, rows))
  }

  @Test func aGraphDrawsItsArrowsAndVertices() {
    let graph = Self.graph2D(["k = [0..3]", "graph(k, mod(k + 1, 4))", "graph(1, 1, 7)", "mark(2)"])
    // A panel of graphs has no grid unless asked.
    #expect(graph.grid == .off)
    let overlay = graph.overlay(at: 0, pointsPerUnit: 50)
    let nodes = overlay.nodes ?? []
    #expect(nodes.map(\.text) == ["0", "1", "2", "3", "1"])
    #expect(nodes.map { $0.mark == true } == [false, false, true, false, false])
    // Four arrows of the cycle, and the loop with its label.
    #expect(overlay.polylines.count == 5)
    #expect(overlay.polylines.allSatisfy { $0.arrow == true })
    #expect((overlay.tags ?? []).map(\.text) == ["7"])
    // A cycle stays a circle, fitted to its radius about the origin.
    let radii = nodes.prefix(4).map { hypot($0.x, $0.y) }
    #expect(radii.allSatisfy { abs($0 - graphRadius(4)) < 1e-9 })
  }

  @Test func aGridRowOrAPlotKeepsTheGrid() {
    #expect(Self.graph2D(["graph(1, 2)", "grid(on)"]).grid == .on)
    #expect(Self.graph2D(["graph(1, 2)", "y = x"]).grid == .on)
    #expect(Self.graph2D(["graph(1, 2)", "1 + 1"]).grid == .off)
  }

  @Test func bothWaysWithTheSameLabelsIsOneLine() {
    let overlay = Self.graph2D(["graph([(1, 2), (2, 1)])"]).overlay(at: 0, pointsPerUnit: 50)
    #expect(overlay.polylines.count == 1)
    #expect(overlay.polylines[0].arrow == false)
  }

  @Test func aStackIsTheRowsOfALattice() throws {
    let rows = ["s_0 = ()", "s_{n+1} = push(s_n, n + 1)"]
    let graph = Self.graph2D(rows)
    #expect(graph.lattice == ["h", "n"])
    guard case .lattice(_, _, let computed?)? = graph.analysis.rows[1].cpu else {
      Issue.record("no computed rows")
      return
    }
    #expect(computed.prefix(4).map { $0 } == [[], [1], [1, 2], [1, 2, 3]])
    // Row k's position h is rows[k][h - 1]; nothing where the stack is not.
    let grid = evalTable(.num(.nan), [:], i0: 0, j0: 0, width: 4, rows: 3, computed: computed)
    #expect(grid.values[4..<8].map { $0.isNaN ? -1 : $0 } == [-1, 1, -1, -1])
    #expect(grid.values[8..<12].map { $0.isNaN ? -1 : $0 } == [-1, 1, 2, -1])
  }

  @Test func aTrailInSpaceIsWhatTheRunSaw() {
    let rows = ["trail((cos(t), sin(t), t))", "z = 0", "trail((t, 1))"]
    let analysis = analyze(rows)
    #expect(analysis.rows.allSatisfy { $0.error == nil && $0.unsupported == nil })
    #expect(analysis.rows[0].classified?.needs3D == true)
    let document = Document3D(analysis, colors: Self.colors(analysis, rows))
    var run = StateStepper(analysis)
    run.play(to: 1)
    let scene = document.scene(at: 1, camera: document.camera, run: run)
    // Each trail is its line and its head; the one in the plane lies in z = 0.
    #expect(scene.curves.count == 2)
    #expect(scene.points.count == 2)
    let head = scene.points[0].pos
    #expect(abs(head.x - cos(1)) < 1e-9 && abs(head.z - 1) < 1e-9)
    #expect(scene.points[1].pos.z == 0)
    #expect(scene.curves[1].pts.count >= 6)
    #expect(stride(from: 2, to: scene.curves[1].pts.count, by: 3).allSatisfy { scene.curves[1].pts[$0] == 0 })
    // With no run, where the point is now.
    let still = document.scene(at: 1, camera: document.camera, run: nil)
    #expect(still.curves.isEmpty && still.points.count == 2)
  }
}
