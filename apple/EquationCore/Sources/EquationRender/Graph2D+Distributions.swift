import EquationCore
import Foundation

/// What the CPU draws of a random variable's row (web/main.ts, the
/// `density`, `pmf`, `prob` and `expect` cases of its plan switch): a density
/// curve from the variable's law, a pmf's stems, the part of either a `P(…)`
/// row selects, and the marker of an `E(…)` row. (A closed-form density and
/// the region under it are shader layers like any curve and inequality.)
extension Graph2D {
  /// Without a window the whole of a law is drawn, its stems as if they
  /// stood well apart.
  private static let openStemPx = 40.0

  /// A run of a discrete variable's stems (or the run a P(…) row selects,
  /// drawn `heavy`) as overlay geometry (web/session.ts `pushStems`). What to
  /// draw is the language's (`stemGeometry`).
  private func pushStems(
    _ run: PmfStems, _ color: RGB, heavy: Bool, pxPerUnit: Double, into overlay: inout Overlay2D
  ) {
    if run.ks.isEmpty { return }
    let g = stemGeometry(run, heavy: heavy, pxPerUnit: pxPerUnit)
    let ink = CSSColor(color, alpha: g.alpha)
    if let fill = g.fill {
      overlay.polylines.append(
        .init(pts: g.lines, color: ink, closed: true, fill: CSSColor(color, alpha: fill), width: g.width))
    } else {
      overlay.polylines.append(.init(pts: g.lines, color: ink, width: g.width))
    }
    guard let dots = g.dots else { return }
    for (k, p) in zip(run.ks, run.ps) {
      overlay.points.append(.init(x: k, y: p, color: ink, r: dots.r, bare: !dots.outlined))
    }
  }

  /// Draw the density, pmf, prob or expect plan of a row. What it draws
  /// changes only with the constants its law reads and the window, so a
  /// frame that moves neither draws what the last one did: an enumeration or
  /// a convolution is not run again (the site keeps them per variable, in
  /// its `RVSystem`). `window` is the part of the plane in view, whose
  /// stretch of the x-axis says which stems are drawn; `pointsPerUnit` how
  /// far apart consecutive whole numbers stand on it (web/scene.ts `stemPx`),
  /// which says how.
  func drawDistribution(
    _ plan: CpuPlan, row: Int, color: RGB, env: [String: Double], window: Bounds?, pointsPerUnit: Double?,
    into overlay: inout Overlay2D
  ) {
    let reads = analysis.rows[row].classified.map { $0.params + ($0.animated ? ["t"] : []) } ?? []
    let key = DrawnLaws.Key(
      rows: analysis.rows.map(\.text), color: color, values: reads.map { (env[$0] ?? .nan).bitPattern },
      xmin: window?.xmin, xmax: window?.xmax, pointsPerUnit: pointsPerUnit)
    let drawn = lawsDrawn.drawn(row: row, key: key) {
      var fresh = Overlay2D()
      drawDistribution(plan, color: color, env: env, window: window, pointsPerUnit: pointsPerUnit, into: &fresh)
      return fresh
    }
    overlay.polylines += drawn.polylines
    overlay.points += drawn.points
  }

  /// Draw a density, pmf, prob or expect plan. A plan whose law has no value
  /// this frame (a parameter out of range mid-drag) draws nothing.
  private func drawDistribution(
    _ plan: CpuPlan, color: RGB, env: [String: Double], window: Bounds?, pointsPerUnit: Double?,
    into overlay: inout Overlay2D
  ) {
    let rvs = analysis.random
    let css = CSSColor(color)
    let view = window.map { (lo: $0.xmin, hi: $0.xmax) }
    let stemPx = pointsPerUnit ?? Self.openStemPx
    do {
      switch plan {
      case .density(let rv, let mass):
        guard var c = try rvs.curve(rv, env, view: view) else { return }
        if let mass { c = c.scaled(try evaluate(mass, env)) }
        if c.pts.count >= 4 { overlay.polylines.append(.init(pts: c.pts, color: css, width: 2)) }
        // Point masses draw as probability stems (height = mass, not density).
        for a in c.atoms ?? [] {
          overlay.polylines.append(.init(pts: [a.x, 0, a.x, a.p], color: css, width: 2))
          overlay.points.append(.init(x: a.x, y: a.p, color: css, r: 4))
        }
      case .pmf(let rv, let mass):
        // Stems at the whole numbers in view.
        let scale = try mass.map { try evaluate($0, env) } ?? 1
        for run in try rvs.pmfRuns(rv, env, view: view) ?? [] {
          pushStems(run.scaled(scale), color, heavy: false, pxPerUnit: stemPx, into: &overlay)
        }
      case .prob(_, let shade):
        // The value lives in the row's readout; the plot is the shaded area
        // under the variable's density, when the body has that shape.
        guard let shade else { return }
        // Over a discrete variable: the selected stems, drawn heavier —
        // `X < 3` stops at 2 and `X <= 3` takes the stem at 3.
        if let selected = try rvs.pmfRuns(shade.rv, env, view: view, select: shade.bounds) {
          for run in selected { pushStems(run, color, heavy: true, pxPerUnit: stemPx, into: &overlay) }
          return
        }
        guard let c = try rvs.curve(shade.rv, env, view: view) else { return }
        let lo = try shade.bounds.lo.map { try evaluate($0, env) }
        let hi = try shade.bounds.hi.map { try evaluate($0, env) }
        if let poly = c.shadePolygon(lo: lo, hi: hi) {
          overlay.polylines.append(.init(pts: poly, color: css, closed: true, fill: CSSColor(color, alpha: 0.16)))
        }
      case .expect(let rv):
        // The value lives in the row's readout; the plot is a vertical
        // marker at x = E under the variable's density.
        guard let mark = try rvs.markerHeight(rv, env, view: view) else { return }
        if mark.h > 0 { overlay.polylines.append(.init(pts: [mark.x, 0, mark.x, mark.h], color: css, width: 2)) }
        overlay.points.append(.init(x: mark.x, y: mark.h, color: css, r: 4))
      default:
        break
      }
    } catch {
      // A parameter is missing this frame, or the law is not evaluable at it.
    }
  }
}

/// What each row's law last drew, and what it was drawn from. Shared by the
/// copies of a graph, which are the same rows.
final class DrawnLaws: Equatable, @unchecked Sendable {
  struct Key: Equatable {
    var rows: [String]
    var color: RGB
    /// The constants the row's law reads, as their bits (NaN is itself).
    var values: [UInt64]
    /// The stretch of the x-axis in view, and how far apart whole numbers stand on it.
    var xmin: Double?
    var xmax: Double?
    var pointsPerUnit: Double?
  }

  private let lock = NSLock()
  private var rows: [Int: (key: Key, drawn: Overlay2D)] = [:]

  /// A cache is no part of what a graph is.
  static func == (_: DrawnLaws, _: DrawnLaws) -> Bool { true }

  func drawn(row: Int, key: Key, _ draw: () -> Overlay2D) -> Overlay2D {
    lock.lock()
    let hit = rows[row]
    lock.unlock()
    if let hit, hit.key == key { return hit.drawn }
    let fresh = draw()
    lock.lock()
    rows[row] = (key, fresh)
    lock.unlock()
    return fresh
  }
}
