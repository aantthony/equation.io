/**
 * CPU renderer for /g/ link-preview images (og:image).
 *
 * Workers have no WebGL, so this rasterizes directly: expressions compile to
 * stack programs (vm.ts) and 2D plots sample per pixel — implicit curves via
 * the same |F|/|∇F| distance estimate the shader uses, regions as fills,
 * scalar fields as a colormap. 3D rows draw as projected wireframes
 * (parametric surfaces/curves, z = f(x,y) heightmaps). Output is a PNG built
 * with CompressionStream — no image library.
 */
import { densityAt, pdfExpr, shadePolygon } from '../lib/dist.ts';
import { type Expr, evaluate, substVars } from '../lib/expr.ts';
import type { Plot } from '../lib/plot.ts';
import { clampPhi, fitView2D } from '../lib/view.ts';
import { type Analysis, type RowInfo, analyze } from './graph.ts';
import { type Prog, compileProg, run } from './vm.ts';

// Matches web/main.ts PALETTE.
const PALETTE: [number, number, number][] = [
  [0.176, 0.439, 0.702],
  [0.780, 0.267, 0.251],
  [0.220, 0.549, 0.275],
  [0.376, 0.259, 0.651],
  [0.980, 0.494, 0.098],
  [0.000, 0.000, 0.000],
];

export const OG_WIDTH = 600;
export const OG_HEIGHT = 315;
export const MAX_PLOTS = 6;

interface Raster {
  w: number;
  h: number;
  /** RGB, row-major. */
  px: Uint8ClampedArray;
}

function blend(r: Raster, x: number, y: number, c: [number, number, number], a: number) {
  if (x < 0 || y < 0 || x >= r.w || y >= r.h || a <= 0) return;
  const i = (y * r.w + x) * 3;
  r.px[i] += (c[0] * 255 - r.px[i]) * a;
  r.px[i + 1] += (c[1] * 255 - r.px[i + 1]) * a;
  r.px[i + 2] += (c[2] * 255 - r.px[i + 2]) * a;
}

/** 2px-wide line with round-ish ends, stepped in unit increments. */
function drawLine(r: Raster, x0: number, y0: number, x1: number, y1: number, c: [number, number, number], a = 1) {
  const dx = x1 - x0, dy = y1 - y0;
  const n = Math.max(1, Math.ceil(Math.max(Math.abs(dx), Math.abs(dy))));
  if (n > 4000) return; // discontinuity in a sampled curve — don't draw across it
  for (let i = 0; i <= n; i++) {
    const x = x0 + (dx * i) / n, y = y0 + (dy * i) / n;
    const xi = Math.round(x), yi = Math.round(y);
    blend(r, xi, yi, c, a);
    blend(r, xi + 1, yi, c, a * 0.6);
    blend(r, xi, yi + 1, c, a * 0.6);
    blend(r, xi + 1, yi + 1, c, a * 0.35);
  }
}

function drawDisc(r: Raster, cx: number, cy: number, rad: number, c: [number, number, number]) {
  for (let y = Math.floor(cy - rad - 1); y <= cy + rad + 1; y++) {
    for (let x = Math.floor(cx - rad - 1); x <= cx + rad + 1; x++) {
      const d = Math.hypot(x - cx, y - cy);
      blend(r, x, y, c, Math.max(0, Math.min(1, rad - d + 0.5)));
    }
  }
}

// --- 2D view ---

interface View2D {
  cx: number; cy: number;
  /** World units per pixel. */
  upp: number;
}

const toScreenX = (r: Raster, v: View2D, wx: number) => r.w / 2 + (wx - v.cx) / v.upp;
const toScreenY = (r: Raster, v: View2D, wy: number) => r.h / 2 - (wy - v.cy) / v.upp;

