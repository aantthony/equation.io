import Foundation
import Testing

@testable import EquationCore

/// Holds the way back through a plane map (PlaneInverse.swift) to
/// lib/plane-map.ts: for a set of maps and windows, the turns and fold points
/// found, every place and the first place the screen shows each of a set of
/// points, and lines, shapes and triangles carried to the screen
/// (apple/corpus/cases-planes.ts `recordPlanes`).
///
/// The way back is found numerically, so the two are held to each other at
/// the solver's own tolerance rather than to the bit: the same pieces, of the
/// same lengths, each number within a millionth of the window's size (what
/// the method itself calls one place, `same`). cos, sin and exp differ in
/// the last place between the two, which Levenberg–Marquardt forgives.
@Suite struct PlaneConformance {
  @Test func theWayBackMatchesTheTypeScript() throws {
    let maps = try #require(try fixture("planes") as? [[String: Any]])
    var failures: [String] = []
    var compared = 0
    var folded = 0
    for entry in maps {
      let text = entry["map"] as! String
      let (lo, hi) = (numbers(entry["lo"]!), numbers(entry["hi"]!))
      let name = "\(text) on \(lo[0])…\(hi[0]) × \(lo[1])…\(hi[1])"
      let map = try parsePlaneMap(text)
      let box = ScreenBox(lo: lo, hi: hi)
      let inverse = PlaneInverse(map, box)
      let tol = 1e-6 * hypot(hi[0] - lo[0], hi[1] - lo[1])
      func same(_ what: String, _ got: [Double], _ want: Any?, tol: Double = tol) {
        compared += 1
        guard let want = want as? [Any] else {
          failures.append("\(name): \(what): the site has none, got \(got.count) numbers")
          return
        }
        let wanted = want.map(number)
        guard got.count == wanted.count else {
          failures.append("\(name): \(what): \(got.count) numbers, the site has \(wanted.count)")
          return
        }
        for (k, (a, b)) in zip(got, wanted).enumerated() {
          if a.isNaN && b.isNaN { continue }
          if a == b || abs(a - b) <= tol * (1 + abs(b)) { continue }
          failures.append("\(name): \(what): number \(k) is \(a), the site has \(b)")
          return
        }
      }
      func pair(_ p: ScreenPoint) -> [Double] { [p.0, p.1] }
      func flat(_ ps: [ScreenPoint]) -> [Double] { ps.flatMap(pair) }
      func unpaired(_ json: Any?) -> [Any]? { (json as? [[Any]])?.flatMap { $0 } }
      let mid = ((lo[0] + hi[0]) / 2 + 0.1, (lo[1] + hi[1]) / 2 + 0.2)
      // The map itself: to the last places, which libm decides.
      same("world", pair(planeToWorld(map, mid.0, mid.1)), entry["world"], tol: 1e-13)
      let j = planeJacobian(map, mid.0, mid.1)
      same("jacobian", [j.0, j.1, j.2, j.3], entry["jacobian"], tol: 1e-13)
      same("pixel", pair(pixelSpan(map, mid.0, mid.1, 0.01, 0.02)), entry["pixel"], tol: 1e-13)
      if let shown = planeWorldBox(map, box) {
        let want = entry["worldBox"] as? [String: Any]
        same("worldBox", shown.lo + shown.hi, want.map { ($0["lo"] as! [Any]) + ($0["hi"] as! [Any]) }, tol: 1e-13)
      } else if !(entry["worldBox"] is NSNull) {
        failures.append("\(name): worldBox: none, the site has one")
      }
      same("turns", flat(inverse.turns()), unpaired(entry["turns"]))
      same("folds", flat(inverse.foldPoints()), unpaired(entry["folds"]))
      let symmetric = [inverse.symmetric((2 * Double.pi, 0)), inverse.symmetric((1, 0))]
      if symmetric != entry["symmetric"] as? [Bool] { failures.append("\(name): symmetric: \(symmetric)") }
      for point in entry["points"] as! [[String: Any]] {
        let p = numbers(point["p"]!)
        let at = "(\(p[0]), \(p[1]))"
        if inverse.mayShow(p[0], p[1]) != point["mayShow"] as? Bool { failures.append("\(name): mayShow\(at)") }
        // A point the map folds at (the polar origin) is shown all along a
        // line: which places of it a search lands on turns on the last bits
        // of cos and sin. There each answer must be a place on the fold that
        // shows the point, and there must be some where the site has some.
        let all = inverse.all(p[0], p[1])
        let first = inverse.first(p[0], p[1])
        let sites = (point["all"] as! [[Any]]).map { numbers($0) }
        if !sites.isEmpty, sites.allSatisfy({ inverse.folds($0[0], $0[1]) }) {
          compared += 2
          let shows = (all + [first]).allSatisfy { s in
            let w = inverse.world(s.0, s.1)
            return inverse.folds(s.0, s.1) && abs(w.0 - p[0]) + abs(w.1 - p[1]) <= 1e-7 * (1 + abs(p[0]) + abs(p[1]))
          }
          if all.isEmpty || !shows { failures.append("\(name): all\(at), on a fold: \(all)") }
          folded += 1
        } else {
          same("all\(at)", flat(all), unpaired(point["all"]))
          same("first\(at)", pair(first), point["first"])
        }
        for (key, found) in [
          ("solve", inverse.solve(p[0], p[1], mid)), ("follow", inverse.follow(p[0], p[1], mid, 1)),
        ] {
          if let found {
            same("\(key)\(at)", pair(found), point[key])
          } else if !(point[key] is NSNull) {
            failures.append("\(name): \(key)\(at): none, the site has one")
          }
        }
      }
      func vertex(_ pts: [Double]) -> (Int) -> ScreenPoint { { (pts[2 * $0], pts[2 * $0 + 1]) } }
      for line in entry["lines"] as! [[String: Any]] {
        let pts = numbers(line["pts"]!)
        let what = "line \(line["name"]!)"
        let got = planeLines(inverse, pts.count / 2, vertex(pts), line["closed"] as! Bool)
        let want = line["out"] as! [[Any]]
        if got.count != want.count {
          failures.append("\(name): \(what): \(got.count) pieces, the site has \(want.count)")
          continue
        }
        for (k, piece) in got.enumerated() { same("\(what), piece \(k)", piece, want[k]) }
      }
      for shape in entry["shapes"] as! [[String: Any]] {
        let pts = numbers(shape["pts"]!)
        let what = "shape \(shape["name"]!)"
        let got = planeShapes(inverse, pts.count / 2, vertex(pts))
        let want = shape["out"] as! [[String: Any]]
        if got.count != want.count {
          failures.append("\(name): \(what): \(got.count) pieces, the site has \(want.count)")
          continue
        }
        for (k, piece) in got.enumerated() {
          same("\(what), piece \(k)", piece.pts, want[k]["pts"])
          if piece.closed != want[k]["closed"] as? Bool || piece.stroke != want[k]["stroke"] as? Bool {
            failures.append("\(name): \(what), piece \(k): closed \(piece.closed), stroke \(piece.stroke as Any)")
          }
        }
      }
      for mesh in entry["meshes"] as! [[String: Any]] {
        same("mesh \(mesh["name"]!)", inverse.triangles(numbers(mesh["tris"]!)), mesh["out"])
      }
    }
    print(
      "Plane conformance: \(maps.count) maps, \(compared) answers compared (\(folded) points on a fold, "
        + "held to the fold), \(failures.count) differ.")
    for failure in failures.prefix(60) { Issue.record(Comment(rawValue: failure)) }
    #expect(failures.isEmpty)
  }
}

private func numbers(_ json: Any) -> [Double] { (json as! [Any]).map(number) }
