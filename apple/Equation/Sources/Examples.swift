import SwiftUI

/// The web app's examples (web/examples.ts), bundled as Web/examples.json by
/// `pnpm app:web`.
struct ExampleCategory: Decodable, Identifiable {
  var name: String
  var examples: [Example]
  var id: String { name }

  struct Example: Decodable, Identifiable {
    var label: String
    var rows: [String]
    var tags: [String]
    var id: String { label }
  }

  static let all: [ExampleCategory] = {
    guard let url = Bundle.main.resourceURL?.appending(path: "Web/examples.json"),
      let data = try? Data(contentsOf: url),
      let categories = try? JSONDecoder().decode([ExampleCategory].self, from: data)
    else { return [] }
    return categories
  }()
}

/// The examples, a submenu per category. Opening one replaces the graph in
/// the front window, as on the site; undo brings the old one back.
struct ExamplesMenu: View {
  var open: ([String]) -> Void

  var body: some View {
    ForEach(ExampleCategory.all) { category in
      Menu(category.name) {
        ForEach(category.examples) { example in
          Button(example.label) { open(example.rows) }
        }
      }
    }
  }
}

