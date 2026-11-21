/// User definitions (lib/defs.ts): which rows define a name, and what each
/// name comes to once every definition has resolved.
///
/// - `a = 2` defines a constant (a slider); `b = a^2 + t` a computed one.
///   Constants stay symbolic through compilation (they become uniforms).
/// - `f(x) = x^3 - a x` defines a function; calls are inlined symbolically.
/// - `r = sqrt(x^2 + y^2)` reaches x and y, so it is a coordinate field,
///   written into the rows that name it.
/// - `A = (1, 2)` names a point: its components are the constants A_x, A_y.
/// - `within = r < 2` names a condition, read in braces: `{within: 1}`.
/// - `L = [1, 2, 3]`, `T = (1, 2, 3, 4)` and `p ∈ L` name lists (Lists.swift).
///
/// - `a = e^(i pi/3)` names a complex number, written in where it is read.
/// - `M = ((1, 2), (3, 4))` names a matrix, expanded where it is used.
/// - `L = [1, 2, 3]`, `T = (1, 2, 3, 4)` and `p ∈ L` name lists (Lists.swift).
///
/// - a name for an interval, or for anything built from one, is the hidden parameter every row
///   using it shares (Interval.swift); u and v take one as the range they run over.
/// - `person = open("people.csv", 3a7f…)` names a data file (Tables.swift).
///
/// What is not ported is reported as not supported yet, and so is every row
/// that names it.
public enum Definition: Equatable, Sendable {
  /// `draw`: `p ∈ A`, a binder over A's members.
  case constant(name: String, rhs: String, draw: Bool = false)
  case function(name: String, params: [String], rhs: String)
  /// `a' = …` — da/dt, integrated forward in time.
  case state(name: String, rhs: String)
  /// `a(0) = …` — where the state a starts.
  case initial(name: String, rhs: String)
  /// `person = open("people.csv", 3a7f…)` — a local data file.
  case table(name: String, file: String = "", hash: String = "")
  /// `Y ~ m X + b` — a fit, which defines its coefficients (RegressionRows.swift).
  case regression(name: String, lhs: String, rhs: String)

  public var name: String {
    switch self {
    case .constant(let name, _, _), .function(let name, _, _), .state(let name, _), .initial(let name, _),
      .table(let name, _, _), .regression(let name, _, _):
      name
    }
  }

  /// Row identity for duplicate detection (`defKey`): `a = 1` and `a' = 2`
  /// share a key, but `a(0)` is its own row.
  public var key: String {
    if case .initial(let name, _) = self { return "\(name)(0)" }
    return name
  }

  /// The kind as the site's tools name it.
  public var kind: String {
    switch self {
    case .constant: "const"
    case .function: "fn"
    case .state: "state"
    case .initial: "init"
    case .table: "table"
    case .regression: "regression"
    }
  }

  var rhs: String? {
    switch self {
    case .constant(_, let rhs, _), .function(_, _, let rhs), .state(_, let rhs), .initial(_, let rhs): rhs
    case .table, .regression: nil
    }
  }
}

/// Names with built-in meaning that definitions may not shadow.
let reservedNames: Set<String> = ["x", "y", "z", "u", "v", "t", "w", "i", "d", "e", "pi"]

/// A name a definition may claim: not a builtin (except the late-addition
/// ones old graphs may define themselves), not reserved, not a uniform.
func nameable(_ n: String) -> Bool {
  (!functions.contains(n) || shadowableFunctions.contains(n)) && !reservedNames.contains(n) && !n.hasPrefix("u_")
}

/// Of the names a document binds as values, the ones the language would
/// otherwise claim (`shadowedNames`): what parseExpr needs to keep
/// `total = 3` followed by `total(x + 1)` a product, and to read `e` after
/// `e := 0.6` (or in the body of `f(e) := …`) as that e.
func shadowedNames<S: Sequence>(_ names: S) -> Set<String> where S.Element == String {
  var out: Set<String> = []
  for n in names {
    // A redefined built-in (`e := 0.6`, or a parameter named e) is bound by
    // its alias; every row of its scope reads the written name as that alias.
    if n != writtenName(n) { out.insert(writtenName(n)) }
    if let b = builtinFn(n), shadowableFunctions.contains(b) { out.insert(b) }
  }
  return out
}

/// A row written `name := …` (or `f(x) := …`, `a' := …`): explicitly a definition.
func isExplicitDefinition(_ text: String) -> Bool { explicitAssignment(Array(text.utf16)) != nil }

/// The row with its `:=` read as `=`, for the scanners that match a row's
/// shape (definitions, data files, random variables) — the same row either way.
func asAssignment(_ text: Units) -> Units {
  guard let at = explicitAssignment(text) else { return text }
  return Array(text[..<at.lowerBound]) + [unit("=")] + Array(text[at.upperBound...])
}

func asAssignment(_ text: String) -> String {
  let u = Array(text.utf16)
  guard let at = explicitAssignment(u) else { return text }
  return String(Array(u[..<at.lowerBound]) + [unit("=")] + Array(u[at.upperBound...]))
}

/// A written name as a definition binds it: a redefined built-in (or
/// parameter) by its alias, so it reads as what parses there (`redefinable`).
private func bindable(_ name: String) -> String { redefinable.contains(name) ? reboundName(name) : name }

/// A definition row's left side and assignment as the row wrote them, for
/// writing it back (`e :=`, `a(0) =`): a slider or drag keeps `:=` and the
/// written name, never the alias (`definitionHead`).
public func definitionHead(_ definition: Definition, _ text: String) -> String {
  var initial = false
  if case .initial = definition { initial = true }
  return "\(writtenName(definition.name))\(initial ? "(0)" : "") \(isExplicitDefinition(text) ? ":=" : "=")"
}

/// Component names a named point expands to: A_x, A_y(, A_z).
func pointComps(_ name: String, _ dim: Int = 2) -> [String] {
  ["x", "y", "z"].prefix(dim).map { "\(name)_\($0)" }
}

// MARK: - Scanning rows (the regular expressions of lib/defs.ts, by hand)

/// A cursor over a row's UTF-16 text, or a stretch of it, with the pieces the
/// TypeScript's regular expressions are made of: the anchored patterns that
/// decide what a row defines before anything is parsed, and the highlighter's.
struct RowScanner {
  let u: Units
  var i: Int
  /// Where the scan stops: the end of the text, or of the stretch being read.
  let end: Int

  init(_ text: String) { self.init(Array(text.utf16)) }
  init(_ units: Units, _ range: Range<Int>? = nil) {
    u = units
    i = range?.lowerBound ?? 0
    end = range?.upperBound ?? units.count
  }

  var atEnd: Bool { i >= end }
  var peek: UInt16? { i < end ? u[i] : nil }

  /// `\s*`
  mutating func space() {
    while i < end, isJSWhitespace(u[i]) { i += 1 }
  }

  /// A name as written (lib/expr.ts `NAME_SRC`): a name-start character,
  /// then name characters.
  mutating func nameRange() -> Range<Int>? {
    guard i < end, isNameStart(u[i]) else { return nil }
    let start = i
    i += 1
    while i < end, isWrittenName(u[i]) { i += 1 }
    return start..<i
  }

  mutating func name() -> String? { nameRange().map { String(u[$0]) } }

  mutating func eat(_ c: UInt16) -> Bool {
    guard i < end, u[i] == c else { return false }
    i += 1
    return true
  }

  mutating func eat(_ c: Unicode.Scalar) -> Bool { eat(unit(c)) }

  /// Literal ASCII text.
  mutating func eat(word: String) -> Bool {
    let w = Array(word.utf16)
    guard i + w.count <= end, Array(u[i..<(i + w.count)]) == w else { return false }
    i += w.count
    return true
  }

  /// An ASCII word, whatever its case: the `/i` of the row-shape patterns.
  mutating func eat(wordIgnoringCase lower: String) -> Bool {
    var k = i
    for c in lower.utf16 {
      guard k < end, u[k] | 0x20 == c, isASCIILetter(u[k]) else { return false }
      k += 1
    }
    i = k
    return true
  }

  /// `=(?!=)`
  mutating func assign() -> Bool {
    guard i < end, u[i] == unit("="), !(i + 1 < end && u[i + 1] == unit("=")) else { return false }
    i += 1
    return true
  }

