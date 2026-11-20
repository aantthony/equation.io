import Foundation
import Testing

@testable import EquationCore

/// Holds the CPU evaluator to lib/expr.ts `evaluate`, and the numbers the
/// port writes to JavaScript's spelling of them. Regenerate with
///
///   node --experimental-transform-types --no-warnings apple/corpus/analysis.ts
@Suite struct EvaluateConformance {
  /// Every expression at every point: the same value (to the last few
  /// places: sin, exp and pow come from a different libm than V8's), the
  /// same NaN or infinity, or the same error.
  @Test func expressions() throws {
    let root = try #require(try fixture("evaluate") as? [String: Any])
    let evals = root["evals"] as! [[String: Any]]
    var failures: [String] = []
    var compared = 0
    var inexact = 0
    for entry in evals {
      let src = entry["src"] as! String
      let expr: Expr
      do {
        expr = try parseExpr(src)
      } catch {
        if entry["parseError"] as? String != error.message {
          failures.append("\(src): parse error \(error.message)")
        }
        continue
      }
      if let key = entry["key"] as? String {
        // (A list has identity the key leaves out; the port has no lists yet.)
        if exprKey(expr) != key { failures.append("\(src): key \(exprKey(expr)), want \(key)") }
      } else {
        failures.append("\(src): parsed, but the site reports \(entry["parseError"] ?? "?")")
        continue
      }
      for c in entry["cases"] as! [[String: Any]] {
        let env = ["x": number(c["x"]!), "y": number(c["y"]!)]
        compared += 1
        let at = "\(src) at x = \(env["x"]!), y = \(env["y"]!)"
        do {
          let got = try evaluate(expr, env)
          guard let value = c["value"] else {
            failures.append("\(at): \(got), want the error \(c["error"]!)")
            continue
          }
          let want = number(value)
          if got.bitPattern != want.bitPattern && !(got.isNaN && want.isNaN) { inexact += 1 }
          if !close(got, want) { failures.append("\(at): \(got), want \(want)") }
        } catch let error as LanguageError {
          if c["error"] as? String != error.message {
            failures.append("\(at): error \(error.message), want \(c["error"] ?? c["value"] ?? "?")")
          }
        }
      }
    }
    print("Evaluate conformance: \(compared) evaluations, \(inexact) differ in the last places.")
    let shown = failures.prefix(40).joined(separator: "\n")
    #expect(failures.isEmpty, "\(failures.count) differences:\n\(shown)")
  }

  @Test func powers() throws {
    let root = try #require(try fixture("evaluate") as? [String: Any])
    for c in root["pow"] as! [[String: Any]] {
      let (a, b, want) = (number(c["a"]!), number(c["b"]!), number(c["value"]!))
      let got = realPow(a, b)
      #expect(close(got, want), "\(a)^\(b): \(got), want \(want)")
      // Signs of zero and infinity are exact, whatever the libm.
      if want == 0 || want.isInfinite { #expect(got.bitPattern == want.bitPattern, "\(a)^\(b)") }
    }
  }

  @Test func numbersAsJavaScriptWritesThem() throws {
    let root = try #require(try fixture("evaluate") as? [String: Any])
    for c in root["numbers"] as! [[String: Any]] {
      let v = number(c["v"]!)
      func want(_ key: String) -> String { c[key] as! String }
      #expect(JS.string(v) == want("string"), "String(\(v))")
      #expect(JS.toPrecision(v, 6) == want("precision6"), "\(v).toPrecision(6)")
      #expect(JS.toPrecision(v, 1) == want("precision1"), "\(v).toPrecision(1)")
      #expect(JS.toPrecision(v, 17) == want("precision17"), "\(v).toPrecision(17)")
      #expect(JS.toFixed(v, 6) == want("fixed6"), "\(v).toFixed(6)")
      #expect(JS.toFixed(v, 0) == want("fixed0"), "\(v).toFixed(0)")
      #expect(JS.toFixed(v, 2) == want("fixed2"), "\(v).toFixed(2)")
      #expect(formatSliderNumber(v) == want("slider"), "fmtNum(\(v))")
      #expect(valueReadout(v) == want("readout"), "valueReadout(\(v))")
    }
  }

  @Test func structure() throws {
    let e = try parseExpr("a x^2 + f(b, {x > 0: a})", userFns: ["f"])
    #expect(freeVarNames(e).list == ["a", "x", "b"])
    let env: [String: Expr] = ["a": .num(2), "x": try parseExpr("t + 1")]
    let substituted = try parseExpr("2 (t + 1)^2 + f(b, {t + 1 > 0: 2})", userFns: ["f"])
    #expect(substVars(e, env) == substituted)
    let mapped = mapChildren(Expr.neg(.var("x"))) { _ in Expr.num(1) }
    #expect(mapped == Expr.neg(.num(1)))
    let piecewise = try parseExpr("{x > 0: 1, 2}")
    #expect(childrenOf(piecewise).count == 3)
    let derivative = try Sym.diff(try parseExpr("x^3 + sin(2 x)"), "x")
    let expected = try parseExpr("3 x^2 + cos(2 x) 2")
    #expect(derivative == expected)
  }

  @Test func statements() {
    #expect(splitStatements("y = x; a = 2\n(1,\n 2)") == ["y = x", " a = 2", "(1,  2)"])
    #expect(splitStatements("p = open(\"a;b.csv\"); y = 2") == ["p = open(\"a;b.csv\")", " y = 2"])
    #expect(splitStatements("f(x)' ; y = 2") == ["f(x)' ", " y = 2"])
    #expect(noteStart("y = x^2 # parabola") == 8)
    #expect(noteStart("# heading") == nil)
    #expect(noteStart("p = open(\"a#b\")") == nil)
    #expect(stripNote("y = x^2  # parabola") == "y = x^2")
    let short: [Double] = [238.0 / 255, 34.0 / 255, 68.0 / 255]
    let long: [Double] = [31.0 / 255, 119.0 / 255, 180.0 / 255]
    #expect(noteColor("y = x #e24") == short)
    #expect(noteColor("y = x #1f77b4 blue") == long)
    #expect(noteColor("y = x # fed") == nil)
    #expect(noteColor("y = x #feed") == nil)
    #expect(keepNote("a = 1 # speed", "a = 2") == "a = 2 # speed")
  }

  @Test func definitionsAreScanned() {
    #expect(scanDefinition("a = 2") == .constant(name: "a", rhs: " 2"))
    #expect(scanDefinition("f(x, y) = x y") == .function(name: "f", params: ["x", "y"], rhs: " x y"))
    #expect(scanDefinition("a' = -a") == .state(name: "a", rhs: " -a"))
    #expect(scanDefinition("a(0) = 1") == .initial(name: "a", rhs: " 1"))
    #expect(scanDefinition("T₀ = 3") == .constant(name: "T_0", rhs: " 3"))
    #expect(scanDefinition("T_{c} = 300") == .constant(name: "T_c", rhs: " 300"))
    #expect(scanDefinition("p ∈ A") == .constant(name: "p", rhs: "A", draw: true))
    #expect(scanDefinition("p = open(\"a.csv\")") == .table(name: "p"))
    for text in ["y = x", "y' = x - y", "a == 2", "sin(x) = 1", "e = 2", "x^2 + y^2 = 1", "u_a = 1", "a ="] {
      #expect(scanDefinition(text) == nil, "\(text)")
    }
  }
}
