import EquationCore
import Foundation

// A row as the tools describe it: lib/assistant-tools.ts `describeRow`,
// which voice mode's get_graph, the app's Ask and `check` answer with
// (web/main.ts `rowStatus`). The text is what a model reads, and the Ask
// evals depend on it, so each sentence is the TypeScript's to the letter; a
// fixture (apple/corpus/reports.ts) holds this port to it.
//
// The analysis says less of a definition than the site's does (what a name
// is bound to is not public): a definition whose meaning cannot be told from
// its kind, its slider and its value is reported with its kind and no
// meaning, never with a guess.

/// What get_graph says about one row, less what needs the renderer (its
/// color and intercepts) (`RowReport`).
public struct RowReport: Equatable, Sendable {
  public var error: String?
  /// For an error: what probably went wrong, when the message alone misleads.
  public var hint: String?
  /// The public kind, e.g. "implicit2d", "definition (const)".
  public var kind: String?
  /// What the row is, in words.
  public var meaning: String?
  /// The readout under the row, or a constant's value.
  public var value: String?
  public var animated = false
  /// Valid, but probably not what was meant.
  public var warning: String?

  public var status: String { error == nil ? "ok" : "error" }

  public init() {}
}

/// 2D-only plots a 3D scene leaves out (`SKIPPED_IN_3D`).
private let skippedIn3D: Set<String> = [
  "scalar2d", "complex2d", "domain2d", "rgb2d", "hsl2d", "oklch2d", "conformal2d", "fractal2d", "ineq2d",
  "projected2d", "vfield2d", "tfield2d", "vlist", "dlist", "histogram", "sequence", "cobweb", "bifurcation",
  "automaton", "lattice", "graph", "density", "pmf", "prob", "expect",
]

/// `parseFloat(v.toPrecision(6))`.
private func round6(_ v: Double) -> Double {
  guard v.isFinite else { return v }
  return Double(String(format: "%.5e", v)) ?? v
}

private func isNameStart(_ c: Character) -> Bool { c.isLetter || c == "_" }
private func isNamePart(_ c: Character) -> Bool { c.isLetter || c.isNumber || c == "_" }

/// `/(?<![\p{L}_])name(?![\p{L}\p{N}_])/u` over `text`.
private func namesWord(_ text: String, _ name: String) -> Bool {
  let chars = Array(text)
  let word = Array(name)
  guard !word.isEmpty, chars.count >= word.count else { return false }
  for at in 0...(chars.count - word.count) where Array(chars[at..<(at + word.count)]) == word {
    if at > 0, isNameStart(chars[at - 1]) { continue }
    if at + word.count < chars.count, isNamePart(chars[at + word.count]) { continue }
    return true
  }
  return false
}

/// `text.replace(/"[^"]*"/g, '""')`: a row without what its strings say.
private func withoutStrings(_ text: String) -> String {
  var out = ""
  var held = ""
  var open = false
  for c in text {
    if c == "\"" {
      if open { out += "\"\"" } else { held = "" }
      open.toggle()
    } else if open {
      held.append(c)
    } else {
      out.append(c)
    }
  }
  // An unclosed quote matches nothing: it stays as written.
  if open { out += "\"" + held }
  return out
}

/// `/(?<![\w])name\s*\(/` over `text`: a call of `name`.
private func calls(_ text: String, _ name: String) -> Bool {
  let chars = Array(text)
  let word = Array(name)
  func isWord(_ c: Character) -> Bool { c.isASCII && (c.isLetter || c.isNumber || c == "_") }
  guard !word.isEmpty, chars.count > word.count else { return false }
  for at in 0..<(chars.count - word.count) where Array(chars[at..<(at + word.count)]) == word {
    if at > 0, isWord(chars[at - 1]) { continue }
    var k = at + word.count
    while k < chars.count, chars[k].isWhitespace { k += 1 }
    if k < chars.count, chars[k] == "(" { return true }
  }
  return false
}

