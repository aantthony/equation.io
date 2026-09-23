/** Minimal WebGL2 helpers: program compilation with cache, fullscreen quad. */
import { withHelpers } from '../lib/glsl.ts';

/**
 * Shader-compile counter, read by the perf harness (scripts/perf.ts) to
 * assert that interactions like slider drags hit the program cache instead
 * of compiling. Exposed on globalThis so the harness can read it in-page.
 */
export const glStats = { compiles: 0 };
(globalThis as { __glStats?: typeof glStats }).__glStats = glStats;

export function compileProgram(gl: WebGL2RenderingContext, vert: string, frag: string): WebGLProgram {
  glStats.compiles++;
  const compile = (type: number, src: string) => {
    const sh = gl.createShader(type)!;
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      const log = gl.getShaderInfoLog(sh);
      gl.deleteShader(sh);
      throw new Error(`Shader compile error: ${log}\n---\n${src}`);
    }
    return sh;
  };
  const vs = compile(gl.VERTEX_SHADER, vert);
  const fs = compile(gl.FRAGMENT_SHADER, withHelpers(frag));
  const prog = gl.createProgram()!;
  gl.attachShader(prog, vs);
  gl.attachShader(prog, fs);
  gl.linkProgram(prog);
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(prog);
    gl.deleteProgram(prog);
    throw new Error(`Program link error: ${log}`);
  }
  return prog;
}

/** A shared clip-space quad; every fragment-shader pass draws this. */
export function fullscreenQuad(gl: WebGL2RenderingContext): { draw(): void } {
  const vao = gl.createVertexArray()!;
  const buf = gl.createBuffer()!;
  gl.bindVertexArray(vao);
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  gl.bindVertexArray(null);
  return {
    draw() {
      gl.bindVertexArray(vao);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      gl.bindVertexArray(null);
    },
  };
}

export const QUAD_VERT = `#version 300 es
layout(location=0) in vec2 aPos;
void main() { gl_Position = vec4(aPos, 0.0, 1.0); }
`;

/** Cache programs by source so editing one equation doesn't recompile others. */
export class ProgramCache {
  private map = new Map<string, WebGLProgram>();
  constructor(private gl: WebGL2RenderingContext) {}
  get(vert: string, frag: string): WebGLProgram {
    const key = vert + '\0' + frag;
    let p = this.map.get(key);
    if (!p) {
      p = compileProgram(this.gl, vert, frag);
      this.map.set(key, p);
      // Bound the cache; old programs are cheap to rebuild.
      if (this.map.size > 64) {
        const [firstKey] = this.map.keys();
        this.gl.deleteProgram(this.map.get(firstKey)!);
        this.map.delete(firstKey);
      }
    }
    return p;
  }
}
