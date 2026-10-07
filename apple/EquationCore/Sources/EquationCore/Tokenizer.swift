/// Tokens and the token passes ahead of the shunting-yard parser
/// (lib/lang/tokenizer.ts and the token passes of lib/expr.ts).
///
/// Positions are UTF-16 offsets, as in the TypeScript: whether two tokens
/// touch (`2x` versus `2 x`) decides how they multiply, so both
/// implementations have to count the same way.

enum TokenType: Sendable {
  case parenopen, parenclose, number, superscript, bar, whitespace, glyph, symbol, string, `operator`
}

struct Token: Sendable {
  var type: TokenType
  var str: String
  var loc: (Int, Int)
  /// Marks a parenopen that is a function-call argument list.
  var call = false
}

/// What parseExpr throws: the message is the one the TypeScript gives, word for word.
public struct ParseError: Error, Equatable, Sendable {
  public var message: String
  /// Whether the TypeScript throws its `ParseError` class here rather than a plain `Error`.
  public var isParseError: Bool

  init(_ message: String, parse: Bool = false) {
    self.message = message
    self.isParseError = parse
  }
}

// MARK: - Character classes

/// Greek letters are ordinary name characters (θ, Δx), except the glyphs
/// that stand for something by themselves (π τ Σ Π), which tokenize alone.
let greekNameChars: Set<UInt16> = Set("αβγδεζηθικλμνξορςσυφχψωΑΒΓΔΕΖΗΘΙΚΛΜΝΞΟΡΤΥΦΧΨΩϑϕϖϱϵµ".utf16)

/// Standalone glyphs and the names they mean.
let glyphAliases: [UInt16: String] = [
  0x03A3: "sum",  // Σ
  0x2211: "sum",  // ∑
  0x03A0: "prod",  // Π
  0x220F: "prod",  // ∏
  0x222B: "int",  // ∫
  0x221E: "inf",  // ∞
  0x2207: "grad",  // ∇
  0x03C0: "pi",  // π
  0x03C4: "tau",  // τ
]

let superscripts: [UInt16: String] = [
  0x2070: "0", 0x00B9: "1", 0x00B2: "2", 0x00B3: "3", 0x2074: "4",
  0x2075: "5", 0x2076: "6", 0x2077: "7", 0x2078: "8", 0x2079: "9", 0x207B: "-",
]

@inline(__always) func isDigit(_ u: UInt16) -> Bool { u >= 0x30 && u <= 0x39 }
@inline(__always) func isSubscriptDigit(_ u: UInt16) -> Bool { u >= 0x2080 && u <= 0x2089 }
@inline(__always) func isASCIILetter(_ u: UInt16) -> Bool { (u >= 0x41 && u <= 0x5A) || (u >= 0x61 && u <= 0x7A) }

func isNameStart(_ u: UInt16) -> Bool { isASCIILetter(u) || u == 0x5F || greekNameChars.contains(u) }
func isWrittenName(_ u: UInt16) -> Bool { isNameStart(u) || isDigit(u) || isSubscriptDigit(u) }

/// JavaScript's `\s`.
func isJSWhitespace(_ u: UInt16) -> Bool {
  switch u {
  case 0x09...0x0D, 0x20, 0xA0, 0x1680, 0x2000...0x200A, 0x2028, 0x2029, 0x202F, 0x205F, 0x3000, 0xFEFF: true
  default: false
  }
}

// MARK: - Patterns

private let quote: UInt16 = 0x22, apostrophe: UInt16 = 0x27, dot: UInt16 = 0x2E

private func matches(_ type: TokenType, _ s: ArraySlice<UInt16>) -> Bool {
  let first = s.first!
  switch type {
  case .parenopen: return s.count == 1 && (first == 0x28 || first == 0x7B || first == 0x5B)
  case .parenclose: return s.count == 1 && (first == 0x29 || first == 0x7D || first == 0x5D)
  case .number:  // ^\d+\.?\d*$
    var i = s.startIndex
    while i < s.endIndex, isDigit(s[i]) { i += 1 }
    if i == s.startIndex { return false }
    if i < s.endIndex, s[i] == dot { i += 1 }
    while i < s.endIndex, isDigit(s[i]) { i += 1 }
    return i == s.endIndex
  case .superscript: return s.allSatisfy { superscripts[$0] != nil }
  case .bar: return s.count == 1 && first == 0x7C
  case .whitespace: return isJSWhitespace(s.last!)
  case .glyph: return s.count == 1 && glyphAliases[first] != nil
  case .symbol:  // ^[start][written]*'*$
    guard isNameStart(first) else { return false }
    var i = s.index(after: s.startIndex)
    while i < s.endIndex, isWrittenName(s[i]) { i += 1 }
    while i < s.endIndex, s[i] == apostrophe { i += 1 }
    return i == s.endIndex
  case .string:  // ^("[^"]*"?|'[^']*'?)$
    guard first == quote || first == apostrophe else { return false }
    let body = s.dropFirst()
    guard let close = body.firstIndex(of: first) else { return true }
    return close == body.index(before: body.endIndex)
  case .operator:
    let str = String(decoding: s, as: UTF16.self)
    return operatorTable[str] != nil || multiCharOps.contains { $0.hasPrefix(str) }
  }
}

