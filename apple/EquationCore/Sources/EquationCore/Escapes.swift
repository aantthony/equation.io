/// LaTeX-style input escapes (lib/escapes.ts): in the editor, typing `\pi`
/// becomes π.
///
/// Pure logic: the editor applies the edit on each keystroke. A typed escape
/// commits in one of two ways:
///
///  - The letter completing a name no other command extends converts at once:
///    `\pi` is π the moment the i lands (no command continues "pi").
///  - A name some longer command extends (`\sin` could still become \sinh)
///    converts when a non-letter lands after it: `\sin(` → `sin(`.
///
/// `\\` collapses to a literal backslash, and inside quoted text ("C:\data")
/// a backslash is always literal — no escape fires there.
public struct Escape: Equatable, Sendable {
  /// What is typed after the backslash.
  public var name: String
  /// What it becomes — a symbol, or the plain function name for the LaTeX
  /// spellings of built-ins, where the backslash simply drops.
  public var text: String
  public var description: String
}

/// In display order: a bare `\` suggests the head of this list.
private let symbolEscapes: [Escape] = {
  let greek = "Greek letter"
  let rows: [(String, String, String)] = [
    ("pi", "π", "The constant π"), ("theta", "θ", greek), ("tau", "τ", greek),
    ("nabla", "∇", "Nabla: ∇f, ∇·F, ∇×F, ∇²f"), ("infty", "∞", "Infinity"), ("inf", "∞", "Infinity"),
    ("sum", "Σ", "Sum: Σ(n=1..N, …)"), ("prod", "Π", "Product: Π(n=1..N, …)"),
    ("int", "∫", "Integral: ∫[a..b] f(x) dx"), ("in", "∈", "Draw from a list, on a row of its own: p ∈ A"),
    ("times", "×", "Cross product (or multiplication)"), ("cdot", "·", "Dot product (or multiplication)"),
    ("otimes", "⊗", "Outer (tensor) product: a ⊗ b"),
    ("wedge", "∧", "Wedge product: a ∧ b = a ⊗ b − b ⊗ a"),
    ("gp", "⟑", "Geometric product: e_x ⟑ e_y = e_xy"), ("div", "÷", "Division"),
    ("le", "≤", "Less than or equal"), ("leq", "≤", "Less than or equal"),
    ("ge", "≥", "Greater than or equal"), ("geq", "≥", "Greater than or equal"),
    ("ne", "≠", "Not equal (list filters)"), ("neq", "≠", "Not equal (list filters)"),
    ("alpha", "α", greek), ("beta", "β", greek), ("gamma", "γ", greek), ("delta", "δ", greek),
    ("epsilon", "ε", greek), ("varepsilon", "ε", greek), ("zeta", "ζ", greek), ("eta", "η", greek),
    ("vartheta", "ϑ", greek), ("iota", "ι", greek), ("kappa", "κ", greek), ("lambda", "λ", greek),
    ("mu", "μ", greek), ("nu", "ν", greek), ("xi", "ξ", greek), ("omicron", "ο", greek), ("rho", "ρ", greek),
    ("sigma", "σ", greek), ("upsilon", "υ", greek), ("phi", "φ", greek), ("varphi", "φ", greek),
    ("chi", "χ", greek), ("psi", "ψ", greek), ("omega", "ω", greek), ("Gamma", "Γ", greek),
    ("Delta", "Δ", greek), ("Theta", "Θ", greek), ("Lambda", "Λ", greek), ("Xi", "Ξ", greek),
    ("Pi", "Π", "Product (same as prod)"), ("Sigma", "Σ", "Sum (same as sum)"), ("Upsilon", "Υ", greek),
    ("Phi", "Φ", greek), ("Psi", "Ψ", greek), ("Omega", "Ω", greek), ("arcsin", "asin", "Function name"),
    ("arccos", "acos", "Function name"), ("arctan", "atan", "Function name"),
  ]
  return rows.map { Escape(name: $0.0, text: $0.1, description: $0.2) }
}()

