import Foundation
import Testing

@testable import EquationCore

/// Holds `fitRegression` and `formatFit` to lib/regression.ts: the fits the
/// corpus records (apple/corpus/analysis.ts, in evaluate.json), each model
/// written out per observation as list lowering would hand it over.
@Suite struct RegressionConformance {
  @Test func fitsMatchTheSite() throws {
    let root = try #require(try fixture("evaluate") as? [String: Any])
    let fits = try #require(root["fits"] as? [[String: Any]])
    #expect(fits.count > 20)
    for (k, fit) in fits.enumerated() {
      let observed = (fit["y"] as! [Any]).map(number)
      let models = try (fit["models"] as! [Any]).map(decode)
      let parameters = fit["params"] as! [String]
      let fixed = (fit["fixed"] as! [String: Any]).mapValues(number)
      let want = fit["result"] as! [String: Any]
      let what = "fit \(k + 1), \(parameters) over \(observed)"
      do {
        let got = try fitRegression(observed, models, parameters, fixed)
        guard want["error"] == nil else {
          Issue.record("\(what): fitted, but the site says \(want["error"]!)")
          continue
        }
        // The readout is what a row shows: six significant digits of everything.
        #expect(formatFit(got) == want["text"] as? String, "\(what)")
        let coefficients = want["coefficients"] as! [[String: Any]]
        #expect(got.coefficients.map(\.name) == coefficients.map { $0["name"] as! String }, "\(what)")
        for (mine, theirs) in zip(got.coefficients, coefficients) {
          let value = number(theirs["value"]!)
          #expect(abs(mine.value - value) <= 1e-9 * max(1, abs(value)), "\(what): \(mine.name)")
        }
        #expect(got.count == (want["count"] as! NSNumber).intValue, "\(what)")
        #expect(got.skipped == (want["skipped"] as! NSNumber).intValue, "\(what)")
        #expect(got.nonlinear == want["nonlinear"] as! Bool, "\(what)")
        #expect((got.r2 == nil) == (want["r2"] is NSNull), "\(what)")
      } catch {
        #expect(errorMessage(error) == want["error"] as? String, "\(what)")
      }
    }
  }

  @Test func aTildeRowIsAFitOrADeclaration() {
    func reads(_ text: String, declared: Set<String> = []) -> Bool? {
      tildeRow(Array(text.utf16), declared)?.regression
    }
    #expect(reads("Y ~ m X + b", declared: ["Y"]) == true)
    #expect(reads("Y ~ m X + b") == false)
    #expect(reads("P.y ~ m P.x + b") == true)
    #expect(reads("Y ~ Normal(0, 1)", declared: ["Y"]) == false)
    // The spellings that are also a function or a coefficient: models over data, but for a bare exp.
    #expect(reads("Y ~ exp(a X)", declared: ["Y"]) == true)
    #expect(reads("Y ~ gamma", declared: ["Y"]) == true)
    #expect(reads("Y ~ exp", declared: ["Y"]) == false)
    #expect(reads("Y ~ Gamma(2, 1)") == false)
    #expect(reads("y = x") == nil && reads("a ~ b ~ c") == nil && reads("# a ~ b") == nil && reads("f(a ~ b)") == nil)
    #expect(declaredNames(["Y = [1, 2]", "p ∈ L", "q \\in L", "r \\inx", "f(x) = 2", "a == 2"].map { Array($0.utf16) })
      == ["Y", "p", "q"])
  }
}
