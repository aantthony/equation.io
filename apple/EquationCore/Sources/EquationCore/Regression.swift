/// Which `~` rows fit a model to data (lib/regression.ts): observed-list ~
/// model-list, where unbound scalar names are the fit's coefficients.
///
/// Port: only the reading of the row is here — whether a `~` row is a fit or
/// a random variable's declaration, which the two must agree on. The fit
/// itself (`fitRegression`, `formatFit`) runs over lists, which the
/// definitions port does not read yet: a regression row is reported as not
/// supported, and so is every row that names one of its coefficients.

/// How a row with a `~` reads (lib/regression.ts `tildeRow`).
struct TildeRow {
  var lhs: Units
  var rhs: Units
  /// The offset of the `~`.
  var tilde: Int
  /// False: the row is left to the distribution path.
  var regression: Bool
}

/// Names some row of the document defines (`name = …`, `name ∈ …`), by text
/// alone: a definition that fails to parse still makes `name ~ …` a fit, not
/// a law (`declaredNames`): `^\s*(NAME)\s*(?:=(?!=)|∈|\\in\b)`.
func declaredNames(_ texts: [Units]) -> Set<String> {
  var declared = Set<String>()
  for text in texts {
    var c = RowScanner(text)
    c.space()
    guard let name = c.nameRange() else { continue }
    c.space()
    var drawn = c
    var binder = drawn.eat(0x2208)
    if !binder, drawn.eat(word: "\\in") {
      // \b: not followed by a word character.
      binder = !(drawn.peek.map { isASCIILetter($0) || isDigit($0) || $0 == 0x5F } ?? false)
    }
    if c.assign() || binder { declared.insert(canonicalName(c.text(name))) }
  }
  return declared
}

/// How a row with a `~` reads — the one predicate, so the highlighter and
/// the analysis cannot disagree. Nil without exactly one `~` at depth 0
/// outside quotes (or in a comment).
///
/// A distribution name (DistFamilies.swift) at the head of the right side
/// keeps its meaning, and its collision diagnostics, whatever is on the
/// left. The exceptions are the spellings that are also a function or an
/// everyday coefficient name — exp, gamma, beta, t: over declared data they
/// are models in every form (`Y ~ gamma(a X)`, `Y ~ gamma`, mid-typing
/// `Y ~ gamma x`). The one carve-out: a bare `exp` is the Exponential alias.
func tildeRow(_ u: Units, _ declared: Set<String>) -> TildeRow? {
  if jsTrimStart(u[...]).first == 0x23 { return nil }
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
    case 0x27 where !(k > 0 && endsValue(u[k - 1])): quote = c
    case 0x28, 0x5B, 0x7B: depth += 1
    case 0x29, 0x5D, 0x7D: depth -= 1
    case 0x7E where depth == 0:
      if tilde >= 0 { return nil }
      tilde = k
    default: break
    }
  }
  guard tilde >= 0 else { return nil }
  let lhs = Array(jsTrim(u[..<tilde]))
  let rhs = Array(jsTrim(u[(tilde + 1)...]))
  // `^(NAME)\s*(?:\(|$)`: the first name of the right side, possibly a distribution's.
  var law = false
  var head = RowScanner(rhs)
  if let name = head.nameRange() {
    let spelled = head.text(name)
    head.space()
    if head.atEnd || head.peek == 0x28 { law = distFamily(spelled) != nil && !isModelName(spelled) }
  }
  let bareExp = String(decoding: rhs, as: UTF16.self).lowercased() == "exp"
  let data = declared.contains(canonicalName(String(decoding: lhs, as: UTF16.self)))
  // /[.[\](+*/-]/
  let expression = lhs.contains { [0x2E, 0x5B, 0x5D, 0x28, 0x2B, 0x2A, 0x2F, 0x2D].contains($0) }
  return TildeRow(lhs: lhs, rhs: rhs, tilde: tilde, regression: !law && !bareExp && (data || expression))
}

/// The rows that fit a model (`scanRegressions`). A declared data name on
/// the left disambiguates regression from a random variable declaration;
/// explicit lists or columns also unambiguously mean data.
func scanRegressions(_ texts: [String]) -> [Int: TildeRow] {
  let units = texts.map { Array($0.utf16) }
  let declared = declaredNames(units)
  var out: [Int: TildeRow] = [:]
  for (i, text) in units.enumerated() {
    if let row = tildeRow(text, declared), row.regression { out[i] = row }
  }
  return out
}
