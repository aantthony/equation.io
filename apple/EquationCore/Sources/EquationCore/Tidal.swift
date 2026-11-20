#if canImport(Darwin)
  import Darwin
#elseif canImport(Glibc)
  import Glibc
#elseif canImport(Musl)
  import Musl
#elseif canImport(WASILibc)
  import WASILibc
#endif

/// Tidal forces of a panel's metric (lib/tidal.ts): what gravity does to a
/// small cloud of free particles held at rest. `tidal` draws a glyph on a
/// lattice over the window, as `lightcones` does, and `tidal(P)` one at a
/// point.
///
/// The observer is static, u = ∂τ/√(−g_ττ), so it exists only where
/// g_ττ < 0. Neighbouring free particles accelerate apart as ξ'' = −E ξ with
/// E_ab = R_aτbτ / (−g_ττ), the tidal tensor; its eigenvalues λ against the
/// observer's space h_ab = g_ab − g_aτ g_bτ / g_ττ are the tidal
/// accelerations per unit length: λ < 0 stretches along its eigenvector,
/// λ > 0 squeezes. On a spacetime diagram there is one direction of space,
/// and λ = −K. Riemann is formed in numbers at each point from g and its
/// first and second derivatives, taken symbolically once per plot, in the
/// coordinates the metric is written in.

/// What the curvature of a metric needs of its document besides the metric
/// (lib/metric-curvature.ts `CurvatureContext`).
struct CurvatureContext {
  /// The row as the resolver writes it, coordinate fields left as names.
  var written: (Expr) throws -> Expr
  /// The document's coordinate fields, as written.
  var fieldEnv: [String: Expr]
}

/// Components g_ab of the metric, for the index pairs asked, in the
/// coordinates it is written in, other coordinate fields written in them —
/// or nil where one still reads x or y that are not those coordinates, or a
/// differential (lib/metric-curvature.ts `writtenComponents`). With `panel`
/// they may read x and y too, the coordinates still names.
func writtenComponents(
  _ rhs: Expr, _ metric: PanelMetric, _ ctx: CurvatureContext, _ pairs: [(Int, Int)], panel: Bool = false
) throws -> [Expr]? {
  let (n, coords) = (metric.n, metric.coords)
  let spatial = Array(coords[(n - 2)...])
  // d<c> for each coordinate c is its differential (parseMetric decided so).
  func slot(_ k: Int) -> String { "[d\(k)]" }
  var renamed: [String: Expr] = [:]
  for (k, c) in coords.enumerated() { renamed["d\(c)"] = .var(slot(k)) }
  var Q = try ctx.written(substVars(rhs, renamed))
  // Every other field in terms of the coordinates.
  let others = ctx.fieldEnv.filter { !spatial.contains($0.key) }
  for _ in 0..<32 {
    if !freeVars(Q).contains(where: { others[$0] != nil }) { break }
    Q = substVars(Q, others)
  }
  let vars = freeVars(Q)
  if (panel ? ["z", "t"] : ["x", "y", "z", "t"]).contains(where: { vars.contains($0) && !spatial.contains($0) }) {
    return nil
  }
  var form: [Expr] = []
  do {
    for (a, b) in pairs { form.append(mul(.num(0.5), try metricPartial(try metricPartial(Q, slot(a)), slot(b)))) }
  } catch let error as DiffError {
    throw LanguageError(error.message)
  }
  for e in form {
    for name in freeVars(e) where name.hasPrefix("[d") { return nil }
  }
  return form
}

private let PANEL: Set<String> = ["x", "y"]

