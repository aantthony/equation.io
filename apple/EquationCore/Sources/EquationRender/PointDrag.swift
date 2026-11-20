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
  if let definition = row.definition, case .constant(_, let rhs, false) = definition {
    // (`:=` and the written name are kept: lib/defs.ts `definitionHead`.)
    let head = definitionHead(definition, row.text)
    return PairRow(pair: rhs.trimmingCharacters(in: .whitespacesAndNewlines)) { "\(head) \($0)" }
  }
  guard row.definition == nil, case .point(2, _)? = row.cpu else { return nil }
  return PairRow(pair: row.text) { $0 }
}

/// How each coordinate of a pair answers a drag: a literal is rewritten in
/// place, a slider's name moves through its own row (the row's index), and
/// nil stays pinned, as does a name in `pinned`. Nil when the text is not a
/// pair or nothing of it moves (lib/drag.ts `dragAxes`).
private enum DragAxis: Equatable {
  case literal
  case slider(row: Int)
}

private func dragAxes(
  _ pair: String, _ analysis: DocumentAnalysis, pinned: Set<String> = []
) -> (parts: [String], axes: [DragAxis?])? {
  guard let (a, b) = splitPair(pair) else { return nil }
  let axes = [a, b].map { part -> DragAxis? in
    if isNumberLiteral(part) { return .literal }
    // Sliders live under canonical names: (r₁, 2) drags r_1's row; a
    // redefined built-in's under its alias (lib/env.ts `boundIn`).
    let name = boundName(canonicalName(part), analysis.valueNames)
    if pinned.contains(name) { return nil }
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
  /// are when the constants are `env` (which has t). The names in `pinned`
  /// are held still: a slider the panel's surface reads, which would move
  /// the point under the drag (web/main.ts `defPointWriter`).
  public func grabPoints(rows: Range<Int>, env: [String: Double], pinned: Set<String> = []) -> [GrabPoint] {
    var points: [GrabPoint] = []
    for index in rows where index < self.rows.count {
      let row = self.rows[index]
      guard let written = pairRow(row), dragAxes(written.pair, self, pinned: pinned) != nil else { continue }
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
    row index: Int, to x: Double, _ y: Double, upp: (x: Double, y: Double), pinned: Set<String> = [],
    in sources: [String]
  ) -> [String]? {
    guard rows.indices.contains(index), sources.indices.contains(index),
      let written = pairRow(rows[index]), let drag = dragAxes(written.pair, self, pinned: pinned)
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

/// A point placed by its coordinates' names — `(r, theta) = (2, 0.8)`, a
/// system whose plan has `coordinates` — is dragged by evaluating those
/// coordinates where the pointer is and writing them back as the right-hand
/// pair (web/main.ts `coordinatePointWriter`, lib/drag.ts `coordinateDragWriter`).
extension DocumentAnalysis {
  /// The row's coordinates and its right-hand pair, where it is such a point.
  private func coordinateRow(_ index: Int, _ source: String) -> (coords: [Expr], lhs: String, pair: String)? {
    guard rows.indices.contains(index), rows[index].error == nil, rows[index].unsupported == nil,
      case .system(2, _, false, _, let coords?)? = rows[index].cpu, coords.count == 2
    else { return nil }
    let code = stripNote(source)
    guard let at = code.firstIndex(of: "=") else { return nil }
    let trim = { (s: Substring) in s.trimmingCharacters(in: .whitespacesAndNewlines) }
    return (coords, trim(code[..<at]), trim(code[code.index(after: at)...]))
  }

  /// The names the row's coordinates read, where it is a point placed by
  /// them: a slider among those (or among what they are made of) changes the
  /// chart itself, and is held still under a drag.
  public func coordinateNames(row index: Int) -> [String]? {
    coordinateRow(index, rows.indices.contains(index) ? rows[index].text : "").map { found in
      found.coords.flatMap { Array(freeVars($0)) }
    }
  }

  /// Whether a drag can move the point of row `index`: it is placed by its
  /// coordinates' names and some coordinate of its pair is a number, or a
  /// slider not among `pinned`.
  public func movesCoordinatePoint(row index: Int, pinned: Set<String> = []) -> Bool {
    guard rows.indices.contains(index), let found = coordinateRow(index, rows[index].text) else { return false }
    return dragAxes(found.pair, self, pinned: pinned) != nil
  }

  /// The document's rows with the point of row `index` moved to (x, y) of
  /// the plane, each rounded to about a pixel there before the coordinates
  /// are evaluated ("pixel precision belongs to Cartesian space, before
  /// changing units"). `env` has the constants and t. Nil when the row holds
  /// no such point, the coordinates have no value there, or nothing changes.
  public func movingCoordinatePoint(
    row index: Int, to x: Double, _ y: Double, upp: (x: Double, y: Double), env: [String: Double],
    pinned: Set<String> = [], in sources: [String]
  ) -> [String]? {
    guard sources.indices.contains(index), let found = coordinateRow(index, sources[index]),
      let drag = dragAxes(found.pair, self, pinned: pinned)
    else { return nil }
    var scope = env
    scope["x"] = snapToPixel(x, upp: upp.x)
    scope["y"] = snapToPixel(y, upp: upp.y)
    // (A singular coordinate keeps the previous values.)
    let values = found.coords.map { (try? evaluate($0, scope)) ?? .nan }
    guard values.allSatisfy(\.isFinite) else { return nil }
    var out = sources
    var text = drag.parts
    for (k, axis) in drag.axes.enumerated() {
      switch axis {
      case .literal?:
        text[k] = JS.string(Double(String(format: "%.5e", values[k])) ?? values[k])
      case .slider(let row)?:
        if sources.indices.contains(row), let moved = settingSlider(row: row, to: values[k], in: out[row]) {
          out[row] = moved
        }
      case nil:
        break
      }
    }
    out[index] = keepNote(sources[index], "\(found.lhs) = (\(text[0]), \(text[1]))")
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