function drawGrid2D(r: Raster, v: View2D) {
  const minor: [number, number, number] = [0.92, 0.92, 0.92];
  const axis: [number, number, number] = [0.65, 0.65, 0.65];
  // With a viewport row the window is author-controlled: a zoomed-out view
  // would paint one gridline per pixel (or worse), so drop the unit grid once
  // it gets denser than ~3px and keep only the axes.
  const drawMinor = 1 / v.upp >= 3;
  const x0 = v.cx - (r.w / 2) * v.upp, x1 = v.cx + (r.w / 2) * v.upp;
  const y0 = v.cy - (r.h / 2) * v.upp, y1 = v.cy + (r.h / 2) * v.upp;
  const lines = (lo: number, hi: number) => (drawMinor ? Array.from(
    { length: Math.max(0, Math.floor(hi) - Math.ceil(lo) + 1) },
    (_, i) => Math.ceil(lo) + i,
  ) : [0]);
  for (const wx of lines(x0, x1)) {
    const sx = Math.round(toScreenX(r, v, wx));
    for (let y = 0; y < r.h; y++) blend(r, sx, y, wx === 0 ? axis : minor, 1);
  }
  for (const wy of lines(y0, y1)) {
    const sy = Math.round(toScreenY(r, v, wy));
    for (let x = 0; x < r.w; x++) blend(r, x, sy, wy === 0 ? axis : minor, 1);
  }
}

/** Sample prog over the pixel-corner grid: (w+1) x (h+1). */
function sampleField(r: Raster, v: View2D, prog: Prog, env: EvalEnv): Float64Array {
  const { w, h } = r;
  const grid = new Float64Array((w + 1) * (h + 1));
  const { vars, stack, slotX, slotY } = env;
  for (let j = 0; j <= h; j++) {
    const wy = v.cy + (h / 2 - j) * v.upp;
    vars[slotY] = wy;
    for (let i = 0; i <= w; i++) {
      vars[slotX] = v.cx + (i - w / 2) * v.upp;
      grid[j * (w + 1) + i] = run(prog, vars, stack);
    }
  }
  return grid;
}

/** Paint the zero set of a sampled field using a distance estimate. */
function strokeZeroSet(r: Raster, grid: Float64Array, c: [number, number, number]) {
  const { w, h } = r;
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      const f00 = grid[j * (w + 1) + i], f10 = grid[j * (w + 1) + i + 1];
      const f01 = grid[(j + 1) * (w + 1) + i], f11 = grid[(j + 1) * (w + 1) + i + 1];
      const favg = (f00 + f10 + f01 + f11) / 4;
      if (!Number.isFinite(favg)) continue;
      const fx = (f10 + f11 - f00 - f01) / 2;
      const fy = (f01 + f11 - f00 - f10) / 2;
      const d = Math.abs(favg) / (Math.hypot(fx, fy) + 1e-12);
      if (d < 1.6) blend(r, i, j, c, Math.max(0, Math.min(1, 1.6 - d)));
    }
  }
}

function fillNegative(r: Raster, grid: Float64Array, c: [number, number, number], a: number) {
  const { w, h } = r;
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      if (grid[j * (w + 1) + i] < 0) blend(r, i, j, c, a);
    }
  }
}

/**
 * Scanline fill of a closed polygon given in screen coordinates, using the
 * nonzero winding rule — the canvas default the live app fills with, so
 * self-intersecting figures (a pentagram) fill the same way in both.
 */
function fillPolygon(r: Raster, sx: number[], sy: number[], c: [number, number, number], a: number) {
  const n = sx.length;
  const y0 = Math.max(0, Math.floor(Math.min(...sy)));
  const y1 = Math.min(r.h - 1, Math.ceil(Math.max(...sy)));
  for (let y = y0; y <= y1; y++) {
    const yc = y + 0.5;
    const hits: [number, number][] = [];
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const ya = sy[i], yb = sy[j];
      if (ya <= yc === yb <= yc) continue;
      hits.push([sx[i] + ((yc - ya) / (yb - ya)) * (sx[j] - sx[i]), yb > ya ? 1 : -1]);
    }
    hits.sort((p, q) => p[0] - q[0]);
    let wind = 0, spanStart = 0;
    for (const [x, dir] of hits) {
      if (wind === 0) spanStart = x;
      wind += dir;
      if (wind !== 0) continue;
      const xa = Math.max(0, Math.ceil(spanStart - 0.5));
      const xb = Math.min(r.w - 1, Math.floor(x - 0.5));
      for (let px = xa; px <= xb; px++) blend(r, px, y, c, a);
    }
  }
}

