#if canImport(Darwin)
  import Darwin
#elseif canImport(Glibc)
  import Glibc
#elseif canImport(Musl)
  import Musl
#elseif canImport(WASILibc)
  import WASILibc
#endif

/// Which constants are sliders, and how a drag writes one back (lib/slider.ts).
///
/// A constant is a slider when its right-hand side is a number the user
/// wrote, optionally held to a range or to whole numbers by the ordinary
/// functions that mean exactly that:
///
///     a = 0.4                        a slider over a default range
///     a = clamp(0.4, 0, 1)           over [0, 1]
///     n = round(5)                   in whole steps (floor and ceil too)
///     r = round(clamp(30, 0, 255))   whole steps over [0, 255]
///
/// The range is part of the row's text; a drag rewrites only the literal.
/// Offsets are UTF-16, into the right-hand side.
public struct SliderForm: Equatable, Sendable {
  /// The literal as written.
  public var literal: Double
  /// Where it sits in the right-hand side.
  public var start: Int
  public var end: Int
  /// Source text of the range's ends, when clamped, and the span of `lo, hi`
  /// within the right-hand side.
  public var bounds: Bounds?
  /// Steps by whole numbers (a rounding function wraps the literal).
  public var whole: Bool

  public struct Bounds: Equatable, Sendable {
    public var lo: String
    public var hi: String
    public var start: Int
    public var end: Int
  }
}

/// /^\s*-?(\d+\.?\d*|\.\d+)\s*$/ — a plain number, with no exponent form: the
/// grammar has no scientific notation (lib/drag.ts `SLIDER_NUM_RE`).
func isSliderNumber(_ text: ArraySlice<UInt16>) -> Bool {
  var s = jsTrimEnd(jsTrimStart(text))
  if s.first == 0x2D { s = s.dropFirst() }
  let whole = s.prefix(while: isDigit)
  var rest = s.dropFirst(whole.count)
  if whole.isEmpty {
    guard rest.first == 0x2E else { return false }
    rest = rest.dropFirst()
    return !rest.isEmpty && rest.allSatisfy(isDigit)
  }
  if rest.first == 0x2E { rest = rest.dropFirst() }
  return rest.allSatisfy(isDigit)
}

private func opens(_ c: UInt16) -> Bool { c == 0x28 || c == 0x5B || c == 0x7B }
private func closes(_ c: UInt16) -> Bool { c == 0x29 || c == 0x5D || c == 0x7D }

/// `name( … )` around the whole of text[from, to), or nil. Returns the inner span.
private func callSpan(_ text: Units, _ from: Int, _ to: Int, _ name: String) -> (Int, Int)? {
  // ^\s*name\s*\(
  var k = from
  while k < to, isJSWhitespace(text[k]) { k += 1 }
  let word = Array(name.utf16)
  guard k + word.count <= to, Array(text[k..<(k + word.count)]) == word else { return nil }
  k += word.count
  while k < to, isJSWhitespace(text[k]) { k += 1 }
  guard k < to, text[k] == 0x28 else { return nil }
  let open = k
  var close = to
  while close > from, isJSWhitespace(text[close - 1]) { close -= 1 }
  guard close > 0, text[close - 1] == 0x29 else { return nil }
  // The parenthesis opened by the head must be the one closing the span.
  var depth = 0
  var j = open
  while j < close {
    if opens(text[j]) {
      depth += 1
    } else if closes(text[j]) {
      depth -= 1
      if depth == 0 && j != close - 1 { return nil }
    }
    j += 1
  }
  return (open + 1, close - 1)
}

/// Top-level comma positions in text[from, to).
private func commas(_ text: Units, _ from: Int, _ to: Int) -> [Int] {
  var out: [Int] = []
  var depth = 0
  var k = from
  while k < to {
    let c = text[k]
    if opens(c) {
      depth += 1
    } else if closes(c) {
      depth -= 1
    } else if c == 0x2C && depth == 0 {
      out.append(k)
    }
    k += 1
  }
  return out
}

