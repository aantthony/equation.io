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
import { type Expr, evaluate } from '../../lib/expr.ts';
import { fanFillable, vertexSampler } from '../../lib/figure-vertices.ts';
import { traceField } from '../../lib/flow.ts';
import { GLSL_PRELUDE, toGLSL, withHelpers } from '../../lib/glsl.ts';
import { hullGeometrySampler } from '../../lib/hull-geometry.ts';
import { traceIntersection } from '../../lib/intersection.ts';
import { DARK_PALETTE, LIGHT_PALETTE, takesColor } from '../../lib/palette.ts';
import { CURVE_SAMPLES } from '../../lib/path.ts';
import { solveSystem, traceSystem } from '../../lib/solve.ts';
import { noteColor } from '../../lib/statements.ts';
import { defaultGeodesicLength, divergingGain, numericIn } from '../../lib/surface-geometry.ts';
import { surfaceInUV, surfaceMapping } from '../../lib/surface-map.ts';
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
      if (paint && surfaceMapping(row.cls.object) === 'paint')
        scene.paints.push({ ...surfaceGLSL, paint, color, params: gpu!.params, uniforms: gpu!.uniforms });
      else warn(`not carried onto the surface: ${text}`);
      return;
    }
    draw(row.cpu, row.gpu, color, index, text, point ? row.def?.name : undefined);
  });

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
