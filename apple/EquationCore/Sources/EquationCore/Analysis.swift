/// From a document's rows to what each row draws (lib/analysis.ts
/// `analyzeRows`): rows → definitions and environment → classification →
/// a CPU plan and a GPU plan per row.
///
/// A pure function of the rows. What the port has not reached comes back as
/// a row's `unsupported` message — never as a plot the site would not draw:
/// a definition the port cannot read takes its name with it, so every row
/// that names it is not supported either.

/// A constant's slider, as its row shows it.
public struct Slider: Equatable, Sendable {
  public var min: Double
  public var max: Double
  public var step: Double
  public var value: Double
}

public struct RowAnalysis: Equatable, Sendable {
  /// The row's math: its text without a trailing `# note`, trimmed.
  public var text: String
  /// Where a trailing `# note` starts in the row as written (UTF-16), if it has one.
  public var noteStart: Int?
  /// A `# heading` row.
  public var comment = false
  /// Set for definition rows (constants, functions, fields, points).
  public var definition: Definition?
  /// Set for viewport rows: `view(…)`, `camera(…)`, `grid(…)`, and `---`.
  public var view: ViewSpec?
  /// The error the site reports for the row.
  public var error: String?
  /// Why the app cannot show the row yet: the site draws it, the port does
  /// not. Such a row has no plans, and its other fields say nothing.
  public var unsupported: String?
  /// The readout under the row: a value, a verdict, or a hint.
  public var info: String?
  /// Set when the row is a constant a slider moves.
  public var slider: Slider?
  /// Whether the row shows a palette color (lib/palette.ts `takesColor`).
  public var takesColor = false
  /// The row's kind as the site's tools name it (lib/row-kind.ts).
  public var kind: String?
  /// Set for plot rows that classified.
  public var classified: Classified?
  public var cpu: CpuPlan?
  public var gpu: GpuPlan?

  /// A `---` row, which starts a new panel.
  public var divider: Bool {
    if case .split? = view { return true }
    return false
  }
}

public struct DocumentAnalysis: Equatable, Sendable {
  /// One per input row, in order.
  public var rows: [RowAnalysis]
  /// Every constant's value at t = 0, by name: what the plans' `params`
  /// read (as uniforms `uniformName` names, or by name on the CPU).
  public var env: [String: Double]
  /// Constants that move with t: their values need evaluating each frame
  /// (`environment(at:)`).
  public var animated: Set<String>
  /// The names the document binds, which the highlighter colors rows by
  /// (`highlightRows(_:names:)`).
  public var names: BoundNames
  /// The document's own functions (a slider's `clamp` is not one of these).
  var userFns: Set<String>
  /// Each constant's expression, in the order the rows define them.
  var constNames: [String]
  var constExprs: [Expr]

  /// Every constant's value at a time, in seconds since the graph opened
  /// (lib/env.ts `evaluateFrame`): what the uniforms read on that frame.
  public func environment(at time: Double) -> [String: Double] {
    if animated.isEmpty { return env }
    var defs = BuiltDefs()
    for (name, expr) in zip(constNames, constExprs) { defs.consts[name] = expr }
    return (try? evaluateFrame(defs, time: time)) ?? env
  }

  /// The row's text with its slider moved to `value`: held to the slider's
  /// range and step, written into its literal as the site writes it, the
  /// note kept. Nil when the row is not a slider. `source` is the row as
  /// written (with its note).
  public func settingSlider(row index: Int, to value: Double, in source: String) -> String? {
    guard rows.indices.contains(index), rows[index].slider != nil,
      case .constant(let name, let rhs, false)? = rows[index].definition
    else { return nil }
    let trimmed = jsTrimmed(rhs)
    guard let form = sliderForm(trimmed, userFns: userFns) else { return nil }
    let held = sliderValue(form, value, sliderBounds(form, env, userFns: userFns))
    return keepNote(source, "\(name) = \(writeSlider(trimmed, form, formatSliderNumber(held)))")
  }
}

// MARK: - Rows the port leaves alone

