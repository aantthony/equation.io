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
