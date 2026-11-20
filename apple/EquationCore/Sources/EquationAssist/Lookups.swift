import Foundation

/// Ask's tools that answer from the language, not the graph: list_kinds,
/// kind_examples, shape, search_functions and function_doc, ported from
/// lib/assistant-tools.ts function for function. The on-device model's evals
/// score what these return, so every answer is the TypeScript's to the
/// character (LookupConformanceTests holds them to it, over a fixture
/// `pnpm swift:corpus` records).
///
/// They answer from two files `pnpm app:data` writes (apple/tools/app-data.ts):
/// assistant.json, the reference's kinds, examples, notes and shapes
/// (lib/reference.ts `AssistantData`), and language.json, what the TypeScript
/// reads from the language itself (the function table, each kind's meaning).
public struct AssistantLookups: Sendable {
  let data: AssistantData
  let language: LanguageData
  let builtins: Builtins
  /// The examples that call each function, and the reference's note on it.
  let functions: [Exact: [LabelledRows]]
  let notes: [Exact: String]

  public init(assistant: Data, language: Data) throws {
    data = try JSONDecoder().decode(AssistantData.self, from: assistant)
    self.language = try JSONDecoder().decode(LanguageData.self, from: language)
    builtins = Builtins(self.language.builtins)
    functions = exact(data.functions)
    notes = exact(data.notes)
  }

  // MARK: kinds

  private var kinds: [AssistantData.Kind] { data.groups.flatMap(\.kinds) }

  private func meaning(_ kind: String) -> String { language.kindMeanings[kind] ?? "" }

  /// list_kinds: every kind; the common ones with their smallest form and a
  /// few words, the rest by topic (the reference's groups).
  public func listKinds() -> String {
    var lines = ["One shape per row. kind: smallest form (; separates rows) | what it draws"]
    lines += data.groups.filter { !$0.brief }.flatMap { $0.kinds.map { "\($0.kind): \($0.form) | \($0.short)" } }
    lines.append(
      "Definitions draw nothing themselves: a = 2 (a slider), f(x) = x^2 (add y = f(x) to draw it), "
        + "A = (1, 2) (a draggable point).")
    lines.append("More kinds:")
    lines += data.groups.filter(\.brief).map {
      "\(JS.lower($0.name)): \($0.kinds.map(\.kind).joined(separator: ", "))"
    }
    lines.append("kind_examples(kind) gives any kind with worked examples.")
    return lines.joined(separator: "\n")
  }

  /// The rows first and the label after: a label first ("solid cube: […]")
  /// was copied into a row.
  private func exampleLines(_ list: [LabelledRows]?) -> [String] {
    (list ?? []).map { "- \(JS.stringify($0.rows)) (\($0.label))" }
  }

  /// The kind a model means: a name from list_kinds or the instructions, or
  /// a kind as get_graph reports it ("pcurve", "parametric curve").
  private func findKind(_ query: String) -> AssistantData.Kind? {
    let q = JS.lower(JS.trim(query))
    let kinds = self.kinds
    return kinds.first { JS.same($0.kind, q) }
      ?? kinds.first { JS.same(JS.lower($0.title), q) }
      ?? kinds.first { JS.starts(q, with: $0.kind) }
      ?? kinds.first { JS.starts(JS.lower($0.short), with: q) || JS.starts(JS.lower(meaning($0.kind)), with: q) }
  }

  /// kind_examples(kind): what a kind draws, its smallest form, and worked
  /// examples, each a whole graph.
  public func kindExamples(_ query: String) -> String {
    guard let found = findKind(query) else {
      return "No kind \"\(query)\". Kinds: \(kinds.map(\.kind).joined(separator: ", "))."
    }
    let kind = found.kind
    let examples = data.kinds[kind]
    var lines = ["\(kind): \(meaning(kind))", "smallest: \(JS.stringify(language.forms[kind] ?? []))"]
    if examples?.isEmpty == false { lines.append("examples (each a whole graph, one entry per row):") }
    lines += exampleLines(examples)
    return lines.joined(separator: "\n")
  }

  // MARK: functions

  private static let stopWords: Set<String> = [
    "a", "an", "the", "of", "to", "in", "on", "and", "or", "for", "with", "function", "by",
  ]

