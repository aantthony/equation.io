import Foundation
import Testing

@testable import EquationCore

/// Holds the Swift solvers (Solve.swift, Roots.swift) to the TypeScript ones
/// over the corpus apple/corpus/solve.ts records. Regenerate the fixture with
///
///   pnpm swift:solve-corpus
///
/// A case marked `exact` uses only arithmetic every IEEE machine computes
/// alike, and there the Swift must return the same doubles in the same order:
/// every seed, step and tie taken as the TypeScript takes it. Elsewhere the C
/// library and V8 may differ in a last place, so the same solutions are asked
/// for within a tolerance.
@Suite struct SolveConformance {
  let fixture: [String: Any]

  init() throws {
    let url = try #require(Bundle.module.url(forResource: "Fixtures/solve-corpus", withExtension: "json"))
    fixture = try #require(try JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any])
  }

  @Test func systems() throws {
    var failures: [String] = []
    let cases = fixture["solve"] as! [[String: Any]]
    for c in cases {
      let o = c["opts"] as! [String: Any]
      let opts = SolveOptions(
        env: (o["env"] as? [String: Any] ?? [:]).mapValues(number),
        margin: o["margin"].map(solveNumber) ?? 0.05,
        seeds: (o["seeds"] as? [[Any]] ?? []).map(numbers),
        lattice: o["lattice"] as? Bool ?? true,
        angular: o["angular"] as? [Bool] ?? [])
      let got = solveSystem(
        try exprs(c["residuals"]!), c["vars"] as! [String], numbers(c["lo"]!), numbers(c["hi"]!), opts,
        evaluate: evaluateForTests)
      let want = (c["result"] as! [[Any]]).map(numbers)
      if !same([got], [want], exact: c["exact"] as! Bool) {
        failures.append("\(c["src"]!)\n  want \(want)\n  got  \(got)")
      }
    }
    #expect(failures.isEmpty, "\(failures.count) of \(cases.count) differ:\n\(failures.joined(separator: "\n"))")
  }

  @Test func linear() throws {
    for c in fixture["linear"] as! [[String: Any]] {
      let J = (c["J"] as! [[Any]]).map(numbers)
      let b = numbers(c["b"]!)
      let got = solveLinear(J, b, b.count)
      let want = (c["result"] as? [Any]).map(numbers)
      #expect(got.map { [[$0]] } == want.map { [[$0]] }, "\(J) \(b)")
    }
  }

  @Test func traces() throws {
    var failures: [String] = []
    let cases = fixture["trace"] as! [[String: Any]]
    for c in cases {
      let got = traceSystem(
        try exprs(c["residuals"]!), c["vars"] as! [String], numbers(c["lo"]!), numbers(c["hi"]!),
        (c["env"] as! [String: Any]).mapValues(number), Int(solveNumber(c["samples"]!)), c["angular"] as! [Bool],
        evaluate: evaluateForTests)
      let want = (c["result"] as! [[[Any]]]).map { $0.map(numbers) }
      if !same(got, want, exact: c["exact"] as! Bool) {
        failures.append(
          "\(c["src"]!): want \(want.count) paths of \(want.map(\.count)), got \(got.count) of \(got.map(\.count))")
      }
    }
    #expect(failures.isEmpty, "\(failures.count) of \(cases.count) differ:\n\(failures.joined(separator: "\n"))")
  }

  @Test func numericRoots() throws {
    var failures: [String] = []
    let cases = fixture["roots"] as! [[String: Any]]
    for c in cases {
      let f = try decode(exactNumbers(c["f"]!))
      let got = findRoots(f, c["v"] as! String, solveNumber(c["lo"]!), solveNumber(c["hi"]!), evaluate: evaluateForTests)
      let want: FoundRoots =
        if let list = c["result"] as? [[String: Any]] {
          .roots(
            list.map {
              FoundRoot(x: solveNumber($0["x"]!), mult: Int(solveNumber($0["mult"]!)), exact: $0["exact"] as! Bool)
            })
        } else {
          .zero
        }
      var matches = got == want
      if !matches, c["exact"] as! Bool == false, case .roots(let g) = got, case .roots(let w) = want {
        matches =
          g.map(\.mult) == w.map(\.mult) && g.map(\.exact) == w.map(\.exact)
          && same([[g.map(\.x)]], [[w.map(\.x)]], exact: false)
      }
      if !matches { failures.append("\(c["src"]!)\n  want \(want)\n  got  \(got)") }
    }
    #expect(failures.isEmpty, "\(failures.count) of \(cases.count) differ:\n\(failures.joined(separator: "\n"))")
  }
}

/// The fixture's numbers are text (see exactNumbers).
private func solveNumber(_ json: Any) -> Double {
  switch json as! String {
  case "Infinity": .infinity
  case "-Infinity": -.infinity
  case "NaN": .nan
  case let text: Double(text)!
  }
}
private func numbers(_ json: Any) -> [Double] { (json as! [Any]).map(solveNumber) }
private func exprs(_ json: Any) throws -> [Expr] { try (json as! [Any]).map { try decode(exactNumbers($0)) } }

