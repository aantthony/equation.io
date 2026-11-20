/// Viewport rows: the framing as document state (lib/view.ts, lib/panels.ts).
///
/// `view(x = -5..5, y = -2..2)` frames the 2D window, `camera(theta, phi,
/// radius, (tx, ty, tz))` aims the 3D orbit camera, `---` starts a new panel
/// and `grid(off)` says what draws behind a panel's plots. They are scanned
/// before expression parsing, because `,` binds tighter than `=` in the
/// grammar; the pieces between top-level commas are ordinary scalar
/// expressions, so `pi` and defined constants work.
///
/// Not ported: a view that maps its axes (`x = 10^X`, `(x, y) = …`), a
/// lattice view's index axes, `on(…)` surfaces, and `grid(r, theta)`.
public enum ViewSpec: Equatable, Sendable {
  /// [lo, hi] of each axis given (at least one is); `ratio` is pixels per y
  /// unit over pixels per x unit; `locked` pins the window.
  ///
  /// A lattice view names its index axes instead of x and y,
  /// `view(i = -60..60, n = 0..80)` (the row's `viewAxes`): x is then the
  /// range across and y the range down negated, since row n + 1 sits below
  /// row n.
  case view(x: [Double]?, y: [Double]?, ratio: Double?, locked: Bool)
  /// Orbit angles in radians; `spin` in radians per second.
  case camera(theta: Double, phi: Double, radius: Double?, target: [Double]?, spin: Double?, locked: Bool)
  /// A `---` divider: where the new panel goes (`place` nil splits along the
  /// longer side), its share of the panel it splits, and the axes it shares.
  case split(place: String?, corner: String?, size: Double?, sharedX: Bool, sharedY: Bool)
  /// `grid(off)`, `grid(axes)`, `grid(on)`.
  case grid(mode: String)

  public var kind: String {
    switch self {
    case .view: "view"
    case .camera: "camera"
    case .split: "split"
    case .grid: "grid"
    }
  }
}

let maxPanels = 8

private let dividerUsage =
  "Expected --- then where the panel goes (right, left, below, above, or inset top left), "
  + "a size like 40%, and optionally shared x or shared y."

/// `^(\d+(?:\.\d+)?)%$`
private func percentage(_ token: String) -> Double? {
  guard token.hasSuffix("%") else { return nil }
  let body = Array(token.utf16.dropLast())
  let whole = body.prefix(while: isDigit)
  guard !whole.isEmpty else { return nil }
  let rest = body.dropFirst(whole.count)
  if !rest.isEmpty {
    guard rest.first == unit("."), rest.count > 1, rest.dropFirst().allSatisfy(isDigit) else { return nil }
  }
  return Double(String(body))
}

