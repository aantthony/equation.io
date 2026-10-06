/** Minimal WebGL2 helpers: program compilation with cache, fullscreen quad. */
import { shaderTables, withHelpers } from '../lib/glsl.ts';
import type { AxisMaps } from '../lib/axis-map.ts';

/**
 * Shader-compile counter, read by the perf harness (scripts/perf.ts) to
 * assert that interactions like slider drags hit the program cache instead
 * of compiling. Exposed on globalThis so the harness can read it in-page.
 */
export const glStats = { compiles: 0 };
(globalThis as { __glStats?: typeof glStats }).__glStats = glStats;

/**
 * Where a renderer draws: a panel's box in device pixels, from the bottom-left
 * corner as GL counts, and how much of the grid goes behind its plots
 * (lib/panels.ts GridRowSpec). Fragment shaders subtract the box's corner from
 * gl_FragCoord (uOrigin), so every field maps pixels to math inside its panel.
 */
export interface Frame {
  vp?: { x: number; y: number; w: number; h: number };
  grid?: 'on' | 'off' | 'axes';
  /** A lattice panel (docs/discrete.md): the grid runs between cells. */
  lattice?: boolean;
  /** Axes the panel's view(…) maps (lib/axis-map.ts): gridded at their ticks. */
  maps?: AxisMaps;
}

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
  const tableBudget = frag.includes('eq_loop_')
    ? gl.getParameter(gl.MAX_FRAGMENT_UNIFORM_VECTORS) - (frag.match(/\buniform\b/g)?.length ?? 0)
    : Infinity;
  const fragment = withHelpers(frag, tableBudget);
  const fs = compile(gl.FRAGMENT_SHADER, fragment);
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
  const tables = shaderTables(fragment);
  if (tables.length) {
    let previous = gl.getParameter(gl.CURRENT_PROGRAM) as WebGLProgram | null;
    // Binding the new program releases an old one pending deletion; such a
    // program cannot be rebound after the upload.
    if (previous && gl.getProgramParameter(previous, gl.DELETE_STATUS)) previous = null;
    gl.useProgram(prog);
    for (const table of tables) gl.uniform4fv(gl.getUniformLocation(prog, `${table.name}[0]`), table.values);
    gl.useProgram(previous);
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