function shadeScalar(r: Raster, grid: Float64Array, c: [number, number, number]) {
  const { w, h } = r;
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      const value = grid[j * (w + 1) + i];
      if (!Number.isFinite(value)) continue;
      // Signed shade: positive toward the row color, negative toward its complement.
      const s = Math.tanh(value * 0.6);
      const tint: [number, number, number] = s >= 0 ? c : [1 - c[0], 1 - c[1], 1 - c[2]];
      blend(r, i, j, tint, Math.abs(s) * 0.55);
    }
  }
}

// --- evaluation env ---

interface EvalEnv {
  slots: Map<string, number>;
  vars: Float64Array;
  stack: Float64Array;
  slotX: number;
  slotY: number;
}

/** Slots for x, y, z, t, u, v plus every constant (bound to its t=0 value). */
function makeEnv(constEnv: Record<string, number>): EvalEnv {
  const slots = new Map<string, number>();
  for (const name of ['x', 'y', 'z', 't', 'u', 'v']) slots.set(name, slots.size);
  for (const name of Object.keys(constEnv)) if (!slots.has(name)) slots.set(name, slots.size);
  const vars = new Float64Array(slots.size);
  for (const [name, value] of Object.entries(constEnv)) vars[slots.get(name)!] = value;
  return { slots, vars, stack: new Float64Array(64), slotX: 0, slotY: 1 };
}

/** Compile against env, growing the shared stack to the program's depth. */
function compileFor(env: EvalEnv, e: Expr): Prog {
  const p = compileProg(e, env.slots);
  if (p.depth > env.stack.length) env.stack = new Float64Array(p.depth);
  return p;
}

const ineqDiff = (op: string, l: Expr, r: Expr): Expr =>
  op[0] === '<'
    ? { kind: 'bin', op: '-', a: l, b: r }
    : { kind: 'bin', op: '-', a: r, b: l };

/** Flatten a left-nested inequality chain into normalized F<0 parts. */
function ineqParts(e: Expr & { kind: 'ineq' }): { field: Expr; edge: boolean }[] {
  const chain: Array<Expr & { kind: 'ineq' }> = [];
  let node: Expr = e;
  while (node.kind === 'ineq') { chain.unshift(node); node = node.l; }
  return chain.map((c, k) => ({
    field: ineqDiff(c.op, k === 0 ? c.l : chain[k - 1].r, c.r),
    edge: c.op.length === 2,
  }));
}

// --- 3D projection ---

// Matches the app's default camera (web/main.ts): angles, and radius 14
// corresponding to the h/14 projection scale.
const THETA = -Math.PI / 3;
const PHI = Math.PI / 5.5;
const RADIUS = 14;

interface View3D {
  scale: number;
  ox: number;
  oy: number;
  theta: number;
  phi: number;
  target: [number, number, number];
}

function project(v: View3D, p: [number, number, number]): [number, number] {
  const x = p[0] - v.target[0], y = p[1] - v.target[1], z = p[2] - v.target[2];
  const st = Math.sin(v.theta), ct = Math.cos(v.theta);
  const sp = Math.sin(v.phi), cp = Math.cos(v.phi);
  const rx = -st * x + ct * y;
  const ry = -ct * sp * x - st * sp * y + cp * z;
  return [v.ox + rx * v.scale, v.oy - ry * v.scale];
}

function drawGrid3D(r: Raster, v: View3D) {
  const minor: [number, number, number] = [0.9, 0.9, 0.9];
  const axis: [number, number, number] = [0.6, 0.6, 0.6];
  const R = 6;
  for (let k = -R; k <= R; k++) {
    const c = k === 0 ? axis : minor;
    const [ax, ay] = project(v, [k, -R, 0]);
    const [bx, by] = project(v, [k, R, 0]);
    drawLine(r, ax, ay, bx, by, c, 0.9);
    const [cx2, cy2] = project(v, [-R, k, 0]);
    const [dx2, dy2] = project(v, [R, k, 0]);
    drawLine(r, cx2, cy2, dx2, dy2, c, 0.9);
  }
  const [zx0, zy0] = project(v, [0, 0, 0]);
  const [zx1, zy1] = project(v, [0, 0, 4]);
  drawLine(r, zx0, zy0, zx1, zy1, axis, 0.9);
}

