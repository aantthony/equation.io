/// States: `a' = …` defines da/dt, integrated forward as the graph animates,
/// starting from `a(0) = …` (lib/defs.ts, lib/state.ts).
///
/// Every other value in a graph is a formula the renderer can evaluate at any
/// t, which is why scrubbing time is free. A state is the exception: it is
/// carried from frame to frame, so systems with no closed form — a driven
/// oscillator, a double pendulum — can be graphed at all. Downstream a state
/// is just another entry in the constant environment (a uniform in GLSL), so
/// nothing else has to know it is integrated.
///
/// Where the values live. The analysis is a pure function of the rows, so it
/// holds the system (`DocumentAnalysis.stateSystem`) and where it starts
/// (`initialState`), and its `env` is the environment at t = 0 with every
/// state at its start. The run itself — the states' values now, and the time
/// they have been stepped to — is a `StateStepper`, a small value owned by
/// whoever draws frames: it is made from an analysis, advanced to each
/// frame's time (`advance(to:)`), and its `environment(at:)` is what that
/// frame's uniforms and overlay read. An edit that leaves the system as it
/// was written keeps the run (`adopt`); ↻ makes a new stepper.
///
/// Stepping is RK4 at a fixed step, decoupled from the frame rate: a chaotic
/// system integrated at whatever dt the display happened to deliver is not
/// reproducible even on the same machine.
///
/// The run also holds what was observed of it: each `trail(…)` row's past
/// positions (Trail.swift).
///
/// Not ported: a family of runs (`th(0) = [1..12]/4`: lists).

/// A scalar state: da/dt and where it starts, both resolved (`StateDef`).
struct StateDef: Equatable {
  /// Free variables in {t, constants, states}.
  var deriv: Expr
  var initial: Expr
}

/// The derived scalar states an n-vector state expands to: om_1, om_2(, om_3)
/// (lib/geom.ts `vecStateComps`).
func vecStateComps(_ name: String, _ dim: Int) -> [String] {
  (0..<dim).map { "\(name)_\($0 + 1)" }
}

/// The states of a document while its definitions build (lib/defs.ts
/// `buildDefs`'s `derivs`, `inits`, `stateNames` and `vecOwnerKey`).
struct StateDraft {
  var derivs = OrderedMap<Expr>()
  var inits = OrderedMap<Expr>()
  /// The names that stand for themselves in a definition: every state row's
  /// name, then (once vector states have split) the scalar states.
  var names: Set<String> = []
  /// A vector state's scalar component → the row that defines it.
  var vecOwnerKey = OrderedMap<String>()

  /// The row a scalar state's errors land on.
  func row(_ name: String) -> String { vecOwnerKey[name] ?? name }
}

