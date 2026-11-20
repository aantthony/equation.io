/// Parse an expression or equation, keeping free variables symbolic
/// (lib/expr.ts `parseExpr`, with lib/lang's shunting-yard parser).
///
/// Names in `userFns` parse as function calls (`f(x+1)`) instead of
/// products; `listNames` index (`L[2]`) instead of multiplying; names in
/// `valueNames` that a late-addition builtin would claim stay variables, so
/// an older graph keeps the meaning it was shared with.
public func parseExpr(
  _ text: String,
  userFns: Set<String> = [],
  listNames: Set<String> = [],
  valueNames: Set<String> = []
) throws(ParseError) -> Expr {
  let context = ParseContext(userFns: userFns, listNames: listNames, valueNames: valueNames)
  return try context.parse(text)
}

struct ParseContext {
  var userFns: Set<String>
  var listNames: Set<String>
  var valueNames: Set<String>

  /// Whether this document defines the builtin `name` would fold to, so the name reads as a value.
  func shadowedFn(_ name: String) -> Bool {
    guard !valueNames.isEmpty, let b = builtinFn(name) else { return false }
    return shadowableFunctions.contains(b) && valueNames.contains(b)
  }

  func isFnName(_ name: String) -> Bool {
    userFns.contains(name) || (builtinFn(name) != nil && !shadowedFn(name))
  }

  /// User functions win (exact), then case-folded builtins.
  func canonicalFn(_ name: String) -> String {
    userFns.contains(name) ? name : (builtinFn(name) ?? name)
  }

  /// Whether `name[…]` indexes rather than multiplies: a list, a sequence's
  /// term (s_n[2]), or a column of a known table (person.age[2]).
  func indexes(_ name: String) -> Bool {
    if listNames.contains(name) { return true }
    let u = Array(name.utf16)
    if let sub = u.firstIndex(of: 0x5F), sub > 0, sub < u.count - 1,
      listNames.contains(String(decoding: u[...sub], as: UTF16.self))
    {
      return true
    }
    if let dot = u.firstIndex(of: 0x2E), dot > 0 {
      return listNames.contains(String(decoding: u[..<dot], as: UTF16.self))
    }
    return false
  }

  func parse(_ text: String) throws(ParseError) -> Expr {
    let tokens = addImplicitTokens(mergeEmptyBrackets(mergeBracedSubscripts(normalizeTokens(try tokenize(text)))))
    var stack: [PNode] = []
    try shunting(tokens) { (token: Token) throws(ParseError) in
      if token.type == .operator || token.type == .parenclose {
        guard let op = operatorTable[token.str] else { throw unknownOperator(token) }
        let args = Array(stack.suffix(op.n))
        stack.removeLast(args.count)
        if args.count < op.n { throw ParseError("Incomplete expression.", parse: true) }
        stack.append(try apply(op.kind, args))
      } else {
        stack.append(try leaf(token))
      }
    }
    guard stack.count == 1 else { throw ParseError("Incomplete expression.") }
    // A bare top-level comma series (no parens) still reads as a vector.
    if case .series(let items) = stack[0] { return try seriesToVec(items) }
    return try asExpr(stack[0])
  }

  private func leaf(_ token: Token) throws(ParseError) -> PNode {
    switch token.type {
    case .number:
      return .expr(.num(jsNumber(token.str)))
    case .string:
      let u = Array(token.str.utf16)
      if u.count < 2 || u.last != u.first { throw ParseError("Unterminated text: \(token.str)") }
      return .expr(.str(String(decoding: u[1..<(u.count - 1)], as: UTF16.self)))
    case .parenopen:
      return .popen(bracket: token.str, call: token.call)
    case .symbol:
      if token.str == emptyList { return .expr(.list([])) }
      if let value = constants[token.str] { return .expr(.num(value)) }
      return .expr(.var(token.str))
    default:
      throw ParseError("Invalid token: \(token.type) \"\(token.str)\"")
    }
  }

  // MARK: Operators