/// The expressions a panel's tidal glyphs are read from, made once per
/// metric (`tidalSpec`): g in the coordinates it is written in and its first
/// and second derivatives there, with the chart from x and y to them. A
/// metric mixing x and y with fields of them is taken as a function of x, y
/// and them as separate names, the reader combining its partial derivatives
/// by the chain rule. `inXY` writes a coordinate field in x and y.
func tidalSpec(_ rhs: Expr, _ metric: PanelMetric, _ ctx: CurvatureContext, inXY: (Expr) throws -> Expr) throws
  -> TidalSpec
{
  let (n, coords) = (metric.n, metric.coords)
  var pairs: [(Int, Int)] = []
  for i in 0..<n {
    for j in i..<n { pairs.append((i, j)) }
  }
  let params = Array(coords[(n - 2)...])
  let time = n == 3 ? 0 : (metric.timeAxis ?? 1)
  // A component reading x and y may only spell out a coordinate: folded
  // back into its name, it is written in the coordinates after all.
  var folds: [String: Expr] = [:]
  for c in params where !PANEL.contains(c) { folds[exprKey(try inXY(.var(c)))] = .var(c) }
  func fold(_ e: Expr) -> Expr { folds[exprKey(e)] ?? mapChildren(e, fold) }
  let mixed = try writtenComponents(rhs, metric, ctx, pairs, panel: true)?.map(fold)
  func reads(_ e: Expr) -> Bool { freeVars(e).contains { PANEL.contains($0) && !params.contains($0) } }
  let written = try writtenComponents(rhs, metric, ctx, pairs) ?? (mixed?.contains(where: reads) == true ? nil : mixed)
  guard let g = written ?? mixed else {
    throw LanguageError("This metric is too complex to take its tidal forces.")
  }
  // Not x and y: the coordinates as fields of them, and their Jacobian (and
  // for a mixed metric its derivatives).
  let J = metric.jacobian
  var chart: [Expr]?
  if let J {
    chart = try params.map { PANEL.contains($0) ? .var($0) : try inXY(.var($0)) } + J.prefix(written != nil ? 4 : 12)
  }
  var curvature: [Expr]
  var symbols: [String]?
  if written != nil {
    let (p, q) = (params[0], params[1])
    let dp = try g.map { try smoothPartial($0, p) }
    let dq = try g.map { try smoothPartial($0, q) }
    curvature = g + dp + dq
    curvature += try dp.map { try smoothPartial($0, p) }
    curvature += try dp.map { try smoothPartial($0, q) }
    curvature += try dq.map { try smoothPartial($0, q) }
  } else {
    var names = ["x", "y"]
    for p in params where !names.contains(p) { names.append(p) }
    symbols = names
    let first = try names.map { s in try g.map { try smoothPartial($0, s) } }
    curvature = g + first.flatMap { $0 }
    for s in names.indices {
      for t in s..<names.count { curvature += try first[s].map { try smoothPartial($0, names[t]) } }
    }
  }
  if exceedsNodes(curvature + (chart ?? []), 6 * FLOW_NODE_LIMIT) {
    throw LanguageError("This metric is too large to take its tidal forces.")
  }
  return TidalSpec(
    n: n, time: time, params: params, curvature: curvature, symbols: symbols, chart: chart,
    components: metric.components, jacobian: J, at: nil)
}

/// The tides at a point, as read: one or two eigenvalues λ (< 0 stretches)
/// and their eigenvectors in x and y (not of unit length) (`Tides`).
public struct Tides: Sendable {
  public var count = 0
  public var lambda = [0.0, 0.0]
  /// (x, y) of each eigenvector in turn.
  public var dir = [0.0, 0.0, 0.0, 0.0]
}

/// A point's tides, or nil where no static observer is or the metric is not
/// defined. `count` 0: no tide there (flat, to rounding).
public typealias TidalRead = (Double, Double) -> Tides?

/// An eigenvalue under this part of the size of the terms it is the sum of
/// is rounding.
private let ROUNDING = 1e-9