/// Vector states: a state whose derivative (or starting value) lowers to a
/// 2- or 3-vector integrates componentwise. The base name splits into the
/// scalar states om_1, om_2(, om_3) — the integrator and everything below
/// it see only those — and the name itself expands to its components
/// wherever expressions lower, exactly as a point name does, so `th' = om`
/// and `segment((0, 0), om)` both work.
func lowerVectorStates(
  _ defs: inout BuiltDefs, _ draft: inout StateDraft, defined: (String) -> Bool,
  comps: @escaping (String) -> [String]?, mats: @escaping GetMat
) {
  // The component names are read with the dimensions as they are found.
  // (`om' = solve(M, f)` is a vector by what the matrix algebra returns.)
  func lowered(_ e: Expr, _ dims: [String: Int]) throws -> Expr {
    try lowerGeom(e, comps: { name in dims[name].map { vecStateComps(name, $0) } ?? comps(name) }, mats: mats)
  }
  // Dims propagate (`th' = om` is scalar until om's own row makes om a
  // vector), so discovery iterates to a fixed point. Lowering failures
  // wait for the final pass below, where they are reported per row.
  var changed = true
  while changed {
    changed = false
    for (name, e) in draft.derivs.entries + draft.inits.entries where defs.vecStates[name] == nil {
      if case .vec(let items)? = try? lowered(e, defs.vecStates) {
        defs.vecStates[name] = items.count
        changed = true
      }
    }
  }

  // Final pass: lower every derivative and starting value against the full
  // component map, split vector ones, and swap the scalar results in.
  var flatDerivs = OrderedMap<Expr>()
  var flatInits = OrderedMap<Expr>()
  func fail(_ key: String, _ error: any Error) {
    if let error = error as? Unsupported {
      defs.unsupported[key] = error.what
    } else {
      defs.errors[key] = errorMessage(error)
    }
  }
  for (name, e) in draft.derivs.entries {
    do {
      let low = try lowered(e, defs.vecStates)
      guard let dim = defs.vecStates[name] else {
        flatDerivs[name] = low
        continue
      }
      guard case .vec(let items) = low, items.count == dim else {
        var got = "a single number"
        if case .vec(let items) = low { got = "\(items.count) components" }
        throw LanguageError("\(name) is a \(dim)-component state, but \(name)' has \(got).")
      }
      // (The site's environment holds vectors of 2 or 3 components.)
      if dim != 2 && dim != 3 { throw Unsupported("a state of more than 3 components") }
      let names = vecStateComps(name, dim)
      for c in names where defined(c) {
        throw LanguageError("Cannot make \(name) a vector state: \(c) is already defined.")
      }
      for (c, item) in zip(names, items) {
        flatDerivs[c] = item
        draft.vecOwnerKey[c] = name
      }
    } catch {
      defs.vecStates[name] = nil
      fail(name, error)
    }
  }
  for (name, e) in draft.inits.entries {
    do {
      let low = try lowered(e, defs.vecStates)
      guard let dim = defs.vecStates[name] else {
        if case .vec(let items) = low {
          throw LanguageError("\(name)(0) has \(items.count) components, but \(name) is a single number.")
        }
        flatInits[name] = low
        continue
      }
      guard case .vec(let items) = low, items.count == dim else {
        var got = "is a single number"
        if case .vec(let items) = low { got = "has \(items.count) components" }
        throw LanguageError("\(name) is a \(dim)-component state, but \(name)(0) \(got).")
      }
      for (c, item) in zip(vecStateComps(name, dim), items) {
        flatInits[c] = item
        draft.vecOwnerKey[c] = name
      }
    } catch {
      fail("\(name)(0)", error)
    }
  }
  draft.derivs = flatDerivs
  draft.inits = flatInits
  // Downstream validation runs over the scalar components.
  draft.names = Set(flatDerivs.keys)
}

/// States. A derivative sees time, constants, and the other states; an
/// initial value is read once at reset, so it must be constant. Vector
/// states validate per scalar component; their errors land on the base row.
func validateStates(_ defs: inout BuiltDefs, _ draft: StateDraft, constNames: Set<String>) {
  for (name, deriv) in draft.derivs.entries {
    do {
      if defs.fields.has(name) {
        throw LanguageError("\(name) is a coordinate field — use a tuple flow like (\(name)', y') = (F, G).")
      }
      if defs.consts.has(name) { throw LanguageError("\(name) is already defined as a constant.") }
      var env: [String: Double] = ["t": 0]
      for fv in freeVars(deriv) {
        if fv != "t" && !constNames.contains(fv) && !draft.names.contains(fv) {
          throw LanguageError(
            "\(draft.row(name))' changes with time, so it may only use t, constants, and other states (found \(fv)).")
        }
        env[fv] = 0
      }
      _ = try evaluate(deriv, env)  // surfaces unsupported calls now
      var initial = draft.inits[name] ?? .num(0)
      for fv in freeVars(initial) where !constNames.contains(fv) {
        defs.errors["\(draft.row(name))(0)"] =
          "\(draft.row(name))(0) is a starting value, so it must be constant (found \(fv))."
        initial = .num(0)
        break
      }
      defs.states[name] = StateDef(deriv: deriv, initial: initial)
    } catch {
      defs.errors[draft.row(name)] = errorMessage(error)
    }
  }
  for name in draft.inits.keys {
    let row = draft.row(name)
    // (A state the port could not read is not one that is missing.)
    if defs.unsupported[row] != nil { continue }
    if !defs.states.has(name) && !defs.errors.has(row) && !defs.errors.has("\(row)(0)") {
      defs.errors["\(row)(0)"] = "\(row)(0) is a starting value, but \(row)' is not defined."
    }
  }
  // A vector state that lost every component to errors is not a state at all.
  for (name, dim) in defs.vecStates where !vecStateComps(name, dim).allSatisfy(defs.states.has) {
    defs.vecStates[name] = nil
  }
}

