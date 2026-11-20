/// `fourier(…)` and `reconstruct(…)` in a row (lib/list.ts `lowerFourier`,
/// and the resolver's case for the two in lib/defs.ts `rx`): the numbers go
/// through Fourier.swift, and what comes back is a list of spectrum points
/// or the series as an ordinary expression in x.

/// What `lowerFourier` reads of list lowering's context (Lists.swift `Ctx`,
/// whose helpers are that file's own).
struct ListLowering {
  let opts: ResolveOpts
  let lower: (Expr) throws -> Low
  let settle: (Low) throws -> Low
  /// `constVal(e, what, whole)`.
  let constVal: (Expr, String, Bool) throws -> Double
  let numericItems: ([Expr], String) throws -> [Double]
  let listOf: ([Expr]) throws -> Expr
}

/// A named clamp keeps every slider input within the validated range
/// (`harmonicClamp`). Its upper bound fixes the shader's size; the count
/// itself stays a uniform. Unbounded counts keep the static path so invalid
/// drags still diagnose.
private func harmonicClamp(_ count: Expr, _ ctx: ListLowering) throws -> (definition: Expr, lo: Double, hi: Double)? {
  guard case .var(let name) = count, let definition = ctx.opts.definition(name) else { return nil }
  var bound = definition
  while case .call(let fn, let args) = bound, ["round", "floor", "ceil"].contains(fn), args.count == 1 {
    bound = args[0]
  }
  guard case .call("min", let outer) = bound, outer.count == 2, case .call("max", let inner) = outer[0],
    inner.count == 2
  else { return nil }
  let lo = try ctx.constVal(try ctx.lower(inner[1]).e, "The harmonic slider minimum", false)
  let hi = try ctx.constVal(try ctx.lower(outer[1]).e, "The harmonic slider maximum", false)
  return JS.isInteger(lo) && JS.isInteger(hi) && lo >= 0 && hi > lo && hi <= Double(FOURIER_MAX_HARMONICS)
    ? (definition, lo, hi) : nil
}

/// Fourier consumes a signal whole, rather than mapping over its samples
/// (`lowerFourier`). A continuous signal is read over the one interval in
/// it, which is both its variable and its period — `s = interval(0, 2pi);
/// fourier(sin(3s))`. Samples are a tuple (a list is a multiset: only a
/// tuple has an order), spread over [0, 1) or the interval after them.
func lowerFourier(_ name: String, _ args: [Expr], _ ctx: ListLowering) throws -> Low {
  let reconstruction = name == "reconstruct"
  let offset = reconstruction ? 2 : 1
  let example =
    reconstruction
    ? "s = interval(0, 1); y = reconstruct(sign(sin(2pi s)), N)" : "s = interval(0, 1); fourier(sin(2pi s))"
  if args.count != offset && args.count != offset + 1 {
    let n = reconstruction ? ", N" : ""
    throw LanguageError(
      "Use \(name)(signal\(n)) or \(name)(signal\(n), samples), the signal over an interval: \(example).")
  }
  let count: Expr? = reconstruction ? args[1] : nil
  let clamp = try count.flatMap { try harmonicClamp($0, ctx) }
  // Validate against the declaration, without marking the count's current
  // value as a structural input. Bounds and signal coefficients remain
  // structural, and a fractional/invalid initial count is still refused.
  let requested =
    try count.map {
      try ctx.constVal(try ctx.lower(clamp?.definition ?? $0).e, "The number of harmonics", clamp == nil)
    } ?? 0
  if clamp != nil, case .var(let counted)? = count { ctx.opts.boundConsts?.names.insert(counted) }
  if !JS.isInteger(requested) || requested < 0 || requested > Double(FOURIER_MAX_HARMONICS) {
    throw LanguageError("reconstruct needs a whole number of harmonics from 0 to \(FOURIER_MAX_HARMONICS).")
  }
  // The last argument: a continuous signal's sample count, or the interval a
  // tuple of samples spans.
  let option = args.count > offset ? try ctx.lower(args[offset]) : nil
  func spanOf(_ h: HiddenInterval) throws -> (lo: Double, period: Double) {
    let lo = try ctx.constVal(try ctx.lower(h.lo).e, "The interval start", false)
    let hi = try ctx.constVal(try ctx.lower(h.hi).e, "The interval end", false)
    return (lo, hi - lo)
  }
  let span = option.map { intervalsIn($0.e) } ?? []
  if let option, !span.isEmpty, span.count != 1 || span[0].node != option.e {
    throw LanguageError("The last argument is a sample count, or the interval a tuple of samples spans.")
  }
  let signal = try ctx.settle(try ctx.lower(args[0]))
  var xs: [Double]
  var lo = 0.0
  var period = 1.0
  var tuple: [Expr]?
  if case .vec(let items) = signal.e { tuple = items }
  if signal.isSeq || tuple != nil {
    if option != nil && span.isEmpty {
      throw LanguageError(
        "A tuple of samples has its own count; give the interval it spans instead: fourier(S, interval(0, 10)).")
    }
    if !span.isEmpty { (lo, period) = try spanOf(span[0]) }
    if signal.isSeq && (!isTuple(signal) || signal.own.count != 1) {
      throw LanguageError(
        "Fourier samples need an order: use a tuple, or sort(data.signal, data.row) for CSV row order.")
    }
    if signal.isText { throw LanguageError("Fourier samples must be finite real numbers.") }
    // (A list still a template over a slider has no numbers to read yet.)
    if signal.isLazy { throw Unsupported("Fourier analysis of samples that move") }
    let items = tuple ?? signal.items
    let length = signal.isData ? signal.values.count : items.count
    if length < 2 || length > FOURIER_MAX_SAMPLES {
      throw LanguageError("Fourier analysis needs 2 to \(FOURIER_MAX_SAMPLES) samples.")
    }
    xs = signal.isData ? signal.values : try ctx.numericItems(items, name)
  } else {
    if !span.isEmpty {
      throw LanguageError("The signal's own interval sets its period; the last argument is its sample count.")
    }
    let sampleCount =
      try option.map { try ctx.constVal($0.e, "The Fourier sample count", true) } ?? Double(FOURIER_SAMPLES)
    if !JS.isInteger(sampleCount) || sampleCount < 2 || sampleCount > Double(FOURIER_MAX_SAMPLES) {
      throw LanguageError("The Fourier sample count must be a whole number from 2 to \(FOURIER_MAX_SAMPLES).")
    }
    if try inferScalarType(signal.e) != .real {
      throw LanguageError("Fourier analysis needs a real signal, not a complex one.")
    }
    let over = intervalsIn(signal.e)
    if over.count != 1 {
      throw LanguageError(
        over.isEmpty
          ? "A Fourier signal is read over an interval, which sets its period: \(example)."
          : "A Fourier signal is read over one interval; this one has \(over.count).")
    }
    (lo, period) = try spanOf(over[0])
    let at = "@fourier"
    // A real signal reached through complex values (|a| sin(2pi s) with a
    // complex, re(e^(2pi i s))) is read as its real part.
    let body = try realValue(replaceIntervals(signal.e) { _ in .var(at) }, "A Fourier signal")
    var env: [String: Double] = [:]
    for name in freeVars(body) where name != at {
      guard let value = ctx.opts.consts(name) else {
        throw LanguageError(
          ["x", "y", "z", "u", "v", "w"].contains(name)
            ? "A Fourier signal is read over its interval, not \(name): \(example)."
            : "Fourier signals must be static; \"\(name)\" has no static value.")
      }
      env[name] = value
    }
    let n = Int(sampleCount)
    xs = [Double](repeating: 0, count: n)
    for j in 0..<n {
      env[at] = lo + period * (Double(j) / sampleCount)
      xs[j] = try evaluate(body, env)
    }
  }
  if !(period > 0) || !period.isFinite || !((2 * Double.pi) / period).isFinite {
    throw LanguageError("A Fourier interval needs finite bounds, start before end, and a finite frequency scale.")
  }
  if !((2 * Double.pi * Double(xs.count / 2)) / period).isFinite {
    throw LanguageError("The Fourier frequency scale is not finite; use a wider interval.")
  }
  let max = min(xs.count / 2, FOURIER_MAX_HARMONICS)
  if reconstruction && requested > Double(max) {
    throw LanguageError("This signal has only \(xs.count / 2) harmonics; use N from 0 to \(max).")
  }
  let coefficients = try realFourier(xs)
  let live = clamp.map { $0.hi <= Double(max) } ?? false
  // A clamp extending past Nyquist cannot stay on the uniform path: moving
  // it there must recompile to report the same out-of-range diagnostic.
  if clamp != nil && !live { _ = try ctx.constVal(try ctx.lower(count!).e, "The number of harmonics", true) }
  if reconstruction {
    return Low(
      reconstructSeries(
        coefficients, harmonics: Int(live ? clamp!.hi : requested), lo: lo, period: period,
        count: live ? count : nil))
  }
  return Low(try ctx.listOf(spectrumPoints(coefficients, period)), nil)
}

