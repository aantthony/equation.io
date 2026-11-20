/// Viewport rows: the framing as document state (lib/view.ts, lib/panels.ts).
///
/// `view(x = -5..5, y = -2..2)` frames the 2D window, `camera(theta, phi,
/// radius, (tx, ty, tz))` aims the 3D orbit camera, `---` starts a new panel
/// and `grid(off)` says what draws behind a panel's plots. They are scanned
/// before expression parsing, because `,` binds tighter than `=` in the
/// grammar; the pieces between top-level commas are ordinary scalar
/// expressions, so `pi` and defined constants work.
///
public enum ViewSpec: Equatable, Sendable {
  /// [lo, hi] of each axis given (at least one is); `ratio` is pixels per y
  /// unit over pixels per x unit; `locked` pins the window.
  ///
  /// A lattice view names its index axes instead of x and y,
  /// `view(i = -60..60, n = 0..80)` (the row's `viewAxes`): x is then the
  /// range across and y the range down negated, since row n + 1 sits below
  /// row n.
  case view(x: [Double]?, y: [Double]?, ratio: Double?, locked: Bool)
  /// A view that maps an axis, `view(x = 1..1000, x = 10^X)`: x is 10^X, X
  /// the panel's linear screen coordinate (AxisMap.swift). Here x and y hold
  /// the window in screen units — the row writes it in x units. Or both at
  /// once, `view((x, y) = (Y cos(X), Y sin(X)), X = -pi..pi, Y = 0..4)`
  /// (`maps.plane`, PlaneMap.swift): the window is the screen's, X and Y.
  case mappedView(x: [Double]?, y: [Double]?, ratio: Double?, locked: Bool, maps: AxisMaps)
  /// Orbit angles in radians; `spin` in radians per second.
  case camera(theta: Double, phi: Double, radius: Double?, target: [Double]?, spin: Double?, locked: Bool)
  /// A `---` divider: where the new panel goes (`place` nil splits along the
  /// longer side), its share of the panel it splits, and the axes it shares.
  case split(place: String?, corner: String?, size: Double?, sharedX: Bool, sharedY: Bool)
  /// `grid(off)`, `grid(axes)`, `grid(on)`.
  case grid(mode: String)
  /// `grid(r, theta)`: exactly those coordinates' level sets (Grid.swift);
  /// `grid(x, y)` the Cartesian grid even where coordinate fields are defined.
  case gridCoords([String])
  /// `on((X, Y, Z) = (…), x = lo..hi, y = lo..hi)`: the surface the panel's
  /// 2D rows are drawn on (SurfaceMap.swift).
  case surface(SurfaceMap)

