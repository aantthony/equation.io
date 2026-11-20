/// The complex rows of lib/plot.ts `classifyLowered`: the whole-expression
/// forms (`domain`, `conformal`, `iter`, `rgb`, `hsl`, `oklch`) and a complex
/// path, as `classify` (Classify.swift) calls them.

/// How a complex value at every pixel is drawn (lib/math-object.ts, the
/// `complex-field` forms other than a fractal).
public enum ComplexForm: String, Equatable, Sendable {
  case potential, domain, conformal

  /// The plan's `type`, as the TypeScript spells it.
  public var planType: String {
    switch self {
    case .potential: "complex2d"
    case .domain: "domain2d"
    case .conformal: "conformal2d"
    }
  }
}

/// Every call that is a whole row rather than a value, by the name the user
/// writes (lib/complex.ts `WHOLE_EXPR_NAMES`; the geometry statements are
/// the rest, and belong to their own port).
private let WHOLE_EXPR_NAMES: Set<String> = SPECIAL_FORMS.union(["tube", "revolve", "[trail]", "label"])

/// The special form a row is, when it is a call to one.
func specialForm(_ e: Expr) -> String? {
  if case .call(let name, _) = e, SPECIAL_FORMS.contains(name) { return name }
  return nil
}

/// Neither a tuple, a list nor a comparison.
func isBareScalar(_ e: Expr) -> Bool {
  switch e {
  case .vec, .list, .eq, .ineq: false
  default: true
  }
}

func isListNode(_ e: Expr) -> Bool {
  if case .list = e { return true }
  return false
}

/// First special-form call at any position other than the root itself
/// (lib/plot.ts `nestedSpecial`), as the row's error names it.
func nestedSpecial(_ e: Expr, isRoot: Bool = false) -> String? {
  if !isRoot {
    switch e {
    case .trail: return "trail"
    case .label, .hist, .family: return e.kind
    case .figure(let form, _, _, _): return form.rawValue
    case .call(let name, _) where WHOLE_EXPR_NAMES.contains(name): return name == "[trail]" ? "trail" : name
    default: break
    }
  }
  switch e {
  case .num, .var, .data, .str, .text, .lazy:
    return nil
  case .piecewise(let cases, let otherwise):
    for c in cases {
      if let f = nestedSpecial(c.cond) ?? nestedSpecial(c.value) { return f }
    }
    return otherwise.flatMap { nestedSpecial($0) }
  default:
    for child in childrenOf(e) {
      if let f = nestedSpecial(child) { return f }
    }
    return nil
  }
}

/// `domain(…)`, `conformal(…)`, `iter(…)` and the colour fields, each the
/// whole row (lib/plot.ts `classifyLowered`, `if (special)`). `vars` are the
/// row's free variables, with w read as x and y.
func classifySpecial(_ special: String, _ args: [Expr], _ vars: NameSet) throws -> MathObject {
  if vars.contains("z") { throw LanguageError("Use w (= x + iy) in \(special)(…); z is the 3D axis.") }
  if vars.contains("u") || vars.contains("v") { throw LanguageError("Cannot use u/v in \(special)(…).") }
  if special == "rgb" || special == "hsl" || special == "oklch" {
    let usage =
      special == "rgb"
      ? "rgb(red, green, blue, opacity?), each from 0 to 1"
      : special == "hsl"
        ? "hsl(hue in radians, saturation 0–1, lightness 0–1, opacity?)"
        : "oklch(lightness 0–1, chroma, hue in radians, opacity?)"
    if args.count != 3 && args.count != 4 {
      throw LanguageError("\(special) takes three channels and an optional opacity: \(usage).")
    }
    for channel in args {
      switch channel {
      case .ineq, .eq:
        throw LanguageError("\(special) channels must be real numbers, not comparisons: \(usage).")
      default: break
      }
      if try inferScalarType(channel) != .real {
        throw LanguageError("\(special) channels must be real numbers; use re, im, abs, or arg for complex values.")
      }
    }
    return .colorField(space: special, channels: args)
  }
  if special == "iter" {
    if args.count < 1 || args.count > 2 { throw LanguageError("iter takes iter(step) or iter(step, count).") }
    var maxIter = 250.0
    if args.count == 2 {
      do {
        maxIter = try evaluate(args[1], [:])
      } catch {
        throw LanguageError("The iteration count must be a plain number.")
      }
      if !maxIter.isFinite || maxIter < 1 { throw LanguageError("The iteration count must be at least 1.") }
      maxIter = JS.min([5000, JS.round(maxIter)])
    }
    _ = try inferScalarType(args[0], ["z": .complex])
    // The pixel enters either as a parameter (w/x/y in the step → seed 0,
    // the Mandelbrot convention) or as the seed (fixed map → Julia set).
    let bodyVars = freeVars(args[0])
    let seed = bodyVars.contains("w") || bodyVars.contains("x") || bodyVars.contains("y") ? "zero" : "pixel"
    return .fractal(step: args[0], seed: seed, maxIter: Int(maxIter))
  }
  if args.count != 1 { throw LanguageError("\(special) takes one argument.") }
  if try inferScalarType(args[0]) != .complex {
    throw LanguageError("\(special)(…) needs a complex expression — use w for x + iy.")
  }
  return .complexField(form: special == "domain" ? .domain : .conformal, expr: args[0])
}

/// A complex-valued expression in u: the path it traces (lib/plot.ts
/// `classifyLowered`, `if (complexPath)`).
func classifyComplexPath(_ expr: Expr) throws -> MathObject {
  // Sized before anything walks it: typing and splitting a huge inlined
  // composition would cost seconds just to learn it cannot be sampled.
  if exceedsNodes(expr, SPLIT_NODE_BUDGET) { throw LanguageError(splitTooLarge("This complex path", "sample")) }
  // An expression that mentions i but is real (|exp(i u)|) traces nothing
  // in the plane: it is a number for each u, and the row says so.
  if try inferScalarType(expr) != .complex {
    throw LanguageError(
      "This is a real number for each u, not a path — a complex path needs an imaginary part, "
        + "like exp(i 2 pi u); for a real curve write (u, …).")
  }
  return .complexPath(expr: expr)
}
