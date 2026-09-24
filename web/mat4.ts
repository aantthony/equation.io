/** Minimal column-major mat4 utilities (only what the 3D view needs). */
export type Mat4 = Float32Array;

export function perspective(fovY: number, aspect: number, near: number, far: number): Mat4 {
  const f = 1 / Math.tan(fovY / 2);
  const nf = 1 / (near - far);
  const m = new Float32Array(16);
  m[0] = f / aspect;
  m[5] = f;
  m[10] = (far + near) * nf;
  m[11] = -1;
  m[14] = 2 * far * near * nf;
  return m;
}

/** Right-handed lookAt with +Z treated as up (math convention). */
export function lookAt(eye: number[], target: number[], up: number[]): Mat4 {
  const [ex, ey, ez] = eye;
  let zx = ex - target[0],
    zy = ey - target[1],
    zz = ez - target[2];
  const zl = Math.hypot(zx, zy, zz);
  zx /= zl;
  zy /= zl;
  zz /= zl;
  let xx = up[1] * zz - up[2] * zy;
  let xy = up[2] * zx - up[0] * zz;
  let xz = up[0] * zy - up[1] * zx;
  const xl = Math.hypot(xx, xy, xz) || 1;
  xx /= xl;
  xy /= xl;
  xz /= xl;
  const yx = zy * xz - zz * xy;
  const yy = zz * xx - zx * xz;
  const yz = zx * xy - zy * xx;
  return new Float32Array([
    xx,
    yx,
    zx,
    0,
    xy,
    yy,
    zy,
    0,
    xz,
    yz,
    zz,
    0,
    -(xx * ex + xy * ey + xz * ez),
    -(yx * ex + yy * ey + yz * ez),
    -(zx * ex + zy * ey + zz * ez),
    1,
  ]);
}

export function multiply(a: Mat4, b: Mat4): Mat4 {
  const out = new Float32Array(16);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      let s = 0;
      for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k];
      out[c * 4 + r] = s;
    }
  }
  return out;
}

export function invert(m: Mat4): Mat4 {
  // Standard cofactor inversion.
  const inv = new Float32Array(16);
  const a = m;
  inv[0] =
    a[5] * a[10] * a[15] -
    a[5] * a[11] * a[14] -
    a[9] * a[6] * a[15] +
    a[9] * a[7] * a[14] +
    a[13] * a[6] * a[11] -
    a[13] * a[7] * a[10];
  inv[4] =
    -a[4] * a[10] * a[15] +
    a[4] * a[11] * a[14] +
    a[8] * a[6] * a[15] -
    a[8] * a[7] * a[14] -
    a[12] * a[6] * a[11] +
    a[12] * a[7] * a[10];
  inv[8] =
    a[4] * a[9] * a[15] -
    a[4] * a[11] * a[13] -
    a[8] * a[5] * a[15] +
    a[8] * a[7] * a[13] +
    a[12] * a[5] * a[11] -
    a[12] * a[7] * a[9];
  inv[12] =
    -a[4] * a[9] * a[14] +
    a[4] * a[10] * a[13] +
    a[8] * a[5] * a[14] -
    a[8] * a[6] * a[13] -
    a[12] * a[5] * a[10] +
    a[12] * a[6] * a[9];
  inv[1] =
    -a[1] * a[10] * a[15] +
    a[1] * a[11] * a[14] +
    a[9] * a[2] * a[15] -
    a[9] * a[3] * a[14] -
    a[13] * a[2] * a[11] +
    a[13] * a[3] * a[10];
  inv[5] =
    a[0] * a[10] * a[15] -
    a[0] * a[11] * a[14] -
    a[8] * a[2] * a[15] +
    a[8] * a[3] * a[14] +
    a[12] * a[2] * a[11] -
    a[12] * a[3] * a[10];
  inv[9] =
    -a[0] * a[9] * a[15] +
    a[0] * a[11] * a[13] +
    a[8] * a[1] * a[15] -
    a[8] * a[3] * a[13] -
    a[12] * a[1] * a[11] +
    a[12] * a[3] * a[9];
  inv[13] =
    a[0] * a[9] * a[14] -
    a[0] * a[10] * a[13] -
    a[8] * a[1] * a[14] +
    a[8] * a[2] * a[13] +
    a[12] * a[1] * a[10] -
    a[12] * a[2] * a[9];
  inv[2] =
    a[1] * a[6] * a[15] -
    a[1] * a[7] * a[14] -
    a[5] * a[2] * a[15] +
    a[5] * a[3] * a[14] +
    a[13] * a[2] * a[7] -
    a[13] * a[3] * a[6];
  inv[6] =
    -a[0] * a[6] * a[15] +
    a[0] * a[7] * a[14] +
    a[4] * a[2] * a[15] -
    a[4] * a[3] * a[14] -
    a[12] * a[2] * a[7] +
    a[12] * a[3] * a[6];
  inv[10] =
    a[0] * a[5] * a[15] -
    a[0] * a[7] * a[13] -
    a[4] * a[1] * a[15] +
    a[4] * a[3] * a[13] +
    a[12] * a[1] * a[7] -
    a[12] * a[3] * a[5];
  inv[14] =
    -a[0] * a[5] * a[14] +
    a[0] * a[6] * a[13] +
    a[4] * a[1] * a[14] -
    a[4] * a[2] * a[13] -
    a[12] * a[1] * a[6] +
    a[12] * a[2] * a[5];
  inv[3] =
    -a[1] * a[6] * a[11] +
    a[1] * a[7] * a[10] +
    a[5] * a[2] * a[11] -
    a[5] * a[3] * a[10] -
    a[9] * a[2] * a[7] +
    a[9] * a[3] * a[6];
  inv[7] =
    a[0] * a[6] * a[11] -
    a[0] * a[7] * a[10] -
    a[4] * a[2] * a[11] +
    a[4] * a[3] * a[10] +
    a[8] * a[2] * a[7] -
    a[8] * a[3] * a[6];
  inv[11] =
    -a[0] * a[5] * a[11] +
    a[0] * a[7] * a[9] +
    a[4] * a[1] * a[11] -
    a[4] * a[3] * a[9] -
    a[8] * a[1] * a[7] +
    a[8] * a[3] * a[5];
  inv[15] =
    a[0] * a[5] * a[10] -
    a[0] * a[6] * a[9] -
    a[4] * a[1] * a[10] +
    a[4] * a[2] * a[9] +
    a[8] * a[1] * a[6] -
    a[8] * a[2] * a[5];
  let det = a[0] * inv[0] + a[1] * inv[4] + a[2] * inv[8] + a[3] * inv[12];
  if (det === 0) throw new Error('Singular matrix');
  det = 1 / det;
  for (let i = 0; i < 16; i++) inv[i] *= det;
  return inv;
}
