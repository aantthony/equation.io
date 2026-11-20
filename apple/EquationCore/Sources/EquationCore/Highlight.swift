/// Editor syntax coloring (lib/highlight.ts). Pure and tolerant: a row
/// half-typed, unbalanced or invalid still colors, because this is a scan of
/// the text, not a parse: the parser throws on what the typist has not
/// finished yet. Names are colored by what the document binds, so `mean` is a
/// function until a row binds `mean = [1, 2]`.
///
/// Offsets are UTF-16, as in the TypeScript and in the editor's text storage.
/// The TypeScript's regular expressions are written out as scans over the
/// code units: the core has no Foundation to match them with.

/// `name` is a name the document or the row binds; `unbound` one nothing
/// does yet: mid-typing, a typo, or a row that failed to define it.
public enum SpanClass: String, Equatable, Sendable {
  case num, str, fn, const, coord, name, unbound, op
}

/// A stretch of a row in one color (lib/highlight.ts `Span`; Swift has a
/// `Span` of its own, so it is named for what it is).
public struct HighlightSpan: Equatable, Sendable {
  public var start: Int
  public var end: Int
  public var cls: SpanClass
  /// The canonical name a name span refers to (dotted for a column).
  public var name: String?
  /// The name is applied: `(` follows it.
  public var called = false
}

/// What the highlighter reads of a document's definitions (lib/env.ts `Env`,
/// as `nameClass` and `highlightSpans` use it): the names bound, which of
/// them are functions, and the sequences.
public struct BoundNames: Equatable, Sendable {
  /// A sequence row's letter and the names it binds in every row that uses
  /// its terms (lib/seq.ts `SeqScan`): `a_{n+1} = …` has name `a`, index `n`.
  public struct Sequence: Equatable, Sendable {
    public var name: String
    public var index: String
    public var cell: String?
    public var cell2: String?

    public init(name: String, index: String, cell: String? = nil, cell2: String? = nil) {
      self.name = name
      self.index = index
      self.cell = cell
      self.cell2 = cell2
    }
  }

  /// Every bound name that is not a function, a vector's components
  /// (`A_x`, `r_1`) included.
  public var values: Set<String>
  /// The document's own functions: `f` of `f(x) = x^2`.
  public var functions: Set<String>
  public var sequences: [Sequence]

  public init(values: Set<String> = [], functions: Set<String> = [], sequences: [Sequence] = []) {
    self.values = values
    self.functions = functions
    self.sequences = sequences
  }

  /// The names `rows` bind, by `collectBoundNames`.
  public init(rows: [String]) {
    self = collectBoundNames(rows)
  }
}

/// Each row's colored spans, in order, as the site computes them for the
/// app (web/main.ts `rowSpans`), given the names the document binds.
public func highlightRows(_ rows: [String], names: BoundNames) -> [[HighlightSpan]] {
  rows.map { highlightSpans($0, names) }
}

/// Each row's colored spans, with the bound names read off the rows themselves.
public func highlightRows(_ rows: [String]) -> [[HighlightSpan]] {
  highlightRows(rows, names: BoundNames(rows: rows))
}

// MARK: - Builtin names

/// Builtins lib/expr.ts `FUNCTIONS` has gained since Parser.swift's
/// `functions` was written (all of them shadowable). Delete each as that
/// table gains it; the highlight fixture's tables say when the two agree.
let laterFunctions: Set<String> = ["gaussian", "meancurvature", "geodesic", "lightray", "lightcone", "tidal"]

/// lib/expr.ts `builtinFn`, over the whole of `FUNCTIONS`.
private func highlightBuiltinFn(_ name: String) -> Bool {
  if builtinFn(name) != nil || laterFunctions.contains(name) { return true }
  return laterFunctions.contains(name.lowercased())
}

/// The call forms that are not functions (lib/syntax-help.ts `signatures`,
/// less `FUNCTIONS`): they only read as built-in when called.
let callForms: Set<String> = [
  "view", "grid", "graph", "mark", "open", "Normal", "Uniform", "Exponential", "Gamma", "Beta", "ChiSquared",
  "StudentT", "LogNormal", "Cauchy", "Weibull", "Binomial", "Poisson", "Geometric", "NegativeBinomial", "Bernoulli",
  "DiscreteUniform", "P", "E",
]

/// Every distribution's name and aliases, lowercased: a law is spelled in
/// any capitalization (lib/dist-families.ts `distFamily`).
let distributionNames: Set<String> = [
  "normal", "n", "uniform", "u", "exponential", "exp", "gamma", "beta", "chisquared", "chisq", "chi2", "studentt",
  "t", "lognormal", "cauchy", "weibull", "binomial", "binom", "poisson", "pois", "geometric", "geom",
  "negativebinomial", "negbin", "bernoulli", "discreteuniform",
]