extension Resolver {
  /// A name defined as an interval, written in where the name is read
  /// (lib/defs.ts `rx`, `opts.interval`): the same node at every mention.
  /// A function's parameter of the same name shadows it.
  func namedInterval(_ name: String) throws -> Expr? {
    if opts.params?.contains(name) == true { return nil }
    return opts.interval(name)
  }

  /// `interval(a, b)`, `fourier(…)` and `reconstruct(…)` (lib/defs.ts `rx`,
  /// case 'call'), or nil for any other call.
  func resolveSignalCall(_ name: String, _ rawArgs: [Expr]) throws -> Expr? {
    if name == "interval" { return try hiddenInterval(try legacyCallArgs(name, rawArgs).map(resolve)) }
    guard name == "fourier" || name == "reconstruct" else { return nil }
    let args = try legacyCallArgs(name, rawArgs).map(resolve)
    var scope = opts
    if let params = opts.params, !params.isEmpty {
      // A parameter is not the document's constant, list or field of the same name.
      let (consts, getList, definition) = (opts.consts, opts.getList, opts.definition)
      scope.consts = { params.contains($0) ? nil : consts($0) }
      scope.getList = { params.contains($0) ? nil : try getList?($0) }
      scope.definition = { params.contains($0) ? nil : definition($0) }
    }
    var signal = args.first
    // A function is read over an interval its caller names, not over an x
    // the document never wrote: f(interval(0, 1)).
    if case .var(let fn)? = signal, opts.params?.contains(fn) != true, try getFn(fn) != nil {
      throw LanguageError(
        "\(name) reads a signal over an interval, which sets its period: "
          + "\(name)(\(fn)(interval(0, 1))\(name == "reconstruct" ? ", N" : "")).")
    }
    // Coordinate fields can name a signal too. Scalar constants remain names
    // so list lowering records every numeric dependency it reads.
    if let written = signal { signal = Resolver(getFn: getFn, opts: scope).throughFields(written) }
    // Finish the numeric transform before a containing user function is
    // inlined: g(x) = reconstruct(f, N); g(2x) scales the finished
    // approximation, not the signal's sampling variable and interval.
    let lowered = try lowerLists(
      .call(name, signal.map { [$0] + args.dropFirst() } ?? args), scope.getList ?? { _ in nil }, scope, named: true)
    if hasInterval(lowered.e) { throw Unsupported("interval(…)") }
    return settledNode(lowered)
  }
}
