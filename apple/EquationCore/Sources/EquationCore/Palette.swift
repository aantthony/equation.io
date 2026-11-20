/// Row colors: the palettes, which rows take a color from them, and which
/// slot each takes (lib/palette.ts). The site, its share image and the app
/// all color through the same rules, so a shared link opens in the colors
/// its preview showed.

/// Row colors on the light theme, in the order a document's rows take them.
public let lightPalette: [SIMD3<Float>] = [
  [0.176, 0.439, 0.702],  // blue
  [0.78, 0.267, 0.251],  // red
  [0.22, 0.549, 0.275],  // green
  [0.376, 0.259, 0.651],  // purple
  [0.98, 0.494, 0.098],  // orange
  [0.0, 0.0, 0.0],  // black
]

/// The same slots on the dark theme.
public let darkPalette: [SIMD3<Float>] = [
  [0.4, 0.62, 0.92],  // blue
  [0.92, 0.45, 0.42],  // red
  [0.42, 0.78, 0.48],  // green
  [0.65, 0.52, 0.95],  // purple
  [0.98, 0.62, 0.28],  // orange
  [0.9, 0.91, 0.93],  // light (stands in for black)
]

/// What `takesColor` reads of a row's plan (lib/compiler.ts `CpuPlan`): only
/// the kinds that draw nothing in a color are told apart.
public enum ColorPlan: Equatable, Sendable {
  /// A row that only says something (`e = 2` is a false claim, and says so).
  case note
  /// A panel's metric row.
  case metric
  /// A value row shows only its readout, unless it shades a region (an integral's area).
  case value(shade: Bool)
  /// Any plan that draws.
  case other
}

/// The facts about a row that decide whether it shows a palette color
/// (lib/palette.ts `ColorRow`). The row's text supplies two of them: whether
/// it is blank, and whether its note picks a color of its own.
public struct ColorRow: Equatable, Sendable {
  public var text: String
  /// A `# heading` row.
  public var comment: Bool
  /// The row is a definition.
  public var def: Bool
  /// The row names a point (`A = (1, 2)`): a definition, but it draws a dot.
  public var point: Bool
  /// A view, camera, grid or `---` divider row.
  public var view: Bool
  /// What the row compiles to, or nil when it has no plan (an error, usually).
  public var plan: ColorPlan?

  public init(
    text: String, comment: Bool = false, def: Bool = false, point: Bool = false, view: Bool = false,
    plan: ColorPlan? = nil
  ) {
    self.text = text
    self.comment = comment
    self.def = def
    self.point = point
    self.view = view
    self.plan = plan
  }
}

/// Whether a row shows a palette color. Blank rows, definitions (other than
/// named points), comments, view/camera/grid rows and `---` dividers draw
/// nothing, a value row shows only its readout, and a `#hex` note picks its
/// own color, so none of them use up a slot. A row with an error does: it is
/// usually a curve being typed.
public func takesColor(_ row: ColorRow) -> Bool {
  let blank = row.text.utf16.allSatisfy(isJSWhitespace)
  if blank || row.comment || (row.def && !row.point) || row.view || noteColor(row.text) != nil { return false }
  switch row.plan {
  case .note, .metric, .value(shade: false): return false
  default: return true
  }
}

/// Give each row that takes a color (`takes[i]`) but has none
/// (`colorIndex[i] < 0`) a palette slot, in document order, and clear the
/// slot of rows that don't. A new row takes the slot the fewest colored rows
/// use; on a tie, one its nearest colored neighbours above and below don't
/// use; then the earliest. So a freshly loaded document runs through the
/// palette in order, and a row added later fills a gap rather than repeating
/// the row beside it.
public func assignColors(_ colorIndex: inout [Int], takes: [Bool], size: Int) {
  var counts = [Int](repeating: 0, count: max(size, 0))
  for i in colorIndex.indices {
    if takes[i] && colorIndex[i] >= 0 && colorIndex[i] < size {
      counts[colorIndex[i]] += 1
    } else {
      colorIndex[i] = -1
    }
  }
  // The nearest colored row below each row, found before any are assigned:
  // rows still waiting for a slot are passed over.
  var below = [Int](repeating: -1, count: colorIndex.count)
  var next = -1
  for i in colorIndex.indices.reversed() {
    below[i] = next
    if colorIndex[i] >= 0 { next = colorIndex[i] }
  }
  var above = -1
  for i in colorIndex.indices where takes[i] {
    if colorIndex[i] < 0 {
      // An empty palette has no slot to give.
      guard let fewest = counts.min() else { continue }
      var pick = -1
      for s in 0..<size where counts[s] == fewest {
        if pick < 0 { pick = s }
        if s != above && s != below[i] {
          pick = s
          break
        }
      }
      colorIndex[i] = pick
      counts[pick] += 1
    }
    above = colorIndex[i]
  }
}

/// `assignColors` for a document whose rows have stable ids: each row's slot
/// in document order (-1 for a row that takes none), given the slots the
/// rows had before this edit. A row not in `previous` is new.
public func assignColors<ID: Hashable>(
  rows: [(id: ID, takes: Bool)], previous: [ID: Int], size: Int
) -> [Int] {
  var colorIndex = rows.map { previous[$0.id] ?? -1 }
  assignColors(&colorIndex, takes: rows.map(\.takes), size: size)
  return colorIndex
}
