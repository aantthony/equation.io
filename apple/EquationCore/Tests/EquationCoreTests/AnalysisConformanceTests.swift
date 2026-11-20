import Foundation
import Testing

@testable import EquationCore

/// Holds the Swift language trunk to the TypeScript one: for every example
/// in the site's menu and a set of targeted documents, each row the port
/// supports must come to what lib/analysis.ts says of it — its kind, error,
/// readout, slider, color, and its CPU and GPU plans. A row the port does not
/// support must say so; it is counted, never compared. Regenerate with
///
///   node --experimental-transform-types --no-warnings apple/corpus/analysis.ts
@Suite struct AnalysisConformance {
  @Test func documents() throws {
    let docs = try #require(try fixture("analysis") as? [[String: Any]])
    var failures: [String] = []
    var rowsTotal = 0
    var rowsSupported = 0
    var exampleRows = 0
    var exampleRowsSupported = 0
    var examples = 0
    var examplesWhole = 0
    var reasons: [String: Int] = [:]
    for doc in docs {
      let name = doc["name"] as! String
      let rows = doc["rows"] as! [String]
      let results = doc["results"] as! [[String: Any]]
      let isExample = !name.hasPrefix("case ")
      let analysis = analyze(rows)
      #expect(analysis.rows.count == rows.count)
      var whole = true
      for (i, want) in results.enumerated() {
        let got = analysis.rows[i]
        rowsTotal += 1
        if isExample { exampleRows += 1 }
        if let why = got.unsupported {
          whole = false
          // ANALYSIS_UNSUPPORTED=<name prefix> lists the rows left alone in those documents.
          if let prefix = ProcessInfo.processInfo.environment["ANALYSIS_UNSUPPORTED"], name.hasPrefix(prefix) {
            print("  \(name), row \(i + 1) \(rows[i].debugDescription): \(why)")
          }
          reasons[why, default: 0] += 1
          continue
        }
        rowsSupported += 1
        if isExample { exampleRowsSupported += 1 }
        for difference in compare(got, want, analysis, index: i, source: rows[i]) {
          failures.append("\(name), row \(i + 1) \(rows[i].debugDescription): \(difference)")
        }
      }
      // The environment the uniforms read.
      if whole {
        let env = doc["env"] as! [String: Any]
        for (key, value) in env {
          let v = number(value)
          if let mine = analysis.env[key], close(mine, v) { continue }
          failures.append("\(name): env \(key) is \(String(describing: analysis.env[key])), want \(v)")
        }
        if env.count != analysis.env.count {
          failures.append("\(name): env has \(analysis.env.count) names, want \(env.count)")
        }
      }
      if isExample {
        examples += 1
        if whole { examplesWhole += 1 }
      }
    }
    print(
      """
      Analysis conformance: \(rowsSupported) of \(rowsTotal) rows supported and compared \
      (\(rowsTotal - rowsSupported) not supported yet).
        Examples: \(exampleRowsSupported) of \(exampleRows) rows; \(examplesWhole) of \(examples) documents whole.
        Not supported, by reason:
      """)
    for (why, n) in reasons.sorted(by: { $0.value > $1.value }).prefix(30) { print("    \(n)  \(why)") }
    let shown = failures.prefix(40).joined(separator: "\n")
    #expect(failures.isEmpty, "\(failures.count) differences:\n\(shown)")
  }

  /// A row the site draws simply must not slip out of the port's reach.
  @Test func coreRowsAreSupported() {
    let rows = [
      "a = 2", "y = a sin(x)", "f(x) = x^2", "y < f(x)", "sin(x) y", "A = (1, 2)", "A", "(y, -x)", "1 + a",
      "# heading", "y = x # note", "view(x = -5..5)", "---", "r = sqrt(x^2 + y^2)", "r = 2", "y = d/dx x^3",
    ]
    let analysis = analyze(rows)
    for (row, text) in zip(analysis.rows, rows) {
      #expect(row.unsupported == nil, "\(text)")
      #expect(row.error == nil, "\(text)")
    }
    #expect(analysis.env == ["a": 2, "A_x": 1, "A_y": 2])
    #expect(analysis.rows[1].gpu?.params == ["a"])
    #expect(analysis.rows[0].slider == Slider(min: -10, max: 10, step: 0.05, value: 2))
    #expect(analysis.rows[10].noteStart == 6)
    #expect(analysis.rows[12].divider)
  }