  /// search_functions(query): the built-in functions that best match a few
  /// words, a line each.
  public func searchFunctions(_ query: String, limit: Int = 6) -> String {
    // Words of letters, digits and _; a plural's s dropped (`(?<=..)s$`, two
    // UTF-16 units before it).
    let words: [[Unicode.Scalar]] = JS.lower(query).unicodeScalars
      .split { !(JS.isLetter($0) || JS.isNumber($0) || $0 == "_") }
      .filter { !Self.stopWords.contains(String($0)) }
      .map { $0.last == "s" && String($0).utf16.count >= 3 ? Array($0.dropLast()) : Array($0) }
    if words.isEmpty { return #"Give a few words, e.g. "inverse sine" or "convex hull"."# }
    var scored: [(help: Builtins.Help, score: Int, rank: Int)] = []
    for (index, name) in builtins.names.enumerated() {
      guard let help = builtins.help(name) else { continue }
      let lower = Array(JS.lower(name).unicodeScalars)
      let text = Array(JS.lower("\(help.signature) \(help.description)").unicodeScalars)
      var score = 0
      for w in words {
        if lower == w { score += 10 } else if lower.starts(with: w) { score += 4 }
        if Self.startsAWord(w, in: text) { score += 2 }
      }
      if score > 0 { scored.append((help, score, builtins.rank[Exact(name)] ?? index)) }
    }
    if scored.isEmpty { return "No built-in function matches \"\(query)\"." }
    // Only the strong matches: one word in common with many descriptions ("3D") is noise.
    let best = scored.map(\.score).max() ?? 0
    return
      scored
      .filter { $0.score * 2 > best }
      .sorted { $0.score != $1.score ? $0.score > $1.score : $0.rank < $1.rank }
      .prefix(max(0, limit))
      .map { "\($0.help.signature): \($0.help.description)" }
      .joined(separator: "\n")
  }

  /// `(?<![\p{L}])word`: whether `word` is in `text` where no letter comes
  /// before it.
  private static func startsAWord(_ word: [Unicode.Scalar], in text: [Unicode.Scalar]) -> Bool {
    guard word.count <= text.count else { return false }
    for at in 0...(text.count - word.count)
    where (at == 0 || !JS.isLetter(text[at - 1])) && text[at...].starts(with: word) {
      return true
    }
    return false
  }

  /// `name.trim().replace(/\s*\(.*$/, '')`: a name as it was called, less its
  /// arguments. The bracket is the first with no line end after it (`.`
  /// stops at one), and the space before it goes too.
  private static func bareName(_ name: String) -> String {
    let s = Array(JS.trim(name).unicodeScalars)
    let lastLineEnd = s.lastIndex(where: JS.isLineEnd) ?? -1
    guard var cut = s[(lastLineEnd + 1)...].firstIndex(of: "(") else { return JS.string(s) }
    while cut > 0, JS.isSpace(s[cut - 1]) { cut -= 1 }
    return JS.string(s[..<cut])
  }

  /// function_doc(name): a built-in function's signature, what it does, the
  /// reference's note, and an example or two that use it.
  public func functionDoc(_ name: String) -> String {
    let bare = Self.bareName(name)
    guard let help = builtins.help(bare) else {
      let near = searchFunctions(bare, limit: 3)
      return "\(bare) is not a built-in function.\(near.hasPrefix("No ") ? "" : " Close:\n\(near)")"
    }
    let lower = JS.lower(bare)
    let examples = functions[Exact(bare)] ?? functions[Exact(lower)]
    var lines = ["\(help.signature): \(help.description)"]
    if let note = notes[Exact(bare)] ?? notes[Exact(lower)], !note.isEmpty { lines.append(note) }
    if examples?.isEmpty == false { lines.append("examples (each a whole graph):") }
    lines += exampleLines(examples)
    return lines.joined(separator: "\n")
  }

  // MARK: named shapes

  /// A name as shape() compares it: lower case, no accents or punctuation,
  /// no leading article. Only a–z, 0–9 and single spaces are left.
  static func shapeKey(_ name: String) -> [UInt8] {
    let plain = JS.string(name.decomposedStringWithCanonicalMapping.unicodeScalars.filter {
      !(0x0300...0x036F).contains($0.value)
    })
    var key: [UInt8] = []
    for c in JS.lower(plain).unicodeScalars {
      if ("a"..."z").contains(c) || ("0"..."9").contains(c) {
        key.append(UInt8(c.value))
      } else if key.last != 0x20 {
        key.append(0x20)
      }
    }
    if key.first == 0x20 { key.removeFirst() }
    if key.last == 0x20 { key.removeLast() }
    for article in ["a ", "an ", "the "] where key.starts(with: Array(article.utf8)) {
      key.removeFirst(article.utf8.count)
      break
    }
    return key
  }

  /// Edits (insert, delete, change a letter) between two strings.
  static func editDistance(_ a: [UInt8], _ b: [UInt8]) -> Int {
    var row = Array(0...b.count)
    for i in 0..<a.count {
      var next = [i + 1]
      for j in 0..<b.count {
        next.append(min(row[j + 1] + 1, next[j] + 1, row[j] + (a[i] == b[j] ? 0 : 1)))
      }
      row = next
    }
    return row[b.count]
  }

  /// `(?:^| )key(?:e?s)?(?: |$)`: `key` as whole words of `q`, or its plural.
  private static func names(_ key: [UInt8], in q: [UInt8]) -> Bool {
    for start in 0...q.count {
      var openings: [Int] = start == 0 ? [0] : []
      if start < q.count, q[start] == 0x20 { openings.append(start + 1) }
      for at in openings where q[at...].starts(with: key) {
        let after = at + key.count
        for plural in ["es", "s", ""] where q[after...].starts(with: Array(plural.utf8)) {
          let end = after + plural.utf8.count
          if end == q.count || q[end] == 0x20 { return true }
        }
      }
    }
    return false
  }

  private static func words(_ key: [UInt8]) -> [[UInt8]] {
    key.split(separator: 0x20, omittingEmptySubsequences: false).map(Array.init)
  }

  /// The shape a request names: by name or alias, exactly; else the longest
  /// name inside the request ("a sphere of radius 2"); else a near spelling
  /// ("cardiod"); else a word of a name ("lissajous", "knot").
  private func findShape(_ query: String) -> AssistantData.Shape? {
    let q = Self.shapeKey(query)
    if q.isEmpty { return nil }
    let names = data.shapes.flatMap { shape in
      ([shape.name] + shape.aliases).map { (shape: shape, key: Self.shapeKey($0)) }
    }
    if let exact = names.first(where: { $0.key == q }) { return exact.shape }
    // The longest, and of equals the first: the TypeScript's sorts are stable.
    var inside: (shape: AssistantData.Shape, key: [UInt8])?
    for n in names where Self.names(n.key, in: q) && n.key.count > (inside?.key.count ?? -1) { inside = n }
    if let inside { return inside.shape }
    let words = Self.words(q)
    var near: (shape: AssistantData.Shape, distance: Int)?
    for n in names {
      let size = Self.words(n.key).count
      let windows = (0..<min(words.count, max(1, words.count - size + 1))).map { k in
        Array(words[k..<min(k + size, words.count)].joined(separator: [0x20]))
      }
      let distance = windows.map { Self.editDistance($0, n.key) }.min() ?? .max
      if distance <= n.key.count / 5, distance < (near?.distance ?? .max) { near = (n.shape, distance) }
    }
    if let near { return near.shape }
    return names.first { n in Self.words(n.key).contains { $0.count > 3 && words.contains($0) } }?.shape
  }

  /// shape(name): a named curve or surface's forms in this language, each
  /// with its parameters and one instance, from the reference
  /// (docs/reference/shapes.md); on a miss, every name. One form only, the
  /// equation where there is one (the model drew every form it was shown, as
  /// separate rows). Rows come before their kind (a `kind: rows` line was
  /// copied into a row whole), and the answer ends by saying it drew nothing:
  /// the model took the entry for a drawing and replied without set_graph.
  public func shape(_ name: String) -> String {
    guard let found = findShape(name) else {
      let all = data.shapes.map { JS.lower($0.name) }.joined(separator: ", ")
      return "No shape \"\(JS.trim(name))\". Shapes: \(all)."
    }
    // Every shape has a form (lib/reference.ts throws on one without).
    guard let form = found.forms.first(where: { $0.kind.hasPrefix("implicit") }) ?? found.forms.first else {
      return "No shape \"\(JS.trim(name))\"."
    }
    let also = found.aliases.isEmpty ? "" : " (also \(found.aliases.joined(separator: ", ")))"
    let note = { (text: String?) in text.flatMap { $0.isEmpty ? nil : " — \($0)" } ?? "" }
    let values = form.example.values.flatMap { $0.isEmpty ? nil : "\($0) → " } ?? ""
    var lines = [
      "\(found.name)\(also): \(JS.collapseSpaces(found.intro))",
      "- \(JS.stringify(form.rows)) (\(form.kind))\(note(form.note))",
    ]
    lines += form.params.map { "  \($0.joined(separator: ": "))" }
    lines.append("  e.g. \(values)\(JS.stringify(form.example.rows))\(note(form.example.note))")
    if let pitfall = found.pitfall, !pitfall.isEmpty { lines.append("Pitfall: \(pitfall)") }
    lines.append("Nothing is drawn yet: adapt this form to the request and pass its rows to set_graph.")
    return lines.joined(separator: "\n")
  }
}