/// Parse a divider row, or nil when the text is not one. `---x` and `--- x`
/// stay math (negations of x): only a bare run of dashes, or one followed by
/// a placement word or a size, is a divider (lib/panels.ts `parseDividerRow`).
func parseDividerRow(_ text: String) throws -> ViewSpec? {
  let u = Array(jsTrimmed(text).utf16)
  let dashes = u.prefix { $0 == unit("-") }.count
  guard dashes >= 3 else { return nil }
  // Split the rest on whitespace and commas.
  var tokens: [String] = []
  var cur: Units = []
  for c in Array(String(u[dashes...]).lowercased().utf16) {
    if isJSWhitespace(c) || c == unit(",") {
      if !cur.isEmpty { tokens.append(String(cur)) }
      cur = []
    } else {
      cur.append(c)
    }
  }
  if !cur.isEmpty { tokens.append(String(cur)) }
  let words: Set<String> = ["right", "left", "below", "above", "top", "bottom", "inset", "shared"]
  let corners: [String: (String, String)] = [
    "top-left": ("top", "left"), "top-right": ("top", "right"), "bottom-left": ("bottom", "left"),
    "bottom-right": ("bottom", "right"),
  ]
  if let first = tokens.first, !words.contains(first), percentage(first) == nil, corners[first] == nil { return nil }
  var size: Double?
  var vertical: String?
  var horizontal: String?
  var inset = false
  var sharedX = false
  var sharedY = false
  func setVertical(_ v: String) throws {
    if let vertical, vertical != v { throw LanguageError("A divider names both top and bottom.") }
    vertical = v
  }
  func setHorizontal(_ h: String) throws {
    if let horizontal, horizontal != h { throw LanguageError("A divider names both left and right.") }
    horizontal = h
  }
  func axes(_ token: String?) -> Bool {
    guard let token, !token.isEmpty else { return false }
    return token.utf16.allSatisfy { $0 == unit("x") || $0 == unit("y") }
  }
  var i = 0
  while i < tokens.count {
    let tok = tokens[i]
    if let pct = percentage(tok) {
      if size != nil { throw LanguageError("A divider sets its size twice.") }
      if pct <= 0 || pct >= 100 { throw LanguageError("A panel size is a percentage between 0% and 100%.") }
      size = pct / 100
    } else if let corner = corners[tok] {
      inset = true
      try setVertical(corner.0)
      try setHorizontal(corner.1)
    } else if tok == "inset" {
      inset = true
    } else if tok == "top" || tok == "above" {
      try setVertical("top")
    } else if tok == "bottom" || tok == "below" {
      try setVertical("bottom")
    } else if tok == "left" || tok == "right" {
      try setHorizontal(tok)
    } else if tok == "shared" {
      if !axes(i + 1 < tokens.count ? tokens[i + 1] : nil) {
        throw LanguageError("shared names the axes the panels share: shared x, shared y.")
      }
      while axes(i + 1 < tokens.count ? tokens[i + 1] : nil) {
        i += 1
        if tokens[i].contains("x") { sharedX = true }
        if tokens[i].contains("y") { sharedY = true }
      }
    } else {
      throw LanguageError("\"\(tok)\" is not a divider option. \(dividerUsage)")
    }
    i += 1
  }
  var place: String?
  var corner: String?
  if inset {
    place = "inset"
    corner = "\(vertical ?? "top")-\(horizontal ?? "right")"
  } else if let vertical, let horizontal {
    throw LanguageError(
      "A split goes one way — for a floating corner panel write --- inset \(vertical) \(horizontal).")
  } else if let vertical {
    place = vertical == "top" ? "above" : "below"
  } else if let horizontal {
    place = horizontal
  }
  return .split(place: place, corner: corner, size: size, sharedX: sharedX, sharedY: sharedY)
}

/// Whether the text is a divider row, well-formed or not.
func isDividerRow(_ text: String) -> Bool {
  do {
    return try parseDividerRow(text) != nil
  } catch {
    return true
  }
}

/// `^\s*name\s*\(([\s\S]*)\)\s*$`: the text between a call's parentheses
/// when the call is the whole row.
private func wholeCallBody(_ text: String, _ name: String) -> String? {
  var s = RowScanner(text)
  s.space()
  guard s.eat(word: name) else { return nil }
  s.space()
  guard s.eat("(") else { return nil }
  let end = jsTrimEnd(s.u[...])
  guard end.last == unit(")"), end.endIndex - 1 >= s.i else { return nil }
  return String(s.u[s.i..<(end.endIndex - 1)])
}

/// The call a row opens with, of view, camera, grid and on:
/// `^\s*(view|camera|grid|on)\s*\(`.
func viewHead(_ text: String, ignoringCase: Bool = false) -> String? {
  for name in ["view", "camera", "grid", "on"] {
    var s = RowScanner(ignoringCase ? text.lowercased() : text)
    s.space()
    guard s.eat(word: name) else { continue }
    s.space()
    if s.eat("(") { return name }
  }
  return nil
}

/// A viewport row by its text: a `---` divider, or a view/camera/grid/on
/// call that is not the definition of a function by that name, `grid(x) = …`
/// (lib/analysis.ts `isViewportText`). `text` is trimmed.
func isViewportText(_ text: String) -> Bool {
  isDividerRow(text) || (viewHead(text, ignoringCase: true) != nil && scanDefinition(text) == nil)
}

/// Split on top-level commas only, so a (tx, ty, tz) target stays one arg.
private func splitArgs(_ s: String) -> [String] {
  var parts: [Units] = []
  var depth = 0
  var cur: Units = []
  for ch in s.utf16 {
    if ch == unit("(") || ch == unit("[") || ch == unit("{") {
      depth += 1
    } else if ch == unit(")") || ch == unit("]") || ch == unit("}") {
      depth = max(0, depth - 1)
    }
    if ch == unit(",") && depth == 0 {
      parts.append(cur)
      cur = []
    } else {
      cur.append(ch)
    }
  }
  parts.append(cur)
  return parts.map { jsTrimmed(String($0)) }.filter { !$0.isEmpty }
}