function polyline3D(
  r: Raster, v: View3D, c: [number, number, number],
  n: number, at: (i: number) => [number, number, number] | null,
) {
  let prev: [number, number] | null = null;
  for (let i = 0; i <= n; i++) {
    const p = at(i);
    if (!p || p.some(x => !Number.isFinite(x))) { prev = null; continue; }
    const s = project(v, p);
    if (prev) drawLine(r, prev[0], prev[1], s[0], s[1], c);
    prev = s;
  }
}

// --- per-row renderers ---

const zVar = (e: Expr) => e.kind === 'var' && e.name === 'z';

/** The g of a z = g(x, y) equation (either side), or null when not that form. */
function heightmapExpr(expr: Expr): Expr | null {
  if (expr.kind !== 'eq') return null;
  return zVar(expr.l) ? expr.r : zVar(expr.r) ? expr.l : null;
}

function renderRow2D(
  r: Raster, v: View2D, row: RowInfo, env: EvalEnv, color: [number, number, number], analysis: Analysis,
) {
  const { cls, expr } = row;
  if (!cls) return;
  const compile = (e: Expr) => compileFor(env, e);
  if (cls.plot.type === 'density' || cls.plot.type === 'prob') {
    // Sampled-density rows: the same estimator the app uses (lib/dist.ts),
    // drawn as a polyline (density) or a filled area under it (P(…)).
    const shade = cls.plot.type === 'prob' ? cls.plot.shade : undefined;
    if (cls.plot.type === 'prob' && !shade) return; // readout-only row
    const name = cls.plot.type === 'density' ? cls.plot.rv : shade!.rv;
    const curve = analysis.rvs.curve(name, analysis.constEnv);
    if (!curve) return;
    if (cls.plot.type === 'density') {
      // Point masses draw as probability stems (height = mass, not density).
      for (const a of curve.atoms ?? []) {
        const ax = toScreenX(r, v, a.x);
        drawLine(r, ax, toScreenY(r, v, 0), ax, toScreenY(r, v, a.p), color);
        drawDisc(r, ax, toScreenY(r, v, a.p), 3.5, color);
      }
    }
    if (curve.pts.length < 4) return;
    const pts = shade
      ? shadePolygon(
          curve,
          shade.lo ? evaluate(shade.lo, analysis.constEnv) : undefined,
          shade.hi ? evaluate(shade.hi, analysis.constEnv) : undefined,
        )
      : curve.pts;
    if (!pts) return;
    const sx: number[] = [], sy: number[] = [];
    for (let i = 0; i + 1 < pts.length; i += 2) {
      sx.push(toScreenX(r, v, pts[i]));
      sy.push(toScreenY(r, v, pts[i + 1]));
    }
    if (shade) fillPolygon(r, sx, sy, color, 0.16);
    for (let i = 0; i + 1 < sx.length; i++) drawLine(r, sx[i], sy[i], sx[i + 1], sy[i + 1], color);
    if (shade) drawLine(r, sx[sx.length - 1], sy[sy.length - 1], sx[0], sy[0], color);
    return;
  }
  if (cls.plot.type === 'expect') {
    // The mean marker the app draws: a stem from the axis to the density at
    // x = E, capped with a dot (web/main.ts case 'expect').
    const name = cls.plot.rv;
    const m = analysis.rvs.mean(name, analysis.constEnv);
    if (!Number.isFinite(m)) return;
    const exact = analysis.rvs.exactDist(name);
    let h: number;
    try {
      h = exact
        ? evaluate(pdfExpr(exact, { kind: 'num', value: m }), analysis.constEnv)
        : (c => (c ? densityAt(c, m) : 0))(analysis.rvs.curve(name, analysis.constEnv));
    } catch {
      return;
    }
    if (!Number.isFinite(h) || h < 0) h = 0;
    const mx = toScreenX(r, v, m);
    if (h > 0) drawLine(r, mx, toScreenY(r, v, 0), mx, toScreenY(r, v, h), color);
    drawDisc(r, mx, toScreenY(r, v, h), 3.5, color);
    return;
  }
  if (cls.plot.type === 'cobweb') {
    // A recurrence a_{n+1} = f(a_n) draws the same three pieces as the app
    // (web/main.ts): the map's curve y = f(x), the y = x diagonal the orbit
    // reflects off, and the iterated path from the seed. Classification
    // leaves row.expr unset for sequence-family rows — the recurrence lives
    // in cls.plot.f — so this runs before the expr guard below.
    const { f, recVar, a0Name } = cls.plot;
    const fx = substVars(f, { [recVar]: { kind: 'var', name: 'x' } });
    strokeZeroSet(r, sampleField(r, v, compile({ kind: 'bin', op: '-', a: { kind: 'var', name: 'y' }, b: fx }), env), color);
    // y = x across the visible window, lighter than the axes.
    const dLo = Math.max(v.cx - (r.w / 2) * v.upp, v.cy - (r.h / 2) * v.upp);
    const dHi = Math.min(v.cx + (r.w / 2) * v.upp, v.cy + (r.h / 2) * v.upp);
    if (dHi > dLo) {
      drawLine(r, toScreenX(r, v, dLo), toScreenY(r, v, dLo), toScreenX(r, v, dHi), toScreenY(r, v, dHi), [0.65, 0.65, 0.65], 0.45);
    }
    const prog = compile(fx);
    const seedSlot = a0Name === undefined ? undefined : env.slots.get(a0Name);
    const seed = seedSlot === undefined ? 0.5 : env.vars[seedSlot];
    let a = seed;
    let ax = toScreenX(r, v, seed), ay = toScreenY(r, v, seed);
    for (let k = 0; k < 80; k++) {
      env.vars[env.slotX] = a;
      const b = run(prog, env.vars, env.stack);
      if (!Number.isFinite(b) || Math.abs(b) > 1e9) break;
      const bx = toScreenX(r, v, b), by = toScreenY(r, v, b);
      drawLine(r, ax, ay, ax, by, color); // vertically to the curve
      drawLine(r, ax, by, bx, by, color); // across to the diagonal
      a = b; ax = bx; ay = by;
    }
    drawDisc(r, toScreenX(r, v, seed), toScreenY(r, v, seed), 3.5, color);
    return;
  }
  if (!expr) return;
  switch (cls.plot.type) {
    case 'implicit2d': {
      const f: Expr = expr.kind === 'eq'
        ? { kind: 'bin', op: '-', a: expr.l, b: expr.r }
        : { kind: 'bin', op: '-', a: { kind: 'var', name: 'y' }, b: expr };
      strokeZeroSet(r, sampleField(r, v, compile(f), env), color);
      return;
    }
    case 'ineq2d': {
      if (expr.kind !== 'ineq') return;
      const parts = ineqParts(expr);
      let combined = parts[0].field;
      for (let k = 1; k < parts.length; k++) {
        combined = { kind: 'call', name: 'max', args: [combined, parts[k].field] };
      }
      fillNegative(r, sampleField(r, v, compile(combined), env), color, 0.18);
      for (const part of parts) {
        if (part.edge) strokeZeroSet(r, sampleField(r, v, compile(part.field), env), color);
      }
      return;
    }
    case 'scalar2d':
      shadeScalar(r, sampleField(r, v, compile(expr), env), color);
      return;
    case 'point': {
      if (expr.kind !== 'vec' || cls.plot.dim !== 2) return;
      const [px, py] = expr.items.map(c2 => run(compile(c2), env.vars, env.stack));
      drawDisc(r, toScreenX(r, v, px), toScreenY(r, v, py), 4.5, color);
      return;
    }
    case 'pcurve': {
      if (expr.kind !== 'vec' || cls.plot.dim !== 2) return;
      const progs = expr.items.map(compile);
      const slotU = env.slots.get('u')!;
      let prev: [number, number] | null = null;
      for (let i = 0; i <= 800; i++) {
        env.vars[slotU] = i / 800;
        const px = run(progs[0], env.vars, env.stack);
        const py = run(progs[1], env.vars, env.stack);
        if (!Number.isFinite(px) || !Number.isFinite(py)) { prev = null; continue; }
        const s: [number, number] = [toScreenX(r, v, px), toScreenY(r, v, py)];
        if (prev) drawLine(r, prev[0], prev[1], s[0], s[1], color);
        prev = s;
      }
      return;
    }
    case 'polygon': {
      // Flat scalar vertex list [x0, y0, x1, y1, …], constant by
      // classification; like the app, a single non-finite vertex drops the row.
      const vals = cls.plot.pts.map(p => run(compile(p), env.vars, env.stack));
      if (vals.length < 4 || !vals.every(Number.isFinite)) return;
      const sx: number[] = [], sy: number[] = [];
      for (let i = 0; i + 1 < vals.length; i += 2) {
        sx.push(toScreenX(r, v, vals[i]));
        sy.push(toScreenY(r, v, vals[i + 1]));
      }
      const { closed } = cls.plot;
      if (closed) fillPolygon(r, sx, sy, color, 0.16);
      for (let i = 0; i + 1 < sx.length; i++) drawLine(r, sx[i], sy[i], sx[i + 1], sy[i + 1], color);
      if (closed) drawLine(r, sx[sx.length - 1], sy[sy.length - 1], sx[0], sy[0], color);
      return;
    }
  }
}

