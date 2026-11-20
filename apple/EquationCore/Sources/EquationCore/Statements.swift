/// The statement-list text format (lib/statements.ts): how text splits into
/// rows, and where a row's trailing `# note` starts.
///
/// Offsets are UTF-16, as the TypeScript's are: the editor and the site
/// count a row's characters the same way.

/// A row's text as UTF-16 code units, which is what every offset in the
/// TypeScript counts and what its regular expressions scan.
typealias Units = [UInt16]

extension String {
  init(_ units: ArraySlice<UInt16>) { self.init(decoding: units, as: UTF16.self) }
  init(_ units: Units) { self.init(decoding: units, as: UTF16.self) }
}

/// The ASCII code unit of a character literal.
@inline(__always) func unit(_ c: Unicode.Scalar) -> UInt16 { UInt16(c.value) }

/// JavaScript's `trim`, `trimStart` and `trimEnd`.
func jsTrimStart(_ u: ArraySlice<UInt16>) -> ArraySlice<UInt16> {
  var s = u
  while let first = s.first, isJSWhitespace(first) { s = s.dropFirst() }
  return s
}

func jsTrimEnd(_ u: ArraySlice<UInt16>) -> ArraySlice<UInt16> {
  var s = u
  while let last = s.last, isJSWhitespace(last) { s = s.dropLast() }
  return s
}

func jsTrimmed(_ text: String) -> String {
  let u = Array(text.utf16)
  return String(jsTrimEnd(jsTrimStart(u[...])))
}

/// Characters a value can end with, so a following `'` is a prime mark:
/// written name characters, constant/operator glyphs, superscript exponents,
/// and everything that closes or ends a value (lib/statements.ts `VALUE_END`).
func endsValue(_ u: UInt16) -> Bool {
  isWrittenName(u) || glyphAliases[u] != nil || superscripts[u] != nil || u == 0x27 || u == 0x29 || u == 0x5D
    || u == 0x7D || u == 0x21
}

/// Statements separate on newlines or `;`, but only at bracket depth zero and
/// outside quoted text; a newline swallowed inside brackets becomes a space.
/// Total: half-typed, unparseable text still splits.
public func splitStatements(_ text: String) -> [String] {
  var parts: [String] = []
  var depth = 0
  var cur: Units = []
  var quote: UInt16?
  var prev: UInt16 = 0
  // \r\n and a lone \r are both a newline.
  var units: Units = []
  let raw = Array(text.utf16)
  var k = 0
  while k < raw.count {
    if raw[k] == 0x0D {
      units.append(0x0A)
      if k + 1 < raw.count, raw[k + 1] == 0x0A { k += 1 }
    } else {
      units.append(raw[k])
    }
    k += 1
  }
  for ch in units {
    let wasPrev = prev
    prev = ch
    if ch == 0x0A {
      if quote != nil { depth = 0 }
      quote = nil
    } else if let q = quote {
      if ch == q { quote = nil }
      cur.append(ch)
      continue
    } else if ch == 0x22 || (ch == 0x27 && !(wasPrev != 0 && endsValue(wasPrev))) {
      quote = ch
    } else if ch == 0x28 || ch == 0x5B || ch == 0x7B {
      depth += 1
    } else if ch == 0x29 || ch == 0x5D || ch == 0x7D {
      depth = max(0, depth - 1)
    }
    if (ch == 0x0A || ch == 0x3B) && depth == 0 {
      parts.append(String(cur))
      cur = []
    } else {
      cur.append(ch == 0x0A ? 0x20 : ch)
    }
  }
  parts.append(String(cur))
  return parts
}

/// Where a row's trailing `# note` starts (`y = x^2 # parabola`), as a UTF-16
/// offset, or nil. A row that starts with `#` is a comment row, not a row
/// with a note; a `#` in quoted text is data.
public func noteStart(_ text: String) -> Int? {
  noteStart(Array(text.utf16))
}

func noteStart(_ u: Units) -> Int? {
  if jsTrimStart(u[...]).first == 0x23 { return nil }
  var quote: UInt16?
  for (k, c) in u.enumerated() {
    if let q = quote {
      if c == q { quote = nil }
      continue
    }
    if c == 0x22 || (c == 0x27 && !(k > 0 && endsValue(u[k - 1]))) {
      quote = c
    } else if c == 0x23 {
      return k
    }
  }
  return nil
}

/// A row's math, without its trailing `# note`.
public func stripNote(_ text: String) -> String {
  let u = Array(text.utf16)
  guard let at = noteStart(u) else { return text }
  return String(jsTrimEnd(u[..<at]))
}

/// A row's color, when its note opens with a hex color glued to the `#`
/// (`y = x^2 #e24`), as channels in 0–1; nil for no (or a malformed) color.
public func noteColor(_ text: String) -> [Double]? {
  let u = Array(text.utf16)
  guard let at = noteStart(u) else { return nil }
  func hexValue(_ c: UInt16) -> Int? {
    switch c {
    case 0x30...0x39: Int(c) - 0x30
    case 0x41...0x46: Int(c) - 0x41 + 10
    case 0x61...0x66: Int(c) - 0x61 + 10
    default: nil
    }
  }
  // ^#([0-9a-f]{3}|[0-9a-f]{6})(?![\w]), ignoring case: three is tried first.
  func word(_ c: UInt16) -> Bool { isASCIILetter(c) || isDigit(c) || c == 0x5F }
  for length in [3, 6] {
    let end = at + 1 + length
    guard end <= u.count else { continue }
    let digits = u[(at + 1)..<end].compactMap(hexValue)
    guard digits.count == length, !(end < u.count && word(u[end])) else { continue }
    let wide = length == 3 ? digits.flatMap { [$0, $0] } : digits
    return [0, 2, 4].map { Double(wide[$0] * 16 + wide[$0 + 1]) / 255 }
  }
  return nil
}

/// `code` with `old`'s trailing note carried over, for writers that rebuild a
/// row's math (a slider drag) and must not drop the note.
public func keepNote(_ old: String, _ code: String) -> String {
  let u = Array(old.utf16)
  guard let at = noteStart(u) else { return code }
  return "\(code) \(String(u[at...]))"
}