/// The tides of a TidalSpec, its sliders read from `env` (`tidalReader`).
public func tidalReader(_ spec: TidalSpec, _ env: [String: Double]) -> TidalRead {
  let (n, ti, symbols) = (spec.n, spec.time, spec.symbols)
  let m = n * (n + 1) / 2
  // Only what is not a constant is compiled (most second derivatives are 0).
  var live: [Int] = []
  var raw = [Double](repeating: 0, count: spec.curvature.count)
  for (k, e) in spec.curvature.enumerated() {
    if case .num(let value) = e { raw[k] = value } else { live.append(k) }
  }
  let names = symbols ?? spec.params
  let curv = NumericExprs(live.map { spec.curvature[$0] }, names, env)
  let chart = spec.chart.map { numericIn($0, ["x", "y"], env) }
  var lbuf = [Double](repeating: 0, count: live.count)
  var cbuf = [Double](repeating: 0, count: spec.chart?.count ?? 0)
  var vals = [Double](repeating: 0, count: names.count)
  var buf = [Double](repeating: 0, count: 6 * m)
  // A mixed metric's chain rule: each symbol's gradient in x and y and its
  // second derivatives (xx, xy, yy), and the pairs (s ≤ t) in order.
  let ns = symbols?.count ?? 0
  var grad = [Double](repeating: 0, count: 2 * ns)
  var hess = [Double](repeating: 0, count: 3 * ns)
  var pairIndex = [[Int]](repeating: [Int](repeating: 0, count: ns), count: ns)
  var pk = 0
  for s in 0..<ns {
    for t in s..<ns {
      pairIndex[s][t] = pk
      pairIndex[t][s] = pk
      pk += 1
    }
  }
  let field = (symbols ?? []).map { spec.params.firstIndex(of: $0) ?? -1 }
  // The first coordinate differentiated: τ (index 0) is not, with a time.
  let o = n - 2
  let sq = [[Double]](repeating: [Double](repeating: 0, count: n), count: n)
  let cube = [[[Double]]](repeating: sq, count: n)
  return { x, y in
    var p = x
    var q = y
    // J[a][k] = ∂(p, q)_a/∂(x, y)_k.
    var (j00, j01, j10, j11) = (1.0, 0.0, 0.0, 1.0)
    if let chart {
      chart(x, y, &cbuf)
      for v in cbuf where !v.isFinite { return nil }
      (p, q, j00, j01, j10, j11) = (cbuf[0], cbuf[1], cbuf[2], cbuf[3], cbuf[4], cbuf[5])
    }
    let jd = j00 * j11 - j01 * j10
    if !(abs(jd) > 0) { return nil }
    if let symbols {
      for s in 0..<ns {
        let name = symbols[s]
        let a = field[s]
        vals[s] = name == "x" ? x : name == "y" ? y : a == 0 ? p : q
        if name == "x" || name == "y" {
          grad[2 * s] = name == "x" ? 1 : 0
          grad[2 * s + 1] = name == "y" ? 1 : 0
          for c in 0..<3 { hess[3 * s + c] = 0 }
        } else {
          // Row a of J, and its ∂x (cbuf 6..9) and ∂y (cbuf 10..13).
          grad[2 * s] = cbuf[2 + 2 * a]
          grad[2 * s + 1] = cbuf[3 + 2 * a]
          hess[3 * s] = cbuf[6 + 2 * a]
          hess[3 * s + 1] = cbuf[7 + 2 * a]
          hess[3 * s + 2] = cbuf[11 + 2 * a]
        }
      }
    } else {
      vals[0] = p
      vals[1] = q
    }
    curv.read(vals, &lbuf)
    for (k, place) in live.enumerated() { raw[place] = lbuf[k] }
    for v in raw where !v.isFinite { return nil }
    if symbols != nil {
      // Total derivatives in x and y by the chain rule, then in p and q
      // through J⁻¹ (Ji[k][A] = ∂x_k/∂c_A) and its derivatives,
      // ∂_k J⁻¹ = −J⁻¹ (∂_k J) J⁻¹.
      let (i00, i01, i10, i11) = (j11 / jd, -j01 / jd, -j10 / jd, j00 / jd)
      var dI = [Double](repeating: 0, count: 8)
      for kk in 0..<2 {
        let b = 6 + 4 * kk
        let (d00, d01, d10, d11) = (cbuf[b], cbuf[b + 1], cbuf[b + 2], cbuf[b + 3])
        // M = dJ Ji, then −Ji M.
        let m00 = d00 * i00 + d01 * i10
        let m01 = d00 * i01 + d01 * i11
        let m10 = d10 * i00 + d11 * i10
        let m11 = d10 * i01 + d11 * i11
        dI[4 * kk] = -(i00 * m00 + i01 * m10)
        dI[4 * kk + 1] = -(i00 * m01 + i01 * m11)
        dI[4 * kk + 2] = -(i10 * m00 + i11 * m10)
        dI[4 * kk + 3] = -(i10 * m01 + i11 * m11)
      }
      let Ji = [i00, i01, i10, i11]
      for c in 0..<m {
        var (fx, fy, fxx, fxy, fyy) = (0.0, 0.0, 0.0, 0.0, 0.0)
        for s in 0..<ns {
          let fs = raw[m + s * m + c]
          let gx = grad[2 * s]
          let gy = grad[2 * s + 1]
          fx += fs * gx
          fy += fs * gy
          fxx += fs * hess[3 * s]
          fxy += fs * hess[3 * s + 1]
          fyy += fs * hess[3 * s + 2]
          for t in 0..<ns {
            let fst = raw[m + ns * m + pairIndex[s][t] * m + c]
            let hx = grad[2 * t]
            let hy = grad[2 * t + 1]
            fxx += fst * gx * hx
            fxy += fst * gx * hy
            fyy += fst * gy * hy
          }
        }
        let f1 = [fx, fy]
        let f2 = [fxx, fxy, fxy, fyy]
        buf[c] = raw[c]
        for A in 0..<2 { buf[(1 + A) * m + c] = Ji[A] * fx + Ji[2 + A] * fy }
        for w in 0..<3 {
          let A = w == 2 ? 1 : 0
          let B = w == 0 ? 0 : 1
          var v = 0.0
          for k in 0..<2 {
            let jkA = Ji[2 * k + A]
            for l in 0..<2 { v += jkA * (Ji[2 * l + B] * f2[2 * k + l] + dI[4 * k + 2 * l + B] * f1[l]) }
          }
          buf[(3 + w) * m + c] = v
        }
      }
    } else {
      for k in 0..<(6 * m) { buf[k] = raw[k] }
    }
    var g = sq
    // dg[k][i][j] = ∂_k g_ij, dd[k][l][i][j] = ∂_k ∂_l g_ij (0 for k or l = τ).
    var dg = cube
    var dd = [[[[Double]]]](repeating: cube, count: n)
    var k = 0
    for i in 0..<n {
      for j in i..<n {
        for (a, b) in [(i, j), (j, i)] {
          g[a][b] = buf[k]
          // ∂p, ∂q at coordinates o, o + 1.
          dg[o][a][b] = buf[m + k]
          dg[o + 1][a][b] = buf[2 * m + k]
          dd[o][o][a][b] = buf[3 * m + k]
          dd[o][o + 1][a][b] = buf[4 * m + k]
          dd[o + 1][o][a][b] = buf[4 * m + k]
          dd[o + 1][o + 1][a][b] = buf[5 * m + k]
        }
        k += 1
      }
    }
    // The static observer's direction ∂τ, in the written basis.
    let v0: Double = ti == 0 ? 1 : 0
    let v1 = 1 - v0
    let gtt = n == 2 ? g[ti][ti] : g[0][0]
    // A static observer: ∂τ timelike.
    if !(gtt < 0) { return nil }
    // g⁻¹ by cofactors.
    var inv = sq
    if n == 2 {
      let det = g[0][0] * g[1][1] - g[0][1] * g[0][1]
      if !(det < 0) { return nil }
      inv[0][0] = g[1][1] / det
      inv[1][1] = g[0][0] / det
      inv[0][1] = -g[0][1] / det
      inv[1][0] = inv[0][1]
    } else {
      let (A, B, C, D, E, F) = (g[0][0], g[0][1], g[0][2], g[1][1], g[1][2], g[2][2])
      let c00 = D * F - E * E
      let c01 = C * E - B * F
      let c02 = B * E - C * D
      let det = A * c00 + B * c01 + C * c02
      if !(det < 0) { return nil }
      inv[0][0] = c00 / det
      inv[0][1] = c01 / det
      inv[1][0] = inv[0][1]
      inv[0][2] = c02 / det
      inv[2][0] = inv[0][2]
      inv[1][1] = (A * F - C * C) / det
      inv[1][2] = (B * C - A * E) / det
      inv[2][1] = inv[1][2]
      inv[2][2] = (A * D - B * B) / det
    }
    // Γ_l,ij (first kind) and Γ^k_ij.
    var G1 = cube
    var G2 = cube
    for l in 0..<n {
      for i in 0..<n {
        for j in i..<n {
          G1[l][i][j] = 0.5 * (dg[i][j][l] + dg[j][i][l] - dg[l][i][j])
          G1[l][j][i] = G1[l][i][j]
        }
      }
    }
    for c in 0..<n {
      for i in 0..<n {
        for j in i..<n {
          var s = 0.0
          for l in 0..<n { s += inv[c][l] * G1[l][i][j] }
          G2[c][i][j] = s
          G2[c][j][i] = s
        }
      }
    }
    /// R_abcd, and the sum of its terms' sizes.
    func riemann(_ a: Int, _ b: Int, _ c: Int, _ d: Int) -> (Double, Double) {
      let t1 = dd[b][c][a][d]
      let t2 = dd[a][d][b][c]
      let t3 = dd[b][d][a][c]
      let t4 = dd[a][c][b][d]
      var sum = 0.5 * (t1 + t2 - t3 - t4)
      var s = 0.5 * (abs(t1) + abs(t2) + abs(t3) + abs(t4))
      for e in 0..<n {
        let u = G2[e][b][c] * G1[e][a][d]
        let v = G2[e][b][d] * G1[e][a][c]
        sum += u - v
        s += abs(u) + abs(v)
      }
      return (sum, s)
    }
    var out = Tides()
    // Inverse Jacobian, to carry a vector in (p, q) to x and y.
    func toXY(_ vp: Double, _ vq: Double, _ at: Int) {
      out.dir[at] = (j11 * vp - j01 * vq) / jd
      out.dir[at + 1] = (-j10 * vp + j00 * vq) / jd
    }
    if n == 2 {
      // λ = −K = −R_0101/det g, along the direction g-orthogonal to ∂τ.
      let det = g[0][0] * g[1][1] - g[0][1] * g[0][1]
      let (r, size) = riemann(0, 1, 0, 1)
      let lam = -r / det
      let noise = size / abs(det)
      // w = (−(g v)₁, (g v)₀): g(w, v) = 0.
      let gv0 = g[0][0] * v0 + g[0][1] * v1
      let gv1 = g[1][0] * v0 + g[1][1] * v1
      toXY(-gv1, gv0, 0)
      out.lambda[0] = lam
      out.count = abs(lam) > ROUNDING * noise && lam.isFinite ? 1 : 0
      return out
    }
    // E_ab = R_aτbτ / (−g_ττ) on the spatial coordinates 1, 2, and its
    // sizes; h_ab = g_ab − g_aτ g_bτ / g_ττ.
    let minus = -gtt
    let (r11, z11) = riemann(1, 0, 1, 0)
    let (r12, z12) = riemann(1, 0, 2, 0)
    let (r22, z22) = riemann(2, 0, 2, 0)
    let (e11, e12, e22) = (r11 / minus, r12 / minus, r22 / minus)
    let (s11, s12, s22) = (z11 / minus, z12 / minus, z22 / minus)
    let h11 = g[1][1] - (g[1][0] * g[1][0]) / gtt
    let h12 = g[1][2] - (g[1][0] * g[2][0]) / gtt
    let h22 = g[2][2] - (g[2][0] * g[2][0]) / gtt
    let hdet = h11 * h22 - h12 * h12
    if !(h11 > 0) || !(hdet > 0) { return nil }
    // An orthonormal basis of h: f1 = ∂1/√h11, f2 = (∂2 − (h12/h11) ∂1)/√(hdet/h11).
    let a = 1 / h11.squareRoot()
    let b2 = 1 / (hdet / h11).squareRoot()
    let b1 = (-h12 / h11) * b2
    // Ê = Fᵀ E F with F = [[a, b1], [0, b2]].
    let E11 = a * a * e11
    let E12 = a * (b1 * e11 + b2 * e12)
    let E22 = b1 * b1 * e11 + 2 * b1 * b2 * e12 + b2 * b2 * e22
    // What Ê's entries could be at most from the terms' sizes.
    let noise = JS.pow(abs(a) + abs(b1) + abs(b2), 2) * JS.max([s11, s12, s22])
    let mean = (E11 + E22) / 2
    let spread = hypot((E11 - E22) / 2, E12)
    if !mean.isFinite || !spread.isFinite { return nil }
    let th = atan2(2 * E12, E11 - E22) / 2
    let (c, s) = (cos(th), sin(th))
    // Eigenvectors in the orthonormal basis (c, s) and (−s, c), in (p, q).
    out.lambda[0] = mean + spread
    out.lambda[1] = mean - spread
    toXY(a * c + b1 * s, b2 * s, 0)
    toXY(-a * s + b1 * c, b2 * c, 2)
    let floor = ROUNDING * noise
    if abs(out.lambda[0]) <= floor { out.lambda[0] = 0 }
    if abs(out.lambda[1]) <= floor { out.lambda[1] = 0 }
    out.count = (out.lambda[0] != 0 && !out.lambda[0].isNaN) || (out.lambda[1] != 0 && !out.lambda[1].isNaN) ? 2 : 0
    return out
  }
}