  /// `=(?!=)([\s\S]+)$`: the text after a single `=`, which must not be empty.
  func assignment() -> String? {
    guard i + 1 < end, u[i] == unit("="), u[i + 1] != unit("=") else { return nil }
    return String(u[(i + 1)..<end])
  }

  /// `\d+`
  mutating func digits() -> Range<Int>? {
    let start = i
    while i < end, isDigit(u[i]) { i += 1 }
    return i > start ? start..<i : nil
  }

  func text(_ range: Range<Int>) -> String { String(u[range]) }
}

/// `^\s*(NAME)\s*=(?!=)(…)$`
private func scanConst(_ text: Units) -> (name: String, rhs: String)? {
  var s = RowScanner(text)
  s.space()
  guard let name = s.name() else { return nil }
  s.space()
  guard let rhs = s.assignment() else { return nil }
  return (name, rhs)
}

/// `^\s*(NAME)\s*\(\s*(NAME(?:\s*,\s*NAME)*)\s*\)\s*=(?!=)(…)$`
private func scanFn(_ text: Units) -> (name: String, params: [String], rhs: String)? {
  var s = RowScanner(text)
  s.space()
  guard let name = s.name() else { return nil }
  s.space()
  guard s.eat("(") else { return nil }
  s.space()
  guard let first = s.name() else { return nil }
  var params = [first]
  while true {
    let mark = s.i
    s.space()
    guard s.eat(",") else {
      s.i = mark
      break
    }
    s.space()
    guard let next = s.name() else { return nil }
    params.append(next)
  }
  s.space()
  guard s.eat(")") else { return nil }
  s.space()
  guard let rhs = s.assignment() else { return nil }
  return (name, params, rhs)
}

/// `^\s*(NAME)\s*(?:∈|\\in\b)\s*(…)$`: a binder, `p ∈ A`.
private func scanDraw(_ text: Units) -> (name: String, rhs: String)? {
  var s = RowScanner(text)
  s.space()
  guard let name = s.name() else { return nil }
  s.space()
  if !s.eat("\u{2208}") {
    guard s.eat(word: "\\in") else { return nil }
    // \b: not followed by a word character.
    if let next = s.peek, isASCIILetter(next) || isDigit(next) || next == unit("_") { return nil }
  }
  s.space()
  guard !s.atEnd else { return nil }
  return (name, String(s.u[s.i...]))
}

/// A row that means to open a file, `name = open("file.csv", hash)`: the name
/// as written, and whether the row says so well enough to be one — then with
/// the file it names and the hash it pins, lowercase, or "" (lib/defs.ts
/// `OPEN_HEAD_RE`, and the whole of `TABLE_RE`).
func scanOpen(_ text: Units) -> (name: String, wellFormed: Bool, file: String, hash: String)? {
  var s = RowScanner(text)
  s.space()
  guard let name = s.name() else { return nil }
  s.space()
  guard s.eat("=") else { return nil }
  s.space()
  guard s.eat(word: "open") else { return nil }
  s.space()
  guard s.eat("(") else { return nil }
  s.space()
  guard let quote = s.peek, quote == unit("\"") || quote == unit("'") else { return nil }
  s.i += 1
  let fileStart = s.i
  while let c = s.peek, c != quote { s.i += 1 }
  let file = s.text(fileStart..<s.i)
  guard s.eat(quote) else { return (name, false, "", "") }
  s.space()
  var hash = ""
  if s.eat(",") {
    s.space()
    let start = s.i
    while let c = s.peek, isDigit(c) || (0x61...0x66).contains(c | 0x20) { s.i += 1 }
    // At least `HASH_TOKEN_LEN` digits, because a row is resolved by hash prefix.
    guard (HASH_TOKEN_LEN...64).contains(s.i - start) else { return (name, false, "", "") }
    hash = String(decoding: s.u[start..<s.i].map { isDigit($0) ? $0 : $0 | 0x20 }, as: UTF16.self)
    s.space()
  }
  guard s.eat(")") else { return (name, false, "", "") }
  s.space()
  return (name, s.atEnd, file, hash)
}

/// A subscript written in braces, as a recurrence row is: `a_{0} = 1`
/// defines a_0, `T_{c} = 300` defines T_c. Parens only around a number.
private func unbraceTerm(_ text: Units) -> Units {
  var s = RowScanner(text)
  s.space()
  guard let letter = s.peek, isNameLetter(letter) else { return text }
  s.i += 1
  let head = s.i
  guard s.eat("_") else { return text }
  var inner: ArraySlice<UInt16>
  if s.eat("{") {
    s.space()
    let start = s.i
    if let c = s.peek, isDigit(c) {
      while let c = s.peek, isDigit(c) { s.i += 1 }
    } else if let c = s.peek, isNameLetter(c) {
      s.i += 1
      while let c = s.peek, isASCIILetter(c) || isDigit(c) || c == unit("_") { s.i += 1 }
    } else {
      return text
    }
    inner = text[start..<s.i]
    s.space()
    guard s.eat("}") else { return text }
  } else if s.eat("(") {
    s.space()
    let start = s.i
    while let c = s.peek, isDigit(c) { s.i += 1 }
    guard s.i > start else { return text }
    inner = text[start..<s.i]
    s.space()
    guard s.eat(")") else { return text }
  } else {
    return text
  }
  // (?=\s*=(?!=))
  var ahead = s
  ahead.space()
  guard ahead.i < text.count, text[ahead.i] == unit("="), !(ahead.i + 1 < text.count && text[ahead.i + 1] == unit("="))
  else { return text }
  return Array(text[..<head]) + [unit("_")] + Array(inner) + Array(text[s.i...])
}

/// /\binterval\s*\(/i: a right side that may define u or v.
private func mentionsIntervalCall(_ rhs: String) -> Bool {
  let u = Array(rhs.lowercased().utf16)
  let word = Array("interval".utf16)
  guard u.count >= word.count else { return false }
  for start in 0...(u.count - word.count) where Array(u[start..<(start + word.count)]) == word {
    if start > 0, isASCIILetter(u[start - 1]) || isDigit(u[start - 1]) || u[start - 1] == unit("_") { continue }
    var k = start + word.count
    while k < u.count, isJSWhitespace(u[k]) { k += 1 }
    if k < u.count, u[k] == unit("(") { return true }
  }
  return false
}

/// Detect a definition row before parsing (so calls to it parse everywhere).
public func scanDefinition(_ source: String) -> Definition? {
  // `a := …` says outright what `a = …` leaves to the name: this is a
  // definition, so it may claim e, i, w, pi or t too.
  let units = Array(source.utf16)
  let explicit = explicitAssignment(units) != nil
  func claimable(_ n: String) -> Bool { nameable(n) || (explicit && redefinable.contains(n)) }
  let text = unbraceTerm(explicit ? asAssignment(units) : units)
  // Primes first: `a' = …` is a state, but the reserved coordinate names keep
  // their ODE meaning, so `y' = x - y` stays a slope field.
  var s = RowScanner(text)
  s.space()
  if let written = s.name(), s.eat("'") {
    s.space()
    let name = canonicalName(written)
    if let rhs = s.assignment(), claimable(name) { return .state(name: bindable(name), rhs: rhs) }
  }
  s = RowScanner(text)
  s.space()
  if let written = s.name() {
    s.space()
    if s.eat("(") {
      s.space()
      if s.eat("0") {
        s.space()
        if s.eat(")") {
          s.space()
          let name = canonicalName(written)
          if let rhs = s.assignment(), claimable(name) { return .initial(name: bindable(name), rhs: rhs) }
        }
      }
    }
  }
  // Before the function form: `open(…)` takes a file name, not parameters.
  // A row that plainly means to open a file but does not read as one is not
  // a constant either: its own row explains what is wrong with it.
  if let open = scanOpen(text) {
    let name = canonicalName(open.name)
    guard open.wellFormed, claimable(name) else { return nil }
    return .table(name: bindable(name), file: open.file, hash: open.hash)
  }
  // Only as a value: the parser reads `e(2)` as e · 2 wherever e is not the
  // document's value, so `e(x) := …` would define a function no row calls.
  if let m = scanFn(text), nameable(canonicalName(m.name)) {
    return .function(
      name: canonicalName(m.name), params: m.params.map { bindable(canonicalName($0)) }, rhs: m.rhs)
  }
  if let m = scanConst(text) {
    let name = canonicalName(m.name)
    if claimable(name) { return .constant(name: bindable(name), rhs: m.rhs) }
    // `u = interval(0, 2pi)` sets the range u runs over, (0, 1) by default.
    if name == "u" || name == "v", mentionsIntervalCall(m.rhs) { return .constant(name: name, rhs: m.rhs) }
  }
  if let m = scanDraw(text), claimable(canonicalName(m.name)) {
    return .constant(name: bindable(canonicalName(m.name)), rhs: m.rhs, draw: true)
  }
  return nil
}