// MARK: - The system and its integration (lib/state.ts)

/// The system to integrate (`StateSystem`): each scalar state, its
/// derivative, and where it starts.
public struct StateSystem: Equatable, Sendable {
  public var names: [String]
  public var derivs: [Expr]
  /// The `a(0)` expressions, read against the constants.
  public var initials: [Expr]
  /// Identity of the system as written. Reanalyzing on every keystroke
  /// rebuilds this; an unchanged key means the run in progress survives the
  /// edit.
  public var key: String

  /// Fixed integration step, in seconds of graph time (`STEP`).
  public static let step = 1.0 / 240
  /// Most steps per frame: past this the simulation runs slow rather than
  /// freezing the app (a backgrounded app can hand back a gap of minutes).
  public static let maxSteps = 60
}

/// The system to integrate, or nil when the graph defines no states (`buildStateSystem`).
func buildStateSystem(_ defs: BuiltDefs) -> StateSystem? {
  let states = defs.states.entries
  if states.isEmpty { return nil }
  return StateSystem(
    names: states.map(\.key), derivs: states.map(\.value.deriv), initials: states.map(\.value.initial),
    key: states.map { "\($0.key)'=\(exprKey($0.value.deriv));\($0.key)(0)=\(exprKey($0.value.initial))" }
      .joined(separator: "\n"))
}

/// Starting values, read from the `a(0)` expressions against the constants (`initialState`).
func initialState(_ defs: BuiltDefs, _ sys: StateSystem) -> [String: Double] {
  var zeros: [String: Double] = [:]
  for name in sys.names { zeros[name] = 0 }
  // Constants that read a state cannot be resolved before there is one;
  // initial values may not use states, so those failures don't matter here.
  // (An init using a broken constant lands on 0.)
  let env = (try? evaluateFrame(defs, time: 0, states: zeros)) ?? [:]
  var out: [String: Double] = [:]
  for (name, initial) in zip(sys.names, sys.initials) {
    let v = (try? evaluate(initial, env)) ?? 0
    out[name] = v.isFinite ? v : 0
  }
  return out
}

/// Constants whose value moves under the integrator, so the derivative sees a
/// fresh environment at every RK4 stage rather than one per frame.
private func dynamicConsts(_ defs: BuiltDefs) -> Bool {
  defs.consts.entries.contains { entry in freeVars(entry.value).contains { $0 == "t" || defs.states.has($0) } }
}

