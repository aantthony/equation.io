/// CSV/TSV parsing (lib/csv.ts): RFC 4180 for the grammar — quoted fields,
/// "" escapes, embedded commas and newlines, CRLF — plus the pragmatics real
/// files need: a UTF-8 BOM, a delimiter that might be ';' or a tab, header
/// names that have to become identifiers, and cells that are blank or spell
/// "N/A".
///
/// The result is columnar: a column is a list, and `(person.age,
/// person.height)` zips two of them. Nothing here knows about expressions.
/// Text is read by UTF-16 code units, as the site reads it.

/// A table's column: numbers (a missing cell is NaN) or text (a missing cell is "").
public struct CsvColumn: Equatable, Sendable {
  public enum Values: Equatable, Sendable {
    case nums([Double])
    case strs([String])
  }
  /// Identifier used in expressions: `person.age`.
  public var name: String
  /// The header cell as written, for display.
  public var label: String
  public var values: Values

  public static func == (a: CsvColumn, b: CsvColumn) -> Bool {
    guard a.name == b.name, a.label == b.label else { return false }
    switch (a.values, b.values) {
    case (.strs(let x), .strs(let y)): return x == y
    case (.nums(let x), .nums(let y)):
      // (NaN is a missing cell, and equal to itself here.)
      return x.count == y.count && zip(x, y).allSatisfy { $0 == $1 || ($0.isNaN && $1.isNaN) }
    default: return false
    }
  }
}

public struct CsvTable: Equatable, Sendable {
  public var columns: [CsvColumn]
  /// Data rows (the header is not one).
  public var rows: Int
  /// Records dropped for having a different field count than the header.
  public var skipped: Int
  /// Missing/unparsable cells, by column name, in column order.
  public var missing: [(name: String, count: Int)]
  /// The delimiter that was sniffed.
  public var delimiter: String
  /// Human-readable notes: skipped rows, renamed columns, missing cells.
  public var warnings: [String]
  /// Each row's 1-based position among the file's records, when it is not
  /// simply 1…rows: a filtered table keeps the positions its rows had.
  public var positions: [Double]?

  public static func == (a: CsvTable, b: CsvTable) -> Bool {
    a.columns == b.columns && a.rows == b.rows && a.skipped == b.skipped && a.delimiter == b.delimiter
      && a.warnings == b.warnings && a.positions == b.positions
      && a.missing.map(\.name) == b.missing.map(\.name) && a.missing.map(\.count) == b.missing.map(\.count)
  }
}

/// The name under which a table's rows give their position in the file:
/// `row`, unless the file has a column of that name — then `row_index`
/// (`positionColumn`).
public func positionColumn(_ table: CsvTable) -> String? {
  ["row", "row_index"].first { name in !table.columns.contains { $0.name == name } }
}

/// Each row's 1-based position in the file (`rowPositions`).
public func rowPositions(_ table: CsvTable) -> [Double] {
  table.positions ?? (0..<table.rows).map { Double($0 + 1) }
}

private typealias U = [UInt16]
private func text(_ u: U) -> String { String(decoding: u, as: UTF16.self) }
private func trimmed(_ u: U) -> U {
  var (a, b) = (0, u.count)
  while a < b, isJSWhitespace(u[a]) { a += 1 }
  while b > a, isJSWhitespace(u[b - 1]) { b -= 1 }
  return Array(u[a..<b])
}

private let QUOTE = unit("\"")
private let NEWLINE = unit("\n")

/// Delimiters we sniff for, in preference order on a tie.
private let DELIMITERS: [UInt16] = [unit(","), unit("\t"), unit(";")]

/// Cells that mean "no value" rather than a string (case-insensitive).
private let BLANKS: Set<String> = ["", "na", "n/a", "nan", "null", "nil", "none", "-", "--", "?"]

/// Pick the delimiter by counting candidates outside quotes in the first few
/// lines: the count that wins is the one that is both largest and
/// consistent across the sampled lines (`sniffDelimiter`).
public func sniffDelimiter(_ source: String) -> String { text([sniff(Array(source.utf16))]) }

