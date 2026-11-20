import EquationCore
import Foundation

// Graphs (web/scene.ts, case 'graph' and `graphOverlay`): a `graph(…)` row's
// arrows, vertices and edge labels, laid out by the core's `layoutGraph`.

/// What each graph row last laid out, and from which values. Shared by the
/// copies of a graph, which are the same rows.
final class GraphLayouts: Equatable, @unchecked Sendable {
  struct Laid {
    /// The constants the row reads (and t, when it moves), as their bits.
    var values: [UInt64]
    var data: GraphData
    var pos: [Double: (Double, Double)]
  }

  private let lock = NSLock()
  private var rows: [Int: Laid] = [:]

  /// A cache is no part of what a graph is.
  static func == (_: GraphLayouts, _: GraphLayouts) -> Bool { true }

  /// The row's graph and where its vertices are. Evaluated again only when
  /// a value it reads changes (a pan redraws the same arrows), and laid out
  /// again only when the graph changes, from where it was.
  func laid(row: Int, values: [UInt64], _ evaluate: () -> GraphData) -> Laid {
    lock.lock()
    let hit = rows[row]
    lock.unlock()
    if let hit, hit.values == values { return hit }
    let data = evaluate()
    let laid =
      hit?.data == data
      ? Laid(values: values, data: data, pos: hit!.pos)
      : Laid(values: values, data: data, pos: layoutGraph(data, prev: hit?.pos))
    lock.lock()
    rows[row] = laid
    lock.unlock()
    return laid
  }
}

extension Graph2D {
  /// A graph has no coordinates to grid: a panel of graphs draws none unless
  /// asked (web/scene.ts `renderFrame`, `graphs`). True when the panel has a
  /// graph, every row it draws is a graph or a readout, and no grid(…) row.
  static func isGraphPanel(_ analysis: DocumentAnalysis) -> Bool {
    var any = false
    func plain(_ cpu: CpuPlan) -> Bool {
      switch cpu {
      case .graph:
        any = true
        return true
      case .value, .note: return true
      // (Each member of a family is a row of its own to the site.)
      case .family(let members): return members.allSatisfy { plain($0.cpu) }
      default: return false
      }
    }
    for row in analysis.rows {
      switch row.view {
      case .grid?, .gridCoords?: return false
      default: break
      }
      // (A row with an error or no classification draws nothing and decides nothing.)
      guard row.error == nil, row.unsupported == nil, row.classified != nil, let cpu = row.cpu else { continue }
      if !plain(cpu) { return false }
    }
    return any
  }

  /// The values the panel's `mark(v)` rows highlight (web/scene.ts, case 'graph').
  func marks(_ env: [String: Double]) -> Set<Double> {
    var marks: Set<Double> = []
    for row in analysis.rows where row.mark && row.error == nil {
      if case .value(let expr, _)? = row.cpu, let v = try? evaluate(expr, env) { marks.insert(v) }
    }
    return marks
  }

  /// Draw a graph row: its arrows, vertices and edge labels. `pointsPerUnit`
  /// is the window's scale, which a vertex's ring is sized against.
  func drawGraph(
    _ edges: [[Expr]], row index: Int, color: CSSColor, env: [String: Double], time: Double,
    pointsPerUnit: Double?, into overlay: inout Overlay2D
  ) {
    let row = analysis.rows[index]
    let params = (row.classified?.params ?? []).map { (env[$0] ?? .nan).bitPattern }
    let values = params + [(row.classified?.animated == true ? time : 0).bitPattern]
    let laid = graphLayouts.laid(row: index, values: values) { collectEdges(evaluateEdges(edges, env)) }
    // A vertex's radius in plane units, so arrows stop at its ring.
    let node = graphNodePx / (pointsPerUnit ?? 50)
    graphOverlay(laid.data, laid.pos, color: color, marks: marks(env), node: node, into: &overlay)
  }
}

/// A graph's arrows, vertices and edge labels for the overlay
/// (`graphOverlay`). `node` is a vertex's radius in plane units, so arrows
/// stop at its ring. An arrow whose reverse is also drawn bends to its own
/// side, a loop hangs above its vertex, and the rest are straight.
func graphOverlay(
  _ data: GraphData, _ pos: [Double: (Double, Double)], color: CSSColor, marks: Set<Double>, node: Double,
  into extras: inout Overlay2D
) {
  func key(_ from: Double, _ to: Double) -> [Double] { [from == 0 ? 0 : from, to == 0 ? 0 : to] }
  var texts: [[Double]: String] = [:]
  for e in data.edges { texts[key(e.from, e.to)] = edgeText(e) }
  var tags = extras.tags ?? []
  for e in data.edges {
    // Both ways with the same labels (an involution's two arrows, s·s = 1)
    // is one plain line, drawn from the smaller end.
    let reverse = texts[key(e.to, e.from)]
    let both = e.from != e.to && reverse == texts[key(e.from, e.to)]
    if both && e.from > e.to { continue }
    guard let (ax, ay) = pos[e.from == 0 ? 0 : e.from], let (bx, by) = pos[e.to == 0 ? 0 : e.to] else { continue }
    let text = edgeText(e)
    var pts: [Double] = []
    let mid: (Double, Double)
    if e.from == e.to {
      // A loop: a circle above the vertex, entering it from the right.
      let r = node * 1.3
      let cx = ax
      let cy = ay + node + r * 0.45
      let start = Double.pi * 1.25
      let end = Double.pi * 1.25 - Double.pi * 1.5
      // Few enough steps that the last is long enough to carry the head.
      for k in 0...9 {
        let a = start + ((end - start) * Double(k)) / 9
        pts += [cx + r * cos(a), cy + r * sin(a)]
      }
      mid = (cx, cy + r + node * 0.6)
    } else {
      let hyp = hypot(bx - ax, by - ay)
      let len = hyp == 0 ? 1 : hyp
      // Perpendicular, to the arrow's left; bend only when the reverse is drawn too.
      let (nx, ny) = (-(by - ay) / len, (bx - ax) / len)
      let bend = reverse != nil && !both ? len * 0.18 : 0
      let (qx, qy) = ((ax + bx) / 2 + nx * bend, (ay + by) / 2 + ny * bend)
      let t0 = min(0.45, node / len)
      let t1 = 1 - min(0.45, (node * 1.1) / len)
      // The arrowhead is as long as the last segment (`arrowHead`), so the
      // curve stops a head short of the tip and one segment finishes it.
      let tHead = max(t0, t1 - (node * 0.95) / len)
      func at(_ t: Double) {
        let u = 1 - t
        pts += [u * u * ax + 2 * u * t * qx + t * t * bx, u * u * ay + 2 * u * t * qy + t * t * by]
      }
      for k in 0...12 { at(t0 + ((tHead - t0) * Double(k)) / 12) }
      at(t1)
      let lift = bend != 0 ? bend / 2 + node * 0.55 : node * 0.55
      mid = ((ax + bx) / 2 + nx * lift, (ay + by) / 2 + ny * lift)
    }
    extras.polylines.append(.init(pts: pts, color: color, width: 1.75, arrow: !both))
    if !text.isEmpty { tags.append(.init(x: mid.0, y: mid.1, text: text, color: color)) }
  }
  if !tags.isEmpty || extras.tags != nil { extras.tags = tags }
  var nodes = extras.nodes ?? []
  for v in data.vertices {
    guard let (x, y) = pos[v] else { continue }
    nodes.append(.init(x: x, y: y, text: vertexText(v), color: color, mark: marks.contains(v) ? true : nil))
  }
  extras.nodes = nodes
}