  private func apply(_ kind: OpKind, _ args: [PNode]) throws(ParseError) -> PNode {
    let a = args[0]
    let b = args.count > 1 ? args[1] : a
    switch kind {
    case .eof:
      return a
    case .close(let open):
      // Shunting yields "content, open marker" then the close token.
      guard case .popen(let bracket, let call) = b else { throw ParseError("Mismatched brackets.") }
      if bracket != open {
        throw ParseError("Mismatched brackets: \"\(bracket)\" closed by \"\(bracketClose[open]!)\".")
      }
      return try finish(open, a, call: call)
    case .equals:
      // Either side may be a tuple: (x', y') = (y, -sin(x)).
      if holdsConditions(a) || holdsConditions(b) { return .peq(a, b) }
      return .expr(.eq(try asVecOrExpr(a), try asVecOrExpr(b)))
    case .comma:
      func items(_ n: PNode) throws(ParseError) -> [PItem] {
        switch n {
        case .series(let items): items
        case .pcase(let cond, let value): [.pcase(cond, value)]
        default: [.expr(try asExpr(n))]
        }
      }
      return .series(try items(a) + items(b))
    case .colon:
      return .pcase(try asExpr(a), try asExpr(b))
    case .eqtest(let op):
      return .expr(.eqtest(op, try asVecOrExpr(a), try asVecOrExpr(b)))
    case .ineq(let op):
      return .expr(.ineq(op, try asVecOrExpr(a), try asVecOrExpr(b)))
    case .range:
      return .expr(.range(try asExpr(a), try asExpr(b)))
    case .bin(let op):
      return .expr(.bin(op, try asVecOrExpr(a), try asVecOrExpr(b)))
    case .product(let glyph):
      return .expr(.bin(.mul, try asVecOrExpr(a), try asVecOrExpr(b), glyph: glyph))
    case .neg:
      return .expr(.neg(try asVecOrExpr(a)))
    case .factorial:
      return .expr(.call("factorial", [try asExpr(a)]))
    case .apply:
      guard case .expr(.var(let written)) = a, isFnName(written) else {
        throw ParseError("Expected a function name.")
      }
      let name = canonicalFn(written)
      if name == "sum" || name == "prod" {
        if case .peq = b { return .expr(try sumCall(name, .expr(try asExpr(b)))) }
        return .expr(try sumCall(name, b))
      }
      if name == "int" { return .expr(try intCall(b)) }
      let callArgs: [Expr]
      if case .series(let items) = b {
        callArgs = try items.map { (item: PItem) throws(ParseError) in try asExpr(item.node) }
      } else {
        callArgs = [try asExpr(b)]
      }
      // log2 is spelled out, so every backend already knows it: ln(x)/ln(2).
      if name == "log2" && !userFns.contains(name) {
        if callArgs.count != 1 { throw ParseError("log2 takes one argument.") }
        return .expr(.bin(.div, .call("ln", [callArgs[0]]), .call("ln", [.num(2)])))
      }
      return .expr(.call(name, callArgs))
    case .at:
      return .expr(.index(try asExpr(a), try asVecOrExpr(b)))
    case .column:
      guard case .expr(.var(let table)) = a, case .expr(.var(let column)) = b else {
        throw ParseError("Write a column as table.column, like people.age.")
      }
      return .expr(.var("\(table).\(column)"))
    }
  }

  private func finish(_ open: String, _ content: PNode, call: Bool) throws(ParseError) -> PNode {
    switch open {
    case "{":
      return try bracePiecewise(content)
    case "(":
      // Call parens keep their series for [apply]; plain parens make a vector.
      if call { return content }
      if case .series(let items) = content { return .expr(try seriesToVec(items)) }
      if case .expr(.ineq(let op, let l, let r, _)) = content { return .expr(.ineq(op, l, r, grouped: true)) }
      return content
    default:  // "["
      // A comma series is a data list; a single item is that item: [n] is n.
      if case .series(let items) = content {
        return .expr(.list(try items.map { (item: PItem) throws(ParseError) in try asExpr(item.node) }))
      }
      // A lone range is a list too, but not in a call bracket (int[a..b]).
      if !call, case .expr(.range) = content, case .expr(let range) = content { return .expr(.list([range])) }
      return content
    }
  }

