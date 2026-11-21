/// Trails: `trail(A)` draws where a moving point has been (lib/plot.ts
/// `classifyLowered`, lib/point-trail.ts).
///
/// A trail is observed motion, never a re-evaluation of past state: each
/// frame samples where the point is, and the line is what was seen. So, like
/// a state's value, it belongs to the run (`StateStepper.trails`), not to the
/// analysis.

/// The object of a lowered `trail(…)` row. `off` is whether the row reads
/// the plane, a parameter or a complex value, none of which a trail follows.
func classifyTrail(_ coordinates: [Expr], off: Bool) throws -> MathObject {
  let packed = coordinates.contains {
    switch $0 {
    case .data, .list: true
    default: false
    }
  }
  if off || packed {
    throw LanguageError("trail needs a real point using constants, states, and t; use u for a parametric curve.")
  }
  if coordinates.count != 2 && coordinates.count != 3 {
    throw LanguageError("A point or vector needs 2 or 3 components.")
  }
  return .trail(coordinates: coordinates)
}

/// Where a point has been (`PointTrail`). Limits bound both memory and draw
/// work, even for graphs left animating indefinitely.
public struct PointTrail: Equatable, Sendable {
  public let dim: Int
  public let seconds: Double
  public let capacity: Int
  private var samples: [(time: Double, point: [Double])] = []
  private var lastTime = -Double.infinity
  private var pendingBreak = false
  /// Where the point is now, or nil where it has no position.
  public private(set) var head: [Double]?

  public init(dim: Int, seconds: Double = 30, capacity: Int = 2048) {
    self.dim = dim
    self.seconds = seconds
    self.capacity = capacity
  }

  public static func == (a: PointTrail, b: PointTrail) -> Bool {
    a.dim == b.dim && a.head == b.head && a.lastTime == b.lastTime && a.coordinates.count == b.coordinates.count
  }

  public mutating func sample(_ time: Double, _ point: [Double]) {
    guard time.isFinite else { return }
    if time < lastTime {
      samples = []
      lastTime = -.infinity
      pendingBreak = false
    }
    head = point.count == dim && point.allSatisfy(\.isFinite) ? point : nil
    // Remember invalid positions even when this frame is not sampled.
    if head == nil { pendingBreak = true }
    // At most 60 samples/s, regardless of display refresh rate.
    if time - lastTime < 1.0 / 60 { return }
    let gap = [Double](repeating: .nan, count: dim)
    // A suspended app or an undefined position breaks the line. Connecting
    // its endpoints would invent a trajectory that was never observed.
    if (time - lastTime > 0.5 || (pendingBreak && head != nil)) && !samples.isEmpty {
      samples.append((time, gap))
    }
    samples.append((time, head ?? gap))
    pendingBreak = false
    lastTime = time
    var drop = 0
    while samples.count - drop > capacity || (drop < samples.count && samples[drop].time < time - seconds) {
      drop += 1
    }
    if drop > 0 { samples.removeFirst(drop) }
  }

  /// The line so far, flat: `dim` numbers a sample, NaN where the pen lifts.
  public var coordinates: [Double] { samples.flatMap(\.point) }

  /// The line as drawn: the samples, then on to where the point is now. The
  /// samples are at most 60 a second, so the last may be a frame or two
  /// behind the head; the site draws that gap, and a still picture shows it.
  public var line: [Double] {
    var out = coordinates
    if let head, !pendingBreak, let last = samples.last?.point, last != head, last.allSatisfy(\.isFinite) {
      out += head
    }
    return out
  }
}

extension StateStepper {
  /// Sample each trail row where its point is on a frame at `time`
  /// (web/main.ts samples every trail each frame it draws).
  mutating func sampleTrails(at time: Double) {
    var env: [String: Double]?
    for (index, row) in analysis.rows.enumerated() {
      guard row.error == nil, row.unsupported == nil, case .trail(let dim, let coords)? = row.cpu else { continue }
      if env == nil {
        env = environment(at: time)
        env?["t"] = time
      }
      // (Incomplete values while editing: a gap.)
      let point = coords.map { (try? evaluate($0, env ?? [:])) ?? .nan }
      trails[index, default: PointTrail(dim: dim)].sample(time, point)
    }
  }
}
