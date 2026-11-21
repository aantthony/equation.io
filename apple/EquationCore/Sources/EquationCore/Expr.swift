/// The symbolic expression tree (lib/expr.ts `Expr`), and what the language
/// reads of a tree's structure: its children, its free variables, its key.
///
/// Every kind of the TypeScript's union is here, field for field. The first
/// fourteen are what the parser writes; the rest only lowering makes (a
/// function applied to a point, a figure, a packed list, a loop).
///
/// List identity. The TypeScript hangs `axes` and `origin` on list nodes: a
/// list's identity while lists lower, which decides whether two lists zip
/// (the same list) or cross (independent ones). An enum's cases have no room
/// for them, and a value has no identity of its own, so the port carries
/// them without touching a case:
/// - the axes a lowered list runs over travel beside it, in a `Low`
///   (Lists.swift), never on the node;
/// - a list literal the resolver has met is written `[list](id, [ … ])`, a
///   call no row can spell (`LIST_ID`), so every copy substitution makes of
///   it is the same list, as every reference to the TypeScript's one node
///   is; `[origin](id, [ … ])` is one `markOrigins` marked, whose identity
///   also survives a copy that changes its items;
/// - a list lowered ahead of its row is written back as `[seq](axes, list)`
///   (`LIST_SEQ`), as the TypeScript writes back a node with its `axes`.
/// List lowering reads all three and leaves none behind; `exprKey` of a
/// lowered tree never sees one.
public indirect enum Expr: Equatable, Hashable, Sendable {
  case num(Double)
  case `var`(String)
  case bin(BinOp, Expr, Expr, glyph: ProductGlyph? = nil)
  case neg(Expr)
  case call(String, [Expr])
  case index(Expr, Expr)
  case range(Expr, Expr)
  case eqtest(EqTestOp, Expr, Expr)
  case eq(Expr, Expr)
  /// Chains nest left: 0 < y < x is ((0 < y) < x). `grouped` marks one written in parentheses.
  case ineq(IneqOp, Expr, Expr, grouped: Bool = false)
  case vec([Expr])
  case list([Expr])
  case str(String)
  case piecewise([Case], otherwise: Expr?)
  /// Component `index` (0-based) of `value`, which must be a point of `arity`
  /// components: how `f(P)` hands a point to an `arity`-parameter function
  /// `functionName`. Arity 0 is a coordinate read, `p.x`, of a point of any
  /// dimension that has it. The resolver writes it (it cannot know yet what
  /// is a point); geometry lowering settles a single point, list lowering a
  /// list of them.
  case comp(value: Expr, index: Int, arity: Int, functionName: String)
  /// A figure's vertices, flat (`dimension` numbers per vertex) — or, with
  /// `over`, one vertex template evaluated once per element of the columns:
  /// a path through thousands of computed points stays a single template.
  case figure(form: FigureForm, dimension: Int, vertices: [Expr], over: [Column]? = nil)
  case trail(coordinates: [Expr])
  /// `label(point, "text")`: text anchored at a point. Only the point is math.
  case label(coordinates: [Expr], text: String)
  case hist(centers: [Double], counts: [Double], width: Double)
  case family(members: [Expr])
  /// A list of numbers held as one array (a Float64Array on the site): a CSV
  /// column, or anything constant derived from one. Semantically a `list` of
  /// num nodes. Only list lowering makes or reads one, and like `list` it
  /// never survives lowering: GLSL, diff and the integrator never see it.
  case data(values: [Double])
  /// A list kept as one template over packed columns: element k is `body`
  /// with each column's variable bound to its k-th value. What list lowering
  /// builds when an operation over numbers involves a slider or t,
  /// `sin(a L)`. Like `data`, it never survives lowering unless the caller
  /// asks for it (a connected figure, which keeps it as `over`).
  case lazy(cols: [Column], body: Expr)
  /// A text column, the counterpart of `data`. Same rule as `str`: only comparisons.
  case text(values: [String])
  /// A tail-recursive function call run as a bounded loop: `params` start at
  /// `seeds`; each pass evaluates `body`, a piecewise whose leaves either
  /// give the result or, as a `RECUR` call, the params for the next pass.
  /// The params are bound inside body only (a binder, like a Σ index): seeds
  /// and everything else in body resolve in the enclosing scope. Undefined
  /// (NaN) once `limit` passes run out, a param leaves the finite range, or
  /// no case holds and there is no default.
  case loop(params: [String], seeds: [Expr], body: Expr, limit: Int)

  public struct Case: Equatable, Hashable, Sendable {
    public var cond: Expr
    public var value: Expr
    /// A condition written without a value (`{x > 0, …}`), whose value is 1.
    public var bare: Bool

    public init(cond: Expr, value: Expr, bare: Bool = false) {
      self.cond = cond
      self.value = value
      self.bare = bare
    }
  }

  /// The node's `kind`, as the TypeScript names it.
  public var kind: String {
    switch self {
    case .num: "num"
    case .var: "var"
    case .bin: "bin"
    case .neg: "neg"
    case .call: "call"
    case .index: "index"
    case .range: "range"
    case .eqtest: "eqtest"
    case .eq: "eq"
    case .ineq: "ineq"
    case .vec: "vec"
    case .list: "list"
    case .str: "str"
    case .piecewise: "piecewise"
    case .comp: "comp"
    case .figure: "figure"
    case .trail: "trail"
    case .label: "label"
    case .hist: "hist"
    case .family: "family"
    case .data: "data"
    case .lazy: "lazy"
    case .text: "text"
    case .loop: "loop"
    }
  }
}