  /// Assemble {…} content into a piecewise if it contains `cond: value` parts.
  private func bracePiecewise(_ content: PNode) throws(ParseError) -> PNode {
    let items: [PNode]
    switch content {
    case .series, .peq: items = try eqItems(content).map(\.node)
    default: items = [content]
    }
    if case .peq = content, items.count == 1, !items[0].isPCase { return .expr(try asExpr(items[0])) }
    // A bare condition among several parts is `{cond, else}`: 1 where it holds.
    let bare = items.count > 1 && items.contains { $0.isComparison }
    if !items.contains(where: \.isPCase) && !bare {
      if case .series(let series) = content { return .expr(try seriesToVec(series)) }
      return content
    }
    var cases: [Expr.Case] = []
    var otherwise: Expr?
    for (k, n) in items.enumerated() {
      // So is a name or call before the last part: `{within, x > 0.5: x}`.
      let named = n.isNameOrCall && k < items.count - 1
      if (n.isComparison && items.count > 1) || named {
        if otherwise != nil { throw ParseError("The default value must come last in {…}.") }
        guard case .expr(let cond) = n else { preconditionFailure() }
        cases.append(Expr.Case(cond: cond, value: .num(1), bare: true))
        continue
      }
      if case .pcase(let cond, let value) = n {
        switch cond {
        case .ineq, .eq, .var, .call: break
        default: throw ParseError("Piecewise conditions must be inequalities, like x < 0.")
        }
        if otherwise != nil { throw ParseError("The default value must come last in {…}.") }
        cases.append(Expr.Case(cond: cond, value: value))
      } else {
        if k != items.count - 1 { throw ParseError("Each piecewise part needs a \"condition: value\".") }
        otherwise = try asExpr(n)
      }
    }
    return .expr(.piecewise(cases, otherwise: otherwise))
  }

  /// Shape a Σ/Π header: [index, lo, hi] for `sum[n=1..N] …`, and
  /// [index, lo, hi, body] for `sum(n=1..N, body)`, whose `n = (1..N, body)`
  /// arrives as an equation with a tuple right side.
  private func sumCall(_ name: String, _ b: PNode) throws(ParseError) -> Expr {
    let usage = ParseError("Expected \(name)(n=1..N, …).")
    guard case .expr(.eq(let idx, var range)) = b, case .var = idx else { throw usage }
    var body: Expr?
    if case .vec(let items) = range {
      if items.count != 2 { throw usage }
      range = items[0]
      body = items[1]
    }
    guard case .range(let lo, let hi) = range else { throw usage }
    return .call(name, [idx, lo, hi] + (body.map { [$0] } ?? []))
  }

  /// Shape an ∫: [lo, hi] for the header `int[a..b] …`, [body] for
  /// `int(f dx)`, and [lo, hi, body] for `int(a..b, f dx)`.
  private func intCall(_ b: PNode) throws(ParseError) -> Expr {
    let usage = ParseError("Expected int(f(x) dx) or int[a..b] f(x) dx.")
    if case .popen = b { throw usage }
    let items: [Expr]
    if case .series(let series) = b {
      items = try series.map { (item: PItem) throws(ParseError) in try asExpr(item.node) }
    } else {
      items = [try asExpr(b)]
    }
    let ranges = items.filter { if case .range = $0 { true } else { false } }
    let bodies = items.filter { if case .range = $0 { false } else { true } }
    if items.isEmpty || ranges.count > 1 || bodies.count > 1 { throw usage }
    var bounds: [Expr] = []
    if case .range(let lo, let hi) = ranges.first { bounds = [lo, hi] }
    guard let body = bodies.first else {
      if bounds.isEmpty { throw usage }
      return .call("int", bounds)  // header awaiting its body
    }
    return .call("int", bounds + [body])
  }
}