/// The constants a name can spell (lib/expr.ts `CONSTANTS`).
let constantNames: Set<String> = ["pi", "e"]

/// Whether lib/syntax-help.ts `builtinHelp` describes the name. The call
/// forms that are not functions (P(…), view(…), a distribution) only count
/// when `called`: bare, `n` is a sum's index, not Normal by its alias N.
private func isBuiltin(_ name: String, called: Bool) -> Bool {
  if highlightBuiltinFn(name) { return true }
  return called && (callForms.contains(name) || distributionNames.contains(name.lowercased()))
}

/// The plot's own variables: meaningful in any row without a definition.
private let coords: Set<String> = ["x", "y", "z", "t", "u", "v", "w"]

/// The unit vectors and blades: e_x, e_y, e_z, e_xy, e_yz, e_zx, e_xyz.
private let basisNames: Set<String> = ["e_x", "e_y", "e_z", "e_xy", "e_yz", "e_zx", "e_xyz"]

/// Calculus notation: d/dx, the dx of an integral (`^d[xyztuvw]?$`).
private func isDifferential(_ name: String) -> Bool {
  name == "d" || (name.utf16.count == 2 && name.hasPrefix("d") && coords.contains(String(name.dropFirst())))
}

private func nameClass(_ name: String, _ names: BoundNames, called: Bool) -> SpanClass? {
  if names.functions.contains(name) { return .fn }
  if names.values.contains(name) { return .name }
  if let dot = name.firstIndex(of: "."), dot > name.startIndex {
    let head = String(name[..<dot])
    if names.values.contains(head) || names.functions.contains(head) { return .name }
  }
  // A sequence's terms: a_n, a_ before {n+1}, a_0.
  if let under = name.lastIndex(of: "_"), under > name.startIndex {
    let letter = name[..<under]
    if names.sequences.contains(where: { $0.name == letter }) { return .name }
  }
  if constantNames.contains(name) || name == "i" || name == "inf" { return .const }
  if basisNames.contains(name) { return .const }
  if coords.contains(name) || isDifferential(name) { return .coord }
  return isBuiltin(name, called: called) ? .fn : nil
}

// MARK: - Scanning

/// A position in a row's code units, with the pieces the TypeScript's
/// regular expressions are made of.
private struct Cursor {
  let u: [UInt16]
  var i: Int
  let end: Int

  init(_ u: [UInt16], _ range: Range<Int>? = nil) {
    self.u = u
    self.i = range?.lowerBound ?? 0
    self.end = range?.upperBound ?? u.count
  }

  var peek: UInt16? { i < end ? u[i] : nil }
  var done: Bool { i >= end }

  /// `\s*`
  mutating func spaces() {
    while i < end, isJSWhitespace(u[i]) { i += 1 }
  }

  mutating func eat(_ c: UInt16) -> Bool {
    guard i < end, u[i] == c else { return false }
    i += 1
    return true
  }

  /// A name as written (lib/expr.ts `NAME_SRC`).
  mutating func name() -> Range<Int>? {
    guard i < end, isRowNameStart(u[i]) else { return nil }
    let start = i
    i += 1
    while i < end, isRowNameChar(u[i]) { i += 1 }
    return start..<i
  }

  /// `=(?!=)`
  mutating func assign() -> Bool {
    guard i < end, u[i] == 0x3D, !(i + 1 < end && u[i + 1] == 0x3D) else { return false }
    i += 1
    return true
  }

  /// `\d+`
  mutating func digits() -> Range<Int>? {
    let start = i
    while i < end, isDigit(u[i]) { i += 1 }
    return i > start ? start..<i : nil
  }

  /// An ASCII word, whatever its case: the `/i` of the row-shape patterns.
  mutating func word(_ lower: String) -> Bool {
    var k = i
    for c in lower.utf16 {
      guard k < end, u[k] | 0x20 == c, isASCIILetter(u[k]) else { return false }
      k += 1
    }
    i = k
    return true
  }

  func text(_ range: Range<Int>) -> String {
    String(decoding: u[range], as: UTF16.self)
  }
}

