interface GeometryBuffers {
  vao: WebGLVertexArrayObject;
  buffers: WebGLBuffer[];
  used: boolean;
}

/** GPU storage for immutable geometry. Unused entries are freed each frame,
 * so animation, edits and deleted rows cannot accumulate old buffers. */
export class RetainedGeometry {
  private entries = new Map<object, GeometryBuffers>();

  constructor(private gl: WebGL2RenderingContext) {}

  bind(key: object, attributes: Array<{ data: Float32Array; size: number }>, indices?: Uint32Array) {
    const { gl } = this;
    let entry = this.entries.get(key);
    if (!entry) {
      entry = { vao: gl.createVertexArray()!, buffers: [], used: true };
      gl.bindVertexArray(entry.vao);
      attributes.forEach(({ data, size }, location) => {
        const buffer = gl.createBuffer()!;
        entry!.buffers.push(buffer);
        gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
        gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
        gl.enableVertexAttribArray(location);
        gl.vertexAttribPointer(location, size, gl.FLOAT, false, 0, 0);
      });
      if (indices) {
        const buffer = gl.createBuffer()!;
        entry.buffers.push(buffer);
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, buffer);
        gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, indices, gl.STATIC_DRAW);
      }
      this.entries.set(key, entry);
    } else {
      gl.bindVertexArray(entry.vao);
      entry.used = true;
    }
  }

  endFrame() {
    for (const [key, entry] of this.entries) {
      if (!entry.used) this.remove(key, entry);
      else entry.used = false;
    }
  }

  clear() {
    for (const [key, entry] of this.entries) this.remove(key, entry);
  }

  private remove(key: object, entry: GeometryBuffers) {
    this.gl.deleteVertexArray(entry.vao);
    for (const buffer of entry.buffers) this.gl.deleteBuffer(buffer);
    this.entries.delete(key);
  }
}