extension Expr {
  /// Equality and hashing are written out, not derived: a derived one's
  /// frame holds every case's payload at once (about 2 KB in a debug build),
  /// and comparing or hashing a row — a memo's key — is a frame per level of
  /// it. Equality is the derived one's, field by field (so NaN is not NaN);
  /// equal nodes feed the hasher the same things, which is all hashing asks.
  public static func == (a: Expr, b: Expr) -> Bool {
    switch (a, b) {
    case (.num(let x), .num(let y)): return x == y
    case (.var(let x), .var(let y)): return x == y
    case (.neg(let x), .neg(let y)): return x == y
    case (.bin(let op, let l, let r, let glyph), .bin(let op2, let l2, let r2, let glyph2)):
      return op == op2 && glyph == glyph2 && l == l2 && r == r2
    case (.call(let name, let args), .call(let name2, let args2)):
      return name == name2 && sameItems(args, args2)
    default:
      return a.sameStructure(as: b)
    }
  }

  private static func sameItems(_ a: [Expr], _ b: [Expr]) -> Bool {
    guard a.count == b.count else { return false }
    for k in a.indices where !(a[k] == b[k]) { return false }
    return true
  }

  /// The rarer kinds of `==`.
  private func sameStructure(as other: Expr) -> Bool {
    switch (self, other) {
    case (.index(let a, let b), .index(let a2, let b2)), (.range(let a, let b), .range(let a2, let b2)),
      (.eq(let a, let b), .eq(let a2, let b2)):
      return a == a2 && b == b2
    case (.eqtest(let op, let a, let b), .eqtest(let op2, let a2, let b2)):
      return op == op2 && a == a2 && b == b2
    case (.ineq(let op, let a, let b, let grouped), .ineq(let op2, let a2, let b2, let grouped2)):
      return op == op2 && grouped == grouped2 && a == a2 && b == b2
    case (.vec(let a), .vec(let b)), (.list(let a), .list(let b)), (.trail(let a), .trail(let b)),
      (.family(let a), .family(let b)):
      return Expr.sameItems(a, b)
    case (.str(let a), .str(let b)):
      return a == b
    case (.piecewise(let cases, let otherwise), .piecewise(let cases2, let otherwise2)):
      return cases == cases2 && otherwise == otherwise2
    case (.comp(let value, let index, let arity, let name), .comp(let value2, let index2, let arity2, let name2)):
      return index == index2 && arity == arity2 && name == name2 && value == value2
    case (.figure(let form, let dim, let vertices, let over), .figure(let form2, let dim2, let vertices2, let over2)):
      return form == form2 && dim == dim2 && over == over2 && Expr.sameItems(vertices, vertices2)
    case (.label(let coordinates, let text), .label(let coordinates2, let text2)):
      return text == text2 && Expr.sameItems(coordinates, coordinates2)
    case (.hist(let centers, let counts, let width), .hist(let centers2, let counts2, let width2)):
      return centers == centers2 && counts == counts2 && width == width2
    case (.data(let a), .data(let b)):
      return a == b
    case (.lazy(let cols, let body), .lazy(let cols2, let body2)):
      return cols == cols2 && body == body2
    case (.text(let a), .text(let b)):
      return a == b
    case (.loop(let params, let seeds, let body, let limit), .loop(let params2, let seeds2, let body2, let limit2)):
      return params == params2 && limit == limit2 && Expr.sameItems(seeds, seeds2) && body == body2
    default:
      return false
    }
  }