function renderRow3D(r: Raster, v: View3D, row: RowInfo, env: EvalEnv, color: [number, number, number]) {
  const { cls, expr } = row;
  if (!cls || !expr) return;
  const compile = (e: Expr) => compileFor(env, e);
  const slotU = env.slots.get('u')!, slotV = env.slots.get('v')!;
  switch (cls.plot.type) {
    case 'psurface': {
      if (expr.kind !== 'vec') return;
      const progs = expr.items.map(compile);
      const at = (): [number, number, number] =>
        [run(progs[0], env.vars, env.stack), run(progs[1], env.vars, env.stack), run(progs[2], env.vars, env.stack)];
      const LINES = 16, SEGS = 64;
      for (let a = 0; a <= LINES; a++) {
        polyline3D(r, v, color, SEGS, i => {
          env.vars[slotU] = a / LINES; env.vars[slotV] = i / SEGS;
          return at();
        });
        polyline3D(r, v, color, SEGS, i => {
          env.vars[slotU] = i / SEGS; env.vars[slotV] = a / LINES;
          return at();
        });
      }
      return;
    }
    case 'pcurve': {
      if (expr.kind !== 'vec' || cls.plot.dim !== 3) return;
      const progs = expr.items.map(compile);
      polyline3D(r, v, color, 800, i => {
        env.vars[slotU] = i / 800;
        return [run(progs[0], env.vars, env.stack), run(progs[1], env.vars, env.stack), run(progs[2], env.vars, env.stack)];
      });
      return;
    }
    case 'point': {
      if (expr.kind !== 'vec') return;
      const p = expr.items.map(c2 => run(compile(c2), env.vars, env.stack)) as [number, number, number];
      const [sx, sy] = project(v, p);
      drawDisc(r, sx, sy, 4.5, color);
      return;
    }
    case 'implicit3d': {
      // Only the z = f(x, y) heightmap form draws (as a wireframe); general
      // implicit surfaces would need a raymarcher, too slow on CPU here.
      // previewGap() reports this gap to callers — keep them in sync.
      const g = heightmapExpr(expr);
      if (!g) return;
      let prog: Prog;
      try { prog = compile(g); } catch { return; }
      const slotX = env.slots.get('x')!, slotY = env.slots.get('y')!;
      const R = 6, LINES = 12, SEGS = 60;
      for (let a = 0; a <= LINES; a++) {
        const fixed = -R + (2 * R * a) / LINES;
        polyline3D(r, v, color, SEGS, i => {
          env.vars[slotX] = fixed; env.vars[slotY] = -R + (2 * R * i) / SEGS;
          return [env.vars[slotX], env.vars[slotY], run(prog, env.vars, env.stack)];
        });
        polyline3D(r, v, color, SEGS, i => {
          env.vars[slotX] = -R + (2 * R * i) / SEGS; env.vars[slotY] = fixed;
          return [env.vars[slotX], env.vars[slotY], run(prog, env.vars, env.stack)];
        });
      }
      return;
    }
  }
}

