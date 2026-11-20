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
/// - `uniform float name;` (vec2, vec3, vec4, and int, which the buffer holds
///   as a float) becomes a slot in a float buffer, and `uniform vec4 name[16];`
///   sixteen of them, read as `name[i]`; the frame's own uniforms (uCenter,
///   uUpp, uRes, uOrigin, uColor, t) come from `Frame`.
/// - `uniform sampler2D name;` (usampler2D, isampler2D) becomes a texture, in
///   the order declared; `texelFetch` reads it, and `texture` samples it
///   linearly, clamped to its edge.
/// - `discard` returns from main with the fragment marked discarded. It
///   works in `main` and in void functions; a helper that returns a value
///   and discards needs rewriting by hand.
/// - `a == vec2(…)` and `a != vec2(…)` (vec3, vec4), which in Metal compare
///   component by component, become `all(…)` and `any(…)`: GLSL's one bool.
///   Only with a constructor on the right; two named vectors are not seen.
///
/// What is not translated, and so must be changed where a shader uses it:
/// uniforms of other types (matrices, bool), array constructors
/// (`float[3](…)`), and `inverse` of a mat3 or mat4.
struct TranslatedShader {
  /// Metal Shading Language: `quad_vertex` and `graph_fragment`.
  var source: String
  /// Where each declared uniform sits in the float buffer, and how many floats it takes.
  var slots: [String: (offset: Int, count: Int)]
  /// Floats in the buffer (at least 1, so there is always something to bind).
  var count: Int
  /// The textures the shader declares; each one's place here is its texture index.
  var textures: [String] = []
}

/// The uniforms every pass gets from `FrameUniforms`.
private let frameUniforms: Set<String> = ["uCenter", "uUpp", "uRes", "uOrigin", "uColor", "t"]

