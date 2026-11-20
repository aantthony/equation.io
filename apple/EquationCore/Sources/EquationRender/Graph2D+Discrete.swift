import EquationCore
import Foundation

/// What web/main.ts draws of the discrete plans and of an integral's row:
/// a sequence's dots, a cobweb's path, an orbit diagram's seed, the area a
/// definite integral shades. These read the window, which the shader passes
/// get as uniforms but the overlay must be told (`Graph2D.Bounds`).
extension Graph2D {
  /// The part of the plane a frame shows (web/main.ts `xmin`, `xmax`,
  /// `view.cy ± halfH`).
  public struct Bounds: Equatable, Sendable {
    public var xmin: Double
    public var xmax: Double
    public var ymin: Double
    public var ymax: Double

    public init(xmin: Double, xmax: Double, ymin: Double, ymax: Double) {
      self.xmin = xmin
      self.xmax = xmax
      self.ymin = ymin
      self.ymax = ymax
    }

    /// What `view` shows in a frame `width` × `height` of its pixels.
    public init(view: View2D, width: Double, height: Double) {
      let halfW = (width / 2) * view.upp
      let halfH = (height / 2) * view.uppY
      self.init(xmin: view.cx - halfW, xmax: view.cx + halfW, ymin: view.cy - halfH, ymax: view.cy + halfH)
    }
  }

  /// A recurrence's seed: the constant a_0 when the document defines one,
  /// else 1/2 (web/main.ts `seedOf`).
  static func seed(_ a0Name: String?, _ env: [String: Double]) -> Double {
    a0Name.flatMap { env[$0] } ?? 0.5
  }

  /// A sequence's dots at the whole n in view (web/main.ts, case 'sequence').
  /// In partial-sum mode they are S_N = Σ a_n, accumulated from n = 0; terms
  /// that are not finite, like 1/0², are skipped. A term that throws (a
  /// Σ(s=1..n, …) past its term limit) is skipped, and a partial sum stops
  /// there so the running total does not freeze.
  static func sequenceDots(
    term: Expr, index: String, env: [String: Double], bounds: Bounds, color: CSSColor, partialSum: Bool
  ) -> [Overlay2D.Point] {
    var scope = env
    func termAt(_ n: Double) -> Double? {
      scope[index] = n
      return try? evaluate(term, scope)
    }
    var points: [Overlay2D.Point] = []
    let nEnd = min(bounds.xmax.rounded(.down), partialSum ? 20000 : 100000)
    let n0 = max(0, bounds.xmin.rounded(.up))
    guard nEnd.isFinite, n0.isFinite else { return [] }
    let step = max(1, ((nEnd - n0 + 1) / 4000).rounded(.up))
    if partialSum {
      var sum = 0.0
      var started = false
      var n = 0.0
      while n <= nEnd {
        guard let v = termAt(n) else { break }
        if v.isFinite {
          sum += v
          started = true
        }
        if started && n >= n0 && (n - n0).truncatingRemainder(dividingBy: step) == 0 {
          points.append(.init(x: n, y: sum, color: color, r: 3.5))
        }
        n += 1
      }
    } else {
      var n = n0
      while n <= nEnd {
        if let v = termAt(n), v.isFinite { points.append(.init(x: n, y: v, color: color, r: 3.5)) }
        n += step
      }
    }
    return points
  }

