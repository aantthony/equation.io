/// What a row over continuous intervals is (lib/plot.ts `classifyLowered`,
/// "Continuous intervals"; Interval.swift). Beside x and y an interval makes
/// the row a family over it, drawn as the region the family sweeps; anywhere
/// else it is one more sampling parameter, swept over [0, 1] like u and v —
/// and three of them in a point in space fill a solid, drawn as its faces.
/// `classify` (Classify.swift) calls in here where the TypeScript's one
/// function goes on.

private let paramVarNames = ["u", "v"]

/// A solid's map, over its params in [0, 1], for its fold check in analysis
/// (lib/plot.ts `SolidMap`). The TypeScript keeps it beside the object, in a
/// WeakMap; here the classified row carries it (`Classified.solid`).
public struct SolidMap: Equatable, Sendable {
  public var items: [Expr]
  public var params: [String]
}

/// What a family over an interval asks of a point: that some member passes
/// through it, or that some member's inequalities all hold there.
public enum ProjectedRelation: String, Equatable, Sendable {
  case eq, ineq
}

/// The intervals of a row, once its names are known: the region a family in
/// x and y sweeps or a solid's faces (returned), or else each interval swept
/// by a free parameter, written into `expr` and `vars`, for classify to go on
/// with (nil).
func classifyIntervals(
  _ expr: inout Expr, _ vars: inout NameSet, hidden: [HiddenInterval], special: String?, tube: Bool,
  params: [String], defined: Set<String>, fields: [String: Expr]
) throws -> Classified? {
  if hidden.isEmpty { return nil }
  if let special { throw LanguageError("Cannot use an interval in \(special)(…).") }
  // A parametric system, `(x, y) = (cos(s), sin(s))`, sweeps its one
  // interval as it does u.
  var system = false
  if case .eq(.vec, _) = expr { system = hidden.count == 1 && !vars.contains("u") && !vars.contains("v") }
  if !system && (vars.contains("x") || vars.contains("y") || vars.contains("z")) {
    let object = try projectedRegion(expr, hidden, vars)
    return Classified(object: object, animated: vars.contains("t"), needs3D: false, params: params)
  }
  if case .list = expr { throw LanguageError("An interval cannot be an item of a list — write it in a tuple.") }
  let free = paramVarNames.filter { !vars.contains($0) }
  let swept = hidden.count + 2 - free.count
  if swept == 3, case .vec(let items) = expr, items.count == 3 {
    if tube { throw LanguageError("tube(…) takes a curve; this is a solid over three parameters.") }
    // The faces are this row's own surfaces, not a family the user wrote:
    // their errors are the row's.
    do {
      let faces = try solidFaces(items, hidden, vars, defined)
      var cls = try classify(faces.family, defined: defined, fields: fields)
      cls.solid = faces.map
      return cls
    } catch let error as Unsupported {
      throw error
    } catch {
      throw LanguageError(withoutFamilyElement(errorMessage(error)))
    }
  }
  if hidden.count > free.count {
    throw LanguageError(
      "A row can sweep at most two parameters (intervals, u and v), or three in a point in space — "
        + "this one has \(swept).")
  }
  var slot: [String: String] = [:]
  for (k, h) in hidden.enumerated() { slot[h.key] = free[k] }
  expr = replaceIntervals(expr) { sweep($0, slot[$0.key]!) }
  for k in hidden.indices { vars.insert(free[k]) }
  return nil
}

/// `message` without a leading "Family element 3: " (/^Family element \d+: /).
private func withoutFamilyElement(_ message: String) -> String {
  let head = Array("Family element ".utf16)
  let u = Array(message.utf16)
  guard u.starts(with: head) else { return message }
  var at = head.count
  while at < u.count, u[at] >= unit("0"), u[at] <= unit("9") { at += 1 }
  guard at > head.count, at + 1 < u.count, u[at] == unit(":"), u[at + 1] == unit(" ") else { return message }
  return String(decoding: u[(at + 2)...], as: UTF16.self)
}