// MARK: - Parse nodes

/// What the operand stack holds while parsing: an expression, or one of the
/// pieces that only exist mid-parse.
private indirect enum PNode {
  case expr(Expr)
  /// A comma-joined argument list.
  case series([PItem])
  /// A `cond: value` piecewise part.
  case pcase(Expr, Expr)
  /// An open-bracket marker.
  case popen(bracket: String, call: Bool)
  /// `=` beside a comma series: braces re-split it into conditions.
  case peq(PNode, PNode)

  var isPCase: Bool { if case .pcase = self { true } else { false } }
  var isComparison: Bool {
    switch self {
    case .expr(.ineq), .expr(.eq): true
    default: false
    }
  }
  var isNameOrCall: Bool {
    switch self {
    case .expr(.var), .expr(.call): true
    default: false
    }
  }
}

private enum PItem {
  case expr(Expr)
  case pcase(Expr, Expr)

  var node: PNode {
    switch self {
    case .expr(let e): .expr(e)
    case .pcase(let c, let v): .pcase(c, v)
    }
  }
}

private func asExpr(_ n: PNode) throws(ParseError) -> Expr {
  switch n {
  case .expr(let e): return e
  case .series(let items):
    if items.count == 1 { return try asExpr(items[0].node) }
    throw ParseError("Unexpected argument list.")
  case .pcase: throw ParseError("A \"condition: value\" pair is only valid inside {…}.")
  // Outside braces, `a = b, c` keeps its old reading: b, c is a tuple.
  case .peq(let l, let r): return .eq(try asVecOrExpr(l), try asVecOrExpr(r))
  case .popen: throw ParseError("Incomplete expression.")
  }
}

private func holdsConditions(_ n: PNode) -> Bool {
  switch n {
  case .pcase, .peq, .series: true
  default: false
  }
}

/// The comma items of `a = b` in braces: `=` joins a's last item to b's first.
private func eqItems(_ n: PNode) throws(ParseError) -> [PItem] {
  switch n {
  case .series(let items): return items
  case .pcase(let c, let v): return [.pcase(c, v)]
  case .peq(let ln, let rn):
    let l = try eqItems(ln)
    let r = try eqItems(rn)
    guard let last = l.last, let first = r.first else { throw ParseError("Incomplete expression.") }
    guard case .expr(let left) = last else { throw ParseError("A piecewise value cannot be an equation.") }
    let joined: PItem =
      switch first {
      case .pcase(let cond, let value): .pcase(.eq(left, cond), value)
      case .expr(let right): .expr(.eq(left, right))
      }
    return l.dropLast() + [joined] + r.dropFirst()
  default: return [.expr(try asExpr(n))]
  }
}

/// Operators take tuples as operands: a parenthesized pair in arithmetic is a vector.
private func asVecOrExpr(_ n: PNode) throws(ParseError) -> Expr {
  if case .series(let items) = n, items.count == 2 || items.count == 3 { return try seriesToVec(items) }
  return try asExpr(n)
}

/// A comma series in plain brackets is a tuple.
private func seriesToVec(_ items: [PItem]) throws(ParseError) -> Expr {
  guard items.count >= 2 else { throw ParseError("Expected 2 or 3 vector components.") }
  return .vec(try items.map { (item: PItem) throws(ParseError) in try asExpr(item.node) })
}

// MARK: - Shunting yard

private let matchingClose: [String: String] = ["(": ")", "[": "]", "{": "}"]
private let bracketClose = matchingClose

private func unknownOperator(_ token: Token) -> ParseError {
  ParseError("Unknown operator: \(token.str) at \(token.loc.0 < 0 ? -1 : 1):\(token.loc.0).")
}

