/// Data files (lib/defs.ts, the parts about `open(…)` rows): a row like
/// `person = open("people.csv", 3a7f9c…)` names a table, whose columns are
/// lists (`person.age`), and `adults = person[person.age >= 18]` names a cut
/// of one.
///
/// A row carries the file's identity — its name and a prefix of its SHA-256 —
/// and never its bytes. The bytes come from whoever analyzes the document
/// (`DataFiles`); a row whose file is not among them is not an error but a
/// row that needs its file (`RowAnalysis.dataLocal`), and so is every row
/// that reads it.

/// A data file as a document reads it: the name it was stored under and what
/// lib/csv.ts made of its text (web/filestore.ts `LoadedFile`).
public struct DataFile: Sendable {
  public var name: String
  public var table: CsvTable

  public init(name: String, table: CsvTable) {
    self.name = name
    self.table = table
  }
}

/// The data files on hand, by the full SHA-256 (lowercase hex) of their bytes
/// (web/filestore.ts `memory`). The analysis only reads it.
public struct DataFiles: Sendable {
  /// The hashes in the order the files arrived, the newest last.
  public private(set) var hashes: [String] = []
  private var files: [String: DataFile] = [:]

  public init() {}

  public var isEmpty: Bool { hashes.isEmpty }

  public subscript(hash: String) -> DataFile? { files[hash] }

  /// Keep a file under its hash; one already there is the newest again.
  public mutating func add(_ file: DataFile, hash: String) {
    hashes.removeAll { $0 == hash }
    hashes.append(hash)
    files[hash] = file
  }

  public mutating func remove(hash: String) {
    hashes.removeAll { $0 == hash }
    files[hash] = nil
  }

  /// The file a row names (web/filestore.ts `lookup`): by the prefix of its
  /// hash the row pins, or — for a row that pins none, as typed by hand — the
  /// newest file of that name.
  public func lookup(file: String, hash: String) -> (hash: String, file: DataFile)? {
    if !hash.isEmpty {
      return hashes.first { $0.hasPrefix(hash) }.map { ($0, files[$0]!) }
    }
    return hashes.last { files[$0]!.name == file }.map { ($0, files[$0]!) }
  }
}

extension DataFiles: Equatable {
  /// A file is its hash: the same hashes under the same names are the same files.
  public static func == (a: DataFiles, b: DataFiles) -> Bool {
    a.hashes == b.hashes && a.hashes.allSatisfy { a.files[$0]!.name == b.files[$0]!.name }
  }
}

/// A table by name: its file, the hash its row pins, and its data when the
/// file is on hand (lib/defs.ts `TableDef`).
struct TableDef: Equatable {
  var file: String
  var hash: String
  var data: CsvTable?
  /// Why `data` is nil, phrased for wherever this ran.
  var missing: String?
}

/// A name whose definition wanted a file that is not here (lib/defs.ts
/// `missingData`): what to say of it, and whether it reads as a list.
struct MissingValue: Equatable {
  var message: String
  var list: Bool
}

/// Rows one data file may plot (`TABLE_MAX_ROWS`). A column reaches the
/// renderer as its own array with nothing to evaluate per point, so this is a
/// drawing limit; combining a column with t or a slider still expands it to
/// one expression per row, which Lists.swift caps separately (`ITEMS_MAX`).
public let TABLE_MAX_ROWS = 200_000

/// Points a row may put in a 3D scene (web/session.ts `CLOUD_3D_MAX`): each is
/// a sprite, sorted by depth every frame, where a flat cloud is binned.
public let CLOUD_3D_MAX = 10_000

/// The error of a row that needs data this device does not have (lib/defs.ts
/// `MissingDataError`): an error like any other to what catches it on the way,
/// and to the row not a mistake but a file to supply.
func missingDataError(_ message: String) -> LanguageError {
  var error = LanguageError(message)
  error.missingData = true
  return error
}

// MARK: - Rows

/// The name a file is stored and written under (`rowSafeFileName`). A row
/// quotes the file name with no escape, so a name holding a quote or a line
/// break could not be read back.
public func rowSafeFileName(_ name: String) -> String {
  var out: Units = []
  var run = false
  for c in name.utf16 {
    // `/["\r\n\t]+/g`: a run of them is one underscore.
    if c == unit("\"") || c == 0x0D || c == 0x0A || c == 0x09 {
      if !run { out.append(unit("_")) }
      run = true
    } else {
      out.append(c)
      run = false
    }
  }
  let trimmed = jsTrimmed(String(decoding: out, as: UTF16.self))
  return trimmed.isEmpty ? "data.csv" : trimmed
}

