#if canImport(Darwin)
  import Darwin
#elseif canImport(Glibc)
  import Glibc
#elseif canImport(Musl)
  import Musl
#elseif canImport(WASILibc)
  import WASILibc
#endif

/// Graphs: `graph(from, to)` and `graph(from, to, label)` (lib/graph.ts,
/// docs/discrete.md §4).
///
/// The arguments are read as the tuple `(from, to, label)`, so the multiset
/// rule does the combinatorics: with `k = [0..11]`, `graph(k, mod(k + 1, 12))`
/// is the cycle C₁₂, and with separate lists of states and symbols
/// `graph(Q, d(Q, S), S)` is every transition of a state machine. `graph(P)`
/// takes a list of pairs as it is: `graph([(1, 2), (2, 3)])`.
///
/// Each element is an edge. Vertices are the numbers the edges meet; an edge
/// listed twice (the same from, to and label) is one arrow with its count.

/// The arguments of a row that is one call of `name` as a whole, as
/// `graph(…)` and `mark(v)` rows are (`wholeCall`). Nil when the call's `)`
/// is not the row's end, as in `graph(1, 2) * (3)`.
func wholeCall(_ name: String, _ text: String) -> String? {
  let u = Array(text.utf16)
  var k = 0
  while k < u.count, isJSWhitespace(u[k]) { k += 1 }
  for c in name.utf16 {
    guard k < u.count, u[k] == c else { return nil }
    k += 1
  }
  while k < u.count, isJSWhitespace(u[k]) { k += 1 }
  guard k < u.count, u[k] == unit("(") else { return nil }
  k += 1
  let start = k
  var depth = 1
  var quote: UInt16?
  while k < u.count {
    let c = u[k]
    if let q = quote {
      if c == q { quote = nil }
    } else if c == unit("\"") || c == unit("'") {
      quote = c
    } else if c == unit("(") {
      depth += 1
    } else if c == unit(")") {
      depth -= 1
      if depth == 0 {
        let rest = String(decoding: u[(k + 1)...], as: UTF16.self)
        return jsTrimmed(rest).isEmpty ? String(decoding: u[start..<k], as: UTF16.self) : nil
      }
    }
    k += 1
  }
  return nil
}

/// The graph a `graph(…)` row denotes, from the classification of its tuple
/// (`graphObject`).
func graphObject(_ cls: Classified) throws -> Classified {
  let usage = "graph(from, to) or graph(from, to, label) takes numbers, or lists of them, as vertices."
  var edges: [[Expr]]
  switch cls.object {
  case .list(.points(_, let values)): edges = values
  case .point(let coordinates): edges = [coordinates]
  default: throw LanguageError(usage)
  }
  if edges.contains(where: { $0.count < 2 || $0.count > 3 }) { throw LanguageError(usage) }
  // Vertices are whole numbers, so a case may test equality: an arrow of A
  // composes with one of B where they meet, {A.y = B.x: A.x}.
  edges = edges.map { $0.map(exactCases) }
  var out = cls
  out.object = .graph(edges: edges)
  out.needs3D = false
  return out
}

public struct GraphEdge: Equatable, Sendable {
  public var from: Double
  public var to: Double
  /// Labels on this arrow, each with how many times it is listed.
  public var labels: [(label: Double?, count: Int)]

  public static func == (a: GraphEdge, b: GraphEdge) -> Bool {
    a.from == b.from && a.to == b.to && a.labels.count == b.labels.count
      && zip(a.labels, b.labels).allSatisfy { $0.label == $1.label && $0.count == $1.count }
  }
}

public struct GraphData: Equatable, Sendable {
  /// Every vertex, ascending.
  public var vertices: [Double]
  /// One entry per ordered pair (from, to) that has an arrow.
  public var edges: [GraphEdge]
}

/// The edges' values in an environment (`edgeEvaluator`; the site compiles
/// them for its VM, which computes what `evaluate` does). A coordinate that
/// cannot be evaluated is NaN.
public func evaluateEdges(_ edges: [[Expr]], _ env: [String: Double]) -> [[Double]] {
  var scope = env
  return edges.map { $0.map { (try? evaluate($0, &scope)) ?? .nan } }
}

/// Collect evaluated edges ([from, to] or [from, to, label]); rows with a
/// non-finite vertex are left out (`collectEdges`).
public func collectEdges(_ rows: [[Double]]) -> GraphData {
  var vertices: Set<Double> = []
  var order: [String] = []
  var byPair: [String: GraphEdge] = [:]
  for row in rows where row.count >= 2 {
    let (from, to) = (row[0], row[1])
    if !from.isFinite || !to.isFinite { continue }
    // (-0 and 0 are one vertex, as in a JavaScript Set.)
    vertices.insert(from == 0 ? 0 : from)
    vertices.insert(to == 0 ? 0 : to)
    let key = "\(JS.string(from))>\(JS.string(to))"
    if byPair[key] == nil {
      byPair[key] = GraphEdge(from: from, to: to, labels: [])
      order.append(key)
    }
    let label: Double? = row.count > 2 && row[2].isFinite ? row[2] : nil
    if let seen = byPair[key]!.labels.firstIndex(where: { $0.label == label }) {
      byPair[key]!.labels[seen].count += 1
    } else {
      byPair[key]!.labels.append((label, 1))
    }
  }
  let edges = order.map { key -> GraphEdge in
    var e = byPair[key]!
    // (A stable sort, as JavaScript's is.)
    let sorted = e.labels.enumerated().sorted {
      let (a, b) = ($0.element.label ?? -.infinity, $1.element.label ?? -.infinity)
      return a != b ? a < b : $0.offset < $1.offset
    }
    e.labels = sorted.map(\.element)
    return e
  }
  return GraphData(vertices: vertices.sorted(), edges: edges)
}