private let classifyOrder: [TokenType] = [
  .parenopen, .parenclose, .number, .superscript, .bar, .whitespace, .glyph, .symbol, .string, .operator,
]

/// JSON.stringify of a one-code-unit string, as the invalid-character message spells it.
private func jsonQuote(_ u: UInt16) -> String {
  let hex = { (u: UInt16) in
    let h = String(u, radix: 16)
    return String(repeating: "0", count: 4 - h.count) + h
  }
  switch u {
  case 0x22: return "\"\\\"\""
  case 0x5C: return "\"\\\\\""
  case 0x08: return "\"\\b\""
  case 0x09: return "\"\\t\""
  case 0x0A: return "\"\\n\""
  case 0x0C: return "\"\\f\""
  case 0x0D: return "\"\\r\""
  case 0..<0x20, 0xD800...0xDFFF: return "\"\\u\(hex(u))\""
  default: return "\"" + String(decoding: [u], as: UTF16.self) + "\""
  }
}

private func classify(_ u: UInt16) throws(ParseError) -> TokenType {
  if let type = classifyOrder.first(where: { matches($0, [u][...]) }) { return type }
  if u == 0x5C {
    throw ParseError(
      "Invalid character: \"\\\". Write the symbol itself (π, θ, ∇, …)"
        + " — in the editor, typing \\pi, \\theta or \\nabla inserts it.")
  }
  if u == 0x2208 { throw ParseError("∈ draws a name from a list on a row of its own, like p ∈ A.") }
  throw ParseError("Invalid character: \(jsonQuote(u)).")
}

// MARK: - Tokenize and desugar

/// The subscript digits of a name are the `_` subscript: T₀ is T_0, θ₁₂ is θ_12.
public func canonicalName(_ name: String) -> String {
  var out = ""
  var inRun = false
  for scalar in name.unicodeScalars {
    let v = scalar.value
    if v >= 0x2080 && v <= 0x2089 {
      if !inRun { out.append("_") }
      inRun = true
      out.unicodeScalars.append(Unicode.Scalar(v - 0x2080 + 0x30)!)
    } else {
      inRun = false
      out.unicodeScalars.append(scalar)
    }
  }
  return out
}

/// Split into tokens, lowering unicode sugar as each one is read (glyphs to
/// names, subscripts to `_`, superscripts to `^ n`), so the first bad
/// character or exponent is the one reported, as in the lazy TypeScript.
func tokenize(_ text: String) throws(ParseError) -> [Token] {
  let units = Array(text.utf16)
  guard !units.isEmpty else { return [] }
  var out: [Token] = []

  func emit(_ range: Range<Int>, _ type: TokenType) throws(ParseError) {
    let str = String(decoding: units[range], as: UTF16.self)
    let loc = (range.lowerBound, range.upperBound)
    switch type {
    case .glyph:
      out.append(Token(type: .symbol, str: glyphAliases[units[range.lowerBound]]!, loc: loc))
    case .symbol where units[range].contains(where: isSubscriptDigit):
      out.append(Token(type: .symbol, str: canonicalName(str), loc: loc))
    case .superscript:
      let digits = units[range].map { superscripts[$0]! }.joined()
      let body = digits.hasPrefix("-") ? digits.dropFirst() : Substring(digits)
      guard !body.isEmpty, body.utf16.allSatisfy(isDigit) else {
        throw ParseError("Cannot read the exponent \(str).")
      }
      out.append(Token(type: .operator, str: "^", loc: loc))
      if digits.hasPrefix("-") { out.append(Token(type: .operator, str: "-", loc: loc)) }
      out.append(Token(type: .number, str: String(body), loc: loc))
    default:
      out.append(Token(type: type, str: str, loc: loc))
    }
  }

  var start = 0
  var type = try classify(units[0])
  for i in 1..<units.count where !matches(type, units[start...i]) {
    try emit(start..<i, type)
    type = try classify(units[i])
    start = i
  }
  try emit(start..<units.count, type)
  return out
}