  public func hash(into hasher: inout Hasher) {
    switch self {
    case .num(let value):
      hasher.combine(0)
      hasher.combine(value)
    case .var(let name):
      hasher.combine(1)
      hasher.combine(name)
    case .neg(let a):
      hasher.combine(2)
      a.hash(into: &hasher)
    case .bin(let op, let a, let b, let glyph):
      hasher.combine(3)
      hasher.combine(op)
      hasher.combine(glyph)
      a.hash(into: &hasher)
      b.hash(into: &hasher)
    case .call(let name, let args):
      hasher.combine(4)
      hasher.combine(name)
      hasher.combine(args.count)
      for arg in args { arg.hash(into: &hasher) }
    default:
      hashStructure(into: &hasher)
    }
  }

  /// The rarer kinds: the kind, what it holds beside expressions that is
  /// cheap to say, and its children.
  private func hashStructure(into hasher: inout Hasher) {
    hasher.combine(kind)
    switch self {
    case .str(let value): hasher.combine(value)
    case .data(let values): hasher.combine(values)
    case .text(let values): hasher.combine(values)
    case .hist(let centers, let counts, let width):
      hasher.combine(centers)
      hasher.combine(counts)
      hasher.combine(width)
    case .comp(_, let index, let arity, _):
      hasher.combine(index)
      hasher.combine(arity)
    default: break
    }
    let children = childrenOf(self)
    hasher.combine(children.count)
    for child in children { child.hash(into: &hasher) }
  }
}

public enum BinOp: String, Sendable {
  case add = "+", sub = "-", mul = "*", div = "/", pow = "^"
}

public enum IneqOp: String, Sendable {
  case lt = "<", le = "<=", gt = ">", ge = ">="
}

public enum EqTestOp: String, Sendable {
  case eq = "==", ne = "!="
}

/// How a product was written: between vectors, tensors or multivectors the
/// glyph picks the product; between numbers it is plain multiplication.
public enum ProductGlyph: String, Sendable {
  case dot, cross, outer, wedge, geometric
}

/// What a figure draws of its vertices (lib/expr.ts `FigureForm`).
public enum FigureForm: String, Sendable {
  case polygon, segment, polyline, vector, square, hull
}

/// A packed column a `lazy` list or packed figure runs over (lib/expr.ts
/// `Column`): `name` is the variable its template reads, bound to values[k]
/// for element k. Names start with '@', so they never collide with anything
/// a row can write.
public struct Column: Equatable, Hashable, Sendable {
  public var name: String
  public var values: [Double]

  public init(name: String, values: [Double]) {
    self.name = name
    self.values = values
  }
}

// MARK: - Names only lowering writes

/// A continuous interval's hidden parameter (lib/expr.ts `INTERVAL`): not an
/// identifier, so no document name or builtin can collide with it.
let INTERVAL = "[interval]"
/// The self-call inside a `loop` body (lib/expr.ts `RECUR`): its args are the
/// next pass's params.
let RECUR = "@recur"
/// The member a guard leaves where no case holds, `[none]()`: the empty box
/// (lib/expr.ts `NONE`). Anything that still evaluates one gets NaN.
let NONE = "[none]"
/// A function applied per member of its list arguments (lib/expr.ts `MAP`):
/// `[map](body, "m", M, …)` is the body once per member. List lowering
/// evaluates it; nothing downstream sees it.
let MAP = "[map]"
/// A list literal with an identity, `[list]("7", [1, 2, 3])`, and one whose
/// identity survives a changed copy (lib/expr.ts `origin`); see "List
/// identity" above.
let LIST_ID = "[list]"
let LIST_ORIGIN = "[origin]"
/// A lowered list with the axes it runs over, `[seq](axes, list)`.
let LIST_SEQ = "[seq]"
/// Passes a tail-recursive function may take before it is undefined
/// (lib/expr.ts `LOOP_LIMIT`).
let LOOP_LIMIT = 250
/// The most passes a loop with an explicit counter (`k >= 600: …`) may ask
/// for (lib/expr.ts `LOOP_LIMIT_MAX`).
let LOOP_LIMIT_MAX = 5000
/// `[term]("eqioSeq_a_", k, …inputs)`: term k of a recurrence, read from the
/// chain of constants that computes it (lib/expr.ts `TERM_AT_FN`). The
/// trailing arguments are the recurrence's inputs: not evaluated, only there
/// so the row depends on what the chain does.
let TERM_AT_FN = "[term]"
/// The internal call angle(…) lowers to (lib/expr.ts `ANGLE_FN`): [angle](u0, u1, v0, v1).
let ANGLE_FN = "[angle]"
/// d/dp of [angle] is a difference of two of these, one per arm (lib/expr.ts
/// `ANGLE_RATE_FN`): [angle′](v0, v1, w0, w1) is the turning rate of arm v
/// moving with velocity w.
let ANGLE_RATE_FN = "[angle′]"
/// The densities of the distributions that have no elementary closed form a
/// float32 shader survives (lib/expr.ts `GAMMA_PDF_FN`, …).
let GAMMA_PDF_FN = "[gammapdf]"
let BETA_PDF_FN = "[betapdf]"
let T_PDF_FN = "[tpdf]"
let WEIBULL_PDF_FN = "[weibullpdf]"
/// The probability mass functions of the discrete laws (lib/expr.ts
/// `PMF_FNS`). First argument k; CPU only: a pmf is drawn as stems, never
/// by a shader.
let BINOM_PMF_FN = "[binomialpmf]"
let POISSON_PMF_FN = "[poissonpmf]"
let NEGBINOM_PMF_FN = "[negativebinomialpmf]"
let DUNIFORM_PMF_FN = "[discreteuniformpmf]"
let PMF_FNS: Set<String> = [BINOM_PMF_FN, POISSON_PMF_FN, NEGBINOM_PMF_FN, DUNIFORM_PMF_FN]

