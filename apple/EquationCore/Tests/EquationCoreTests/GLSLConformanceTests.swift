import Foundation
import Testing

@testable import EquationCore

/// Holds the Swift emitter to lib/glsl.ts: every expression the TypeScript
/// suite compiles must come out as the same GLSL text, or the same error.
/// The fixture also carries what the suite has no reason to ask: numbers of
/// every magnitude, awkward uniform names, and shaders to link. Regenerate
/// it with `pnpm swift:corpus`.
///
/// An input holding a node the Swift Expr does not have yet (figure, data,
/// lazy, loop, …) is passed over; a failure says how many were.
///
/// Serialized: linking reads the helpers the process has declared.
@Suite(.serialized) struct GLSLConformance {
  /// Read once, and only read after that.
  nonisolated(unsafe) static let corpus: [String: Any] = {
    let url = Bundle.module.url(forResource: "Fixtures/glsl-corpus", withExtension: "json")!
    return try! JSONSerialization.jsonObject(with: Data(contentsOf: url)) as! [String: Any]
  }()

  private func cases(_ key: String) -> [[String: Any]] { Self.corpus[key] as! [[String: Any]] }

  /// The fixture's number: non-finite ones and -0 are written as text.
  private func float(_ json: Any) -> Float {
    if let n = json as? NSNumber { return n.floatValue }
    switch json as! String {
    case "-0": return -0.0
    case "Infinity": return .infinity
    case "-Infinity": return -.infinity
    default: return .nan
    }
  }

  private func report(_ failures: [String], of checked: Int, _ total: Int) {
    #expect(checked > 0, "nothing compared, of \(total)")
    let shown = failures.prefix(15).joined(separator: "\n")
    let passed = total - checked
    #expect(failures.isEmpty, "\(failures.count) of \(checked) differ (\(passed) not representable):\n\(shown)")
  }

  /// A recorded outcome beside the Swift one, or nil when they agree.
  private func differs(_ entry: [String: Any], _ got: Result<String, ShaderError>, _ label: String) -> String? {
    let want = entry["error"].map { "error: \($0)" } ?? "\(entry["out"]!)"
    let have =
      switch got {
      case .success(let text): text
      case .failure(let error): "error: \(error.message)"
      }
    return want == have ? nil : "\(label.prefix(300))\n    want \(want.prefix(600))\n    got  \(have.prefix(600))"
  }

  @Test func thePreludeIsTheSites() {
    #expect(glslPrelude == Self.corpus["prelude"] as? String)
  }

  @Test func numbers() {
    var failures: [String] = []
    let entries = cases("numbers")
    for entry in entries {
      let value = Double(bitPattern: UInt64(entry["bits"] as! String, radix: 16)!)
      let text = jsNumberString(value)
      if text != entry["text"] as! String { failures.append("\(entry["bits"]!): want \(entry["text"]!), got \(text)") }
      let got = Result { () throws(ShaderError) in try toGLSL(.num(value)) }
      var want = entry
      want["out"] = entry["glsl"]
      if let failure = differs(want, got, "\(entry["bits"]!)") { failures.append(failure) }
    }
    report(failures, of: entries.count, entries.count)
  }

  @Test func uniformNames() {
    let entries = cases("uniforms")
    let failures = entries.compactMap { entry in
      differs(entry, .success(uniformName(entry["p"] as! String)), "\(entry["p"]!)")
    }
    report(failures, of: entries.count, entries.count)
  }

  @Test func suiteExpressions() {
    var failures: [String] = []
    var checked = 0
    let entries = cases("emits")
    for entry in entries {
      guard let expr = try? decode(entry["expr"]!) else { continue }
      checked += 1
      let got = Result { () throws(ShaderError) in try toGLSL(expr) }
      if let failure = differs(entry, got, "\(expr)") { failures.append(failure) }
    }
    report(failures, of: checked, entries.count)
  }

