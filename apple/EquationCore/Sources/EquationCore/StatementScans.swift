/// A row's trailing `# note` and the color it may open with (lib/statements.ts
/// `noteStart`, `stripNote`, `noteColor`): what the highlighter and the
/// palette read of a row before any parsing.
///
/// Offsets are UTF-16, as in the TypeScript and in the editor's text storage.

/// Greek letters a name is written with (lib/expr.ts `GREEK_NAME_CHARS`).
/// The tokenizer's `greekNameChars` predates τ becoming an ordinary name, so
/// the row scanners keep their own class until it catches up.
@inline(__always) func isRowNameStart(_ u: UInt16) -> Bool { isNameStart(u) || u == 0x03C4 }
/// A name's later characters as written, subscript digits included (`WRITTEN_NAME_CHARS`).
@inline(__always) func isRowNameChar(_ u: UInt16) -> Bool { isWrittenName(u) || u == 0x03C4 }

/// Standalone glyphs: Σ ∑ Π ∏ ∫ ∞ ∇ π (lib/expr.ts `GLYPH_CHARS`).
func isRowGlyph(_ u: UInt16) -> Bool {
  switch u {
  case 0x03A3, 0x2211, 0x03A0, 0x220F, 0x222B, 0x221E, 0x2207, 0x03C0: true
  default: false
  }
}

/// Characters a value can end with, so a following `'` is a prime mark and
/// not the start of quoted text (`VALUE_END`): name characters, glyphs,
/// superscript exponents, and everything that closes or ends a value.
func isValueEnd(_ u: UInt16) -> Bool {
  if isRowNameChar(u) || isRowGlyph(u) || superscripts[u] != nil { return true }
  switch u {
  case 0x27, 0x29, 0x5D, 0x7D, 0x21: return true  // ' ) ] } !
  default: return false
  }
}

/// JavaScript's `trim`, as a range of the units.
func trimmedRange(_ u: [UInt16], _ range: Range<Int>? = nil) -> Range<Int> {
  var lo = range?.lowerBound ?? 0
  var hi = range?.upperBound ?? u.count
  while lo < hi, isJSWhitespace(u[lo]) { lo += 1 }
  while hi > lo, isJSWhitespace(u[hi - 1]) { hi -= 1 }
  return lo..<hi
}

/// Whether the row is a `#` comment row: a group heading, not a row with a note.
func isCommentRow(_ u: [UInt16]) -> Bool {
  u.first { !isJSWhitespace($0) } == 0x23
}

/// Where a row's trailing `# note` starts (`y = x^2 # parabola`), or -1. A
/// row that starts with `#` is a comment row and has none; a `#` in quoted
/// text (a file name, a column value) is data, not a note.
func noteOffset(_ u: [UInt16]) -> Int {
  if isCommentRow(u) { return -1 }
  var quote: UInt16 = 0
  for (k, c) in u.enumerated() {
    if quote != 0 {
      if c == quote { quote = 0 }
      continue
    }
    if c == 0x22 || (c == 0x27 && !(k > 0 && isValueEnd(u[k - 1]))) {
      quote = c
    } else if c == 0x23 {
      return k
    }
  }
  return -1
}

/// A row's color, when its note opens with a hex color glued to the `#`:
/// `y = x^2 #e24` or `y = x^2 #1f77b4 parabola`. The glue is what makes it a
/// color: `# fed` and `# 100 samples` stay plain notes. Channels in 0–1, or
/// nil for no (or a malformed) color.
public func noteColorRGB(_ text: String) -> SIMD3<Float>? {
  let u = Array(text.utf16)
  let at = noteOffset(u)
  if at < 0 { return nil }
  func hex(_ c: UInt16) -> Float? {
    switch c {
    case 0x30...0x39: Float(c - 0x30)
    case 0x41...0x46: Float(c - 0x41 + 10)
    case 0x61...0x66: Float(c - 0x61 + 10)
    default: nil
    }
  }
  // ^#([0-9a-f]{3}|[0-9a-f]{6})(?![\w]): three digits if a word doesn't go on, else six.
  var digits: [Float] = []
  var k = at + 1
  while k < u.count, digits.count < 7, let d = hex(u[k]) {
    digits.append(d)
    k += 1
  }
  func ends(_ count: Int) -> Bool {
    guard digits.count >= count else { return false }
    let next = at + 1 + count
    return next >= u.count || !(isASCIILetter(u[next]) || isDigit(u[next]) || u[next] == 0x5F)
  }
  if ends(3) {
    return SIMD3(digits[0] * 17, digits[1] * 17, digits[2] * 17) / 255
  }
  if ends(6) {
    return SIMD3(digits[0] * 16 + digits[1], digits[2] * 16 + digits[3], digits[4] * 16 + digits[5]) / 255
  }
  return nil
}
