/**
 * A 3D graph's scene as the site builds it, for the Metal renderer to draw
 * before the language's Swift port compiles 3D rows: the rows' shader
 * strings (lib/compiler.ts) and sampled geometry, as the JSON of a Graph3D
 * (apple/EquationCore EquationRender/Scene3D.swift).
 *
 *   node --experimental-transform-types apple/tools/scene3d.ts "z = sin(x) cos(y)" > scene.json
 *   swift run metal-shot --out metal.png --scene scene.json
 *
 *   --dark     the dark theme's row colors
 *   --time 1   seconds since the graph opened (t)
 *
 * It follows web/main.ts renderPanel for the rows a document can draw
 * without the page: surfaces, planes, clouds, parametric surfaces and
 * curves (tubes too), points, polygons and hulls, vector fields
 * (streamlines when the row's note says `# streamlines`, arrows for
 * `# arrows`: the page keeps those toggles outside the text), systems and
 * intersections. What needs the page's state — orbits, trails, geodesics,
 * rows on a surface — is left out, and said so on stderr.
 */
import { analyzeRows } from '../../lib/analysis.ts';
import { type CpuPlan, type GpuPlan, parametricGLSL } from '../../lib/compiler.ts';
import { buildTube, curveFrames } from '../../lib/curve3d.ts';
import { type Expr, evaluate, substVars } from '../../lib/expr.ts';
import { fanFillable, vertexSampler } from '../../lib/figure-vertices.ts';
import { traceField } from '../../lib/flow.ts';
import { GLSL_PRELUDE, toGLSL, uniformName, withHelpers } from '../../lib/glsl.ts';
import { hullGeometrySampler } from '../../lib/hull-geometry.ts';
import { traceIntersection } from '../../lib/intersection.ts';
import { DARK_PALETTE, LIGHT_PALETTE, takesColor } from '../../lib/palette.ts';
import { CURVE_SAMPLES } from '../../lib/path.ts';
import { solveSystem, traceSystem } from '../../lib/solve.ts';
import { noteColor } from '../../lib/statements.ts';
import { defaultGeodesicLength, divergingGain, numericIn } from '../../lib/surface-geometry.ts';
import {
  type SurfaceMap,
  surfaceArrows,
  surfaceInUV,
  surfaceMapping,
  surfaceOver,
  surfacePoint,
} from '../../lib/surface-map.ts';
import { clampPhi } from '../../lib/view.ts';
import { fieldScale } from '../../lib/volume.ts';

type RGB = [number, number, number];

/** The Graph3D of some rows, as JSON: what the page would draw of them
 *  `time` seconds in. `warn` hears of what is left out. */
