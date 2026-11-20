import Foundation

/// A GLSL program — the vertex and fragment shaders web/render3d.ts writes —
/// as Metal. GLSL.swift's way, taken as far as the 3D renderer needs: each
/// stage's source becomes the body of a struct whose methods are the
/// shader's functions and whose fields are everything GLSL has as globals,
/// so the body itself is left as the site wrote it.
///
/// - `uniform` float, vec2–4, mat4, bool, int and ivec2–3 become fields read
///   from one float buffer both stages share (`slots` says where), filled in
///   before `main` runs. Fields, not macros: a shader may name a local after
///   a uniform (`float t = …` in a march).
/// - `uniform sampler2D` becomes a texture argument, in the order declared.
///   One whose name has `Depth` in it is a depth texture. `texture` reads
///   it with y counted up from the bottom, as GL stores a target it drew.
/// - A vertex shader's `layout(location=n) in` are its attributes, and its
///   `out`, the fragment shader's `in`, the varyings; `gl_Position`,
///   `gl_PointSize`, `gl_VertexID`, `gl_InstanceID`, `gl_FragCoord`,
///   `gl_PointCoord`, `gl_FragDepth` and `outColor` are fields too.
/// - Clip space: GL's z runs −w…w and Metal's 0…w, so the vertex stage
///   halves it into place. Depths are then the ones `depthOf` computes.
/// - `discard` is as in GLSL.swift: in `main` or a void function only.
/// - `float[n](…)` array constructors become braces; `lessThan` and
///   `texture` are functions here, under names of their own.
///
/// What is not translated: uniform arrays, `texelFetch`, `inverse`, the
/// other vector comparisons, and `%` or `==` on vectors.
struct TranslatedProgram {
  /// Metal Shading Language: `program_vertex` and `program_fragment`.
  var source: String
  /// Where each uniform sits in the float buffer, and how many floats it takes.
  var slots: [String: (offset: Int, count: Int)]
  /// Floats in the buffer.
  var count: Int
  /// The sampler uniforms, in texture-index order.
  var textures: [String]
  /// The vertex attributes: location, and how many floats.
  var attributes: [(location: Int, size: Int)]
}

/// The slot every program has: the height of the target in pixels, to count
/// gl_FragCoord.y up from its bottom.
let targetHeightUniform = "eq_height"

/// The buffer index the uniforms' floats are bound at, in both stages: above
/// the vertex buffers, which take the indices from 0.
let uniformBufferIndex = 8

/// The floats a uniform or attribute of each type takes.
private let floatCounts = [
  "float": 1, "vec2": 2, "vec3": 3, "vec4": 4, "mat4": 16, "bool": 1, "int": 1, "ivec2": 2, "ivec3": 3,
]