/// A glyph's longer bar reaches this part of a lattice cell, and never
/// further than TIDAL_CAP of it, nor a lone tidal(P)'s past LONE_TIDAL_PX.
let TIDAL_REACH = 0.2
let TIDAL_CAP = 0.46
let LONE_TIDAL_PX = 60.0
/// An arrowhead's length (points), at most this or half its bar.
let TIDAL_HEAD_PX = 6.0
/// A bar shorter than this many points each way is not drawn.
private let MIN_BAR_PX = 1.5
/// How far (in powers of two) the median may drift before a panel's scale changes.
private let HOLD_DOWN = 1.5
private let HOLD_UP = 1.0

/// The size of the strongest tide at a point, or NaN with none.
private func strongest(_ t: Tides?) -> Double {
  guard let t, t.count > 0 else { return .nan }
  return t.count == 1 ? abs(t.lambda[0]) : JS.max([abs(t.lambda[0]), abs(t.lambda[1])])
}

/// The panel's tidal scale over a view, in points per unit of λ: a power of
/// two, so the median glyph's longer bar reaches TIDAL_REACH of a lattice
/// cell — or NaN when no glyph is in view (`tidalScale`). With the scale it
/// had before (`previous`), it keeps it while the median stays within
/// HOLD_DOWN and HOLD_UP of where the median asks.
public func tidalScale(
  _ read: TidalRead, _ view: ConeView, skip: ((Double, Double) -> Bool)? = nil, previous: Double? = nil
) -> Double {
  var sizes: [Double] = []
  for (x, y) in coneLattice(view) {
    let s = strongest(read(x, y))
    if s > 0 && skip?(x, y) != true { sizes.append(s) }
  }
  if sizes.isEmpty { return .nan }
  sizes.sort()
  let median = sizes[sizes.count / 2]
  let cellPx = coneCell(view.upp) / view.upp
  let ideal = log2(TIDAL_REACH * cellPx / median)
  if let previous, previous > 0 {
    let drift = log2(previous) - ideal
    if drift <= HOLD_UP && drift >= -HOLD_DOWN { return previous }
  }
  return JS.pow(2, JS.round(ideal))
}

