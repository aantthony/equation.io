import EquationCore
import Foundation

// A parametric region, `(u cos(2pi v), u sin(2pi v))`: the area a pair in u
// and v fills as both run over [0, 1], as triangles the overlay fills
// (lib/path.ts `regionSampler`, web/scene.ts `sampleRegion`).

/// Cells along each side of the lattice a region is sampled on (lib/path.ts `REGION_CELLS`).
let regionCells = 64

/// The triangles filling a 2D region traced by (x(u, v), y(u, v)), u and v
/// each over [0, 1]: flat [x0, y0, x1, y1, x2, y2, …], each triangle turned
/// counter-clockwise (`regionSampler`). With one orientation, overlapping
/// triangles (a disc's cells all meet at its centre) wind the same way, so a
/// nonzero fill of them all is their union at one opacity. A triangle with
/// an undefined corner is left out.
func regionTriangles(_ comps: [Expr], _ env: [String: Double]) -> [Double] {
  let n = regionCells + 1
  var xs = [Double](repeating: .nan, count: n * n)
  var ys = xs
  var scope = env
  for i in 0..<n {
    scope["u"] = Double(i) / Double(regionCells)
    for j in 0..<n {
      scope["v"] = Double(j) / Double(regionCells)
      xs[i * n + j] = (try? evaluate(comps[0], scope)) ?? .nan
      ys[i * n + j] = (try? evaluate(comps[1], scope)) ?? .nan
    }
  }
  var out: [Double] = []
  func tri(_ a: Int, _ b: Int, _ c: Int) {
    let (ax, ay, bx, by, cx, cy) = (xs[a], ys[a], xs[b], ys[b], xs[c], ys[c])
    let turn = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax)
    if !turn.isFinite || turn == 0 { return }
    out += turn > 0 ? [ax, ay, bx, by, cx, cy] : [ax, ay, cx, cy, bx, by]
  }
  for i in 0..<regionCells {
    for j in 0..<regionCells {
      let a = i * n + j
      tri(a, a + n, a + n + 1)
      tri(a, a + n + 1, a + 1)
    }
  }
  return out
}

/// Each parametric region's triangles, resampled when a value it reads
/// changes (web/main.ts `regionCache`).
final class SampledRegions: Equatable, @unchecked Sendable {
  private let lock = NSLock()
  private var entries: [Int: (comps: [Expr], values: [UInt64], tris: [Double])] = [:]

  /// Nothing a graph is: two graphs of the same rows are the same graph.
  static func == (a: SampledRegions, b: SampledRegions) -> Bool { true }

  func triangles(row: Int, _ comps: [Expr], _ env: [String: Double]) -> [Double] {
    var names = Set(comps.flatMap { freeVars($0).list })
    names.subtract(["u", "v"])
    let values = names.sorted().map { (env[$0] ?? .nan).bitPattern }
    lock.lock()
    defer { lock.unlock() }
    if let c = entries[row], c.comps == comps, c.values == values, !c.tris.isEmpty { return c.tris }
    let tris = regionTriangles(comps, env)
    entries[row] = (comps, values, tris)
    return tris
  }
}

extension Graph2D {
  /// Opacity of a parametric region's fill (web/main.ts: `cssColorA(color, 0.22)`).
  static let regionFillAlpha = 0.22

  /// A parametric region as the triangles the overlay fills.
  func drawParametricRegion(
    _ comps: [Expr], row index: Int, env: [String: Double], color: RGB, into overlay: inout Overlay2D
  ) {
    let tris = sampledRegions.triangles(row: index, comps, env)
    overlay.regions =
      (overlay.regions ?? []) + [.init(tris: tris, fill: CSSColor(color, alpha: Self.regionFillAlpha))]
  }
}
