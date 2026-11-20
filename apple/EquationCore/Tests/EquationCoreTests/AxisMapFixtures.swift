import Foundation

@testable import EquationCore

/// A mapped view row as the fixtures carry it (lib/view.ts `View2DSpec` with
/// `maps`), for AnalysisConformanceTests: the maps' trees must be the
/// TypeScript's exactly; the window, which each side works out through its
/// own libm (`toScreen` of the row's bounds), within the last few places —
/// there it is taken from `mine`, so the two compare equal.
func mappedViewSpec(_ view: [String: Any], like mine: ViewSpec) throws -> ViewSpec? {
  guard let maps = view["maps"] as? [String: Any] else { return nil }
  if maps["plane"] != nil { throw FixtureError(description: "a plane map") }
  func map(_ key: String) throws -> AxisMap? {
    guard let m = maps[key] as? [String: Any] else { return nil }
    return AxisMap(
      axis: AxisMap.Axis(rawValue: m["axis"] as! String)!, text: m["text"] as! String,
      forward: try decode(m["forward"]!), inverse: try decode(m["inverse"]!), slope: try decode(m["slope"]!))
  }
  func pair(_ key: String, _ own: [Double]?) -> [Double]? {
    guard let wanted = (view[key] as? [Any])?.map(number) else { return nil }
    if let own, own.count == wanted.count, zip(own, wanted).allSatisfy({ close($0, $1) }) { return own }
    return wanted
  }
  var (x, y): ([Double]?, [Double]?) = (nil, nil)
  if case .mappedView(let mx, let my, _, _, _) = mine { (x, y) = (mx, my) }
  return .mappedView(
    x: pair("x", x), y: pair("y", y), ratio: view["ratio"].map(number), locked: view["locked"] as? Bool ?? false,
    maps: AxisMaps(x: try map("x"), y: try map("y")))
}