/// Every built-in function name is also an escape that simply writes itself:
/// \trail → trail. A curated spelling above wins — \sum stays Σ (which is
/// sum) and \gamma stays the letter γ, LaTeX-style; the gamma function is
/// reached by typing its name plainly.
private let functionEscapes: [Escape] = jsSorted(
  (Array(functions) + ["view", "open"]).filter { name in !symbolEscapes.contains { $0.name == name } }
).map { Escape(name: $0, text: $0, description: "Function name") }

public let escapes: [Escape] = symbolEscapes + functionEscapes

private let escapesByName: [String: Escape] = {
  var out: [String: Escape] = [:]
  for e in escapes { out[e.name] = e }
  return out
}()

/// Names some longer command extends (\inf → \infty, \sin → \sinh): typing
/// their last letter cannot commit them; a delimiter or the suggestions can.
private let prefixOfLonger: Set<String> = Set(
  escapes.filter { a in escapes.contains { $0.name != a.name && $0.name.hasPrefix(a.name) } }.map(\.name))

public struct EscapeEdit: Equatable, Sendable {
  /// Replace text[start..<end) (UTF-16 offsets) …
  public var start: Int
  public var end: Int
  /// … with this …
  public var text: String
  /// … and put the caret here.
  public var caret: Int
}

/// Whether index `at` sits inside quoted text, where a backslash is literal.
/// A `'` only opens text where no value just ended (see splitStatements).
private func inQuote(_ u: Units, _ at: Int) -> Bool {
  var quote: UInt16?
  for i in 0..<max(0, min(at, u.count)) {
    let c = u[i]
    if let open = quote {
      if c == open { quote = nil }
    } else if c == unit("\"") || (c == unit("'") && !(i > 0 && endsValue(u[i - 1]))) {
      quote = c
    }
  }
  return quote != nil
}

/// The `\name` ending at `end`, unless it is escaped or inside quotes.
private func escapeBefore(_ u: Units, _ end: Int) -> (start: Int, escape: Escape)? {
  guard end <= u.count else { return nil }
  var k = end
  while k > 0, isASCIILetter(u[k - 1]) { k -= 1 }
  guard k < end, k > 0, u[k - 1] == unit("\\") else { return nil }
  let start = k - 1
  if (start > 0 && u[start - 1] == unit("\\")) || inQuote(u, start) { return nil }
  guard let escape = escapesByName[String(u[k..<end])] else { return nil }
  return (start, escape)
}

/// The rewrite (if any) that the character just typed at text[offset - 1]
/// finishes: `\pi` → π on its last letter, `\sin` → sin on a delimiter,
/// `\\` → `\`. Bounds are UTF-16 offsets in `text`; `caret` is where the
/// caret lands (lib/escapes.ts `typedEscape`).
public func typedEscape(_ text: String, offset: Int, inserted: String) -> EscapeEdit? {
  let u = Array(text.utf16)
  let typed = Array(inserted.utf16)
  guard typed.count == 1, offset >= 1, offset <= u.count, u[offset - 1] == typed[0] else { return nil }
  if typed[0] == unit("\\") {
    guard offset >= 2, u[offset - 2] == unit("\\"), !inQuote(u, offset - 2) else { return nil }
    return EscapeEdit(start: offset - 2, end: offset, text: "\\", caret: offset - 1)
  }
  if isASCIILetter(typed[0]) {
    guard let hit = escapeBefore(u, offset), !prefixOfLonger.contains(hit.escape.name) else { return nil }
    return EscapeEdit(
      start: hit.start, end: offset, text: hit.escape.text, caret: hit.start + hit.escape.text.utf16.count)
  }
  guard let hit = escapeBefore(u, offset - 1) else { return nil }
  return EscapeEdit(
    start: hit.start, end: offset - 1, text: hit.escape.text, caret: hit.start + hit.escape.text.utf16.count + 1)
}