  @Test func whatIsNotPortedSaysSo() {
    let rows = ["L = [1, 2, 3]", "(x, y) = (1, 2)", "s_{n+1} = push(s_n, n)", "int[0..1] x dx", "(u, v)"]
    for text in rows {
      let row = analyze([text]).rows[0]
      #expect(row.unsupported != nil, "\(text)")
      #expect(row.cpu == nil && row.gpu == nil && row.error == nil, "\(text)")
    }
    // A name the port cannot read takes the rows that use it with it.
    let analysis = analyze(["L = [1, 2, 3]", "b = L[1]", "y = b x", "y = x"])
    #expect(analysis.rows.map { $0.unsupported != nil } == [true, true, true, false])
  }

  @Test func slidersWriteBack() {
    let rows = ["a = clamp(0.4, 0, 1) # speed", "n = round(5)", "b = 3"]
    let analysis = analyze(rows)
    #expect(analysis.settingSlider(row: 0, to: 2, in: rows[0]) == "a = clamp(1, 0, 1) # speed")
    #expect(analysis.settingSlider(row: 0, to: 0.123456789, in: rows[0]) == "a = clamp(0.123457, 0, 1) # speed")
    #expect(analysis.settingSlider(row: 1, to: 6.6, in: rows[1]) == "n = round(7)")
    #expect(analysis.settingSlider(row: 2, to: -1.5, in: rows[2]) == "b = -1.5")
    #expect(analyze(["y = x"]).settingSlider(row: 0, to: 1, in: "y = x") == nil)
  }

  @Test func constantsMoveWithTime() {
    let analysis = analyze(["a = 2 t", "b = a + 1", "c = 3", "y = b x"])
    #expect(analysis.animated == ["a", "b"])
    #expect(analysis.env == ["a": 0, "b": 1, "c": 3])
    #expect(analysis.environment(at: 1.5) == ["a": 3, "b": 4, "c": 3])
    #expect(analysis.rows[3].classified?.animated == false)
    #expect(analysis.rows[3].gpu?.params == ["b"])
  }

  // MARK: Comparing a row