/// The name an internal call wears in a message (lib/expr.ts `plainFnName`):
/// `[polygon]` is written polygon, and both angle helpers are the user's angle.
func plainFnName(_ name: String) -> String {
  if name == ANGLE_RATE_FN { return "angle" }
  // As the TypeScript's slice(1, -1): the first and last characters go.
  return name.hasPrefix("[") ? String(name.dropFirst().dropLast()) : name
}

/// The leaves of a loop body's piecewise tree, in order (lib/expr.ts `loopLeaves`).
func loopLeaves(_ body: Expr) -> [Expr] {
  guard case .piecewise(let cases, let otherwise) = body else { return [body] }
  return cases.flatMap { loopLeaves($0.value) } + (otherwise.map(loopLeaves) ?? [])
}

/// A loop body's self-call, as its arguments (lib/expr.ts `isRecur`).
func recurArgs(_ e: Expr) -> [Expr]? {
  if case .call(RECUR, let args) = e { return args }
  return nil
}

/// The calls that take a tuple whole (lib/expr.ts `legacyCallArgs`).
private let groupedCalls: Set<String> = [
  "segment", "polyline", "polygon", "hull", "vector", "line", "circle", "square", "distance", "angle", "dot",
  "cross", "midpoint", "perp", "unit", "rotate", "grad", "div", "curl", "laplacian",
  // A tuple of rows is one matrix argument: det(((a, b), (c, d))).
  "det", "trace", "solve", "exp",
  // Tensors are nested tuples: outer((1, 0), (0, 1)) takes two vectors.
  "outer", "wedge", "contract",
  // Multivectors take vectors whole: gp((1, 0), (0, 1)) is e_xy.
  "gp", "rev", "grade", "dual", "slerp", "vec",
  // Points of projective geometry are tuples, whole: join((0, 0), (1, 1)).
  "meet", "join", "plane", "project", "reflect", "motor",
  // A matrix or a map, whole: action(((1, 1), (0, 1))), jacobian((x y, x + y)).
  "action", "streamlines", "jacobian", "hessian", "transpose",
  // A curve, whole: curvature((cos(u), sin(u)), 0.5).
  "curvature", "torsion", "osculating", "frame",
  // A surface, whole: gaussian((u, v, u v), (0.5, 0.5)), and a geodesic's start and direction.
  "gaussian", "meancurvature", "geodesic",
  // sort((s, sin(s)), s): the points to order, then their key.
  "sort", "fourier", "reconstruct",
  // A stack is a tuple, whole: push((1, 2), 3) is (1, 2, 3).
  "push", "pop", "top",
]

/// Historical tuple-call spelling, applied before resolving argument values
/// (lib/expr.ts `legacyCallArgs`): f((a, b)) ≡ f(a, b). Only syntax vectors
/// flatten: a named or computed vector is never splatted.
func legacyCallArgs(_ name: String, _ args: [Expr]) -> [Expr] {
  if groupedCalls.contains(name) { return args }
  return args.flatMap { (x: Expr) -> [Expr] in
    if case .vec(let items) = x { return items }
    return [x]
  }
}

// MARK: - Diagnostics