/// Names the row binds for itself, which no definition will ever claim: a
/// function row's parameters (`f(x, k) =`) and an index a sum, product or
/// list binds in place (`sum[n=1..N]`, `prod(k=1..N, k)`).
private func rowLocals(_ u: [UInt16], _ end: Int) -> Set<String> {
  var locals = Set<String>()
  // ^\s*NAME\s*\(([^)]*)\)\s*=(?!=)
  var c = Cursor(u, 0..<end)
  c.spaces()
  if c.name() != nil {
    c.spaces()
    if c.eat(0x28) {
      let open = c.i
      while let p = c.peek, p != 0x29 { c.i += 1 }
      let close = c.i
      if c.eat(0x29) {
        c.spaces()
        if c.assign() {
          for param in u[open..<close].split(separator: 0x2C, omittingEmptySubsequences: false) {
            let trimmed = trimmedRange(u, param.startIndex..<param.endIndex)
            if !trimmed.isEmpty { locals.insert(canonicalName(c.text(trimmed))) }
          }
        }
      }
    }
  }
  // [[(,]\s*(NAME)\s*=(?!=), wherever it matches
  var k = 0
  while k < end {
    guard u[k] == 0x5B || u[k] == 0x28 || u[k] == 0x2C else {
      k += 1
      continue
    }
    var c = Cursor(u, (k + 1)..<end)
    c.spaces()
    if let name = c.name() {
      c.spaces()
      if c.assign() {
        locals.insert(canonicalName(c.text(name)))
        k = c.i
        continue
      }
    }
    k += 1
  }
  return locals
}

/// Colored spans of a row, in order (lib/highlight.ts `highlightSpans`). A
/// `#` comment row, a trailing note and a viewport row have none: the editor
/// sets them apart as a whole.
public func highlightSpans(_ text: String, _ names: BoundNames) -> [HighlightSpan] {
  let u = Array(text.utf16)
  if isCommentRow(u) || isViewportText(u, trimmedRange(u)) { return [] }
  let note = noteOffset(u)
  let end = note < 0 ? u.count : note
  var spans: [HighlightSpan] = []
  var locals = rowLocals(u, end)
  // A sequence's index (n in a_{n+1}) and a lattice's cells are names in every row that uses them.
  for scan in names.sequences {
    for index in [scan.index, scan.cell, scan.cell2] {
      if let index, !index.isEmpty { locals.insert(index) }
    }
  }
  var i = 0
  while i < end {
    let c = u[i]
    if c == 0x22 || (c == 0x27 && !(i > 0 && isValueEnd(u[i - 1]))) {
      let close = u[(i + 1)...].firstIndex(of: c)
      let stop = close.map { $0 >= end ? end : $0 + 1 } ?? end
      spans.append(HighlightSpan(start: i, end: stop, cls: .str))
      i = stop
      continue
    }
    // A name, its primes, and any dotted members: f'', person.age, A.x.
    var word = Cursor(u, i..<end)
    if word.name() != nil {
      while word.eat(0x27) {}
      while true {
        var member = word
        guard member.eat(0x2E), member.name() != nil else { break }
        word = member
      }
      let stop = word.i
      let bare = u[i..<stop].filter { $0 != 0x27 }
      let name = canonicalName(String(decoding: bare, as: UTF16.self))
      word.spaces()
      let called = word.peek == 0x28
      let cls = nameClass(name, names, called: called) ?? (locals.contains(name) ? .name : .unbound)
      spans.append(HighlightSpan(start: i, end: stop, cls: cls, name: name, called: called))
      i = stop
      continue
    }
    // A range's `..`, consumed whole so `0..1` never reads `.1`.
    if c == 0x2E, i + 1 < end, u[i + 1] == 0x2E {
      while i < end, u[i] == 0x2E { i += 1 }
      continue
    }
    if let stop = numberEnd(u, i, end) {
      spans.append(HighlightSpan(start: i, end: stop, cls: .num))
      i = stop
      continue
    }
    if isRowGlyph(c) {
      // π and ∞ are constants; Σ ∏ ∫ ∇ are applied.
      let cls: SpanClass = c == 0x03C0 || c == 0x221E ? .const : .fn
      spans.append(HighlightSpan(start: i, end: i + 1, cls: cls, name: String(decoding: [c], as: UTF16.self)))
      i += 1
      continue
    }
    // Relations and binders: where a row says what it is. Arithmetic stays plain.
    if (c == 0x3C || c == 0x3E || c == 0x3A), i + 1 < end, u[i + 1] == 0x3D {
      spans.append(HighlightSpan(start: i, end: i + 2, cls: .op))
      i += 2
      continue
    }
    switch c {
    case 0x3D, 0x3C, 0x3E, 0x2264, 0x2265, 0x2260, 0x7E, 0x2208, 0x3A:  // = < > ≤ ≥ ≠ ~ ∈ :
      spans.append(HighlightSpan(start: i, end: i + 1, cls: .op))
    default:
      break
    }
    i += 1
  }
  return spans
}

