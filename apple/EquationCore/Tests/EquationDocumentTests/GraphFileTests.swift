import EquationCore
import Foundation
import Testing

@testable import EquationDocument

/// A document's data files: in with the rows that open them, saved inside the
/// document, and back out as the same bytes under the same hash.
@Suite struct GraphFileTests {
  static let people = Data("name,age,height\nAda,36,1.7\nBob,41,1.82\nCy,,1.6\n".utf8)

  @Test func hashesAsTheCoreDoes() {
    let hash = DocumentData.hash(Self.people)
    #expect(hash == sha256Hex(Array(Self.people)))
    // (The token the site's own hash gives these bytes: apple/corpus/cases-data.ts records it.)
    #expect(hash.hasPrefix("0dccef8955b6"))
    #expect(DocumentData.hash(Data()) == "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855")
  }

  @Test func aFileArrivesWithItsRows() {
    var file = GraphFile(rows: ["y = sin(x)", ""])
    let notices = file.open([("people.csv", Self.people)])
    let token = shortHash(DocumentData.hash(Self.people))
    #expect(file.rows == ["y = sin(x)", "people = open(\"people.csv\", \(token))", "(people.age, people.height)"])
    #expect(notices == ["people.csv: 3 rows as people"])
    let analysis = analyze(file.rows, files: file.data.files)
    #expect(analysis.rows.allSatisfy { $0.error == nil && $0.dataLocal == nil && $0.unsupported == nil })
    #expect(analysis.rows[1].info == "3 rows · name (text), age, height · 1 missing value in age")
    // (As text: the missing age is NaN, which is not equal to itself.)
    #expect("\(analysis.rows[2].cpu!)" == "dscatter(dim: 2, coords: [[36.0, 41.0, nan], [1.7, 1.82, 1.6]])")
    // The same file again is the same file: its row is found, and nothing is added.
    #expect(file.open([("people.csv", Self.people)]) == ["people.csv reloaded"])
    #expect(file.rows.count == 3 && file.data.stored.count == 1)
  }

  @Test func roundTripsThroughTheDocument() throws {
    var file = GraphFile(rows: ["a = 2"])
    _ = file.open([("people.csv", Self.people)])
    let saved = try file.encoded()
    let opened = try GraphFile(data: saved)
    #expect(opened == file)
    #expect(opened.rows == file.rows)
    #expect(opened.data.stored.map(\.bytes) == [Self.people])
    #expect(opened.data.stored.map(\.hash) == [DocumentData.hash(Self.people)])
    let (before, after) = (analyze(file.rows, files: file.data.files), analyze(opened.rows, files: opened.data.files))
    #expect("\(after.rows)" == "\(before.rows)")
    // Saved again, the same bytes: nothing drifts.
    let again = try opened.encoded()
    #expect(again == saved)
    // A CSV is text in the document, where it can be read.
    let json = try #require(JSONSerialization.jsonObject(with: saved) as? [String: Any])
    let files = try #require(json["files"] as? [[String: Any]])
    #expect(files.count == 1)
    #expect(files[0]["name"] as? String == "people.csv")
    #expect(files[0]["sha256"] as? String == DocumentData.hash(Self.people))
    #expect(files[0]["text"] as? String == String(decoding: Self.people, as: UTF8.self))
    #expect(files[0]["base64"] == nil)
  }

  /// The hash is of the bytes, so the bytes come back exactly: a BOM, CRLF
  /// line ends, text that is not ASCII — and bytes that are not UTF-8 at all.
  @Test func bytesComeBackExactly() throws {
    let awkward: [(String, Data)] = [
      ("bom.csv", Data([0xEF, 0xBB, 0xBF]) + Data("x;y\r\n1,5;2\r\n2,5;3\r\n".utf8)),
      ("names.csv", Data("ß,naïve,日本\n1,2,3\n4,5,6\n".utf8)),
      ("latin1.csv", Data([0x63, 0x61, 0x66, 0xE9, 0x2C, 0x6E, 0x0A, 0x31, 0x2C, 0x32, 0x0A])),
      ("quotes \"and\"\ttabs.csv", Data("a,b\n\"multi\nline\",2\n3,4\n".utf8)),
    ]
    var file = GraphFile(rows: [])
    let notices = file.open(awkward.map { (name: $0.0, bytes: $0.1) })
    #expect(notices.count == 4 && notices.allSatisfy { $0.contains(" rows as ") })
    let opened = try GraphFile(data: try file.encoded())
    #expect(opened.data.stored.map(\.bytes) == awkward.map(\.1))
    #expect(opened.data.stored.map(\.hash) == awkward.map { DocumentData.hash($0.1) })
    #expect(opened.data.stored.map(\.name) == ["bom.csv", "names.csv", "latin1.csv", "quotes _and_tabs.csv"])
    #expect(opened == file)
    // Every row reads its file once it is back.
    let analysis = analyze(opened.rows, files: opened.data.files)
    #expect(analysis.rows.allSatisfy { $0.error == nil && $0.dataLocal == nil })
    // What is not UTF-8 travels as Base64, and so does what a string would not give back to
    // the byte (Foundation reads a BOM away); the rest as text.
    let json = try #require(JSONSerialization.jsonObject(with: try file.encoded()) as? [String: Any])
    let files = try #require(json["files"] as? [[String: Any]])
    #expect(files.map { $0["base64"] != nil } == [true, false, true, false])
    #expect(files.allSatisfy { ($0["base64"] == nil) != ($0["text"] == nil) })
  }