extension DocumentAnalysis {
  /// Whether the graph draws in 3D: some row needs it (`is3D`).
  public var is3D: Bool {
    rows.contains { $0.error == nil && $0.unsupported == nil && $0.classified?.needs3D == true }
  }

  /// Whether any other row reads `name` (`usedElsewhere`): a row's plan
  /// names it, or its text does. The site also follows the constants a row
  /// reads to the ones they read; every such chain passes through a row
  /// whose text names `name`, which the second test finds — where the
  /// tokenizer splits a run of letters into names (`2ab`), by the names the
  /// highlighter finds in it.
  ///
  /// Nil when a row the port cannot read is among them: what it reads, or
  /// whether the site counts it (a framing row is not counted), is not known.
  func usedElsewhere(_ texts: [String], _ index: Int, _ name: String) -> Bool? {
    let others = rows.indices.filter { $0 != index && !rows[$0].comment && rows[$0].view == nil }
    if others.contains(where: { rows[$0].classified?.params.contains(name) == true }) { return true }
    for k in others where k < texts.count && rows[k].unsupported == nil {
      let bare = withoutStrings(stripNote(texts[k]))
      if namesWord(canonicalName(bare), name) { return true }
      let units = Array(texts[k].utf16)
      for span in highlightRows([texts[k]], names: names)[0] where span.cls == .name || span.cls == .fn {
        guard span.start >= 0, span.end <= units.count, span.start < span.end else { continue }
        if canonicalName(String(decoding: units[span.start..<span.end], as: UTF16.self)) == name { return true }
      }
    }
    return others.contains { rows[$0].unsupported != nil } ? nil : false
  }

  /// What a definition row makes (`definitionMeaning`), where the row's
  /// kind, slider and value say; nil where they do not.
  func definitionMeaning(_ def: Definition, _ row: RowAnalysis) -> String? {
    let name = def.name
    let quiet = "; draws nothing by itself"
    switch def {
    case .initial:
      return "sets where the state \(name) starts (its value at t = 0)"
    case .function(_, let params, _):
      let example = params == ["x"] ? ", e.g. y = \(name)(x)" : ""
      return "defines the function \(name)(\(params.joined(separator: ", "))); "
        + "draws nothing until another row uses it\(example)"
    case .regression(_, let lhs, let rhs):
      return "fits the model \(lhs) ~ \(rhs) to data, defining its parameters"
    case .table:
      return nil
    case .state:
      let states = stateSystem?.names ?? []
      if states.contains(name) {
        return "defines \(name): a scalar state, integrated forward in time from its derivative\(quiet)"
      }
      // A vector state is integrated as its components, name_1, name_2, ….
      let dim = (1...4).prefix { states.contains("\(name)_\($0)") }.count
      guard dim >= 2 else { return nil }
      return "defines \(name): a \(dim)D vector state, integrated forward in time from its derivative\(quiet); "
        + "a row \"\(name)\" draws it as a moving point"
    case .constant:
      switch row.kind {
      case "definition (matrix)": return "defines \(name): a matrix\(quiet)"
      case "definition (list)": return "defines \(name): a list\(quiet)"
      case "definition (filtered data)": return "defines \(name): a data table\(quiet)"
      case "definition (interval)":
        return "defines \(name): a continuous interval, one hidden parameter shared by every row that uses "
          + "\(name)\(quiet)"
      case "definition (point)":
        // (A field `F = (-y, x)` has this kind too, and no place of its own.)
        guard env["\(name)_x"] != nil, env["\(name)_y"] != nil else { return nil }
        return "defines \(name): a named \(env["\(name)_z"] == nil ? 2 : 3)D point, drawn on the graph"
      case "definition (const)":
        if gridFields.contains(where: { $0.name == name }) {
          return "defines \(name): a scalar field (a value at every point, e.g. a coordinate like r or theta)\(quiet)"
        }
        if row.slider != nil { return "defines \(name): a scalar constant with a slider\(quiet)" }
        // A name with a value of its own is a number; a field, a complex
        // number or a condition has none here.
        guard env[name] != nil, stateSystem?.names.contains(name) != true else { return nil }
        let moves = animated.contains(name) ? " that changes with time (t)" : ""
        return "defines \(name): a scalar constant\(moves)\(quiet)"
      default: return nil
      }
    }
  }