/// Where the number at `i` ends, or nil: `\d+(?:\.(?!\.)\d*)?|\.\d+`, greedy
/// like the tokenizer except that `1..N` leaves `1` and the range operator;
/// failing that, a run of superscript exponents.
private func numberEnd(_ u: [UInt16], _ i: Int, _ end: Int) -> Int? {
  var k = i
  while k < end, isDigit(u[k]) { k += 1 }
  if k > i {
    if k < end, u[k] == 0x2E, !(k + 1 < end && u[k + 1] == 0x2E) {
      k += 1
      while k < end, isDigit(u[k]) { k += 1 }
    }
    return k
  }
  if u[i] == 0x2E {
    k = i + 1
    while k < end, isDigit(u[k]) { k += 1 }
    return k > i + 1 ? k : nil
  }
  while k < end, superscripts[u[k]] != nil { k += 1 }
  return k > i ? k : nil
}

// MARK: - Row shapes

/// A viewport row by its text: a `---` divider, or a view/camera/grid/on
/// call that is not the definition of a function by that name, `grid(x) = …`
/// (lib/analysis.ts `isViewportText`).
private func isViewportText(_ u: [UInt16], _ range: Range<Int>) -> Bool {
  if isDividerRow(u, range) { return true }
  var c = Cursor(u, range)
  guard c.word("view") || c.word("camera") || c.word("grid") || c.word("on") else { return false }
  c.spaces()
  return c.eat(0x28) && scanDefinition(u, range) == nil
}

/// Whether the text is a divider row, well-formed or not (lib/panels.ts
/// `isDividerRow`). `---x` and `--- x` stay math (negations of x): only a
/// bare run of dashes, or one followed by a placement word or a size, is a
/// divider.
private func isDividerRow(_ u: [UInt16], _ range: Range<Int>) -> Bool {
  var c = Cursor(u, range)
  var dashes = 0
  while c.eat(0x2D) { dashes += 1 }
  guard dashes >= 3 else { return false }
  c.spaces()
  // The first of the tokens `[\s,]+` separates, lowercased.
  while let p = c.peek, p == 0x2C || isJSWhitespace(p) { c.i += 1 }
  let start = c.i
  while let p = c.peek, p != 0x2C, !isJSWhitespace(p) { c.i += 1 }
  if c.i == start { return true }
  let token = String(decoding: u[start..<c.i].map { isASCIILetter($0) ? $0 | 0x20 : $0 }, as: UTF16.self)
  let words: Set<String> = ["right", "left", "below", "above", "top", "bottom", "inset", "shared"]
  let corners: Set<String> = ["top-left", "top-right", "bottom-left", "bottom-right"]
  if words.contains(token) || corners.contains(token) { return true }
  // A size: ^(\d+(?:\.\d+)?)%$
  var size = Cursor(u, start..<c.i)
  guard size.digits() != nil else { return false }
  if size.eat(0x2E), size.digits() == nil { return false }
  return size.eat(0x25) && size.done
}

/// What a definition row defines (lib/defs.ts `Definition`), as far as the highlighter reads it.
private enum DefinitionKind {
  case state, initial, table, fn, const, draw
}

private struct ScannedDefinition {
  var kind: DefinitionKind
  var name: String
  /// The right side, in the units `scanDefinition` was given.
  var rhs: [UInt16]
}

/// A data file's hash, as a row pins it, is at least this many hex digits (lib/hash.ts `HASH_TOKEN_LEN`).
private let hashTokenLength = 12