/// A row in x and y over one interval: the family of its members, drawn as
/// the region they sweep — `a = interval(1, 2)`; `y = sin(a x)` is every
/// (x, y) that some a ∈ [1, 2] puts on its curve (`projectedRegion`). The
/// interval becomes u over [0, 1], so each residual is F(x, y, u), and a
/// pixel is kept when some u satisfies the relation there: a search along u
/// per pixel (the renderer's projFrag), not a draw per member.
private func projectedRegion(_ expr: Expr, _ hidden: [HiddenInterval], _ vars: NameSet) throws -> MathObject {
  if hidden.count > 1 {
    throw LanguageError(
      "A row in x and y can range over one interval (this one has \(hidden.count)) — fix the others to a value.")
  }
  if vars.contains("z") { throw LanguageError("A family over an interval is drawn in the plane; it cannot use z.") }
  if vars.contains("u") || vars.contains("v") { throw LanguageError("Cannot mix u/v with x/y/z.") }
  if usesComplex(expr) { throw LanguageError("A family over an interval must be real.") }
  let swept = replaceIntervals(expr) { sweep($0, "u") }
  if case .eq(let l, let r) = swept {
    var plain = true
    if case .vec = l { plain = false }
    if case .vec = r { plain = false }
    if plain {
      return .regionProjected(
        relation: .eq, constraints: [Constraint(residual: .bin(.sub, l, r), strict: false)])
    }
  }
  if case .ineq = swept {
    let comparisons = ineqComparisons(swept)
    if Set(comparisons.map { $0.op == .lt || $0.op == .le }).count > 1 {
      throw LanguageError("Chained inequalities must point the same way.")
    }
    return .regionProjected(
      relation: .ineq,
      constraints: comparisons.map { c in
        let less = c.op == .lt || c.op == .le
        return Constraint(
          residual: .bin(.sub, less ? c.l : c.r, less ? c.r : c.l), strict: c.op == .lt || c.op == .gt)
      })
  }
  throw LanguageError(
    "A field in x and y cannot range over an interval — set it equal to something for the region its family "
      + "sweeps, like y = sin(a x).")
}

/// A point in space over three parameters (intervals, u and v) is a solid:
/// `(interval(0, 1), interval(0, 1), interval(0, 1))` is the unit cube
/// (`solidFaces`). It is drawn as the six faces of its parameter box, each a
/// parametric surface in u and v. Where the map is a local diffeomorphism
/// inside the box, the interior lands inside the solid (inverse function
/// theorem), so the solid's surface lies within the faces; and the faces
/// being part of the solid, drawn opaque they show exactly what is seen from
/// outside. A face may fall inside (the seam φ = 0 of a ball in spherical
/// coordinates) or collapse to a curve or point (its r = 0 face); opaque,
/// neither shows. A map that folds inside the box takes part of its surface
/// from the fold, which no face draws, so a Jacobian that changes sign there
/// is an error. So is a map undefined in part of the box (`{…}` with no
/// default, or sqrt of a negative): its edge there bounds the solid too, and
/// no face draws that either.
private func solidFaces(
  _ coordinates: [Expr], _ hidden: [HiddenInterval], _ vars: NameSet, _ defined: Set<String>
) throws -> (family: Expr, map: SolidMap) {
  // Every parameter as a name over [0, 1]: u and v as they are, each
  // interval as a fresh one.
  var names = paramVarNames.filter(vars.contains)
  var slot: [String: String] = [:]
  for h in hidden {
    var name = "eqioSolid\(names.count)"
    while vars.contains(name) || defined.contains(name) { name += "X" }
    slot[h.key] = name
    names.append(name)
  }
  let items = coordinates.map { c in replaceIntervals(c) { sweep($0, slot[$0.key]!) } }
  let map = SolidMap(items: items, params: names)
  try checkFolds(map, nil)
  var members: [Expr] = []
  for fixed in names {
    let others = names.filter { $0 != fixed }
    for end in [0.0, 1.0] {
      let env: [String: Expr] = [fixed: .num(end), others[0]: .var("u"), others[1]: .var("v")]
      members.append(.vec(items.map { substVars($0, env) }))
    }
  }
  return (.family(members: members), map)
}