/// Split `lo..hi` at the top-level `..`, or nil when there is none.
private func splitRange(_ s: String) -> (String, String)? {
  let u = Array(s.utf16)
  var depth = 0
  for (i, ch) in u.enumerated() {
    if ch == unit("(") || ch == unit("[") || ch == unit("{") {
      depth += 1
    } else if ch == unit(")") || ch == unit("]") || ch == unit("}") {
      depth = max(0, depth - 1)
    } else if ch == unit("."), i + 1 < u.count, u[i + 1] == unit("."), depth == 0 {
      return (String(u[..<i]), String(u[(i + 2)...]))
    }
  }
  return nil
}

private func numExpr(_ e: Expr, _ env: [String: Double], _ what: String) throws -> Double {
  let v: Double
  do {
    v = try evaluate(e, env)
  } catch {
    throw LanguageError("\(what): \(errorMessage(error))")
  }
  if !v.isFinite { throw LanguageError("\(what) is not a finite number.") }
  return v
}

private func num(_ src: String, _ env: [String: Double], _ what: String) throws -> Double {
  let parsed: Expr
  do {
    parsed = try parseExpr(src)
  } catch {
    throw LanguageError("\(what): \(error.message)")
  }
  return try numExpr(parsed, env, what)
}

/// `^([A-Za-z]\w*)\s*=\s*([\s\S]+)$`
private func namedArg(_ arg: String) -> (name: String, value: String)? {
  let u = Array(arg.utf16)
  guard let first = u.first, isASCIILetter(first) else { return nil }
  var i = 1
  while i < u.count, isASCIILetter(u[i]) || isDigit(u[i]) || u[i] == unit("_") { i += 1 }
  let name = String(u[..<i])
  while i < u.count, isJSWhitespace(u[i]) { i += 1 }
  guard i < u.count, u[i] == unit("=") else { return nil }
  i += 1
  while i < u.count, isJSWhitespace(u[i]) { i += 1 }
  guard i < u.count else { return nil }
  return (name, String(u[i...]))
}

/// Whether `word` stands alone in the text (`\bword\b`).
private func mentionsWord(_ text: String, _ word: String) -> Bool {
  let u = Array(text.utf16)
  let w = Array(word.utf16)
  func isWord(_ c: UInt16) -> Bool { isASCIILetter(c) || isDigit(c) || c == unit("_") }
  guard u.count >= w.count else { return false }
  for start in 0...(u.count - w.count) where Array(u[start..<(start + w.count)]) == w {
    if start > 0, isWord(u[start - 1]) { continue }
    if start + w.count < u.count, isWord(u[start + w.count]) { continue }
    return true
  }
  return false
}

/// Parse a viewport row. Returns nil when the text is not one (so ordinary
/// rows fall through to the expression parser); throws a row-friendly error
/// when it is one but malformed. `env` supplies constant values at t = 0.
func parseViewRow(_ text: String, _ env: [String: Double]) throws -> ViewSpec? {
  var axes: [String]?
  return try parseViewRow(text, env, latticeAxes: &axes)
}