private func sniff(_ u: U) -> UInt16 {
  let sample = 5
  var perLine = [[Int]](repeating: [0], count: DELIMITERS.count)
  var inQuotes = false
  var lines = 1
  var i = 0
  while i < u.count && lines <= sample {
    let c = u[i]
    defer { i += 1 }
    if c == QUOTE {
      // A doubled quote inside a quoted field is an escape, not a toggle.
      if inQuotes && i + 1 < u.count && u[i + 1] == QUOTE { i += 1 } else { inQuotes.toggle() }
      continue
    }
    if inQuotes { continue }
    if c == NEWLINE {
      lines += 1
      for d in perLine.indices { perLine[d].append(0) }
      continue
    }
    if let d = DELIMITERS.firstIndex(of: c) { perLine[d][perLine[d].count - 1] += 1 }
  }
  // The last counter is worth nothing when it is the empty row after a
  // trailing newline, or a record the sample limit cut in half — but a file
  // with no trailing newline ends on a real record.
  let partial = i < u.count || u.last == NEWLINE
  func pick(_ skipFirst: Bool) -> (d: UInt16, even: Bool)? {
    var best: (d: UInt16, even: Bool)?
    var bestCount = 0
    for (k, d) in DELIMITERS.enumerated() {
      let seen = perLine[k]
      let sampled = partial && seen.count > 1 ? Array(seen.dropLast()) : seen
      let full = skipFirst ? Array(sampled.dropFirst()) : sampled
      guard let first = full.first, first != 0 else { continue }
      // A real delimiter appears the same number of times in every record,
      // and that outranks appearing often. Count decides only among
      // candidates that are equally (in)consistent.
      let even = full.allSatisfy { $0 == first }
      if best == nil || (even == best!.even ? first > bestCount : even) {
        best = (d, even)
        bestCount = first
      }
    }
    return best
  }
  // Line 1 is not always a record: spreadsheets export a title above the
  // header. A delimiter that lines up across every sampled line is still
  // the answer, so that reading is tried first; only when it is not is the
  // same question asked of the records alone.
  let all = pick(false)
  if let all, all.even { return all.d }
  let body = pick(true)
  if let body, body.even { return body.d }
  return all?.d ?? body?.d ?? unit(",")
}

/// Split text into records of fields (RFC 4180). Blank lines are dropped. A
/// quoted field that never closes is refused: the file is nearly always
/// truncated (`parseRecords`).
public func parseRecords(_ source: String, delimiter: String) throws -> [[String]] {
  try records(Array(source.utf16), delimiter.utf16.first ?? unit(",")).map { $0.map(text) }
}

private func records(_ u: U, _ delimiter: UInt16) throws -> [[U]] {
  var out: [[U]] = []
  var row: [U] = []
  var field: U = []
  var quoted = false
  var started = false  // this record has at least one field
  var explicit = false  // …written as syntax: a quote or a delimiter
  func endRow() {
    if started {
      row.append(field)
      // A line holding nothing is blank and dropped — but `""` is a record
      // of one empty field, and so is anything with a delimiter in it.
      if explicit || !(row.count == 1 && trimmed(row[0]).isEmpty) { out.append(row) }
    }
    row = []
    field = []
    started = false
    explicit = false
  }
  var i = 0
  while i < u.count {
    let c = u[i]
    defer { i += 1 }
    if quoted {
      if c == QUOTE {
        if i + 1 < u.count && u[i + 1] == QUOTE {
          field.append(QUOTE)
          i += 1
        } else {
          quoted = false
        }
      } else {
        field.append(c)
      }
      continue
    }
    if c == QUOTE && trimmed(field).isEmpty {
      // Only a field that has not started yet opens a quote; a stray quote
      // mid-field is data ('5" pipe').
      field = []
      quoted = true
      started = true
      explicit = true
      continue
    }
    if c == delimiter {
      row.append(field)
      field = []
      started = true
      explicit = true
      continue
    }
    if c == unit("\r") { continue }
    if c == NEWLINE {
      endRow()
      continue
    }
    field.append(c)
    started = true
  }
  if quoted { throw LanguageError("A quoted field never closed — the file looks truncated.") }
  endRow()
  return out
}