/// The fold and gap check, split by what the Jacobian reads besides the
/// params (`checkFolds`). Only those names can fold the map or move its gaps:
/// a translation (`… + k`) can do neither, and is read as 0. One undefined
/// there (`log(k)`) is ∞, which leaves the gaps NaN, so they still show; one
/// NaN there (`sqrt(k - 1)`) leaves the whole map NaN, and unchecked. A
/// Jacobian of numbers alone is checked in classification (`consts` nil). One
/// reading sliders needs their values, which only analysis has. A name with
/// no value (t, an animated constant, a state) leaves the map unchecked.
func checkFolds(_ map: SolidMap, _ consts: ((String) -> Double?)?) throws {
  func valued(_ n: String) -> Bool { consts?(n) != nil }
  // pi and e compile as themselves unless the document redefines them.
  var free = NameSet()
  for c in map.items {
    for n in freeVars(c) where !map.params.contains(n) && (valued(n) || constants[n] == nil) { free.insert(n) }
  }
  var shaping = NameSet()
  do {
    for c in map.items {
      for p in map.params {
        for n in freeVars(try diff(c, p)) where free.contains(n) { shaping.insert(n) }
      }
    }
  } catch {
    shaping = free
  }
  if consts == nil ? !shaping.isEmpty : shaping.isEmpty || !shaping.allSatisfy(valued) { return }
  let extra = free.list
  let values = extra.map { shaping.contains($0) ? consts!($0)! : 0 }
  if let defect = solidDefect(map.items, map.params, extra, values) { throw LanguageError(defect) }
}

private let solidFolds = "This solid folds over itself inside its parameter box, so its faces do not bound it."
private let solidPartial =
  "This solid is undefined in part of its parameter box, so its faces do not bound it — give its {…} a default, "
  + "or split it into solids over the parts where it is defined."

/// Why the faces of `items` over `names` (each in [0, 1]) do not bound it, or
/// nil (`solidDefect`): the map is undefined (NaN; ∞ is a value too large to
/// draw, not a gap) at some samples but not others, or its Jacobian changes
/// sign inside the box, sampled on a grid that reaches to just inside the
/// faces, by central differences. The sign is read from det J / (|J₁| |J₂|
/// |J₃|), the volume of the unit-scaled columns, so it does not depend on the
/// map's size and differencing noise on a flat solid stays far below the
/// threshold. Zeros on the faces (r = 0 or θ = 0 of a ball) are no fold. A
/// fold or gap narrower than the grid can be missed. Other names in the map
/// (`extra`) take `values`; a map that still does not evaluate is not checked.
///
/// Port: the TypeScript compiles each component (lib/vm.ts) and a map that
/// does not compile is unchecked; here the tree-walking evaluator runs it,
/// and one it cannot run is unchecked the same way.
private func solidDefect(_ items: [Expr], _ names: [String], _ extra: [String], _ values: [Double]) -> String? {
  let n = 7
  let inset = 1e-3
  let h = 1e-4
  var env: [String: Double] = [:]
  // (A name the box does not set and the document does not define: pi, e.)
  for c in items {
    for name in freeVars(c) { if let value = constants[name] { env[name] = value } }
  }
  for (name, value) in zip(extra, values) { env[name] = value }
  for name in names { env[name] = 0 }
  func run() throws -> [Double] { try items.map { try evaluate($0, &env) } }
  guard (try? run()) != nil else { return nil }
  func col(_ name: String) -> [Double] {
    let x = env[name]!
    env[name] = x + h
    let f = (try? run()) ?? items.map { _ in .nan }
    env[name] = x - h
    let g = (try? run()) ?? items.map { _ in .nan }
    env[name] = x
    return zip(f, g).map { ($0 - $1) / (2 * h) }
  }
  func hypot3(_ a: [Double]) -> Double { (a[0] * a[0] + a[1] * a[1] + a[2] * a[2]).squareRoot() }
  var negative = false
  var positive = false
  var defined = false
  var gap = false
  for i in 0..<n {
    for j in 0..<n {
      for k in 0..<n {
        for (m, s) in [i, j, k].enumerated() {
          env[names[m]] = inset + ((1 - 2 * inset) * Double(s)) / Double(n - 1)
        }
        guard let at = try? run() else { return nil }
        if at.contains(where: \.isNaN) {
          gap = true
          continue
        }
        defined = true
        let (a, b, c) = (col(names[0]), col(names[1]), col(names[2]))
        let det =
          a[0] * (b[1] * c[2] - b[2] * c[1]) - a[1] * (b[0] * c[2] - b[2] * c[0])
          + a[2] * (b[0] * c[1] - b[1] * c[0])
        let volume = det / (hypot3(a) * hypot3(b) * hypot3(c))
        if volume < -1e-6 { negative = true }
        if volume > 1e-6 { positive = true }
        if negative && positive { return solidFolds }
      }
    }
  }
  return defined && gap ? solidPartial : nil
}
