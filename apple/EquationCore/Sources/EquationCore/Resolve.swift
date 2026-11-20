/// From a parsed row to scalar expressions the backends read: user functions
/// inlined, d/dx expanded, named conditions and points written in
/// (lib/defs.ts `resolveExpr`/`rx`, lib/geom.ts `lowerGeom`).
///
/// The port covers the scalar core and lists (ObjectLists.swift has the
/// resolver's part of those). Everything it has not reached — sums and
/// integrals, multivectors, … —
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
  /// The function now being resolved, seen from inside its own body: a call
  /// becomes a RECUR marker, and the finished body wraps into a loop.
  var recursive = false
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
  /// The value of a name defined as a complex number (`a = e^(iπ/3)`),
  /// written in wherever the name is read.
  var complex: (String) -> Expr? = { _ in nil }
  /// The value of a name defined as a multivector, a line or a plane: its
  /// internal node, written in wherever the name appears (GeomAlgebra.swift).
  var multivector: (String) -> Expr? = { _ in nil }
  /// A constant's value, for a Σ/Π bound at expansion time.
  var consts: (String) -> Double? = { _ in nil }
  /// Out: the constants Σ/Π bounds read (their sliders step in whole numbers).
  var boundConsts: NameBox?
  /// Names a Σ/Π bound may use without a value: a sequence's index, and the
  /// index of a sum that could not expand yet. The sum stays a call.
  var openVars: Set<String> = []
  /// A sequence term by name (a_3, a_k) or index (a_[…]) (Sequences.swift).
  var sequenceTerm: ((String, Expr?, Set<String>) throws -> Expr?)?
  /// What list lowering reads beside the constants (Lists.swift): which
  /// names are lists, and what is wrong with an index by its shape alone.
  var isList: (String) -> Bool = { _ in false }
  var getList: GetList?
  var indexIssue: ((_ index: Expr, _ target: Expr) -> String?)?
  /// A name defined as an interval (Interval.swift), and whether one may be
  /// written here: in a Fourier signal, or as a definition's whole value.
  var interval: (String) -> Expr? = { _ in nil }
  var intervals = false
}

/// The elementary functions the port evaluates and compiles: a call to any
/// other builtin is not supported yet.
/// The calls complex typing reads (lib/complex.ts): the projections, and the
/// forms that are a whole row.
let complexFunctions: Set<String> = ["re", "im", "arg", "conj", "domain", "conformal", "iter", "rgb", "hsl", "oklch"]

let elementaryFunctions: Set<String> = [
  "sin", "cos", "tan", "asin", "acos", "atan", "atan2", "sinh", "cosh", "tanh", "sech", "asinh", "acosh", "atanh",
  "sqrt", "abs", "exp", "ln", "log", "floor", "ceil", "round", "sign", "min", "max", "mod", "fract", "erf",
  "normalpdf", "normalcdf", "gcd", "isprime", "gamma", "factorial", "sinc", "coth",
]

private let spaceVars: Set<String> = ["x", "y", "z"]
private let coordNames = ["x", "y", "z"]

struct Resolver {
  var getFn: GetFn
  var opts: ResolveOpts
  var ctx = ResolveCtx()

  // MARK: Derivatives (lib/defs.ts dOrder … matchDeriv)

  /// A differential's name: d and one letter, Latin or Greek (dx, dθ).
  private func dVarName(_ n: Expr) -> String? {
    guard case .var(let name) = n else { return nil }
    let u = Array(name.utf16)
    guard u.count == 2, u[0] == unit("d"), isNameLetter(u[1]) else { return nil }
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
    if case .neg(let a) = n, let order = dOrder(a) { return (order, neg) }
    if case .bin(.mul, let c, let b, _) = n, let order = dOrder(b) { return (order, { mul(c, $0) }) }
    return nil
  }