/// Flatten a (possibly chained) inequality into its comparisons; comparison k
/// compares the previous comparison's right side, so 0 < y < x yields
/// [0 < y, y < x] (lib/expr.ts `ineqComparisons`). Empty unless `e` is an ineq.
func ineqComparisons(_ e: Expr) -> [(op: IneqOp, l: Expr, r: Expr)] {
  var chain: [(op: IneqOp, l: Expr, r: Expr)] = []
  var node = e
  while case .ineq(let op, let l, let r, _) = node {
    chain.insert((op, l, r), at: 0)
    node = l
  }
  return chain.indices.map { k in (chain[k].op, k == 0 ? chain[k].l : chain[k - 1].r, chain[k].r) }
}

/// The messages of a `comp` whose value is not an n-component point
/// (lib/expr.ts `compArity`; n = 0 is a coordinate read).
func compArity(_ fn: String, _ n: Int) -> String {
  n != 0 ? "\(fn) takes \(n) arguments." : "\(fn) reads a coordinate of a point, and that is not one."
}

/// What a node that only lowering reads says when it reaches scalar code
/// (lib/expr.ts `structuralDiagnostic`).
func structuralDiagnostic(_ e: Expr) -> String {
  switch e {
  case .comp(_, _, let arity, let functionName): compArity(functionName, arity)
  case .range: "'..' ranges only appear in sum(n=1..N, …), prod(…), int[a..b], or a list like [1..10]."
  case .index: "List indexing must resolve before scalar evaluation."
  case .eqtest(let op, _, _): "'\(op.rawValue)' tests a list inside a filter."
  case .figure(let form, _, _, _): "\(form.rawValue)(…) must be the whole expression."
  default: "\(e.kind)(…) must be the whole expression."
  }
}

// MARK: - Structure (lib/expr.ts childrenOf, mapChildren, substVars, freeVars)

/// A node's direct children, in the order the TypeScript lists them. Packed
/// numeric and text columns are leaves.
public func childrenOf(_ e: Expr) -> [Expr] {
  switch e {
  case .num, .var, .str, .hist, .data, .text: return []
  case .neg(let a): return [a]
  case .bin(_, let a, let b, _), .index(let a, let b), .range(let a, let b), .eqtest(_, let a, let b),
    .eq(let a, let b), .ineq(_, let a, let b, _):
    return [a, b]
  case .call(_, let items), .vec(let items), .list(let items), .figure(_, _, let items, _), .trail(let items),
    .label(let items, _), .family(let items):
    return items
  case .comp(let value, _, _, _): return [value]
  case .lazy(_, let body): return [body]
  case .piecewise(let cases, let otherwise):
    return cases.flatMap { [$0.cond, $0.value] } + (otherwise.map { [$0] } ?? [])
  case .loop(_, let seeds, let body, _): return seeds + [body]
  }
}

/// Map one level of children, keeping everything else about the node.
/// (A small function a shape: every walk of a tree stands on this one, a
/// frame of it per level, and a debug build's frame holds every case's
/// temporaries at once.)
public func mapChildren(_ e: Expr, _ map: (Expr) throws -> Expr) rethrows -> Expr {
  switch e {
  case .num, .var, .str, .hist, .data, .text: return e
  case .neg(let a): return .neg(try map(a))
  case .bin: return try mapBin(e, map)
  case .index, .range, .eqtest, .eq, .ineq: return try mapPair(e, map)
  case .call(let name, let args): return .call(name, try mapEach(args, map))
  case .vec, .list, .trail, .label, .family: return try mapItems(e, map)
  case .piecewise(let cases, let otherwise): return try mapPiecewise(cases, otherwise, map)
  case .comp, .figure, .lazy, .loop: return try mapBound(e, map)
  }
}

private func mapBin(_ e: Expr, _ map: (Expr) throws -> Expr) rethrows -> Expr {
  guard case .bin(let op, let a, let b, let glyph) = e else { return e }
  return .bin(op, try map(a), try map(b), glyph: glyph)
}

private func mapPair(_ e: Expr, _ map: (Expr) throws -> Expr) rethrows -> Expr {
  switch e {
  case .index(let a, let b): return .index(try map(a), try map(b))
  case .range(let a, let b): return .range(try map(a), try map(b))
  case .eqtest(let op, let a, let b): return .eqtest(op, try map(a), try map(b))
  case .eq(let l, let r): return .eq(try map(l), try map(r))
  case .ineq(let op, let l, let r, let grouped): return .ineq(op, try map(l), try map(r), grouped: grouped)
  default: return e
  }
}

/// `items.map(map)`, as a loop: `map` is a frame of its own, and a thunk's, per level.
private func mapEach(_ items: [Expr], _ map: (Expr) throws -> Expr) rethrows -> [Expr] {
  var out: [Expr] = []
  out.reserveCapacity(items.count)
  for item in items { out.append(try map(item)) }
  return out
}