/**
 * Whether this renderer draws each plot type.
 *
 * It is a second, CPU-only backend for the same lib/ classifier the GPU app
 * uses, so it necessarily lags. Typing this as a total Record over
 * Plot['type'] means adding a plot family to lib/plot.ts FAILS TO COMPILE
 * until it is classified here — the drift cannot be silent, and tsc catches a
 * stale entry too.
 *
 * The cost of getting it wrong is a preview showing an empty grid, which reads
 * as "this graph is broken" — worse than no preview at all. Callers use
 * canRenderOg() and fall back to the site's static card instead.
 */
export const OG_COVERAGE: Record<Plot['type'], 'draws' | 'fallback'> = {
  implicit2d: 'draws',
  ineq2d: 'draws',
  scalar2d: 'draws',
  point: 'draws',
  pcurve: 'draws',
  psurface: 'draws',
  implicit3d: 'draws',
  polygon: 'draws',
  // Pure polyline work — the map's curve, the y = x diagonal, the iterated
  // path — so the scanline renderer draws the full figure.
  cobweb: 'draws',
  // Each of these needs a per-pixel shader — domain coloring, conformal grids,
  // escape-time iteration, line-integral convolution — that a scanline
  // rasterizer cannot reproduce faithfully at preview size. They get the
  // static site card instead of a wrong picture.
  complex2d: 'fallback',
  domain2d: 'fallback',
  conformal2d: 'fallback',
  fractal2d: 'fallback',
  vfield2d: 'fallback',
  // The rest of the sequence family (term dots, orbit diagrams) and data
  // lists have no scanline path here yet; the site card beats a blank grid.
  vlist: 'fallback',
  plist: 'fallback',
  // Typed-array lists reach the worker only from a data file, whose bytes
  // never travel in the link — so there is nothing to draw here anyway.
  dlist: 'fallback',
  dscatter: 'fallback',
  histogram: 'fallback',
  sequence: 'fallback',
  bifurcation: 'fallback',
  // Solution marks require running the numeric solver, which is not wired
  // into this backend yet.
  system: 'fallback',
  // Sampled densities run the same lib/dist.ts estimator on the CPU: the
  // curve is a polyline, a shaded P(…) a filled polygon, an E(…) row a
  // vertical mean marker. A readout-only P(…) row (no shade) draws nothing,
  // matching the app's canvas.
  density: 'draws',
  prob: 'draws',
  expect: 'draws',
};