  private func compare(
    _ got: RowAnalysis, _ want: [String: Any], _ analysis: DocumentAnalysis, index: Int, source: String
  ) -> [String] {
    var out: [String] = []
    func check<T: Equatable>(_ what: String, _ mine: T, _ theirs: T) {
      guard mine != theirs else { return }
      // A plan prints long: show where the two part.
      let (a, b) = (Array("\(mine)"), Array("\(theirs)"))
      let at = zip(a, b).prefix { $0 == $1 }.count
      let from = max(0, at - 60)
      func around(_ s: [Character]) -> String { String(s[from..<min(s.count, at + 120)]) }
      let whole = "\(what): got \(mine), want \(theirs)"
      out.append(a.count < 300 ? whole : "\(what): got …\(around(a))…, want …\(around(b))…")
    }
    check("text", got.text, want["text"] as! String)
    check("noteStart", got.noteStart ?? -1, (want["noteStart"] as! NSNumber).intValue)
    check("comment", got.comment, want["comment"] as! Bool)
    check("error", got.error, want["error"] as? String)
    let def = want["def"] as? [String: Any]
    check("definition", got.definition?.kind, def?["kind"] as? String)
    check("definition name", got.definition?.name, def?["name"] as? String)
    if got.error != nil { return out }
    check("info", got.info, want["info"] as? String)
    check("kind", got.kind, want["kind"] as? String)
    check("takesColor", got.takesColor, want["takesColor"] as! Bool)
    check("dist", got.dist?.rawValue, want["dist"] as? String)
    if want["dataLocal"] as? String != nil { out.append("the site reads this row as a data row") }
    // The slider, and where a drag to a third of the way along lands.
    if let slider = want["slider"] as? [String: Any] {
      let wanted = Slider(
        min: number(slider["min"]!), max: number(slider["max"]!), step: number(slider["step"]!),
        value: number(slider["value"]!))
      check("slider", got.slider, wanted)
      let target = wanted.min + (wanted.max - wanted.min) / 3
      check("moved", analysis.settingSlider(row: index, to: target, in: source), want["moved"] as? String)
    } else {
      check("slider", got.slider, nil)
    }
    // The view.
    let view = want["view"] as? [String: Any]
    check("view", got.view?.kind, view?["kind"] as? String)
    if let view, let mine = got.view {
      func pair(_ key: String) -> [Double]? { (view[key] as? [Any])?.map(number) }
      let wanted: ViewSpec? =
        switch view["kind"] as! String {
        case "view":
          .view(
            x: pair("x"), y: pair("y"), ratio: view["ratio"].map(number), locked: view["locked"] as? Bool ?? false)
        case "camera":
          .camera(
            theta: number(view["theta"]!), phi: number(view["phi"]!), radius: view["radius"].map(number),
            target: pair("target"), spin: view["spin"].map(number), locked: view["locked"] as? Bool ?? false)
        case "split":
          .split(
            place: view["place"] as? String, corner: view["corner"] as? String, size: view["size"].map(number),
            sharedX: (view["shared"] as? [String: Any])?["x"] as? Bool ?? false,
            sharedY: (view["shared"] as? [String: Any])?["y"] as? Bool ?? false)
        case "grid": .grid(mode: view["mode"] as! String)
        default: nil
        }
      // (JSON has no -0: a lattice view's down range from 0 is [-80, -0] on the site too.)
      let spelled = String(describing: Optional(mine)).replacingOccurrences(of: " -0.0]", with: " 0.0]")
      check("view spec", spelled, String(describing: wanted))
      check("view axes", got.viewAxes, view["axes"] as? [String])
    }
    // Classification and plans.
    let cls = want["cls"] as? [String: Any]
    check("params", got.classified?.params, cls?["params"] as? [String])
    check("animated", got.classified?.animated, cls?["animated"] as? Bool)
    check("needs3D", got.classified?.needs3D, cls?["needs3D"] as? Bool)
    let cpu = want["cpu"] as? [String: Any]
    check("cpu type", got.cpu?.type, cpu?["type"] as? String)
    if let cpu, let mine = got.cpu, cpu["omitted"] == nil {
      do {
        check("cpu", "\(mine)", "\(try cpuPlan(cpu))")
      } catch {
        out.append("cpu: \(error)")
      }
    }
    let gpu = want["gpu"] as? [String: Any]
    check("gpu type", got.gpu?.type, gpu?["type"] as? String)
    if let gpu, let mine = got.gpu, gpu["omitted"] == nil {
      check("gpu params", mine.params, gpu["params"] as! [String])
      func same(_ what: String, _ a: String?, _ b: Any?) {
        check("gpu \(what)", a.map(normalizeGLSL), (b as? String).map(normalizeGLSL))
      }
      func sameList(_ what: String, _ a: [String]?, _ b: Any?) {
        check("gpu \(what)", a?.map(normalizeGLSL), (b as? [String])?.map(normalizeGLSL))
      }
      let graph = gpu["graphEval"] as? [String: Any]
      same("graphEval", mine.graphEval?.glsl, graph?["glsl"])
      check("gpu slopeScale", mine.graphEval?.slopeScale, graph?["slopeScale"].map(number))
      switch mine.shader {
      case .none: break
      case .implicit2d(let field, let levels):
        same("field", field, gpu["field"])
        let wanted = gpu["levels"] as? [String: Any]
        same("levels", levels?.glsl, wanted?["glsl"])
        sameList("levels gradient", levels?.gradGlsl, wanted?["gradGlsl"])
        check("gpu levels params", levels?.params, wanted?["params"] as? [String])
      case .ineq2d(let field, let edges):
        same("field", field, gpu["field"])
        sameList("edges", edges, gpu["edges"])
      case .scalar2d(let field):
        same("field", field, gpu["field"])
      case .vfield2d(let fx, let fy):
        same("fx", fx, gpu["fx"])
        same("fy", fy, gpu["fy"])
      case .complexField(_, let field):
        same("field", field, gpu["field"])
      case .fractal2d(let step, let seed, let maxIter):
        same("step", step, gpu["step"])
        check("gpu seed", seed, gpu["seed"] as? String)
        check("gpu maxIter", maxIter, (gpu["maxIter"] as? NSNumber)?.intValue)
      case .color2d(let space, let field, let locals):
        check("gpu space", space, gpu["space"] as? String)
        same("field", field, gpu["field"])
        same("locals", locals, gpu["locals"])
      case .tfield2d(let entries, let streamlines):
        sameList("entries", entries, gpu["entries"])
        check("gpu streamlines", streamlines, gpu["streamlines"] as? Bool ?? false)
        if gpu["jacobian"] != nil { out.append("gpu: a matrix field on mapped axes") }
      case .cobweb(let curveField):
        same("curveField", curveField, gpu["curveField"])
      case .bifurcation(let field):
        same("field", field, gpu["field"])
      case .implicit3d(let field, let grad):
        if gpu["plane"] != nil { out.append("gpu: the site draws a plane here") }
        same("field", field, gpu["field"])
        sameList("grad", grad, gpu["grad"])
      case .scalar3d(let field):
        same("field", field, gpu["field"])
      case .vfield3d(let comps):
        sameList("comps", comps, gpu["comps"])
      case .psurface(let comps, let du, let dv, let paint):
        sameList("comps", comps, gpu["comps"])
        sameList("du", du, gpu["du"])
        sameList("dv", dv, gpu["dv"])
        same("paint", paint, gpu["paint"])
      }
    }
    return out
  }

