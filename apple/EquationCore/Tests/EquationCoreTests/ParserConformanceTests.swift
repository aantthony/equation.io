import Foundation
import Testing

@testable import EquationCore

/// Holds the Swift parser to the TypeScript one: every input the TypeScript
/// suite parses, and every prefix of each as it would be typed, must give
/// the same tree or the same error message. Regenerate the fixtures with
///
///   pnpm swift:corpus
@Suite struct ParserConformance {
  @Test func suiteInputs() throws { try conform("parse-corpus") }
  @Test func typingPrefixes() throws { try conform("parse-prefixes") }

  private func conform(_ fixture: String) throws {
    let url = try #require(Bundle.module.url(forResource: "Fixtures/\(fixture)", withExtension: "json"))
    let entries = try #require(try JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [[String: Any]])
    var failures: [String] = []
    for entry in entries {
      let src = entry["src"] as! String
      let got: Result<Expr, ParseError> = Result { () throws(ParseError) in
        try parseExpr(
          src,
          userFns: Set(entry["userFns"] as! [String]),
          listNames: Set(entry["listNames"] as! [String]),
          valueNames: Set(entry["valueNames"] as! [String]))
      }
      let want: Result<Expr, ParseError> =
        if let message = entry["error"] as? String {
          .failure(ParseError(message, parse: entry["errorType"] as? String == "ParseError"))
        } else {
          .success(try decode(entry["expr"]!))
        }
      // Compared as printed, so a NaN matches a NaN (and -0 still differs from 0).
      if "\(got)" != "\(want)" { failures.append("\(src.debugDescription)\n    want \(want)\n    got  \(got)") }
    }
    let shown = failures.prefix(25).joined(separator: "\n")
    #expect(failures.isEmpty, "\(failures.count) of \(entries.count) differ:\n\(shown)")
  }
}

struct DecodeError: Error, CustomStringConvertible {
  var description: String
}

/// The TypeScript's JSON for an Expr.
func decode(_ json: Any) throws -> Expr {
  guard let o = json as? [String: Any], let kind = o["kind"] as? String else {
    throw DecodeError(description: "not an expr: \(json)")
  }
  func expr(_ key: String) throws -> Expr { try decode(o[key]!) }
  func exprs(_ key: String) throws -> [Expr] { try (o[key] as! [Any]).map(decode) }
  func number(_ v: Any) throws -> Double {
    if let n = v as? NSNumber { return n.doubleValue }
    switch v as? String {
    case "-0": return -0.0
    case "Infinity": return .infinity
    case "-Infinity": return -.infinity
    case "NaN": return .nan
    case let text?:
      // A num's value is text in the fixtures, as JavaScript prints it (apple/corpus/build.ts).
      if let value = Double(text) { return value }
      throw DecodeError(description: "not a number: \(v)")
    default: throw DecodeError(description: "not a number: \(v)")
    }
  }
  switch kind {
  case "num": return .num(try number(o["value"]!))
  case "var": return .var(o["name"] as! String)
  case "bin":
    return .bin(
      BinOp(rawValue: o["op"] as! String)!, try expr("a"), try expr("b"),
      glyph: (o["glyph"] as? String).map { ProductGlyph(rawValue: $0)! })
  case "neg": return .neg(try expr("a"))
  case "call": return .call(o["name"] as! String, try exprs("args"))
  case "index", "range", "eqtest":
    let args = try exprs("args")
    if kind == "index" { return .index(args[0], args[1]) }
    if kind == "range" { return .range(args[0], args[1]) }
    return .eqtest(EqTestOp(rawValue: o["op"] as! String)!, args[0], args[1])
  case "eq": return .eq(try expr("l"), try expr("r"))
  case "ineq":
    return .ineq(
      IneqOp(rawValue: o["op"] as! String)!, try expr("l"), try expr("r"), grouped: o["grouped"] as? Bool ?? false)
  case "vec": return .vec(try exprs("items"))
  case "list": return .list(try exprs("items"))
  case "str": return .str(o["value"] as! String)
  case "piecewise":
    let cases = try (o["cases"] as! [[String: Any]]).map {
      Expr.Case(cond: try decode($0["cond"]!), value: try decode($0["value"]!), bare: $0["bare"] as? Bool ?? false)
    }
    return .piecewise(cases, otherwise: try o["otherwise"].map(decode))
  default: throw DecodeError(description: "unknown kind \(kind)")
  }
}
