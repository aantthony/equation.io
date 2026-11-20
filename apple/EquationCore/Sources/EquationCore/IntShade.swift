/// The shaded area of a definite-integral row (`int[0..1] x^2 dx`): the region
/// between the integrand and the axis over [a, b], as CPU-sampled polygons
/// (lib/intshade.ts). The row still denotes the number — this is the picture
/// of that number, the same way `P(X < b)` is a readout that shades.
///
/// The integration variable runs along the horizontal axis whatever it is
/// called: `int[0..1] u^2 du` shades under the curve y = u² drawn over the
/// x-axis, exactly as if it had been written in x.

/// One stretch of the integrand on one side of the axis: the curve's points
/// [x0, y0, x1, y1, …], unclamped. `sign` is the run's contribution to the
/// integral's VALUE — so with reversed bounds (`int[1..0]`, which negates the
/// integral) a run above the axis is −1. The tints follow the number the row
/// reads out, not the side of the axis.
public struct ShadeRun: Equatable, Sendable {
  public var sign: Int
  public var pts: [Double]
  /// The run starts / ends where the WINDOW cut the range, not at a bound, a
  /// gap or a crossing: there is no edge of the region there to stroke.
  public var clipLo: Bool
  public var clipHi: Bool

  public init(sign: Int, pts: [Double], clipLo: Bool, clipHi: Bool) {
    self.sign = sign
    self.pts = pts
    self.clipLo = clipLo
    self.clipHi = clipHi
  }
}

/// The tint for areas that subtract from the value: the row color's
/// complement, as signed scalar fields shade. A near-grey row color (the
/// palette's black / light slot) has a complement that IS the background, so
/// it takes a fixed red instead — legible on both themes.
public func minusTint(_ r: Double, _ g: Double, _ b: Double) -> (Double, Double, Double) {
  if max(r, g, b) - min(r, g, b) < 0.2 { return (0.85, 0.35, 0.3) }
  return (1 - r, 1 - g, 1 - b)
}

/// Samples across the visible part of [a, b].
public let SHADE_SAMPLES = 400
/// Bisection steps per zero crossing or domain edge: 2^-20 of a sample gap.
private let REFINE_STEPS = 20
/// Hard cap on integrand evaluations per call, refinements included. A wildly
/// oscillating integrand (`sin(1000 x)`) crosses zero between most samples;
/// once the refinement budget is spent the remaining crossings fall back to
/// the chord's zero, so an animated bound stays a bounded per-frame cost.
public let SHADE_MAX_EVALS = 8 * SHADE_SAMPLES

/// A bound's value: ±∞ for ±inf, else evaluated (NaN when it cannot be).
public func boundValue(_ e: Expr, _ env: [String: Double]) -> Double {
  if case .var("inf") = e { return .infinity }
  if case .neg(.var("inf")) = e { return -.infinity }
  return (try? evaluate(e, env)) ?? .nan
}