/// The names a row writes: maximal runs of name characters, canonicalized
/// (the tokenizer's identifier rule, so `2X` names X and `X2` is its own name).
func writtenNames(_ text: String) -> [String] {
  let u = Array(text.utf16)
  var out: [String] = []
  var i = 0
  while i < u.count {
    guard isNameStart(u[i]) else {
      // (Digits before a name are a number: `2x` is 2 and x.)
      i += 1
      continue
    }
    let start = i
    while i < u.count, isWrittenName(u[i]) { i += 1 }
    out.append(canonicalName(String(u[start..<i])))
  }
  return out
}

/// Whether a written name is one of `names`, or a part of one: A_x of the
/// point A, a_3 of the sequence a.
private func touches(_ name: String, _ names: Set<String>) -> Bool {
  if names.contains(name) { return true }
  let u = Array(name.utf16)
  for (k, c) in u.enumerated() where c == unit("_") && k > 0 {
    if names.contains(String(u[..<k])) { return true }
  }
  return false
}

/// The index as a standalone identifier in the term (lib/seq.ts `usesIndex`):
/// `a_j = 1/j^2` is a sequence, but `T_c = 300` and `k_B = 1.38` are
/// subscripted constants.
func usesIndex(_ u: Units, _ index: String) -> Bool {
  let w = Array(index.utf16)
  guard !w.isEmpty, u.count >= w.count else { return false }
  for start in 0...(u.count - w.count) where Array(u[start..<(start + w.count)]) == w {
    if start > 0, isWrittenName(u[start - 1]) { continue }
    if start + w.count < u.count, isWrittenName(u[start + w.count]) { continue }
    return true
  }
  return false
}

/// `^\s*name\s*\(…\)\s*$`
private func isWholeCall(_ text: String, _ name: String) -> Bool {
  var s = RowScanner(text)
  s.space()
  guard s.eat(word: name) else { return false }
  s.space()
  return s.peek == unit("(") && jsTrimEnd(s.u[...]).last == unit(")")
}

/// `^\s*ds\s*(?:\^\s*2|²)\s*=`: a panel's metric row.
private func isMetricRow(_ text: String) -> Bool {
  var s = RowScanner(text)
  s.space()
  guard s.eat(word: "ds") else { return false }
  s.space()
  if s.eat("^") {
    s.space()
    guard s.eat("2") else { return false }
  } else if !s.eat("\u{B2}") {
    return false
  }
  s.space()
  return s.peek == unit("=")
}

/// A scalar field in x alone (or y alone) is most often a curve meant as
/// `y = …`: the row says how to write that, since it now draws a field.
private func curveHint(_ object: MathObject, _ text: String) -> String? {
  guard case .scalarField(let expr) = object else { return nil }
  let vars = freeVars(expr)
  let (free, other) = vars.contains("x") ? ("x", "y") : ("y", "x")
  if !vars.contains(free) || vars.contains(other) { return nil }
  return "scalar field — for the curve write \(other) = \(text)"
}

private func notSupported(_ what: String) -> String {
  "Not supported in the app yet: \(what)."
}

// MARK: - Definitions

/// A document's rows as far as its definitions (lib/analysis.ts
/// `prepareDocument`): what each row is by its text, and what the names it
/// defines come to. The highlighter colors names by this; `analyze` goes on
/// from it to what each row draws.
struct PreparedDocument {
  /// Each row's math: its text without a trailing `# note`, trimmed.
  var texts: [String]
  /// The `# heading` rows.
  var comments: Set<Int> = []
  /// The definition each row scans as, whether or not it is the one that owns the name.
  var scanned: [Definition?]
  /// Each row's sequence reading, decided across the document (`scanSequences`).
  var seqScans: [SeqScan?] = []
  /// The rows the port leaves alone, with what stopped it: such a row's
  /// definition is not in `built`.
  var blocked: [Int: String] = [:]
  /// Every name a `~` row writes: a random variable, or a fit and its coefficients.
  var tildeNames: Set<String> = []
  /// The definitions in row order, one per key, and the row that owns each.
  var raw: [Definition] = []
  var owner: [String: Int] = [:]
  /// Rows that define a name a row above already has.
  var duplicates: [Int] = []
  var built = BuiltDefs()
}