/// Reorder infix tokens to postfix, handing each to `output` as it is
/// ready, so parse errors surface in the same order as the TypeScript's
/// generators. A bracket left open at the end is closed there, so
/// half-typed input like `sin(x` still plots.
private func shunting(_ tokens: [Token], _ output: (Token) throws(ParseError) -> Void) throws(ParseError) {
  var stack: [Token] = []
  func lookup(_ token: Token) throws(ParseError) -> Operator {
    guard let op = operatorTable[token.str] else { throw unknownOperator(token) }
    return op
  }
  for token in tokens {
    switch token.type {
    case .parenopen:
      stack.append(token)
    case .parenclose:
      while true {
        guard let op = stack.popLast() else { throw ParseError("Could not find open brace.", parse: true) }
        try output(op)
        if op.type == .parenopen {
          try output(token)
          break
        }
      }
    case .operator:
      let o1 = try lookup(token)
      while let top = stack.last, top.type != .parenopen {
        let o2 = try lookup(top)
        if o1.prec > o2.prec { break }
        if o1.prec == o2.prec && o1.right { break }
        stack.removeLast()
        try output(top)
      }
      stack.append(token)
    default:
      try output(token)
    }
  }
  while let entry = stack.popLast() {
    try output(entry)
    if entry.type == .parenopen {
      try output(Token(type: .parenclose, str: matchingClose[entry.str] ?? ")", loc: (entry.loc.1, entry.loc.1)))
    }
  }
}

// MARK: - Operator table

enum OpKind {
  case eof, close(String), equals, comma, colon, eqtest(EqTestOp), ineq(IneqOp), range
  case bin(BinOp), product(ProductGlyph), neg, factorial, apply, at, column
}

struct Operator {
  var kind: OpKind
  var n: Int
  var right: Bool
  var prec: Int
}

/// Tightness runs from the top of the list (loosest) down. Spellings of
/// one operator, comparators, and the juxtapositions that rank with an
/// operator share its level (see the overrides below).
let operatorList: [(String, OpKind, n: Int, right: Bool)] = [
  ("EOF", .eof, 1, false),
  ("}", .close("{"), 2, false),
  (")", .close("("), 2, false),
  ("]", .close("["), 2, false),
  ("=", .equals, 2, false),
  (",", .comma, 2, false),
  (":", .colon, 2, false),
  ("==", .eqtest(.eq), 2, false),
  ("!=", .eqtest(.ne), 2, false),
  ("≠", .eqtest(.ne), 2, false),
  ("<", .ineq(.lt), 2, false),
  ("<=", .ineq(.le), 2, false),
  ("≤", .ineq(.le), 2, false),
  (">", .ineq(.gt), 2, false),
  (">=", .ineq(.ge), 2, false),
  ("≥", .ineq(.ge), 2, false),
  ("..", .range, 2, false),
  ("+", .bin(.add), 2, false),
  ("-", .bin(.sub), 2, false),
  ("−", .bin(.sub), 2, false),
  ("*", .bin(.mul), 2, false),
  ("×", .product(.cross), 2, false),
  ("·", .product(.dot), 2, false),
  ("⋅", .product(.dot), 2, false),
  ("⊗", .product(.outer), 2, false),
  ("⟑", .product(.geometric), 2, false),
  ("∧", .product(.wedge), 2, false),
  ("/", .bin(.div), 2, false),
  ("÷", .bin(.div), 2, false),
  // Juxtaposition across a space: `g/L sin(th)` is (g/L) sin(th).
  ("[spaced]", .bin(.mul), 2, false),
  ("[neg]", .neg, 1, true),
  // Juxtaposition written touching: `1/2pi` is 1/(2π).
  ("[impl]", .bin(.mul), 2, false),
  ("^", .bin(.pow), 2, true),
  // After '^' so 2^3! is 2^(3!); -x! is -(x!).
  ("!", .factorial, 1, false),
  // Tighter than '^', so sin(x)^2 is (sin(x))^2.
  ("[apply]", .apply, 2, false),
  ("[at]", .at, 2, false),
  (".", .column, 2, false),
]

