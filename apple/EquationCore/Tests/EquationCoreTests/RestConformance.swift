import Foundation

@testable import EquationCore

/// What apple/corpus/cases-rest.ts records beside a row's plans: whether it
/// is a `mark(v)` row, and what the site draws of a graph (its vertices, its
/// arrows as they read, and where the layout puts each vertex).
func restDifferences(_ got: RowAnalysis, _ want: [String: Any], _ analysis: DocumentAnalysis) -> [String] {
  var out: [String] = []
  if let mark = want["mark"] as? Bool, mark != got.mark { out.append("mark: got \(got.mark), want \(mark)") }
  if let graph = want["graph"] as? [String: Any], case .graph(let edges)? = got.cpu {
    var env = analysis.env
    env["t"] = 0
    let data = collectEdges(evaluateEdges(edges, env))
    let vertices = (graph["vertices"] as! [Any]).map(number)
    if data.vertices != vertices { out.append("graph vertices: got \(data.vertices), want \(vertices)") }
    let mine = data.edges.map { "\(JS.string($0.from))>\(JS.string($0.to)) \(edgeText($0))" }
    let theirs = (graph["edges"] as! [[String: Any]]).map {
      "\(JS.string(number($0["from"]!)))>\(JS.string(number($0["to"]!))) \($0["text"] as! String)"
    }
    if mine != theirs { out.append("graph edges: got \(mine), want \(theirs)") }
    // The layout from a given start (apple/corpus/cases-rest.ts says why not from scratch).
    let wanted = (graph["pos"] as! [[Any]]).map { $0.map(number) }
    if data.vertices == vertices {
      var from: [Double: (Double, Double)] = [:]
      for (v, p) in zip(vertices, (graph["from"] as! [[Any]]).map({ $0.map(number) })) { from[v] = (p[0], p[1]) }
      let pos = layoutGraph(data, prev: from)
      for (v, w) in zip(data.vertices, wanted) {
        let p = pos[v]!
        if abs(p.0 - w[0]) > 1e-6 || abs(p.1 - w[1]) > 1e-6 {
          out.append("graph layout: vertex \(v) at \(p), want \(w)")
          break
        }
      }
    }
  }
  return out
}
