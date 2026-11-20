/// From a parsed row to scalar expressions the backends read: user functions
/// inlined, d/dx expanded, named conditions and points written in
/// (lib/defs.ts `resolveExpr`/`rx`, lib/geom.ts `lowerGeom`).
///
/// The port covers the scalar core. Everything it has not reached — sums and
/// integrals, lists, matrices, complex numbers, geometry statements, … —
/// throws `Unsupported`, and the row says it is not supported yet rather
/// than drawing something the site would not.

/// A part of the language the Swift port has not reached. Never a row's
/// error: the row is reported as not supported yet.
struct Unsupported: Error, Equatable {
  /// What was met, as a noun phrase: "lists", "sum(…)".
  var what: String

  init(_ what: String) { self.what = what }
}

/// A user function: its parameters and its resolved body.
struct FnDef: Equatable {
  var params: [String]
  var body: Expr
}

/// Looks a user function up, resolving it first if need be; nil for a name
/// that is not one. Throws when its definition is in error.
typealias GetFn = (String) throws -> FnDef?

/// What resolution reads of the document (lib/defs.ts `ResolveOpts`), for
/// the parts ported.
struct ResolveOpts {
  /// Definition values cannot contain row-only forms.
  var inDefinition = false
  /// A piecewise case may test equality (a row not drawn over the plane).
  var exactConditions = false
  /// The value of a name defined as a number, field or condition, so
  /// derivatives can differentiate through it.
  var definition: (String) -> Expr? = { _ in nil }
  /// The component names a named point lowers to (A → A_x, A_y).
  var comps: (String) -> [String]? = { _ in nil }
  /// Every name the document binds: the unit vectors e_x, e_y, e_z are in
  /// scope only when this is given and does not hold them.
  var documentNames: Set<String>?
  /// A function's parameters, while its body resolves.
  var params: Set<String>?
}

/// The elementary functions the port evaluates and compiles: a call to any
/// other builtin is not supported yet.
let elementaryFunctions: Set<String> = [
  "sin", "cos", "tan", "asin", "acos", "atan", "atan2", "sinh", "cosh", "tanh", "sech", "asinh", "acosh", "atanh",
  "sqrt", "abs", "exp", "ln", "log", "floor", "ceil", "round", "sign", "min", "max", "mod", "fract", "erf",
  "normalpdf", "normalcdf", "gcd", "isprime", "gamma", "factorial", "sinc", "coth",
]

/// Calls whose arguments stay grouped (lib/expr.ts `legacyCallArgs`); of the
/// elementary set only exp is one (e^M of a matrix).
private let groupedCalls: Set<String> = ["exp"]

/// Historical tuple-call spelling: a tuple written as an argument spreads
/// into arguments, f((a, b)) ≡ f(a, b).
private func legacyCallArgs(_ name: String, _ args: [Expr]) -> [Expr] {
  if groupedCalls.contains(name) { return args }
  return args.flatMap { (x: Expr) -> [Expr] in
    if case .vec(let items) = x { return items }
    return [x]
  }
}

private let spaceVars: Set<String> = ["x", "y", "z"]
private let coordNames = ["x", "y", "z"]

struct Resolver {
  var getFn: GetFn
  var opts: ResolveOpts

  // MARK: Derivatives (lib/defs.ts dOrder … matchDeriv)

  /// A differential's name: d and one letter, Latin or Greek (dx, dθ).
  private func dVarName(_ n: Expr) -> String? {
    guard case .var(let name) = n else { return nil }
    let u = Array(name.utf16)
    guard u.count == 2, u[0] == unit("d"), isASCIILetter(u[1]) || greekNameChars.contains(u[1]) else { return nil }
    return String(u[1...])
  }

  private func smallOrder(_ n: Expr) -> Int? {
    guard case .num(let value) = n, JS.isInteger(value), value >= 1, value <= 6 else { return nil }
    return Int(value)
  }

  /// Match `d` or `d^k` (the numerator of a Leibniz derivative).
  private func dOrder(_ n: Expr) -> Int? {
    if case .var("d") = n { return 1 }
    if case .bin(.pow, .var("d"), let k, _) = n { return smallOrder(k) }
    return nil
  }

  /// Match `dx` or `dx^k`, yielding the variable and order.
  private func dxOrder(_ n: Expr) -> (v: String, order: Int)? {
    if let v = dVarName(n) { return (v, 1) }
    if case .bin(.pow, let a, let k, _) = n, let v = dVarName(a), let order = smallOrder(k) { return (v, order) }
    return nil
  }