private func op(_ str: String) -> Token { Token(type: .operator, str: str, loc: (-1, -1)) }

/// Settle what a '.' means: the greedy number match takes "1." out of
/// `1..N`, so the dot rejoins into ".."; a '.' with no value before it and a
/// number after it is a decimal (`.5`); any other is column access.
func normalizeTokens(_ bare: [Token]) -> [Token] {
  var out: [Token] = []
  var held: Token?
  var dotToken: Token?
  var afterValue = false
  func ends(_ t: Token) -> Bool {
    t.type == .number || t.type == .symbol || t.type == .parenclose || t.type == .string
      || (t.type == .operator && t.str == "!")
  }
  for var token in bare {
    if let h = held {
      if token.type == .operator && token.str.hasPrefix(".") {
        var trimmed = h
        trimmed.str.removeLast()
        out.append(trimmed)
        token.str = "." + token.str
      } else {
        out.append(h)
      }
      afterValue = true
      held = nil
    }
    if let d = dotToken {
      if !afterValue && token.type == .number {
        token.str = "0." + token.str
        dotToken = nil
        if token.str.hasSuffix(".") {
          held = token
          continue
        }
        out.append(token)
        afterValue = true
        continue
      }
      out.append(d)
      afterValue = false
      dotToken = nil
    }
    if token.type == .number && token.str.hasSuffix(".") {
      held = token
      continue
    }
    if token.type == .operator && token.str == "." {
      dotToken = token
      continue
    }
    out.append(token)
    afterValue = ends(token)
  }
  if let h = held { out.append(h) }
  if let d = dotToken { out.append(d) }
  return out
}

/// `T_{c}` is the name T_c and `a_{10}` is a_10: a single name or whole
/// number in braces after `_` (`a_{n+1}` stays an index).
func mergeBracedSubscripts(_ all: [Token]) -> [Token] {
  var out: [Token] = []
  func skip(_ k: Int) -> Int {
    var k = k
    while k < all.count, all[k].type == .whitespace { k += 1 }
    return k
  }
  var i = 0
  while i < all.count {
    let token = all[i]
    if token.type == .symbol, token.str.hasSuffix("_"), i + 1 < all.count, all[i + 1].type == .parenopen,
      all[i + 1].str == "{"
    {
      let at = skip(i + 2)
      if at < all.count {
        let inner = all[at]
        let close = skip(at + 1)
        if inner.type == .symbol || (inner.type == .number && inner.str.utf16.allSatisfy(isDigit)),
          close < all.count, all[close].type == .parenclose, all[close].str == "}"
        {
          out.append(Token(type: token.type, str: token.str + inner.str, loc: (token.loc.0, all[close].loc.1)))
          i = close + 1
          continue
        }
      }
    }
    out.append(token)
    i += 1
  }
  return out
}

/// `[]` is the empty multiset: the pair arrives as one symbol no one can type.
let emptyList = "[]"

func mergeEmptyBrackets(_ tokens: [Token]) -> [Token] {
  var out: [Token] = []
  var open: Token?
  for token in tokens {
    if let o = open {
      if token.type == .whitespace { continue }
      if token.type == .parenclose && token.str == "]" {
        out.append(Token(type: .symbol, str: emptyList, loc: (o.loc.0, token.loc.1)))
        open = nil
        continue
      }
      out.append(o)
      open = nil
    }
    if token.type == .parenopen && token.str == "[" { open = token } else { out.append(token) }
  }
  if let o = open { out.append(o) }
  return out
}