private nonisolated(unsafe) let uniformLine = try! Regex(#"^\s*uniform\s+(?:highp\s+)?(\w+)\s+(\w+)\s*;\s*$"#)
private nonisolated(unsafe) let attributeLine = try! Regex(
  #"^\s*layout\s*\(\s*location\s*=\s*(\d+)\s*\)\s*in\s+(\w+)\s+(\w+)\s*;\s*$"#)
private nonisolated(unsafe) let varyingLine = try! Regex(#"^\s*(in|out)\s+(\w+)\s+(\w+)\s*;\s*$"#)
private nonisolated(unsafe) let outParameter = try! Regex(#"\b(?:inout|out)\s+(\w+)\s+(\w+)"#)
private nonisolated(unsafe) let precisionQualifier = try! Regex(#"\b(?:highp|mediump|lowp)\s+"#)
private nonisolated(unsafe) let arrayConstructor = try! Regex(#"\b(?:float|int|vec[234])\s*\[\d*\]\s*\("#)

/// One stage's source, its declarations taken out.
private struct Stage {
  var uniforms: [(type: String, name: String)] = []
  var samplers: [String] = []
  var attributes: [(location: Int, type: String, name: String)] = []
  /// `in` of a fragment shader, `out` of a vertex shader.
  var varyings: [(type: String, name: String)] = []
  var body = ""

  init(_ glsl: String) {
    var lines: [String] = []
    for line in glsl.split(separator: "\n", omittingEmptySubsequences: false) {
      let text = String(line)
      let trimmed = text.trimmingCharacters(in: .whitespaces)
      if trimmed.hasPrefix("#version") || trimmed.hasPrefix("precision ") || trimmed == "out vec4 outColor;" {
        continue
      }
      if let match = text.wholeMatch(of: uniformLine) {
        let type = String(match.output[1].substring ?? "")
        let name = String(match.output[2].substring ?? "")
        if type == "sampler2D" {
          samplers.append(name)
        } else if floatCounts[type] != nil {
          if !uniforms.contains(where: { $0.name == name }) { uniforms.append((type, name)) }
        } else {
          lines.append("#error \"uniform \(type) \(name) is not translated: see GLSL3D.swift\"")
        }
        continue
      }
      if let match = text.wholeMatch(of: attributeLine) {
        attributes.append(
          (
            Int(match.output[1].substring ?? "") ?? 0, String(match.output[2].substring ?? ""),
            String(match.output[3].substring ?? "")
          ))
        continue
      }
      if let match = text.wholeMatch(of: varyingLine) {
        varyings.append((String(match.output[2].substring ?? ""), String(match.output[3].substring ?? "")))
        continue
      }
      lines.append(
        text.replacing(precisionQualifier, with: "").replacing(outParameter) { match in
          "thread \(match.output[1].substring ?? "") &\(match.output[2].substring ?? "")"
        })
    }
    body = bracedArrays(lines.joined(separator: "\n")).replacing("lessThan(", with: "eq3_lessThan(")
      .replacing("texture(", with: "eq3_texture(")
  }

  func uses(_ name: String) -> Bool { body.contains(name) }
}

/// `float[5](a, b, …)` as `{a, b, …}`: what initializes an array in Metal.
private func bracedArrays(_ source: String) -> String {
  var text = source
  while let match = text.firstMatch(of: arrayConstructor) {
    // The parenthesis that closes the constructor's.
    var depth = 0
    var close: String.Index?
    for index in text[match.range.upperBound...].indices {
      if text[index] == "(" { depth += 1 }
      if text[index] == ")" {
        if depth == 0 {
          close = index
          break
        }
        depth -= 1
      }
    }
    guard let close else { break }
    text.replaceSubrange(close...close, with: "}")
    text.replaceSubrange(match.range, with: "{")
  }
  return text
}

func translateProgram(vertex: String, fragment: String) -> TranslatedProgram {
  let vert = Stage(vertex)
  let frag = Stage(fragment)

  var slots: [String: (offset: Int, count: Int)] = [targetHeightUniform: (0, 1)]
  var count = 1
  for uniform in vert.uniforms + frag.uniforms where slots[uniform.name] == nil {
    let size = floatCounts[uniform.type] ?? 1
    slots[uniform.name] = (count, size)
    count += size
  }

  /// The fields a stage's uniforms are, and the statements that fill them from the buffer.
  func uniforms(_ stage: Stage) -> (fields: String, fill: String) {
    var fields = ""
    var fill = ""
    for (type, name) in stage.uniforms {
      let at = slots[name]!.offset
      let read = { (k: Int) in "P[\(at + k)]" }
      let vector = { (from: Int, n: Int) in (from..<(from + n)).map(read).joined(separator: ", ") }
      fields += "  \(type) \(name);\n"
      switch type {
      case "float": fill += "  s.\(name) = \(read(0));\n"
      case "bool": fill += "  s.\(name) = \(read(0)) != 0.0;\n"
      case "int": fill += "  s.\(name) = int(\(read(0)));\n"
      case "ivec2", "ivec3": fill += "  s.\(name) = \(type)(vec\(type.last!)(\(vector(0, slots[name]!.count))));\n"
      case "mat4":
        fill += "  s.\(name) = mat4(" + (0..<4).map { "vec4(\(vector($0 * 4, 4)))" }.joined(separator: ", ") + ");\n"
      default: fill += "  s.\(name) = \(type)(\(vector(0, slots[name]!.count)));\n"
      }
    }
    return (fields, fill)
  }
  let fields = { (list: [(type: String, name: String)]) in list.map { "  \($0.type) \($0.name);\n" }.joined() }

  let vertUniforms = uniforms(vert)
  let fragUniforms = uniforms(frag)
  let pointSize = vert.uses("gl_PointSize")
  let pointCoord = frag.uses("gl_PointCoord")
  let fragDepth = frag.uses("gl_FragDepth")
  let attributes = vert.attributes.sorted { $0.location < $1.location }
  let textures = frag.samplers.enumerated().map { k, name in
    "\(name.contains("Depth") ? "depth2d<float>" : "texture2d<float>") eq_texture\(k) [[texture(\(k))]]"
  }

  let source = """
    \(header)
    \(header3D)
    #define discard { eq_discarded = true; return; }

    struct VertexIn {
    \(attributes.map { "  \($0.type) \($0.name) [[attribute(\($0.location))]];\n" }.joined())};

    struct VertexOut {
      float4 eq_position [[position]];
    \(pointSize ? "  float eq_pointSize [[point_size]];\n" : "")\
    \(vert.varyings.map { "  \($0.type) \($0.name) [[user(\($0.name))]];\n" }.joined())};

    struct FragmentIn {
      float4 eq_position [[position]];
    \(frag.varyings.map { "  \($0.type) \($0.name) [[user(\($0.name))]];\n" }.joined())};

    struct FragmentOut {
      float4 color [[color(0)]];
    \(fragDepth ? "  float depth [[depth(any)]];\n" : "")};

    struct VertexShader {
    \(vertUniforms.fields)\(fields(vert.attributes.map { ($0.type, $0.name) }))\(fields(vert.varyings))
      vec4 gl_Position;
      float gl_PointSize;
      int gl_VertexID;
      int gl_InstanceID;

    \(vert.body)
    };

    struct FragmentShader {
    \(fragUniforms.fields)\(fields(frag.varyings))\
    \(frag.samplers.map { "  \($0.contains("Depth") ? "eq3_depth" : "eq3_color") \($0);\n" }.joined())
      vec4 gl_FragCoord;
      vec2 gl_PointCoord;
      vec4 outColor;
      float gl_FragDepth;
      bool eq_discarded;

    \(frag.body)
    };

    vertex VertexOut program_vertex(\(attributes.isEmpty ? "" : "VertexIn in [[stage_in]], ")
                                    uint vertexID [[vertex_id]], uint instanceID [[instance_id]],
                                    constant float *P [[buffer(\(uniformBufferIndex))]]) {
      VertexShader s;
    \(vertUniforms.fill)\(attributes.map { "  s.\($0.name) = in.\($0.name);\n" }.joined())
      s.gl_VertexID = int(vertexID);
      s.gl_InstanceID = int(instanceID);
      s.gl_Position = float4(0.0, 0.0, 0.0, 1.0);
      s.gl_PointSize = 1.0;
      s.main();
      VertexOut out;
      // GL's clip z runs from -w to w; Metal's from 0.
      out.eq_position = float4(s.gl_Position.xy, 0.5 * (s.gl_Position.z + s.gl_Position.w), s.gl_Position.w);
    \(pointSize ? "  out.eq_pointSize = s.gl_PointSize;\n" : "")\
    \(vert.varyings.map { "  out.\($0.name) = s.\($0.name);\n" }.joined())
      return out;
    }

    fragment FragmentOut program_fragment(FragmentIn in [[stage_in]],
                                          \(pointCoord ? "float2 pointCoord [[point_coord]]," : "")
                                          constant float *P [[buffer(\(uniformBufferIndex))]]\
    \(textures.map { ",\n    \($0)" }.joined())) {
      FragmentShader s;
    \(fragUniforms.fill)\(frag.varyings.map { "  s.\($0.name) = in.\($0.name);\n" }.joined())\
    \(frag.samplers.indices.map { "  s.\(frag.samplers[$0]).t = eq_texture\($0);\n" }.joined())
      // GL counts pixels up from the bottom of the target.
      s.gl_FragCoord = float4(in.eq_position.x, P[0] - in.eq_position.y, in.eq_position.z, in.eq_position.w);
      s.gl_PointCoord = \(pointCoord ? "pointCoord" : "float2(0.0)");
      s.outColor = float4(0.0);
      s.gl_FragDepth = in.eq_position.z;
      s.eq_discarded = false;
      s.main();
      if (s.eq_discarded) discard_fragment();
      FragmentOut out;
      out.color = s.outColor;
    \(fragDepth ? "  out.depth = s.gl_FragDepth;\n" : "")
      return out;
    }
    """
  return TranslatedProgram(
    source: source, slots: slots, count: count, textures: frag.samplers,
    attributes: attributes.map { ($0.location, floatCounts[$0.type] ?? 1) })
}

/// What the 3D shaders name beyond GLSL.swift's header.
private let header3D = """
  static inline bool3 eq3_lessThan(float3 a, float3 b) { return a < b; }

  constexpr sampler eq3_nearest(coord::normalized, filter::nearest, address::clamp_to_edge);
  // A target another pass drew, as a sampler2D: rows from the top in Metal, so v is turned over.
  struct eq3_color { texture2d<float> t; };
  struct eq3_depth { depth2d<float> t; };
  static inline float4 eq3_texture(eq3_color s, float2 uv) {
    return s.t.sample(eq3_nearest, float2(uv.x, 1.0 - uv.y));
  }
  static inline float4 eq3_texture(eq3_depth s, float2 uv) {
    return float4(s.t.sample(eq3_nearest, float2(uv.x, 1.0 - uv.y)));
  }
  """
