import EquationCore
import Foundation

/// A fragment shader with the loop helpers it names declared, and the
/// coefficient tables those helpers read: the part of web/gl.ts
/// `compileProgram` between a renderer's source and the compiler.
///
/// The language declares a helper (`eq_loop_<hash>`: a recursive function, a
/// Fourier sum) as it compiles a row (EquationCore `declareHelper`), and a
/// shader only names it; `withHelpers` splices the declarations in after the
/// prelude.
struct LinkedShader {
  var source: String
  /// Each `uniform vec4 <name>[N]` table's floats, uploaded once with the program.
  var tables: [(name: String, values: [Float])] = []
}

private nonisolated(unsafe) let uniformIdentifier = try! Regex(#"\bu_(\w+)"#)

/// Link a fragment shader's helpers. `tableBudget` is how many vec4 slots its
/// tables may take as uniforms before they are written into the source as
/// constants (the site asks the device: MAX_FRAGMENT_UNIFORM_VECTORS less the
/// shader's own). The 2D passes read uniforms from a buffer of floats that is
/// as long as it needs to be, so there a table is always a uniform.
///
/// A helper takes every constant its body reads as a parameter named for the
/// constant's uniform (`float u_a`), which in GLSL shadows the uniform. The
/// 2D translator makes a uniform a macro (GLSL.swift), which a parameter
/// cannot shadow, so the names in the helpers' declarations are respelled
/// (`eqv_a`): a helper reads nothing but its parameters and its own table.
func linkHelpers(_ fragment: String, tableBudget: Double = .infinity) throws -> LinkedShader {
  guard fragment.contains("eq_loop_") else { return LinkedShader(source: fragment) }
  let linked = try withHelpers(fragment, tableBudget: tableBudget)
  let tables = tableBudget == .infinity ? shaderTables(linked) : []
  // The declarations are what was spliced in after the prelude.
  guard let prelude = linked.range(of: glslPrelude) else { return LinkedShader(source: linked, tables: tables) }
  let added = linked.utf8.count - fragment.utf8.count
  let start = prelude.upperBound
  guard added > 0, let end = linked.utf8.index(start, offsetBy: added, limitedBy: linked.utf8.endIndex) else {
    return LinkedShader(source: linked, tables: tables)
  }
  let declarations = linked[start..<end].replacing(uniformIdentifier) { "eqv_\($0.output[1].substring ?? "")" }
  return LinkedShader(source: String(linked[..<start]) + declarations + String(linked[end...]), tables: tables)
}
