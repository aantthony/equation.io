import Metal
import Testing

@testable import EquationRender

/// What GLSL.swift translates beyond scalar and vector uniforms.
@Suite struct Translator {
  @Test func matricesAndVectorComparisons() throws {
    let metal = try #require(MetalContext())
    let shader = translateFragment(
      """
      #version 300 es
      precision highp float;
      out vec4 outColor;
      const int   N    = 24;
      const float STEP = 1.6;
      mat2 J(float x, float y) { return mat2(1.0); }
      bool inside(vec3 c) { return all(greaterThanEqual(c, vec3(-0.0001))) && all(lessThanEqual(c, vec3(1.0001))); }
      void main() {
        mat2 j = J(1.0, 2.0);
        mat2 m = inverse(j) * mat2(1.0, 2.0, 3.0, 4.0) * j;
        vec2 d = m[0];
        if (d == vec2(0.0)) discard;
        vec2 e = d != vec2(max(d.x, 1.0), 2.0) ? d : -d;
        vec3 linear = vec3(e, float(N) * STEP);
        outColor = vec4(linear, inside(linear) ? 1.0 : 0.0);
      }
      """)
    #expect(shader.source.contains("if (all(d == vec2(0.0))) discard;"))
    #expect(shader.source.contains("vec2 e = any(d != vec2(max(d.x, 1.0), 2.0)) ? d : -d;"))
    _ = try metal.makeLibrary(shader.source)
  }

  @Test func uniformArraysAndIntegers() throws {
    let metal = try #require(MetalContext())
    let shader = translateFragment(
      """
      #version 300 es
      precision highp float;
      uniform float u_a;
      uniform vec4 uMajx[16];
      uniform int uNMajx;
      uniform float uLevels[3];
      out vec4 outColor;
      void main() {
        float sum = u_a + uLevels[2];
        for (int i = 0; i < 64; i++) {
          if (i >= uNMajx) break;
          sum += uMajx[i / 4][i % 4];
        }
        outColor = vec4(sum);
      }
      """)
    #expect(shader.slots["uMajx"]?.offset == 1)
    #expect(shader.slots["uMajx"]?.count == 64)
    #expect(shader.slots["uNMajx"]?.offset == 65)
    #expect(shader.slots["uLevels"]?.count == 3)
    #expect(shader.count == 69)
    _ = try metal.makeLibrary(shader.source)
  }

  @Test func texturesTakeIndices() throws {
    let metal = try #require(MetalContext())
    let shader = translateFragment(
      """
      #version 300 es
      precision highp float;
      uniform highp usampler2D uCells;
      uniform sampler2D uImage;
      uniform vec2 uSize;
      out vec4 outColor;
      void main() {
        float v = float(texelFetch(uCells, ivec2(int(uSize.x), 0), 0).r) / 255.0;
        outColor = v * texture(uImage, vec2(0.5)) + texelFetch(uImage, ivec2(0), 0);
      }
      """)
    #expect(shader.textures == ["uCells", "uImage"])
    #expect(shader.slots["uCells"] == nil)
    #expect(shader.count == 2)
    _ = try metal.makeLibrary(shader.source)
  }
}
