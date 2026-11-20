import Foundation

@testable import EquationCore

/// A document's coordinate fields against the fixture's (`gridFields`, which
/// apple/corpus/cases-panels.ts records as web/main.ts compiles them), for
/// AnalysisConformanceTests. Every field the port makes must be the site's —
/// its tree, gradient, GLSL and panel — and every one of the site's must be
/// there unless the row defining it is not supported.
func compareGridFields(_ analysis: DocumentAnalysis, _ wanted: [[String: Any]]) -> [String] {
  var out: [String] = []
  var mine: [String: GridField] = [:]
  for field in analysis.gridFields { mine[field.name] = field }
  let unsupported = Set(analysis.rows.compactMap { $0.unsupported != nil ? $0.definition?.name : nil })
  var seen: [String] = []
  for want in wanted {
    let name = want["name"] as! String
    guard let got = mine[name] else {
      // (One the site's own compiler refuses is drawn by neither.)
      if !unsupported.contains(name) && want["error"] == nil { out.append("grid field \(name) is missing") }
      continue
    }
    seen.append(name)
    guard let cpu = want["cpu"] as? [String: Any], let gpu = want["gpu"] as? [String: Any] else {
      out.append("grid field \(name): the site does not compile it (\(want["error"] ?? "?"))")
      continue
    }
    do {
      let wantedCpu = CpuGrid(
        name: cpu["name"] as! String, expr: try decode(cpu["expr"]!), grad: try (cpu["grad"] as? [Any])?.map(decode),
        params: cpu["params"] as! [String], angular: cpu["angular"] as! Bool, level: cpu["level"] as? String)
      if got.cpu != wantedCpu { out.append("grid field \(name): cpu \(got.cpu), want \(wantedCpu)") }
    } catch {
      out.append("grid field \(name): \(error)")
    }
    if normalizeGLSL(got.gpu.glsl) != normalizeGLSL(gpu["glsl"] as! String) {
      out.append("grid field \(name): glsl \(got.gpu.glsl), want \(gpu["glsl"]!)")
    }
    if got.gpu.gradGlsl?.map(normalizeGLSL) != (gpu["gradGlsl"] as? [String])?.map(normalizeGLSL) {
      out.append("grid field \(name): gradient \(String(describing: got.gpu.gradGlsl)), want \(gpu["gradGlsl"] ?? "none")")
    }
    if got.gpu.params != gpu["params"] as! [String] { out.append("grid field \(name): params \(got.gpu.params)") }
    if got.panel != (want["panel"] as! NSNumber).intValue { out.append("grid field \(name): panel \(got.panel)") }
  }
  // In the site's order, and none the site has not.
  if analysis.gridFields.map(\.name) != seen {
    out.append("grid fields \(analysis.gridFields.map(\.name)), of the site's \(wanted.map { $0["name"] as! String })")
  }
  return out
}