/// The slider a constant's right-hand side makes, or nil. `userFns` are the
/// document's own functions: one named clamp or round is not the builtin.
public func sliderForm(_ rhs: String, userFns: Set<String> = []) -> SliderForm? {
  let text = Array(rhs.utf16)
  var whole = false
  var bounds: SliderForm.Bounds?
  func read(_ from: Int, _ to: Int) -> SliderForm? {
    guard from <= to else { return nil }
    let slice = text[from..<to]
    if isSliderNumber(slice) {
      let start = from + (slice.count - jsTrimStart(slice).count)
      let end = from + jsTrimEnd(slice).count
      return SliderForm(
        literal: JS.number(String(text[start..<end])), start: start, end: end, bounds: bounds, whole: whole)
    }
    for fn in ["round", "floor", "ceil"] where !whole && !userFns.contains(fn) {
      if let inner = callSpan(text, from, to, fn) {
        whole = true
        return read(inner.0, inner.1)
      }
    }
    guard bounds == nil, !userFns.contains("clamp"), let inner = callSpan(text, from, to, "clamp") else { return nil }
    let at = commas(text, inner.0, inner.1)
    guard at.count == 2 else { return nil }
    let found = SliderForm.Bounds(
      lo: jsTrimmed(String(text[(at[0] + 1)..<at[1]])),
      hi: jsTrimmed(String(text[(at[1] + 1)..<inner.1])),
      start: at[0] + 1,
      end: inner.1)
    bounds = found
    if found.lo.isEmpty || found.hi.isEmpty { return nil }
    return read(inner.0, at[0])
  }
  return read(0, text.count)
}

/// The right-hand side with the literal replaced by `value` (already formatted).
public func writeSlider(_ rhs: String, _ form: SliderForm, _ value: String) -> String {
  let text = Array(rhs.utf16)
  return String(text[..<form.start]) + value + String(text[form.end...])
}

/// The range's ends at these values, or nil when either end is not a number
/// or they are out of order.
/// `valueNames` are the document's shadowed names: a bound may read a redefined `pi`.
public func sliderBounds(
  _ form: SliderForm, _ env: [String: Double], userFns: Set<String> = [], valueNames: Set<String> = []
) -> (Double, Double)? {
  guard let bounds = form.bounds else { return nil }
  guard let lo = try? evaluate(try parseExpr(bounds.lo, userFns: userFns, valueNames: valueNames), env),
    let hi = try? evaluate(try parseExpr(bounds.hi, userFns: userFns, valueNames: valueNames), env)
  else { return nil }
  return lo.isFinite && hi.isFinite && lo < hi ? (lo, hi) : nil
}

/// `v` as this slider can hold it: within its range, and whole if it steps so.
public func sliderValue(_ form: SliderForm, _ v: Double, _ bounds: (Double, Double)?) -> Double {
  var v = v
  if let (lo, hi) = bounds { v = JS.min([JS.max([v, lo]), hi]) }
  return form.whole ? JS.round(v) : v
}

/// A slider's value as its row writes it: six significant digits (web/main.ts `fmtNum`).
func formatSliderNumber(_ v: Double) -> String {
  JS.string(JS.number(JS.toPrecision(v, 6)))
}

/// A "nice" spacing (1, 2, or 5 × 10^k) at least `minPx` pixels apart, and
/// the finer one that divides it (web/render2d.ts `niceSpacing`): a grid's
/// lines, and a slider's step.
public func niceSpacing(_ upp: Double, _ minPx: Double) -> (major: Double, minor: Double) {
  let target = upp * minPx
  let base = JS.pow(10, log10(target).rounded(.down))
  for (m, div) in [(1.0, 5.0), (2, 4), (5, 5), (10, 5)] where m * base >= target {
    return (m * base, m * base / div)
  }
  return (10 * base, 2 * base)
}