private func mapItems(_ e: Expr, _ map: (Expr) throws -> Expr) rethrows -> Expr {
  switch e {
  case .vec(let items): return .vec(try items.map(map))
  case .list(let items): return .list(try items.map(map))
  case .trail(let coordinates): return .trail(coordinates: try coordinates.map(map))
  case .label(let coordinates, let text): return .label(coordinates: try coordinates.map(map), text: text)
  case .family(let members): return .family(members: try members.map(map))
  default: return e
  }
}

private func mapPiecewise(_ cases: [Expr.Case], _ otherwise: Expr?, _ map: (Expr) throws -> Expr) rethrows -> Expr {
  .piecewise(
    try cases.map { Expr.Case(cond: try map($0.cond), value: try map($0.value), bare: $0.bare) },
    otherwise: try otherwise.map(map))
}

private func mapBound(_ e: Expr, _ map: (Expr) throws -> Expr) rethrows -> Expr {
  switch e {
  case .comp(let value, let index, let arity, let functionName):
    return .comp(value: try map(value), index: index, arity: arity, functionName: functionName)
  case .figure(let form, let dimension, let vertices, let over):
    return .figure(form: form, dimension: dimension, vertices: try vertices.map(map), over: over)
  case .lazy(let cols, let body): return .lazy(cols: cols, body: try map(body))
  case .loop(let params, let seeds, let body, let limit):
    // Seeds first, then the body, as `childrenOf` orders them.
    let mapped = try seeds.map(map)
    return .loop(params: params, seeds: mapped, body: try map(body), limit: limit)
  default: return e
  }
}

/// A Σ/Π that survived resolve: args are [index, lo, hi, body]. Its index is
/// bound (lib/expr.ts `isBoundSum`).
func boundSumIndex(_ e: Expr) -> String? {
  guard case .call(let name, let args) = e, name == "sum" || name == "prod", args.count >= 4,
    case .var(let index) = args[0]
  else { return nil }
  return index
}

/// Replace free variables by expressions. A surviving Σ/Π binds its index,
/// and a loop its params.
public func substVars(_ e: Expr, _ env: [String: Expr]) -> Expr {
  if case .var(let name) = e { return env[name] ?? e }
  if let index = boundSumIndex(e), env[index] != nil, case .call(let name, let args) = e {
    var bodyEnv = env
    bodyEnv[index] = nil
    return .call(name, args.enumerated().map { k, a in substVars(a, k == 0 || k == 3 ? bodyEnv : env) })
  }
  if case .loop(let params, let seeds, let body, let limit) = e {
    var bodyEnv = env
    for p in params { bodyEnv[p] = nil }
    // A replacement that mentions a param's name must not be captured by
    // it: rename that param to a name no row can spell before substituting.
    var incoming = NameSet()
    for x in bodyEnv.values {
      for v in freeVars(x) { incoming.insert(v) }
    }
    var renames: [String: Expr] = [:]
    var renamed: [String] = []
    for p in params {
      guard incoming.contains(p) else {
        renamed.append(p)
        continue
      }
      var fresh = "\(p).1"
      var k = 2
      while incoming.contains(fresh) || params.contains(fresh) {
        fresh = "\(p).\(k)"
        k += 1
      }
      renames[p] = .var(fresh)
      renamed.append(fresh)
    }
    let inner = renames.isEmpty ? body : substVars(body, renames)
    return .loop(
      params: renamed, seeds: seeds.map { substVars($0, env) }, body: substVars(inner, bodyEnv), limit: limit)
  }
  return mapChildren(e) { substVars($0, env) }
}

/// Names in the order they were first met, as a JavaScript `Set` keeps them:
/// "found b" in an error names the first stray variable the TypeScript walks
/// into, so the order is part of the answer.
public struct NameSet: Equatable, Sendable, Sequence {
  public private(set) var list: [String] = []
  private var members: Set<String> = []

  public init() {}

  public init<S: Sequence>(_ names: S) where S.Element == String {
    for name in names { insert(name) }
  }

  public var isEmpty: Bool { list.isEmpty }
  public var count: Int { list.count }
  public func contains(_ name: String) -> Bool { members.contains(name) }
  public func makeIterator() -> IndexingIterator<[String]> { list.makeIterator() }

  public mutating func insert(_ name: String) {
    if members.insert(name).inserted { list.append(name) }
  }

  /// Whether the name was there (JavaScript's `Set.delete`).
  @discardableResult public mutating func remove(_ name: String) -> Bool {
    guard members.remove(name) != nil else { return false }
    list.removeAll { $0 == name }
    return true
  }
}