  /// Row `index` of `texts` (the rows as written), as web/main.ts
  /// `rowStatus` reports it (`describeRow`). `kindMeanings` is lib/row-kind.ts
  /// `KIND_MEANINGS` (the app bundles it in language.json); `lookupHint`
  /// what an unknown function's hint says to do (`LOOKUP_HINT`).
  ///
  /// A row the port cannot read yet is reported as such, in `warning`: it
  /// is not an error (the site draws it), and nothing else is known of it.
  public func describe(
    row index: Int, texts: [String], kindMeanings: [String: String],
    lookupHint: String = "call search_functions to find the right form"
  ) -> RowReport {
    let row = rows[index]
    let text = index < texts.count ? texts[index] : row.text
    var out = RowReport()
    if let error = row.error {
      out.error = error
      // `surface((…))` fails as an unknown *variable* times a bracket: name the real problem.
      let prefix = "Unknown variable: "
      if error.hasPrefix(prefix) {
        let word = error.dropFirst(prefix.count).prefix { $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "_") }
        if !word.isEmpty, error.dropFirst(prefix.count + word.count).hasPrefix(".") {
          let fns = rows.filter { if case .function? = $0.definition { true } else { false } }.map(\.text)
          if ([text] + fns).contains(where: { calls(stripNote($0), String(word)) }) {
            out.hint = "\(word)(…) is not a built-in function; \(lookupHint)"
          }
        }
      }
      return out
    }
    if !text.contains(where: { !$0.isWhitespace }) { return out }
    if let reason = row.unsupported {
      // (The reason reads "Not supported in the app yet: …".)
      out.warning = "not drawn: \(reason.prefix(1).lowercased())\(reason.dropFirst())"
      return out
    }
    out.kind = row.kind
    if row.comment {
      out.meaning = "group heading; draws nothing"
    } else if let def = row.definition {
      out.meaning = definitionMeaning(def, row)
    } else if let view = row.view {
      out.meaning =
        switch view.kind {
        case "view": "sets the 2D window"
        case "camera": "sets the 3D camera"
        case "grid": "sets what draws behind its panel's plots"
        default: "starts a new panel; the rows below it draw there"
        }
    } else if row.dist != nil {
      out.meaning = row.kind
    } else if let cls = row.classified, let kind = row.kind, let meaning = kindMeanings[kind] {
      // (The row's kind is the object's public kind, as the fixtures hold it.)
      out.meaning =
        meaning + (cls.needs3D && !meaning.contains("3D") ? " (in 3D)" : "")
        + (cls.animated ? "; moves with time t" : "")
    }
    var members: [String] = []
    if case .family(let list)? = row.cpu {
      members = list.map { $0.cpu.type }
    } else if let cpu = row.cpu {
      members = [cpu.type]
    }
    if is3D, row.classified != nil, row.definition == nil, members.allSatisfy(skippedIn3D.contains) {
      out.warning =
        "not drawn: another row makes this graph 3D, and a 3D scene leaves out 2D-only plots like this one"
    }
    if let info = row.info {
      out.value = info
    } else if case .constant(let name, _, _)? = row.definition, let value = env[name] {
      out.value = JS.string(round6(value))
    }
    out.animated = row.classified?.animated == true
    switch row.definition {
    case .constant(let name, _, _)?, .function(let name, _, _)?:
      if row.kind != "definition (point)", usedElsewhere(texts, index, name) == false {
        out.warning = "this defines \(name), but no other row uses it, so nothing is drawn"
      }
    default: break
    }
    return out
  }
}
