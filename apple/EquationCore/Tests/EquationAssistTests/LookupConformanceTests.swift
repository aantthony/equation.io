import Foundation
import Testing

@testable import EquationAssist

/// Ask's lookups must answer as lib/assistant-tools.ts does, to the
/// character: the on-device model's evals score what the tools return.
/// The fixture is the app's data and what the TypeScript answers to a few
/// thousand requests over it (apple/corpus/lookups.ts); regenerate it with
/// `pnpm swift:corpus`.
@Suite struct LookupConformance {
  static func fixture(_ name: String) throws -> Data {
    let url = try #require(Bundle.module.url(forResource: "Fixtures/\(name)", withExtension: "json"))
    return try Data(contentsOf: url)
  }

  static func lookups() throws -> AssistantLookups {
    try AssistantLookups(assistant: fixture("assistant"), language: fixture("language"))
  }

  @Test func answersMatchTheTypeScript() throws {
    let lookups = try Self.lookups()
    let cases = try JSONDecoder().decode([[String]].self, from: Self.fixture("lookups"))
    var counts: [String: Int] = [:]
    var failures: [String] = []
    for entry in cases {
      let (tool, arg, want) = (entry[0], entry[1], entry[2])
      let got: String
      switch tool {
      case "list_kinds": got = lookups.listKinds()
      case "kind_examples": got = lookups.kindExamples(arg)
      case "shape": got = lookups.shape(arg)
      case "function_doc": got = lookups.functionDoc(arg)
      case "search_functions": got = lookups.searchFunctions(arg)
      default:
        failures.append("unknown tool \(tool)")
        continue
      }
      counts[tool, default: 0] += 1
      // By code points: Swift's == would pass a composed letter for a decomposed one.
      if !got.unicodeScalars.elementsEqual(want.unicodeScalars) {
        failures.append("\(tool)(\(JS.stringify(arg)))\n    want \(JS.stringify(want))\n    got  \(JS.stringify(got))")
      }
    }
    #expect(
      failures.isEmpty,
      "\(failures.count) of \(cases.count) differ:\n\(failures.prefix(20).joined(separator: "\n"))")
    // Every tool was asked, and widely.
    #expect(counts["list_kinds"] == 1)
    for tool in ["kind_examples", "shape", "function_doc", "search_functions"] {
      #expect(counts[tool, default: 0] > 300, "\(tool)")
    }
  }

  @Test func stringsAreJavaScripts() {
    #expect(JS.stringify(["a\"b\\c", "tab\there\n", "\u{01}é→"]) == #"["a\"b\\c","tab\there\n","\u0001é→"]"#)
    #expect(JS.trim("\u{FEFF}\n a b\u{2028}\u{A0}") == "a b")
    #expect(JS.lower("ΟΔΟΣ") == "οδος")
    #expect(!JS.same("é", "e\u{301}"))
  }

  @Test func shapeKeys() {
    #expect(AssistantLookups.shapeKey("  The Möbius-strip! ") == Array("mobius strip".utf8))
    #expect(AssistantLookups.shapeKey("a") == Array("a".utf8))
    #expect(AssistantLookups.editDistance(Array("cardiod".utf8), Array("cardioid".utf8)) == 1)
  }
}