/**
 * Why this renderer cannot draw a classified row — null when it draws.
 *
 * OG_COVERAGE is the type-level map; this is the row-level truth, because two
 * gaps live WITHIN types it marks 'draws': implicit3d only draws the
 * z = f(x, y) heightmap form, and a 3D scene draws none of the 2D-only rows.
 * Without this, a sphere gets preview "attached" with a picture of an empty
 * grid — which reads as "the graph failed" when only the preview did.
 *
 * The wording matters as much as the verdict: these strings are shown to
 * assistants deciding whether the graph WORKS, so each says what the live app
 * does with the row, and never implies the row itself is broken.
 */
export function previewGap(row: RowInfo, needs3D: boolean): string | null {
  // Sequence-family rows classify without a resolved expr — judge them by
  // type alone; only the implicit3d heightmap probe below needs the expr.
  const { cls, expr } = row;
  if (!cls) return null;
  const type = cls.plot.type;
  if (!needs3D) {
    return OG_COVERAGE[type] === 'draws'
      ? null
      : `no static preview for ${type} rows; the live app renders them (WebGL)`;
  }
  switch (type) {
    case 'psurface':
      return null;
    case 'implicit3d':
      return expr && heightmapExpr(expr)
        ? null
        : 'the static preview draws only z = f(x, y) surfaces; the live app renders general implicit surfaces in full';
    case 'pcurve':
    case 'point':
      return cls.plot.dim === 3
        ? null
        : 'the static preview skips 2D rows in a 3D scene; the live app draws them on the z = 0 plane';
    case 'implicit2d':
      return 'the static preview skips 2D curves in a 3D scene; the live app extrudes them as vertical sheets';
    default:
      // scalar2d, ineq2d, polygon and the shader families have no 3D locus — the live
      // app skips them in a 3D scene too (web/main.ts), so say that, not
      // "renders in the app", which would be false here.
      return `${type} rows are not drawn in a 3D scene (the live app skips them there too)`;
  }
}