  @Test func aDocumentWithoutFilesIsAsItWas() throws {
    let file = GraphFile(rows: ["y = sin(a x)", "a = 2"])
    let saved = try file.encoded()
    let json = try #require(JSONSerialization.jsonObject(with: saved) as? [String: Any])
    #expect(Set(json.keys) == ["version", "rows"])
    // And a document written before there were files opens.
    let old = Data(#"{"version": 1, "rows": ["y = x"]}"#.utf8)
    #expect(try GraphFile(data: old) == GraphFile(rows: ["y = x"]))
  }

  @Test func aDeletedRowTakesItsDataWithIt() throws {
    var file = GraphFile(rows: [])
    _ = file.open([("people.csv", Self.people), ("pairs.csv", Data("a,b\n1,2\n3,4\n".utf8))])
    #expect(file.data.stored.count == 2)
    // The rows of pairs.csv go; the file is still on hand (an undo away), but is not saved.
    file.rows.removeAll { $0.contains("pairs") }
    let opened = try GraphFile(data: try file.encoded())
    #expect(opened.data.stored.map(\.name) == ["people.csv"])
    #expect(!String(decoding: try file.encoded(), as: UTF8.self).contains("pairs.csv"))
    // A cut of a file, and a row that pins no hash, keep their file.
    file.rows = ["p = open(\"people.csv\")", "tall = p[p.height > 1.65]", "(tall.age, tall.height)"]
    #expect(try GraphFile(data: try file.encoded()).data.stored.map(\.name) == ["people.csv"])
  }

  /// A link carries the rows and not the files: opened elsewhere, its rows
  /// ask for the file, and the file — only that file — answers.
  @Test func aMissingFileIsAskedForAndSupplied() throws {
    var author = GraphFile(rows: ["# heights"])
    _ = author.open([("people.csv", Self.people)])
    let token = shortHash(DocumentData.hash(Self.people))
    // What travels in a link: the rows.
    var reader = GraphFile(rows: author.linkRows)
    #expect(reader.data.isEmpty)
    let asking = analyze(reader.rows, files: reader.data.files)
    let message = "people.csv (\(token)) is not on this device — drop the file here to load it."
    #expect(asking.rows.map(\.dataLocal) == [nil, message, message])
    #expect(asking.rows.allSatisfy { $0.error == nil })
    // Another file of the same name is another file: the row keeps its hash, and stays missing.
    let other = Data("name,age,height\nDee,20,1.5\n".utf8)
    let refused = reader.open([("people.csv", other)])
    #expect(refused[0].hasPrefix("people.csv: 1 row pinned to other bytes kept"))
    #expect(reader.rows[1] == author.rows[1])
    #expect(analyze(reader.rows, files: reader.data.files).rows[1].dataLocal == message)
    #expect(reader.rows.contains("people_2 = open(\"people.csv\", \(shortHash(DocumentData.hash(other))))"))
    // The file itself, whatever it is called now, is the one.
    var second = GraphFile(rows: author.linkRows)
    #expect(second.open([("renamed.csv", Self.people)]) == ["renamed.csv reloaded"])
    #expect(second.rows == author.rows)
    let drawn = analyze(second.rows, files: second.data.files)
    #expect(drawn.rows.allSatisfy { $0.dataLocal == nil && $0.error == nil })
    #expect("\(drawn.rows[2].cpu!)" == "\(analyze(author.rows, files: author.data.files).rows[2].cpu!)")
    // And it is saved with the reader's document from then on.
    #expect(try GraphFile(data: try second.encoded()).data.stored.map(\.bytes) == [Self.people])
  }

  @Test func rowsTypedByHandArePinned() {
    var file = GraphFile(rows: ["p := open('people.csv') # the survey", "p.age", "q = open(\"people.csv\", abc)"])
    #expect(file.linkRows == file.rows)
    #expect(file.open([("people.csv", Self.people)]) == ["people.csv reloaded"])
    let token = shortHash(DocumentData.hash(Self.people))
    #expect(file.rows[0] == "p := open(\"people.csv\", \(token)) # the survey")
    #expect(file.rows.count == 3)
    // A row typed after the file came is pinned in what a link carries.
    file.rows.append("r = open(\"people.csv\")")
    #expect(file.linkRows.last == "r = open(\"people.csv\", \(token))")
    #expect(file.rows.last == "r = open(\"people.csv\")")
  }

  @Test func aFileThatIsNotATableSaysSo() {
    var file = GraphFile(rows: ["y = x"])
    #expect(file.open([("empty.csv", Data())]) == ["empty.csv: That file has no rows."])
    #expect(file.rows == ["y = x"] && file.data.isEmpty)
    // Names a definition may not take, and names already taken.
    let csv = { (text: String) in Data(text.utf8) }
    _ = file.open([("u.csv", csv("a,b\n1,2\n")), ("y.csv", csv("a\n1\n")), ("u.csv", csv("a,b\n3,4\n"))])
    let names = file.rows.filter { $0.contains("open(") }.map { String($0.prefix { $0 != " " }) }
    #expect(names == ["data_u", "data_y", "data_u_2"])
  }
}
