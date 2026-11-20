import Foundation
import Testing

@testable import EquationCore

/// Holds the port's exact arithmetic to JavaScript's: BigInt.swift to BigInt
/// itself, and Poly.swift to lib/poly.ts, over what apple/corpus/exact.ts
/// records. Regenerate the fixture with
///
///   pnpm swift:exact-corpus
///
/// Integers must agree to the digit. A root's value is the same double,
/// except where a coefficient came through the C library (sin(3)): there the
/// last places may differ.
@Suite struct ExactConformance {
  let corpus: [String: Any]

  init() throws {
    corpus = try #require(try fixture("exact-corpus") as? [String: Any])
  }

  private func big(_ json: Any?) -> BigInt { BigInt(json as! String)! }

  @Test func integersOneAtATime() throws {
    var failures: [String] = []
    func check(_ what: String, _ a: String, _ got: String, _ want: Any?) {
      let wanted = want as? String ?? "\(want ?? "nil")"
      if got != wanted { failures.append("\(what) of \(a): got \(got), want \(wanted)") }
    }
    for c in corpus["unary"] as! [[String: Any]] {
      let text = c["a"] as! String
      let a = big(text)
      check("description", text, "\(a)", text)
      check("neg", text, "\(-a)", c["neg"])
      let n = exactNumber(c["number"]!)
      if a.double != n { failures.append("Number(\(text)): got \(a.double), want \(n)") }
      check("bits", text, "\(max(1, a.bitWidth))", c["bits"] as! String)
      for pair in c["shl"] as! [[Any]] { check("<< \(pair[0])", text, "\(a << Int(pair[0] as! String)!)", pair[1]) }
      for pair in c["shr"] as! [[Any]] { check(">> \(pair[0])", text, "\(a >> Int(pair[0] as! String)!)", pair[1]) }
      for pair in c["pow"] as! [[Any]] { check("** \(pair[0])", text, "\(a.power(Int(pair[0] as! String)!))", pair[1]) }
      if let root = c["isqrt"] as? String { check("isqrt", text, "\(isqrt(a))", root) }
      check("odd", text, "\(a.isOdd)", "\(c["odd"] as! Bool)")
      if let small = Int(text) { check("int", text, "\(a.int.map(String.init) ?? "nil")", "\(small)") }
      if a != BigInt(text)! || a.hashValue != BigInt(text)!.hashValue { failures.append("\(text) is not itself") }
    }
    #expect(failures.isEmpty, "\(failures.count) differ:\n\(failures.prefix(20).joined(separator: "\n"))")
  }

  @Test func integersInPairs() throws {
    var failures: [String] = []
    let cases = corpus["binary"] as! [[String: Any]]
    for c in cases {
      let (x, y) = (c["a"] as! String, c["b"] as! String)
      let (a, b) = (big(x), big(y))
      func check(_ op: String, _ got: BigInt?, _ want: Any?) {
        let wanted = want as? String
        if got.map({ "\($0)" }) != wanted {
          failures.append("\(x) \(op) \(y): got \(got.map { "\($0)" } ?? "nil"), want \(wanted ?? "nil")")
        }
      }
      check("+", a + b, c["add"])
      check("-", a - b, c["sub"])
      check("*", a * b, c["mul"])
      check("/", b.isZero ? nil : a / b, c["div"])
      check("%", b.isZero ? nil : a % b, c["mod"])
      let cmp = a < b ? -1 : a > b ? 1 : 0
      if "\(cmp)" != c["cmp"] as! String { failures.append("\(x) <=> \(y): got \(cmp)") }
      if (a == b) != (cmp == 0) { failures.append("\(x) == \(y)") }
      if let reduced = c["frac"] as? [String] {
        let f = frac(a, b)
        check("frac n", f.n, reduced[0])
        check("frac d", f.d, reduced[1])
      }
    }
    #expect(failures.isEmpty, "\(failures.count) of \(cases.count) differ:\n\(failures.prefix(20).joined(separator: "\n"))")
  }

  @Test func integersAndDoubles() throws {
    var failures: [String] = []
    for c in corpus["numbers"] as! [[String: Any]] {
      let a = big(c["a"])
      let want = exactNumber(c["number"]!)
      if a.double != want { failures.append("Number(\(a)): got \(a.double), want \(want)") }
    }
    for c in corpus["fromDouble"] as! [[String: Any]] {
      let v = exactNumber(c["v"]!)
      let got = BigInt(exactly: v)
      if got.map({ "\($0)" }) != c["big"] as? String {
        failures.append("BigInt(\(v)): got \(String(describing: got)), want \(c["big"]!)")
      }
    }
    #expect(BigInt(exactly: 0.5) == nil)
    #expect(BigInt(exactly: .infinity) == nil)
    #expect(BigInt("12a") == nil && BigInt("") == nil && BigInt("-") == nil)
    #expect(failures.isEmpty, "\(failures.count) differ:\n\(failures.prefix(20).joined(separator: "\n"))")
  }

  // MARK: Polynomials

  private func spell(_ p: FPoly) -> [String] { p.map { "\($0.n)/\($0.d)" } }

  private func poly(_ json: Any?) -> FPoly {
    (json as! [String]).map { text in
      let parts = text.split(separator: "/")
      return Frac(n: BigInt(String(parts[0]))!, d: BigInt(String(parts[1]))!)
    }
  }

  /// Whether the expression's constants are the same doubles on both sides.
  private func exactConstants(_ e: Expr) -> Bool {
    if case .call = e { return false }
    return childrenOf(e).allSatisfy(exactConstants)
  }