  /// A cobweb's overlay (web/main.ts, case 'cobweb'): the diagonal y = x the
  /// orbit reflects off, the path from the seed, and the seed's dot. (The
  /// curve y = f(x) is a shader layer.)
  static func cobweb(
    f: Expr, recVar: String, seed: Double, env: [String: Double], bounds: Bounds, color: CSSColor, axis: RGB,
    into overlay: inout Overlay2D
  ) {
    let dLo = max(bounds.xmin, bounds.ymin)
    let dHi = min(bounds.xmax, bounds.ymax)
    if dHi > dLo {
      // Kept lighter than the axes.
      overlay.polylines.append(.init(pts: [dLo, dLo, dHi, dHi], color: CSSColor(axis, alpha: 0.45), width: 1))
    }
    var pts = [seed, seed]
    var a = seed
    var scope = env
    for _ in 0..<80 {
      scope[recVar] = a
      guard let b = try? evaluate(f, scope), b.isFinite, abs(b) <= 1e9 else { break }
      pts += [a, b, b, b]
      a = b
    }
    overlay.polylines.append(.init(pts: pts, color: color, width: 1.5))
    overlay.points.append(.init(x: seed, y: seed, color: color, r: 3.5))
  }
}

// MARK: - The integer lattice

extension Graph2D {
  /// The lattice a panel is (web/main.ts `syncPanels`): its view row names
  /// the index axes, or every row it draws is an automaton's or a table's.
  /// The rows say which index runs across; a view row naming the same two in
  /// the other order still frames them. Nil for the plane.
  static func latticeAxes(_ analysis: DocumentAnalysis) -> [String]? {
    let rows = analysis.rows.filter { $0.error == nil && $0.unsupported == nil }
    var written: [String]?
    for row in rows {
      if case .view? = row.view, let axes = row.viewAxes {
        written = axes
        break
      }
    }
    // Readouts draw nothing, so they leave a lattice a lattice.
    let drawn = rows.compactMap(\.cpu).filter {
      switch $0 {
      case .value, .note: false
      default: true
      }
    }
    let cells = drawn.compactMap { plan -> [String]? in
      switch plan {
      case .automaton(_, _, _, _, let axes), .lattice(_, let axes): axes
      default: nil
      }
    }
    let own = cells.first
    if let written {
      if let own, Set(own + written).count == 2 { return own }
      return written
    }
    if let own, cells.count == drawn.count { return own }
    return nil
  }

  /// A lattice view's window for a panel whose rows run `axes` = [across,
  /// down] (lib/view.ts `orientLattice`). The row names its axes in either
  /// order, so when it names them the other way round, its ranges swap.
  static func orientLattice(x: [Double]?, y: [Double]?, written: [String], axes: [String]) -> (
    x: [Double]?, y: [Double]?
  ) {
    guard written.count == 2, axes.count == 2 else { return (x, y) }
    let (a, b) = (written[0], written[1])
    // One axis named (b empty): the lattice says which way it runs.
    if b.isEmpty, let x, x.count == 2, !a.isEmpty {
      return a == axes[1] ? (nil, [-x[1], -x[0]]) : (x, y)
    }
    guard let x, let y, x.count == 2, y.count == 2, a == axes[1], b == axes[0] else { return (x, y) }
    return ([-y[1], -y[0]], [-x[1], -x[0]])
  }

  /// Generations a board catches up by in one frame (web/main.ts `BOARD_CATCH_UP`).
  static let boardCatchUp = 40.0