  /// Numerator forms: d(^k), -d(^k), C·d(^k).
  private func numeratorWrap(_ n: Expr) -> (order: Int, wrap: (Expr) -> Expr)? {
    if let order = dOrder(n) { return (order, { $0 }) }
    if case .neg(let a) = n, let order = dOrder(a) { return (order, Sym.neg) }
    if case .bin(.mul, let c, let b, _) = n, let order = dOrder(b) { return (order, { Sym.mul(c, $0) }) }
    return nil
  }

  /// `e` with the named definitions it reaches that depend on position
  /// written out, so differentiation sees through them (`throughFields`).
  private func throughFields(_ e: Expr) -> Expr {
    func closed(_ name: String, _ seen: Set<String>) -> Expr? {
      if spaceVars.contains(name) || seen.contains(name) { return nil }
      guard let value = opts.definition(name) else { return nil }
      if case .vec = value { return nil }
      if case .list = value { return nil }
      let inner = seen.union([name])
      var sub: [String: Expr] = [:]
      for v in freeVarNames(value) {
        if let c = closed(v, inner) { sub[v] = c }
      }
      let out = sub.isEmpty ? value : substVars(value, sub)
      return freeVarNames(out).contains(where: spaceVars.contains) ? out : nil
    }
    var sub: [String: Expr] = [:]
    for v in freeVarNames(e) {
      if let c = closed(v, []) { sub[v] = c }
    }
    return sub.isEmpty ? e : substVars(e, sub)
  }

  /// Step for the central-difference fallback.
  private static let fdH = 1e-4

  private func applyDiff(_ operand: Expr, _ v: String, _ order: Int) throws -> Expr {
    var e = throughFields(operand)
    // A component that does not exist — F_1 of a function F, G_1 of a point
    // whose components are G_x, G_y — would differentiate to 0.
    for name in freeVarNames(e) {
      let u = Array(name.utf16)
      // /^(.+)_[^_]+$/: the base before the last underscore.
      guard let cut = u.lastIndex(of: unit("_")), cut > 0, cut < u.count - 1 else { continue }
      let base = String(u[..<cut])
      if opts.definition(name) != nil { continue }
      let comps = opts.comps(base)
      if let comps, !comps.contains(name) {
        throw LanguageError(
          "\(name) is not defined — \(base)'s components are \(comps.joined(separator: ", ")).")
      }
      if comps == nil, try getFn(base) != nil {
        throw LanguageError(
          "\(name) is not defined — \(base) is a function. Name its value first, like G = \(base)(x, y, z), then use G_x, G_y, G_z."
        )
      }
    }
    for _ in 0..<order {
      do {
        e = try Sym.diff(e, v)
      } catch is Sym.NonSmoothError {
        // factorial, gamma, floor, …: expand a symbolic central difference.
        let vv = Expr.var(v)
        let h = Expr.num(Resolver.fdH)
        e = Sym.div(
          Sym.sub(substVars(e, [v: Sym.add(vv, h)]), substVars(e, [v: Sym.sub(vv, h)])), .num(2 * Resolver.fdH))
      }
    }
    return e
  }

  /// Rewrite a division that spells a Leibniz derivative: `d/dx expr` parses
  /// as d / (dx · expr), the operand being the tail of the denominator's
  /// product chain.
  private func matchDeriv(_ numr: Expr, _ den: Expr) throws -> Expr? {
    guard let head = numeratorWrap(numr) else { return nil }
    var factors: [Expr] = []
    var leftmost = den
    while case .bin(.mul, let a, let b, _) = leftmost {
      factors.insert(b, at: 0)
      leftmost = a
    }
    guard let dx = dxOrder(leftmost), dx.order == head.order, !factors.isEmpty else { return nil }
    var operand = factors[0]
    for factor in factors.dropFirst() { operand = .bin(.mul, operand, factor) }
    return head.wrap(try applyDiff(operand, dx.v, head.order))
  }

  // MARK: Names

  /// `P.x` of one named point is its coordinate P_x (`pointCoord`).
  private func pointCoord(_ name: String) -> Expr? {
    let u = Array(name.utf16)
    guard let dot = u.lastIndex(of: unit(".")), dot > 0,
      let k = coordNames.firstIndex(of: String(u[(dot + 1)...]))
    else { return nil }
    let base = String(u[..<dot])
    if opts.params?.contains(base) == true { return nil }
    guard let comps = opts.comps(base), k < comps.count else { return nil }
    return .var(comps[k])
  }