/// Detect a definition row by its shape, before any parsing (lib/defs.ts
/// `scanDefinition`), for the row's name and kind.
private func scanDefinition(_ whole: [UInt16], _ range: Range<Int>) -> ScannedDefinition? {
  let u = unbraceTerm(Array(whole[range]))
  /// `^\s*(NAME)`, then whatever `shape` reads up to the `=`, then `=(?!=)` and a right side.
  func row(_ kind: DefinitionKind, _ shape: (inout Cursor) -> Bool) -> ScannedDefinition? {
    var c = Cursor(u)
    c.spaces()
    guard let name = c.name(), shape(&c) else { return nil }
    c.spaces()
    guard c.assign(), !c.done else { return nil }
    let canonical = canonicalName(c.text(name))
    return nameable(canonical) ? ScannedDefinition(kind: kind, name: canonical, rhs: Array(u[c.i...])) : nil
  }
  // Primes first: `a' = …` is a state, but the reserved coordinate names keep their ODE meaning.
  if let state = row(.state, { $0.eat(0x27) }) { return state }
  // NAME(0) = …
  let initial = row(.initial) { c in
    c.spaces()
    guard c.eat(0x28) else { return false }
    c.spaces()
    guard c.eat(0x30) else { return false }
    c.spaces()
    return c.eat(0x29)
  }
  if let initial { return initial }
  // Before the function form: `open(…)` takes a file name, not parameters. A
  // row that plainly means to open a file but does not read as one is not a
  // constant either.
  if let open = scanOpen(u) {
    return open.wellFormed && nameable(open.name) ? ScannedDefinition(kind: .table, name: open.name, rhs: []) : nil
  }
  // NAME(NAME, NAME, …) = …
  let fn = row(.fn) { c in
    c.spaces()
    guard c.eat(0x28) else { return false }
    repeat {
      c.spaces()
      guard c.name() != nil else { return false }
      c.spaces()
    } while c.eat(0x2C)
    return c.eat(0x29)
  }
  if let fn { return fn }
  // NAME = …; `u = interval(0, 2pi)` sets the range u runs over.
  var c = Cursor(u)
  c.spaces()
  if let name = c.name() {
    let canonical = canonicalName(c.text(name))
    var equals = c
    equals.spaces()
    if equals.assign(), !equals.done {
      let rhs = Array(u[equals.i...])
      if nameable(canonical) || ((canonical == "u" || canonical == "v") && namesInterval(rhs)) {
        return ScannedDefinition(kind: .const, name: canonical, rhs: rhs)
      }
    }
    // `p ∈ A` (or `p \in A`): a binder, a draw from A.
    c.spaces()
    var drawn = c.eat(0x2208)
    if !drawn, c.eat(0x5C), c.eat(0x69), c.eat(0x6E) {  // \in\b
      drawn = !(c.peek.map { isASCIILetter($0) || isDigit($0) || $0 == 0x5F } ?? false)
    }
    c.spaces()
    if drawn, !c.done, nameable(canonical) {
      return ScannedDefinition(kind: .draw, name: canonical, rhs: Array(u[c.i...]))
    }
  }
  return nil
}

/// A subscript written in braces, as a recurrence row is: `a_{0} = 1` defines
/// a_0 (the seed), `T_{c} = 300` defines T_c. Parens only around a number:
/// `f_(x) = …` is a function (lib/defs.ts `BRACED_TERM_RE`).
private func unbraceTerm(_ u: [UInt16]) -> [UInt16] {
  var c = Cursor(u)
  c.spaces()
  guard let letter = c.peek, isSequenceLetter(letter) else { return u }
  c.i += 1
  let head = c.i
  guard c.eat(0x5F) else { return u }
  var inner: Range<Int>?
  if c.eat(0x7B) {
    c.spaces()
    if let number = c.digits() {
      inner = number
    } else if let p = c.peek, isSequenceLetter(p) {
      // [A-Za-zGreek]\w*
      let start = c.i
      c.i += 1
      while let p = c.peek, isASCIILetter(p) || isDigit(p) || p == 0x5F { c.i += 1 }
      inner = start..<c.i
    }
    c.spaces()
    guard c.eat(0x7D) else { return u }
  } else if c.eat(0x28) {
    c.spaces()
    inner = c.digits()
    c.spaces()
    guard c.eat(0x29) else { return u }
  }
  guard let inner else { return u }
  var after = c
  after.spaces()
  guard after.assign() else { return u }
  return Array(u[..<head]) + [0x5F] + u[inner] + u[c.i...]
}

/// `\binterval\s*\(`, in any case.
private func namesInterval(_ u: [UInt16]) -> Bool {
  for k in u.indices {
    if k > 0, isASCIILetter(u[k - 1]) || isDigit(u[k - 1]) || u[k - 1] == 0x5F { continue }
    var c = Cursor(u, k..<u.count)
    guard c.word("interval") else { continue }
    c.spaces()
    if c.eat(0x28) { return true }
  }
  return false
}

/// A row that means to open a file, `name = open("file.csv", hash)`: its
/// name, and whether it says so well enough to be one (lib/defs.ts
/// `OPEN_HEAD_RE`, `TABLE_RE`).
private func scanOpen(_ u: [UInt16]) -> (name: String, wellFormed: Bool)? {
  var c = Cursor(u)
  c.spaces()
  guard let name = c.name() else { return nil }
  c.spaces()
  guard c.eat(0x3D) else { return nil }
  c.spaces()
  for letter in "open".utf16 { guard c.eat(letter) else { return nil } }
  c.spaces()
  guard c.eat(0x28) else { return nil }
  c.spaces()
  guard let quote = c.peek, quote == 0x22 || quote == 0x27 else { return nil }
  let canonical = canonicalName(c.text(name))
  c.i += 1
  while let p = c.peek, p != quote { c.i += 1 }
  guard c.eat(quote) else { return (canonical, false) }
  c.spaces()
  if c.eat(0x2C) {
    c.spaces()
    let start = c.i
    while let p = c.peek, isDigit(p) || (0x61...0x66).contains(p | 0x20) { c.i += 1 }
    guard (hashTokenLength...64).contains(c.i - start) else { return (canonical, false) }
    c.spaces()
  }
  guard c.eat(0x29) else { return (canonical, false) }
  c.spaces()
  return (canonical, c.done)
}