/// Sample the region between f and the axis over [lo, hi], clipped to the
/// visible [xmin, xmax]: bounds at infinity or far off-screen cost nothing and
/// resolution stays per-pixel when zoomed in. Runs break — never bridge —
/// where f is undefined (a pole's NaN, outside a no-default piecewise, sqrt of
/// a negative), and split exactly at sign changes, each refined by bisection.
/// Nothing here depends on the vertical window: see runPaths.
public func integralRuns(
  _ f: (Double) throws -> Double, _ lo: Double, _ hi: Double, _ xmin: Double, _ xmax: Double,
  _ n: Int = SHADE_SAMPLES
) -> [ShadeRun] {
  var out: [ShadeRun] = []
  // lo == hi is an empty region (and a zero integral); a NaN bound has none.
  if lo == hi || lo.isNaN || hi.isNaN { return out }
  let reversed = hi < lo
  let a = max(min(lo, hi), xmin)
  let b = min(max(lo, hi), xmax)
  if !(b > a) { return out }
  let clippedLo = min(lo, hi) < xmin
  let clippedHi = max(lo, hi) > xmax

  var refineLeft = SHADE_MAX_EVALS - (n + 1)
  func at(_ x: Double) -> Double {
    // ±∞ is a pole sampled dead on: undefined there, like NaN.
    guard let y = try? f(x), y.isFinite else { return .nan }
    return y
  }
  /// Claim one refinement's worth of evaluations, while the budget lasts.
  func canRefine() -> Bool {
    if refineLeft < REFINE_STEPS { return false }
    refineLeft -= REFINE_STEPS
    return true
  }
  // Signs are compared, never multiplied: the product of two tiny values
  // underflows to 0 and hides the crossing.
  func opposite(_ p: Double, _ q: Double) -> Bool { p != 0 && q != 0 && (p > 0) != (q > 0) }
  func signOf(_ y: Double) -> Int { y > 0 ? 1 : y < 0 ? -1 : 0 }

  var cur: [Double]?
  var curSign = 0
  func open(_ x: Double, _ y: Double) {
    cur = [x, y]
    curSign = signOf(y)
  }
  func push(_ x: Double, _ y: Double) {
    cur!.append(x)
    cur!.append(y)
    if curSign == 0 { curSign = signOf(y) }
  }
  func close() {
    guard let pts = cur else { return }
    // A run that never left the axis, or is a single point, encloses nothing.
    if curSign != 0 && pts.count >= 4 {
      out.append(
        ShadeRun(
          sign: (curSign > 0) != reversed ? 1 : -1, pts: pts, clipLo: clippedLo && pts[0] == a,
          clipHi: clippedHi && pts[pts.count - 2] == b))
    }
    cur = nil
    curSign = 0
  }

  /// The last defined x toward xBad, starting from a defined xOk.
  func edge(_ xOk0: Double, _ yOk0: Double, _ xBad0: Double) -> (Double, Double) {
    var (xOk, yOk, xBad) = (xOk0, yOk0, xBad0)
    if !canRefine() { return (xOk, yOk) }
    for _ in 0..<REFINE_STEPS {
      let xm = (xOk + xBad) / 2
      let ym = at(xm)
      if ym.isNaN {
        xBad = xm
      } else {
        xOk = xm
        yOk = ym
      }
    }
    return (xOk, yOk)
  }

  var px = a
  var py = at(a)
  if !py.isNaN { open(px, py) }
  for k in stride(from: 1, through: n, by: 1) {
    let x = k == n ? b : a + ((b - a) * Double(k)) / Double(n)
    let y = at(x)
    let was = !py.isNaN
    let isDefined = !y.isNaN
    if was && !isDefined {
      let (ex, ey) = edge(px, py, x)
      if ex != px { push(ex, ey) }
      close()
    } else if !was && isDefined {
      let (ex, ey) = edge(x, y, px)
      open(ex, ey)
      if ex != x { push(x, y) }
    } else if was && isDefined {
      if opposite(py, y) {
        // A sign change: shrink the bracket to [xa, xb] and end one tint at
        // xa, start the other at xb. A continuous crossing has f ≈ 0 at both,
        // so the runs meet on the axis; a jump (or a pole) keeps its two
        // one-sided values, and an undefined point inside splits the run.
        var (xa, ya, xb, yb) = (px, py, x, y)
        if canRefine() {
          var xz = Double.nan  // an exact zero, or an undefined point, inside the bracket
          var hole = false
          for _ in 0..<REFINE_STEPS {
            let xm = (xa + xb) / 2
            let ym = at(xm)
            if ym.isNaN || ym == 0 {
              xz = xm
              hole = ym != 0
              break
            }
            if (ym > 0) == (ya > 0) {
              xa = xm
              ya = ym
            } else {
              xb = xm
              yb = ym
            }
          }
          if hole {
            (xa, ya) = edge(xa, ya, xz)
            (xb, yb) = edge(xb, yb, xz)
          } else if !xz.isNaN {
            (xa, xb) = (xz, xz)
            (ya, yb) = (0, 0)
          }
          if xa != px { push(xa, ya) }
          close()
          open(xb, yb)
          if xb != x { push(x, y) }
        } else {
          // Budget spent: the chord's zero. The ratio of two same-scale
          // values stays in [0, 1] however small they are.
          let xc = px + (x - px) * (py / (py - y))
          push(xc, 0)
          close()
          open(xc, 0)
          push(x, y)
        }
      } else {
        push(x, y)
        // A sample landing exactly on the axis ends the run, so the next one
        // takes its own sign (x^3 sampled at 0 must not span both tints).
        if y == 0 {
          close()
          open(x, 0)
        }
      }
    }
    px = x
    py = y
  }
  close()
  return out
}