/// The free variable names (not function names or constants), in the order
/// the TypeScript's `freeVars` meets them. What a node binds is not free in
/// it: a surviving Σ/Π's index, a template's column variables, a loop's params.
public func freeVars(_ e: Expr) -> NameSet {
  var out = NameSet()
  collectFreeVars(e, &out)
  return out
}

private func collectFreeVars(_ e: Expr, _ out: inout NameSet) {
  // (The plain kinds here, the binders apart: this walk is a frame per level of a row.)
  switch e {
  case .num, .str, .data, .text, .hist: break
  case .var(let name): out.insert(name)
  case .neg(let a): collectFreeVars(a, &out)
  case .bin(_, let a, let b, _):
    collectFreeVars(a, &out)
    collectFreeVars(b, &out)
  default: collectBoundFreeVars(e, &out)
  }
}

@inline(never)
private func collectBoundFreeVars(_ e: Expr, _ out: inout NameSet) {
  /// The names free in `parts` less those `bound` there, after what is in `out`.
  func scoped(_ parts: [Expr], binding bound: [String]) {
    var inner = NameSet()
    for part in parts { collectFreeVars(part, &inner) }
    for name in bound { inner.remove(name) }
    for v in inner { out.insert(v) }
  }
  switch e {
  case .num, .str, .data, .text:
    break
  case .var(let name):
    out.insert(name)
  case .call(_, let args):
    if let index = boundSumIndex(e) {
      collectFreeVars(args[1], &out)
      collectFreeVars(args[2], &out)
      scoped([args[3]], binding: [index])
    } else {
      for a in args { collectFreeVars(a, &out) }
    }
  case .figure(_, _, let vertices, let over?):
    // A template's column variables are bound by the template itself.
    scoped(vertices, binding: over.map(\.name))
  case .lazy(let cols, let body):
    scoped([body], binding: cols.map(\.name))
  case .loop(let params, let seeds, let body, _):
    for seed in seeds { collectFreeVars(seed, &out) }
    scoped([body], binding: params)
  case .neg, .bin, .index, .range, .eqtest, .eq, .ineq, .vec, .list, .piecewise, .comp, .figure, .trail, .label,
    .hist, .family:
    for child in childrenOf(e) { collectFreeVars(child, &out) }
  }
}

// MARK: - exprKey

/// `JSON.stringify` of the TypeScript's node (lib/expr.ts `exprKey`): the
/// stable spelling the compiler interns and compares expressions by. The
/// keys are in the order the TypeScript's node type declares them, which is
/// the order its constructors write them in.
public func exprKey(_ e: Expr) -> String {
  // (The kinds a row is mostly made of here, the rest in a function of their
  // own: a key is written by a frame per level of the row.)
  switch e {
  case .num(let value):
    return "{\"kind\":\"num\",\"value\":\(keyNumber(value))}"
  case .var(let name):
    return "{\"kind\":\"var\",\"name\":\(jsonString(name))}"
  case .bin(let op, let a, let b, let glyph):
    return keyOfBin(op, exprKey(a), exprKey(b), glyph)
  case .neg(let a):
    return "{\"kind\":\"neg\",\"a\":\(exprKey(a))}"
  case .call(let name, let args):
    return "{\"kind\":\"call\",\"name\":\(jsonString(name)),\"args\":\(keyList(args))}"
  default:
    return keyOfStructure(e)
  }
}

@inline(never)
private func keyOfBin(_ op: BinOp, _ a: String, _ b: String, _ glyph: ProductGlyph?) -> String {
  let tail = glyph.map { ",\"glyph\":\"\($0.rawValue)\"" } ?? ""
  return "{\"kind\":\"bin\",\"op\":\"\(op.rawValue)\",\"a\":\(a),\"b\":\(b)\(tail)}"
}

private func keyList(_ items: [Expr]) -> String {
  var out = "["
  for (k, item) in items.enumerated() {
    if k > 0 { out += "," }
    out += exprKey(item)
  }
  return out + "]"
}

private func keyNumber(_ value: Double) -> String { value.isFinite ? JS.string(value) : "null" }

/// A Float64Array, which JSON writes as an object keyed by index.
private func keyPacked(_ values: [Double]) -> String {
  "{" + values.enumerated().map { "\"\($0.offset)\":\(keyNumber($0.element))" }.joined(separator: ",") + "}"
}

private func keyColumns(_ cols: [Column]) -> String {
  "["
    + cols.map { "{\"name\":\(jsonString($0.name)),\"values\":\(keyPacked($0.values))}" }.joined(separator: ",")
    + "]"
}

