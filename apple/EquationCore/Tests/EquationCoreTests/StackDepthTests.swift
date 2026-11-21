import Foundation
import Testing

@testable import EquationCore

/// `body` on a thread with a stack of `size` bytes, and how many of them it
/// used: the stack is filled with a pattern first and read back afterwards.
/// A page below it is unmapped, so overrunning it stops the process as
/// overrunning any thread's stack does.
func stackUse(_ size: Int = 512 << 10, _ body: @escaping @Sendable () -> Void) -> Int {
  let page = Int(getpagesize())
  let total = size + page
  let memory = mmap(nil, total, PROT_READ | PROT_WRITE, MAP_PRIVATE | MAP_ANON, -1, 0)!
  precondition(memory != MAP_FAILED)
  mprotect(memory, page, PROT_NONE)
  let stack = memory + page
  memset(stack, 0xA5, size)
  var attributes = pthread_attr_t()
  pthread_attr_init(&attributes)
  pthread_attr_setstack(&attributes, stack, size)
  final class Body {
    let run: () -> Void
    init(_ run: @escaping () -> Void) { self.run = run }
  }
  var thread: pthread_t?
  pthread_create(
    &thread, &attributes,
    { argument in
      Unmanaged<Body>.fromOpaque(argument).takeRetainedValue().run()
      return nil
    }, Unmanaged.passRetained(Body(body)).toOpaque())
  pthread_join(thread!, nil)
  pthread_attr_destroy(&attributes)
  let bytes = stack.assumingMemoryBound(to: UInt8.self)
  var untouched = 0
  while untouched < size, bytes[untouched] == 0xA5 { untouched += 1 }
  munmap(memory, total)
  return size - untouched
}

/// The smallest stack a thread has: a secondary thread's, on every Apple platform.
private let smallestStack = 512 << 10

private func terms(_ n: Int, _ term: (Int) -> String, _ separator: String = " + ") -> String {
  (1...n).map(term).joined(separator: separator)
}

private func nested(_ n: Int, _ open: String, _ inner: String, _ close: String) -> String {
  String(repeating: open, count: n) + inner + String(repeating: close, count: n)
}

/// A chain of `n` definitions, each reading the one before, then a row that
/// reads the last — or all of that last row first.
private func chain(_ n: Int, first: String, _ link: (Int) -> String, last: String, reversed: Bool = false) -> [String] {
  let rows = [first] + (1...n).map(link) + [last]
  return reversed ? rows.reversed() : rows
}

/// Rows whose expressions are `n` deep, by shape: each walks the language a
/// different way down. `most`: the deepest worth asking for, where another
/// limit of the site's answers first (a Σ expands to 500 terms at most).
private let deepShapes: [(name: String, most: Int, rows: @Sendable (Int) -> [String])] = [
  ("sum", 640, { n in ["y = " + terms(n) { "sin(\($0) x)" }] }),
  ("d/dx sum", 640, { n in ["y = d/dx (" + terms(n) { "sin(\($0) x)" } + ")"] }),
  ("d/dx product", 640, { n in ["y = d/dx (" + terms(n, { "sin(\($0) x)" }, " ") + ")"] }),
  ("nested", 640, { n in ["y = " + nested(n, "sin(", "x", ")")] }),
  ("d/dx nested", 640, { n in ["y = d/dx " + nested(n, "sin(", "x", ")")] }),
  ("power", 640, { n in ["y = " + terms(n, { _ in "x" }, "^")] }),
  ("numbers", 640, { n in [terms(n, String.init)] }),
  ("constant", 640, { n in ["a = " + terms(n) { "sin(\($0))" }, "y = a x"] }),
  ("implicit", 640, { n in [terms(n) { "sin(\($0) x y)" } + " = 1"] }),
  ("region", 640, { n in ["y < " + terms(n) { "sin(\($0) x)" }] }),
  ("surface", 640, { n in ["z = " + terms(n) { "sin(\($0) x y)" }] }),
  ("sigma", 500, { n in ["y = sum(k=1..\(n), sin(k x))"] }),
  ("composed", 640, { n in ["f(x) = sin(x) + 1", "y = " + nested(n, "f(", "x", ")")] }),
  ("list", 640, { n in ["[1, 2, 3] + " + terms(n) { "sin(\($0))" }] }),
  ("points", 640, { n in ["A = (1, 2)", terms(n) { _ in "A" }] }),
  ("curve", 640, { n in ["(" + terms(n) { "sin(\($0) t)" } + ", cos(t))"] }),
  ("cases", 640, { n in ["y = " + nested(n, "{x > 1: ", "x", ", 0}")] }),
  ("complex", 640, { n in ["z = " + terms(n) { "e^(\($0) i)" }, "|z| x"] }),
  ("field", 640, { n in ["r = " + terms(n) { "sin(\($0) x)" }, "r = 1"] }),
  ("quadrature", 1, { _ in ["a = interval(1, 2)", "y = int[0..x] a q dq"] }),
]