export function graphJSON(
  texts: readonly string[],
  { dark = false, time = 0, warn = console.error }: { dark?: boolean; time?: number; warn?: (m: string) => void } = {},
): string {
  const { rows, constEnv, defs } = analyzeRows(texts, { backend: 'both', readouts: false });
  const env = { ...constEnv, t: time };

  // web/main.ts defaultCamera, and the camera row over it.
  const camera = { target: [0, 0, 0], radius: 14, theta: -Math.PI / 3, phi: Math.PI / 5.5 };
  for (const row of rows) {
    if (row.view?.kind !== 'camera') continue;
    camera.theta = row.view.theta;
    camera.phi = clampPhi(row.view.phi);
    camera.radius = row.view.radius ?? 14;
    camera.target = row.view.target ? [...row.view.target] : [0, 0, 0];
  }
  const boxR = camera.radius * 0.85;

  const scene = {
    paints: [] as object[],
    implicits: [] as object[],
    psurfaces: [] as object[],
    curves: [] as object[],
    segments: [] as object[],
    tubes: [] as object[],
    points: [] as object[],
    planes: [] as object[],
    texts: [] as object[],
    volumes: [] as object[],
    streamlines: [] as object[],
  };

  /** A point on a surface moved a hair toward the eye, so the surface does
   *  not hide what lies exactly on it: web/main.ts towardEye. */
  const lifted = (p: readonly number[]): [number, number, number] => {
    const cp = Math.cos(camera.phi);
    const eye = [
      camera.target[0] + camera.radius * cp * Math.cos(camera.theta),
      camera.target[1] + camera.radius * cp * Math.sin(camera.theta),
      camera.target[2] + camera.radius * Math.sin(camera.phi),
    ];
    const lift = 0.004 * camera.radius;
    const d = Math.hypot(eye[0] - p[0], eye[1] - p[1], eye[2] - p[2]) || 1;
    return [0, 1, 2].map(k => p[k] + (lift * (eye[k] - p[k])) / d) as [number, number, number];
  };
  const markScene = () => ({
    curves: scene.curves.length,
    points: scene.points.length,
    texts: scene.texts.length,
    segments: scene.segments.length,
  });
  /** What a 2D row added to the scene since `mark`, placed in the plane
   *  z = 0, carried onto the surface: web/main.ts carryOntoSurface. */
  const carryOntoSurface = (mark: ReturnType<typeof markScene>, surface: SurfaceMap) => {
    const SURFACE_PIECES = 24;
    const onto = (x: number, y: number) => lifted(surfacePoint(surface, x, y));
    const line = (pts: ArrayLike<number>, pieces: number): Float32Array => {
      const out: number[] = [];
      for (let i = 0; i + 2 < pts.length; i += 3) {
        const [x0, y0] = [pts[i], pts[i + 1]];
        const next = i + 5 < pts.length;
        const steps = next && Number.isFinite(pts[i + 3]) ? pieces : 1;
        for (let k = 0; k < steps; k++) {
          const t = k / steps;
          const [x, y] = next && steps > 1 ? [x0 + (pts[i + 3] - x0) * t, y0 + (pts[i + 4] - y0) * t] : [x0, y0];
          const q = Number.isFinite(x) && Number.isFinite(y) ? onto(x, y) : null;
          out.push(...(q?.every(Number.isFinite) ? q : [NaN, NaN, NaN]));
        }
      }
      return Float32Array.from(out);
    };
    type Line = { pts: Float32Array; retained?: boolean };
    for (const c of scene.curves.slice(mark.curves) as Line[])
      c.pts = line(c.pts, c.pts.length > 300 ? 1 : SURFACE_PIECES);
    for (const s of scene.segments.slice(mark.segments) as Line[]) {
      const out: number[] = [];
      for (let i = 0; i + 5 < s.pts.length; i += 6) {
        const piece = line([s.pts[i], s.pts[i + 1], 0, s.pts[i + 3], s.pts[i + 4], 0], SURFACE_PIECES);
        for (let k = 0; k + 5 < piece.length; k += 3) {
          const seg = piece.subarray(k, k + 6);
          if (seg.every(Number.isFinite)) out.push(...seg);
        }
      }
      s.pts = Float32Array.from(out);
      s.retained = false;
    }
    const placed = (items: object[], from: number) => {
      const kept = (items.slice(from) as Array<{ pos: [number, number, number] }>).filter(it =>
        (it.pos = onto(it.pos[0], it.pos[1])).every(Number.isFinite),
      );
      items.splice(from, items.length - from, ...kept);
    };
    placed(scene.points, mark.points);
    placed(scene.texts, mark.texts);
  };

  const palette = dark ? DARK_PALETTE : LIGHT_PALETTE;
  const edgeShade = (c: RGB): RGB => c.map(v => v + (1 - v) * 0.55) as RGB;
  const TUBE_SEGMENTS = 24;

  /** What brings a surface's paint (its curvature) to about 1 where it is
   *  typical: web/main.ts paintGain. */
  function paintGain(comps: readonly Expr[], paint: Expr): number {
    const unit: [[number, number], [number, number]] = [
      [0, 1],
      [0, 1],
    ];
    const f = numericIn([paint], ['u', 'v'], env);
    const P = numericIn(comps, ['u', 'v'], env);
    const out = new Float64Array(3);
    // Rounding, not curvature, below 1e-9 of the surface's own size.
    const size = defaultGeodesicLength((u, v) => (P(u, v, out), [...out]), unit) / 2;
    const one = new Float64Array(1);
    return divergingGain((u, v) => (f(u, v, one), one[0]), unit, 1e-9 * Math.min(1 / size, 1 / size ** 2));
  }

  function draw(cpu: CpuPlan, gpu: GpuPlan | undefined, color: RGB, group: number, text: string, name?: string) {
    const params = gpu?.params ?? [];
    const uniforms = gpu?.uniforms;
    const bindings = { params, uniforms };
    // The box solvers search, padded as web/main.ts solveFor pads it.
    const lo = camera.target.map(c => c - 1.5 * boxR);
    const hi = camera.target.map(c => c + 1.5 * boxR);
    /** A polyline, as the floats the page uploads; `lift` between two paths lifts the pen. */
    const curve = (pts: number[], more: object = {}) =>
      scene.curves.push({ pts: new Float32Array(pts), color, ...more });
    const lift = [NaN, NaN, NaN];
    const at = (e: Expr, extra: Record<string, number> = {}) => {
      try {
        return evaluate(e, { ...env, ...extra });
      } catch {
        return NaN;
      }
    };
    switch (cpu.type) {
      case 'family':
        cpu.members.forEach((m, k) => {
          const shade = (0.45 * k) / Math.max(1, cpu.members.length - 1);
          const member = gpu?.type === 'family' ? gpu.members[k] : undefined;
          draw(m.cpu, member, color.map(c => c + (1 - c) * shade) as RGB, group, text);
        });
        break;
      case 'implicit2d':
        if (gpu?.type === 'implicit2d') scene.implicits.push({ field: gpu.field, color, ...bindings });
        break;
      case 'implicit3d':
        if (gpu?.type !== 'implicit3d') break;
        if (gpu.plane) scene.planes.push({ coeffs: gpu.plane, color, ...bindings });
        else scene.implicits.push({ field: gpu.field, grad: gpu.grad, color, ...bindings });
        break;
      case 'scalar3d':
        if (gpu?.type === 'scalar3d')
          scene.volumes.push({
            field: gpu.field,
            scale: fieldScale(cpu.expr, env, camera.target, camera.radius * 0.25),
            color,
            ...bindings,
          });
        break;
      case 'psurface':
      case 'pregion':
        if (gpu?.type !== 'psurface') break;
        scene.psurfaces.push({
          comps: gpu.comps,
          du: gpu.du,
          dv: gpu.dv,
          paint: gpu.paint,
          gain: cpu.type === 'psurface' && cpu.paint ? paintGain(cpu.comps, cpu.paint) : undefined,
          color,
          ...bindings,
        });
        break;
      case 'pcurve': {
        const sample = (es: Expr[] | undefined) => {
          if (!es) return undefined;
          const out = new Float32Array(CURVE_SAMPLES * 3);
          es.forEach((e, c) => {
            for (let k = 0; k < CURVE_SAMPLES; k++) out[k * 3 + c] = at(e, { u: k / (CURVE_SAMPLES - 1) });
          });
          return out;
        };
        const radius = cpu.dim === 3 && cpu.tube ? at(cpu.tube) : 0;
        const pts = sample(cpu.comps)!;
        if (radius > 0 && isFinite(radius)) {
          const frames = curveFrames(pts, sample(cpu.d1), sample(cpu.d2), sample(cpu.d3));
          scene.tubes.push({ ...buildTube(pts, frames, radius, TUBE_SEGMENTS), color });
        } else scene.curves.push({ pts, color });
        break;
      }
      case 'point': {
        const p = cpu.coords.map(c => at(c));
        if (p.every(isFinite)) scene.points.push({ pos: [p[0], p[1], p[2] ?? 0], color, label: name, group });
        break;
      }
      case 'label': {
        const p = cpu.coords.map(c => at(c));
        if (p.every(isFinite)) scene.texts.push({ pos: [p[0], p[1], p[2] ?? 0], text: cpu.text, color });
        break;
      }
      case 'plist':
        for (const comps of cpu.pts) {
          const p = comps.map(c => at(c));
          if (p.every(isFinite)) scene.points.push({ pos: [p[0], p[1], p[2] ?? 0], color, group });
        }
        break;
      case 'dscatter': {
        const [xs, ys, zs] = cpu.coords;
        for (let k = 0; k < xs.length; k++) {
          const z = zs ? zs[k] : 0;
          if (isFinite(xs[k]) && isFinite(ys[k]) && isFinite(z))
            scene.points.push({ pos: [xs[k], ys[k], z], color, group });
        }
        break;
      }
      case 'polygon': {
        const dim = cpu.dim ?? 2;
        if (cpu.hull) {
          const geometry = hullGeometrySampler(cpu.pts, dim, cpu.over)(constEnv, time);
          if (!geometry) break;
          const solid = geometry.mesh.indices.length > 0;
          if (solid) scene.tubes.push({ ...geometry.mesh, cells: [1, 1], color, retained: true });
          scene.segments.push({ pts: geometry.edges, color: solid ? edgeShade(color) : color, retained: true });
          break;
        }
        const vals = vertexSampler(cpu.pts, cpu.over)(constEnv, time);
        if (!vals.every(Number.isFinite)) break;
        const pts: number[] = [];
        for (let k = 0; k < vals.length; k += dim) pts.push(vals[k], vals[k + 1], dim === 3 ? vals[k + 2] : 0);
        const fill = cpu.closed && fanFillable(pts);
        if (cpu.closed) pts.push(...pts.slice(0, 3));
        curve(pts, { arrow: cpu.arrow, fill });
        break;
      }
      case 'vfield3d': {
        if (/#.*streamlines/.test(text) && gpu?.type === 'vfield3d') {
          scene.streamlines.push({ comps: gpu.comps, color, ...bindings });
          break;
        }
        const arrows = /#.*arrows/.test(text);
        const paths = traceField(cpu.comps, lo, hi, env, arrows);
        if (arrows) curve(paths.flatMap(path => [...path, lift]).flat(), { arrow: true });
        else for (const path of paths) if (path.length >= 2) curve(path.flat(), { fade: true });
        break;
      }
      case 'spacecurve':
        curve(
          traceIntersection(cpu.residuals, lo, hi, env)
            .flatMap(path => [...path, lift])
            .flat(),
        );
        break;
      case 'system': {
        const vars = cpu.dim === 3 ? ['x', 'y', 'z'] : ['x', 'y'];
        const [l, h] = [lo.slice(0, cpu.dim), hi.slice(0, cpu.dim)];
        if (cpu.parametric) {
          const paths = traceSystem(cpu.residuals, vars, l, h, env, 256, cpu.angular);
          curve(paths.flatMap(path => [...path, lift]).flatMap(p => [p[0], p[1], p[2] ?? 0]));
        } else
          solveSystem(cpu.residuals, vars, l, h, { env, angular: cpu.angular }).forEach((p, k) =>
            scene.points.push({ pos: [p[0], p[1], p[2] ?? 0], color, group: group * 1000 + k }),
          );
        break;
      }
      default:
        warn(`not drawn (${cpu.type}): ${text}`);
    }
  }

  // A document drawing its 2D rows on a surface (an on(…) row): the surface
  // first, in a shade between the page and its axes, then the rows it paints.
  const surface = rows.map(row => row.view).find(view => view?.kind === 'surface')?.surface;
  let surfaceGLSL: { comps: string[]; du?: string[]; dv?: string[]; xy: string[] } | undefined;
  if (surface) {
    const { comps, uv } = surfaceInUV(surface);
    surfaceGLSL = { ...parametricGLSL(comps), xy: [toGLSL(uv.x), toGLSL(uv.y)] };
    const [bg, axis] = dark
      ? [
          [0.09, 0.1, 0.12],
          [0.55, 0.56, 0.6],
        ]
      : [
          [1, 1, 1],
          [0.25, 0.25, 0.25],
        ];
    scene.psurfaces.push({ ...surfaceGLSL, xy: undefined, color: bg.map((b, k) => 0.65 * b + 0.35 * axis[k]) });
  }

  // Named points in x and y, which sit on a panel's surface, labelled.
  const surfacePoints: Array<{ name: string; color: RGB }> = [];
  let slot = 0;
  rows.forEach((row, index) => {
    // A row's own text: the analysis keeps it without its note.
    const text = texts[index] ?? row.text;
    // Every row that takes a colour takes a slot, drawn or not, as on the
    // page: a named point or surface, a row in error.
    const named = row.def?.kind === 'const' && defs.points.has(row.def.name);
    const takes = takesColor({ ...row, text, point: named });
    const color = noteColor(text) ?? palette[takes ? slot++ % palette.length : 0];
    if (row.error) warn(`${row.text}: ${row.error}`);
    if (surface && named && !row.error && defs.pointDims.get(row.def!.name) === 2)
      surfacePoints.push({ name: row.def!.name, color });
    if (!row.cpu || row.error) return;
    const point = row.cpu.type === 'point';
    if (surfaceGLSL && row.cls && !row.cls.needs3D) {
      const { gpu } = row;
      const paint =
        gpu?.type === 'implicit2d'
          ? { kind: 'curve', field: gpu.field }
          : gpu?.type === 'ineq2d'
            ? { kind: 'region', field: gpu.field, edges: gpu.edges }
            : gpu?.type === 'scalar2d'
              ? { kind: 'scalar', field: gpu.field }
              : null;
      const on = surfaceMapping(row.cls.object);
      if (paint && on === 'paint')
        scene.paints.push({ ...surfaceGLSL, paint, color, params: gpu!.params, uniforms: gpu!.uniforms });
      else if (on === 'carry' && row.cpu.type === 'vfield2d') {
        // A vector field as arrows along the surface's tangents.
        const comps = row.cpu.comps;
        const arrows = surfaceArrows(surface!, (x, y) =>
          comps.map(c => {
            try {
              return evaluate(c, { ...env, x, y });
            } catch {
              return NaN;
            }
          }),
        );
        const pts = new Float32Array(arrows.length);
        for (let k = 0; k + 2 < arrows.length; k += 3) pts.set(lifted(arrows.slice(k, k + 3)), k);
        if (pts.length) scene.curves.push({ pts, color, arrow: true });
      } else if (on === 'carry' && row.cpu.type === 'pregion') {
        // A parametric region's own mesh, carried onto the surface whole.
        const names = Object.fromEntries(
          (gpu?.params ?? []).map(p => [p, { kind: 'var', name: uniformName(p) } as Expr]),
        );
        try {
          const mesh = parametricGLSL(surfaceOver(surface!, row.cpu.comps), e => substVars(e, names));
          scene.paints.push({
            ...mesh,
            xy: ['u', 'v'],
            paint: { kind: 'region', field: '-1.0', edges: [] },
            color,
            params: gpu?.params ?? [],
            uniforms: gpu?.uniforms,
            lift: true,
          });
        } catch {
          warn(`not carried onto the surface: ${text}`);
        }
      } else if (on === 'carry' && row.cpu.type !== 'geodesic') {
        const mark = markScene();
        draw(row.cpu, row.gpu, color, index, text, point ? row.def?.name : undefined);
        carryOntoSurface(mark, surface!);
      } else if (on !== 'none') warn(`not carried onto the surface: ${text}`);
      return;
    }
    draw(row.cpu, row.gpu, color, index, text, point ? row.def?.name : undefined);
  });

  for (const { name, color } of surfacePoints) {
    const [px, py] = [constEnv[`${name}_x`], constEnv[`${name}_y`]];
    if (!isFinite(px) || !isFinite(py)) continue;
    const mark = markScene();
    scene.points.push({ pos: [px, py, 0], color, label: name });
    carryOntoSurface(mark, surface!);
  }

  // The loop helpers the shaders name (recursive functions, Fourier sums), as
  // the page splices them into a shader, their tables written as constants.
  const MARK = '\n// the scene\n';
  const shaders = JSON.stringify(scene, (_, value) => (ArrayBuffer.isView(value) ? undefined : value));
  const linked = withHelpers(GLSL_PRELUDE + MARK + shaders, 0);
  const helpers = linked.slice(GLSL_PRELUDE.length, linked.indexOf(MARK)).trim() || undefined;

  // JSON has no NaN; the Swift decoder reads the string.
  const json = JSON.stringify({ camera, scene, env: constEnv, time, helpers }, (_, value) => {
    // A float's nine digits, not the seventeen of the double it widens to.
    if (value instanceof Float32Array)
      return Array.from(value, v => (Number.isNaN(v) ? 'NaN' : Number(v.toPrecision(9))));
    if (ArrayBuffer.isView(value)) return Array.from(value as Uint32Array);
    if (typeof value === 'number' && !Number.isFinite(value))
      return Number.isNaN(value) ? 'NaN' : value > 0 ? 'Infinity' : '-Infinity';
    return value;
  });
  return json;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const timeAt = args.indexOf('--time');
  const texts = args.filter((a, i) => !a.startsWith('--') && (timeAt < 0 || i !== timeAt + 1));
  console.log(graphJSON(texts, { dark: args.includes('--dark'), time: timeAt >= 0 ? Number(args[timeAt + 1]) : 0 }));
}
