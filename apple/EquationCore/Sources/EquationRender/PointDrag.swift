import EquationCore
import Foundation

// Draggable points: lib/drag.ts, and the part of web/main.ts that wires it
// up (`makePairWriter`, `pointWriter`, `defPointWriter`, `pointAt`).
//
// A point row whose coordinates are plain numbers or bare slider names can
// be picked up and moved on the graph; the drag rewrites those numbers, so
// the rows stay the source of truth and the move is undoable. Coordinates
// that are computed — (2cos(t), 2sin(t)), (a+1, b) — have nothing to write
// back to and stay pinned on that axis.

/// The two top-level coordinates of `(A, B)`, or nil if it is not a pair.
public func splitPair(_ text: String) -> (String, String)? {
  guard text.hasPrefix("("), text.hasSuffix(")"), text.count >= 2 else { return nil }
  let inner = Array(text.dropFirst().dropLast())
  var parts: [String] = []
  var depth = 0
  var start = 0
  for (i, c) in inner.enumerated() {
    if c == "(" || c == "[" {
      depth += 1
    } else if c == ")" || c == "]" {
      depth -= 1
    } else if c == ",", depth == 0 {
      parts.append(String(inner[start..<i]))
      start = i + 1
    }
    // The outer parentheses don't wrap the whole row.
    if depth < 0 { return nil }
  }
  guard depth == 0 else { return nil }
  parts.append(String(inner[start...]))
  guard parts.count == 2 else { return nil }
  let trim = { (s: String) in s.trimmingCharacters(in: .whitespacesAndNewlines) }
  return (trim(parts[0]), trim(parts[1]))
}

/// /^-?(?:\d+\.?\d*|\.\d+)$/ — a number a drag rewrites in place.
private func isNumberLiteral(_ text: String) -> Bool {
  var s = Substring(text)
  if s.hasPrefix("-") { s = s.dropFirst() }
  let whole = s.prefix { $0.isASCII && $0.isNumber }
  var rest = s.dropFirst(whole.count)
  if whole.isEmpty {
    guard rest.hasPrefix(".") else { return false }
    rest = rest.dropFirst()
    return !rest.isEmpty && rest.allSatisfy { $0.isASCII && $0.isNumber }
  }
  if rest.hasPrefix(".") { rest = rest.dropFirst() }
  return rest.allSatisfy { $0.isASCII && $0.isNumber }
}

/// `Math.round`: halves go up.
func jsRound(_ v: Double) -> Double { (v + 0.5).rounded(.down) }

/// Round to roughly a pixel, so dragging writes short, readable numbers
/// (web/main.ts `snapToPixel`). `upp` is the axis's math units per pixel.
public func snapToPixel(_ v: Double, upp: Double) -> Double {
  guard upp > 0, upp.isFinite else { return v }
  let step = pow(10, log10(upp * 3).rounded(.down))
  return jsRound(v / step) * step
}

/// A point of the document a drag can move, and where it is.
public struct GrabPoint: Equatable, Sendable {
  /// The row that draws it.
  public var row: Int
  public var x: Double
  public var y: Double
}

/// How a row's point is written: the pair's text, and the row around it.
private struct PairRow {
  var pair: String
  /// The row's code with a new pair in place of the old.
  var code: (String) -> String
}

/// The pair a point row holds: `(1, 2)` itself, or the right-hand side of `A = (1, 2)`.
private func pairRow(_ row: RowAnalysis) -> PairRow? {
  guard row.error == nil, row.unsupported == nil else { return nil }
  if case .constant(let name, let rhs, false)? = row.definition {
    return PairRow(pair: rhs.trimmingCharacters(in: .whitespacesAndNewlines)) { "\(name) = \($0)" }
  }
  guard row.definition == nil, case .point(2, _)? = row.cpu else { return nil }
  return PairRow(pair: row.text) { $0 }
}

