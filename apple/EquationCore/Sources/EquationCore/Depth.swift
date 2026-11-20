/// How deep an expression may nest (port only).
///
/// The language's walks are recursive, here as on the site: resolving,
/// lowering, differentiating, compiling and evaluating a row each take a
/// frame or a few per level of its expression. The site has no limit of its
/// own; past what its engine's stack holds a row's error is the engine's,
/// "Maximum call stack size exceeded" (a sum of 2,000 terms written out
/// still draws there, one of 5,000 says that). A thread here has no such
/// net: running off its stack stops the app. So an expression is measured
/// where it is made — by the parser, by a function call's inlining, a
/// derivative, a Σ written out, a definition — and one deeper than
/// `maxExprDepth` is refused in the engine's words before anything walks it —
/// and, where what is made could be several times deeper than what it is
/// made of (a derivative, a function's body around its arguments), before it
/// is made: letting go of a tree is a frame per level as well.
///
/// The limit is a number of levels, not a number of bytes left on this
/// thread's stack, so that a document reads the same wherever it is read:
/// plans made on one thread are evaluated on others, the smallest of which
/// has 512 KB. It is what a 512 KB stack holds of the deepest walk's frames,
/// measured (StackDepthTests) with room to spare, and so it differs between
/// an optimized build and a debug one, whose frames are several times larger.

/// What a row too deep to walk says: the JavaScript engines' own words, which
/// are the site's error for it.
let stackExceeded = "Maximum call stack size exceeded"

/// The deepest an expression may nest.
#if DEBUG
  public let maxExprDepth = 96
#else
  public let maxExprDepth = 512
#endif

/// How many definitions may be read one inside another: a function whose
/// body calls one defined below it, which calls one below that. Each is a
/// run of the parser's and the resolver's frames — some 6 KB in a debug
/// build, 4 KB in an optimized one — whatever its own depth.
let maxDefinitionNesting = 32

/// Whether `e` nests deeper than `limit`, found over a stack of its own:
/// this is what is asked before anything recursive may be.
func exceedsDepth(_ e: Expr, _ limit: Int = maxExprDepth) -> Bool {
  // (A leaf is its own answer; most of what is asked is small.)
  switch e {
  case .num, .var, .str, .data, .text, .hist: return false
  default: break
  }
  var pending: [(Expr, Int)] = [(e, 1)]
  // A tree whose branches are shared — a function's argument written into
  // its body many times over — is walked once per path: past a million
  // nodes its size is the trouble, which the site's node limits speak to.
  var visited = 0
  while let (node, depth) = pending.popLast() {
    if depth > limit { return true }
    visited += 1
    if visited > 1 << 20 { return false }
    switch node {
    case .num, .var, .str, .data, .text, .hist: continue
    case .neg(let a): pending.append((a, depth + 1))
    case .bin(_, let a, let b, _):
      pending.append((a, depth + 1))
      pending.append((b, depth + 1))
    default:
      for child in childrenOf(node) { pending.append((child, depth + 1)) }
    }
  }
  return false
}

/// How deep `e` nests, counted no further than `cap` + 1.
func exprDepth(_ e: Expr, upTo cap: Int = maxExprDepth) -> Int {
  var deepest = 0
  var pending: [(Expr, Int)] = [(e, 1)]
  var visited = 0
  while let (node, depth) = pending.popLast() {
    deepest = max(deepest, depth)
    visited += 1
    if depth > cap || visited > 1 << 20 { break }
    for child in childrenOf(node) { pending.append((child, depth + 1)) }
  }
  return deepest
}

/// Whether `body` with the names of `env` replaced by their expressions
/// would nest deeper than the limit — asked before the tree is made, since
/// a tree far deeper than the limit cannot even be let go of: releasing one
/// is a frame per level too. (A name the body binds over again is counted
/// as replaced: the answer errs toward refusing.)
func substitutionExceedsDepth(_ body: Expr, _ env: [String: Expr], _ limit: Int = maxExprDepth) -> Bool {
  var depths: [String: Int] = [:]
  var pending: [(Expr, Int)] = [(body, 1)]
  var visited = 0
  while let (node, depth) = pending.popLast() {
    if depth > limit { return true }
    visited += 1
    if visited > 1 << 20 { return false }
    if case .var(let name) = node, let replacement = env[name] {
      let within = depths[name] ?? exprDepth(replacement, upTo: limit)
      depths[name] = within
      if depth - 1 + within > limit { return true }
      continue
    }
    for child in childrenOf(node) { pending.append((child, depth + 1)) }
  }
  return false
}

/// Whether the derivative of `e` may nest deeper than the limit: an upper
/// bound, from what each rule of `diff` puts above the derivatives of its
/// operands (a sum one level, a product two, a quotient three, a power or a
/// call of several arguments five), asked before the derivative is made.
func derivativeMayExceedDepth(_ e: Expr, _ limit: Int = maxExprDepth) -> Bool {
  var pending: [(Expr, Int, Int)] = [(e, 1, 0)]
  var visited = 0
  while let (node, depth, above) = pending.popLast() {
    // (A rule also writes its operands in beside their derivatives, a few levels down.)
    if above + 1 > limit || depth + 5 > limit { return true }
    visited += 1
    if visited > 1 << 20 { return false }
    let adds: Int
    switch node {
    case .num, .var, .str, .data, .text, .hist: continue
    case .bin(let op, _, _, _):
      switch op {
      case .add, .sub: adds = 1
      case .mul: adds = 2
      case .div: adds = 3
      case .pow: adds = 5
      }
    case .call(_, let args): adds = args.count == 1 ? 2 : 5
    default: adds = 1
    }
    for child in childrenOf(node) { pending.append((child, depth + 1, above + adds)) }
  }
  return false
}

/// `e`, or the engine's error for one too deep to walk.
@discardableResult
func notTooDeep(_ e: Expr) throws(LanguageError) -> Expr {
  if exceedsDepth(e) { throw LanguageError(stackExceeded) }
  return e
}