  /// fourierGraphGLSL: the same text, having asked for the derivatives the
  /// TypeScript asked lib/diff.ts for and been given the same answers.
  @Test func fourierGraphs() {
    var failures: [String] = []
    var checked = 0
    let entries = cases("graphs")
    for entry in entries {
      guard let expr = try? decode(entry["expr"]!) else { continue }
      let diffs = entry["diffs"] as! [[String: Any]]
      guard let asked = try? diffs.map({ (try decode($0["expr"]!), $0["v"] as! String) }) else { continue }
      checked += 1
      var next = 0
      var stray = false
      let got = Result { () throws(ShaderError) in
        try fourierGraphGLSL(expr) { e, v in
          guard next < asked.count, sameExprKey(asked[next].0, e), asked[next].1 == v else {
            stray = true
            throw DecodeError(description: "a derivative the TypeScript did not ask for")
          }
          next += 1
          let derivative = Result { () throws(DiffError) in try diff(e, v) }
          // Compared as printed, so a NaN matches a NaN.
          let have =
            switch derivative {
            case .success(let d): "\(d)"
            case .failure(let error): "error: \(error.message)"
            }
          let want =
            try (diffs[next - 1]["error"] as? String).map { "error: \($0)" } ?? "\(decode(diffs[next - 1]["out"]!))"
          if have != want { stray = true }
          return try derivative.get()
        }
      }
      var want = entry
      var have: Result<String, ShaderError> = got.map { $0.map { "\($0.glsl) × \($0.slopeScale)" } ?? "none" }
      if let out = entry["out"] as? [String: Any] {
        want["out"] = "\(out["glsl"]!) × \(Double(out["slopeScale"] as! String)!)"
      } else if entry["error"] == nil {
        want["out"] = "none"
      }
      if stray || next != asked.count { have = .success("asked for \(next) of \(asked.count) derivatives, or got others") }
      if let failure = differs(want, have, "\(expr)") { failures.append(failure) }
    }
    report(failures, of: checked, entries.count)
  }

  @Test func helperNames() {
    let entries = cases("helpers")
    let failures = entries.compactMap { entry in
      let table = (entry["table"] as? [Any])?.map(float)
      var want = entry
      want["out"] = entry["name"]
      return differs(want, .success(declareHelper(entry["source"] as! String, table: table)), "\(entry["source"]!)")
    }
    report(failures, of: entries.count, entries.count)
  }

  /// withHelpers and shaderTables, after declaring what each case's shader needs.
  @Test func linkedShaders() {
    var failures: [String] = []
    var checked = 0
    let entries = cases("links")
    for entry in entries {
      guard let exprs = try? (entry["exprs"] as! [Any]).map(decode) else { continue }
      checked += 1
      for helper in entry["declare"] as! [[String: Any]] {
        _ = declareHelper(helper["source"] as! String, table: (helper["table"] as? [Any])?.map(float))
      }
      for expr in exprs { _ = try? toGLSL(expr) }
      let shader = entry["shader"] as! String
      let budget = (entry["budget"] as? NSNumber)?.doubleValue ?? .infinity
      let got = Result { () throws(ShaderError) in try withHelpers(shader, tableBudget: budget) }
      if let failure = differs(entry, got, shader) { failures.append(failure) }
      guard case .success(let linked) = got, let tables = entry["tables"] as? [[String: Any]] else { continue }
      // Compared as bits, so a NaN coefficient matches itself.
      let want = tables.map { "\($0["name"]!) \(($0["values"] as! [Any]).map { float($0).bitPattern })" }
      let have = shaderTables(linked).map { "\($0.name) \($0.values.map(\.bitPattern))" }
      if want != have { failures.append("tables of \(shader.suffix(200))\n    want \(want)\n    got  \(have)") }
    }
    report(failures, of: checked, entries.count)
  }

  /// Only the most recently declared or linked helpers are kept (HELPER_LIMIT).
  @Test func oldHelpersAreForgotten() throws {
    let first = declareHelper("float @self() { return -1.0; }")
    let kept = declareHelper("float @self() { return -2.0; }")
    for k in 0..<511 {
      _ = declareHelper("float @self() { return \(k).0; }")
      _ = try withHelpers("\(glslPrelude)\n\(kept)()")
    }
    #expect(throws: ShaderError("Shader refers to an undeclared helper \(first).")) {
      try withHelpers("\(glslPrelude)\n\(first)()")
    }
    #expect(try withHelpers("\(glslPrelude)\n\(kept)()").contains("float \(kept)() { return -2.0; }"))
  }
}