private func isIdent(_ c: UInt16) -> Bool {
  isDigit(c) || (c >= unit("A") && c <= unit("Z")) || (c >= unit("a") && c <= unit("z")) || c == unit("_")
}

/// `.replace(/[^A-Za-z0-9_]+/g, '_').replace(/^_+|_+$/g, '')`
private func identifier(_ u: U) -> U {
  var out: U = []
  var gap = false
  for c in u {
    if isIdent(c) {
      out.append(c)
      gap = false
    } else if !gap {
      out.append(unit("_"))
      gap = true
    }
  }
  var (a, b) = (0, out.count)
  while a < b, out[a] == unit("_") { a += 1 }
  while b > a, out[b - 1] == unit("_") { b -= 1 }
  return Array(out[a..<b])
}

/// What JavaScript's `name in CONSTANTS` answers yes to: the constants, and
/// what every object inherits.
private let CONSTANT_KEYS: Set<String> = Set(constants.keys).union([
  "constructor", "toString", "valueOf", "hasOwnProperty", "isPrototypeOf", "propertyIsEnumerable", "toLocaleString",
  "__proto__", "__defineGetter__", "__defineSetter__", "__lookupGetter__", "__lookupSetter__",
])

/// Turn a header cell into an identifier usable after a dot (`toIdent`).
private func toIdent(_ label: U, _ index: Int) -> String {
  var name = text(identifier(trimmed(label)))
  if name.isEmpty { name = "col\(index + 1)" }
  if let first = name.utf16.first, isDigit(first) { name = "c\(name)" }
  // `people.e` would read the constant e, not a column, so nudge the name.
  if CONSTANT_KEYS.contains(name) { name += "_" }
  return name
}

private func isBlankCell(_ s: U) -> Bool { BLANKS.contains(text(trimmed(s)).lowercased()) }

/// A cursor over a cell, for the number forms below.
private struct Cell {
  var u: U
  var i = 0
  var done: Bool { i == u.count }
  mutating func eat(_ c: Unicode.Scalar) -> Bool {
    if i < u.count, u[i] == unit(c) {
      i += 1
      return true
    }
    return false
  }
  mutating func sign() { if !eat("+") { _ = eat("-") } }
  /// How many digits were read.
  mutating func digits() -> Int {
    let start = i
    while i < u.count, isDigit(u[i]) { i += 1 }
    return i - start
  }
}

/// `^[+-]?\d{1,3}(G\d{3})+(P\d+)?$`: digits grouped in threes by `group`,
/// with an optional fraction after `point`.
private func isGrouped(_ t: U, group: Unicode.Scalar, point: Unicode.Scalar) -> Bool {
  var c = Cell(u: t)
  c.sign()
  let lead = c.digits()
  if lead < 1 || lead > 3 { return false }
  var groups = 0
  while c.eat(group) {
    if c.digits() != 3 { return false }
    groups += 1
  }
  if groups == 0 { return false }
  if c.eat(point), c.digits() < 1 { return false }
  return c.done
}

/// `^[+-]?\d+,\d+$`
private func isCommaDecimal(_ t: U) -> Bool {
  var c = Cell(u: t)
  c.sign()
  if c.digits() < 1 || !c.eat(",") || c.digits() < 1 { return false }
  return c.done
}

/// `^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$`
private func isPlainNumber(_ t: U) -> Bool {
  var c = Cell(u: t)
  c.sign()
  if c.digits() > 0 {
    if c.eat(".") { _ = c.digits() }
  } else {
    if !c.eat(".") || c.digits() < 1 { return false }
  }
  if c.eat("e") || c.eat("E") {
    c.sign()
    if c.digits() < 1 { return false }
  }
  return c.done
}