extension ParseContext {
  /// Insert implicit multiplication (2x, x(x+1), x y) and function
  /// application, and rewrite unary minus to the [neg] prefix. Touching
  /// factors get [impl], which binds tighter than '/'; spaced factors get
  /// [spaced], which ranks with it — except in a Leibniz operand.
  func addImplicitTokens(_ bare: [Token]) -> [Token] {
    var out: [Token] = []
    var last: Token?
    /// The dotted name ending at `last` when it is a symbol: `person.age`.
    var path: String?
    var barDepth = 0
    /// What each open bracket is: the function it calls, an index, or nil.
    var opened: [String?] = []
    /// What the bracket `last` closed was.
    var closed: String?
    /// Bracket depths where a Leibniz head (`d/dx`) is taking its operand.
    var leibniz: [Int] = []
    var recent: [String] = []

    for token in bare {
      if token.type == .whitespace { continue }
      while let top = leibniz.last, top > opened.count { leibniz.removeLast() }
      let inLeibniz = leibniz.last == opened.count

      let afterValue: Bool
      if let last {
        let afterPostfix = last.type == .operator && last.str == "!"
        afterValue =
          last.type == .number || last.type == .symbol || last.type == .parenclose || last.type == .string
          || afterPostfix
      } else {
        afterValue = false
      }

      if token.type == .bar {
        // |x| is abs(x): a bar after a value closes the innermost open bar.
        if barDepth > 0 && afterValue {
          barDepth -= 1
          var close = token
          close.type = .parenclose
          close.str = ")"
          out.append(close)
          last = close
          closed = opened.popLast() ?? nil
        } else {
          barDepth += 1
          if afterValue { out.append(op(inLeibniz || last!.loc.1 == token.loc.0 ? "[impl]" : "[spaced]")) }
          var abs = token
          abs.type = .symbol
          abs.str = "abs"
          out.append(abs)
          out.append(op("[apply]"))
          var open = token
          open.type = .parenopen
          open.str = "("
          open.call = true
          out.append(open)
          last = open
          opened.append("abs")
        }
        path = nil
        continue
      }

      if token.type == .operator && (token.str == "-" || token.str == "−" || token.str == "+") && !afterValue {
        if token.str != "+" { out.append(op("[neg]")) }
        last = token
        path = nil
        continue
      }

      var emit = token
      var indexing = false
      if afterValue, let prev = last,
        token.type == .number || token.type == .symbol || token.type == .parenopen || token.type == .string
      {
        let touching = prev.loc.1 == token.loc.0
        let isIndex: Bool
        if token.type != .parenopen {
          isIndex = false
        } else if prev.type == .symbol {
          isIndex =
            token.str == "["
            ? touching && indexes(path ?? prev.str)
            : prev.str.hasSuffix("_") && listNames.contains(prev.str)
        } else {
          isIndex =
            token.str == "[" && touching && prev.type == .parenclose && (closed == "sort" || closed == "[list]")
        }
        let isFnCall =
          !isIndex && !(path?.contains(".") ?? false) && token.type == .parenopen && prev.type == .symbol
          && isFnName(prev.str)
        indexing = isIndex
        out.append(op(isFnCall ? "[apply]" : isIndex ? "[at]" : inLeibniz || touching ? "[impl]" : "[spaced]"))
        if isFnCall { emit.call = true }
      }

      let afterDot = last?.type == .operator && last?.str == "."
      if emit.type == .parenopen {
        opened.append(
          emit.call ? (builtinFn(last!.str) ?? last!.str) : indexing ? "[at]" : emit.str == "[" ? "[list]" : nil)
      }
      closed = emit.type == .parenclose ? (opened.popLast() ?? nil) : nil
      if inLeibniz && emit.type == .operator && emit.str != "^" && emit.str != "!" && emit.str != "." {
        leibniz.removeLast()
      }
      if emit.type == .symbol && isLeibnizVariable(emit.str) && endsLeibnizHead(recent) {
        leibniz.append(opened.count)
      }
      recent.append(emit.str)
      if recent.count > 4 { recent.removeFirst() }
      out.append(emit)
      last = emit
      if emit.type == .symbol {
        path = afterDot && path != nil ? "\(path!).\(emit.str)" : emit.str
      } else if !(emit.type == .operator && emit.str == ".") {
        path = nil
      }
    }
    return out
  }
}

/// /^d[A-Za-z]$/
private func isLeibnizVariable(_ s: String) -> Bool {
  let u = Array(s.utf16)
  return u.count == 2 && u[0] == 0x64 && isASCIILetter(u[1])
}

/// Whether the last few tokens, space-joined, match /(^| )d( \^ \d+)? \/$/.
private func endsLeibnizHead(_ recent: [String]) -> Bool {
  let u = Array(recent.joined(separator: " ").utf16)
  guard u.count >= 3, u[u.count - 2] == 0x20, u[u.count - 1] == 0x2F else { return false }
  let head = u[..<(u.count - 2)]
  func endsWithD(_ h: ArraySlice<UInt16>) -> Bool {
    h.last == 0x64 && (h.count == 1 || h[h.endIndex - 2] == 0x20)
  }
  if endsWithD(head) { return true }
  // An order, `d ^ 2 /`.
  var k = head.endIndex
  while k > head.startIndex, isDigit(head[k - 1]) { k -= 1 }
  guard k < head.endIndex, k - head.startIndex >= 3 else { return false }
  return head[k - 3] == 0x20 && head[k - 2] == 0x5E && head[k - 1] == 0x20 && endsWithD(head[..<(k - 3)])
}