// MARK: - Sequences

/// A sequence letter: one Latin or Greek letter (a_n, θ_n).
private func isSequenceLetter(_ u: UInt16) -> Bool { isRowNameStart(u) && u != 0x5F }

/// How a sequence row reads (lib/seq.ts `scanSeqRec`), as far as the names it binds go.
private enum SequenceRow {
  /// `a_n = …` or the recurrence `a_{n+1} = …`.
  case terms(name: String, index: String, rec: Bool, rhs: [UInt16])
  /// An automaton's rule or seed over cells, or a table `T[i, j] = …`: no
  /// name of the document's, and no row of definitions.
  case lattice(name: String, rule: Bool)
  /// `L_0 = [` or `s_0 = ()`: a seed if its letter turns out to be an automaton or a recurrence.
  case seed(name: String, list: Bool)
}

private func scanSeqRec(_ u: [UInt16]) -> SequenceRow? {
  var c = Cursor(u)
  c.spaces()
  guard let letter = c.peek, isSequenceLetter(letter) else { return nil }
  c.i += 1
  let name = String(decoding: [letter], as: UTF16.self)
  /// One sequence letter, between optional spaces.
  func index(_ c: inout Cursor) -> String? {
    c.spaces()
    guard let p = c.peek, isSequenceLetter(p) else { return nil }
    c.i += 1
    c.spaces()
    return String(decoding: [p], as: UTF16.self)
  }
  /// `[i]` or `[i, j]`: the cells an automaton row is written over.
  func cells(_ c: inout Cursor, pair: Bool = false) -> Bool {
    var k = c
    guard k.eat(0x5B), index(&k) != nil else { return false }
    let comma = k.eat(0x2C)
    if comma { guard index(&k) != nil else { return false } }
    guard k.eat(0x5D), comma || !pair else { return false }
    c = k
    return true
  }
  /// `=(?!=)` and a right side.
  func rhs(_ c: Cursor) -> [UInt16]? {
    var k = c
    k.spaces()
    guard k.assign(), !k.done else { return nil }
    return Array(u[k.i...])
  }
  // T[i, j] = …: a function on the integer lattice.
  var table = c
  table.spaces()
  if cells(&table, pair: true), rhs(table) != nil { return .lattice(name: name, rule: false) }
  guard c.eat(0x5F) else { return nil }
  enum Sub { case step(String), zero, plain(String) }
  var sub: Sub?
  let open = c.peek
  if open == 0x7B || open == 0x28 {
    let close: UInt16 = open == 0x7B ? 0x7D : 0x29
    c.i += 1
    var zero = c
    zero.spaces()
    if zero.eat(0x30) {
      zero.spaces()
      guard zero.eat(close) else { return nil }
      c = zero
      sub = .zero
    } else {
      guard let letter = index(&c) else { return nil }
      if c.eat(0x2B) {
        c.spaces()
        guard c.eat(0x31) else { return nil }
        c.spaces()
        sub = .step(letter)
      } else {
        sub = .plain(letter)
      }
      guard c.eat(close) else { return nil }
    }
  } else if c.eat(0x30) {
    sub = .zero
  } else if let p = c.peek, isSequenceLetter(p) {
    c.i += 1
    sub = .plain(String(decoding: [p], as: UTF16.self))
  }
  guard let sub else { return nil }
  var celled = c
  celled.spaces()
  let hasCells = cells(&celled)
  switch sub {
  case .step(let index):
    if hasCells, rhs(celled) != nil { return .lattice(name: name, rule: true) }
    return rhs(c).map { .terms(name: name, index: index, rec: true, rhs: $0) }
  case .zero:
    if hasCells, rhs(celled) != nil { return .lattice(name: name, rule: false) }
    guard let right = rhs(c) else { return nil }
    let value = trimmedRange(right)
    if right[value].first == 0x5B { return .seed(name: name, list: true) }
    // ^\(\s*\)$
    var empty = Cursor(right, value)
    if empty.eat(0x28) {
      empty.spaces()
      if empty.eat(0x29), empty.done { return .seed(name: name, list: false) }
    }
    return nil
  case .plain(let index):
    // Every letter_letter row used to be a sequence, which stole the
    // subscripted constants physics and chemistry are written with (T_c,
    // k_B, v_x). Require a conventional index or one the term actually uses.
    guard let right = rhs(c) else { return nil }
    let conventional = index == "n" || index == "k" || index == "m"
    guard conventional || (!reservedNames.contains(index) && usesIndex(right, index)) else { return nil }
    return .terms(name: name, index: index, rec: false, rhs: right)
  }
}