  /// The document's condition of a name, unless a parameter shadows it.
  func namedCondition(_ name: String) -> Expr? {
    if opts.params?.contains(name) == true { return nil }
    if let value = opts.definition(name), case .ineq = value { return value }
    return nil
  }

  /// A piecewise condition written as a name (`{within: 1}`) or a call: the
  /// inequality it stands for, written in here.
  private func writtenCondition(_ raw: Expr, _ resolved: Expr) throws -> Expr {
    switch raw {
    case .var, .call: break
    default: return resolved
    }
    if opts.params != nil { return resolved }
    switch resolved {
    case .ineq, .eq: return resolved
    case .var(let name):
      if let value = namedCondition(name) { return value }
    default: break
    }
    // In a definition it may be named below: written in once every
    // definition has resolved, or reported there.
    if opts.inDefinition { return resolved }
    throw notACondition(raw)
  }

  // MARK: rx

  func resolve(_ e: Expr) throws -> Expr {
    switch e {
    case .num:
      return e
    case .var(let name):
      // What the port cannot write in yet, by the names that ask for it.
      if name == "int" || name == "sum" || name == "prod" { throw Unsupported("sums and integrals") }
      if name == "grad" || name == "div" || name == "curl" || name == "laplacian" {
        throw Unsupported("vector calculus")
      }
      if isUnitVector(name), let names = opts.documentNames, !names.contains(name) {
        throw Unsupported("unit vectors")
      }
      return pointCoord(name) ?? e
    case .neg(let a):
      return .neg(try resolve(a))
    case .bin(let op, let lhs, let rhs, let glyph):
      let a = try resolve(lhs)
      let b = try resolve(rhs)
      if op == .div, let d = try matchDeriv(a, b) { return d }
      if glyph != nil { return .bin(op, a, b, glyph: glyph) }
      if op == .mul, case .bin(.div, let top, let bottom, _) = a {
        // The parenthesized form (d/dx)(expr): the quotient is bare.
        if let head = numeratorWrap(top), let dx = dxOrder(bottom), head.order == dx.order {
          return head.wrap(try applyDiff(b, dx.v, head.order))
        }
      }
      return .bin(op, a, b)
    case .index:
      throw Unsupported("indexing")
    case .range:
      throw LanguageError(structuralDiagnostic(e))
    case .eqtest:
      throw Unsupported("== and != filters")
    case .call(let name, let rawArgs):
      return try resolveCall(name, rawArgs)
    case .eq(let l, let r):
      return .eq(try resolve(l), try resolve(r))
    case .ineq(let op, let l, let r, let grouped):
      return .ineq(op, try resolve(l), try resolve(r), grouped: grouped)
    case .vec(let items):
      return .vec(try items.map(resolve))
    case .list:
      throw Unsupported("lists")
    case .str:
      throw Unsupported("text")
    case .piecewise(let cases, let otherwise):
      for c in cases {
        guard case .eq = c.cond else { continue }
        // A case testing equality is a lattice row's, or a function body's
        // for the lattice rows that call it.
        if opts.inDefinition { throw Unsupported("a case testing equality in a definition") }
        if !opts.exactConditions {
          throw LanguageError(
            "A condition like y = x^2 is a filter for a reduction, like count({y = x^2, 0 < x < 1}); piecewise conditions are inequalities."
          )
        }
      }
      return .piecewise(
        try cases.map {
          Expr.Case(
            cond: try writtenCondition($0.cond, try resolve($0.cond)), value: try resolve($0.value), bare: $0.bare)
        },
        otherwise: try otherwise.map(resolve))
    }
  }

  /// e_x, e_y, e_z, and the blades e_xy, e_zx, e_xyz.
  private func isUnitVector(_ name: String) -> Bool {
    let u = Array(name.utf16)
    guard u.count >= 3, u.count <= 5, u[0] == unit("e"), u[1] == unit("_") else { return false }
    let axes = u[2...]
    return axes.allSatisfy { $0 >= unit("x") && $0 <= unit("z") } && Set(axes).count == axes.count
  }