/// Integrate `values` from `from` towards `to` (both in seconds of graph
/// time), in place. Returns the time actually reached: only whole steps are
/// taken, so the leftover carries to the next frame and the trajectory is the
/// same sequence of steps at any frame rate — which is the only way two runs
/// of a chaotic system agree.
///
/// Beyond `maxSteps` the excess is dropped rather than queued. A step that
/// produces a non-finite value is rolled back and integration stops: a
/// blown-up system holds its last good frame instead of vanishing
/// (`advanceState`). `maxSteps` nil takes every step (an orbit, ahead of time).
func advanceState(
  _ defs: BuiltDefs, _ sys: StateSystem, _ values: inout [String: Double], from: Double, to: Double,
  maxSteps: Int? = StateSystem.maxSteps
) -> Double {
  let n = sys.names.count
  let h = StateSystem.step
  // The epsilon keeps a frame that is a whole number of steps long from
  // losing one to float dust and running a step behind ever after.
  let whole = ((to - from) / h + 1e-9).rounded(.down)
  guard whole > 0, whole.isFinite else { return from }
  var steps = whole < Double(Int.max / 2) ? Int(whole) : Int.max / 2
  var reached = from + Double(steps) * h
  if let maxSteps, steps > maxSteps {
    steps = maxSteps
    reached = to
  }
  let perStage = dynamicConsts(defs)

  // Constants that hold still for the whole call are evaluated once; the rest
  // (and anything reading a state) are re-evaluated per stage below.
  var base: [String: Double] = [:]
  if !perStage {
    // A half-typed definition: hold the state where it is and stay glued to
    // the clock, so finishing the edit resumes rather than fast-forwards.
    guard let env = try? evaluateFrame(defs, time: to, states: values) else { return to }
    base = env
  }

  var y = sys.names.map { values[$0] ?? 0 }
  var tmp = [Double](repeating: 0, count: n)
  var k1 = tmp
  var k2 = tmp
  var k3 = tmp
  var k4 = tmp

  /// dy/dt at `time` for the state vector `at`, into `out`. False if it is
  /// not a finite number anywhere (a pole, a broken definition).
  func deriv(_ time: Double, _ at: [Double], _ out: inout [Double]) -> Bool {
    var env: [String: Double]
    if perStage {
      var seed: [String: Double] = [:]
      for i in 0..<n { seed[sys.names[i]] = at[i] }
      guard let frame = try? evaluateFrame(defs, time: time, states: seed) else { return false }
      env = frame
    } else {
      env = base
      for i in 0..<n { env[sys.names[i]] = at[i] }
    }
    env["t"] = time
    for i in 0..<n {
      guard let v = try? evaluate(sys.derivs[i], env), v.isFinite else { return false }
      out[i] = v
    }
    return true
  }

  /// An RK4 midpoint/endpoint stage: sample the derivative at y + scale·k.
  func stage(_ time: Double, _ scale: Double, _ k: [Double], _ out: inout [Double]) -> Bool {
    for i in 0..<n { tmp[i] = y[i] + scale * k[i] }
    return deriv(time, tmp, &out)
  }

  var now = from
  for _ in 0..<steps {
    if !deriv(now, y, &k1) { break }
    if !stage(now + h / 2, h / 2, k1, &k2) { break }
    if !stage(now + h / 2, h / 2, k2, &k3) { break }
    if !stage(now + h, h, k3, &k4) { break }
    var ok = true
    for i in 0..<n {
      tmp[i] = y[i] + (h / 6) * (k1[i] + 2 * k2[i] + 2 * k3[i] + k4[i])
      if !tmp[i].isFinite { ok = false }
    }
    if !ok { break }
    y = tmp
    now += h
  }

  for i in 0..<n { values[sys.names[i]] = y[i] }
  return reached
}

/// A run of a document's state system: the states' values, and the time
/// they have been stepped to. Owned by whoever draws frames (see the note at
/// the top of this file); a document with no states has a stepper too, which
/// only evaluates the constants.
public struct StateStepper: Equatable, Sendable {
  /// The document the run is of.
  public private(set) var analysis: DocumentAnalysis
  /// Each scalar state's value now.
  public private(set) var values: [String: Double]
  /// The graph time the states have reached, in seconds.
  public private(set) var time: Double
  /// Where each `trail(…)` row's point has been, by row (Trail.swift):
  /// sampled as the run is advanced, a frame at a time.
  public internal(set) var trails: [Int: PointTrail] = [:]

  /// A fresh run: every state at its `a(0)`, the clock at `time`.
  public init(_ analysis: DocumentAnalysis, time: Double = 0) {
    self.analysis = analysis
    self.time = time
    values = analysis.initialState
  }

  /// Step the states forward to `time`. Time that runs backwards (a scrub,
  /// a reset clock) restarts the run from there, as ↻ does; within a step
  /// behind is only the whole steps' float dust, and nothing to do.
  public mutating func advance(to time: Double) {
    defer { sampleTrails(at: time) }
    guard let sys = analysis.stateSystem else {
      self.time = time
      return
    }
    if time < self.time - StateSystem.step {
      values = analysis.initialState
      self.time = time
      return
    }
    self.time = advanceState(analysis.defs, sys, &values, from: self.time, to: time)
  }

  /// Take up an edited document. A system written as it was keeps its run;
  /// any other starts again from its `a(0)`s.
  public mutating func adopt(_ next: DocumentAnalysis) {
    let same = next.stateSystem?.key == analysis.stateSystem?.key
    // A trail is of the math as it was written: any other document's starts again
    // (framing rows aside, which a pan rewrites).
    func math(_ a: DocumentAnalysis) -> [String] { a.rows.filter { $0.view == nil && !$0.comment }.map(\.text) }
    if !same || math(next) != math(analysis) { trails = [:] }
    analysis = next
    if !same { values = next.initialState }
  }

  /// Every constant's value on a frame at `time`, the states among them at
  /// the values they have been stepped to: what the uniforms read.
  public func environment(at time: Double) -> [String: Double] {
    analysis.environment(at: time, states: values)
  }
}
