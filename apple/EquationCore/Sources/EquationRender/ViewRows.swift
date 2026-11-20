import EquationCore
import Foundation

// A panel's framing written back as its row's text: the writeback half of
// lib/view.ts (`formatViewSpec`, `formatCameraRow`). The app rewrites a
// `view(…)` or `camera(…)` row to the picture on screen once a gesture or a
// move has changed it, as the site does.

/// `parseFloat(v.toPrecision(digits))`: v at so many significant digits.
private func trimmed(_ v: Double, _ digits: Int) -> Double {
  guard v.isFinite else { return v }
  return Double(String(format: "%.*e", digits - 1, v)) ?? v
}

/// The site's `fmt`: six significant digits (or `digits`), always as a plain
/// decimal — the row language has no exponent notation, and reads
/// `-4.44089e-16` as -4.44089·e − 16.
func formatRowNumber(_ v: Double, digits: Int = 6) -> String {
  let n = trimmed(v, digits)
  let s = JS.string(n)
  if !s.contains("e") { return s }
  if abs(n) >= 1 { return String(format: "%.0f", n) }
  // Anything under a hundred places is 0 at any scale a view shows.
  let places = digits - 1 - Int(log10(abs(n)).rounded(.down))
  if places > 100 { return "0" }
  var fixed = String(format: "%.*f", places, n)
  if fixed.contains(".") {
    while fixed.hasSuffix("0") { fixed.removeLast() }
    if fixed.hasSuffix(".") { fixed.removeLast() }
  }
  return fixed
}

/// Float dust (from easing, or equal and opposite drags) at `scale`, written as 0.
private func clean(_ v: Double, _ scale: Double = 1) -> Double {
  abs(v) < scale * 1e-9 ? 0 : v
}

/// A range's ends at the fewest digits that reproduce it. Six read well, but
/// a window zoomed deep at a large offset (99.99995..100.00005) needs more:
/// digits grow until the rounding quantum is under 1% of the span.
private func formatRange(_ lo: Double, _ hi: Double) -> String {
  let span = hi - lo
  let scale = max(abs(lo), abs(hi))
  var digits = 6
  while digits < 17, scale * pow(10, Double(1 - digits)) > span / 100 { digits += 1 }
  return "\(formatRowNumber(clean(lo, span), digits: digits))..\(formatRowNumber(clean(hi, span), digits: digits))"
}

/// The `view(…)` row for a window: each axis given as [lo, hi] (a panel
/// sharing an axis with another leaves that one out), the ratio when it is
/// not 1, and `locked`.
public func formatViewRow(
  x: (Double, Double)?, y: (Double, Double)?, ratio: Double? = nil, locked: Bool = false
) -> String {
  var parts: [String] = []
  if let x { parts.append("x = \(formatRange(x.0, x.1))") }
  if let y { parts.append("y = \(formatRange(y.0, y.1))") }
  if let ratio, ratio != 1 { parts.append("ratio = \(formatRowNumber(ratio))") }
  if locked { parts.append("locked") }
  return "view(\(parts.joined(separator: ", ")))"
}

/// The `view(…)` row for the window `view` shows in a box `width` × `height`
/// pixels; `sharedX`/`sharedY` leave out an axis another panel's row owns.
/// Nil when both are shared: there is nothing of its own to write.
public func formatViewRow(
  _ view: View2D, width: Double, height: Double, sharedX: Bool = false, sharedY: Bool = false, locked: Bool = false
) -> String? {
  guard width > 0, height > 0, !(sharedX && sharedY) else { return nil }
  let hw = width / 2 * view.upp
  let hh = height / 2 * view.uppY
  return formatViewRow(
    x: sharedX ? nil : (view.cx - hw, view.cx + hw), y: sharedY ? nil : (view.cy - hh, view.cy + hh),
    ratio: sharedX || sharedY ? nil : view.ratio, locked: locked)
}

/// The same row for a panel whose view(…) row maps an axis or names a
/// lattice's (lib/view.ts `formatViewSpec`). A mapped axis's window is held
/// in screen units and written in its own, each end to six significant
/// digits (on a log axis 0.00001 is a real bound, not float dust beside
/// 100000), with the map after the ranges. A lattice's axes are written by
/// name, the one down negated, in the order the row had them (`written`).
public func formatViewRow(
  _ view: View2D, width: Double, height: Double, sharedX: Bool = false, sharedY: Bool = false, locked: Bool = false,
  maps: AxisMaps?, lattice axes: [String]? = nil, written: [String]? = nil
) -> String? {
  guard width > 0, height > 0, !(sharedX && sharedY) else { return nil }
  let hw = width / 2 * view.upp
  let hh = height / 2 * view.uppY
  let lattice = axes.flatMap { $0.count == 2 ? $0 : nil }
  let (across, down) = (lattice?[0] ?? "x", lattice?[1] ?? "y")
  func range(_ map: AxisMap?, _ lo: Double, _ hi: Double) -> String {
    guard let map else { return formatRange(lo, hi) }
    return "\(formatRowNumber(toWorld(map, lo)))..\(formatRowNumber(toWorld(map, hi)))"
  }
  var parts: [String] = []
  if !sharedX { parts.append("\(across) = \(range(maps?.x, view.cx - hw, view.cx + hw))") }
  if !sharedY {
    let (lo, hi) = (view.cy - hh, view.cy + hh)
    parts.append("\(down) = \(lattice == nil ? range(maps?.y, lo, hi) : formatRange(-hi, -lo))")
  }
  for map in [maps?.x, maps?.y] {
    if let map { parts.append("\(map.axis.rawValue) = \(map.text)") }
  }
  if lattice != nil, parts.count == 2, let written, written.count == 2, written[0] == down, written[1] == across {
    parts.reverse()
  }
  if !sharedX, !sharedY, let ratio = view.ratio, ratio != 1 { parts.append("ratio = \(formatRowNumber(ratio))") }
  if locked { parts.append("locked") }
  return "view(\(parts.joined(separator: ", ")))"
}

/// The `camera(…)` row for a camera. A spun or eased camera accumulates
/// turns and float dust: the angle is written as it shows, in (-pi, pi], and
/// 0 for 0.
public func formatCameraRow(_ cam: Camera3D, spin: Double = 0, locked: Bool = false) -> String {
  let turn = 2 * Double.pi
  let theta = clean(cam.theta - turn * jsRound(cam.theta / turn))
  var parts = [formatRowNumber(theta), formatRowNumber(clean(cam.phi)), formatRowNumber(cam.radius)]
  let target = [cam.target.x, cam.target.y, cam.target.z].map { clean($0, cam.radius) }
  if target.contains(where: { $0 != 0 }) {
    parts.append("(\(target.map { formatRowNumber($0) }.joined(separator: ", ")))")
  }
  let turning = clean(spin)
  if turning != 0 { parts.append("spin = \(formatRowNumber(turning))") }
  if locked { parts.append("locked") }
  return "camera(\(parts.joined(separator: ", ")))"
}