  private func resolveCall(_ name: String, _ rawArgs: [Expr]) throws -> Expr {
    if name == "sum" || name == "prod" || name == "int" { throw Unsupported("sums and integrals") }
    // A reduction of one argument is over a list, or an integral against a measure.
    if rawArgs.count == 1, ["count", "total", "mean", "min", "max", "stdev", "median", "hist"].contains(name) {
      throw Unsupported("\(name)(…) over a list or a set")
    }
    if let fn = try getFn(name) {
      let n = fn.params.count
      // A function's arguments are as written when they fill its parameters:
      // only a mismatch spreads tuples, f((a, b)) ≡ f(a, b).
      let args = try (rawArgs.count == n ? rawArgs : legacyCallArgs("", rawArgs)).map(resolve)
      var env: [String: Expr] = [:]
      if args.count == 1, n >= 2, !isNum(args[0]) {
        // f(P) ≡ f(P_1, …, P_n): one argument that is an n-component point.
        guard case .vec(let items) = args[0] else { throw Unsupported("a point passed to a function") }
        if items.count != n {
          throw LanguageError("\(name) takes \(n) arguments, and that point has \(items.count) components.")
        }
        for (p, item) in zip(fn.params, items) { env[p] = item }
        return substVars(fn.body, env)
      }
      if args.count != n { throw LanguageError("\(name) takes \(n) argument\(n == 1 ? "" : "s").") }
      for (p, arg) in zip(fn.params, args) { env[p] = arg }
      // The coordinates of point parameters the body reads, `p.x`, as the
      // argument's own (`coordParams`).
      let used = freeVarNames(fn.body)
      for (p, arg) in zip(fn.params, args) {
        for (k, c) in coordNames.enumerated() where used.contains("\(p).\(c)") {
          if case .var(let argName) = arg, let own = pointCoord("\(argName).\(c)") {
            env["\(p).\(c)"] = own
          } else if case .vec(let items) = arg {
            if k >= items.count {
              throw LanguageError(
                "\(name) reads a coordinate that point does not have: it has \(items.count).")
            }
            env["\(p).\(c)"] = items[k]
          } else {
            throw Unsupported("a coordinate of a computed point")
          }
        }
      }
      let inlined = substVars(fn.body, env)
      // The body's named conditions, now that its parameters are its
      // arguments and cannot capture their variables.
      return opts.params != nil ? inlined : writeConditions(inlined, namedCondition)
    }
    let args = try legacyCallArgs(name, rawArgs).map(resolve)
    if name == "clamp" {
      // clamp(x, lo, hi) ≡ min(max(x, lo), hi): every backend already runs those.
      if args.count != 3 { throw LanguageError("clamp takes three arguments: clamp(x, lo, hi).") }
      return .call("min", [.call("max", [args[0], args[1]]), args[2]])
    }
    guard elementaryFunctions.contains(name) else { throw Unsupported("\(name)(…)") }
    return .call(name, args)
  }

  private func isNum(_ e: Expr) -> Bool {
    if case .num = e { return true }
    return false
  }
}

/// Named conditions written in where a condition is read — a piecewise
/// case's condition, or the whole expression — and nowhere else: one read as
/// a number keeps its name, for the error that says so (`writeConditions`).
func writeConditions(_ e: Expr, _ condition: (String) -> Expr?, whole: Bool = true) -> Expr {
  if case .var(let name) = e { return (whole ? condition(name) : nil) ?? e }
  guard case .piecewise(let cases, let otherwise) = e else {
    return mapChildren(e) { writeConditions($0, condition, whole: false) }
  }
  return .piecewise(
    cases.map {
      Expr.Case(
        cond: writeConditions($0.cond, condition, whole: true),
        value: writeConditions($0.value, condition, whole: false), bare: $0.bare)
    },
    otherwise: otherwise.map { writeConditions($0, condition, whole: false) })
}

/// What a condition's name says when it is read as a number.
func conditionAsNumber(_ name: String) -> String {
  "\(name) is a condition, not a number — read it in braces, like {\(name): 1}."
}

// MARK: - Equality cases (lib/expr.ts exactCase, lib/automaton.ts exactCases)

/// Rounding one equation allows: a few units in the last place of the larger
/// side's size (at least 1).
private let eqUlps = 8 * Double.ulpOfOne