private nonisolated(unsafe) let uniformLine = try! Regex(
  #"^\s*uniform\s+(?:highp\s+)?(\w+)\s+(\w+)\s*(?:\[\s*(\d+)\s*\])?\s*;\s*$"#)
/// `a == vec2(…)`: a name (with fields or an index) set against a vector constructor, parentheses one deep.
private nonisolated(unsafe) let vectorEquality = try! Regex(
  #"([\w.\[\]]+)\s*(==|!=)\s*(vec[234]\((?:[^()]|\([^()]*\))*\))"#)
private let textureTypes = ["sampler2D": "float", "usampler2D": "uint", "isampler2D": "int"]
private nonisolated(unsafe) let outParameter = try! Regex(#"\b(?:inout|out)\s+(\w+)\s+(\w+)"#)
private nonisolated(unsafe) let precisionQualifier = try! Regex(#"\b(?:highp|mediump|lowp)\s+"#)

func translateFragment(_ glsl: String) -> TranslatedShader {
  var slots: [String: (offset: Int, count: Int)] = [:]
  var count = 0
  var defines: [String] = []
  var body: [String] = []
  var textures: [String] = []
  // A texture is a field of the struct, an argument of the fragment function, and the one set from the other.
  var fields: [String] = []
  var arguments: [String] = []
  var assigns: [String] = []
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
      if let texel = textureTypes[type] {
        fields.append("texture2d<\(texel)> \(name);")
        arguments.append(", texture2d<\(texel)> \(name) [[texture(\(textures.count))]]")
        assigns.append("s.\(name) = \(name);")
        textures.append(name)
        continue
      }
      guard let size = ["float": 1, "vec2": 2, "vec3": 3, "vec4": 4, "int": 1][type] else {
        body.append("#error \"uniform \(type) \(name) is not translated: see GLSL.swift\"")
        continue
      }
      if let length = match.output[3].substring.flatMap({ Int($0) }) {
        // An array is its floats in a row; eq_array reads element i from them.
        slots[name] = (count, size * length)
        defines.append("#define \(name) (eq_array<\(type)>{P + \(count)})")
        count += size * length
        continue
      }
      slots[name] = (count, size)
      let reads = (0..<size).map { "P[\(count + $0)]" }.joined(separator: ", ")
      defines.append("#define \(name) (\(size == 1 && type == "float" ? reads : "\(type)(\(reads))"))")
      count += size
      continue
    }
    body.append(
      text.replacing(precisionQualifier, with: "")
        .replacing(vectorEquality) { match in
          let (a, op, b) = (match.output[1].substring ?? "", match.output[2].substring ?? "", match.output[3].substring ?? "")
          return "\(op == "==" ? "all" : "any")(\(a) \(op) \(b))"
        }
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
      \(fields.joined(separator: " "))

    \(body.joined(separator: "\n"))
    };

    fragment float4 graph_fragment(Varyings in [[stage_in]], constant Frame &frame [[buffer(0)]],
                                   constant float *P [[buffer(1)]]\(arguments.joined())) {
      Shader s;
      s.uCenter = frame.uCenter; s.uUpp = frame.uUpp; s.uRes = frame.uRes; s.uOrigin = frame.uOrigin;
      s.uColor = frame.uColor.rgb; s.t = frame.t;
      s.P = P;
      \(assigns.joined(separator: " "))
      // GL counts pixels up from the bottom of the target.
      s.gl_FragCoord = float4(in.position.x, frame.uHeight - in.position.y, in.position.z, in.position.w);
      s.outColor = float4(0.0);
      s.eq_discarded = false;
      s.main();
      if (s.eq_discarded) discard_fragment();
      return s.outColor;
    }
    """
  return TranslatedShader(source: source, slots: slots, count: max(count, 1), textures: textures)
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
  // Metal has no inverse. A singular matrix gives infinities and NaNs, as GLSL's does.
  static inline mat2 inverse(mat2 m) {
    return mat2(m[1][1], -m[0][1], -m[1][0], m[0][0]) * (1.0 / determinant(m));
  }
  // GLSL names the comparisons that answer per component; Metal's operators are those.
  #define EQ_COMPARE(name, op) \\
    static inline bvec2 name(vec2 a, vec2 b) { return a op b; } \\
    static inline bvec3 name(vec3 a, vec3 b) { return a op b; } \\
    static inline bvec4 name(vec4 a, vec4 b) { return a op b; }
  EQ_COMPARE(lessThan, <) EQ_COMPARE(lessThanEqual, <=) EQ_COMPARE(greaterThan, >)
  EQ_COMPARE(greaterThanEqual, >=) EQ_COMPARE(equal, ==) EQ_COMPARE(notEqual, !=)
  // A uniform array: element i of the floats at p.
  template <typename T> struct eq_array;
  template <> struct eq_array<float> { constant float *p; float operator[](int i) const { return p[i]; } };
  template <> struct eq_array<int> { constant float *p; int operator[](int i) const { return int(p[i]); } };
  template <> struct eq_array<vec2> {
    constant float *p;
    vec2 operator[](int i) const { return vec2(p[2 * i], p[2 * i + 1]); }
  };
  template <> struct eq_array<vec3> {
    constant float *p;
    vec3 operator[](int i) const { return vec3(p[3 * i], p[3 * i + 1], p[3 * i + 2]); }
  };
  template <> struct eq_array<vec4> {
    constant float *p;
    vec4 operator[](int i) const { return vec4(p[4 * i], p[4 * i + 1], p[4 * i + 2], p[4 * i + 3]); }
  };
  // Textures: a texel by its integer place, or sampled as GL's default-free setup here asks (linear, clamped).
  template <typename T> static inline vec<T, 4> texelFetch(texture2d<T> image, ivec2 at, int lod) {
    return image.read(uint2(at), lod);
  }
  constexpr sampler eq_sampler(filter::linear, address::clamp_to_edge);
  static inline vec4 texture(texture2d<float> image, vec2 at) { return image.sample(eq_sampler, at); }
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