func prepareDocument(_ sources: [String]) -> PreparedDocument {
  // A trailing `# note` is prose for the reader; the math is what precedes it.
  let texts = sources.map { jsTrimmed(stripNote($0)) }
  let count = texts.count
  var document = PreparedDocument(texts: texts, scanned: Array(repeating: nil, count: count))

  // What each row is by its text alone, and the rows the port leaves alone:
  // random variables and regressions (`~`), a tuple-valued recurrence's seed.
  let seqScans = scanSequences(texts)
  document.seqScans = seqScans
  var blocked: [Int: String] = [:]
  var poison: Set<String> = []
  var tildeNames: Set<String> = []
  var scanned: [Definition?] = Array(repeating: nil, count: count)
  for (i, text) in texts.enumerated() where !text.isEmpty {
    if text.hasPrefix("#") {
      document.comments.insert(i)
    } else if text.contains("~") {
      blocked[i] = "random variables and regressions (~)"
      // A fit defines its coefficients too: every name in the row is its.
      tildeNames.formUnion(writtenNames(text))
    } else if let scan = seqScans[i] {
      // Sequence and recurrence rows (a_n = …, a_{n+1} = …) are plots, not definitions.
      if scan.emptyTuple {
        blocked[i] = "tuple-valued recurrences"
        poison.insert(scan.name)
      }
    } else {
      scanned[i] = scanDefinition(text)
    }
  }
  poison.formUnion(tildeNames)

  // Pass 1: definitions. The first row to define a name owns it.
  var raw: [Definition] = []
  var owner: [String: Int] = [:]
  var duplicates: [Int] = []
  for i in 0..<count {
    guard let d = scanned[i] else { continue }
    if owner[d.key] != nil {
      duplicates.append(i)
    } else {
      owner[d.key] = i
      raw.append(d)
    }
  }

  // A definition the port cannot read takes its name out of reach: the rows
  // that write the name are not supported, and so are the names they define.
  var built = BuiltDefs()
  while true {
    var grew = true
    while grew {
      grew = false
      for i in 0..<count where blocked[i] == nil && !document.comments.contains(i) {
        guard let name = writtenNames(texts[i]).first(where: { touches($0, poison) }) else { continue }
        blocked[i] = "it uses \(name), which is not supported yet"
        if let d = scanned[i], poison.insert(d.name).inserted { grew = true }
        if let scan = seqScans[i], poison.insert(scan.name).inserted { grew = true }
      }
    }
    let skip = Set(raw.filter { blocked[owner[$0.key]!] != nil }.map(\.key))
    // An automaton's letter names rows of cells, not scalar terms.
    built = buildDefs(raw, skip: skip, sequences: seqScans.compactMap { $0 }.filter { !$0.lattice && !$0.emptyTuple })
    var found = false
    for d in raw where !skip.contains(d.key) {
      guard let what = built.unsupported[d.key] else { continue }
      blocked[owner[d.key]!] = what
      poison.insert(d.name)
      found = true
    }
    if !found { break }
  }
  document.scanned = scanned
  document.blocked = blocked
  document.tildeNames = tildeNames
  document.raw = raw
  document.owner = owner
  document.duplicates = duplicates
  document.built = built
  return document
}

// MARK: - analyze