/// A piecewise case testing equality as an inequality every backend runs:
/// r - ε < l < r + ε with ε the rounding allowed, scaled by r.
func exactCase(_ l: Expr, _ r: Expr) -> Expr {
  let eps: Expr
  if case .num(let value) = r {
    eps = .num(eqUlps * JS.max([1, abs(value)]))
  } else {
    eps = .bin(.mul, .num(eqUlps), .call("max", [.num(1), .call("abs", [r])]))
  }
  return .ineq(.lt, .ineq(.lt, .bin(.sub, r, eps), l), .bin(.add, r, eps))
}

/// Every equality case below `e` as exactCase.
func exactCases(_ e: Expr) -> Expr {
  let inner = mapChildren(e, exactCases)
  guard case .piecewise(let cases, let otherwise) = inner else { return inner }
  return .piecewise(
    cases.map { c in
      if case .eq(let l, let r) = c.cond { return Expr.Case(cond: exactCase(l, r), value: c.value, bare: c.bare) }
      return c
    }, otherwise: otherwise)
}

// MARK: - Point lowering (lib/geom.ts lowerGeom, for the parts ported)

/// A value under lowering: a number, or a point's components.
private enum Lowered {
  case scalar(Expr)
  case vec([Expr])

  var expr: Expr {
    switch self {
    case .scalar(let e): e
    case .vec(let items): .vec(items)
    }
  }
}

/// Why a name on the left of `name = (a point)` cannot name it.
private let takenNames: [String: String] = [
  "u": "a built-in parameter running over [0, 1]",
  "v": "a built-in parameter running over [0, 1], like u",
  "t": "time",
  "w": "the complex variable x + iy",
  "i": "the imaginary unit",
  "e": "Euler's number",
]

/// Expand point arithmetic: a point name A becomes (A_x, A_y), and sums,
/// scalings and negations of points are taken component by component.
func lowerGeom(_ e: Expr, comps: (String) -> [String]?) throws -> Expr {
  try lowerPoints(e, comps).expr
}

/// A row's (or a definition's) value once points and lists have lowered
/// (lib/object-lists.ts `lowerObjects`). The port has no lists, so what is
/// left of list lowering is what it does to every expression: it rebuilds
/// each node, and a product comes out without the glyph it was written with,
/// a piecewise without its conditions marked bare.
func lowerObjects(_ e: Expr, comps: (String) -> [String]?) throws -> Expr {
  plainNodes(try lowerGeom(e, comps: comps))
}

private func plainNodes(_ e: Expr) -> Expr {
  switch e {
  case .bin(let op, let a, let b, _):
    return .bin(op, plainNodes(a), plainNodes(b))
  case .piecewise(let cases, let otherwise):
    return .piecewise(
      cases.map { Expr.Case(cond: plainNodes($0.cond), value: plainNodes($0.value)) },
      otherwise: otherwise.map(plainNodes))
  default:
    return mapChildren(e, plainNodes)
  }
}