/// Deep rows of the kinds a plain row's passes do not reach: matrices and
/// tensors, the algebras, integrals, systems, complex numbers, intervals,
/// random variables, sequences, states, the views that map a panel.
private let passShapes: [(name: String, most: Int, rows: @Sendable (Int) -> [String])] = [
  ("multivector", 640, { n in [terms(n) { "\($0) e_x" } + " + e_xy"] }),
  ("matrix", 640, { n in ["M = ((1, 2), (3, 4))", "(" + terms(n) { _ in "M" } + ") (1, 1)"] }),
  ("matrix product", 640, { n in ["M = ((1, 2), (3, 4))", terms(n, { _ in "M" }, " ") + " (1, 1)"] }),
  ("integral", 640, { n in ["int[0..1] (" + terms(n) { "sin(\($0) x)" } + ") dx"] }),
  ("area", 640, { n in ["y = int[0..x] (" + terms(n) { "sin(\($0) q)" } + ") dq"] }),
  ("system", 640, { n in ["(" + terms(n) { "sin(\($0) x)" } + " + y, y - x) = (0, 0)"] }),
  ("complex curve", 640, { n in ["y = re(" + terms(n) { "e^(\($0) i x)" } + ")"] }),
  ("complex map", 640, { n in ["w^2 + " + terms(n) { "\($0) w" } + " = 1"] }),
  ("interval", 640, { n in ["a = interval(0, 1)", "y = " + terms(n) { "a sin(\($0) x)" }] }),
  ("random variable", 640, { n in ["X ~ Normal(0, 1)", "E(" + terms(n) { "sin(\($0) X)" } + ")"] }),
  ("density", 640, { n in ["X ~ Uniform(0, 1)", terms(n) { _ in "X" }] }),
  ("sequence", 640, { n in ["a_n = " + terms(n) { "sin(\($0) n)" }] }),
  ("recurrence rule", 640, { n in ["a_1 = 1", "a_{n+1} = " + terms(n) { "sin(\($0) a_n)" }] }),
  ("state", 640, { n in ["s' = " + terms(n) { "sin(\($0) s)" }, "s(0) = 1", "s", "(t, s)"] }),
  ("count", 640, { n in ["count({" + terms(n) { "sin(\($0) x)" } + " > 0, 0 < x < 1})"] }),
  ("implicit surface", 640, { n in [terms(n) { "sin(\($0) x y z)" } + " = 1"] }),
  ("vector field", 640, { n in ["(" + terms(n) { "sin(\($0) y)" } + ", x)"] }),
  ("space curve", 640, { n in ["(" + terms(n) { "sin(\($0) u)" } + ", cos(u), u)"] }),
  ("parametric surface", 640, { n in ["(u, v, " + terms(n) { "sin(\($0) u v)" } + ")"] }),
  ("polygon", 640, { n in ["polygon((0, 0), (1, 0), (" + terms(n) { "sin(\($0) t)" } + ", 1))"] }),
  ("orbit", 640, { n in ["s' = -s", "s(0) = 1", "(" + terms(n) { "sin(\($0) s)" } + ")(0..1)"] }),
  ("mapped view", 640, { n in ["view(x = 10^X)", "y = " + terms(n) { "sin(\($0) x)" }] }),
  ("plane map", 640, { n in ["view((x, y) = (Y cos(X), Y sin(X)))", "y = " + terms(n) { "sin(\($0) x)" }] }),
  ("fit", 640, { n in ["X = [1, 2, 3]", "Y = [2, 4, 7]", "Y ~ a X + " + terms(n) { "sin(\($0))" }] }),
  ("list of curves", 640, { n in ["y = [1, 2] x + " + terms(n) { "sin(\($0) x)" }] }),
  ("lattice", 640, { n in ["c_0[i] = {i = 0: 1, 0}", "c_{n+1}[i] = mod(" + terms(n) { _ in "c_n[i-1]" } + ", 2)"] }),
  ("graph", 640, { n in ["graph(1, 2, " + terms(n) { "sin(\($0))" } + ")"] }),
  ("condition", 640, { n in ["within = " + terms(n) { "sin(\($0) x)" } + " > 0", "y = {within: 1}"] }),
  ("tensor", 640, { n in ["T = ((1, 2, 3), (4, 5, 6))", terms(n) { _ in "T" }] }),
  ("point list", 640, { n in ["P = [(1, 2), (3, 4)]", terms(n) { _ in "P" }] }),
  ("surface panel", 640, { n in
    ["on((X, Y, Z) = (x, y, x y), x = -1..1, y = -1..1)", "y = " + terms(n) { "sin(\($0) x)" }]
  }),
]