/// The index as a standalone identifier in the term: `a_j = 1/j^2` is a
/// sequence, but `T_c = 300` and `k_B = 1.38` are subscripted constants.
private func usesIndex(_ rhs: [UInt16], _ index: String) -> Bool {
  let letter = index.utf16.first!
  for (k, c) in rhs.enumerated() where c == letter {
    let before = k > 0 && isRowNameChar(rhs[k - 1])
    let after = k + 1 < rhs.count && isRowNameChar(rhs[k + 1])
    if !before && !after { return true }
  }
  return false
}

// MARK: - Bound names

/// The names a document's rows bind, read off the rows' shapes alone.
///
/// A stand-in for the definitions port: the site colors names by the `Env`
/// that lib/defs.ts `buildDefs` builds (lib/analysis.ts `prepareDocument`),
/// and this should be replaced by that port's Env when the app has it. Until
/// then it collects what the row scanners that run ahead of buildDefs find
/// (`scanSequences`, `scanDefinition`, a `~` row's name), and guesses a
/// tuple's components from its text. It cannot know what buildDefs learns by
/// resolving a definition, so it differs from the site where
///
/// - a definition fails (`a = b` with no `b`, `p = "text"`, a cycle, a fit
///   with no data): the site leaves its name unbound, this binds it;
/// - a value is a vector without being written as a tuple (`C = A + B`, a
///   call returning a point): the site binds its components `C_x`, `C_y`,
///   this does not.
func collectBoundNames(_ rows: [String]) -> BoundNames {
  var names = BoundNames()
  // lib/analysis.ts prepareDocument: a row is its math, without the note.
  let texts: [[UInt16]] = rows.map {
    let u = Array($0.utf16)
    let note = noteOffset(u)
    return Array(u[trimmedRange(u, 0..<(note < 0 ? u.count : note))])
  }
  let live = texts.map { !$0.isEmpty && $0[0] != 0x23 && !isViewportText($0, 0..<$0.count) }
  // lib/seq.ts scanSequences: a letter can be a sequence once. Beside
  // `a_n = 1/n`, a row like `a_k = 7` that never uses its k is the constant a_k.
  let scans = texts.indices.map { live[$0] ? scanSeqRec(texts[$0]) : nil }
  var owners = Set<String>()
  var automata = Set<String>()
  var recurrences = Set<String>()
  for case let scan? in scans {
    switch scan {
    case .terms(let name, let index, let rec, let rhs):
      if rec || usesIndex(rhs, index) { owners.insert(name) }
      if rec { recurrences.insert(name) }
    case .lattice(let name, let rule):
      owners.insert(name)
      if rule { automata.insert(name) }
    case .seed:
      break
    }
  }
  // lib/regression.ts declaredNames: names some row defines, by text alone.
  var declared = Set<String>()
  for text in texts {
    var c = Cursor(text)
    guard let name = c.name() else { continue }
    c.spaces()
    var drawn = c
    if c.assign() || drawn.eat(0x2208) || (drawn.eat(0x5C) && drawn.eat(0x69) && drawn.eat(0x6E)) {
      declared.insert(canonicalName(c.text(name)))
    }
  }
  var models: [[UInt16]] = []
  var vectorStates: [String: Int] = [:]
  for (k, text) in texts.enumerated() where live[k] {
    switch scans[k] {
    case .terms(let name, let index, let rec, let rhs)?:
      if rec || !owners.contains(name) || usesIndex(rhs, index) {
        names.sequences.append(.init(name: name, index: index))
        continue
      }
    case .lattice?:
      continue
    case .seed(let name, let list)?:
      if list ? automata.contains(name) : recurrences.contains(name) { continue }
    case nil:
      break
    }
    // A fit, `Y ~ m X + b`, is a definition of its coefficients, found once every other name is.
    if let model = regressionModel(text, declared) {
      models.append(model)
      continue
    }
    // A random variable's declaration, `X ~ Normal(0, 1)`, binds its name (lib/dist.ts).
    var c = Cursor(text)
    if let name = c.name() {
      c.spaces()
      let canonical = canonicalName(c.text(name))
      if c.eat(0x7E), nameable(canonical) {
        names.values.insert(canonical)
        continue
      }
    }
    guard let def = scanDefinition(text, 0..<text.count) else { continue }
    switch def.kind {
    case .fn:
      names.functions.insert(def.name)
    case .state, .const:
      names.values.insert(def.name)
      // A tuple is a vector, and a vector owns its components: A_x, A_y for
      // a point, r_1, r_2 for a state (lib/geom.ts pointComps, vecStateComps).
      let dim = tupleLength(def.rhs)
      if dim == 2 || dim == 3 {
        for axis in 0..<dim {
          names.values.insert(def.name + "_" + (def.kind == .state ? String(axis + 1) : ["x", "y", "z"][axis]))
        }
      }
    case .table, .draw:
      names.values.insert(def.name)
    case .initial:
      // a(0) = … is the other half of the state a' = … binds; a tuple makes it a vector state.
      let dim = tupleLength(def.rhs)
      if dim == 2 || dim == 3 { vectorStates[def.name] = dim }
    }
  }
  for (name, dim) in vectorStates where names.values.contains(name) {
    for axis in 1...dim { names.values.insert(name + "_" + String(axis)) }
  }
  // Unbound scalar names of a fit's model are its coefficients; defined constants stay fixed (lib/regression.ts).
  var coefficients = Set<String>()
  for model in models {
    var k = 0
    while k < model.count {
      var c = Cursor(model, k..<model.count)
      guard let word = c.name() else {
        k += 1
        continue
      }
      k = c.i
      let name = canonicalName(c.text(word))
      c.spaces()
      let member = model[..<word.lowerBound].last == 0x2E || c.peek == 0x2E
      if !member, nameClass(name, names, called: c.peek == 0x28) == nil { coefficients.insert(name) }
    }
  }
  names.values.formUnion(coefficients)
  names.values.subtract(names.functions)
  return names
}