/// How an `open(…)` row is written, for the app's write-back (`formatTableRow`).
public func formatTableRow(name: String, file: String, hash: String) -> String {
  "\(name) = open(\"\(rowSafeFileName(file))\"\(hash.isEmpty ? "" : ", \(shortHash(hash))"))"
}

/// A definable name for a dropped file, starting from the one its file name
/// suggests (`freeTableName`): the stem itself where a definition may claim
/// it, `data_…` where it may not, then numbered until nothing else has it.
public func freeTableName(_ base: String, taken: Set<String>) -> String {
  let stem = nameable(base) ? base : "data_\(base)"
  if !taken.contains(stem) { return stem }
  var k = 2
  while taken.contains("\(stem)_\(k)") { k += 1 }
  return "\(stem)_\(k)"
}

/// What an `open(…)` row says of its file, when it is one: the name it
/// defines, the file, and the hash it pins ("" when it pins none).
public func tableRow(_ text: String) -> (name: String, file: String, hash: String)? {
  guard case .table(let name, let file, let hash)? = scanDefinition(jsTrimmed(stripNote(text))) else { return nil }
  return (name, file, hash)
}

/// The name a row defines, whatever it defines: what a new table's name must
/// not collide with (web/main.ts `rowNameFor`).
public func definedName(_ text: String) -> String? {
  scanDefinition(jsTrimmed(stripNote(text)))?.name
}

/// A row that means to open a file but cannot (`badTableRow`): it claims a
/// name it may not have (`w`, `e`, `open` itself), or pins a hash too short
/// to identify one file. Nil for any other row.
func badTableRow(_ text: String) -> String? {
  let u = asAssignment(Array(text.utf16))
  guard let open = scanOpen(u) else { return nil }
  if !nameable(open.name) {
    return "\(open.name) is a built-in name, so it cannot name a data file — try \(open.name)_data = open(…)."
  }
  if open.wellFormed { return nil }
  // `/,\s*([0-9a-fA-F]+)\s*\)\s*$/`: the hex digits a row ends with.
  var i = u.count
  func back(while test: (UInt16) -> Bool) { while i > 0, test(u[i - 1]) { i -= 1 } }
  back(while: isJSWhitespace)
  if i > 0, u[i - 1] == unit(")") {
    i -= 1
    back(while: isJSWhitespace)
    let end = i
    back { isDigit($0) || (0x61...0x66).contains($0 | 0x20) }
    let digits = end - i
    back(while: isJSWhitespace)
    if digits > 0, i > 0, u[i - 1] == unit(","), digits < HASH_TOKEN_LEN {
      return "A data file's hash is \(HASH_TOKEN_LEN) hex digits; that is \(digits)."
        + " Delete it and the app will fill in the right one."
    }
  }
  // Something else malformed: the only explanation the row will get, since
  // the expression parser only knows quotes are not arithmetic.
  return "A data file row reads \(open.name) = open(\"file.csv\")"
    + ", with an optional \(HASH_TOKEN_LEN)-digit hash after the name."
}

func refuseBadTableRow(_ text: String) throws {
  if let badRow = badTableRow(text) { throw LanguageError(badRow) }
}

/// A table row's readout: how many rows, the columns, and what the parser
/// remarked on (lib/analysis.ts `prepareDocument`).
func tableInfo(_ data: CsvTable) -> String {
  let cols = data.columns.map { column -> String in
    if case .nums = column.values { column.name } else { "\(column.name) (text)" }
  }
  return (["\(data.rows) rows", cols.joined(separator: ", ")] + data.warnings).joined(separator: " · ")
}

/// What the definitions say of the rows that are data files' (lib/analysis.ts
/// `prepareDocument`): a definition that failed only for want of its file is
/// not a broken row — its message is its `dataLocal`, not its error — and a
/// table's row reads out what was parsed. Returns the names tables add to
/// those that index (`tableListNames`), and the tables' own.
func tableRows(
  _ built: BuiltDefs, owner: [String: Int], blocked: [Int: String], _ rows: inout [RowAnalysis]
) -> (indexing: Set<String>, tables: Set<String>) {
  for key in built.needsFile {
    guard let i = owner[key], blocked[i] == nil, let message = rows[i].error else { continue }
    rows[i].dataLocal = message
    rows[i].error = nil
  }
  for (name, table) in built.tables.entries {
    guard let i = owner[name], blocked[i] == nil, rows[i].error == nil, let data = table.data else { continue }
    rows[i].info = tableInfo(data)
  }
  return (tableListNames(built), Set(built.tables.keys))
}