/// Numeric reading of a cell, or NaN. Accepts a leading '+', thousands
/// separators, and a trailing '%' (scaled). `decimalComma` says the column
/// writes 1,5 for one and a half (`cellNumber`).
public func cellNumber(_ s: String, decimalComma: Bool = false) -> Double {
  cellNumber(Array(s.utf16), decimalComma)
}

private func cellNumber(_ s: U, _ decimalComma: Bool) -> Double {
  var t = trimmed(s)
  if t.isEmpty { return .nan }
  var scale = 1.0
  if t.last == unit("%") {
    scale = 0.01
    t = trimmed(Array(t.dropLast()))
  }
  if decimalComma {
    // 1.234.567,89 — dots group, the comma is the point.
    if isGrouped(t, group: ".", point: ",") {
      t = t.filter { $0 != unit(".") }.map { $0 == unit(",") ? unit(".") : $0 }
    } else if isCommaDecimal(t) {
      t = t.map { $0 == unit(",") ? unit(".") : $0 }
    }
  } else if isGrouped(t, group: ",", point: ".") {
    t = t.filter { $0 != unit(",") }
  }
  if !isPlainNumber(t) { return .nan }
  return JS.number(text(t)) * scale
}

/// Parse a CSV document. The first record is the header; every later record
/// with the header's field count becomes a row. A column whose non-blank
/// cells all read as numbers is numeric (blanks become NaN); everything else
/// is text (`parseCsv`).
public func parseCsv(_ source: String) throws -> CsvTable {
  var u = Array(source.utf16)
  if u.first == 0xFEFF { u.removeFirst() }
  let delimiter = sniff(u)
  let all = try records(u, delimiter)
  if all.isEmpty { throw LanguageError("That file has no rows.") }
  var warnings: [String] = []
  // A single-field line above the header is a title, not a record: dropped,
  // but only when the lines below agree on a wider shape.
  let titled =
    all.count > 2 && all[0].count == 1 && all[1].count > 1
    && Double(all.filter { $0.count == all[1].count }.count) > Double(all.count) / 2
  if titled { warnings.append("1 title line above the header ignored") }
  let first = titled ? 1 : 0
  let header = all[first]

  var names: [String] = []
  var used: Set<String> = []
  var renamed = 0
  for (k, label) in header.enumerated() {
    let base = toIdent(label, k)
    var name = base
    var n = 2
    while used.contains(name) {
      name = "\(base)_\(n)"
      n += 1
    }
    used.insert(name)
    if name != text(trimmed(label)) { renamed += 1 }
    names.append(name)
  }
  if renamed > 0 { warnings.append("\(renamed) column name\(renamed == 1 ? "" : "s") adjusted to fit expressions") }

  var body: [[U]] = []
  var skipped = 0
  for record in all.dropFirst(first + 1) {
    if record.count != header.count {
      skipped += 1
      continue
    }
    body.append(record)
  }
  if skipped > 0 { warnings.append("\(skipped) row\(skipped == 1 ? "" : "s") skipped (wrong number of columns)") }

  var missing: [(name: String, count: Int)] = []
  // Cells whose comma was read as a decimal point — said out loud below,
  // because the other reading would have been 1000× larger.
  var pointedByComma = 0
  var columns: [CsvColumn] = []
  for (c, name) in names.enumerated() {
    let cells = body.map { $0[c] }
    // Tabs and semicolons do not imply a numeric locale: an actual
    // comma-form number in this column is required before dots are grouping.
    let decimalComma =
      delimiter != unit(",")
      && cells.contains { cell in
        var value = trimmed(cell)
        if value.last == unit("%") { value = trimmed(Array(value.dropLast())) }
        // ^[+-]?(?:\d+|\d{1,3}(?:\.\d{3})+),\d+$
        if isCommaDecimal(value) { return true }
        guard let comma = value.lastIndex(of: unit(",")) else { return false }
        let fraction = value[(comma + 1)...]
        return !fraction.isEmpty && fraction.allSatisfy(isDigit)
          && isGrouped(Array(value[..<comma]), group: ".", point: ",")
      }
    var numeric = !cells.isEmpty
    var seen = 0
    for cell in cells where !isBlankCell(cell) {
      seen += 1
      if cellNumber(cell, decimalComma).isNaN {
        numeric = false
        break
      }
    }
    if seen == 0 { numeric = false }  // an all-blank column is text, not a run of NaN
    let label = text(trimmed(header[c]))
    if !numeric {
      // A gap is a gap in a text column too: stored as the empty string,
      // and counted like any other missing value.
      var blanks = 0
      let strs = cells.map { s -> String in
        if !isBlankCell(s) { return text(trimmed(s)) }
        blanks += 1
        return ""
      }
      if blanks > 0 { missing.append((name, blanks)) }
      columns.append(CsvColumn(name: name, label: label, values: .strs(strs)))
      continue
    }
    var gaps = 0
    let nums = cells.map { cell -> Double in
      let v = isBlankCell(cell) ? Double.nan : cellNumber(cell, decimalComma)
      if v.isNaN { gaps += 1 } else if decimalComma && cell.contains(unit(",")) { pointedByComma += 1 }
      return v
    }
    if gaps > 0 { missing.append((name, gaps)) }
    columns.append(CsvColumn(name: name, label: label, values: .nums(nums)))
  }

  if pointedByComma > 0 {
    let named = delimiter == unit("\t") ? "tabs" : "\"\(text([delimiter]))\""
    warnings.append(
      "\(pointedByComma) value\(pointedByComma == 1 ? "" : "s") read with ',' as the decimal point"
        + " (the file separates its columns with \(named))")
  }
  if !missing.isEmpty {
    let total = missing.reduce(0) { $0 + $1.count }
    warnings.append(
      "\(total) missing value\(total == 1 ? "" : "s") in \(missing.map(\.name).joined(separator: ", "))")
  }
  return CsvTable(
    columns: columns, rows: body.count, skipped: skipped, missing: missing, delimiter: text([delimiter]),
    warnings: warnings, positions: nil)
}