/// Why a row that reads as a binder, `p ∈ A`, binds no name: the name is the
/// language's. Nil when it is not such a row.
func takenBinder(_ text: String, _ valueNames: Set<String> = []) -> String? {
  guard let m = scanDraw(Array(text.utf16)) else { return nil }
  let n = canonicalName(m.name)
  if nameable(n) { return nil }
  // After `i := 3`, i is the document's, defined once already.
  if redefinable.contains(n) && valueNames.contains(n) { return "\(n) is already defined." }
  let why =
    n.hasPrefix("u_")
    ? "names starting u_ are"
    : functions.contains(n) ? "\(m.name) is a built-in function" : "x, y, z, t, u, v, w, d, e, i and pi are"
  return "\(m.name) is taken by the language, so it cannot be drawn: \(why). Draw with another name, like p ∈ A."
}

/// The name a row tried to define when that name is taken by the language:
/// `e = 0.6` or `d(x) = …` look like a slider or a function but are not one.
func takenDefinitionName(_ text: String) -> String? {
  let u = Array(text.utf16)
  guard let written = scanFn(u)?.name ?? scanConst(u)?.name else { return nil }
  let n = canonicalName(written)
  return n == "d" || n == "e" || n == "pi" || n == "i" ? n : nil
}

/// Why a name from takenDefinitionName (other than `d`) names no value.
func takenNameHint(_ name: String) -> String {
  name == "i"
    ? "i is the imaginary unit; name it something else, like k (i := … replaces it across the whole graph)"
    : "\(name) is a constant; name a slider something else, like k (\(name) := … replaces \(name) across the "
      + "whole graph)"
}

/// What each reserved name is, where a row tried to call or redefine it (`RESERVED_FN_MEANING`).
private let reservedFnMeaning: [String: String] = [
  "x": "a plot axis", "y": "a plot axis", "z": "a plot axis", "t": "animation time",
  "u": "a curve/surface parameter", "v": "a curve/surface parameter, like u",
  "w": "the complex variable x + iy",
]

/// The arguments of a row shaped like a function definition, as written:
/// FN_RE's second group, from the first parameter to the last.
private func scanFnArgs(_ text: Units) -> (name: String, args: String)? {
  var s = RowScanner(text)
  s.space()
  guard let name = s.name() else { return nil }
  s.space()
  guard s.eat("(") else { return nil }
  s.space()
  let start = s.i
  guard s.name() != nil else { return nil }
  var end = s.i
  while true {
    let mark = s.i
    s.space()
    guard s.eat(",") else {
      s.i = mark
      break
    }
    s.space()
    guard s.name() != nil else { return nil }
    end = s.i
  }
  s.space()
  guard s.eat(")") else { return nil }
  s.space()
  guard s.assignment() != nil else { return nil }
  return (name, String(text[start..<end]))
}

/// Why a row that failed and is shaped like a function definition on a
/// reserved name is no definition: `u(x, y) = …` reads as u times a point
/// (`reservedFnHint`). Nil for any other row.
func reservedFnHint(_ text: String) -> String? {
  guard let m = scanFnArgs(Array(text.utf16)) else { return nil }
  let n = canonicalName(m.name)
  guard let meaning = reservedFnMeaning[n] else { return nil }
  return "\(n)(\(m.args)) reads as \(n) times (\(m.args)), since \(n) is \(meaning). To define a function, use "
    + "another name, like f(\(m.args)) = …"
}

/// Why a `:=` row defines nothing: it claims a name the language keeps even
/// from an explicit definition (`redefinable` says which it gives up), or its
/// left side names nothing (`explicitDefinitionError`). Nil for a row that
/// is no `:=`, or defines.
func explicitDefinitionError(_ text: String) -> String? {
  let units = Array(text.utf16)
  guard explicitAssignment(units) != nil, scanDefinition(text) == nil else { return nil }
  let row = asAssignment(units)
  // (A row that means to open a file and does not say so explains itself: `badTableRow`.)
  if scanOpen(row) != nil { return nil }
  let fn = scanFn(row)
  var written = fn?.name ?? scanConst(row)?.name
  if written == nil {
    // STATE_RE: `a' = …`.
    var s = RowScanner(row)
    s.space()
    if let name = s.name(), s.eat("'") {
      s.space()
      if s.assignment() != nil { written = name }
    }
  }
  guard let written else { return "The left side of := names what it defines, like a := 2 or f(x) := x^2." }
  let n = canonicalName(written)
  if fn != nil && redefinable.contains(n) { return "\(n) can be redefined as a value, not a function." }
  let why =
    n == "d"
    ? "d starts derivatives (d/dx)"
    : reservedFnMeaning[n].map { "\(n) is \($0)" }
      ?? (n.hasPrefix("u_") ? "names starting u_ are kept for sliders" : "\(n) is a built-in function")
  if n == "u" || n == "v" {
    return "\(n) is \(reservedFnMeaning[n]!), so it is redefined as the interval it runs over, like "
      + "\(n) := interval(0, 2pi)."
  }
  let params =
    ["x", "y", "z"].contains(n)
    ? " A function's parameters may still be called \(n), like f(\(n)) := \(n)^2." : ""
  return "\(n) cannot be redefined: \(why).\(params)"
}

// MARK: - Building

/// A dictionary that keeps the order its keys were first set in, as a
/// JavaScript `Map` does: the order definitions are checked in decides which
/// error a row gets.
struct OrderedMap<Value> {
  private(set) var keys: [String] = []
  private var values: [String: Value] = [:]

  var isEmpty: Bool { keys.isEmpty }
  func has(_ key: String) -> Bool { values[key] != nil }
  var entries: [(key: String, value: Value)] { keys.map { ($0, values[$0]!) } }

  subscript(key: String) -> Value? {
    get { values[key] }
    set {
      if let newValue {
        if values.updateValue(newValue, forKey: key) == nil { keys.append(key) }
      } else if values.removeValue(forKey: key) != nil {
        keys.removeAll { $0 == key }
      }
    }
  }
}

/// What the document's definitions come to (lib/defs.ts `BuiltDefs`, with
/// lib/env.ts `Env`'s scalar views).
struct BuiltDefs {
  /// Constants by name, a named point's components among them.
  var consts = OrderedMap<Expr>()
  /// Coordinate fields: definitions that reach x, y or z (or u, v).
  var fields = OrderedMap<Expr>()
  /// Named conditions.
  var conditions = OrderedMap<Expr>()
  /// `a = e^(iπ/3)`: complex numbers with a name, bound as complex.
  var complexes = OrderedMap<Expr>()
  /// Functions, in the order they resolved: one first called from a row
  /// above its own resolves there.
  var fns = OrderedMap<FnDef>()
  /// Named points and how many components each has.
  var points: [String] = []
  var pointDims: [String: Int] = [:]
  /// Named matrices (2×2 and 3×3) and tensors of any other shape: their
  /// entries, with those that move with constants and t held as hidden
  /// constants `M#k` (see `hoist`).
  var mats = OrderedMap<Mat>()
  var tensors = OrderedMap<Tensor>()
  /// Named multivectors, lines, planes and motors: each its internal `[mv]`
  /// or `[pga]` node, written into every row that names it.
  var multivectors = OrderedMap<Expr>()
  /// Named lists, and scatters of columns, each with the instances it runs
  /// over (Lists.swift).
  var lists = OrderedMap<Low>()
  /// Per-definition errors by key; failed definitions are not in the stores.
  var errors = OrderedMap<String>()
  /// Definitions the port cannot read yet, by key, with what stopped it.
  var unsupported: [String: String] = [:]
  /// The constants a definition's Σ/Π bounds read (`sumBoundConsts`).
  var sumBoundConsts: Set<String> = []
  /// Scalar states by name, a vector state's components among them (States.swift).
  var states = OrderedMap<StateDef>()
  /// Vector states and how many components each has.
  var vecStates: [String: Int] = [:]
  /// Names defined as an interval: the hidden parameter every mention shares (Interval.swift).
  var intervals = OrderedMap<Expr>()
  /// The fits by their rows' keys (RegressionRows.swift).
  var fits: [String: FitResult] = [:]
  /// Data files and cuts of them, the names whose definitions wanted a file
  /// that is not here, and the keys of those definitions (Tables.swift).
  var tables = OrderedMap<TableDef>()
  var missingData = OrderedMap<MissingValue>()
  var needsFile: Set<String> = []
}

