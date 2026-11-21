#if canImport(Darwin)
  import Darwin
#endif

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
/// The limit is a number of levels: 512, which holds the longest Σ the
/// language expands (500 terms) — or fewer on a thread whose stack would not
/// hold that many of the deepest walk's frames. Those are measured
/// (StackDepthTests), with room to spare: an optimized build's fit the
/// smallest stack a thread has, 512 KB, so there the limit is 512 wherever a
/// document is read; a debug build's are several times larger, and a 512 KB
/// thread reads 100 levels, a main thread's megabyte 209, and 512 only on a
/// thread made with a deep stack, as the app makes one (DeepStack). What is
/// read on such a thread is to be evaluated on one: a plan's expression is
/// as deep as its row's.

/// What a row too deep to walk says: the JavaScript engines' own words, which
/// are the site's error for it.
let stackExceeded = "Maximum call stack size exceeded"

/// The deepest an expression may nest, on this thread.
public var maxExprDepth: Int {
  #if canImport(Darwin)
    let stack = Int(pthread_get_stacksize_np(pthread_self()))
    return min(deepestExpr, max(16, (stack * 3 / 4 - stackReserve) / stackBytesPerLevel))
  #else
    // (WebAssembly: the linear memory's stack, 1 MB by default, and a trap, not a crash, past it.)
    return deepestExpr
  #endif
}

/// The deepest any thread reads: past the longest Σ (500 terms, a level each).
private let deepestExpr = 512
/// What a walk holds whatever the row's depth: the document's own frames.
/// (A quarter of the stack is left alone besides, for the caller's.)
private let stackReserve = 32 << 10
/// What a level of the deepest walk costs: measured at 3.6 KB in a debug
/// build (a list beside a deep sum) and 0.45 KB in an optimized one (calls
/// nested in calls), by StackDepthTests. The optimized figure is set half as
/// large again: what gives the smallest stack its 512 levels, and no more.
#if DEBUG
  private let stackBytesPerLevel = 3600
#else
  private let stackBytesPerLevel = 680
#endif

/// How many definitions may be read one inside another: a function whose
/// body calls one defined below it, which calls one below that. Each is a
/// run of the parser's and the resolver's frames — some 6 KB in a debug
/// build, 4 KB in an optimized one — whatever its own depth.
let maxDefinitionNesting = 32

/// Whether `e` nests deeper than `limit`, found over a stack of its own:
/// this is what is asked before anything recursive may be.
@inline(never)
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
@inline(never)
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
@inline(never)
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
@inline(never)
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
@inline(never)
@discardableResult
func notTooDeep(_ e: Expr) throws(LanguageError) -> Expr {
  if exceedsDepth(e) { throw LanguageError(stackExceeded) }
  return e
}
