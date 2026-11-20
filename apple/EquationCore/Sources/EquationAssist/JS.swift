import Foundation

/// JavaScript's string operations where Swift's own differ, so the lookups
/// (Lookups.swift) give lib/assistant-tools.ts's answers to the character: a
/// Swift String compares by canonical equivalence and trims and folds case
/// by other tables.
enum JS {
  /// `\s` in a regular expression, and what `trim` removes.
  static func isSpace(_ c: Unicode.Scalar) -> Bool {
    switch c.value {
    case 0x09...0x0D, 0x20, 0xA0, 0x1680, 0x2000...0x200A, 0x2028, 0x2029, 0x202F, 0x205F, 0x3000, 0xFEFF: true
    default: false
    }
  }

  /// What `.` in a regular expression doesn't match.
  static func isLineEnd(_ c: Unicode.Scalar) -> Bool {
    c == "\n" || c == "\r" || c.value == 0x2028 || c.value == 0x2029
  }

  /// `\p{L}`.
  static func isLetter(_ c: Unicode.Scalar) -> Bool {
    switch c.properties.generalCategory {
    case .uppercaseLetter, .lowercaseLetter, .titlecaseLetter, .modifierLetter, .otherLetter: true
    default: false
    }
  }

  /// `\p{N}`.
  static func isNumber(_ c: Unicode.Scalar) -> Bool {
    switch c.properties.generalCategory {
    case .decimalNumber, .letterNumber, .otherNumber: true
    default: false
    }
  }

  static func string(_ scalars: some Sequence<Unicode.Scalar>) -> String {
    var view = String.UnicodeScalarView()
    view.append(contentsOf: scalars)
    return String(view)
  }

  /// `s.trim()`.
  static func trim(_ s: String) -> String {
    var scalars = Substring(s).unicodeScalars
    while let first = scalars.first, isSpace(first) { scalars.removeFirst() }
    while let last = scalars.last, isSpace(last) { scalars.removeLast() }
    return String(scalars)
  }

  /// `s.replace(/\s+/g, ' ')`.
  static func collapseSpaces(_ s: String) -> String {
    var out: [Unicode.Scalar] = []
    var inSpace = false
    for c in s.unicodeScalars {
      if isSpace(c) {
        if !inSpace { out.append(" ") }
        inSpace = true
      } else {
        out.append(c)
        inSpace = false
      }
    }
    return string(out)
  }

  /// `s.toLowerCase()`: Foundation's folding, which like JavaScript's reads a
  /// final sigma as one (Swift's own `lowercased()` doesn't).
  static func lower(_ s: String) -> String { (s as NSString).lowercased }

  /// `a === b`: the same code points, where Swift's `==` also takes a
  /// composed letter for its decomposed spelling.
  static func same(_ a: String, _ b: String) -> Bool { a.unicodeScalars.elementsEqual(b.unicodeScalars) }

  /// `a.startsWith(b)`.
  static func starts(_ a: String, with b: String) -> Bool { a.unicodeScalars.starts(with: b.unicodeScalars) }

  /// `JSON.stringify(s)`.
  static func stringify(_ s: String) -> String {
    var out = "\""
    for c in s.unicodeScalars {
      switch c {
      case "\"": out += "\\\""
      case "\\": out += "\\\\"
      case "\u{08}": out += "\\b"
      case "\u{0C}": out += "\\f"
      case "\n": out += "\\n"
      case "\r": out += "\\r"
      case "\t": out += "\\t"
      default:
        if c.value < 0x20 {
          let hex = String(c.value, radix: 16)
          out += "\\u" + String(repeating: "0", count: 4 - hex.count) + hex
        } else {
          out.unicodeScalars.append(c)
        }
      }
    }
    return out + "\""
  }

  /// `JSON.stringify(list)`.
  static func stringify(_ list: [String]) -> String { "[" + list.map(stringify).joined(separator: ",") + "]" }
}

/// A string as a dictionary key that only its own code points match: what a
/// JavaScript object's key or a Set's member is.
struct Exact: Hashable {
  var units: [UInt16]
  init(_ s: String) { units = Array(s.utf16) }
}

func exact<Value>(_ table: [String: Value]) -> [Exact: Value] {
  Dictionary(table.map { (Exact($0.key), $0.value) }, uniquingKeysWith: { first, _ in first })
}