/// How an edge reads: its labels ("0, 1"), each with its count past one
/// ("a ×2") (`edgeText`).
public func edgeText(_ e: GraphEdge) -> String {
  e.labels.map { item -> String in
    let name = item.label.map { JS.string(JS.number(JS.toPrecision($0, 6))) } ?? ""
    return item.count > 1 ? (name.isEmpty ? "×\(item.count)" : "\(name) ×\(item.count)") : name
  }.filter { !$0.isEmpty }.joined(separator: ", ")
}

/// A vertex as its ring reads (web/scene.ts `graphOverlay`).
public func vertexText(_ v: Double) -> String { JS.string(JS.number(JS.toPrecision(v, 6))) }

/// Layout radius: every vertex lands within this distance of the origin.
public let GRAPH_RADIUS = 4.5
/// The layout's pull toward the origin, growing with distance.
private let GRAVITY = 0.2

/// The radius n vertices are fitted to: small graphs stay small.
public func graphRadius(_ n: Int) -> Double { JS.min([GRAPH_RADIUS, JS.max([2.75, 1.25 * Double(n).squareRoot()])]) }

/// Place the vertices: a force layout (Fruchterman–Reingold) started from a
/// circle in vertex order, so a cycle stays a circle and the result is the
/// same every time (`layoutGraph`). `prev` positions (same vertices) start
/// it where it was, so an edit that keeps the vertices keeps the picture.
/// Fitted to graphRadius(n) about the origin.
///
/// (The circle is the platform's cos and sin, as it is the site's in a
/// browser on the same machine. Node's round an ulp apart here and there,
/// and a symmetric graph settles by that rounding: the fixture holds the
/// layout from a given start instead.)
public func layoutGraph(_ g: GraphData, prev: [Double: (Double, Double)]? = nil) -> [Double: (Double, Double)] {
  let n = g.vertices.count
  var index: [Double: Int] = [:]
  for (k, v) in g.vertices.enumerated() { index[v] = k }
  var xs = [Double](repeating: 0, count: n)
  var ys = [Double](repeating: 0, count: n)
  let reuse = prev.map { p in p.count == n && g.vertices.allSatisfy { p[$0] != nil } } ?? false
  for (k, v) in g.vertices.enumerated() {
    let a = (2 * Double.pi * Double(k)) / Double(max(1, n)) - Double.pi / 2
    if reuse, let p = prev?[v] {
      (xs[k], ys[k]) = p
    } else {
      xs[k] = cos(a) * GRAPH_RADIUS
      ys[k] = -sin(a) * GRAPH_RADIUS
    }
  }
  // Undirected, without loops or repeats: a force per pair of neighbours.
  var links: [(Int, Int)] = []
  var seen: Set<[Int]> = []
  for e in g.edges {
    guard let a = index[e.from == 0 ? 0 : e.from], let b = index[e.to == 0 ? 0 : e.to], a != b else { continue }
    if !seen.insert(a < b ? [a, b] : [b, a]).inserted { continue }
    links.append((a, b))
  }
  if n > 1 && n <= 400 {
    let area = (2 * GRAPH_RADIUS) * (2 * GRAPH_RADIUS)
    let k = (area / Double(n)).squareRoot()
    let steps = reuse ? 60 : 300
    var temp = reuse ? k * 0.2 : GRAPH_RADIUS
    var dx = [Double](repeating: 0, count: n)
    var dy = [Double](repeating: 0, count: n)
    for _ in 0..<steps {
      for i in 0..<n {
        dx[i] = 0
        dy[i] = 0
      }
      for i in 0..<n {
        for j in (i + 1)..<max(i + 1, n) {
          var ex = xs[i] - xs[j]
          var ey = ys[i] - ys[j]
          var d2 = ex * ex + ey * ey
          if d2 < 1e-9 {
            // Coincident: part them along a fixed direction.
            ex = 1e-3 * Double(i - j)
            ey = 1e-3
            d2 = ex * ex + ey * ey
          }
          let f = (k * k) / d2
          dx[i] += ex * f
          dy[i] += ey * f
          dx[j] -= ex * f
          dy[j] -= ey * f
        }
      }
      for (a, b) in links {
        let ex = xs[a] - xs[b]
        let ey = ys[a] - ys[b]
        let root = (ex * ex + ey * ey).squareRoot()
        let d = root == 0 ? 1e-9 : root
        let f = d / k
        dx[a] -= ex * f
        dy[a] -= ey * f
        dx[b] += ex * f
        dy[b] += ey * f
      }
      // Gravity toward the centre, so separate components stay in view
      // instead of flying apart (then the fit would crush each one).
      for i in 0..<n {
        let d = jsHypot([xs[i], ys[i]])
        dx[i] -= xs[i] * GRAVITY * d
        dy[i] -= ys[i] * GRAVITY * d
      }
      for i in 0..<n {
        let d = (dx[i] * dx[i] + dy[i] * dy[i]).squareRoot()
        if d > 0 {
          let m = JS.min([d, temp]) / d
          xs[i] += dx[i] * m
          ys[i] += dy[i] * m
        }
      }
      temp *= 0.985
    }
  }
  // Centre and fit.
  var cx = 0.0
  var cy = 0.0
  for i in 0..<n {
    cx += xs[i] / Double(n)
    cy += ys[i] / Double(n)
  }
  var r = 0.0
  for i in 0..<n { r = JS.max([r, jsHypot([xs[i] - cx, ys[i] - cy])]) }
  let scale = r > 0 ? graphRadius(n) / r : 1
  var out: [Double: (Double, Double)] = [:]
  for (i, v) in g.vertices.enumerated() { out[v] = ((xs[i] - cx) * scale, (ys[i] - cy) * scale) }
  return out
}