/// Analyze a document: one result per row, and the constants' values.
public func analyze(_ sources: [String]) -> DocumentAnalysis {
  let document = prepareDocument(sources)
  let (texts, blocked, tildeNames) = (document.texts, document.blocked, document.tildeNames)
  let (raw, owner, duplicates) = (document.raw, document.owner, document.duplicates)
  // (A recurrence's chain of terms is written into the constants as rows resolve.)
  var built = document.built
  var rows = zip(sources, texts).map { RowAnalysis(text: $1, noteStart: noteStart($0)) }
  let count = rows.count
  for i in 0..<count {
    rows[i].comment = document.comments.contains(i)
    rows[i].definition = document.scanned[i]
  }

  for (key, text) in built.errors.entries {
    if let i = owner[key], blocked[i] == nil { rows[i].error = text }
  }
  for i in duplicates where blocked[i] == nil {
    guard let d = rows[i].definition, let first = owner[d.key] else { continue }
    // `r = sqrt(x^2 + y^2); r = 2` is a level set of r. A field over u, v
    // has no level sets in the plane, so a second `k = …` is a redefinition.
    let levelSet = d.kind == "fn" && built.fns[d.name] != nil && texts[i] != texts[first]
    var planar = false
    if let field = built.fields[d.name] {
      let vars = freeVars(field)
      planar = !vars.contains("u") && !vars.contains("v")
    }
    if planar || levelSet {
      rows[i].definition = nil
    } else {
      rows[i].error = "\(d.key) is already defined."
    }
  }

  // Only static constants can affect compilation.
  let constEnv = (try? evaluateFrame(built, time: 0)) ?? [:]
  let animated = animatedConstNames(built)
  // Pass 2: viewport rows and plots.
  var constNames = Set(built.consts.keys)
  // A named condition is written into a row as a field is.
  var fieldEnv: [String: Expr] = [:]
  for (name, e) in built.fields.entries { fieldEnv[name] = e }
  for (name, e) in built.conditions.entries { fieldEnv[name] = e }
  let fnNames = Set(raw.compactMap { if case .function(let name, _, _) = $0 { name } else { nil } })
  // What parses as an index: the named points (T[2]).
  let sequences = SequenceResolver(
    document.seqScans.compactMap { $0 }.filter { !$0.lattice && !$0.emptyTuple }, rawNames: raw.map(\.name))
  defer { sequences.release() }
  let listNames = Set(built.points).union(built.mats.keys).union(built.tensors.keys)
    .union(sequences.sequences.keys.map { $0 + "_" })
  let valueNames = shadowedFnNames(raw.filter { $0.kind != "fn" }.map(\.name) + Array(tildeNames))
  let documentNames = Set(raw.map(\.name)).union(tildeNames)
  func getFn(_ name: String) throws -> FnDef? {
    if let fn = built.fns[name] { return fn }
    if fnNames.contains(name) { throw LanguageError("\(name) has an error in its definition.") }
    return nil
  }
  // A view's bounds read the constants' values at t = 0, the animated ones excluded.
  var boundVals = constEnv
  for name in animated { boundVals[name] = nil }
  func comps(_ name: String) -> [String]? {
    built.points.contains(name) ? pointComps(name, built.pointDims[name] ?? 2) : nil
  }
  var ropts = ResolveOpts()
  ropts.definition = { built.fields[$0] ?? built.conditions[$0] ?? built.consts[$0] }
  ropts.comps = comps
  ropts.documentNames = documentNames
  ropts.complex = { built.complexes[$0] }
  // Σ/Π bounds in plot rows expand against the constants' values at t = 0.
  let boundConsts = NameBox()
  boundConsts.names = built.sumBoundConsts
  ropts.consts = { boundVals[$0] }
  ropts.boundConsts = boundConsts
  if !sequences.sequences.isEmpty {
    ropts.sequenceTerm = { [unowned sequences] in try sequences.resolve($0, $1, $2) }
  }
  sequences.getFn = getFn
  sequences.opts = ropts
  sequences.fnNames = { Set(built.fns.keys) }
  sequences.indexNames = { Set(built.points) }
  sequences.isKnown = { constNames.contains($0) }
  sequences.addKnown = { constNames.insert($0) }
  sequences.protectedNames = Set(raw.map(\.name))
  sequences.hasConst = { built.consts.has($0) }
  sequences.defineConstant = { built.consts[$0] = $1 }
  sequences.setValue = { boundVals[$0] = $1 }

  // Each panel's rows are read with its view's maps, its surface and its
  // metric, none of which is ported: a panel that has one is left alone.
  var panelBlocked: Set<Int> = []
  do {
    var at = 0
    for (i, text) in texts.enumerated() where !text.isEmpty && rows[i].definition == nil && !rows[i].comment {
      if isDividerRow(text) {
        at += 1
      } else if isMetricRow(text) && !documentNames.contains("ds") {
        panelBlocked.insert(at)
      } else if let head = viewHead(text), head == "view" || head == "on", !fnNames.contains(head) {
        do {
          _ = try parseViewRow(text, boundVals)
        } catch is Unsupported {
          panelBlocked.insert(at)
        } catch {
          // The row's own error.
        }
      }
    }
  }

  var seenViewKinds: Set<String> = []
  var viewsUnknown = false
  var panel = 0
  for i in 0..<count {
    let text = texts[i]
    if let why = blocked[i] {
      rows[i].unsupported = notSupported(why)
      // A view row the port could not read may have framed this panel.
      if viewHead(text) != nil { viewsUnknown = true }
      continue
    }
    if rows[i].definition != nil || rows[i].comment || rows[i].error != nil || text.isEmpty { continue }
    do {
      if scanOpenHead(text) != nil { throw Unsupported("data files") }
      // A call to the user's own view/camera/grid function is theirs.
      let head = viewHead(text)
      if isDividerRow(text) || (head != nil && !fnNames.contains(head!)) {
        if viewsUnknown && !isDividerRow(text) { throw Unsupported("a view row after one that is not supported") }
        if let view = try parseViewRow(text, boundVals) {
          // Each panel frames itself: a divider starts a fresh set.
          if case .split = view {
            panel += 1
            if panel >= maxPanels { throw LanguageError("A graph splits into at most \(maxPanels) panels.") }
            seenViewKinds = []
            viewsUnknown = false
          } else if seenViewKinds.contains(view.kind) {
            throw LanguageError(
              "\(view.kind) is already set by another row\(panel > 0 ? " in this panel" : "")"
                + (panel > 0 ? "." : " — a --- row starts a new panel with its own."))
          }
          seenViewKinds.insert(view.kind)
          rows[i].view = view
          continue
        }
      }
      if panelBlocked.contains(panel) { throw Unsupported("a panel with mapped axes, a surface or a metric") }
      if isMetricRow(text) && !documentNames.contains("ds") { throw Unsupported("metrics (ds^2 = …)") }
      let trimmed = jsTrimmed(text)
      if (trimmed == "lightcones" || trimmed == "tidal") && !documentNames.contains(trimmed) {
        throw Unsupported("light cones and tidal forces")
      }
      // `P(…)` shades an area under a declared density — unless the user
      // has defined P themselves. With no random variable there is none.
      for letter in ["P", "E"] where isWholeCall(text, letter) && !constNames.contains(letter) {
        if built.fns[letter] != nil { continue }
        if !tildeNames.isEmpty { throw Unsupported("probabilities and expectations") }
        throw LanguageError("Define a random variable first, e.g. X ~ Normal(0, 1).")
      }
      if let seq = document.seqScans[i], seq.lattice {
        // A seed row draws nothing of its own; the rule row carries it.
        rows[i].classified = try classifyAutomatonRow(
          document.seqScans, i, fnNames: fnNames, getFn: getFn, constNames: constNames, ropts: ropts)
        continue
      }
      if let seq = document.seqScans[i] {
        let first = document.seqScans.firstIndex { $0?.name == seq.name && $0?.emptyTuple == false }
        if let first, first < i { throw LanguageError("Sequence \(seq.name) is already defined.") }
        rows[i].classified = try classifySeqRec(
          seq, fnNames: fnNames, getFn: getFn, constNames: { constNames }, ropts: ropts, resolver: sequences,
          indexNames: Set(built.points))
        continue
      }
      // `d = 1` is no definition (d starts d/dx).
      let taken = takenDefinitionName(text)
      if taken == "d" {
        throw LanguageError(
          "d is taken by derivatives (d/dx), so it cannot name a slider or function. Pick another name, like k.")
      }
      for call in ["graph", "mark"] where !fnNames.contains(call) && viewHeadIs(text, call) {
        throw Unsupported("\(call)(…)")
      }
      if let takenName = takenBinder(text) { throw LanguageError(takenName) }
      let rawParsed = try parseExpr(text, userFns: fnNames, listNames: listNames, valueNames: valueNames)
      // `p(50..400)`: where p goes over that time.
      if case .bin(.mul, _, .range, _) = rawParsed { throw Unsupported("orbits") }
      // A row not drawn over the plane may test equality in a case: `f(2)`
      // with f(m) = {mod(m, 2) = 0: …}.
      func plane(_ e: Expr) -> Bool { freeVars(e).contains(where: ["x", "y", "z"].contains) }
      let exact = !plane(rawParsed)
      var rowOpts = ropts
      rowOpts.exactConditions = exact
      var resolved = try Resolver(getFn: getFn, opts: rowOpts).resolve(rawParsed)
      if exact {
        // Over numbers a case is the tolerance form the evaluator runs.
        let cases = exactCases(resolved)
        if cases != resolved && plane(resolved) {
          throw LanguageError(equalityCaseMessage)
        }
        resolved = cases
      }
      // Expand point arithmetic: a point name A becomes (A_x, A_y).
      let lowered = try lowerObjects(
        resolved, comps: comps, mats: { built.mats[$0] }, tensors: { name, _ in built.tensors[name] })
      // A real row in u and v alone does not depend on the screen, so the
      // site draws the density of its values, as a random variable's.
      switch resolved {
      case .eq, .ineq: break
      case _ where usesComplex(resolved): break
      default:
        let free = freeVars(resolved).list.filter { !constNames.contains($0) }
        if free.contains(where: { $0 == "u" || $0 == "v" }),
          !free.contains(where: ["x", "y", "z", "w"].contains)
        {
          if case .vec = lowered {} else { throw Unsupported("the density of a row in u or v") }
        }
      }
      var cls = try classify(lowered, defined: constNames, fields: fieldEnv)
      rows[i].info = curveHint(cls.object, text)
      // `e = 0.6` parsed with e already a number; only the text still says e.
      if let taken, case .note(let expr, let variable, _, let identity) = cls.object {
        cls.object = .note(expr: expr, variable: variable, constant: taken, identity: identity)
      }
      rows[i].classified = cls
    } catch let error as Unsupported {
      rows[i].unsupported = notSupported(error.what)
      if viewHead(text) != nil { viewsUnknown = true }
    } catch {
      var text = errorMessage(error)
      // `i = 3` fails as a claim about i; the author meant a definition, so
      // say why it is not one.
      if let taken = takenDefinitionName(texts[i]), taken != "d" {
        if text.hasSuffix(".") { text.removeLast() }
        text = "\(text) — \(takenNameHint(taken))."
      }
      rows[i].error = text
    }
  }

  // A named point in space draws a dot in a 3D scene, which is not ported;
  // its components are constants like any others.
  for i in 0..<count where blocked[i] == nil && rows[i].error == nil {
    guard let d = rows[i].definition, built.points.contains(d.name), built.pointDims[d.name] == 3 else { continue }
    if pointComps(d.name, 3).allSatisfy(constNames.contains) {
      rows[i].unsupported = notSupported("points in space")
    }
  }

  // Backend compilation is explicit and never changes the semantic object.
  var readoutEnv = constEnv
  for (name, value) in boundVals { readoutEnv[name] = value }
  readoutEnv["t"] = 0
  for i in 0..<count {
    guard let cls = rows[i].classified, rows[i].error == nil else { continue }
    do {
      let cpu = try compileCpu(cls)
      rows[i].gpu = try compileGpu(cls)
      rows[i].cpu = cpu
      if let info = try? plotReadout(cpu, readoutEnv) { rows[i].info = info }
    } catch let error as Unsupported {
      rows[i].unsupported = notSupported(error.what)
      rows[i].classified = nil
      rows[i].info = nil
    } catch {
      rows[i].error = errorMessage(error)
      rows[i].cpu = nil
      rows[i].gpu = nil
    }
  }

  // A slider that is a Σ/Π bound steps in whole numbers. A row the port
  // leaves alone never expands its sums, so which sliders it bounds one by is
  // not known here: one such a row names, with a sum in reach, is left alone
  // rather than given the wrong step.
  let sumGlyphs: Set<UInt16> = [0x03A3, 0x2211, 0x03A0, 0x220F]
  let hasSums = texts.contains { text in
    text.utf16.contains(where: sumGlyphs.contains)
      || writtenNames(text).contains { ["sum", "prod"].contains($0.lowercased()) }
    // (A slider a sequence's term is read at, a_k, steps in whole numbers too.)
  } || document.seqScans.contains { $0 != nil }
  var namedByUnsupported: Set<String> = []
  if hasSums {
    for i in 0..<count where rows[i].unsupported != nil {
      for name in writtenNames(texts[i]) {
        namedByUnsupported.insert(name)
        // The slider a term is read at: the k of a_k.
        let u = Array(name.utf16)
        if u.count > 2, u[1] == unit("_"), sequences.sequences[String(decoding: u[..<1], as: UTF16.self)] != nil {
          namedByUnsupported.insert(String(decoding: u[2...], as: UTF16.self))
        }
      }
    }
  }

  // What each row shows beside its text.
  let userFns = Set(built.fns.keys)
  for i in 0..<count {
    var row = rows[i]
    defer { rows[i] = row }
    if row.unsupported != nil { continue }
    if case .constant(let name, let rhs, false)? = row.definition, namedByUnsupported.contains(name),
      let form = sliderForm(jsTrimmed(rhs), userFns: userFns), !form.whole, !boundConsts.names.contains(name)
    {
      row.unsupported = notSupported("a slider that a sum may step in whole numbers")
      continue
    }
    let named = row.definition.map { built.points.contains($0.name) } ?? false
    if row.comment {
      row.kind = "comment (group heading)"
    } else if let d = row.definition {
      let valued = built.mats.has(d.name) ? "matrix" : built.tensors.has(d.name) ? "tensor" : nil
      let constant = valued ?? (named ? "point" : "const")
      row.kind = "definition (\(d.kind == "const" ? constant : d.kind))"
    } else if let view = row.view {
      row.kind =
        switch view {
        case .split: "panel divider (the rows below it draw in a panel of their own)"
        case .grid: "grid (what draws behind its panel's plots)"
        default: "viewport (\(view.kind))"
        }
    } else if let cls = row.classified {
      row.kind = cls.object.publicKind
    }
    // Blank rows, definitions (other than named points), comments and view
    // rows draw nothing, a value row shows only its readout, and a `#hex`
    // note picks its own color. A row with an error does take one: it is
    // usually a curve being typed.
    var draws = true
    switch row.cpu {
    case .note, .value: draws = false
    default: break
    }
    row.takesColor =
      !jsTrimmed(sources[i]).isEmpty && !row.comment && (row.definition == nil || named) && row.view == nil
      && noteColor(sources[i]) == nil && draws
    // A constant whose right-hand side is a number the user wrote is a slider.
    if case .constant(let name, let rhs, false)? = row.definition, row.error == nil,
      let form = sliderForm(jsTrimmed(rhs), userFns: userFns)
    {
      var value = form.literal
      let lo: Double
      let hi: Double
      if let bounds = sliderBounds(form, constEnv, userFns: userFns) {
        (lo, hi) = bounds
        value = sliderValue(form, value, bounds)
      } else {
        // No written range: one that fits the value.
        lo = JS.min([-10, value.rounded(.down)])
        hi = JS.max([10, value.rounded(.up)])
      }
      // Whole-number sliders step one at a time; otherwise a round step
      // (1, 2 or 5 × 10^k), so round values sit on it.
      row.slider = Slider(min: lo, max: hi, step: form.whole || boundConsts.names.contains(name) ? 1 : niceSpacing((hi - lo) / 400, 1).major, value: value)
    }
  }
  // The constants once more: a recurrence's chain of terms is among them now.
  let env = (try? evaluateFrame(built, time: 0)) ?? constEnv
  return DocumentAnalysis(
    rows: rows, env: env, animated: animatedConstNames(built), names: boundNames(document), userFns: userFns,
    constNames: built.consts.keys,
    constExprs: built.consts.entries.map(\.value))
}

/// `^\s*name\s*\(`
private func viewHeadIs(_ text: String, _ name: String) -> Bool {
  var s = RowScanner(text)
  s.space()
  guard s.eat(word: name) else { return false }
  s.space()
  return s.peek == unit("(")
}