// MARK: - Definitions

/// An `open(…)` row's table (lib/defs.ts `buildDefs`, `d.kind === 'table'`).
/// The data never comes from the document, so there is nothing to resolve:
/// the file is looked up and registered — also when its bytes are missing, so
/// the rows that read its columns report the file rather than an unknown
/// name. `files` nil means no device data at all (a link read elsewhere).
func openTable(_ name: String, _ file: String, _ hash: String, _ files: DataFiles?, _ defs: inout BuiltDefs) throws {
  let data = files?.lookup(file: file, hash: hash)?.file.table
  let named = hash.isEmpty ? file : "\(file) (\(shortHash(hash)))"
  let missing =
    data != nil
    ? nil
    : files != nil
      ? "\(named) is not on this device — drop the file here to load it."
      : "\(named) is not on this device — its data does not travel in the link."
  defs.tables[name] = TableDef(file: file, hash: hash, data: data, missing: missing)
  if let missing, files != nil { throw missingDataError(missing) }
}

private func tooManyRows(_ table: TableDef, _ rows: Int) -> LanguageError {
  LanguageError("\(table.file) has \(rows) rows; plotting is limited to \(TABLE_MAX_ROWS).")
}

/// Character counts of a text column, a missing cell with none (`textLengths`).
private func textLengths(_ strs: [String]) -> [Double] {
  // CSV blanks are missing values, not empty strings to count as zero.
  // (Unicode code points, not UTF-16 units.)
  strs.map { $0.isEmpty ? .nan : Double($0.unicodeScalars.count) }
}

/// What lib/defs.ts `listGetter` makes of a name that is not a named list: a
/// name whose file is absent, a data file on its own, or a column written
/// `table.column`. Nil when the name has nothing to do with a table. Throws
/// (rather than returning nil) when the name clearly means a column but
/// cannot produce one, so the row explains itself.
func tableColumn(_ defs: BuiltDefs, _ name: String) throws -> Low? {
  // Any name whose definition wanted an absent file reports the file: being
  // a list or not decides how the name parses, not whether a row using it
  // gets a straight answer.
  if let absent = defs.missingData[name] { throw missingDataError(absent.message) }
  let u = Array(name.utf16)
  guard let dot = u.firstIndex(of: unit(".")), dot > 0 else {
    // A data file is not a value on its own: it is where columns live.
    guard let bare = defs.tables[name] else { return nil }
    let col = bare.data?.columns.first { if case .nums = $0.values { true } else { false } }?.name
    throw LanguageError(
      "\(name) is a data file — plot one of its columns\(col.map { ", like \(name).\($0)" } ?? ""),"
        + " or name a filtered copy: adults = \(name)[…].")
  }
  let head = String(decoding: u[..<dot], as: UTF16.self)
  guard let table = defs.tables[head] else { return nil }
  let path = String(decoding: u[(dot + 1)...], as: UTF16.self)
  let length = path.hasSuffix(".length")
  let col = length ? String(path.dropLast(".length".count)) : path
  guard let data = table.data else { throw missingDataError(table.missing ?? "\(table.file) is not loaded.") }
  // Every column of one file runs over the same instances — its rows — so
  // (person.age, person.height) pairs up however the columns are combined.
  let rows = [Axis(id: "\(head).", n: data.rows)]
  guard let found = data.columns.first(where: { $0.name == col }) else {
    // Every row's position in the file: `person.row`.
    if !length, col == positionColumn(data) { return Low(.data(values: rowPositions(data)), rows) }
    throw LanguageError(
      "\(table.file) has no column \"\(col)\" (columns: \(data.columns.map(\.name).joined(separator: ", "))).")
  }
  switch found.values {
  case .strs(let strs):
    if length {
      if data.rows > TABLE_MAX_ROWS { throw tooManyRows(table, data.rows) }
      return Low(.data(values: textLengths(strs)), rows)
    }
    // A text column is a list too — of text. Only comparisons accept one;
    // everything numeric says so where it is used.
    return Low(.text(values: strs), rows)
  case .nums(let nums):
    if length {
      throw LanguageError(
        "\(name) counts characters — \(String(name.dropLast(".length".count))) is a numeric column.")
    }
    if data.rows > TABLE_MAX_ROWS { throw tooManyRows(table, data.rows) }
    return Low(.data(values: nums), rows)
  }
}