@inline(never)
private func keyOfStructure(_ e: Expr) -> String {
  switch e {
  case .num, .var, .bin, .neg, .call:
    return exprKey(e)
  case .index(let a, let b):
    return "{\"kind\":\"index\",\"args\":\(keyList([a, b]))}"
  case .range(let a, let b):
    return "{\"kind\":\"range\",\"args\":\(keyList([a, b]))}"
  case .eqtest(let op, let a, let b):
    return "{\"kind\":\"eqtest\",\"op\":\"\(op.rawValue)\",\"args\":\(keyList([a, b]))}"
  case .eq(let l, let r):
    return "{\"kind\":\"eq\",\"l\":\(exprKey(l)),\"r\":\(exprKey(r))}"
  case .ineq(let op, let l, let r, let grouped):
    return "{\"kind\":\"ineq\",\"op\":\"\(op.rawValue)\",\"l\":\(exprKey(l)),\"r\":\(exprKey(r))"
      + (grouped ? ",\"grouped\":true}" : "}")
  case .vec(let items):
    return "{\"kind\":\"vec\",\"items\":\(keyList(items))}"
  case .list(let items):
    return "{\"kind\":\"list\",\"items\":\(keyList(items))}"
  case .str(let value):
    return "{\"kind\":\"str\",\"value\":\(jsonString(value))}"
  case .piecewise(let cases, let otherwise):
    let parts = cases.map {
      "{\"cond\":\(exprKey($0.cond)),\"value\":\(exprKey($0.value))" + ($0.bare ? ",\"bare\":true}" : "}")
    }
    return "{\"kind\":\"piecewise\",\"cases\":[\(parts.joined(separator: ","))]"
      + (otherwise.map { ",\"otherwise\":\(exprKey($0))}" } ?? "}")
  case .comp(let value, let index, let arity, let functionName):
    return "{\"kind\":\"comp\",\"value\":\(exprKey(value)),\"index\":\(index),\"arity\":\(arity)"
      + ",\"functionName\":\(jsonString(functionName))}"
  case .figure(let form, let dimension, let vertices, let over):
    return "{\"kind\":\"figure\",\"form\":\"\(form.rawValue)\",\"dimension\":\(dimension)"
      + ",\"vertices\":\(keyList(vertices))" + (over.map { ",\"over\":\(keyColumns($0))}" } ?? "}")
  case .trail(let coordinates):
    return "{\"kind\":\"trail\",\"coordinates\":\(keyList(coordinates))}"
  case .label(let coordinates, let text):
    return "{\"kind\":\"label\",\"coordinates\":\(keyList(coordinates)),\"text\":\(jsonString(text))}"
  case .hist(let centers, let counts, let width):
    return "{\"kind\":\"hist\",\"centers\":\(keyPacked(centers)),\"counts\":\(keyPacked(counts))"
      + ",\"width\":\(keyNumber(width))}"
  case .family(let members):
    return "{\"kind\":\"family\",\"members\":\(keyList(members))}"
  case .data(let values):
    return "{\"kind\":\"data\",\"values\":\(keyPacked(values))}"
  case .lazy(let cols, let body):
    return "{\"kind\":\"lazy\",\"cols\":\(keyColumns(cols)),\"body\":\(exprKey(body))}"
  case .text(let values):
    return "{\"kind\":\"text\",\"values\":[\(values.map(jsonString).joined(separator: ","))]}"
  case .loop(let params, let seeds, let body, let limit):
    return "{\"kind\":\"loop\",\"params\":[\(params.map(jsonString).joined(separator: ","))]"
      + ",\"seeds\":\(keyList(seeds)),\"body\":\(exprKey(body)),\"limit\":\(limit)}"
  }
}

/// Whether two trees have the same `exprKey`. That is equality, except that
/// JSON spells every non-finite number `null`, so NaN and ±∞ are one value
/// there (and -0 is 0, as it is to ==).
func sameExprKey(_ a: Expr, _ b: Expr) -> Bool {
  a == b || exprKey(a) == exprKey(b)
}

/// `JSON.stringify` of a string.
func jsonString(_ s: String) -> String {
  var out = "\""
  for u in s.unicodeScalars {
    switch u {
    case "\"": out += "\\\""
    case "\\": out += "\\\\"
    case "\u{08}": out += "\\b"
    case "\u{0C}": out += "\\f"
    case "\n": out += "\\n"
    case "\r": out += "\\r"
    case "\t": out += "\\t"
    default:
      if u.value < 0x20 {
        let hex = String(u.value, radix: 16)
        out += "\\u" + String(repeating: "0", count: 4 - hex.count) + hex
      } else {
        out.unicodeScalars.append(u)
      }
    }
  }
  return out + "\""
}
