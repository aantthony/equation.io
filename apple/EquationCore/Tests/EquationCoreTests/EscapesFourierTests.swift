import Foundation
import Testing

@testable import EquationCore

/// lib/escapes.ts and lib/fourier.ts, against what the TypeScript answers
/// (recorded by apple/corpus/analysis.ts into evaluate.json).
@Suite struct EscapesAndFourier {
  @Test func escapesAreTheSites() throws {
    let recorded = try #require((try fixture("evaluate") as? [String: Any])?["escapes"] as? [String: Any])
    let table = recorded["table"] as! [[String: String]]
    #expect(escapes.map(\.name) == table.map { $0["name"]! })
    #expect(escapes.map(\.text) == table.map { $0["text"]! })
    #expect(escapes.map(\.description) == table.map { $0["description"]! })
    for entry in recorded["typed"] as! [[String: Any]] {
      let text = entry["text"] as! String
      let units = Array(text.utf16)
      for (k, want) in (entry["edits"] as! [Any]).enumerated() {
        let got = typedEscape(
          String(utf16CodeUnits: units, count: k + 1), offset: k + 1,
          inserted: String(utf16CodeUnits: [units[k]], count: 1))
        let wanted = (want as? [String: Any]).map {
          EscapeEdit(
            start: ($0["start"] as! NSNumber).intValue, end: ($0["end"] as! NSNumber).intValue,
            text: $0["text"] as! String, caret: ($0["caret"] as! NSNumber).intValue)
        }
        #expect(got == wanted, "\(text.debugDescription) at \(k + 1)")
      }
    }
  }

  @Test func fourierIsTheSites() throws {
    let recorded = try #require((try fixture("evaluate") as? [String: Any])?["fourier"] as? [[String: Any]])
    /// The two libms' sines and cosines differ in the last place, and a
    /// transform adds a few hundred of them.
    func near(_ a: Double, _ b: Double, _ scale: Double) -> Bool {
      if a.isNaN || b.isNaN { return a.isNaN && b.isNaN }
      return abs(a - b) <= 1e-9 * max(scale, abs(a), abs(b))
    }
    for entry in recorded {
      let name = entry["name"] as! String
      let samples = (entry["samples"] as! [Any]).map(number)
      let (lo, period) = (number(entry["lo"]!), number(entry["period"]!))
      let scale = samples.reduce(0) { max($0, abs($1)) }
      let c: FourierCoefficients
      do {
        c = try realFourier(samples)
      } catch {
        #expect(errorMessage(error) == entry["error"] as? String, "\(name)")
        continue
      }
      #expect(entry["error"] == nil, "\(name)")
      guard entry["error"] == nil else { continue }
      func same(_ what: String, _ mine: [Double], _ theirs: Any?) {
        let want = (theirs as! [Any]).map(number)
        #expect(mine.count == want.count && zip(mine, want).allSatisfy { near($0, $1, scale) }, "\(name): \(what)")
      }
      same("cosine", c.cosine, entry["cosine"])
      same("sine", c.sine, entry["sine"])
      // Which bins the tolerance zeroes decides which terms the series has.
      #expect(c.cosine.map { $0 == 0 } == (entry["cosine"] as! [Any]).map { number($0) == 0 }, "\(name): zeros")
      #expect(c.sine.map { $0 == 0 } == (entry["sine"] as! [Any]).map { number($0) == 0 }, "\(name): zeros")
      let spectrum = spectrumPoints(c, period).flatMap { point -> [Double] in
        guard case .vec(let items) = point else { return [] }
        return items.map { (try? evaluate($0, [:])) ?? .nan }
      }
      same("spectrum", spectrum, (entry["spectrum"] as! [[Any]]).flatMap { $0 })
      let harmonics = (entry["harmonics"] as! NSNumber).intValue
      let xs = [-1.3, 0, 0.21, 1, 2.75]
      let plain = reconstructSeries(c, harmonics: harmonics, lo: lo, period: period)
      same("series", try xs.map { try evaluate(plain, ["x": $0]) }, entry["plain"])
      let gated = reconstructSeries(c, harmonics: harmonics, lo: lo, period: period, count: .var("N"))
      for (n, want) in zip([0, 1, 2.5, 7, 200], entry["gated"] as! [[Any]]) {
        same("series to \(n)", try xs.map { try evaluate(gated, ["x": $0, "N": n]) }, want)
      }
      // The gated series is the shape the shader compiles to a coefficient table.
      let isLoop = (entry["gatedIsLoop"] as? [String: Any])?["out"] as? Bool
      #expect((try? toGLSL(gated).contains("eq_loop_")) == isLoop, "\(name): loop")
    }
  }
}