/// The tidal glyphs of `read` at `at`, or over the view's lattice, at
/// `scale` points per unit λ (`tidalGlyphs`): bars along the eigenvectors as
/// `lines`, arrowheads as filled triangles in `rings` — out at the ends
/// where λ < 0 stretches, in where λ > 0 squeezes.
public func tidalGlyphs(
  _ read: TidalRead, _ view: ConeView, at: [(Double, Double)]? = nil, scale: Double? = nil,
  cut: ((Double, Double) -> Bool)? = nil
) -> ConeGlyphs {
  var out = ConeGlyphs()
  let points = at ?? coneLattice(view)
  let (upp, uppY) = (view.upp, view.uppY)
  let cellPx = coneCell(upp) / upp
  let cap = at != nil ? LONE_TIDAL_PX : TIDAL_CAP * cellPx
  for (x, y) in points {
    if !x.isFinite || !y.isFinite { continue }
    guard let t = read(x, y), t.count > 0 else { continue }
    if cut?(x, y) == true { continue }
    let big = strongest(t)
    var s = Double.nan
    if let scale, scale.isFinite {
      s = scale
    } else if at != nil {
      s = JS.pow(2, JS.round(log2(TIDAL_REACH * cellPx / big)))
    }
    if !s.isFinite { break }
    // Shrunk whole when the longer bar would pass the cap.
    let shrink = JS.min([1, cap / (s * big)])
    for k in 0..<t.count {
      let lam = t.lambda[k]
      let L = s * shrink * abs(lam)
      if !(L >= MIN_BAR_PX) { continue }
      // The eigenvector's direction on the screen, in points.
      var (dx, dy) = (t.dir[2 * k] / upp, t.dir[2 * k + 1] / uppY)
      let len = hypot(dx, dy)
      if !(len > 0) { continue }
      (dx, dy) = (dx / len, dy / len)
      let (nx, ny) = (-dy, dx)
      let H = min(TIDAL_HEAD_PX, L / 2)
      let W = 0.5 * H
      // In math units: along the bar, and across it, per point.
      let (ax, ay) = (dx * upp, dy * uppY)
      let (cx, cy) = (nx * upp, ny * uppY)
      out.lines += [x - L * ax, y - L * ay, x + L * ax, y + L * ay, .nan, .nan]
      for side in [1.0, -1.0] {
        // Stretch: the tip at the end, pointing out. Squeeze: the tip a
        // head's length in, pointing in.
        let tip = side * (lam < 0 ? L : L - H)
        let base = side * (lam < 0 ? L - H : L)
        let (bx, by) = (x + base * ax, y + base * ay)
        out.rings += [x + tip * ax, y + tip * ay, bx + W * cx, by + W * cy, bx - W * cx, by - W * cy, .nan, .nan]
      }
    }
  }
  return out
}