  /// `e` with the named definitions it reaches that depend on position
  /// written out, so differentiation sees through them (`throughFields`).
  func throughFields(_ e: Expr, over asked: Set<String>? = nil) -> Expr {
    // (`over` asks for other variables than x, y, z: u and v write out a named surface.)
    let over = asked ?? spaceVars
    func closed(_ name: String, _ seen: Set<String>) -> Expr? {
      if over.contains(name) || seen.contains(name) { return nil }
      guard let value = opts.definition(name) else { return nil }
      if case .vec = value { return nil }
      if case .list = value { return nil }
      let inner = seen.union([name])
      var sub: [String: Expr] = [:]
      for v in freeVars(value) {
        if let c = closed(v, inner) { sub[v] = c }
      }
      let out = sub.isEmpty ? value : substVars(value, sub)
      return freeVars(out).contains(where: over.contains) ? out : nil
    }
    var sub: [String: Expr] = [:]
    for v in freeVars(e) {
      if let c = closed(v, []) { sub[v] = c }
    }
    return sub.isEmpty ? e : substVars(e, sub)
  }

  /// Step for the central-difference fallback.
  private static let fdH = 1e-4

  func applyDiff(_ operand: Expr, _ v: String, _ order: Int) throws -> Expr {
    try refuseListDerivative(operand)
    var e = throughFields(operand)
    // A component that does not exist — F_1 of a function F, G_1 of a point
    // whose components are G_x, G_y — would differentiate to 0.
    for name in freeVars(e) {
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
          "\(name) is not defined — \(base) is a function. Name its value first, "
            + "like G = \(base)(x, y, z), then use G_x, G_y, G_z."
        )
      }
    }
    for _ in 0..<order {
      do {
        e = try diff(e, v)
      } catch {
        // (Any other error is the row's own: an inequality, a tuple.)
        guard error.nonSmooth else { throw LanguageError(error.message) }
        // factorial, gamma, floor, …: expand a symbolic central difference.
        let vv = Expr.var(v)
        let h = Expr.num(Resolver.fdH)
        e = div(
          sub(substVars(e, [v: add(vv, h)]), substVars(e, [v: sub(vv, h)])), .num(2 * Resolver.fdH))
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
  func pointCoord(_ name: String) -> Expr? {
    let u = Array(name.utf16)
    guard let dot = u.lastIndex(of: unit(".")), dot > 0,
      let k = coordNames.firstIndex(of: String(u[(dot + 1)...]))
    else { return nil }
    let base = String(u[..<dot])
    if opts.isList(base) || opts.params?.contains(base) == true { return nil }
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
    // `big = L > 1` is the members it keeps, a list.
    if case .var(let name) = raw, opts.isList(name) {
      throw LanguageError("\(name) is a list, not a condition; write the comparison itself in the braces.")
    }
    throw notACondition(raw)
  }

  // MARK: rx

  func resolve(_ e: Expr) throws -> Expr {
    switch e {
    case .num:
      return e
    case .var(let name):
      if let term = try opts.sequenceTerm?(name, nil, opts.openVars) { return term }
      if let value = try namedInterval(name) { return value }
      if let value = opts.complex(name) { return value }
      // What the port cannot write in yet, by the names that ask for it.
      if name == "grad" || name == "div" || name == "curl" || name == "laplacian" {
        throw Unsupported("vector calculus")
      }
      if let value = opts.multivector(name) { return value }
      if let value = unitVector(name, opts) { return value }
      return pointCoord(name) ?? e
    case .neg(let a):
      return .neg(try resolve(a))
    case .bin(let op, let lhs, let rhs, let glyph):
      // Σ/∫ headers capture their trailing product chain before it resolves.
      if op == .mul || op == .div, let m = splitSumChain(e) {
        let body = try isSumHeader(m.header) ? expandSum(m.header, m.body) : expandInt(intBounds(m.header), m.body)
        return try m.coeff.map { .bin(m.op, try resolve($0), body) } ?? body
      }
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
    case .index(let target, let at):
      if case .var(let name) = target, let term = try opts.sequenceTerm?(name, at, opts.openVars) { return term }
      return try mapChildren(e, resolve)
    case .eqtest:
      return try mapChildren(e, resolve)
    case .range:
      throw LanguageError(structuralDiagnostic(e))
    case .call(let name, let rawArgs):
      return try resolveCall(name, rawArgs)
    case .eq(let l, let r):
      return .eq(try resolve(l), try resolve(r))
    case .ineq(let op, let l, let r, let grouped):
      return .ineq(op, try resolve(l), try resolve(r), grouped: grouped)
    case .vec(let items):
      return .vec(try items.map(resolve))
    case .list(let items):
      return try resolveList(items)
    case .str:
      return e
    case .data, .text:
      // Packed columns hold nothing to resolve.
      return e
    case .comp, .figure, .lazy, .trail, .label, .hist, .family, .loop:
      return try mapChildren(e, resolve)
    case .piecewise(let cases, let otherwise):
      for c in cases {
        guard case .eq = c.cond else { continue }
        // A lattice row may test equality, and so may a function body for
        // the lattice rows that call it (life(c, s) = {s = 3: 1, …}); the
        // lattice rewrites the case (`exactCases`), and any other row
        // inlining it fails to compile.
        if !opts.inDefinition && !opts.exactConditions {
          throw LanguageError(equalityCaseMessage)
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

  private func resolveCall(_ name: String, _ rawArgs: [Expr]) throws -> Expr {
    // (A list literal a Σ marked before its terms were written out.)
    if let marked = try resolveMarkedList(name, rawArgs) { return marked }
    if name == "sum" || name == "prod" {
      if rawArgs.count != 4 {
        throw LanguageError(
          "\(name == "sum" ? "Σ" : "Π") needs a body: write \(name)(n=1..N, …) or \(name)[n=1..N] (…).")
      }
      return try expandSum(.call(name, rawArgs), rawArgs[3])
    }
    if name == "int" {
      if rawArgs.count == 2 { throw LanguageError("∫ needs a body: write int[a..b] f(x) dx.") }
      let body = rawArgs[rawArgs.count - 1]
      return try expandInt(rawArgs.count == 3 ? (rawArgs[0], rawArgs[1]) : nil, body)
    }
    // A reduction of one argument is over a list, or an integral against a measure.
    if rawArgs.count == 1, ["count", "total", "mean", "min", "max", "stdev", "median", "hist"].contains(name) {
      return try resolveReduction(name, rawArgs[0])
    }
    if let fn = try getFn(name) {
      let n = fn.params.count
      // A function's arguments are as written when they fill its parameters:
      // only a mismatch spreads tuples, f((a, b)) ≡ f(a, b).
      let args = try (!fn.recursive && rawArgs.count == n ? rawArgs : legacyCallArgs("", rawArgs)).map(resolve)
      if fn.recursive { return try resolveRecur(name, n, args) }
      var env: [String: Expr] = [:]
      if args.count == 1, n >= 2, !isNum(args[0]) {
        // f(P) ≡ f(P_1, …, P_n): one argument that is an n-component point,
        // or a list of them.
        return try resolvePointCall(name, fn, args[0])
      }
      if args.count != n { throw LanguageError("\(name) takes \(n) argument\(n == 1 ? "" : "s").") }
      // A body that reduces takes a list argument one member at a time.
      if let map = try resolveMap(name, fn, args) { return map }
      for (p, arg) in zip(fn.params, args) { env[p] = arg }
      // The coordinates of point parameters the body reads, `p.x`, as the
      // argument's own (`coordParams`).
      for (key, value) in try coordParams(name, fn.body, Array(zip(fn.params, args))) { env[key] = value }
      let inlined = substVars(freshLists(fn.body, replacing: Set(env.keys)), env)
      // The body's named conditions, now that its parameters are its
      // arguments and cannot capture their variables.
      return opts.params != nil ? inlined : writeConditions(inlined, namedCondition)
    }
    if let signal = try resolveSignalCall(name, rawArgs) { return signal }
    // (A label's text is not math: it passes through as written.)
    let args = try legacyCallArgs(name, rawArgs).map { arg in
      if name == "label", case .str = arg { return arg }
      return try resolve(arg)
    }
    if name == "clamp" {
      // clamp(x, lo, hi) ≡ min(max(x, lo), hi): every backend already runs those.
      if args.count != 3 { throw LanguageError("clamp takes three arguments: clamp(x, lo, hi).") }
      return .call("min", [.call("max", [args[0], args[1]]), args[2]])
    }
    // trail(A): where A has been, lowered to a trail node with the points (Geom.swift).
    if name == "trail", !opts.inDefinition { return .call("trail", args) }
    if opts.inDefinition, ["trail", "rgb", "hsl", "oklch", "label"].contains(name) {
      throw LanguageError("\(name)(…) must be a whole row, not part of a definition.")
    }
    if name == "tube" || name == "revolve" { return try resolveSpaceForm(name, args) }
    if name == "gaussian" || name == "meancurvature" { return try surfaceGeometry(name, args) }
    if name == PAINT_CALL { return .call(name, args) }
    guard
      elementaryFunctions.contains(name) || complexFunctions.contains(name) || geometryFunctions.contains(name)
        || listFunctions.contains(name)
    else {
      throw Unsupported("\(name)(…)")
    }
    return .call(name, args)
  }

  /// A function's call to itself, inside its own body (lib/defs.ts `rx`,
  /// `fn.recursive`): the RECUR marker `wrapRecursion` makes a loop of.
  private func resolveRecur(_ name: String, _ n: Int, _ args: [Expr]) throws -> Expr {
    // f((a, b)) ≡ f(a, b), as for any other call with a tuple in hand.
    var splat = args
    if args.count == 1, n >= 2, case .vec(let items) = args[0] {
      splat = items
      if splat.count != n {
        throw LanguageError("\(name) takes \(n) arguments, and that point has \(splat.count) components.")
      }
    }
    // A computed point spreads into consecutive parameters too — f(T(a, b) +
    // P, k + 1) for f(a, b, k) — but how many it fills is only known once it
    // lowers, so geometry lowering counts then (lowerPoints, case .loop).
    // Arguments that cannot be points are counted here, where the definition
    // was written.
    if splat.count != n, !splat.contains(where: { mightBePoint($0, opts.comps) }) {
      throw LanguageError("\(name) takes \(n) argument\(n == 1 ? "" : "s").")
    }
    return .call(RECUR, splat)
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

/// What a piecewise case that tests equality says over the plane, where it
/// would be a curve's sliver.
let equalityCaseMessage =
  "A condition like y = x^2 is a filter for a reduction, like count({y = x^2, 0 < x < 1}); "
  + "piecewise conditions are inequalities."

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
enum Lowered {
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
func lowerGeom(
  _ e: Expr, comps: @escaping (String) -> [String]?, mats: @escaping GetMat = { _ in nil },
  tensors: @escaping GetTensor = { _, _ in nil }, isList: @escaping (String) -> Bool = { _ in false }
) throws -> Expr {
  // `[paint](S, f)`: the surface and the scalar it is coloured by, each lowered.
  if case .call(PAINT_CALL, let args) = e {
    return .call(PAINT_CALL, try args.map { try lowerGeom($0, comps: comps, mats: mats, tensors: tensors) })
  }
  // (A root-level geometry form — segment, polygon, circle, … — desugars first.)
  return try lowerWithMatrices(e, comps: comps, getMat: mats, getTensor: tensors, isList: isList)
}

/// A row's figures and points lowered, before its lists are (the geometry
/// half of lib/object-lists.ts `lowerObjects`, `ordinary`): ObjectLists.swift
/// lowers the lists, and expands the row over them where this fails.
func lowerGeomObjects(
  _ e: Expr, comps: @escaping (String) -> [String]?, mats: @escaping GetMat = { _ in nil },
  tensors: @escaping GetTensor = { _, _ in nil }, isList: @escaping (String) -> Bool = { _ in false },
  notMatrix: @escaping (Expr) -> Bool = { _ in false }
) throws -> Expr {
  let figures = try lowerFigureObjects(e, comps, mats, tensors, notMatrix: notMatrix)
  do {
    return try lowerGeom(figures, comps: comps, mats: mats, tensors: tensors, isList: isList)
  } catch let failed as FailedWithMatrices {
    // (What the row says; where it reads a matrix as the list of its rows,
    // the expansion says that is not supported.)
    throw failed.error
  }
}

func lowerPoints(_ e: Expr, _ comps: (String) -> [String]?, _ context: GeomContext) throws -> Lowered {
  func lo(_ n: Expr) throws -> Lowered { try lowerPoints(n, comps, context) }
  // A multivector, or a point, line or plane of projective geometry (GeomAlgebra.swift).
  let outer = context.enterAlgebra(e)
  defer { context.algebra.clean = outer }
  if let value = try context.algebraValue(e) { return value }
  // A tensor operation's result is whatever rank it comes to.
  if let value = try context.tensorValue(e) { return value }
  switch e {
  case .num, .str, .data, .text:
    // (Data and text lists hold no geometry: they pass straight through.)
    return .scalar(e)
  case .list(let items):
    // Items lower independently; a named point becomes its (A_x, A_y) tuple,
    // so [A, B] scatters named points like [(1, 2), (3, 4)] does literals.
    if let multiset = try context.algebraList(items) { return .scalar(multiset) }
    return .scalar(.list(try items.map { try lo($0).expr }))
  case .index, .range, .eqtest, .figure, .lazy, .trail, .label, .hist, .family:
    // A point among a structural node's children is written out as a tuple.
    return .scalar(
      try mapChildren(e) { n in
        switch try lo(n) {
        case .vec(let items): .vec(items)
        case .scalar(let a): a
        }
      })
  case .comp(let value, let index, let arity, let functionName):
    // (A list of points waits for list lowering, which reads the coordinate
    // of every point in it.)
    if try context.compMatrix(value) { throw Unsupported("a matrix read as a list of its rows") }
    if let waiting = try waitingComp(e, isList: context.isList, lo) { return .scalar(waiting) }
    return try lowerComp(value, index, arity, functionName, context)
  case .loop(let params, let seeds, let loopBody, let limit):
    return .scalar(try lowerLoop(params, seeds, loopBody, limit, lo, context))
  case .var(let name):
    try context.refuseMatrixName(name)
    guard let names = comps(name) else { return .scalar(e) }
    return .vec(names.map { .var($0) })
  case .neg(let inner):
    try context.refuseMatrixValue(e)
    switch try lo(inner) {
    case .vec(let items): return .vec(items.map(neg))
    case .scalar(let a): return .scalar(.neg(a))
    }
  case .bin(let op, let lhs, let rhs, let glyph):
    // The matvec M v: a matrix as the direct left factor of a product.
    if let applied = try context.matrixProduct(e, op, lhs, rhs) { return applied }
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
        return .vec(zip(x, y).map { op == .add ? add($0, $1) : sub($0, $1) })
      case .mul:
        // A · B and A × B, as written; a plain * between points has no one meaning.
        if let glyph { return try lo(.call(glyph.rawValue, [lhs, rhs])) }
        throw LanguageError("Use A · B or A × B (or dot(A, B), cross(A, B)) to multiply points.")
      case .div: throw LanguageError("Cannot divide by a point.")
      case .pow: throw LanguageError("Cannot raise a point to a power — |A| is its length.")
      }
    case (.vec(let x), .scalar(let y)):
      switch op {
      case .add, .sub: throw LanguageError("Cannot \(op == .add ? "add" : "subtract") a point and a number.")
      case .mul: return .vec(x.map { mul($0, y) })
      case .div: return .vec(x.map { div($0, y) })
      case .pow: throw LanguageError("Cannot raise a point to a power — |A| is its length.")
      }
    case (.scalar(let x), .vec(let y)):
      switch op {
      case .add, .sub: throw LanguageError("Cannot \(op == .add ? "add" : "subtract") a point and a number.")
      case .mul: return .vec(y.map { mul(x, $0) })
      case .div: throw LanguageError("Cannot divide by a point.")
      case .pow: throw LanguageError("Cannot raise a point to a power — |A| is its length.")
      }
    }
  case .call(let name, let args):
    // A list lowered already holds no geometry; a function applied per
    // member of lists is list lowering's to run.
    if name == LIST_SEQ { return .scalar(e) }
    if name == MAP { return .scalar(try lowerMapPoints(args) { try lo($0).expr }) }
    if let geometry = try lowerGeomCall(e, name, args, context) { return geometry }
    let lowered = try args.map(lo)
    // sort(P, P.x) orders points by a key, and count, total and mean take
    // any multiset, points included: list lowering does the work, and a
    // point stays one value there.
    var pointArg = false
    if args.count == 1, case .vec = lowered[0] { pointArg = true }
    if name == "sort" || (pointArg && ["count", "total", "mean"].contains(name)) {
      return .scalar(.call(name, lowered.map(\.expr)))
    }
    var flat: [Expr] = []
    for arg in lowered {
      if case .scalar(let a) = arg {
        flat.append(a)
        continue
      }
      throw LanguageError("\(name) is not defined for points.")
    }
    return .scalar(.call(name, flat))
  case .eq(let l, let r):
    let taken: String? = if case .var(let name) = l { takenNames[name] } else { nil }
    do {
      let left = try lo(l)
      let right = try lo(r)
      switch (left, right) {
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
    // (Both sides lower before either is refused: the right side's own
    // error comes first, as it does on the site.)
    let left = try lo(l)
    let right = try lo(r)
    guard case .scalar(let a) = left, case .scalar(let b) = right else {
      throw LanguageError("Points cannot be compared — compare |A - B| instead.")
    }
    return .scalar(.ineq(op, a, b, grouped: grouped))
  case .vec(let items):
    var flat: [Expr] = []
    var rows: [[Expr]] = []
    for item in items {
      switch try lo(item) {
      case .scalar(let a): flat.append(a)
      case .vec(let row): rows.append(row)
      }
    }
    // A tuple of points is a matrix, or a tuple of points in order.
    if !rows.isEmpty && rows.count == items.count { return try context.tupleOfPoints(e, rows) }
    if !rows.isEmpty { throw LanguageError("A point cannot be a component of a vector.") }
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

/// A loop under point lowering (lib/geom.ts `lower`, case 'loop'). A
/// self-call's points spread into consecutive parameters, as a call's single
/// point does: f(T(a, b) + P, k + 1) passes f(a, b, k) three values. The
/// function's result and conditions stay numbers. (A quaternion spreads the
/// same way, into its w, x, y, z.)
private func lowerLoop(
  _ params: [String], _ seeds: [Expr], _ loopBody: Expr, _ limit: Int, _ lo: (Expr) throws -> Lowered,
  _ context: GeomContext
) throws -> Expr {
  func scalar(_ n: Expr) throws -> Expr {
    guard case .scalar(let a) = try lo(n) else {
      throw LanguageError("Points cannot pass through a recursive function.")
    }
    return a
  }
  func body(_ x: Expr) throws -> Expr {
    if let recur = recurArgs(x) {
      var args: [Expr] = []
      for a in recur {
        // A quaternion spreads into its w, x, y, z.
        if let parts = try context.quaternionSpread(a) {
          args += parts
          continue
        }
        switch try lo(a) {
        case .vec(let items): args += items
        case .scalar(let e): args.append(e)
        }
      }
      if args.count != params.count {
        throw LanguageError(
          "A recursive call passes \(args.count) value\(args.count == 1 ? "" : "s"), "
            + "and the function takes \(params.count).")
      }
      return .call(RECUR, args)
    }
    guard case .piecewise(let cases, let otherwise) = x else { return try scalar(x) }
    return .piecewise(
      try cases.map { Expr.Case(cond: try scalar($0.cond), value: try body($0.value)) },
      otherwise: try otherwise.map(body))
  }
  return .loop(params: params, seeds: try seeds.map(scalar), body: try body(loopBody), limit: limit)
}