private func lowerPoints(_ e: Expr, _ comps: (String) -> [String]?) throws -> Lowered {
  func lo(_ n: Expr) throws -> Lowered { try lowerPoints(n, comps) }
  switch e {
  case .num, .str:
    return .scalar(e)
  case .index, .range, .eqtest, .list:
    throw Unsupported("lists")
  case .var(let name):
    guard let names = comps(name) else { return .scalar(e) }
    return .vec(names.map { .var($0) })
  case .neg(let inner):
    switch try lo(inner) {
    case .vec(let items): return .vec(items.map(Sym.neg))
    case .scalar(let a): return .scalar(.neg(a))
    }
  case .bin(let op, let lhs, let rhs, let glyph):
    if let glyph, glyph != .dot, glyph != .cross { throw Unsupported("the \(glyph.rawValue) product") }
    let a = try lo(lhs)
    let b = try lo(rhs)
    switch (a, b) {
    case (.scalar(let x), .scalar(let y)):
      // Untouched scalar subtrees pass through unchanged; a rebuilt product
      // loses the glyph it was written with, as the TypeScript's does.
      return .scalar(x == lhs && y == rhs ? e : .bin(op, x, y))
    case (.vec(let x), .vec(let y)):
      switch op {
      case .add, .sub:
        if x.count != y.count {
          throw LanguageError(
            "Cannot \(op == .add ? "add" : "subtract") a \(x.count)-component and a \(y.count)-component vector.")
        }
        return .vec(zip(x, y).map { op == .add ? Sym.add($0, $1) : Sym.sub($0, $1) })
      case .mul:
        if glyph != nil { throw Unsupported("dot and cross products") }
        throw LanguageError("Use A · B or A × B (or dot(A, B), cross(A, B)) to multiply points.")
      case .div: throw LanguageError("Cannot divide by a point.")
      case .pow: throw LanguageError("Cannot raise a point to a power — |A| is its length.")
      }
    case (.vec(let x), .scalar(let y)):
      switch op {
      case .add, .sub: throw LanguageError("Cannot \(op == .add ? "add" : "subtract") a point and a number.")
      case .mul: return .vec(x.map { Sym.mul($0, y) })
      case .div: return .vec(x.map { Sym.div($0, y) })
      case .pow: throw LanguageError("Cannot raise a point to a power — |A| is its length.")
      }
    case (.scalar(let x), .vec(let y)):
      switch op {
      case .add, .sub: throw LanguageError("Cannot \(op == .add ? "add" : "subtract") a point and a number.")
      case .mul: return .vec(y.map { Sym.mul(x, $0) })
      case .div: throw LanguageError("Cannot divide by a point.")
      case .pow: throw LanguageError("Cannot raise a point to a power — |A| is its length.")
      }
    }
  case .call(let name, let args):
    var flat: [Expr] = []
    for arg in args {
      // |A|, and the functions of points (dot, distance, …), are not ported.
      guard case .scalar(let a) = try lo(arg) else { throw Unsupported("\(name)(…) of a point") }
      flat.append(a)
    }
    return .scalar(.call(name, flat))
  case .eq(let l, let r):
    let taken: String? = if case .var(let name) = l { takenNames[name] } else { nil }
    do {
      switch (try lo(l), try lo(r)) {
      case (.scalar(let a), .scalar(let b)): return .scalar(.eq(a, b))
      case (.vec(let a), .vec(let b)): return .scalar(.eq(.vec(a), .vec(b)))
      default: throw LanguageError("One side is a point and the other is a number.")
      }
    } catch let error as LanguageError {
      // `v = (1, 2, 3)` reads as an equation in v, not a definition.
      guard let taken, case .var(let name) = l else { throw error }
      throw LanguageError("\(name) is \(taken), so it cannot name a value — pick another name, like q.")
    }
  case .ineq(let op, let l, let r, let grouped):
    guard case .scalar(let a) = try lo(l), case .scalar(let b) = try lo(r) else {
      throw LanguageError("Points cannot be compared — compare |A - B| instead.")
    }
    return .scalar(.ineq(op, a, b, grouped: grouped))
  case .vec(let items):
    var flat: [Expr] = []
    var points = 0
    for item in items {
      switch try lo(item) {
      case .scalar(let a): flat.append(a)
      case .vec: points += 1
      }
    }
    if points == items.count { throw Unsupported("matrices") }
    if points > 0 { throw LanguageError("A point cannot be a component of a vector.") }
    return items.count == 2 || items.count == 3 ? .vec(flat) : .scalar(.vec(flat))
  case .piecewise(let cases, let otherwise):
    func one(_ n: Expr) throws -> Expr {
      guard case .scalar(let a) = try lo(n) else {
        throw LanguageError("Points cannot appear in a piecewise expression.")
      }
      return a
    }
    // Point-valued cases are a point of cases, coordinate by coordinate.
    let values = try cases.map { try lo($0.value) } + (try otherwise.map { [try lo($0)] } ?? [])
    let pointValued = values.contains { if case .vec = $0 { true } else { false } }
    if pointValued {
      var rows: [[Expr]] = []
      for v in values {
        guard case .vec(let items) = v, items.count == (rows.first?.count ?? items.count) else {
          throw LanguageError("Every case of a piecewise point must be a point of the same dimension.")
        }
        rows.append(items)
      }
      let conds = try cases.map { try one($0.cond) }
      return .vec(
        (0..<rows[0].count).map { k in
          .piecewise(
            conds.enumerated().map { j, cond in Expr.Case(cond: cond, value: rows[j][k]) },
            otherwise: otherwise == nil ? nil : rows[conds.count][k])
        })
    }
    // (A rebuilt piecewise does not keep which conditions were written bare.)
    let rebuilt = Expr.piecewise(
      try cases.enumerated().map { j, c in Expr.Case(cond: try one(c.cond), value: values[j].expr) },
      otherwise: otherwise == nil ? nil : values[cases.count].expr)
    let same = Expr.piecewise(cases.map { Expr.Case(cond: $0.cond, value: $0.value) }, otherwise: otherwise)
    return .scalar(rebuilt == same ? e : rebuilt)
  }
}