/**
 * True when every plot row in the graph is one this renderer draws. False for
 * an empty graph too: a bare grid is not worth an image.
 */
export function canRenderOg(texts: string[]): boolean {
  let analysis: Analysis;
  try {
    analysis = analyze(texts);
  } catch {
    return false;
  }
  const plots = analysis.rows.filter(r => r.cls);
  if (!plots.length) return false;
  const needs3D = plots.some(r => r.cls!.needs3D);
  return plots.every(r => previewGap(r, needs3D) === null);
}

/** Render equations to a raw RGB raster (exported for tests). */
export function renderRaster(texts: string[], w = OG_WIDTH, h = OG_HEIGHT): Raster {
  const raster: Raster = { w, h, px: new Uint8ClampedArray(w * h * 3).fill(255) };
  let analysis: Analysis;
  try {
    analysis = analyze(texts);
  } catch {
    return raster;
  }
  const env = makeEnv(analysis.constEnv);
  const plotRows = analysis.rows.filter(r => r.cls).slice(0, MAX_PLOTS);
  const needs3D = plotRows.some(r => r.cls!.needs3D);

  // Honor viewport rows: the author's framing is document state, so the
  // preview draws the window the app would open with.
  const spec = (kind: 'view' | 'camera') => analysis.rows.find(r => r.view?.kind === kind)?.view;

  // Row colors follow creation order across ALL rows (defs consume a color
  // slot in the app too, since colorIndex comes from row id).
  const colorOf = (row: RowInfo) => PALETTE[analysis.rows.indexOf(row) % PALETTE.length];

  if (needs3D) {
    const cam = spec('camera');
    const view: View3D = cam?.kind === 'camera'
      ? {
          scale: h / (cam.radius ?? RADIUS),
          ox: w / 2,
          oy: h / 2 + h / RADIUS,
          theta: cam.theta,
          phi: clampPhi(cam.phi),
          target: cam.target ?? [0, 0, 0],
        }
      : { scale: h / RADIUS, ox: w / 2, oy: h / 2 + h / RADIUS, theta: THETA, phi: PHI, target: [0, 0, 0] };
    drawGrid3D(raster, view);
    for (const row of plotRows) {
      try { renderRow3D(raster, view, row, env, colorOf(row)); } catch { /* skip row */ }
    }
  } else {
    const box = spec('view');
    const view: View2D = box?.kind === 'view' ? fitView2D(box, w, h) : { cx: 0, cy: 0, upp: 12 / h };
    drawGrid2D(raster, view);
    for (const row of plotRows) {
      try { renderRow2D(raster, view, row, env, colorOf(row), analysis); } catch { /* skip row */ }
    }
  }
  return raster;
}

// --- PNG encoding ---

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(...parts: Uint8Array[]): number {
  let c = 0xffffffff;
  for (const p of parts) for (let i = 0; i < p.length; i++) c = CRC_TABLE[(c ^ p[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const t = new TextEncoder().encode(type);
  const out = new Uint8Array(12 + data.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  out.set(t, 4);
  out.set(data, 8);
  dv.setUint32(8 + data.length, crc32(t, data));
  return out;
}

async function deflate(data: Uint8Array): Promise<Uint8Array> {
  // 'deflate' is zlib-wrapped (RFC 1950), which is what PNG IDAT requires.
  const cs = new CompressionStream('deflate');
  const writer = cs.writable.getWriter();
  const written = writer.write(data).then(() => writer.close());
  const out = new Uint8Array(await new Response(cs.readable).arrayBuffer());
  await written;
  return out;
}

export async function encodePng(r: Raster): Promise<Uint8Array> {
  const { w, h, px } = r;
  const raw = new Uint8Array((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0; // filter: none
    raw.set(px.subarray(y * w * 3, (y + 1) * w * 3), y * (w * 3 + 1) + 1);
  }
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, w);
  dv.setUint32(4, h);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type: RGB
  const idat = await deflate(raw);
  const sig = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  const parts = [sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', new Uint8Array(0))];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return out;
}

export async function renderOgPng(texts: string[]): Promise<Uint8Array> {
  return encodePng(renderRaster(texts));
}
