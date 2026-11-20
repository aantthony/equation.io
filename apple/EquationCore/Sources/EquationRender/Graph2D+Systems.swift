import EquationCore
import Foundation

/// Systems of equations in the plane (web/scene.ts `solveFor`, and its
/// 'system' case of the overlay): `(f, g) = (a, b)` and a complex equation
/// in w are solved over the window, a quarter wider each way, and each
/// solution is a dot; with u the solutions trace a curve.
///
/// Port: the site traces a parametric system, and certifies a search box, in
/// a worker and shows the last finished result meanwhile; here both are done
/// where the frame is built, and kept (as the site keeps a solve) while the
/// window stays inside the box it was solved over. A complex root is drawn
/// with its exact name (lib/complex-label.ts, the core's `complexRootLabel`).

/// What each system row last solved, and over what. Shared by the copies of
/// a graph, which are the same rows.
final class SolvedSystems: Equatable, @unchecked Sendable {
  struct Solved {
    /// The constants the row reads (and t, when it moves), as their bits.
    var values: [UInt64]
    var lo: [Double]
    var hi: [Double]
    var points: [[Double]]
    /// What a certified search found, or why it could not run.
    var note: String?
    var error: String?
  }

  private let lock = NSLock()
  private var rows: [Int: Solved] = [:]

  /// A cache is no part of what a graph is.
  static func == (_: SolvedSystems, _: SolvedSystems) -> Bool { true }

  /// The row's solutions over a box that holds `vlo…vhi`: the ones kept,
  /// while the box they were found over holds the window and is no more than
  /// six times as wide; else `solve` over the box given.
  func points(
    row: Int, values: [UInt64], vlo: [Double], vhi: [Double],
    _ solve: (_ lo: [Double], _ hi: [Double]) -> (points: [[Double]], note: String?, error: String?)
  ) -> [[Double]] {
    lock.lock()
    let hit = rows[row]
    lock.unlock()
    func holds(_ hit: Solved, _ k: Int) -> Bool {
      hit.lo[k] <= vlo[k] && hit.hi[k] >= vhi[k] && hit.hi[k] - hit.lo[k] <= 6 * (vhi[k] - vlo[k])
    }
    if let hit, hit.values == values, holds(hit, 0), holds(hit, 1) { return hit.points }
    let pad = (0..<2).map { 0.25 * (vhi[$0] - vlo[$0]) }
    let lo = (0..<2).map { vlo[$0] - pad[$0] }
    let hi = (0..<2).map { vhi[$0] + pad[$0] }
    let found = solve(lo, hi)
    lock.lock()
    rows[row] = Solved(values: values, lo: lo, hi: hi, points: found.points, note: found.note, error: found.error)
    lock.unlock()
    return found.points
  }

  /// What the row's certified search last reported.
  func report(row: Int) -> (note: String?, error: String?) {
    lock.lock()
    defer { lock.unlock() }
    return (rows[row]?.note, rows[row]?.error)
  }
}

extension Graph2D {
  /// Whether the row offers "certify search box" (web/main.ts `rowToggle`): a
  /// system of two equations that is not parametric and wraps no angle.
  ///
  /// Port: the site withholds it from a real system only on a panel whose map
  /// has it solved in screen coordinates; here from any real system on a
  /// mapped panel.
  public func canCertify(row index: Int) -> Bool {
    switch analysis.rows[index].cpu {
    case .system(2, _, false, let angular, _): !angular.contains(true) && maps == nil
    case .complexSystem: true
    default: false
    }
  }

  /// What a certified row reads once drawn, as the site's row info ("Search
  /// box: 4 certified roots; complete"), or the error that kept the
  /// certificate from running. Nil for a row that is not being certified.
  public func certificate(row index: Int) -> (info: String?, error: String?) {
    guard certified.contains(index), canCertify(row: index) else { return (nil, nil) }
    let report = systemsSolved.report(row: index)
    return (report.note, report.error)
  }

  /// A system row's dots, or the curve a parametric one traces.
  func drawSystem(
    _ cpu: CpuPlan, row index: Int, color: CSSColor, env: [String: Double], window: Bounds?,
    into overlay: inout Overlay2D
  ) {
    let residuals: [Expr]
    var parametric = false
    var angular: [Bool] = []
    var complexEquation: Expr?
    switch cpu {
    case .system(2, let r, let p, let a, _): (residuals, parametric, angular) = (r, p, a)
    case .complexSystem(let r, let equation): (residuals, complexEquation) = (r, equation)
    default: return
    }
    // (With no window given, the one a graph opens on.)
    let row = analysis.rows[index]
    // (On a mapped panel, a system that is placed solves over what the maps show: Graph2D+Maps.swift.)
    guard let window = solveWindow(row, window ?? Bounds(xmin: -8, xmax: 8, ymin: -6, ymax: 6)) else { return }
    let (vlo, vhi) = ([window.xmin, window.ymin], [window.xmax, window.ymax])
    guard zip(vlo, vhi).allSatisfy({ $0.isFinite && $1.isFinite && $1 > $0 }) else { return }
    var values = (row.classified?.params ?? []).map { (env[$0] ?? .nan).bitPattern }
    if row.classified?.animated == true { values.append((env["t"] ?? 0).bitPattern) }
    let certify = certified.contains(index) && canCertify(row: index)
    // (A certified search is not the plain one: neither stands in for the other.)
    values.append(certify ? 1 : 0)
    let vars = ["x", "y"]
    let points = systemsSolved.points(row: index, values: values, vlo: vlo, vhi: vhi) { lo, hi in
      if parametric {
        // One run of points per branch, a gap between branches.
        var pts: [[Double]] = []
        for path in traceSystem(residuals, vars, lo, hi, env, 256, angular) where path.count >= 2 {
          if !pts.isEmpty { pts.append([.nan, .nan]) }
          pts += path
        }
        return (pts, nil, nil)
      }
      if certify {
        do {
          let found = try certifiedSearch(residuals, vars, lo, hi, env)
          return (found.pts, found.info, nil)
        } catch {
          return ([], nil, (error as? LanguageError)?.message ?? "\(error)")
        }
      }
      return (solveSystem(residuals, vars, lo, hi, SolveOptions(env: env, angular: angular)), nil, nil)
    }
    if parametric {
      overlay.polylines.append(.init(pts: points.flatMap { [$0[0], $0[1]] }, color: color))
      return
    }
    for p in points where p.count >= 2 {
      overlay.points.append(
        .init(x: p[0], y: p[1], color: color, label: complexRootLabel(complexEquation, p, env)))
    }
  }
}
