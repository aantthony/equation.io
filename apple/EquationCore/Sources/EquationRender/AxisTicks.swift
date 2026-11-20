import Foundation

/// Grid lines and labels for a mapped axis (lib/axis-ticks.ts).
///
/// An unmapped axis has a line every 1, 2 or 5 × 10^k units, evenly spaced on
/// screen. A mapped one is not even: on `x = 10^X` the decades are, and the
/// numbers between them crowd toward each one's top. So ticks are chosen
/// where they land on screen: from a tick, the next is the nicest number
/// (0, then the fewest significant digits, then a leading 1, 5 or 2) that
/// lands between `gap` and 2.5 `gap` pixels further on.
///
/// The walk starts from the nicest number in view and goes both ways, so
/// while panning (same zoom) the ticks stay put until that number leaves.
public struct AxisTicks: Equatable, Sendable {
  /// Screen coordinates of the labelled lines, with their world values.
  public var major: [Major]
  /// Screen coordinates of the faint lines between them.
  public var minor: [Double]
  /// Screen coordinate where the world value is 0, when the map reaches it.
  public var zero: Double?

  public struct Major: Equatable, Sendable {
    public var at: Double
    public var value: Double
  }
}

/// Pixels between labelled lines, at least: niceSpacing's 90 in render2d.
private let majorGapPx = 90.0
private let minorGapPx = 18.0
/// Enough for any window; a runaway walk stops here.
private let maxTicks = 200

/// `parseFloat(v.toPrecision(12))`: v without its float noise.
private func rounded12(_ v: Double) -> Double {
  Double(String(format: "%.11e", v)) ?? v
}

/// Lower is nicer: 0, then fewer significant digits, then a last digit of
/// 5 or an even one (0.25 before 0.21), then a leading 1, 5, 2.
func niceness(_ v: Double) -> Int {
  if v == 0 { return -1 }
  var m = abs(v)
  m /= pow(10, floor(log10(m)))
  // Digits of the mantissa to ten places, so float noise reads as none.
  var text = String(format: "%.10f", m)
  while text.hasSuffix("0") { text.removeLast() }
  let digits = text.compactMap(\.wholeNumberValue)
  guard let lead = digits.first, let last = digits.last else { return Int.max }
  let ending = digits.count == 1 ? 0 : last == 5 ? 0 : last % 2 == 0 ? 1 : 2
  let rank = [1, 5, 2].firstIndex(of: lead) ?? 9
  return digits.count * 100 + ending * 10 + rank
}

/// The nicest number in [a, b] (a ≤ b), or nil when the interval is empty
/// or holds no number at any scale worth labelling.
public func nicestIn(_ a: Double, _ b: Double) -> Double? {
  guard a <= b, a.isFinite, b.isFinite else { return nil }
  if a <= 0, b >= 0 { return 0 }
  let top = Int(floor(log10(max(abs(a), abs(b)))))
  // The coarsest power of ten with a multiple inside holds the nicest ones.
  for k in stride(from: top, to: top - 16, by: -1) {
    let step = pow(10, Double(k))
    let first = (a / step).rounded(.up)
    let last = (b / step).rounded(.down)
    if first > last { continue }
    var best: Double?
    var bestScore = Int.max
    var n = first
    while n <= last, n - first < 20 {
      // Rounded at the step, so 0.30000000000000004 is 0.3.
      let v = rounded12(n * step)
      let score = niceness(v)
      if score < bestScore || (score == bestScore && abs(v) < abs(best ?? .infinity)) {
        best = v
        bestScore = score
      }
      n += 1
    }
    return best
  }
  return nil
}

/// Ticks for screen window [lo, hi] of a mapped axis, `pxPerUnit` screen
/// pixels per screen unit. Every coordinate returned is in screen units.
public func axisTicks(_ map: AxisMap, _ lo: Double, _ hi: Double, _ pxPerUnit: Double) -> AxisTicks {
  let world = { (s: Double) in toWorld(map, s) }
  let screen = { (v: Double) in toScreen(map, v) }
  // Outward from `from` both ways, staying inside [first, last].
  func walk(_ from: Double, _ first: Double, _ last: Double) -> [Double] {
    let gap = majorGapPx / pxPerUnit
    var out: [Double] = []
    for dir in [1.0, -1.0] {
      var s = from
      for _ in 0..<maxTicks {
        let (v0, v1) = (world(s + dir * gap), world(s + dir * 2.5 * gap))
        guard let next = nicestIn(min(v0, v1), max(v0, v1)) else { break }
        s = screen(next)
        if !s.isFinite || s > last || s < first { break }
        out.append(s)
      }
    }
    return out
  }
  func walkBetween(_ s0: Double, _ s1: Double) -> [Double] {
    let gap = minorGapPx / pxPerUnit
    var out: [Double] = []
    var s = s0
    for _ in 0..<maxTicks {
      guard let next = nicestIn(world(s + gap), world(min(s + 2.5 * gap, s1))) else { break }
      s = screen(next)
      if !s.isFinite || s >= s1 - gap / 2 { break }
      out.append(s)
    }
    return out
  }
  let empty = AxisTicks(major: [], minor: [], zero: nil)
  // The window may reach past the map (ln(X) left of 0): tick what it can show.
  guard let shown = shownRange(map, lo, hi) else { return empty }
  let (a, b) = shown.screen
  guard let anchorValue = nicestIn(shown.world.0, shown.world.1) else { return empty }
  let anchor = screen(anchorValue)
  let majors = ([anchor] + walk(anchor, a, b)).sorted()
  // Minor lines fill each gap between majors (and the ends of the window).
  let edges = [a] + majors + [b]
  var minor: [Double] = []
  for k in 0..<(edges.count - 1) { minor += walkBetween(edges[k], edges[k + 1]) }
  let zero = screen(0)
  return AxisTicks(
    major: majors.map { AxisTicks.Major(at: $0, value: rounded12(world($0))) },
    minor: minor,
    zero: zero.isFinite && abs(world(zero)) < 1e-12 ? zero : nil)
}

/// Each mapped axis's ticks in view, in screen units (web/render2d.ts
/// `mappedTicks`); `w` and `h` are the panel's size in device pixels.
public func mappedTicks(_ view: View2D, _ w: Double, _ h: Double, _ maps: AxisMaps) -> (x: AxisTicks?, y: AxisTicks?) {
  let uppY = view.upp / (view.ratio ?? 1)
  return (
    maps.x.map { axisTicks($0, view.cx - w / 2 * view.upp, view.cx + w / 2 * view.upp, 1 / view.upp) },
    maps.y.map { axisTicks($0, view.cy - h / 2 * uppY, view.cy + h / 2 * uppY, 1 / uppY) }
  )
}