  /// The TypeScript's CPU plan, for the kinds ported.
  private func cpuPlan(_ o: [String: Any]) throws -> CpuPlan {
    func expr(_ key: String) throws -> Expr { try decode(o[key]!) }
    func exprs(_ key: String) throws -> [Expr] { try (o[key] as! [Any]).map(decode) }
    switch o["type"] as! String {
    case "implicit2d":
      var levels: CpuGrid?
      if let l = o["levels"] as? [String: Any] {
        levels = CpuGrid(
          name: l["name"] as! String, expr: try decode(l["expr"]!),
          grad: try (l["grad"] as? [Any])?.map(decode), params: l["params"] as! [String],
          angular: l["angular"] as! Bool, level: l["level"] as? String)
      }
      return .implicit2d(residual: try expr("residual"), equation: try expr("equation"), levels: levels)
    case "ineq2d":
      return .ineq2d(
        constraints: try (o["constraints"] as! [[String: Any]]).map {
          Constraint(residual: try decode($0["residual"]!), strict: $0["strict"] as! Bool)
        })
    case "scalar2d":
      if o["autoscale"] != nil { throw FixtureError(description: "an autoscaled field") }
      return .scalar2d(expr: try expr("expr"))
    case "point": return .point(dim: (o["dim"] as! NSNumber).intValue, coords: try exprs("coords"))
    case "pcurve":
      func optional(_ key: String) throws -> [Expr]? { try (o[key] as? [Any])?.map(decode) }
      if o["tube"] != nil {
        return .tube(
          comps: try exprs("comps"), radius: try expr("tube"), d1: try optional("d1"), d2: try optional("d2"),
          d3: try optional("d3"))
      }
      return .pcurve(
        dim: (o["dim"] as! NSNumber).intValue, comps: try exprs("comps"), d1: try optional("d1"),
        d2: try optional("d2"), d3: try optional("d3"))
    case "vfield2d": return .vfield2d(comps: try exprs("comps"))
    case "value":
      if o["shade"] != nil { throw FixtureError(description: "an integral's shaded area") }
      return .value(expr: try expr("expr"))
    case "label":
      return .label(dim: (o["dim"] as! NSNumber).intValue, coords: try exprs("coords"), text: o["text"] as! String)
    case "polygon":
      if o["over"] != nil { throw FixtureError(description: "a packed figure") }
      return .polygon(
        dim: (o["dim"] as! NSNumber).intValue, pts: try exprs("pts"), closed: o["closed"] as! Bool,
        arrow: o["arrow"] as? Bool ?? false, hull: o["hull"] as? Bool ?? false, over: nil)
    case "tfield2d":
      if o["jacobian"] != nil { throw FixtureError(description: "a matrix field on mapped axes") }
      return .tfield2d(entries: try exprs("entries"), streamlines: o["streamlines"] as? Bool ?? false)
    case "tuple":
      if o["count"] != nil || o["blades"] != nil || o["flat"] != nil {
        throw FixtureError(description: "a multiset, a multivector or a flat")
      }
      return .tuple(
        values: try exprs("values"), shape: (o["shape"] as? [NSNumber])?.map(\.intValue),
        length: (o["length"] as? NSNumber)?.intValue)
    case "note":
      return .note(
        expr: try expr("expr"), variable: o["variable"] as! Bool, constant: o["constant"] as? String,
        identity: o["identity"] as? Bool ?? false)
    case "complex2d": return .complexField(form: .potential, expr: try expr("expr"))
    case "domain2d": return .complexField(form: .domain, expr: try expr("expr"))
    case "conformal2d": return .complexField(form: .conformal, expr: try expr("expr"))
    case "fractal2d":
      return .fractal2d(
        step: try expr("step"), seed: o["seed"] as! String, maxIter: (o["maxIter"] as! NSNumber).intValue)
    case "rgb2d", "hsl2d", "oklch2d":
      return .color2d(space: String((o["type"] as! String).dropLast(2)), channels: try exprs("channels"))
    case "sequence": return .sequence(term: try expr("term"), index: o["index"] as! String)
    case "cobweb": return .cobweb(f: try expr("f"), recVar: o["recVar"] as! String, a0Name: o["a0Name"] as? String)
    case "bifurcation":
      return .bifurcation(expr: try expr("expr"), recVar: o["recVar"] as! String, a0Name: o["a0Name"] as? String)
    case "automaton":
      return .automaton(
        rule: try expr("rule"), radius: (o["radius"] as! NSNumber).intValue, seed: try o["seed"].map(decode),
        dims: (o["dims"] as! NSNumber).intValue, axes: o["axes"] as! [String])
    case "lattice":
      if o["rows"] != nil { throw FixtureError(description: "a table of computed rows") }
      return .lattice(expr: try expr("expr"), axes: o["axes"] as! [String])
    case "implicit3d":
      return .implicit3d(
        residual: try expr("residual"), equation: try expr("equation"),
        heightmap: try o["heightmap"].map { try decode($0) })
    case "scalar3d": return .scalar3d(expr: try expr("expr"))
    case "spacecurve": return .spacecurve(residuals: try exprs("residuals"))
    case "system":
      if o["complexEquation"] != nil || o["coordinates"] != nil {
        throw FixtureError(description: "a complex or positional system")
      }
      return .system(
        dim: (o["dim"] as! NSNumber).intValue, residuals: try exprs("residuals"),
        parametric: o["parametric"] as? Bool ?? false, angular: o["angular"] as? [Bool] ?? [])
    case "vfield3d": return .vfield3d(comps: try exprs("comps"))
    case "psurface": return .psurface(comps: try exprs("comps"), paint: try o["paint"].map { try decode($0) })
    case "density", "pmf":
      if o["mass"] != nil { throw FixtureError(description: "a density scaled by its intervals' length") }
      let rv = o["rv"] as! String
      return o["type"] as! String == "pmf" ? .pmf(rv: rv, mass: nil) : .density(rv: rv, mass: nil)
    case "expect": return .expect(rv: o["rv"] as! String)
    case "prob":
      let shade = try (o["shade"] as? [String: Any]).map { s in
        ProbShade(
          rv: s["rv"] as! String,
          bounds: ProbBounds(
            lo: try s["lo"].map(decode), hi: try s["hi"].map(decode), loStrict: s["loStrict"] as? Bool,
            hiStrict: s["hiStrict"] as? Bool, point: s["point"] as? Bool ?? false, not: s["not"] as? Bool ?? false))
      }
      return .prob(body: try expr("body"), shade: shade)
    default: throw FixtureError(description: "a \(o["type"]!) plan")
    }
  }
}

