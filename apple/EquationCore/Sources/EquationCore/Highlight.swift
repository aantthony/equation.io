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

  /// The names `rows` bind, by their definitions (`boundNames`). A caller
  /// that analyzes the rows too has them already: `DocumentAnalysis.names`.
  public init(rows: [String]) {
    self = boundNames(prepareDocument(rows))
  }
}

/// Each row's colored spans, in order, as the site computes them for the
/// app (web/main.ts `rowSpans`), given the names the document binds.
public func highlightRows(_ rows: [String], names: BoundNames) -> [[HighlightSpan]] {
  rows.map { highlightSpans($0, names) }
}

/// Each row's colored spans, with the names the rows' definitions bind.
public func highlightRows(_ rows: [String]) -> [[HighlightSpan]] {
  highlightRows(rows, names: BoundNames(rows: rows))
}

// MARK: - Builtin names

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

/// Whether lib/syntax-help.ts `builtinHelp` describes the name. The call
/// forms that are not functions (P(…), view(…), a distribution) only count
/// when `called`: bare, `n` is a sum's index, not Normal by its alias N.
private func isBuiltin(_ name: String, called: Bool) -> Bool {
  if builtinFn(name) != nil { return true }
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
  if constants[name] != nil || name == "i" || name == "inf" { return .const }
  if basisNames.contains(name) { return .const }
  if coords.contains(name) || isDifferential(name) { return .coord }
  return isBuiltin(name, called: called) ? .fn : nil
}

// MARK: - Scanning