/// `latticeAxes` comes back as the index axes a lattice view names, [across,
/// down] as written (the second empty when it names only one): the site's
/// `View2DSpec.axes`.
func parseViewRow(_ text: String, _ env: [String: Double], latticeAxes: inout [String]?) throws -> ViewSpec? {
  if let split = try parseDividerRow(text) { return split }
  if let body = wholeCallBody(text, "grid") {
    let args = body.split(separator: ",", omittingEmptySubsequences: false).map { jsTrimmed(String($0)) }
      .filter { !$0.isEmpty }
    if args.isEmpty || args.count > 3 {
      throw LanguageError("Expected grid(off), grid(axes), grid(on), or grid(r, theta) naming coordinates.")
    }
    let word = args[0].lowercased()
    if args.count == 1, ["off", "none", "axes", "on"].contains(word) {
      return .grid(mode: word == "none" ? "off" : word)
    }
    throw Unsupported("a grid of named coordinates")
  }
  let head: String
  let inner: String
  if let body = wholeCallBody(text, "view") {
    (head, inner) = ("view", body)
  } else if let body = wholeCallBody(text, "camera") {
    (head, inner) = ("camera", body)
  } else if wholeCallBody(text, "on") != nil {
    throw Unsupported("panels drawn on a surface (on(…))")
  } else {
    return nil
  }
  var args = splitArgs(inner)
  // A bare `locked` pins the panel; it may sit anywhere among the arguments.
  let lockAt = args.firstIndex { $0.lowercased() == "locked" }
  let locked = lockAt != nil
  if let lockAt { args.remove(at: lockAt) }
  if head == "view" {
    let usage = "Expected view(x = lo..hi, y = lo..hi, ratio = 1, locked) — either axis alone works."
    if args.isEmpty || args.count > 5 { throw LanguageError(usage) }
    var x: [Double]?
    var y: [Double]?
    var ratio: Double?
    var lattice: [(axis: String, range: [Double])] = []
    for arg in args {
      // `(x, y) = (Y cos X, Y sin X)`: both coordinates from the screen at once.
      var plane = RowScanner(arg)
      if plane.eat("(") {
        plane.space()
        if plane.eat("x") {
          plane.space()
          if plane.eat(",") {
            plane.space()
            if plane.eat("y") {
              plane.space()
              if plane.eat(")") {
                plane.space()
                if plane.eat("=") { throw Unsupported("a view that maps its axes") }
              }
            }
          }
        }
      }
      guard let named = namedArg(arg) else { throw LanguageError(usage) }
      let axis = named.name
      if axis == "ratio" {
        if ratio != nil { throw LanguageError("view(...) sets ratio twice.") }
        let value = try num(named.value, env, "view ratio")
        if value <= 0 { throw LanguageError("The view ratio must be positive.") }
        ratio = value
        continue
      }
      let range = splitRange(named.value)
      // `x = 10^X`: no range, and the screen's X, so a map from the screen to x.
      if range == nil, axis == "x" || axis == "y", mentionsWord(named.value, axis.uppercased()) {
        throw Unsupported("a view that maps its axes")
      }
      if (axis == "x" ? x : axis == "y" ? y : nil) != nil || lattice.contains(where: { $0.axis == axis }) {
        throw LanguageError("view(...) sets \(axis) twice.")
      }
      guard let range else { throw LanguageError(usage) }
      let lo = try num(range.0, env, "view \(axis) lower bound")
      let hi = try num(range.1, env, "view \(axis) upper bound")
      if lo >= hi {
        throw LanguageError("view \(axis) range needs lo < hi (got \(JS.string(lo))..\(JS.string(hi))).")
      }
      // Any other letter names an index axis: the view is a lattice.
      if axis == "x" { x = [lo, hi] } else if axis == "y" { y = [lo, hi] } else { lattice.append((axis, [lo, hi])) }
    }
    if !lattice.isEmpty {
      if x != nil || y != nil || lattice.count > 2 {
        throw LanguageError(
          "A lattice view names its index axes, across then down: view(i = -60..60, n = 0..80). "
            + "The plane is framed with x and y.")
      }
      if lattice.count == 1 {
        // One axis, as a panel sharing the other writes it: taken as across
        // here, and turned down by orientLattice when that is its axis.
        latticeAxes = [lattice[0].axis, ""]
        x = lattice[0].range
      } else {
        latticeAxes = [lattice[0].axis, lattice[1].axis]
        x = lattice[0].range
        y = [-lattice[1].range[1], -lattice[1].range[0]]
      }
    }
    if x == nil && y == nil { throw LanguageError(usage) }
    return .view(x: x, y: y, ratio: ratio, locked: locked)
  }
  let usage = "Expected camera(theta, phi, radius?, (x, y, z)?, spin = rate?, locked?) — angles in radians."
  // spin = … is named and comes last, so the positional arguments keep their meaning.
  var spinText: String?
  if let last = args.last {
    var s = RowScanner(last)
    s.space()
    if s.eat(word: "spin") {
      s.space()
      if s.eat("=") {
        spinText = String(s.u[s.i...])
        args.removeLast()
      }
    }
  }
  if args.count < 2 || args.count > 4 { throw LanguageError(usage) }
  let theta = try num(args[0], env, "camera theta")
  let phi = try num(args[1], env, "camera phi")
  var radius: Double?
  var target: [Double]?
  for arg in args.dropFirst(2) {
    guard let parsed = try? parseExpr(arg) else { throw LanguageError(usage) }
    if case .vec(let items) = parsed {
      if target != nil { throw LanguageError("camera(...) sets the target twice.") }
      if items.count != 3 { throw LanguageError("The camera target needs 3 components: (x, y, z).") }
      target = try items.map { try numExpr($0, env, "camera target") }
    } else {
      if radius != nil { throw LanguageError("camera(...) sets the radius twice.") }
      let r = try num(arg, env, "camera radius")
      if r <= 0 { throw LanguageError("The camera radius must be positive.") }
      radius = r
    }
  }
  var spin: Double?
  if let spinText {
    if jsTrimmed(spinText).isEmpty { throw LanguageError(usage) }
    let value = try num(spinText, env, "camera spin")
    if value != 0 { spin = value }
  }
  return .camera(theta: theta, phi: phi, radius: radius, target: target, spin: spin, locked: locked)
}