/// The names tables add to those that read as lists (lib/defs.ts
/// `listNamesOf`): a table (a data file is indexed by a filter), each of its
/// columns, its rows' positions — and a list whose file is elsewhere, which
/// still indexes: a row must parse the same way on every device.
func tableListNames(_ defs: BuiltDefs) -> Set<String> {
  var out: Set<String> = []
  for (name, m) in defs.missingData.entries where m.list { out.insert(name) }
  for (name, t) in defs.tables.entries {
    out.insert(name)
    guard let data = t.data else { continue }
    for c in data.columns { out.insert("\(name).\(c.name)") }
    if let row = positionColumn(data) { out.insert("\(name).\(row)") }
  }
  return out
}

/// A whole-plot form with a list inside it — `domain(person.age)`, and the
/// geometry statements — named as list lowering names it when the bytes are
/// here (`wholePlotOverList`). Answered from the shape alone, so
/// `person[domain(person.age) > 0]` is refused on the device that cannot
/// lower it as well as on the one that can.
func wholePlotOverList(_ e: Expr, _ defs: BuiltDefs) -> String? {
  if case .call(let name, let args) = e {
    if NO_LIST_INSIDE.contains(name), args.contains(where: { staysList($0, defs) }) { return plainFnName(name) }
    for a in args {
      if let hit = wholePlotOverList(a, defs) { return hit }
    }
    return nil
  }
  for k in childrenOf(e) {
    if let hit = wholePlotOverList(k, defs) { return hit }
  }
  return nil
}

/// A mask is a list of comparisons, so a filter condition has to be one
/// (`isComparison`): `person[5]`, `person[person.age]` are values.
private func isComparison(_ e: Expr) -> Bool {
  switch e {
  case .ineq, .eqtest: true
  default: false
  }
}

/// The two sides of each comparison a condition makes.
private func comparisonOperands(_ cond: Expr) -> [Expr] {
  switch cond {
  case .ineq: ineqComparisons(cond).flatMap { [$0.l, $0.r] }
  case .eqtest(_, let a, let b): [a, b]
  default: []
  }
}

/// What a filter can be judged without reading a single row: that it is a
/// comparison over a list, and that it could ever settle (`checkFilterShape`).
/// Which rows it keeps needs the file; the two answers must agree, or a
/// shared link is valid only on the device that has the bytes.
private func checkFilterShape(_ cond: Expr, _ defs: BuiltDefs, _ shape: String) throws {
  if !isComparison(cond) { throw LanguageError(shape) }
  if let inside = wholePlotOverList(cond, defs) { throw LanguageError("Lists cannot appear inside \(inside)(…).") }
  // …and a list has to reach it. Merely mentioning one is not enough:
  // `person[mean(person.age) > 0]` decides one answer for every row.
  if !comparisonOperands(cond).contains(where: { staysList($0, defs) }) { throw LanguageError(shape) }
  if freeVars(cond).contains("t") {
    throw LanguageError("A filter cannot depend on t — the list would change length every frame.")
  }
}

/// A definition that filters a whole data file: `adults = person[cond]`
/// (`filteredTable`). Recognized before list lowering, which knows only about
/// values — the result is a new table, with every column cut to the rows the
/// mask keeps. Nil when the row is not that shape.
func filteredTable(_ e: Expr, _ defs: BuiltDefs, _ opts: ResolveOpts) throws -> TableDef? {
  guard case .index(.var(let name), let cond) = e, let src = defs.tables[name] else { return nil }
  let shape = "\(name)[…] needs a comparison, like \(name)[\(name).x > 0]."
  // Judged by shape on every device first, so a filter the bytes would
  // refuse for another reason says the same everywhere.
  try checkFilterShape(cond, defs, shape)
  // No bytes to cut (a shared link elsewhere): the cut is a table too, and
  // reports the same reason its source does.
  guard let data = src.data else { return TableDef(file: src.file, hash: src.hash, data: nil, missing: src.missing) }
  guard let keep = try lowerMask(cond, listGetter(defs), opts) else { throw LanguageError(shape) }
  if keep.count != data.rows {
    throw LanguageError("The filter tests \(keep.count) values but \(src.file) has \(data.rows) rows.")
  }
  return TableDef(file: src.file, hash: src.hash, data: filterTable(data, keep: keep))
}