  /// The cells this frame draws (web/main.ts, cases 'automaton' and
  /// 'lattice'), and the lattice's labels: its axes, the values of the cells
  /// in view once they are big enough to print, a board's generation.
  /// `view` shows `width` × `height` of its pixels, `dpr` to a point.
  ///
  /// A 1D rule's diagram is rerun only when a value it reads changes; a
  /// board is stepped on from the last frame's, 8 generations a second and at
  /// most `boardCatchUp` a frame (`behind` says it has not caught up, so the
  /// caller draws again); a table is evaluated over the cells in the window.
  public func cells(
    at time: Double, view: View2D, width: Double, height: Double, dpr: Double
  ) -> (cells: [Cells2D], labels: LatticeLabels?, behind: Bool) {
    var env = environment(at: time)
    env["t"] = time
    var layers: [Cells2D] = []
    var labels = LatticeLabels(axes: lattice ?? ["x", "y"], values: [])
    var behind = false
    let printValues = lattice != nil && 1 / (view.upp * dpr) >= latticeValuePx
    /// Print the grid's visible cells; `nonzero` skips an automaton's empty ones.
    func latticeValues(_ g: CellGrid, nonzero: Bool) {
      guard printValues else { return }
      let iLo = Int((view.cx - (width / 2) * view.upp + 0.5).rounded(.down))
      let iHi = Int((view.cx + (width / 2) * view.upp + 0.5).rounded(.down))
      let kLo = Int((-view.cy - (height / 2) * view.uppY + 0.5).rounded(.down))
      let kHi = Int((-view.cy + (height / 2) * view.uppY + 0.5).rounded(.down))
      guard iLo <= iHi, kLo <= kHi else { return }
      for k in kLo...kHi {
        let y = k - g.y0
        if y < 0 || y >= g.rows { continue }
        for i in iLo...iHi {
          let x = i - g.x0
          if x < 0 || x >= g.width { continue }
          let v = Double(g.values[y * g.width + x])
          if !v.isFinite || (nonzero && v == 0) { continue }
          let text = cellText(v)
          labels.values?.append(.init(i: Double(i), k: Double(k), text: text))
        }
      }
    }
    for (index, row) in analysis.rows.enumerated() {
      guard row.error == nil, row.unsupported == nil, index < colors.count, let color = colors[index],
        let cls = row.classified
      else { continue }
      let params = cls.params.map { env[$0] ?? .nan }
      switch row.cpu {
      case .automaton(let rule, let radius, let seed, 2, _)?:
        let board = discrete.board(index, row.cpu!, params) { Board(rule: rule, radius: radius, seed: seed, env) }
        if cls.animated { board.update(env) }
        let target = (time * 8).rounded(.down).truncatingRemainder(dividingBy: Double(BOARD_STEPS + 1))
        let from = target < Double(board.generation) ? 0 : Double(board.generation)
        board.advance(min(target, from + Self.boardCatchUp))
        if Double(board.generation) != target { behind = true }
        let grid = board.grid
        layers.append(
          discrete.shaded(index, generation: board.generation) {
            Self.cellsOf(grid, runs: .init(x: true, y: true), shades: cellShades(grid))
          }.colored(color))
        labels.status = "generation \(board.generation)"
        latticeValues(grid, nonzero: true)
      case .automaton(let rule, let radius, let seed, _, _)?:
        let (grid, cells) = discrete.grid(index, row.cpu!, params + [cls.animated ? time : 0]) {
          let grid = runAutomaton(rule: rule, radius: radius, seed: seed, env)
          return (grid, Self.cellsOf(grid, runs: .init(x: true, y: false), shades: cellShades(grid)))
        }
        layers.append(cells.colored(color))
        latticeValues(grid, nonzero: true)
      case .lattice(let expr, _)?:
        // Only the cells in the window, which is all a table ever needs.
        func span(_ lo: Double, _ hi: Double) -> (Int, Int) {
          let (a, b) = ((lo + 0.5).rounded(.down), (hi + 0.5).rounded(.down))
          if b - a + 1 <= Double(TABLE_MAX) { return (Int(a), Int(b - a + 1)) }
          return (Int(((lo + hi) / 2 + 0.5).rounded(.down)) - TABLE_MAX / 2, TABLE_MAX)
        }
        let (i0, iw) = span(view.cx - (width / 2) * view.upp, view.cx + (width / 2) * view.upp)
        let (k0, kh) = span(-view.cy - (height / 2) * view.uppY, -view.cy + (height / 2) * view.uppY)
        let key = [Double(i0), Double(iw), Double(k0), Double(kh)] + params + [cls.animated ? time : 0]
        let (grid, cells) = discrete.grid(index, row.cpu!, key) {
          let grid = evalTable(expr, env, i0: i0, j0: k0, width: iw, rows: kh)
          return (grid, Self.cellsOf(grid, runs: .init(x: false, y: false), shades: tableShades(grid)))
        }
        layers.append(cells.colored(color))
        latticeValues(grid, nonzero: false)
      default:
        break
      }
    }
    return (layers, lattice == nil ? nil : labels, behind)
  }