let operatorTable: [String: Operator] = {
  var table: [String: Operator] = [:]
  for (prec, (key, kind, n, right)) in operatorList.enumerated() {
    table[key] = Operator(kind: kind, n: n, right: right, prec: prec)
  }
  func share(_ keys: [String], with key: String) {
    for k in keys { table[k]!.prec = table[key]!.prec }
  }
  // -x^2 is -(x^2) and x^-1 is x^(-1).
  share(["[neg]"], with: "^")
  // sort(L)[2] indexes the call.
  share(["[at]"], with: "[apply]")
  // `a/b c` is (a/b)·c and `a b/c` is (a·b)/c.
  share(["[spaced]"], with: "/")
  // Chains like 0 <= y < x associate left.
  share(["<=", "≤", ">", ">=", "≥"], with: "<")
  share(["−"], with: "-")
  share(["×", "·", "⋅", "⊗", "∧", "⟑"], with: "*")
  share(["÷"], with: "/")
  share(["≠"], with: "!=")
  return table
}()

let multiCharOps: [String] = operatorList.map(\.0).filter { $0.utf16.count > 1 }

// MARK: - Names

/// Functions available in expressions.
let functions: Set<String> = [
  "sin", "cos", "tan", "asin", "acos", "atan", "atan2", "sinh", "cosh", "tanh", "sech", "asinh", "acosh", "atanh",
  "sqrt", "abs", "exp", "ln", "log", "log2", "floor", "ceil", "round", "min", "max", "clamp", "mod", "sign", "fract",
  "erf", "normalpdf", "normalcdf", "gcd", "isprime", "gamma", "factorial", "sinc", "coth", "re", "im", "arg", "conj",
  "mean", "total", "count", "stdev", "median", "sort", "hist", "push", "pop", "top", "interval", "dot", "cross",
  "perp", "midpoint", "unit", "rotate", "distance", "angle", "segment", "polyline", "vector", "line", "polygon",
  "square", "circle", "hull", "det", "trace", "solve", "transpose", "outer", "wedge", "contract", "gp", "rev",
  "grade", "dual", "quat", "slerp", "vec", "meet", "join", "plane", "project", "reflect", "motor", "action",
  "streamlines", "qjulia", "sum", "prod", "int", "grad", "div", "curl", "laplacian", "jacobian", "hessian",
  "curvature", "torsion", "osculating", "frame", "gaussian", "meancurvature", "geodesic", "lightray", "lightcone",
  "tidal", "fourier", "reconstruct", "domain", "conformal", "iter", "rgb", "hsl", "oklch", "tube", "trail", "label",
  "revolve",
]

/// Builtins added after graphs existed in the wild, which a document's own
/// definition may claim.
let shadowableFunctions: Set<String> = [
  "gamma", "factorial", "sinc", "coth", "clamp", "mean", "total", "count", "stdev", "median", "sort", "hist", "grad",
  "div", "curl", "laplacian", "polyline", "vector", "distance", "angle", "revolve", "label", "rgb", "hsl", "oklch",
  "outer", "wedge", "contract", "interval", "gp", "rev", "grade", "dual", "quat", "slerp", "action", "streamlines",
  "jacobian", "hessian", "qjulia", "vec", "transpose", "curvature", "torsion", "osculating", "frame", "gaussian",
  "meancurvature", "geodesic", "lightray", "lightcone", "tidal", "log2", "fourier", "reconstruct", "meet", "join",
  "plane", "project", "reflect", "motor", "push", "pop", "top",
]

let constants: [String: Double] = ["pi": Double.pi, "e": 2.718281828459045]

/// JavaScript's Number() over a number token: `1.` is 1, and the `0.5.` a
/// half-typed `[.5..2]` leaves is NaN.
func jsNumber(_ digits: String) -> Double {
  let body = digits.hasSuffix(".") ? digits.dropLast() : Substring(digits)
  if digits.hasSuffix("."), body.contains(".") { return .nan }
  return Double(body) ?? .nan
}

/// A builtin's name, folding case so `Sin` and `SIN` reach `sin`.
public func builtinFn(_ name: String) -> String? {
  if functions.contains(name) { return name }
  let lower = name.lowercased()
  return functions.contains(lower) ? lower : nil
}