/// `adults = person[person.age >= 18]` names a cut of a data file (lib/defs.ts
/// `buildDefs`, where a constant's value has lowered its points): the table
/// the definition names, or nil when it is not one.
func tableCut(
  _ name: String, _ value: Expr, draw: Bool, _ defs: BuiltDefs, _ opts: ResolveOpts,
  comps: @escaping (String) -> [String]?
) throws -> TableDef? {
  guard case .index(.var(let source), _) = value, defs.tables.has(source) else { return nil }
  var e: Expr
  do {
    e = try lowerGeom(
      value, comps: comps, mats: { defs.mats[$0] }, tensors: tensorGetter(defs), isList: defs.lists.has)
  } catch let error as Unsupported {
    throw error
  } catch {
    e = settledNode(try lowerObjects(value, defs, opts, named: true))
  }
  guard let cut = try filteredTable(e, defs, opts) else { return nil }
  if draw {
    throw LanguageError("\(name) ∈ … draws from a list; that is a data file; draw one of its columns, p ∈ T.col.")
  }
  return cut
}

/// A definition failed for want of a file (lib/defs.ts `buildDefs`, its
/// catch): the name still means something — a value whose file is elsewhere —
/// and is registered so rows below report the file too. Whether it is a list
/// is read off the shape, the same way a filter's is: `ages = person.age / 2`
/// is one, `avg = mean(person.age)` is a number.
func noteMissingData(_ error: LanguageError, _ d: Definition, shape: Expr?, _ defs: inout BuiltDefs) {
  guard error.missingData else { return }
  defs.needsFile.insert(d.key)
  if case .constant(let name, _, _) = d {
    defs.missingData[name] = MissingValue(message: error.message, list: shape.map { staysList($0, defs) } ?? false)
  }
}

/// A row that failed for want of a file is not broken (lib/analysis.ts
/// `analyzeDocument`, its catch): the bytes are on the device that made the
/// graph, so this is a gap in this render, not a bad row. True when `error`
/// was that, and the row says so.
func needsFile(_ error: Error, _ row: inout RowAnalysis) -> Bool {
  guard let error = error as? LanguageError, error.missingData else { return false }
  row.dataLocal = error.message
  return true
}

/// The kinds data files give rows (lib/row-kind.ts `rowKind`, `constKind`):
/// `adults = person[…]` scans as a constant, but what it defines is another
/// data file; and a row that is nothing else and waits for its file is data.
/// (Set once the other kinds are, so that `analyze` holds no more of a row
/// than it did: its frame is the floor every deep expression stands on.)
func tableKinds(_ rows: inout [RowAnalysis], _ tableNames: Set<String>) {
  if tableNames.isEmpty { return }
  for i in rows.indices where rows[i].unsupported == nil && !rows[i].comment {
    if case .constant(let name, _, _)? = rows[i].definition {
      if tableNames.contains(name) { rows[i].kind = "definition (filtered data)" }
    } else if rows[i].definition == nil, rows[i].view == nil, rows[i].dist == nil, rows[i].dataLocal != nil {
      rows[i].kind = "data (reads a file on the author's device)"
    }
  }
}

// MARK: - Drawing limits

/// More points than a scene in space draws is the row's error: on the site a
/// limit of its renderer, set where the rows compile (web/main.ts
/// `recompileAll`). The plans stay, as they do there; nothing draws a row
/// with an error.
func limitCloud(_ row: inout RowAnalysis) {
  if row.error == nil, let tooMany = cloudLimitError(row.cpu) { row.error = tooMany }
}

/// Why a row's points are too many for a scene in space, if they are
/// (web/main.ts `recompileAll`, with web/session.ts `cloudPoints`): either
/// representation, a packed scatter or the point list a slider or t expands
/// one into.
func cloudLimitError(_ plan: CpuPlan?) -> String? {
  let points: Int
  switch plan {
  case .dscatter(3, let coords)?: points = coords.first?.count ?? 0
  case .plist(3, let pts)?: points = pts.count
  default: return nil
  }
  guard points > CLOUD_3D_MAX else { return nil }
  return "A 3D cloud draws at most \(CLOUD_3D_MAX) points; that is \(points)."
    + " Filter it first, or plot two of the columns."
}