  public var kind: String {
    switch self {
    case .view, .mappedView: "view"
    case .camera: "camera"
    case .split: "split"
    case .grid, .gridCoords: "grid"
    case .surface: "surface"
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

private func num(_ src: String, _ env: [String: Double], _ what: String, _ valueNames: Set<String>) throws
  -> Double
{
  let parsed: Expr
  do {
    parsed = try parseExpr(src, valueNames: valueNames)
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

/// `^\(\s*x\s*,\s*y\s*\)\s*=\s*([\s\S]+)$`: the right side of a plane map.
private func planeArg(_ arg: String) -> String? {
  var s = RowScanner(arg)
  guard s.eat("(") else { return nil }
  for (name, close) in [("x", ","), ("y", ")")] as [(Unicode.Scalar, Unicode.Scalar)] {
    s.space()
    guard s.eat(name) else { return nil }
    s.space()
    guard s.eat(close) else { return nil }
  }
  s.space()
  guard s.eat("=") else { return nil }
  s.space()
  return s.atEnd ? nil : String(s.u[s.i...])
}

/// A view row with a plane map: its window is the screen's, X and Y (`planeView`).
private func planeView(
  x: [Double]?, y: [Double]?, ratio: Double?, locked: Bool, maps: AxisMaps,
  _ ranges: [(axis: String, range: [Double])]
) throws -> ViewSpec {
  if maps.x != nil || maps.y != nil {
    throw LanguageError(
      "A view maps (x, y) together or x and y one at a time, not both: drop the x = … or y = … map.")
  }
  if x != nil || y != nil {
    throw LanguageError(
      "With (x, y) mapped, the window is the screen’s, which x and y need not frame: give X = lo..hi, Y = lo..hi.")
  }
  var (x, y) = (x, y)
  for (axis, range) in ranges {
    if axis != "X" && axis != "Y" {
      throw LanguageError("A view mapping (x, y) is framed by X and Y, not \(axis).")
    }
    if axis == "X" { x = range } else { y = range }
  }
  // A map alone frames the screen around its origin.
  if x == nil && y == nil { (x, y) = ([-5, 5], [-5, 5]) }
  return .mappedView(x: x, y: y, ratio: ratio, locked: locked, maps: AxisMaps(plane: maps.plane))
}

/// Parse a viewport row. Returns nil when the text is not one (so ordinary
/// rows fall through to the expression parser); throws a row-friendly error
/// when it is one but malformed. `env` supplies constant values at t = 0.
func parseViewRow(
  _ text: String, _ env: [String: Double], documentNames: Set<String> = [], valueNames: Set<String> = [],
  mapDoc: MapDoc = MapDoc()
) throws -> ViewSpec? {
  var axes: [String]?
  return try parseViewRow(
    text, env, documentNames: documentNames, valueNames: valueNames, mapDoc: mapDoc, latticeAxes: &axes)
}

/// `latticeAxes` comes back as the index axes a lattice view names, [across,
/// down] as written (the second empty when it names only one): the site's
/// `View2DSpec.axes`.
/// `documentNames` are the names the document defines, which a map's bare
/// function name may be one of; `mapDoc` what a map's Σ bounds need of the
/// document besides (MapSums.swift).
func parseViewRow(
  _ text: String, _ env: [String: Double], documentNames: Set<String> = [], valueNames: Set<String> = [],
  mapDoc: MapDoc = MapDoc(), latticeAxes: inout [String]?
) throws -> ViewSpec? {
  // The row's maps write out their sums under one limit, as a row's tuple does.
  var doc = mapDoc
  (doc.documentNames, doc.valueNames, doc.budget) = (documentNames, valueNames, ResolveCtx())
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
    return .gridCoords(try parseGridCoords(args))
  }
  let head: String
  let inner: String
  if let body = wholeCallBody(text, "view") {
    (head, inner) = ("view", body)
  } else if let body = wholeCallBody(text, "camera") {
    (head, inner) = ("camera", body)
  } else if let body = wholeCallBody(text, "on") {
    return try parseSurfaceRow(body, env, doc)
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
    var maps = AxisMaps()
    for arg in args {
      // `(x, y) = (Y cos X, Y sin X)`: both coordinates from the screen at once.
      if let plane = planeArg(arg) {
        if maps.plane != nil { throw LanguageError("view(...) maps (x, y) twice.") }
        maps.plane = try parsePlaneMap(plane, env: env, doc: doc)
        continue
      }
      guard let named = namedArg(arg) else { throw LanguageError(usage) }
      let axis = named.name
      if axis == "ratio" {
        if ratio != nil { throw LanguageError("view(...) sets ratio twice.") }
        let value = try num(named.value, env, "view ratio", valueNames)
        if value <= 0 { throw LanguageError("The view ratio must be positive.") }
        ratio = value
        continue
      }
      let range = splitRange(named.value)
      // `x = 10^X`: no range, and the screen's X, so a map from the screen to x.
      if range == nil, let mapped = AxisMap.Axis(rawValue: axis), mentionsWord(named.value, mapped.screen) {
        if maps[mapped] != nil { throw LanguageError("view(...) maps \(axis) twice.") }
        let map = try parseAxisMap(mapped, named.value, env: env, doc: doc)
        if mapped == .x { maps.x = map } else { maps.y = map }
        continue
      }
      if (axis == "x" ? x : axis == "y" ? y : nil) != nil || lattice.contains(where: { $0.axis == axis }) {
        throw LanguageError("view(...) sets \(axis) twice.")
      }
      guard let range else { throw LanguageError(usage) }
      let lo = try num(range.0, env, "view \(axis) lower bound", valueNames)
      let hi = try num(range.1, env, "view \(axis) upper bound", valueNames)
      if lo >= hi {
        throw LanguageError("view \(axis) range needs lo < hi (got \(JS.string(lo))..\(JS.string(hi))).")
      }
      // Any other letter names an index axis: the view is a lattice.
      if axis == "x" { x = [lo, hi] } else if axis == "y" { y = [lo, hi] } else { lattice.append((axis, [lo, hi])) }
    }
    if maps.plane != nil {
      return try planeView(x: x, y: y, ratio: ratio, locked: locked, maps: maps, lattice)
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
    if maps.x != nil || maps.y != nil {
      if !lattice.isEmpty { throw LanguageError("A lattice view cannot map its axes.") }
      if let map = maps.x, let range = x { x = try windowToScreen(map, range[0], range[1]) }
      if let map = maps.y, let range = y { y = try windowToScreen(map, range[0], range[1]) }
      // A map alone frames its axis around the screen's origin, when it can.
      if x == nil && y == nil, let map = maps.x ?? maps.y {
        let axis = map.axis.rawValue
        if !screenWindowOk(map, -5, 5) {
          throw LanguageError("Give \(axis) a range that \(axis) = \(map.text) can show, like \(axis) = 1..10.")
        }
        if map.axis == .x { x = [-5, 5] } else { y = [-5, 5] }
      }
      return .mappedView(x: x, y: y, ratio: ratio, locked: locked, maps: maps)
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
  let theta = try num(args[0], env, "camera theta", valueNames)
  let phi = try num(args[1], env, "camera phi", valueNames)
  var radius: Double?
  var target: [Double]?
  for arg in args.dropFirst(2) {
    guard let parsed = try? parseExpr(arg, valueNames: valueNames) else { throw LanguageError(usage) }
    if case .vec(let items) = parsed {
      if target != nil { throw LanguageError("camera(...) sets the target twice.") }
      if items.count != 3 { throw LanguageError("The camera target needs 3 components: (x, y, z).") }
      target = try items.map { try numExpr($0, env, "camera target") }
    } else {
      if radius != nil { throw LanguageError("camera(...) sets the radius twice.") }
      let r = try num(arg, env, "camera radius", valueNames)
      if r <= 0 { throw LanguageError("The camera radius must be positive.") }
      radius = r
    }
  }
  var spin: Double?
  if let spinText {
    if jsTrimmed(spinText).isEmpty { throw LanguageError(usage) }
    let value = try num(spinText, env, "camera spin", valueNames)
    if value != 0 { spin = value }
  }
  return .camera(theta: theta, phi: phi, radius: radius, target: target, spin: spin, locked: locked)
}

/// `on((X, Y, Z) = (…), x = lo..hi, y = lo..hi)`: the surface the panel's 2D
/// rows are drawn on (lib/view.ts `parseSurfaceRow`).
private func parseSurfaceRow(_ inner: String, _ env: [String: Double], _ doc: MapDoc) throws -> ViewSpec {
  let valueNames = doc.valueNames
  let args = splitArgs(inner)
  // The camera frames the panel: lock it there.
  if args.contains(where: { $0.lowercased() == "locked" }) {
    throw LanguageError("on(…) takes no locked: put it on the panel’s camera(…) row.")
  }
  let usage =
    "Expected on((X, Y, Z) = (cos(y) cos(x), cos(y) sin(x), sin(y)), x = -pi..pi, y = -pi/2..pi/2): the surface "
    + "the panel’s rows are drawn on, and the x and y it spans."
  /// `^\(\s*X\s*,\s*Y\s*,\s*Z\s*\)\s*=\s*([\s\S]+)$`
  func embedded(_ arg: String) -> String? {
    var s = RowScanner(arg)
    guard s.eat("(") else { return nil }
    for (k, name) in ["X", "Y", "Z"].enumerated() {
      s.space()
      guard s.eat(name.unicodeScalars.first!) else { return nil }
      s.space()
      guard s.eat(k < 2 ? "," : ")") else { return nil }
    }
    s.space()
    guard s.eat("=") else { return nil }
    s.space()
    return s.atEnd ? nil : String(s.u[s.i...])
  }
  var src: String?
  var ranges: [String: [Double]] = [:]
  for arg in args {
    if let embed = embedded(arg) {
      if src != nil { throw LanguageError("on(…) gives the surface twice.") }
      src = embed
      continue
    }
    guard let named = namedArg(arg), named.name == "x" || named.name == "y", let range = splitRange(named.value)
    else { throw LanguageError(usage) }
    let axis = named.name
    if ranges[axis] != nil { throw LanguageError("on(…) sets \(axis) twice.") }
    let lo = try num(range.0, env, "\(axis) lower bound", valueNames)
    let hi = try num(range.1, env, "\(axis) upper bound", valueNames)
    if lo >= hi { throw LanguageError("The \(axis) range needs lo < hi (got \(JS.string(lo))..\(JS.string(hi))).") }
    ranges[axis] = [lo, hi]
  }
  guard let src, let x = ranges["x"], let y = ranges["y"] else { throw LanguageError(usage) }
  return .surface(try parseSurfaceMap(src, x: x, y: y, env: env, doc: doc))
}