/// Paths of points: the same doubles, or (not `exact`) the same shape with
/// each coordinate within rounding of the TypeScript's.
private func same(_ a: [[[Double]]], _ b: [[[Double]]], exact: Bool) -> Bool {
  guard a.count == b.count else { return false }
  for (p, q) in zip(a, b) {
    guard p.count == q.count else { return false }
    for (u, v) in zip(p, q) {
      guard u.count == v.count else { return false }
      for (x, y) in zip(u, v) {
        if exact ? x.bitPattern != y.bitPattern : !(abs(x - y) <= 1e-9 * (1 + abs(y))) { return false }
      }
    }
  }
  return true
}

private struct EvaluationError: Error {
  var message: String
}

/// lib/expr.ts `evaluate`, as far as the corpus goes: the core's own
/// evaluator is being ported separately, and the solvers take theirs as an
/// argument. Arithmetic, comparisons and piecewise as the TypeScript has
/// them; the functions are Foundation's.
private func evaluateForTests(_ e: Expr, _ env: [String: Double]) throws -> Double {
  switch e {
  case .num(let value):
    return value
  case .var(let name):
    guard let value = env[name] else { throw EvaluationError(message: "Unbound variable: \(name)") }
    return value
  case .neg(let a):
    return -(try evaluateForTests(a, env))
  case .bin(let op, let l, let r, _):
    let a = try evaluateForTests(l, env)
    let b = try evaluateForTests(r, env)
    switch op {
    case .add: return a + b
    case .sub: return a - b
    case .mul: return a * b
    case .div: return a / b
    case .pow: return realPow(a, b)
    }
  case .call(let name, let arguments):
    let x = try arguments.map { try evaluateForTests($0, env) }
    switch (name, x.count) {
    case ("sqrt", 1): return x[0].squareRoot()
    case ("abs", 1): return abs(x[0])
    case ("floor", 1): return x[0].rounded(.down)
    case ("ceil", 1): return x[0].rounded(.up)
    case ("sign", 1): return x[0] > 0 ? 1 : x[0] < 0 ? -1 : x[0]
    case ("mod", 2): return x[0] - (x[0] / x[1]).rounded(.down) * x[1]
    case ("fract", 1): return x[0] - x[0].rounded(.down)
    // Math.min and Math.max: NaN if any argument is.
    case ("min", _): return x.contains(where: \.isNaN) ? .nan : x.min() ?? .infinity
    case ("max", _): return x.contains(where: \.isNaN) ? .nan : x.max() ?? -.infinity
    case ("sin", 1): return sin(x[0])
    case ("cos", 1): return cos(x[0])
    case ("tan", 1): return tan(x[0])
    case ("exp", 1): return exp(x[0])
    case ("ln", 1): return log(x[0])
    default: throw EvaluationError(message: "Unknown function: \(name)")
    }
  case .eq(let l, let r):
    return try evaluateForTests(l, env) - evaluateForTests(r, env)
  case .piecewise(let cases, let otherwise):
    for c in cases {
      // Chains nest left: 0 < y < x is ((0 < y) < x), and compares y with x.
      var chain: [(IneqOp, Expr, Expr)] = []
      var node = c.cond
      while case .ineq(let op, let l, let r, _) = node {
        chain.insert((op, l, r), at: 0)
        node = l
      }
      guard !chain.isEmpty else { throw EvaluationError(message: "Not a condition.") }
      var holds = true
      for (k, link) in chain.enumerated() where holds {
        let a = try evaluateForTests(k == 0 ? link.1 : chain[k - 1].2, env)
        let b = try evaluateForTests(link.2, env)
        switch link.0 {
        case .lt: holds = a < b
        case .le: holds = a <= b
        case .gt: holds = a > b
        case .ge: holds = a >= b
        }
      }
      if holds { return try evaluateForTests(c.value, env) }
    }
    return try otherwise.map { try evaluateForTests($0, env) } ?? .nan
  default:
    throw EvaluationError(message: "Not a scalar.")
  }
}

/// lib/expr.ts `realPow`: a negative base to a rational power of small odd denominator is real.
private func realPow(_ a: Double, _ b: Double) -> Double {
  if a >= 0 { return pow(a, b) }
  for q in 1...12 {
    let p = (b * Double(q) + 0.5).rounded(.down)
    var (x, y) = (abs(p), Double(q))
    while y != 0 { (x, y) = (y, x.truncatingRemainder(dividingBy: y)) }
    let g = x != 0 && !x.isNaN ? x : 1
    let (pr, qr) = (p / g, Double(q) / g)
    if abs(b - pr / qr) < 1e-6 {
      if qr.truncatingRemainder(dividingBy: 2) == 0 { return .nan }
      return (abs(pr).truncatingRemainder(dividingBy: 2) == 1 ? -1 : 1) * pow(-a, b)
    }
  }
  return .nan
}