  /// Cells for the renderer, coloured where drawn (web/main.ts `cellsOf`).
  static func cellsOf(_ g: CellGrid, runs: Cells2D.Runs, shades: [UInt8]) -> Cells2D {
    Cells2D(
      shades: CellShades(shades), width: g.width, rows: g.rows, x0: Double(g.x0), y0: Double(g.y0), runs: runs,
      color: [0, 0, 0])
  }
}

extension Cells2D {
  fileprivate func colored(_ color: RGB) -> Cells2D {
    var out = self
    out.color = color
    return out
  }
}

/// A lattice panel's grid: lines between cells, never through them
/// (web/render2d.ts `latticeGrid`). Cell (i, k) spans x in [i - 1/2, i + 1/2]
/// and y in [-k - 1/2, -k + 1/2], so the edges are level sets of x + 1/2 and
/// y - 1/2, and the axes are the edges before column 0 and above row 0.
func latticeGrid(_ view: View2D) -> [GridSpec] {
  let sx = latticeSpacing(view.upp)
  let sy = latticeSpacing(view.uppY)
  return [
    GridSpec(glsl: "(x + 0.5)", gradGlsl: ["1.0", "0.0"], major: sx.major, minor: sx.minor),
    GridSpec(glsl: "(y - 0.5)", gradGlsl: ["0.0", "1.0"], major: sy.major, minor: sy.minor),
  ]
}

/// What a graph keeps of its cells from frame to frame (web/main.ts
/// `cellCache`, `boardCache`, `tableCache`): by row, while the plan and the
/// values it reads are the same.
final class DiscreteCache: @unchecked Sendable, Equatable {
  private let lock = NSLock()
  private var grids: [Int: (plan: CpuPlan, key: [Double], grid: CellGrid, cells: Cells2D)] = [:]
  private var boards: [Int: (plan: CpuPlan, key: [Double], board: Board)] = [:]
  private var shades: [Int: (generation: Int, board: ObjectIdentifier, cells: Cells2D)] = [:]

  /// Nothing a graph is: two graphs of the same rows are the same graph.
  static func == (a: DiscreteCache, b: DiscreteCache) -> Bool { true }

  /// Equal, with NaN equal to itself (a parameter with no value yet).
  private static func same(_ a: [Double], _ b: [Double]) -> Bool {
    a.count == b.count && zip(a, b).allSatisfy { $0 == $1 || ($0.isNaN && $1.isNaN) }
  }

  func grid(_ row: Int, _ plan: CpuPlan, _ key: [Double], _ make: () -> (CellGrid, Cells2D)) -> (CellGrid, Cells2D) {
    lock.lock()
    defer { lock.unlock() }
    if let held = grids[row], held.plan == plan, Self.same(held.key, key) { return (held.grid, held.cells) }
    let made = make()
    grids[row] = (plan, key, made.0, made.1)
    return made
  }

  func board(_ row: Int, _ plan: CpuPlan, _ key: [Double], _ make: () -> Board) -> Board {
    lock.lock()
    defer { lock.unlock() }
    if let held = boards[row], held.plan == plan, Self.same(held.key, key) { return held.board }
    let board = make()
    boards[row] = (plan, key, board)
    return board
  }

  /// A board's cells, shaded again only when its generation changes.
  func shaded(_ row: Int, generation: Int, _ make: () -> Cells2D) -> Cells2D {
    lock.lock()
    defer { lock.unlock() }
    guard let board = boards[row]?.board else { return make() }
    if let held = shades[row], held.generation == generation, held.board == ObjectIdentifier(board) {
      return held.cells
    }
    let cells = make()
    shades[row] = (generation, ObjectIdentifier(board), cells)
    return cells
  }
}