private let positionVars: Set<String> = ["x", "y", "z", "w"]
private let paramVars: Set<String> = ["u", "v"]

/// Parse and resolve a set of uniquely named definitions (`buildDefs`).
/// Those whose key is in `skip` are known not to be supported: they keep
/// their names, so everything else parses as it does on the site, and are
/// otherwise left alone.
func buildDefs(
  _ raw: [Definition], skip: Set<String>, sequences: [SeqScan] = [], files: DataFiles? = nil
) -> BuiltDefs {
  var defs = BuiltDefs()
  var byName: [String: Definition] = [:]
  for d in raw { byName[d.name] = d }
  let fnNames = Set(raw.compactMap { if case .function(let name, _, _) = $0 { name } else { nil } })
  // Names this document binds as values shadow a late-addition builtin of
  // the same name, so `total = 3` still reads `total(x + 1)` as a product.
  let valueNames = shadowedNames(raw.filter { $0.kind != "fn" }.map(\.name))
  // Numeric values of constants resolved so far.
  var numEnv: [String: Double] = [:]
  var parsed: [String: Expr] = [:]
  /// Derived point component → the point row it belongs to (A_x → A).
  var compOwner = OrderedMap<String>()
  var resolving: [String] = []
  let boundConsts = NameBox()
  // Sequence terms a definition reads (a_3, a_k); a recurrence's chain of
  // terms is written into the constants (lib/seq.ts `sequenceResolver`).
  let seq = SequenceResolver(sequences, rawNames: raw.map(\.name))
  defer { seq.release() }
  var known = Set(raw.map(\.name))
  // The sequences index too: b_[n+1].
  let seqIndexNames = Set(seq.sequences.keys.map { $0 + "_" })
  // States (States.swift): their derivatives and starting values as they resolve.
  var states = StateDraft()
  states.names = Set(raw.compactMap { if case .state(let name, _) = $0 { name } else { nil } })
  /// Fitted coefficient → the fit's row.
  var fitOwner = OrderedMap<String>()

  func comps(_ name: String) -> [String]? {
    defs.points.contains(name)
      ? pointComps(name, defs.pointDims[name] ?? 2) : defs.vecStates[name].map { vecStateComps(name, $0) }
  }
  func options() -> ResolveOpts {
    var opts = ResolveOpts()
    opts.valueNames = valueNames
    opts.inDefinition = true
    // Live: definitions above this one (a point's components included).
    // A state stands for itself: defined, and constant across space.
    opts.definition = { defs.conditions[$0] ?? defs.consts[$0] ?? (states.names.contains($0) ? .var($0) : nil) }
    opts.comps = comps
    opts.documentNames = Set(byName.keys)
    opts.complex = { defs.complexes[$0] }
    opts.interval = { defs.intervals[$0] }
    opts.multivector = { defs.multivectors[$0] }
    // Σ/Π bounds in later definitions may use the constants resolved so far.
    opts.consts = { numEnv[$0] }
    opts.boundConsts = boundConsts
    // Live too: list names accumulate as definitions are processed.
    opts.isList = { [defs] in isListName(defs, $0) }
    opts.getList = listGetter(defs)
    opts.indexIssue = { [defs] index, target in indexIssue(index, defs, target) }
    if !seq.sequences.isEmpty { opts.sequenceTerm = { [unowned seq] in try seq.resolve($0, $1, $2) } }
    return opts
  }
  // List names accumulate in definition order: a point indexes (`T[2]`) only
  // when its definition sits above.
  func parse(_ d: Definition) throws -> Expr {
    if let p = parsed[d.key] { return p }
    var values = valueNames
    var names = Set(defs.pointDims.keys).union(defs.mats.keys).union(defs.tensors.keys).union(seqIndexNames)
      .union(defs.lists.keys).union(tableListNames(defs))
    if case .function(_, let params, _) = d {
      // A function's parameters are values in its body, and index too.
      values.formUnion(shadowedNames(params))
      names.formUnion(params)
    }
    let p = try parseExpr(d.rhs ?? "", userFns: fnNames, listNames: names, valueNames: values)
    parsed[d.key] = p
    return p
  }

  func getFn(_ name: String) throws -> FnDef? {
    if let hit = defs.fns[name] { return hit }
    guard fnNames.contains(name) else { return nil }
    if skip.contains(name) || defs.unsupported[name] != nil { throw Unsupported("the function \(name)") }
    if defs.errors.has(name) { throw LanguageError("\(name) has an error in its definition.") }
    guard case .function(_, let params, _)? = byName[name] else {
      // A state's start, f(0) = …, written below a function f takes the name
      // from it, and the TypeScript reads the parameters of a definition that
      // has none: its engine's words are the function row's error.
      throw LanguageError("d.params is not iterable")
    }
    if resolving.contains(name) {
      if resolving.last != name {
        throw LanguageError("\(name) and \(resolving.last!) are defined in terms of each other.")
      }
      return recursiveMarker(params)
    }
    // (Port: a chain of functions each defined below the one that calls it is read one
    // inside the next, Depth.swift.)
    if resolving.count >= maxDefinitionNesting { throw LanguageError(stackExceeded) }
    resolving.append(name)
    defer { resolving.removeLast() }
    // A parameter shadows a document name of the same name.
    var scope = options()
    scope.documentNames = scope.documentNames!.union(params)
    scope.params = Set(params)
    // A parameter shadows a complex constant of the same name.
    scope.complex = { params.contains($0) ? nil : defs.complexes[$0] }
    // (And a named multivector, and a built-in unit vector: f(e_x) = e_x^2 squares its argument.)
    scope.multivector = { params.contains($0) ? nil : defs.multivectors[$0] }
    if let names = scope.documentNames { scope.documentNames = names.union(params) }
    var body = try Resolver(getFn: getFn, opts: scope).resolve(try parse(byName[name]!))
    if containsRecur(body) { body = try wrapRecursion(name, params, body) }
    let fn = FnDef(params: params, body: body)
    defs.fns[name] = fn
    return fn
  }

  // A named value's coefficients as constants of their own (lib/defs.ts
  // `hoist`): each entry of a matrix that depends only on constants and t is
  // stored as a hidden constant `M#k`, evaluated once per frame like a named
  // point's components, and the value written into rows refers to it. A
  // number or a single name stays as it is, as does an entry of numbers alone.
  var hidden = 0
  func hoist(_ owner: String, _ e: Expr) -> Expr {
    switch e {
    case .num, .var: return e
    default: break
    }
    func plain(_ n: Expr) -> Bool {
      switch n {
      case .list, .data, .lazy, .range: false
      default: childrenOf(n).allSatisfy(plain)
      }
    }
    let names = freeVars(e)
    guard plain(e), !names.isEmpty, names.allSatisfy({ $0 == "t" || defs.consts.has($0) }) else { return e }
    let name = "\(owner)#\(hidden)"
    hidden += 1
    defs.consts[name] = e
    return .var(name)
  }
  seq.getFn = getFn
  seq.opts = options()
  seq.fnNames = { Set(defs.fns.keys) }
  seq.indexNames = { Set(defs.pointDims.keys).union(defs.lists.keys).union(tableListNames(defs)) }
  seq.isKnown = { known.contains($0) }
  seq.addKnown = { known.insert($0) }
  seq.protectedNames = known
  seq.hasConst = { defs.consts.has($0) }
  seq.defineConstant = { defs.consts[$0] = $1 }
  seq.setValue = { numEnv[$0] = $1 }
  seq.pointDim = { defs.pointDims[$0] }
  seq.hasList = { defs.lists.has($0) }

  // Named conditions (`within = r < R`), found before anything else resolves:
  // a function body reads one by its shape, and that must not depend on
  // whether the condition's row is above the function's or below.
  for d in raw where !skip.contains(d.key) {
    guard case .constant(let name, let rhs, false) = d else { continue }
    let above = Set(defs.pointDims.keys).union(seqIndexNames).union(defs.mats.keys).union(defs.tensors.keys)
      .union(defs.lists.keys).union(tableListNames(defs))
    guard let source = try? parseExpr(rhs, userFns: fnNames, listNames: above, valueNames: valueNames),
      case .ineq = source
    else { continue }
    if let resolved = try? Resolver(getFn: getFn, opts: options()).resolve(source) {
      defs.conditions[name] = resolved
    }
  }

  // (One definition, in a function of its own: a debug build's frame holds every case's
  // temporaries at once, and each definition's expression is resolved beneath this one.)
  func define(_ d: Definition) throws {
    switch d {
    case .function(let name, let params, _):
      if Set(params).count != params.count { throw LanguageError("Duplicate parameter names.") }
      _ = try getFn(name)
    case .table(let name, let file, let hash):
      try openTable(name, file, hash, files, &defs)
    case .regression(_, let lhs, let rhs):
      let source = try parseFit(
        lhs, rhs, userFns: fnNames, valueNames: valueNames,
        listNames: Set(defs.pointDims.keys).union(defs.mats.keys).union(defs.tensors.keys).union(seqIndexNames)
          .union(defs.lists.keys).union(tableListNames(defs)))
      parsed[d.key] = .eq(source.lhs, source.rhs)
      var parameters: [String] = []
      let fit: FitResult
      do {
        fit = try fitRow(
          source, defs, numEnv, getFn: getFn, opts: options(), isRow: { byName[$0] != nil },
          stateNames: states.names, parameters: &parameters)
      } catch let error as LanguageError where error.missingData {
        // (A fit whose data is elsewhere still claims its coefficients.)
        for name in parameters { defs.missingData[name] = MissingValue(message: error.message, list: false) }
        throw error
      }
      defs.fits[d.name] = fit
      for (name, value) in fit.coefficients {
        defs.consts[name] = .num(value)
        numEnv[name] = value
        fitOwner[name] = d.name
      }
    case .state(let name, _):
      let opts = options()
      states.derivs[name] = try Resolver(getFn: getFn, opts: opts).resolve(try parse(d))
    case .initial(let name, _):
      let opts = options()
      // (A list of starting values is a family of runs: StateFamilies.swift.)
      states.inits[name] = try Resolver(getFn: getFn, opts: opts).resolve(try parse(d))
    case .constant(let name, _, let draw):
      let resolved = try Resolver(getFn: getFn, opts: options()).resolve(try parse(d))
      defs.conditions[name] = nil
      // u and v take only an interval: the range they run over.
      if paramVars.contains(name) {
        guard case .call(INTERVAL, _) = resolved else {
          throw LanguageError(
            "\(name) can only be defined as an interval, the range it runs over: \(name) = interval(0, 2pi).")
        }
      }
      // `r = interval(1, 2)`, or anything built from one: not a number but a
      // hidden parameter, which every row using the name shares.
      if hasInterval(resolved) {
        if draw { throw LanguageError("\(name) ∈ … draws from a list; that is an interval.") }
        defs.intervals[name] = resolved
        return
      }
      // Lowering expands point arithmetic; a pair result names a point.
      // Point-ness flows in definition order, so `C = B + D` needs B and D
      // defined above (a stray point name below is reported after the loop).
      // (`L = line(A, B)` names the line as a value of projective geometry.)
      // `M = ((a, b), (c, d))`, `R = e^(a J)`, `N = 2 M`: a tuple of rows,
      // or matrix algebra, names a matrix.
      let getMat: GetMat = { defs.mats[$0] }
      let getTensor = tensorGetter(defs)
      // A binder draws from a list; the other named values below are not one.
      func notDrawn(_ what: String) throws {
        if draw { throw LanguageError("\(name) ∈ … draws from a list; that is \(what).") }
      }
      // M Q with Q a multiset of points is those points moved, never a
      // matrix: the object expansion applies M to each.
      let ofPoints = readsPointList(resolved, defs)
      if !ofPoints,
        let computed = try lowerMatrix(resolved, comps: comps, getMat: getMat, getTensor: getTensor)
      {
        try notDrawn("a matrix")
        defs.mats[name] = computed.map { row in row.map { hoist(name, $0) } }
        return
      }
      // `T = e_x ⊗ e_y ⊗ e_z`: a tensor of any other shape.
      if !ofPoints,
        let tensor = try lowerTensorValue(resolved, comps: comps, getMat: getMat, getTensor: getTensor)
      {
        try notDrawn("a tensor")
        defs.tensors[name] = Tensor(shape: tensor.shape, data: tensor.data.map { hoist(name, $0) })
        return
      }
      // `L = join(A, B)`, `R = e^(-t/2 e_xy)`, `q = quat(1, 2, 3, 4)`: a
      // line, plane, motor or multivector, written into every row that
      // names it; `X = meet(L, M)` names the point it is (GeomAlgebra.swift).
      var value = resolved
      if !ofPoints, holdsAlgebra(resolved) {
        switch try namedAlgebra(
          resolved, comps: comps, getMat: getMat, getTensor: getTensor, isList: { defs.lists.has($0) },
          hoist: { hoist(name, $0) })
        {
        case .named(let node, let what):
          try notDrawn(what)
          defs.multivectors[name] = node
          return
        case .value(let e):
          value = e
        }
      } else if ofPoints, case .call("line", let args) = resolved {
        // `N = line(P, A)` over a list names the lines, as join does.
        value = .call("join", args)
      }
      // `adults = person[person.age >= 18]` names a cut of a data file (Tables.swift).
      if let cut = try tableCut(name, value, draw: draw, defs, options(), comps: comps) {
        // Registered first, so rows below report the file rather than an
        // unknown name — then the row says what is missing, as the `open()`
        // row it cuts does.
        defs.tables[name] = cut
        if let missing = cut.missing, files != nil { throw missingDataError(missing) }
        return
      }
      // A list, a tuple of more than 3 values or a scatter of columns names
      // a list: the name is its values, over instances of its own.
      let listed = try namedList(name, value, draw: draw, ofPoints: ofPoints, defs, options(), comps: comps)
      // A tuple of computed points that is square, `A = (2 P, Q + R)`:
      // one tensor, named as a matrix when it is square.
      if let reduced = tensorOfNode(listed.e), reduced.shape.count >= 2 {
        try notDrawn("a tensor")
        if let m = toMat(reduced) { defs.mats[name] = m } else { defs.tensors[name] = reduced }
        return
      }
      if listed.isSeq || isDataScatter(listed.e) {
        defs.lists[name] = listed
        return
      }
      let e = listed.e
      // `within = r < R`, or another name for one: a condition.
      var alias: Expr?
      if case .var(let other) = e { alias = defs.conditions[other] }
      if case .ineq = e { alias = alias ?? e }
      if let alias {
        if draw { throw LanguageError("\(name) ∈ … draws from a list; that is a condition.") }
        defs.conditions[name] = alias
        return
      }
      var store: [(String, Expr)] = [(name, e)]
      if case .vec(let items) = e {
        if items.count != 2 && items.count != 3 {
          throw LanguageError("A named point needs 2 or 3 components.")
        }
        let names = pointComps(name, items.count)
        for c in names where byName[c] != nil {
          throw LanguageError("Cannot name a point \(name): \(c) is already defined.")
        }
        defs.points.append(name)
        defs.pointDims[name] = items.count
        store = []
        for (c, item) in zip(names, items) {
          compOwner[c] = name
          store.append((c, item))
        }
      }
      for (n, expr) in store {
        defs.consts[n] = expr
        // Its value now, when everything it reads has one.
        var env: [String: Double] = [:]
        var known = true
        for fv in freeVars(expr) {
          guard let v = numEnv[fv] else {
            known = false
            break
          }
          env[fv] = v
        }
        if known, let v = try? evaluate(expr, env), v.isFinite { numEnv[n] = v }
      }
    }
  }

  for d in raw {
    if skip.contains(d.key) {
      defs.unsupported[d.key] = "a name that is not supported yet"
      continue
    }
    do {
      try define(d)
    } catch let error as Unsupported {
      defs.unsupported[d.key] = error.what
    } catch let error as LanguageError {
      defs.errors[d.key] = error.message
      noteMissingData(error, d, shape: parsed[d.key], &defs)
    } catch let error as ParseError {
      defs.errors[d.key] = error.message
    } catch {
      defs.errors[d.key] = "\(error)"
    }
  }

  // A condition named below a definition that reads it: written in now, in
  // condition places only.
  if !defs.conditions.isEmpty {
    for (name, e) in defs.consts.entries {
      defs.consts[name] = writeConditions(e, { defs.conditions[$0] }, whole: false)
    }
    for (name, e) in states.derivs.entries {
      states.derivs[name] = writeConditions(e, { defs.conditions[$0] }, whole: false)
    }
    for (name, e) in states.inits.entries {
      states.inits[name] = writeConditions(e, { defs.conditions[$0] }, whole: false)
    }
  }

  func dropPoint(_ owner: String) {
    defs.points.removeAll { $0 == owner }
  }

  // A bare point name surviving in a resolved expression means the point was
  // defined below its use, so lowering saw it as a scalar: report and drop.
  for (name, e) in defs.consts.entries {
    for fv in freeVars(e) where defs.points.contains(fv) {
      let owner = compOwner[name] ?? name
      defs.errors[owner] = "\(fv) is a point — move its definition above \(owner)."
      if defs.points.contains(owner) {
        dropPoint(owner)
        for c in pointComps(owner, defs.pointDims[owner] ?? 2) { defs.consts[c] = nil }
      } else {
        defs.consts[owner] = nil
      }
      break
    }
  }

  writeComplexConstants(&defs)
  // Vector states split into their scalar components (States.swift).
  let (pointNames, pointDims, matrices) = (defs.points, defs.pointDims, defs.mats)
  // (What list lowering reads of the definitions, as they stand while the states are rewritten.)
  let stateOptions = options()
  func listed(_ e: Expr, _ at: BuiltDefs, _ stateNames: Set<String>) throws -> Low {
    var opts = stateOptions
    opts.definition = { at.conditions[$0] ?? at.consts[$0] ?? (stateNames.contains($0) ? .var($0) : nil) }
    opts.comps = { name in
      at.points.contains(name)
        ? pointComps(name, at.pointDims[name] ?? 2) : at.vecStates[name].map { vecStateComps(name, $0) }
    }
    opts.complex = { at.complexes[$0] }
    opts.isList = { isListName(at, $0) }
    opts.getList = listGetter(at)
    opts.indexIssue = { index, target in indexIssue(index, at, target) }
    return try lowerLists(e, listGetter(at), opts, named: true)
  }
  let (beforeStates, stateNames) = (defs, states.names)
  lowerVectorStates(
    &defs, &states, defined: { byName[$0] != nil },
    comps: { name in pointNames.contains(name) ? pointComps(name, pointDims[name] ?? 2) : nil },
    mats: { matrices[$0] }, listed: { try listed($0, beforeStates, stateNames) })
  expandStateFamilies(
    &defs, &states, prefix: sequencePrefix(raw.map(\.name)), compOwner: &compOwner, lowerNamed: listed)
  writeComplexLists(&defs)

  // A definition whose value depends on position — x, y, or z, directly or
  // via another such definition — is a coordinate field, not a constant. So
  // is one over the parameters u, v, a named curve.
  var fieldNames: Set<String> = []
  var paramNames: Set<String> = []
  var changed = true
  while changed {
    changed = false
    for (name, e) in defs.consts.entries {
      for fv in freeVars(e) {
        if !fieldNames.contains(name), positionVars.contains(fv) || paramVars.contains(fv) || fieldNames.contains(fv) {
          fieldNames.insert(name)
          changed = true
        }
        if !paramNames.contains(name), paramVars.contains(fv) || paramNames.contains(fv) {
          paramNames.insert(name)
          changed = true
        }
      }
    }
  }
  // A named vector that depends on position is a vector field: every
  // component becomes a coordinate field.
  for p in defs.points {
    let names = pointComps(p, defs.pointDims[p] ?? 2)
    guard names.contains(where: fieldNames.contains) else { continue }
    fieldNames.formUnion(names)
    if names.contains(where: paramNames.contains) { paramNames.formUnion(names) }
  }

  var constNames: Set<String> = []
  for d in raw {
    if case .constant(let name, _, _) = d, !fieldNames.contains(name), !defs.conditions.has(name),
      !defs.complexes.has(name)
    {
      constNames.insert(name)
    }
  }
  // A named value's hidden coefficients (M#3) are constants by construction.
  for name in defs.consts.keys where name.utf16.contains(unit("#")) { constNames.insert(name) }
  for name in fitOwner.keys { constNames.insert(name) }
  // (A recurrence's chain of terms.)
  for name in defs.consts.keys where name.hasPrefix(seq.prefix + "_") { constNames.insert(name) }
  // Constant point rows resolve to their component constants; a vector
  // field's components are fields, not uniforms.
  for p in defs.points {
    constNames.remove(p)
    for c in pointComps(p, defs.pointDims[p] ?? 2) where !fieldNames.contains(c) { constNames.insert(c) }
  }

  var pendingFields = OrderedMap<Expr>()
  for (name, e) in defs.consts.entries where fieldNames.contains(name) { pendingFields[name] = e }
  for name in pendingFields.keys { defs.consts[name] = nil }

  // Resolve field-to-field references so each field is a closed expression
  // in x, y, z, t, and constants.
  var fieldVisiting: Set<String> = []
  func resolveField(_ name: String) throws -> Expr {
    if let hit = defs.fields[name] { return hit }
    let shown = compOwner[name] ?? name
    if fieldVisiting.contains(name) { throw LanguageError("\(shown) is defined in terms of itself.") }
    // (Port: fields read one inside another, and one written into the next, Depth.swift.)
    if fieldVisiting.count >= maxDefinitionNesting { throw LanguageError(stackExceeded) }
    fieldVisiting.insert(name)
    defer { fieldVisiting.remove(name) }
    var e = pendingFields[name]!
    var sub: [String: Expr] = [:]
    for fv in freeVars(e) where pendingFields.has(fv) { sub[fv] = try resolveField(fv) }
    if !sub.isEmpty {
      if substitutionExceedsDepth(e, sub) { throw LanguageError(stackExceeded) }
      e = substVars(e, sub)
    }
    // A field lives over the plane or space, or over the parameters.
    let vars = freeVars(e).list
    let param = vars.first(where: paramVars.contains)
    if let param, vars.contains(where: positionVars.contains) {
      throw LanguageError(
        "\(shown) mixes position (x, y, z) with the parameter \(param); "
          + "a definition may use one or the other (found \(param))."
      )
    }
    for fv in vars
    where !positionVars.contains(fv) && !paramVars.contains(fv) && fv != "t" && fv != "i" && !constNames.contains(fv)
      && !states.names.contains(fv)
    {
      throw LanguageError(
        param != nil || paramNames.contains(name)
          ? "\(shown) is a curve or surface (it uses u or v), so it may only use u, v, t, and constants (found \(fv))."
          : "\(shown) defines a coordinate (it uses x, y, or z), "
            + "so it may only use x, y, z, t, and constants (found \(fv))."
      )
    }
    // Trial-evaluate to surface unsupported calls (re, im, …) now. A
    // complex field has no real value; the rows using it check it.
    if !vars.contains("i") && !vars.contains("w") {
      var env: [String: Double] = ["x": 0.7, "y": 0.4, "z": 0.3, "t": 0]
      for fv in vars where env[fv] == nil { env[fv] = 1 }
      _ = try evaluate(e, env)
    }
    defs.fields[name] = e
    return e
  }
  var droppedPoints: Set<String> = []
  for name in pendingFields.keys {
    let owner = compOwner[name]
    if let owner, droppedPoints.contains(owner) { continue }
    do {
      _ = try resolveField(name)
    } catch {
      defs.errors[owner ?? name] = (error as? LanguageError)?.message ?? "\(error)"
      if let owner, defs.points.contains(owner) {
        dropPoint(owner)
        droppedPoints.insert(owner)
        for c in pointComps(owner, defs.pointDims[owner] ?? 2) { defs.fields[c] = nil }
      }
    }
  }
  // The same rule across a named vector's components: `s = (x, u)` has no
  // one meaning, though each component alone would.
  for p in defs.points {
    let names = pointComps(p, defs.pointDims[p] ?? 2)
    let values = names.compactMap { defs.fields[$0] }
    guard values.count == names.count else { continue }
    let vars = values.flatMap { freeVars($0).list }
    if values.contains(where: isComplexValued) {
      // Nor has `s = (x, w)` one meaning: a vector's components are real.
      defs.errors[p] = "\(p) has a complex component; a vector's components are real — take re(…) or im(…)."
      dropPoint(p)
      for c in names { defs.fields[c] = nil }
      continue
    }
    guard let param = vars.first(where: paramVars.contains), vars.contains(where: positionVars.contains) else {
      continue
    }
    defs.errors[p] =
      "\(p) mixes position (x, y, z) with the parameter \(param); "
      + "a definition may use one or the other (found \(param))."
    dropPoint(p)
    for c in names { defs.fields[c] = nil }
  }
  // A binder draws from a list; one over position (or over u, v) is a field
  // (or a curve), which has no members to draw.
  for d in raw {
    guard case .constant(let name, _, true) = d else { continue }
    let names = defs.points.contains(name) ? pointComps(name, defs.pointDims[name] ?? 2) : [name]
    guard names.contains(where: defs.fields.has) else { continue }
    let what = names.contains(where: paramNames.contains) ? "a curve" : "a field"
    defs.errors[name] = "\(name) ∈ … draws from a list; that is \(what)."
    dropPoint(name)
    for c in names { defs.fields[c] = nil }
  }
  // Grid families draw in definition order, not dependency-resolution order.
  var orderedFields = OrderedMap<Expr>()
  for name in pendingFields.keys {
    if let e = defs.fields[name] { orderedFields[name] = e }
  }
  defs.fields = orderedFields

  // A condition reads fields as a row does: closed over them here. It may
  // use what a field may, and its sides must evaluate.
  for (name, written) in defs.conditions.entries {
    do {
      var sub: [String: Expr] = [:]
      for v in freeVars(written) {
        if let field = defs.fields[v] { sub[v] = field }
      }
      let c = sub.isEmpty ? written : substVars(written, sub)
      let vars = freeVars(c).list
      for fv in vars {
        if positionVars.contains(fv) || paramVars.contains(fv) || fv == "t" || fv == "i" || constNames.contains(fv)
          || states.names.contains(fv)
        {
          continue
        }
        throw LanguageError(
          defs.conditions.has(fv)
            ? conditionAsNumber(fv)
            : "\(name) is a condition, so it may only use x, y, z, u, v, t, constants and fields (found \(fv)).")
      }
      if !vars.contains("i") && !vars.contains("w") {
        var env: [String: Double] = ["x": 0.7, "y": 0.4, "z": 0.3, "t": 0]
        for fv in vars where env[fv] == nil { env[fv] = 1 }
        for comparison in ineqComparisons(c) {
          _ = try evaluate(comparison.l, env)
          _ = try evaluate(comparison.r, env)
        }
      }
      defs.conditions[name] = c
    } catch {
      defs.errors[name] = (error as? LanguageError)?.message ?? "\(error)"
      defs.conditions[name] = nil
    }
  }

  // Constants may only depend on other constants, states, and time.
  for (name, e) in defs.consts.entries {
    for fv in freeVars(e) where fv != "t" && !constNames.contains(fv) && !states.names.contains(fv) {
      defs.errors[name] =
        fv == "inf"
        ? "inf only works as an ∫ bound — write it inline: int[-inf..x] f(x) dx."
        : defs.conditions.has(fv)
          ? conditionAsNumber(fv) : "\(name) can only depend on other constants and t (found \(fv))."
      defs.consts[name] = nil
      break
    }
  }

  // A list holds data: its elements may only use constants and t.
  // (Or states: a family's runs are hidden ones, StateFamilies.swift.)
  for (name, message) in strayListNames(defs, constNames.union(states.names)) {
    defs.errors[name] = message
    defs.lists[name] = nil
  }

  // Trial-evaluate to surface cycles and unsupported calls at definition time.
  // (Port: the TypeScript's `check` calls itself for each name a constant
  // reads, a frame per link of a chain of definitions, and checks a name
  // again under every name that reads it. Here the walk keeps its own stack,
  // so a document of a thousand constants each defined by the last is read
  // on any thread's; and a name found sound is not walked again — it was
  // sound whatever was being visited, or it would have been a cycle.)
  struct Check {
    var name: String
    var expr: Expr
    var reads: [String]
    var next = 0
    var env: [String: Double]
  }
  var walk: [Check] = []
  var sound: Set<String> = []
  func check(_ name: String, _ visiting: inout Set<String>) throws {
    guard let e = defs.consts[name] else {
      // A surviving matrix or tensor name means it was defined below its
      // use, so lowering saw it as a plain scalar.
      let listed = defs.lists.has(name) ? "a list" : nil
      let valued =
        defs.mats.has(name)
        ? "a matrix" : defs.tensors.has(name) ? "a tensor" : defs.multivectors.has(name) ? "a multivector" : nil
      if let kind = listed ?? valued ?? (defs.intervals.has(name) ? "an interval" : nil) {
        throw LanguageError("\(name) is \(kind) — move its definition above where it is used.")
      }
      throw LanguageError(
        defs.errors.has(name) ? "\(name) has an error in its definition." : "\(name) is not defined.")
    }
    if visiting.contains(name) { throw LanguageError("\(name) is defined in terms of itself.") }
    visiting.insert(name)
    var env: [String: Double] = ["t": 0]
    // States are leaves here: the integrator supplies their values, so they
    // stand in as 0 and never recurse.
    let reads = freeVars(e).list.filter { $0 != "t" }
    for fv in reads { env[fv] = 0 }
    walk.append(Check(name: name, expr: e, reads: reads, env: env))
  }
  func checkAll(_ root: String) throws {
    var visiting: Set<String> = []
    walk = []
    try check(root, &visiting)
    while var top = walk.popLast() {
      if top.next < top.reads.count {
        let fv = top.reads[top.next]
        top.next += 1
        walk.append(top)
        if !states.names.contains(fv), !sound.contains(fv) { try check(fv, &visiting) }
        continue
      }
      visiting.remove(top.name)
      _ = try evaluate(top.expr, top.env)
      sound.insert(top.name)
    }
  }
  var bad: [String] = []
  for name in defs.consts.keys {
    do {
      try checkAll(name)
    } catch {
      defs.errors[name] = (error as? LanguageError)?.message ?? "\(error)"
      bad.append(name)
    }
  }
  for name in bad { defs.consts[name] = nil }

  validateStates(&defs, states, constNames: constNames)

  // Component validation is atomic at the owner boundary: a failed vector
  // cannot leave usable scalar aliases behind, or hide its error on an alias.
  for (component, owner) in compOwner.entries {
    if let error = defs.errors[component] {
      defs.errors[owner] = error
      defs.errors[component] = nil
    }
  }
  for d in raw {
    guard let dimension = defs.pointDims[d.name] else { continue }
    let owner = d.name
    let names = pointComps(owner, dimension)
    let inFields = names.contains(where: defs.fields.has)
    let whole = names.allSatisfy { inFields ? defs.fields.has($0) : defs.consts.has($0) }
    if defs.points.contains(owner) && whole && !defs.errors.has(owner) { continue }
    dropPoint(owner)
    for c in names {
      defs.consts[c] = nil
      defs.fields[c] = nil
    }
  }
  for (component, owner) in states.vecOwnerKey.entries
  where defs.vecStates[owner] == nil || defs.errors.has(owner) {
    defs.states[component] = nil
  }

  // A successful sibling may already have been inlined before another
  // definition failed. Retain source dependencies, so no binding can outlive
  // a failed one merely because its lowered expression hid that reference.
  if !defs.errors.isEmpty {
    func ownerOf(_ name: String) -> String {
      compOwner[name] ?? states.vecOwnerKey[name] ?? states.familyOwner[name] ?? fitOwner[name] ?? name
    }
    let known = Set(byName.keys).union(compOwner.keys).union(states.vecOwnerKey.keys).union(defs.consts.keys)
      .union(fitOwner.keys)
    func present(_ name: String) -> Bool {
      defs.consts.has(name) || defs.fields.has(name) || defs.conditions.has(name) || defs.points.contains(name)
        || defs.complexes.has(name)
        || defs.fns[name] != nil || defs.unsupported[name] != nil || defs.mats.has(name) || defs.tensors.has(name)
        || defs.multivectors.has(name)
        || defs.states.has(name) || defs.vecStates[name] != nil
        || defs.lists.has(name) || defs.intervals.has(name) || defs.tables.has(name) || defs.missingData.has(name)
    }
    func references(_ expr: Expr) -> NameSet {
      var names = freeVars(expr)
      func calls(_ node: Expr) {
        if case .call(let name, _) = node, fnNames.contains(name) { names.insert(name) }
        for child in childrenOf(node) { calls(child) }
      }
      calls(expr)
      return names
    }
    func sourceRefs(_ name: String) -> NameSet {
      let owner = ownerOf(name)
      var names = parsed[owner].map(references) ?? NameSet()
      if case .function(_, let params, _)? = byName[owner] {
        for param in params { names.remove(param) }
      }
      if case .regression? = byName[owner] {
        for (parameter, fit) in fitOwner.entries where fit == owner { names.remove(parameter) }
      }
      return names
    }
    func failedRef(_ refs: NameSet) -> String? {
      for name in refs {
        let u = Array(name.utf16)
        let head = u.firstIndex(of: unit(".")).map { String(u[..<$0]) } ?? name
        if known.contains(head) && !present(head) { return ownerOf(head) }
      }
      return nil
    }
    func forget(_ name: String) {
      defs.consts[name] = nil
      defs.fields[name] = nil
      defs.conditions[name] = nil
      defs.fns[name] = nil
      defs.complexes[name] = nil
      defs.mats[name] = nil
      defs.tensors[name] = nil
      defs.multivectors[name] = nil
      defs.states[name] = nil
      defs.lists[name] = nil
      defs.intervals[name] = nil
      defs.tables[name] = nil
      defs.missingData[name] = nil
    }
    func remove(_ name: String) {
      let owner = ownerOf(name)
      if compOwner.has(name) {
        dropPoint(owner)
        for alias in pointComps(owner, defs.pointDims[owner] ?? 2) { forget(alias) }
      } else if states.vecOwnerKey.has(name) {
        // The dimension map may have been removed by earlier validation.
        for (alias, state) in states.vecOwnerKey.entries where state == owner { defs.states[alias] = nil }
        defs.vecStates[owner] = nil
      } else if fitOwner.has(name) {
        for (parameter, fit) in fitOwner.entries where fit == owner { defs.consts[parameter] = nil }
        defs.fits[owner] = nil
      } else {
        forget(name)
      }
    }
    var changed = true
    while changed {
      changed = false
      var candidates: [(String, Expr, [String])] = []
      candidates += defs.consts.entries.map { ($0.key, $0.value, []) }
      candidates += defs.fields.entries.map { ($0.key, $0.value, []) }
      candidates += defs.complexes.entries.map { ($0.key, $0.value, []) }
      candidates += defs.conditions.entries.map { ($0.key, $0.value, []) }
      candidates += defs.states.entries.map { ($0.key, $0.value.deriv, []) }
      candidates += defs.fns.entries.map { ($0.key, $0.value.body, $0.value.params) }
      // (A matrix's entries are checked one by one, to the same end.)
      for (name, matrix) in defs.mats.entries { candidates += matrix.flatMap { $0 }.map { (name, $0, []) } }
      for (name, tensor) in defs.tensors.entries { candidates += tensor.data.map { (name, $0, []) } }
      candidates += defs.multivectors.entries.map { ($0.key, $0.value, []) }
      candidates += defs.lists.entries.map { ($0.key, $0.value.e, []) }
      candidates += defs.intervals.entries.map { ($0.key, $0.value, []) }
      for (name, expr, params) in candidates where present(name) {
        var refs = sourceRefs(name)
        for ref in references(expr) { refs.insert(ref) }
        for param in params { refs.remove(param) }
        guard let failed = failedRef(refs) else { continue }
        let owner = ownerOf(name)
        if !defs.errors.has(owner) { defs.errors[owner] = "\(failed) has an error in its definition." }
        remove(name)
        changed = true
      }
    }
    // Initial conditions retain their established recoverable behavior: an
    // invalid component gets the zero seed, while its state and valid sibling
    // seeds survive. Direct tuple sources preserve per-component provenance.
    for (name, state) in defs.states.entries {
      let owner = ownerOf(name)
      var source = parsed["\(owner)(0)"]
      if case .vec(let items)? = source, states.vecOwnerKey.has(name),
        let at = vecStateComps(owner, defs.vecStates[owner] ?? 0).firstIndex(of: name), at < items.count
      {
        source = items[at]
      }
      var refs = references(state.initial)
      if let source {
        for ref in references(source) { refs.insert(ref) }
      }
      guard let failed = failedRef(refs) else { continue }
      let row = "\(owner)(0)"
      if !defs.errors.has(row) { defs.errors[row] = "\(failed) has an error in its definition." }
      defs.states[name] = StateDef(deriv: state.deriv, initial: .num(0))
    }
  }
  defs.sumBoundConsts = boundConsts.names
  return defs
}

