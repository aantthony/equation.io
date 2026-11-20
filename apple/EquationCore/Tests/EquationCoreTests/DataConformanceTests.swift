import Foundation
import Testing

@testable import EquationCore

/// Holds Csv.swift and Hash.swift to lib/csv.ts and lib/hash.ts: the files
/// apple/corpus/cases-leftovers.ts records (data.json) — what each is sniffed
/// and parsed as, a cut of it, cells read as numbers, names made of file
/// names, and the hashes rows pin files by.
@Suite struct DataConformance {
  private func table(_ o: [String: Any]) -> CsvTable {
    let columns = (o["columns"] as! [[String: Any]]).map { c in
      CsvColumn(
        name: c["name"] as! String, label: c["label"] as! String,
        values: c["type"] as! String == "num"
          ? .nums((c["nums"] as! [Any]).map(number)) : .strs(c["strs"] as! [String]))
    }
    let missing = (o["missing"] as! [[Any]]).map { (name: $0[0] as! String, count: ($0[1] as! NSNumber).intValue) }
    return CsvTable(
      columns: columns, rows: (o["rows"] as! NSNumber).intValue, skipped: (o["skipped"] as! NSNumber).intValue,
      missing: missing, delimiter: o["delimiter"] as! String, warnings: o["warnings"] as! [String],
      positions: (o["positions"] as? [Any])?.map(number))
  }

  @Test func filesParseAsTheSiteParsesThem() throws {
    let root = try #require(try fixture("data") as? [String: Any])
    let files = try #require(root["files"] as? [[String: Any]])
    #expect(files.count > 20)
    for file in files {
      let source = file["file"] as! String
      let what = source.debugDescription
      #expect(sniffDelimiter(source) == file["sniffed"] as? String, "\(what)")
      do {
        let got = try parseCsv(source)
        guard let want = file["table"] as? [String: Any] else {
          Issue.record("\(what): parsed, but the site says \(file["error"] ?? "nothing")")
          continue
        }
        #expect(got == table(want), "\(what)")
        #expect(positionColumn(got) == want["positionColumn"] as? String, "\(what)")
        #expect(try parseRecords(source, delimiter: ",") == file["records"] as? [[String]], "\(what)")
        let keep = (0..<got.rows).map { $0 % 2 == 0 }
        #expect(filterTable(got, keep: keep) == table(file["cut"] as! [String: Any]), "\(what), cut")
      } catch {
        #expect(errorMessage(error) == file["error"] as? String, "\(what)")
      }
    }
  }

  @Test func cellsReadAsNumbers() throws {
    let root = try #require(try fixture("data") as? [String: Any])
    for cell in try #require(root["cells"] as? [[String: Any]]) {
      let text = cell["cell"] as! String
      func same(_ a: Double, _ b: Double) -> Bool { a == b || (a.isNaN && b.isNaN) }
      #expect(same(cellNumber(text), number(cell["plain"]!)), "\(text.debugDescription)")
      #expect(same(cellNumber(text, decimalComma: true), number(cell["comma"]!)), "\(text.debugDescription), comma")
    }
    for name in try #require(root["names"] as? [[String: Any]]) {
      #expect(tableNameFor(name["file"] as! String) == name["name"] as? String)
    }
  }

  @Test func hashesAreSHA256() throws {
    let root = try #require(try fixture("data") as? [String: Any])
    for hash in try #require(root["hashes"] as? [[String: Any]]) {
      let hex = sha256Hex(Array((hash["content"] as! String).utf8))
      #expect(hex == hash["hex"] as? String)
      #expect(shortHash(hex) == hash["short"] as? String)
    }
    // FIPS 180-4's own example.
    #expect(sha256Hex(Array("abc".utf8)) == "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad")
  }
}