struct FixtureError: Error, CustomStringConvertible {
  var description: String
}

func fixture(_ name: String) throws -> Any {
  let url = try #require(Bundle.module.url(forResource: "Fixtures/\(name)", withExtension: "json"))
  return try JSONSerialization.jsonObject(with: Data(contentsOf: url))
}

/// A number as the fixtures carry it: whole numbers as JSON numbers, every
/// other as JavaScript writes it (JSONSerialization reads some decimals an
/// ulp off; Double's own parser does not).
func number(_ v: Any) -> Double {
  if let n = v as? NSNumber { return n.doubleValue }
  switch v as? String {
  case "Infinity": return .infinity
  case "-Infinity": return -.infinity
  case let text?: return Double(text) ?? .nan
  case nil: return .nan
  }
}

/// Equal, or within the last few places: the two libms differ there.
func close(_ a: Double, _ b: Double) -> Bool {
  if a.isNaN || b.isNaN { return a.isNaN && b.isNaN }
  if a == b { return true }
  return abs(a - b) <= 1e-13 * max(abs(a), abs(b))
}

/// GLSL with every number literal respelled from its float32 value, so the
/// two emitters' texts compare whatever digits each chose to write: the
/// TypeScript prints the double (`0.1`, `1E21`), Shader.swift the float.
func normalizeGLSL(_ glsl: String) -> String {
  let u = Array(glsl.utf8)
  var out = ""
  var i = 0
  func isWord(_ c: UInt8) -> Bool {
    (c >= 0x30 && c <= 0x39) || (c >= 0x41 && c <= 0x5A) || (c >= 0x61 && c <= 0x7A) || c == 0x5F
  }
  func isDigit(_ c: UInt8) -> Bool { c >= 0x30 && c <= 0x39 }
  while i < u.count {
    let c = u[i]
    if isDigit(c), i == 0 || !(isWord(u[i - 1]) || u[i - 1] == 0x2E) {
      var j = i
      while j < u.count, isDigit(u[j]) { j += 1 }
      if j < u.count, u[j] == 0x2E {
        j += 1
        while j < u.count, isDigit(u[j]) { j += 1 }
      }
      if j < u.count, u[j] == 0x45 || u[j] == 0x65 {
        var k = j + 1
        if k < u.count, u[k] == 0x2B || u[k] == 0x2D { k += 1 }
        if k < u.count, isDigit(u[k]) {
          while k < u.count, isDigit(u[k]) { k += 1 }
          j = k
        }
      }
      let text = String(decoding: u[i..<j], as: UTF8.self)
      out += "\(Float(Double(text) ?? .nan))"
      i = j
    } else {
      out.unicodeScalars.append(Unicode.Scalar(c))
      i += 1
    }
  }
  return out
}