/// A run's drawable paths under the current vertical window. `fill` is the
/// closed region down to the axis; `stroke` is the open outline of its REAL
/// edges — the curve, plus the verticals at a bound, a gap or a jump, but not
/// where the window clipped the range (a line on the canvas border would read
/// as a bound) and not the axis. y (the axis included) is clamped to one
/// window-height beyond the window, which cannot change what is visible but
/// keeps a pole's spike, or a far-off axis, drawable. Cheap enough per frame,
/// so a vertical pan never resamples the integrand. `zero` is where y = 0 is
/// drawn: elsewhere on a mapped axis, or past an edge.
public func runPaths(_ run: ShadeRun, _ ymin: Double, _ ymax: Double, zero: Double = 0)
  -> (fill: [Double], stroke: [Double])
{
  let pad = ymax - ymin
  // (Math.min(Math.max(y, lo), hi): a NaN stays NaN.)
  func clampY(_ y: Double) -> Double { y.isNaN ? y : min(max(y, ymin - pad), ymax + pad) }
  let base = clampY(zero)
  let p = run.pts
  var curve: [Double] = []
  for i in stride(from: 0, to: p.count, by: 2) {
    curve.append(p[i])
    curve.append(clampY(p[i + 1]))
  }
  let x0 = p[0]
  let x1 = p[p.count - 2]
  return (
    [x0, base] + curve + [x1, base],
    (run.clipLo ? [] : [x0, base]) + curve + (run.clipHi ? [] : [x1, base])
  )
}

/// The names whose values the shade reads: everything free in the bounds,
/// plus everything free in the integrand EXCEPT the integration variable,
/// which is bound there only — in `int[0..t] t^2 dt` the bound's t is time.
/// A resample is due exactly when one of these (or the x-window) changes.
public func shadeNames(_ shade: IntShade) -> [String] {
  var names = freeVars(shade.body)
  names.remove(shade.v)
  for name in freeVars(shade.lo) { names.insert(name) }
  for name in freeVars(shade.hi) { names.insert(name) }
  names.remove("inf")
  return names.list
}

/// integralRuns for a row's shade under env (lib/intshade.ts `shadeRuns`,
/// with its tree-walking sampler: the integration variable is bound per
/// sample, shadowing any constant or `t` of the same name).
public func shadeRuns(
  _ shade: IntShade, _ env: [String: Double], _ xmin: Double, _ xmax: Double, maps: AxisMaps = AxisMaps()
) -> [ShadeRun] {
  var scope = env
  func f(_ x: Double) throws -> Double {
    scope[shade.v] = x
    return try evaluate(shade.body, &scope)
  }
  let (lo, hi) = (boundValue(shade.lo, env), boundValue(shade.hi, env))
  guard maps.x != nil || maps.y != nil else { return integralRuns(f, lo, hi, xmin, xmax) }
  // On mapped axes (AxisMap.swift) the area is sampled along the screen,
  // evenly on a log axis, and its signs read from y before y is mapped; a
  // value the y axis cannot show (≤ 0 on a log axis) lies past its edge.
  var runs: [ShadeRun]
  if let mx = maps.x {
    runs = integralRuns({ try f(toWorld(mx, $0)) }, toScreenOrEdge(mx, lo), toScreenOrEdge(mx, hi), xmin, xmax)
  } else {
    runs = integralRuns(f, lo, hi, xmin, xmax)
  }
  if let my = maps.y {
    for k in runs.indices {
      for i in stride(from: 1, to: runs[k].pts.count, by: 2) { runs[k].pts[i] = toScreenOrEdge(my, runs[k].pts[i]) }
    }
  }
  return runs
}
