import Foundation

/// An example the assistant is shown: its rows, then what it is.
struct LabelledRows: Decodable, Sendable {
  var label: String
  var rows: [String]
}

/// What the lookups answer from, assistant.json (lib/reference.ts
/// `AssistantData`): the kinds by group with their smallest forms, worked
/// examples by kind and by function, notes on functions, and named shapes.
struct AssistantData: Decodable, Sendable {
  var groups: [Group]
  var kinds: [String: [LabelledRows]]
  var functions: [String: [LabelledRows]]
  var notes: [String: String]
  /// Named curves and surfaces (docs/reference/shapes.md), for the shape tool.
  var shapes: [Shape]

  struct Group: Decodable, Sendable {
    var name: String
    /// list_kinds names these kinds without their forms.
    var brief: Bool
    var kinds: [Kind]
  }

  struct Kind: Decodable, Sendable {
    var kind: String
    var title: String
    /// The smallest form, rows separated by `;`.
    var form: String
    /// What it draws, in a few words.
    var short: String
  }

  struct Shape: Decodable, Sendable {
    var name: String
    var aliases: [String]
    /// What it is, in a sentence or two.
    var intro: String
    var forms: [Form]
    var pitfall: String?
  }

  /// One form of a named shape: its rows in named parameters, and an
  /// instance with numbers.
  struct Form: Decodable, Sendable {
    var kind: String
    var rows: [String]
    var note: String?
    /// Each parameter's name and what it sets, a pair.
    var params: [[String]]
    var example: Instance
  }

  /// The instance: its parameters' values (`a = 3, c = 2`), its rows and a note.
  struct Instance: Decodable, Sendable {
    var values: String?
    var rows: [String]
    var note: String?
  }
}

/// language.json (apple/tools/app-data.ts `languageData`): what
/// lib/assistant-tools.ts reads from the language rather than the reference.
struct LanguageData: Decodable, Sendable {
  var builtins: Table
  /// lib/assistant-tools.ts `KIND_MEANINGS`: what each kind draws.
  var kindMeanings: [String: String]
  /// Each kind's smallest form as rows (lib/statements.ts `splitStatements`).
  var forms: [String: [String]]

  /// lib/assistant-tools.ts `builtinTable`.
  struct Table: Decodable, Sendable {
    /// Every name `builtinHelp` describes, in `builtinNames`' order.
    var names: [String]
    /// The parser's functions (lib/expr.ts `FUNCTIONS`).
    var functions: [String]
    /// A signature and a description, by function or call form.
    var signatures: [String: [String]]
    /// Each distribution's name and aliases, lower case, with its family's name.
    var distributions: [String: String]
    /// `names` as `localeCompare` orders them where the data was built.
    var sorted: [String]
  }
}

/// The function table, read as lib/assistant-tools.ts `builtinHelp` reads it.
struct Builtins: Sendable {
  struct Help: Sendable {
    var signature: String
    var description: String
  }

  let names: [String]
  private let functions: Set<Exact>
  private let signatures: [Exact: [String]]
  private let distributions: [Exact: String]
  /// Each name's place in `localeCompare`'s order, which breaks a tie in
  /// search_functions: collation is the platform's, so the order is data.
  let rank: [Exact: Int]

  init(_ table: LanguageData.Table) {
    names = table.names
    functions = Set(table.functions.map(Exact.init))
    signatures = exact(table.signatures)
    distributions = exact(table.distributions)
    rank = Dictionary(table.sorted.enumerated().map { (Exact($1), $0) }, uniquingKeysWith: { first, _ in first })
  }

  /// `builtinHelp(name)`: a built-in function's signature and description.
  /// Case folds as the parser folds it (`Sin` is sin); the call forms that
  /// are not functions (P, view) are exact, and a distribution answers to
  /// its name or an alias in any capitalization.
  func help(_ name: String) -> Help? {
    let lower = JS.lower(name)
    let key: String
    if functions.contains(Exact(name)) {
      key = name
    } else if functions.contains(Exact(lower)) {
      key = lower
    } else if signatures[Exact(name)] != nil {
      key = name
    } else if let family = distributions[Exact(lower)] {
      key = family
    } else {
      return nil
    }
    guard let entry = signatures[Exact(key)], entry.count == 2 else {
      return Help(signature: "\(key)(x)", description: "Built-in function")
    }
    return Help(signature: entry[0], description: entry[1])
  }
}
