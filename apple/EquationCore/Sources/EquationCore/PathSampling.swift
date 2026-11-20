/// CPU sampling of 2D parametric curves, complex paths included (lib/path.ts
/// `samplePath`): the polyline, broken wherever the path jumps.

/// Points per parametric curve (`CURVE_SAMPLES`).
public let CURVE_SAMPLES = 400

/// A chord this many times the local scale is suspect.
private let SUSPECT_RATIO = 4.0
/// Chords on each side whose median is the local scale: a robust measure, so
/// jumps in neighbouring intervals do not vouch for each other.
private let SCALE_WINDOW = 4
/// Halvings of a suspect interval: a continuous path's chord shrinks with
/// the interval, a jump's does not.
private let BISECTIONS = 12
/// Suspect chords refined per curve, worst first, so a wild path costs a
/// bounded number of extra evaluations each frame. A suspect past the budget
/// lifts the pen unrefined: a false break loses one short segment, a false
/// chord draws a line that is not part of the curve.
private let MAX_SUSPECTS = 32
/// A chord below this fraction of the path's extent (or of its distance from
/// the origin, where rounding noise lives) is never suspect.
private let EXTENT_FLOOR = 1e-9
private let NOISE_FLOOR = 1e-12

private func median(_ values: [Double]) -> Double {
  if values.isEmpty { return 0 }
  let sorted = values.sorted()
  let mid = sorted.count >> 1
  return sorted.count % 2 == 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

/// Sample a plane path at u = 0, 1/(n-1), …, 1 as a flat [x0, y0, x1, y1, …],
/// breaking it wherever it jumps: across a branch cut, a step, or a pole the
/// two sides are different points, and a chord between them is not part of
/// the curve. A break is a NaN pair: whoever draws the line lifts the pen
/// there (`samplePath`).
public func samplePath(_ at: (Double) -> (Double, Double), _ n: Int = CURVE_SAMPLES) -> [Double] {
  guard n > 1 else { return n == 1 ? [at(0).0, at(0).1] : [] }
  var pts: [(Double, Double)] = []
  pts.reserveCapacity(n)
  for k in 0..<n { pts.append(at(Double(k) / Double(n - 1))) }
  func chord(_ a: (Double, Double), _ b: (Double, Double)) -> Double { jsHypot([b.0 - a.0, b.1 - a.1]) }
  // NaN where either end is undefined: the pen is already up there.
  var len: [Double] = []
  len.reserveCapacity(n - 1)
  for k in 0..<(n - 1) { len.append(chord(pts[k], pts[k + 1])) }

  var (xmin, xmax, ymin, ymax, far) = (Double.infinity, -Double.infinity, Double.infinity, -Double.infinity, 0.0)
  for (x, y) in pts where x.isFinite && y.isFinite {
    xmin = min(xmin, x)
    xmax = max(xmax, x)
    ymin = min(ymin, y)
    ymax = max(ymax, y)
    far = max(far, abs(x), abs(y))
  }
  let floor = JS.max([EXTENT_FLOOR * jsHypot([xmax - xmin, ymax - ymin]), NOISE_FLOOR * far])

  var suspects: [(k: Int, severity: Double)] = []
  for k in 0..<(n - 1) {
    let d = len[k]
    if !(d > floor) || !d.isFinite { continue }
    var near: [Double] = []
    for j in (k - SCALE_WINDOW)...(k + SCALE_WINDOW) where j != k && j >= 0 && j < len.count && len[j].isFinite {
      near.append(len[j])
    }
    let scale = median(near)
    if d > SUSPECT_RATIO * scale { suspects.append((k, d / scale)) }
  }
  // (Worst first; equals in the order found, as JavaScript's stable sort leaves them.)
  suspects.sort { $0.severity > $1.severity || ($0.severity == $1.severity && $0.k < $1.k) }

  var jumps: Set<Int> = []
  for (rank, suspect) in suspects.enumerated() {
    let k = suspect.k
    if rank >= MAX_SUSPECTS {
      jumps.insert(k)
      continue
    }
    let d = len[k]
    var lo = Double(k) / Double(n - 1)
    var hi = Double(k + 1) / Double(n - 1)
    var a = pts[k]
    var b = pts[k + 1]
    var jump = true
    for _ in 0..<BISECTIONS {
      let mid = (lo + hi) / 2
      let m = at(mid)
      let da = chord(a, m)
      let db = chord(m, b)
      // An undefined midpoint is a hole in the path: break there too.
      if !da.isFinite || !db.isFinite { break }
      if da >= db {
        hi = mid
        b = m
      } else {
        lo = mid
        a = m
      }
      if chord(a, b) < d / 2 {
        jump = false
        break
      }
    }
    if jump { jumps.insert(k) }
  }
  var out: [Double] = []
  out.reserveCapacity(2 * n + 2 * jumps.count)
  for k in 0..<n {
    out.append(pts[k].0)
    out.append(pts[k].1)
    if jumps.contains(k) { out += [.nan, .nan] }
  }
  return out
}

/// The polyline of a 2D parametric curve (a real (x(u), y(u)), or the split
/// parts of a complex path) under `env`: sampled along u from 0 to 1 and
/// broken at its jumps (lib/path.ts `pathSampler`). A sample the curve has
/// no value at is undefined, which lifts the pen.
public func samplePath(_ comps: [Expr], _ env: [String: Double]) -> [Double] {
  guard comps.count >= 2 else { return [] }
  var scope = env
  return samplePath({ u in
    scope["u"] = u
    return ((try? evaluate(comps[0], &scope)) ?? .nan, (try? evaluate(comps[1], &scope)) ?? .nan)
  })
}