/// Names the row binds for itself, which no definition will ever claim: a
/// function row's parameters (`f(x, k) =`) and an index a sum, product or
/// list binds in place (`sum[n=1..N]`, `prod(k=1..N, k)`).
private func rowLocals(_ u: [UInt16], _ end: Int) -> Set<String> {
  var locals = Set<String>()
  // ^\s*NAME\s*\(([^)]*)\)\s*=(?!=)
  var c = RowScanner(u, 0..<end)
  c.space()
  if c.nameRange() != nil {
    c.space()
    if c.eat(0x28) {
      let open = c.i
      while let p = c.peek, p != 0x29 { c.i += 1 }
      let close = c.i
      if c.eat(0x29) {
        c.space()
        if c.assign() {
          for param in u[open..<close].split(separator: 0x2C, omittingEmptySubsequences: false) {
            let trimmed = jsTrim(param)
            if !trimmed.isEmpty { locals.insert(canonicalName(String(trimmed))) }
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
    var c = RowScanner(u, (k + 1)..<end)
    c.space()
    if let name = c.nameRange() {
      c.space()
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
  if isCommentRow(u) || isViewportText(jsTrimmed(text)) { return [] }
  let end = noteStart(u) ?? u.count
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
    if c == 0x22 || (c == 0x27 && !(i > 0 && endsValue(u[i - 1]))) {
      let close = u[(i + 1)...].firstIndex(of: c)
      let stop = close.map { $0 >= end ? end : $0 + 1 } ?? end
      spans.append(HighlightSpan(start: i, end: stop, cls: .str))
      i = stop
      continue
    }
    // A name, its primes, and any dotted members: f'', person.age, A.x.
    var word = RowScanner(u, i..<end)
    if word.nameRange() != nil {
      while word.eat(0x27) {}
      while true {
        var member = word
        guard member.eat(0x2E), member.nameRange() != nil else { break }
        word = member
      }
      let stop = word.i
      let bare = u[i..<stop].filter { $0 != 0x27 }
      let name = canonicalName(String(decoding: bare, as: UTF16.self))
      word.space()
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
    if glyphAliases[c] != nil {
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

// MARK: - Bound names

/// The names a document's rows bind, as the site's highlighter reads them
/// off the `Env` that lib/defs.ts `buildDefs` builds (lib/analysis.ts
/// `prepareDocument`; web/main.ts `rowSpans`): every constant, field and
/// condition, a point and its components, and the functions. A definition
/// that fails binds nothing, so its name stays unbound wherever it is written.
///
/// The definitions port does not read every row yet. A row it leaves alone
/// (a sequence, a `~` row, a state, a list, a data file, and whatever names
/// one) binds what `scanBoundNames` reads off its shape instead.
func boundNames(_ document: PreparedDocument) -> BoundNames {
  let built = document.built
  var names = BoundNames()
  names.values.formUnion(built.consts.keys)
  names.values.formUnion(built.fields.keys)
  names.values.formUnion(built.conditions.keys)
  // (A vector owns its aliases: its components are among the constants or the fields.)
  names.values.formUnion(built.points)
  names.values.formUnion(built.mats.keys)
  names.values.formUnion(built.tensors.keys)
  names.functions.formUnion(built.fns.keys)
  // The sequences of the rows the port reads (lib/defs.ts `defs.sequences`).
  for (k, scan) in document.seqScans.enumerated() where document.blocked[k] == nil {
    if let scan, !scan.lattice, !scan.emptyTuple { names.sequences.append(.init(name: scan.name, index: scan.index)) }
  }
  // A random variable whose declaration stands is a value (lib/env.ts `rvs`).
  names.values.formUnion(document.random.built.declarations.map(\.name))
  scanBoundNames(document.texts.map { Array($0.utf16) }, rows: Set(document.blocked.keys), into: &names)
  return names
}

/// The names `rows` of a document's rows bind, read off the rows' shapes
/// alone: what the row scanners that run ahead of buildDefs find
/// (`scanSequences`, `scanDefinition`, a `~` row's name), with a tuple's
/// components guessed from its text. `texts` is every row's math, without
/// its note: a sequence's letter and a fit's data are the document's.
///
/// It cannot know what buildDefs learns by resolving a definition, so for
/// these rows it differs from the site where
///
/// - a definition fails (a cycle, a fit with no data): the site leaves its
///   name unbound, this binds it;
/// - a value is a vector without being written as a tuple (`om' = solve(M,
///   f)`, a call returning a point): the site binds its components, this
///   does not.
private func scanBoundNames(_ texts: [[UInt16]], rows: Set<Int>, into names: inout BoundNames) {
  let live = texts.map { !$0.isEmpty && $0[0] != 0x23 && !isViewportText(String($0)) }
  // lib/seq.ts scanSequences: a letter can be a sequence once. Beside
  // `a_n = 1/n`, a row like `a_k = 7` that never uses its k is the constant a_k.
  let scans = scanSequences(texts.map { String(decoding: $0, as: UTF16.self) })
  // lib/regression.ts declaredNames: names some row defines, by text alone.
  var declared = Set<String>()
  for text in texts {
    var c = RowScanner(text)
    guard let name = c.nameRange() else { continue }
    c.space()
    var drawn = c
    if c.assign() || drawn.eat(0x2208) || (drawn.eat(0x5C) && drawn.eat(0x69) && drawn.eat(0x6E)) {
      declared.insert(canonicalName(c.text(name)))
    }
  }
  var models: [[UInt16]] = []
  var vectorStates: [String: Int] = [:]
  for (k, text) in texts.enumerated() where live[k] && rows.contains(k) {
    if let scan = scans[k] {
      // An automaton's rows, a table's and `s_0 = ()` bind no name of the document's.
      if !scan.lattice && !scan.emptyTuple { names.sequences.append(.init(name: scan.name, index: scan.index)) }
      continue
    }
    // A fit, `Y ~ m X + b`, is a definition of its coefficients, found once every other name is.
    if let model = regressionModel(text, declared) {
      models.append(model)
      continue
    }
    // A random variable's declaration, `X ~ Normal(0, 1)`, binds its name (lib/dist.ts).
    var c = RowScanner(text)
    if let name = c.nameRange() {
      c.space()
      let canonical = canonicalName(c.text(name))
      if c.eat(0x7E), nameable(canonical) {
        names.values.insert(canonical)
        continue
      }
    }
    guard let def = scanDefinition(String(text)) else { continue }
    // A tuple is a vector, and a vector owns its components: A_x, A_y for
    // a point, r_1, r_2 for a state (lib/geom.ts pointComps, vecStateComps).
    let dim = def.rhs.map { tupleLength(Array($0.utf16)) } ?? 0
    let vector = dim == 2 || dim == 3
    switch def {
    case .function(let name, _, _):
      names.functions.insert(name)
    case .state(let name, _):
      names.values.insert(name)
      if vector { names.values.formUnion((1...dim).map { "\(name)_\($0)" }) }
    case .constant(let name, _, let draw):
      names.values.insert(name)
      if vector && !draw { names.values.formUnion(pointComps(name, dim)) }
    case .table(let name):
      names.values.insert(name)
    case .initial(let name, _):
      // a(0) = … is the other half of the state a' = … binds; a tuple makes it a vector state.
      if vector { vectorStates[name] = dim }
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
      var c = RowScanner(model, k..<model.count)
      guard let word = c.nameRange() else {
        k += 1
        continue
      }
      k = c.i
      let name = canonicalName(c.text(word))
      c.space()
      let member = model[..<word.lowerBound].last == 0x2E || c.peek == 0x2E
      if !member, nameClass(name, names, called: c.peek == 0x28) == nil { coefficients.insert(name) }
    }
  }
  names.values.formUnion(coefficients)
  names.values.subtract(names.functions)
}

/// The model of a row that fits one, `Y ~ m X + b`: one `~` outside brackets
/// and quotes, data on the left (a declared name, or an expression in lists
/// or columns), and no distribution at the head of the right side, which
/// keeps `X ~ Normal(0, 1)` a declaration (lib/regression.ts `tildeRow`).
private func regressionModel(_ u: [UInt16], _ declared: Set<String>) -> [UInt16]? {
  // The one reading of a `~` row, which the analysis shares (Regression.swift).
  guard let row = tildeRow(u, declared), row.regression else { return nil }
  return row.rhs
}

/// How many items a right side has when the whole of it is one
/// parenthesized tuple, `(1, 2)` or `(cos(t), sin(t), 0)`; 0 when it is not.
private func tupleLength(_ u: [UInt16]) -> Int {
  let range = jsTrim(u[...]).indices
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
    case 0x27 where !(k > 0 && endsValue(u[k - 1])): quote = c
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