/// Documents of `n` definitions, each reading the one before: read one inside
/// the next, or one written into the next.
private let chainShapes: [(name: String, rows: @Sendable (Int) -> [String])] = [
  ("constants", { n in chain(n, first: "a0 = 1", { "a\($0) = a\($0 - 1) + 1" }, last: "y = a\(n) x") }),
  (
    "constants, last first",
    { n in chain(n, first: "a0 = 1", { "a\($0) = a\($0 - 1) + 1" }, last: "y = a\(n) x", reversed: true) }
  ),
  ("fields", { n in chain(n, first: "f0 = x", { "f\($0) = f\($0 - 1) + 1" }, last: "y = f\(n)") }),
  (
    "fields, last first",
    { n in chain(n, first: "f0 = x", { "f\($0) = f\($0 - 1) + 1" }, last: "y = f\(n)", reversed: true) }
  ),
  (
    "functions",
    { n in chain(n, first: "g0(x) = x", { "g\($0)(x) = g\($0 - 1)(x) + 1" }, last: "y = g\(n)(x)") }
  ),
  (
    "functions, last first",
    { n in chain(n, first: "g0(x) = x", { "g\($0)(x) = g\($0 - 1)(x) + 1" }, last: "y = g\(n)(x)", reversed: true) }
  ),
  ("points", { n in chain(n, first: "A0 = (1, 2)", { "A\($0) = A\($0 - 1) + (1, 0)" }, last: "A\(n)") }),
  ("recurrence", { n in ["a_1 = 1", "a_{n+1} = a_n + 1/n", "a_\(n)"] }),
]

private final class Answer<T>: @unchecked Sendable {
  var value: T
  init(_ value: T) { self.value = value }
}

/// What each row of the rows says is wrong with it, read on a stack of `size` bytes.
private func errors(_ rows: [String], on size: Int) -> [String?] {
  let answer = Answer<[String?]>([])
  _ = stackUse(size) { answer.value = analyze(rows).rows.map(\.error) }
  return answer.value
}

/// A thread's depth limit, on a stack of `size` bytes.
private func depthLimit(on size: Int) -> Int {
  let answer = Answer(0)
  _ = stackUse(size) { answer.value = maxExprDepth }
  return answer.value
}

private func probing() -> Bool { ProcessInfo.processInfo.environment["STACK_PROBE"] != nil }

private func padded(_ name: String) -> String { name.padding(toLength: 24, withPad: " ", startingAt: 0) }

/// The depth guard (Depth.swift), measured: `swift test` holds the debug
/// build's limit to a debug build's frames, and
/// `swift test -c release -Xswiftc -enable-testing --filter StackDepth` the
/// optimized build's to its own. STACK_PROBE=1 prints what was measured.
@Suite struct StackDepth {
  /// The deepest row of each shape the guard lets through is analyzed —
  /// resolved, lowered, differentiated, compiled, read out — within the
  /// stack of the thread it is read on, with a quarter of it to spare: the
  /// smallest a thread has, a main thread's megabyte, and a deep one.
  @Test(arguments: [smallestStack, 1 << 20, 8 << 20])
  func theDeepestRowsFitTheirStack(stack: Int) {
    if probing() { print("  on \(stack >> 10) KB, \(depthLimit(on: stack)) levels:") }
    // (Every pass on the smallest stack; the plain shapes on the larger ones too, where the limit is deeper.)
    for (name, most, rows) in stack == smallestStack ? deepShapes + passShapes : deepShapes {
      // The deepest n that is not refused.
      func refused(_ n: Int) -> Bool { errors(rows(n), on: stack).contains(stackExceeded) }
      var (fits, over) = (1, most)
      if !refused(over) { fits = over }
      while over - fits > 1 {
        let middle = (fits + over) / 2
        if refused(middle) { over = middle } else { fits = middle }
      }
      let deepest = rows(fits)
      let used = stackUse(stack) { _ = analyze(deepest) }
      if probing() { print("  \(padded(name)) n = \(fits): \(used >> 10) KB") }
      #expect(used < stack * 3 / 4, "\(name), n = \(fits), uses \(used >> 10) KB of \(stack >> 10)")
    }
  }

  /// An optimized build reads 512 levels on any thread; a debug build, whose
  /// frames are several times larger, as many as the thread's stack holds.
  @Test func theLimitIsTheThreads() {
    #expect(depthLimit(on: 64 << 20) == 512)
    #if DEBUG
      #expect(depthLimit(on: smallestStack) == 100)
      #expect(depthLimit(on: 1 << 20) == 209)
    #else
      #expect(depthLimit(on: smallestStack) == 512)
    #endif
  }