/// How each coordinate of a pair answers a drag: a literal is rewritten in
/// place, a slider's name moves through its own row (the row's index), and
/// nil stays pinned. Nil when the text is not a pair or nothing of it moves
/// (lib/drag.ts `dragAxes`).
private enum DragAxis: Equatable {
  case literal
  case slider(row: Int)
}

private func dragAxes(_ pair: String, _ analysis: DocumentAnalysis) -> (parts: [String], axes: [DragAxis?])? {
  guard let (a, b) = splitPair(pair) else { return nil }
  let axes = [a, b].map { part -> DragAxis? in
    if isNumberLiteral(part) { return .literal }
    // Sliders live under canonical names: (r₁, 2) drags r_1's row.
    let name = canonicalName(part)
    let row = analysis.rows.firstIndex { row in
      if case .constant(name, _, false)? = row.definition { return row.slider != nil && row.error == nil }
      return false
    }
    return row.map { .slider(row: $0) }
  }
  return axes.contains { $0 != nil } ? ([a, b], axes) : nil
}

extension DocumentAnalysis {
  /// The points among `rows` (a panel's) that a drag can move, where they
  /// are when the constants are `env` (which has t).
  public func grabPoints(rows: Range<Int>, env: [String: Double]) -> [GrabPoint] {
    var points: [GrabPoint] = []
    for index in rows where index < self.rows.count {
      let row = self.rows[index]
      guard let written = pairRow(row), dragAxes(written.pair, self) != nil else { continue }
      var at: (Double?, Double?)
      if let name = row.definition?.name {
        guard env["\(name)_z"] == nil else { continue }
        at = (env["\(name)_x"], env["\(name)_y"])
      } else if case .point(2, let coords)? = row.cpu, coords.count == 2 {
        at = (try? evaluate(coords[0], env), try? evaluate(coords[1], env))
      }
      guard let x = at.0, let y = at.1, x.isFinite, y.isFinite else { continue }
      points.append(GrabPoint(row: index, x: x, y: y))
    }
    return points
  }

  /// The document's rows with the point of row `index` moved to (x, y),
  /// each coordinate rounded to about a pixel (`upp`: math units per pixel
  /// along x and y). Nil when the row holds no point a drag can move, or
  /// when nothing changes.
  public func movingPoint(
    row index: Int, to x: Double, _ y: Double, upp: (x: Double, y: Double), in sources: [String]
  ) -> [String]? {
    guard rows.indices.contains(index), sources.indices.contains(index),
      let written = pairRow(rows[index]), let drag = dragAxes(written.pair, self)
    else { return nil }
    var out = sources
    var text = drag.parts
    for (k, axis) in drag.axes.enumerated() {
      let value = snapToPixel(k == 0 ? x : y, upp: k == 0 ? upp.x : upp.y)
      switch axis {
      case .literal?:
        // The site's `fmtNum`: six significant digits.
        text[k] = JS.string(Double(String(format: "%.5e", value)) ?? value)
      case .slider(let row)?:
        if sources.indices.contains(row), let moved = settingSlider(row: row, to: value, in: out[row]) {
          out[row] = moved
        }
      case nil:
        break
      }
    }
    out[index] = keepNote(sources[index], written.code("(\(text[0]), \(text[1]))"))
    return out == sources ? nil : out
  }
}

/// The grab radius, in points (web/main.ts `GRAB_PX`).
public let grabRadius = 14.0

/// The nearest of `points` within `radius` screen points of the math point
/// (mx, my), in a window of `upp` math units per screen point across and
/// `uppY` up (web/main.ts `pointAt`).
public func grabPoint(
  _ points: [GrabPoint], at mx: Double, _ my: Double, upp: Double, uppY: Double, radius: Double = grabRadius
) -> GrabPoint? {
  var best: GrabPoint?
  var bestDistance = radius
  for p in points {
    let d = hypot((p.x - mx) / upp, (p.y - my) / uppY)
    if d <= bestDistance {
      bestDistance = d
      best = p
    }
  }
  return best
}