/// The model of a row that fits one, `Y ~ m X + b`: one `~` outside brackets
/// and quotes, data on the left (a declared name, or an expression in lists
/// or columns), and no distribution at the head of the right side, which
/// keeps `X ~ Normal(0, 1)` a declaration (lib/regression.ts `tildeRow`).
private func regressionModel(_ u: [UInt16], _ declared: Set<String>) -> [UInt16]? {
  var quote: UInt16 = 0
  var depth = 0
  var tilde = -1
  for (k, c) in u.enumerated() {
    if quote != 0 {
      if c == quote { quote = 0 }
      continue
    }
    switch c {
    case 0x22: quote = c
    case 0x27 where !(k > 0 && isValueEnd(u[k - 1])): quote = c
    case 0x28, 0x5B, 0x7B: depth += 1
    case 0x29, 0x5D, 0x7D: depth -= 1
    case 0x7E where depth == 0:
      if tilde >= 0 { return nil }
      tilde = k
    default: break
    }
  }
  guard tilde >= 0 else { return nil }
  let lhs = u[trimmedRange(u, 0..<tilde)]
  let rhs = Array(u[trimmedRange(u, (tilde + 1)..<u.count)])
  // A law at the head, but for the spellings that are also models: exp, gamma, beta, t.
  var head = Cursor(rhs)
  if let name = head.name() {
    let spelled = head.text(name).lowercased()
    head.spaces()
    if head.done || head.peek == 0x28 {
      if distributionNames.contains(spelled), !["exp", "gamma", "beta", "t"].contains(spelled) { return nil }
      // The one carve-out: a bare `exp` is the Exponential alias.
      if spelled == "exp", name == 0..<rhs.count { return nil }
    }
  }
  let data = declared.contains(canonicalName(String(decoding: lhs, as: UTF16.self)))
  let expression = lhs.contains { [0x2E, 0x5B, 0x5D, 0x28, 0x2B, 0x2A, 0x2F, 0x2D].contains($0) }
  return data || expression ? rhs : nil
}

/// How many items a right side has when the whole of it is one
/// parenthesized tuple, `(1, 2)` or `(cos(t), sin(t), 0)`; 0 when it is not.
private func tupleLength(_ u: [UInt16]) -> Int {
  let range = trimmedRange(u)
  guard range.count >= 2, u[range.lowerBound] == 0x28, u[range.upperBound - 1] == 0x29 else { return 0 }
  var depth = 0
  var items = 1
  var quote: UInt16 = 0
  for k in range {
    let c = u[k]
    if quote != 0 {
      if c == quote { quote = 0 }
      continue
    }
    switch c {
    case 0x22: quote = c
    case 0x27 where !(k > 0 && isValueEnd(u[k - 1])): quote = c
    case 0x28, 0x5B, 0x7B: depth += 1
    case 0x29, 0x5D, 0x7D:
      depth -= 1
      // The opening paren closed before the end: (a) + (b) is no tuple.
      if depth == 0 && k != range.upperBound - 1 { return 0 }
    case 0x2C where depth == 1: items += 1
    default: break
    }
  }
  return items
}