  /// A row far deeper than any walk could go down says so in the site's
  /// words — the engine's, where a stack runs out there — on the smallest
  /// stack, and nothing else in the document is the worse for it.
  @Test func rowsTooDeepSaySo() {
    for (name, most, rows) in deepShapes where most == 640 {
      let document = rows(20_000) + ["y = x"]
      let answer = Answer<[RowAnalysis]>([])
      let used = stackUse(smallestStack) { answer.value = analyze(document).rows }
      #expect(answer.value.contains { $0.error == stackExceeded }, "\(name)")
      #expect(answer.value.last?.error == nil && answer.value.last?.cpu != nil, "\(name)")
      #expect(used < smallestStack * 3 / 4, "\(name) uses \(used >> 10) KB of stack")
    }
  }

  /// A thousand definitions in a chain are read on the smallest stack: what
  /// is read one after the other costs none of it, and what must be read
  /// one inside the other is refused past a depth.
  @Test func chainsOfDefinitions() {
    for (name, rows) in chainShapes {
      let document = rows(1000)
      let answer = Answer<[RowAnalysis]>([])
      let used = stackUse(smallestStack) { answer.value = analyze(document).rows }
      let refused = answer.value.filter { $0.error != nil }.count
      if probing() { print("  \(padded(name)) \(used >> 10) KB, \(refused) rows with an error") }
      #expect(answer.value.count == document.count, "\(name)")
      #expect(used < smallestStack * 3 / 4, "\(name) uses \(used >> 10) KB of stack")
    }
  }

  /// Parentheses nest no expression: twenty thousand around an x are an x, as on the site.
  @Test func parenthesesAreNotDepth() {
    let answer = Answer<RowAnalysis?>(nil)
    _ = stackUse(smallestStack) { answer.value = analyze(["y = " + nested(20_000, "(", "x", ")")]).rows[0] }
    #expect(answer.value?.error == nil)
    #expect(answer.value?.cpu == analyze(["y = x"]).rows[0].cpu)
  }

  /// `diff` itself, on the deepest expressions the guard allows and past
  /// them: a derivative of each, or the engine's words, never a stack overrun.
  @Test func derivativesOfDeepExpressions() throws {
    let limit = depthLimit(on: smallestStack)
    let x = Expr.var("x")
    @Sendable func deep(_ n: Int, _ step: (Expr, Int) -> Expr) -> Expr { (1...n).reduce(x) { step($0, $1) } }
    let shapes: [(String, @Sendable (Int) -> Expr)] = [
      ("sum", { n in deep(n) { .bin(.add, $0, .call("sin", [.bin(.mul, .num(Double($1)), x)])) } }),
      ("product", { n in deep(n) { e, _ in .bin(.mul, e, .call("sin", [x])) } }),
      ("quotient", { n in deep(n) { e, _ in .bin(.div, e, .call("cos", [x])) } }),
      ("power", { n in deep(n) { e, _ in .bin(.pow, x, e) } }),
      ("nested", { n in deep(n) { e, _ in .call("sin", [e]) } }),
      (
        "cases",
        { n in deep(n) { e, _ in .piecewise([.init(cond: .ineq(.gt, x, .num(0)), value: e)], otherwise: x) } }
      ),
    ]
    for (name, make) in shapes {
      for depth in [limit / 6, limit - 8, limit + 8] {
        let outcome = Answer<String>("")
        let used = stackUse(smallestStack) {
          do {
            let d = try diff(make(depth), "x")
            outcome.value = exceedsDepth(d) ? "too deep" : "a derivative"
          } catch let error as DiffError {
            outcome.value = error.message
          } catch {
            outcome.value = "\(error)"
          }
        }
        if probing() { print("  d/dx \(padded(name)) \(depth) deep: \(outcome.value), \(used >> 10) KB") }
        #expect(
          outcome.value == "a derivative" || outcome.value == stackExceeded, "\(name) \(depth): \(outcome.value)")
        #expect(used < smallestStack * 3 / 4, "\(name), \(depth) deep, uses \(used >> 10) KB of stack")
      }
    }
  }

  /// What a level of depth costs each shape's walk (STACK_PROBE=1 only): how
  /// much more stack `analyze` uses for 60 levels than for 30.
  @Test func bytesPerLevel() {
    guard probing() else { return }
    for (name, most, rows) in deepShapes where most > 1 {
      let (low, high) = (30, 60)
      let a = stackUse(8 << 20) { _ = analyze(rows(low)) }
      let b = stackUse(8 << 20) { _ = analyze(rows(high)) }
      let each = (b - a) / (high - low)
      print("  \(padded(name)) \(a >> 10) KB at \(low), \(b >> 10) KB at \(high): \(each) bytes a level")
    }
  }
}