/// A table of the rows a mask keeps — `adults = person[person.age >= 18]`.
/// Every column is filtered together, so the rows stay aligned; missing-value
/// counts are recomputed (`filterTable`).
public func filterTable(_ table: CsvTable, keep: [Bool]) -> CsvTable {
  let rows = keep.filter { $0 }.count
  var missing: [(name: String, count: Int)] = []
  func kept<T>(_ values: [T]) -> [T] {
    values.enumerated().filter { $0.offset < keep.count && keep[$0.offset] }.map(\.element)
  }
  let columns = table.columns.map { col -> CsvColumn in
    var col = col
    switch col.values {
    case .strs(let all):
      let strs = kept(all)
      let gaps = strs.filter(\.isEmpty).count
      if gaps > 0 { missing.append((col.name, gaps)) }
      col.values = .strs(strs)
    case .nums(let all):
      let nums = kept(all)
      let gaps = nums.filter(\.isNaN).count
      if gaps > 0 { missing.append((col.name, gaps)) }
      col.values = .nums(nums)
    }
    return col
  }
  let warnings =
    missing.isEmpty
    ? []
    : ["\(missing.reduce(0) { $0 + $1.count }) missing values in \(missing.map(\.name).joined(separator: ", "))"]
  return CsvTable(
    columns: columns, rows: rows, skipped: 0, missing: missing, delimiter: table.delimiter, warnings: warnings,
    positions: kept(rowPositions(table)))
}

/// Suggest a row name from a file name: "people 2024.csv" → "people_2024"
/// (`tableNameFor`).
public func tableNameFor(_ fileName: String) -> String {
  var stem = Array(fileName.utf16)
  // `.replace(/\.[^.]*$/, '')`: the last dot and what follows it.
  if let dot = stem.lastIndex(of: unit(".")) { stem = Array(stem[..<dot]) }
  let bare = text(identifier(trimmed(stem)))
  if bare.isEmpty { return "data" }
  // Identifiers cannot start with a digit ("2024.csv" → data_2024).
  return isDigit(bare.utf16.first!) ? "data_\(bare)" : bare
}