/// Constants with no fixed value: those depending on t, directly or through
/// other constants (`animatedConstNames`).
func animatedConstNames(_ defs: BuiltDefs) -> Set<String> {
  var out: Set<String> = []
  var changed = true
  while changed {
    changed = false
    for (name, e) in defs.consts.entries where !out.contains(name) {
      if freeVars(e).contains(where: { $0 == "t" || out.contains($0) || defs.states.has($0) }) {
        out.insert(name)
        changed = true
      }
    }
  }
  return out
}

/// Every constant's value at a time (lib/env.ts `evaluateFrame`). State
/// references read the supplied integrated values (`states`), which are in
/// the result too; derivative expressions are never evaluated here.
func evaluateFrame(_ defs: BuiltDefs, time: Double, states: [String: Double] = [:]) throws -> [String: Double] {
  var out = states
  var visiting: Set<String> = []
  // (Port: lib/env.ts `evaluateFrame`'s `get` calls itself for each name a
  // constant reads; here the walk keeps its own stack, so a long chain of
  // definitions — a recurrence's terms are one — costs none of the thread's.)
  struct Pending {
    var name: String
    var expr: Expr
    var reads: [String]
    var next = 0
    var vars: [String: Double]
  }
  var walk: [Pending] = []
  func enter(_ name: String) throws {
    guard let expr = defs.consts[name] else { throw LanguageError("\(name) is not defined.") }
    if visiting.contains(name) { throw LanguageError("\(name) is defined in terms of itself.") }
    visiting.insert(name)
    walk.append(
      Pending(name: name, expr: expr, reads: freeVars(expr).list.filter { $0 != "t" }, vars: ["t": time]))
  }
  for name in defs.consts.keys where out[name] == nil {
    try enter(name)
    while var top = walk.popLast() {
      if top.next < top.reads.count {
        let fv = top.reads[top.next]
        if let value = out[fv] {
          top.vars[fv] = value
          top.next += 1
          walk.append(top)
        } else {
          walk.append(top)
          try enter(fv)
        }
        continue
      }
      out[top.name] = try evaluate(top.expr, top.vars)
      visiting.remove(top.name)
    }
  }
  return out
}