  @Test func polynomials() throws {
    var failures: [String] = []
    let cases = corpus["polys"] as! [[String: Any]]
    for c in cases {
      let src = c["src"] as! String
      let e = try decode(c["e"]!)
      let exact = exactConstants(e)
      func differ(_ what: String, _ got: Any?, _ want: Any?) {
        failures.append("\(src), \(what): got \(got.map { "\($0)" } ?? "nil"), want \(want.map { "\($0)" } ?? "nil")")
      }
      let p = exprToPoly(e, "x")
      let wantPoly = c["poly"] as? [String]
      if exact {
        if p.map(spell) != wantPoly { differ("coefficients", p.map(spell), wantPoly) }
        if let p, spell(primitive(p)) != c["primitive"] as? [String] ?? [] {
          differ("primitive part", spell(primitive(p)), c["primitive"])
        }
      } else if (p == nil) != (wantPoly == nil) || p?.count != wantPoly?.count {
        differ("degree", p?.count, wantPoly?.count)
      }
      if exact, let p, p.count > 1 {
        let factors = try squareFree(primitive(p))
        let wanted = c["factors"] as! [[String: Any]]
        let got = factors.map { "\(spell($0.p))^\($0.mult)" }
        let want = wanted.map { "\($0["p"] as! [String])^\($0["mult"] as! String)" }
        if got != want { differ("square-free factors", got, want) }
        let real = factors.map { realRootsSquareFree($0.p.map(\.n)) }
        let wantReal = (c["real"] as! [[Any]]).map { $0.map(exactNumber) }
        if real != wantReal { differ("real roots", real, wantReal) }
      }
      // The multiset of roots, with its labels.
      let roots = polynomialRoots(e, "x")
      if let text = c["roots"] as? String {
        if text != "zero" || roots != .zero { differ("roots", roots, text) }
      } else if let list = c["roots"] as? [[String: Any]] {
        let want = list.map {
          PolyRoot(
            x: exactNumber($0["x"]!), mult: Int($0["mult"] as! String)!, sym: $0["sym"] as? String,
            rootOf: $0["rootOf"] as? String)
        }
        guard case .roots(let got)? = roots else {
          differ("roots", roots, want)
          continue
        }
        let same =
          exact
          ? got == want
          : got.count == want.count
            && zip(got, want).allSatisfy {
              close($0.x, $1.x) && $0.mult == $1.mult && $0.sym == $1.sym && $0.rootOf == $1.rootOf
            }
        if !same { differ("roots", got, want) }
      } else if roots != nil {
        differ("roots", roots, "none")
      }
      // The same polynomial in w, with its complex roots' labels.
      let labels = complexRootLabels(try decode(c["w"]!))
      if let want = c["complex"] as? [String: Any] {
        let wantRoots = (want["roots"] as! [[String: Any]]).map {
          ComplexRootLabel(re: exactNumber($0["re"]!), im: exactNumber($0["im"]!), label: $0["label"] as! String)
        }
        let same =
          labels.map { got in
            got.rootOf == want["rootOf"] as? String && got.roots.count == wantRoots.count
              && zip(got.roots, wantRoots).allSatisfy {
                $0.label == $1.label && (exact ? $0 == $1 : close($0.re, $1.re) && close($0.im, $1.im))
              }
          } ?? false
        if !same { differ("complex labels", labels, want) }
      } else if labels != nil {
        differ("complex labels", labels, "none")
      }
    }
    #expect(failures.isEmpty, "\(failures.count) differ:\n\(failures.prefix(20).joined(separator: "\n"))")
  }

  @Test func polynomialDivision() throws {
    var failures: [String] = []
    for c in corpus["polyPairs"] as! [[String: Any]] {
      let (a, b) = (poly(c["a"]), poly(c["b"]))
      let (q, r) = fpdivmod(a, b)
      let ext = fpextgcd(a, b)
      let wanted = c["ext"] as! [String: Any]
      let got = [spell(q), spell(r), spell(fpgcd(a, b)), spell(ext.g), spell(ext.s), spell(ext.t)]
      let want = [c["q"], c["r"], c["gcd"], wanted["g"], wanted["s"], wanted["t"]].map { $0 as! [String] }
      if got != want { failures.append("\(spell(a)) and \(spell(b)): got \(got), want \(want)") }
    }
    #expect(failures.isEmpty, "\(failures.count) differ:\n\(failures.prefix(10).joined(separator: "\n"))")
  }

  @Test func polynomialRootsInARange() throws {
    for c in corpus["found"] as! [[String: Any]] {
      let got = findRoots(try decode(c["f"]!), "x", exactNumber(c["lo"]!), exactNumber(c["hi"]!))
      let want: FoundRoots =
        if let list = c["result"] as? [[String: Any]] {
          .roots(
            list.map {
              FoundRoot(
                x: exactNumber($0["x"]!), mult: Int($0["mult"] as! String)!, exact: $0["exact"] as! Bool,
                sym: $0["sym"] as? String, rootOf: $0["rootOf"] as? String)
            })
        } else {
          .zero
        }
      #expect(got == want, "\(c["src"]!)")
    }
  }
}

/// The exact corpus writes every number as text.
func exactNumber(_ json: Any) -> Double {
  switch json as! String {
  case "Infinity": .infinity
  case "-Infinity": -.infinity
  case "NaN": .nan
  case "-0": -0.0
  case let text: Double(text)!
  }
}
