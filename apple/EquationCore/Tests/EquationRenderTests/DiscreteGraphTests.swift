import Foundation
import Testing

@testable import EquationCore
@testable import EquationRender

/// What Graph2D makes of the discrete plans (Graph2D+Discrete.swift), held to
/// what web/scene.ts draws of the same rows.
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

  @Test func aRuleRunsFromItsSeedOverItsBackgrounds() throws {
    // Rule 90: each cell is the sum of its neighbours mod 2, so row n is Pascal's triangle mod 2.
    let rows = analyze(["c_{n+1}[i] = mod(c_n[i-1] + c_n[i+1], 2)"]).rows
    guard case .automaton(let rule, let radius, let seed, 1, let axes)? = rows[0].cpu else {
      Issue.record("not an automaton")
      return
    }
    #expect(axes == ["i", "n"] && radius == 1 && seed == nil)
    let grid = runAutomaton(rule: rule, radius: radius, seed: seed, [:])
    #expect(grid.rows == 1001 && grid.y0 == 0 && grid.width == 2 * (256 + 1000) + 3)
    func live(_ n: Int) -> [Int] {
      (0..<grid.width).filter { grid.values[n * grid.width + $0] != 0 }.map { $0 + grid.x0 }
    }
    #expect(live(0) == [0])
    #expect(live(1) == [-1, 1])
    #expect(live(4) == [-4, 4])
    #expect(live(3) == [-3, -1, 1, 3])
    #expect(live(1000).count == 64)  // 2^(ones in 1000's binary digits)
    // A rule that turns 000 into 1 fills its background exactly.
    guard case .automaton(let flip, _, _, _, _)? = analyze(["c_{n+1}[i] = 1 - c_n[i]"]).rows[0].cpu else { return }
    let flipped = runAutomaton(rule: flip, radius: 0, seed: nil, [:])
    #expect(flipped.values[flipped.width] == 1 && flipped.values[flipped.width - flipped.x0] == 0)
    let shades = cellShades(CellGrid(values: [0, 1, 2, -1, .nan, .infinity], width: 6, rows: 1, x0: 0, y0: 0))
    #expect(shades == [0, 128, 255, 0, 0, 0])
  }

  @Test func aGliderMovesOneCellEveryFourGenerations() throws {
    let rows = [
      "life(c, s) = {s = 3: 1, s = 4: c, 0}", "L_0 = [(0, 1), (1, 2), (2, 0), (2, 1), (2, 2)]",
      "L_{n+1}[i, j] = life(L_n[i, j], sum(a=-1..1, sum(b=-1..1, L_n[i+a, j+b])))",
    ]
    guard case .automaton(let rule, let radius, let seed, 2, let axes)? = analyze(rows).rows[2].cpu else {
      Issue.record("not a board")
      return
    }
    #expect(axes == ["j", "i"] && radius == 1)
    let board = Board(rule: rule, radius: radius, seed: seed, [:])
    func live() -> Set<[Int]> {
      let g = board.grid
      var out: Set<[Int]> = []
      for y in 0..<g.rows {
        for x in 0..<g.width where g.values[y * g.width + x] != 0 { out.insert([y + g.y0, x + g.x0]) }
      }
      return out
    }
    // (row, column), as the seed lists them.
    let start: Set<[Int]> = [[0, 1], [1, 2], [2, 0], [2, 1], [2, 2]]
    #expect(live() == start)
    board.advance(4)
    #expect(board.generation == 4)
    #expect(live() == Set(start.map { [$0[0] + 1, $0[1] + 1] }))
    board.advance(2)
    #expect(board.generation == 2 && live().count == 5)
  }

  @Test func aTableIsALatticeOpenedOnItsCells() {
    let g = graph(["n = 6", "T[i, j] = {0 <= i < n: {0 <= j < n: mod(i + j, n)}}"])
    #expect(g.lattice == ["j", "i"])
    #expect(g.frame.lattice == true)
    // Cells 0…5 each way with a cell of margin, row i running down.
    let view = g.opening(width: 800, height: 600, dpr: 1)
    #expect(view.cx == 2.5 && view.cy == -2.5 && abs(view.upp - 1.0 / 48) < 1e-12)
    let drawn = g.cells(at: 0, view: view, width: 800, height: 600, dpr: 1)
    #expect(drawn.cells.count == 1 && drawn.cells[0].runs == .init(x: false, y: false))
    #expect(drawn.labels?.axes == ["j", "i"])
    #expect(drawn.labels?.values?.count == 36)
    #expect(drawn.labels?.values?.first { $0.i == 2 && $0.k == 5 }?.text == "1")
    // Beside a curve it is cells on the plane: no lattice, no numbers.
    let mixed = graph(["T[i, j] = i j", "y = x"])
    #expect(mixed.lattice == nil && mixed.opening(width: 800, height: 600).upp == 12.0 / 600)
    // A view row may name the axes the other way round.
    let turned = graph(["T[i, j] = i j", "view(i = 0..4, j = 0..8)"])
    #expect(turned.lattice == ["j", "i"])
    #expect(turned.window?.x == [0, 8] && turned.window?.y == [-4, 0])
  }
}
