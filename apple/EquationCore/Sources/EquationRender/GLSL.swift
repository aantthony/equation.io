import Foundation

/// The site's shaders are GLSL ES 3.0, written out by web/render2d.ts and
/// lib/glsl.ts. Metal's language is C++, close enough that the same text
/// compiles once a few names are supplied, so the port keeps each shader as
/// the site has it and translates the wrapping, not the body:
///
/// - GLSL's types and functions Metal spells differently are defined in
///   `header` (vec2, mat2, mod, the two-argument atan, dFdx, …).
/// - The fragment source becomes the body of a struct: its functions are the
///   struct's methods, and its uniforms and `gl_FragCoord`, `outColor` are
///   the struct's fields, so every function reads them as GLSL globals.
/// - `uniform float name;` (vec2, vec3, vec4 too) becomes a slot in a float
///   buffer; the frame's own uniforms (uCenter, uUpp, uRes, uOrigin, uColor,
///   t) come from `Frame`.
/// - `discard` returns from main with the fragment marked discarded. It
///   works in `main` and in void functions; a helper that returns a value
///   and discards needs rewriting by hand.
///
/// What is not translated, and so must be changed where a shader uses it:
/// uniform arrays, samplers and `texture`/`texelFetch`, array constructors
/// (`float[3](…)`), `inverse`, and comparisons that return vectors
/// (`lessThan`, …).
struct TranslatedShader {
  /// Metal Shading Language: `quad_vertex` and `graph_fragment`.
  var source: String
  /// Where each declared uniform sits in the float buffer, and how many floats it takes.
  var slots: [String: (offset: Int, count: Int)]
  /// Floats in the buffer (at least 1, so there is always something to bind).
  var count: Int
}

/// The uniforms every pass gets from `FrameUniforms`.
private let frameUniforms: Set<String> = ["uCenter", "uUpp", "uRes", "uOrigin", "uColor", "t"]

private nonisolated(unsafe) let uniformLine = try! Regex(#"^\s*uniform\s+(?:highp\s+)?(\w+)\s+(\w+)\s*;\s*$"#)
private nonisolated(unsafe) let outParameter = try! Regex(#"\b(?:inout|out)\s+(\w+)\s+(\w+)"#)
private nonisolated(unsafe) let precisionQualifier = try! Regex(#"\b(?:highp|mediump|lowp)\s+"#)

func translateFragment(_ glsl: String) -> TranslatedShader {
  var slots: [String: (offset: Int, count: Int)] = [:]
  var count = 0
  var defines: [String] = []
  var body: [String] = []
  for line in glsl.split(separator: "\n", omittingEmptySubsequences: false) {
    let text = String(line)
    let trimmed = text.trimmingCharacters(in: .whitespaces)
    if trimmed.hasPrefix("#version") || trimmed.hasPrefix("precision ") || trimmed == "out vec4 outColor;" {
      continue
    }
    if let match = text.wholeMatch(of: uniformLine) {
      let type = String(match.output[1].substring ?? "")
      let name = String(match.output[2].substring ?? "")
      if frameUniforms.contains(name) || slots[name] != nil { continue }
      guard let size = ["float": 1, "vec2": 2, "vec3": 3, "vec4": 4][type] else {
        body.append("#error \"uniform \(type) \(name) is not translated: see GLSL.swift\"")
        continue
      }
      slots[name] = (count, size)
      let reads = (0..<size).map { "P[\(count + $0)]" }.joined(separator: ", ")
      defines.append("#define \(name) (\(size == 1 ? reads : "\(type)(\(reads))"))")
      count += size
      continue
    }
    body.append(
      text.replacing(precisionQualifier, with: "")
        .replacing(outParameter) { match in "thread \(match.output[1].substring ?? "") &\(match.output[2].substring ?? "")" })
  }
  let source = """
    \(header)
    \(defines.joined(separator: "\n"))
    #define discard { eq_discarded = true; return; }

    struct Shader {
      vec2 uCenter; vec2 uUpp; vec2 uRes; vec2 uOrigin; vec3 uColor; float t;
      constant float *P;
      vec4 gl_FragCoord;
      vec4 outColor;
      bool eq_discarded;

    \(body.joined(separator: "\n"))
    };

    fragment float4 graph_fragment(Varyings in [[stage_in]], constant Frame &frame [[buffer(0)]],
                                   constant float *P [[buffer(1)]]) {
      Shader s;
      s.uCenter = frame.uCenter; s.uUpp = frame.uUpp; s.uRes = frame.uRes; s.uOrigin = frame.uOrigin;
      s.uColor = frame.uColor.rgb; s.t = frame.t;
      s.P = P;
      // GL counts pixels up from the bottom of the target.
      s.gl_FragCoord = float4(in.position.x, frame.uHeight - in.position.y, in.position.z, in.position.w);
      s.outColor = float4(0.0);
      s.eq_discarded = false;
      s.main();
      if (s.eq_discarded) discard_fragment();
      return s.outColor;
    }
    """
  return TranslatedShader(source: source, slots: slots, count: max(count, 1))
}

/// GLSL's names in Metal, the frame's uniforms, and the triangle every pass draws.
private let header = """
  #include <metal_stdlib>
  using namespace metal;

  typedef float2 vec2; typedef float3 vec3; typedef float4 vec4;
  typedef int2 ivec2; typedef int3 ivec3; typedef int4 ivec4;
  typedef uint2 uvec2; typedef uint3 uvec3; typedef uint4 uvec4;
  typedef bool2 bvec2; typedef bool3 bvec3; typedef bool4 bvec4;
  typedef float2x2 mat2; typedef float3x3 mat3; typedef float4x4 mat4;

  static inline float atan(float y, float x) { return atan2(y, x); }
  static inline vec2 atan(vec2 y, vec2 x) { return atan2(y, x); }
  // GLSL's mod takes the divisor's sign; fmod takes the dividend's.
  static inline float mod(float a, float b) { return a - b * floor(a / b); }
  static inline vec2 mod(vec2 a, float b) { return a - b * floor(a / b); }
  static inline vec3 mod(vec3 a, float b) { return a - b * floor(a / b); }
  static inline vec4 mod(vec4 a, float b) { return a - b * floor(a / b); }
  static inline vec2 mod(vec2 a, vec2 b) { return a - b * floor(a / b); }
  static inline vec3 mod(vec3 a, vec3 b) { return a - b * floor(a / b); }
  static inline vec4 mod(vec4 a, vec4 b) { return a - b * floor(a / b); }
  #define dFdx dfdx
  #define dFdy dfdy
  #define inversesqrt rsqrt
  #define uintBitsToFloat(x) as_type<float>(x)
  #define intBitsToFloat(x) as_type<float>(x)
  #define floatBitsToUint(x) as_type<uint>(x)
  #define floatBitsToInt(x) as_type<int>(x)

  struct Frame {
    float2 uCenter;
    float2 uUpp;
    float2 uRes;
    float2 uOrigin;
    float t;
    float uHeight;
    float4 uColor;
  };

  struct Varyings { float4 position [[position]]; };

  vertex Varyings quad_vertex(uint id [[vertex_id]]) {
    const float2 corners[3] = { float2(-1.0, -1.0), float2(3.0, -1.0), float2(-1.0, 3.0) };
    Varyings out;
    out.position = float4(corners[id], 0.0, 1.0);
    return out;
  }
  """
