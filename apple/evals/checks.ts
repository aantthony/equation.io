/**
 * What an eval task checks, against what a run left behind: the graph's rows
 * as the analyzer reads them, every tool call in order, and the reply.
 */
import { analyzeRows } from '../../lib/analysis.ts';
import type { CpuPlan } from '../../lib/compiler.ts';
import { complexParts } from '../../lib/complex-parts.ts';
import { type Expr, evaluate } from '../../lib/expr.ts';
import type { EvalGraph, RowStatus } from './graph.ts';

export interface ToolCall {
  tool: string;
  args: Record<string, unknown>;
  /** The tool's answer, parsed: what the model read. */
  result: unknown;
}

export interface Outcome {
  start: RowStatus[];
  rows: RowStatus[];
  /** The final graph, for numeric checks. */
  graph: EvalGraph;
  calls: ToolCall[];
  reply: string;
}

export interface Check {
  name: string;
  /** True, or why it failed. */
  test(o: Outcome): true | string;
}

const check = (name: string, test: Check['test']): Check => ({ name, test });
const same = (a: string, b: string) => a.replace(/\s+/g, '') === b.replace(/\s+/g, '');
const failed = (result: unknown) => !!result && typeof result === 'object' && 'error' in result;
/** Rows that put something on the graph (not definitions, comments or views). */
export const drawn = (o: Outcome) => o.rows.filter(r => r.status === 'ok' && r.kind && !framing(r));
/** A definition, heading, viewport, grid or panel row: it sets the graph up and draws nothing itself. */
const framing = (r: RowStatus) => /^(definition|comment|viewport|grid|panel divider)/.test(r.kind ?? '');
const kinds = (rows: RowStatus[]) => rows.map(r => r.kind ?? r.error ?? '?').join(', ') || 'no rows';

/** No row has an error or a warning (a definition nothing uses, a 2D plot left out of 3D). */
export const clean = () =>
  check('no errors or warnings', o => {
    const bad = o.rows.find(r => r.status === 'error' || r.warning);
    return bad ? `${JSON.stringify(bad.text)}: ${bad.error ?? bad.warning}` : true;
  });

/** These rows are still there, exactly. */
export const keeps = (...texts: string[]) =>
  check(`keeps ${texts.join(', ')}`, o => {
    const lost = texts.find(t => !o.rows.some(r => same(r.text, t)));
    return lost ? `${JSON.stringify(lost)} was changed or removed` : true;
  });

/** The rows are exactly the starting rows, besides framing (a camera row saving a spin). */
export const unchanged = () =>
  check('rows unchanged', o => {
    const rows = o.rows.filter(r => !/^(viewport|grid)/.test(r.kind ?? ''));
    return rows.length === o.start.length && rows.every((r, i) => same(r.text, o.start[i].text))
      ? true
      : `rows now ${JSON.stringify(o.rows.map(r => r.text))}`;
  });

/** Between min and max rows draw something, not counting rows of the `besides` kinds (a marked point, a label). */
export const drawnCount = (min: number, max = Infinity, besides: string[] = []) =>
  check(`${min}${max === min ? '' : max === Infinity ? '+' : `–${max}`} drawn rows`, o => {
    const rows = drawn(o).filter(r => !besides.includes(r.kind ?? ''));
    return rows.length >= min && rows.length <= max ? true : `${rows.length} drawn rows (${kinds(rows)})`;
  });

/** Whether a row draws in 3D: a 2D figure in a 3D scene stays in the plane z = 0. */
const in3D = (o: Outcome, r: RowStatus) => !!o.graph.analysis.rows[r.index]?.cls?.needs3D;

/**
 * A unit cube: a solid, or a polygon in 3D (a hull of 3D points), whose
 * extent is 1 along each axis. Not a 2D figure, and not a 1 × 2 × 3 box.
 */
export const unitCube = () =>
  check('a unit cube (a solid or 3D hull, edges 1)', o => {
    const shapes = o.rows.filter(
      r => r.status === 'ok' && (r.kind === 'solid' || (r.kind === 'polygon' && in3D(o, r))),
    );
    if (!shapes.length) return `kinds: ${kinds(o.rows)}`;
    const extents = shapes.map(r => {
      const cpu = o.graph.analysis.rows[r.index].cpu;
      const pts = cpu ? shapePoints(o, cpu) : [];
      return [0, 1, 2].map(axis => {
        const xs = pts.map(p => p[axis]);
        return Math.max(...xs) - Math.min(...xs);
      });
    });
    return extents.some(e => e.every(d => Math.abs(d - 1) < 1e-6))
      ? true
      : `extents ${extents.map(e => e.map(d => +d.toFixed(3)).join(' × ')).join(', ')}`;
  });

/** Some row (matching `text`, if given) is of one of these kinds. */
export const hasKind = (wanted: string | string[], text?: RegExp) => {
  const list = [wanted].flat();
  return check(`a ${list.join(' or ')} row${text ? ` like ${text}` : ''}`, o =>
    o.rows.some(r => r.status === 'ok' && list.includes(r.kind ?? '') && (!text || text.test(r.text)))
      ? true
      : `kinds: ${kinds(o.rows)}`,
  );
};

/** One shape per row: no row draws one copy per list element (two shapes mashed into one row). */
export const oneShapePerRow = () =>
  check('one shape per row', o => {
    const family = o.rows.find(r => r.kind === 'family');
    return family ? `${JSON.stringify(family.text)} draws a family` : true;
  });

/** Some row's readout is about `value`. */
export const value = (expected: number, tolerance = 1e-3) =>
  check(`a readout ≈ ${expected}`, o => {
    const values = o.rows.flatMap(r => (r.value ? [r.value] : []));
    const near = values.some(v => {
      const n = parseFloat(v.replace(/^[=≈]\s*/, ''));
      return Math.abs(n - expected) <= tolerance * Math.max(1, Math.abs(expected));
    });
    return near ? true : `readouts: ${values.join(', ') || 'none'}`;
  });

/** A slider row exists, and a drawn row reads it. */
export const sliderUsed = () =>
  check('a slider that a drawn row uses', o => {
    const sliders = o.rows.filter(r => r.meaning?.includes('with a slider'));
    if (!sliders.length) return 'no slider row';
    return sliders.some(s => !s.warning) ? true : `${JSON.stringify(sliders[0].text)} is not used`;
  });

/** Exactly `n` rows match (to catch an animated or edited near copy beside the original). */
export const rowsLike = (pattern: RegExp, n: number) =>
  check(`${n} row${n === 1 ? '' : 's'} like ${pattern}`, o => {
    const found = o.rows.filter(r => pattern.test(r.text));
    return found.length === n ? true : `${found.length}: ${JSON.stringify(found.map(r => r.text))}`;
  });

/** No row matches. */
export const noRow = (pattern: RegExp) =>
  check(`no row like ${pattern}`, o => {
    const found = o.rows.find(r => pattern.test(r.text));
    return found ? `${JSON.stringify(found.text)}` : true;
  });

/** Some row matching `text` moves with time. */
export const animated = (text: RegExp) =>
  check(`a row like ${text} moves with t`, o =>
    o.rows.some(r => r.animated && text.test(r.text))
      ? true
      : `animated: ${JSON.stringify(o.rows.filter(r => r.animated).map(r => r.text))}`,
  );

/** A tool was called, succeeded, and its arguments passed `test`. */
export const called = (tool: string, what: string, test: (args: Record<string, unknown>) => boolean = () => true) =>
  check(`${tool}: ${what}`, o => {
    const calls = o.calls.filter(c => c.tool === tool);
    if (!calls.length) return `${tool} was not called`;
    return calls.some(c => !failed(c.result) && test(c.args))
      ? true
      : `calls: ${JSON.stringify(calls.map(c => c.args))}`;
  });

/** Every call of this tool succeeded (an animate_slider before its slider existed fails). */
export const noFailedCalls = (tool: string) =>
  check(`every ${tool} succeeded`, o => {
    const bad = o.calls.find(c => c.tool === tool && failed(c.result));
    return bad ? `${JSON.stringify(bad.args)} → ${JSON.stringify(bad.result)}` : true;
  });

/** The reply says something matching. */
export const replySays = (pattern: RegExp) =>
  check(`reply says ${pattern}`, o => (pattern.test(o.reply) ? true : `reply: ${JSON.stringify(o.reply)}`));

/** The env a row's plan evaluates in: its constants at t = 0. */
const env = (o: Outcome, vars: Record<string, number>): Record<string, number> => ({
  ...o.graph.analysis.constEnv,
  t: 0,
  ...vars,
});
const plans = (o: Outcome) =>
  o.graph.analysis.rows.flatMap((r, i) => (r.error || !r.cpu ? [] : [{ text: o.graph.rows[i], cpu: r.cpu }]));
const tryEval = (f: () => number) => {
  try {
    return f();
  } catch {
    return NaN;
  }
};

/** Whether a 2D curve's plan passes within `tolerance` of a point: an implicit curve's residual vanishes there. */
function onCurve(cpu: CpuPlan, vars: Record<string, number>, [x, y]: number[], tolerance: number): boolean {
  if (cpu.type === 'implicit2d') return Math.abs(tryEval(() => evaluate(cpu.residual, { ...vars, x, y }))) < tolerance;
  if (cpu.type === 'pcurve' && cpu.dim === 2)
    return Array.from({ length: 2001 }, (_, k) =>
      cpu.comps.map(c => tryEval(() => evaluate(c, { ...vars, u: k / 2000 }))),
    ).some(([sx, sy]) => Math.hypot(sx - x, sy - y) < Math.max(tolerance, 0.02));
  return false;
}

/**
 * Some 2D curve passes through every point: an implicit curve's residual
 * vanishes there, or a parametric curve comes within `tolerance` of it.
 */
export const curveThrough = (what: string, points: [number, number][], tolerance = 1e-3) =>
  check(what, o =>
    plans(o).some(p => points.every(pt => onCurve(p.cpu, env(o, {}), pt, tolerance)))
      ? true
      : `no curve through ${JSON.stringify(points)}`,
  );

/** Every point is on some 2D curve, not necessarily the same one (a function drawn piece by piece). */
export const curvesThrough = (what: string, points: [number, number][], tolerance = 1e-3) =>
  check(what, o => {
    const missed = points.find(pt => !plans(o).some(p => onCurve(p.cpu, env(o, {}), pt, tolerance)));
    return missed ? `no curve through ${JSON.stringify(missed)}` : true;
  });

/** No 2D curve passes through any of the points (a piece drawn past where it should stop). */
export const curveAvoids = (what: string, points: [number, number][], tolerance = 1e-3) =>
  check(what, o => {
    const hit = plans(o).find(p => points.some(pt => onCurve(p.cpu, env(o, {}), pt, tolerance)));
    return hit ? `${JSON.stringify(hit.text)} passes through one of ${JSON.stringify(points)}` : true;
  });

/** Where a plan's `coords` (a point or a label) evaluate to. */
const coordsAt = (o: Outcome, coords: Expr[]) => coords.map(c => tryEval(() => evaluate(c, env(o, {}))));
const near = (p: number[], q: number[], tolerance = 1e-6) =>
  p.length === q.length && p.every((v, i) => Math.abs(v - q[i]) < tolerance);

/** A point is drawn at `p`: a point row, or a named point. */
export const pointAt = (what: string, p: number[]) =>
  check(what, o => {
    const rows = plans(o).some(({ cpu }) => cpu.type === 'point' && near(coordsAt(o, cpu.coords), p));
    const vars = env(o, {});
    const named = [...o.graph.analysis.defs.points.keys()].some(n =>
      near(
        ['x', 'y', 'z'].slice(0, p.length).map(c => vars[`${n}_${c}`]),
        p,
      ),
    );
    return rows || named ? true : `no point at ${JSON.stringify(p)}`;
  });

/** A label is written at `p`, or beside it (within `tolerance`: a label set off its point so the two don't overlap). */
export const labelAt = (what: string, p: number[], tolerance = 0.5) =>
  check(what, o => {
    const labels = plans(o).filter(({ cpu }) => cpu.type === 'label');
    return labels.some(({ cpu }) => cpu.type === 'label' && near(coordsAt(o, cpu.coords), p, tolerance))
      ? true
      : `labels at ${JSON.stringify(labels.map(({ cpu }) => (cpu.type === 'label' ? coordsAt(o, cpu.coords) : [])))}`;
  });

/**
 * A slider and a 2D curve that follows it as `curve(value)` says: the curve
 * passes through the points `curve` gives for the slider's value, and for
 * another value once the slider row is changed and the rows read again.
 */
export const curveFollowsSlider = (what: string, curve: (value: number) => [number, number][]) =>
  check(what, o => {
    const texts = o.graph.rows;
    for (const [i, row] of o.graph.analysis.rows.entries()) {
      const def = row.def;
      if (def?.kind !== 'const' || !o.rows[i]?.meaning?.includes('with a slider')) continue;
      const value = o.graph.analysis.constEnv[def.name];
      const follows = (analysis: typeof o.graph.analysis, v: number) =>
        analysis.rows.some(
          r => !r.error && r.cpu && curve(v).every(pt => onCurve(r.cpu!, { ...analysis.constEnv, t: 0 }, pt, 1e-3)),
        );
      const moved = value + 0.7;
      const again = analyzeRows(
        texts.map((t, k) => (k === i ? `${def.name} = ${moved}` : t)),
        { readouts: true },
      );
      if (follows(o.graph.analysis, value) && follows(again, moved)) return true;
    }
    return 'no curve that follows a slider';
  });

/**
 * A complex function of w drawn as `kind` (domain2d, conformal2d, complex2d)
 * whose value matches `f` at a few points of the plane.
 */
export const complexFunction = (what: string, kind: CpuPlan['type'], f: (x: number, y: number) => [number, number]) =>
  check(what, o => {
    const fits = (cpu: CpuPlan) => {
      if (cpu.type !== kind || !('expr' in cpu)) return false;
      const [re, im] = complexParts(cpu.expr as Expr);
      return [
        [0.7, 0.4],
        [-1.3, 0.9],
        [0.2, -2.1],
      ].every(([x, y]) => near([evaluate(re, env(o, { x, y })), evaluate(im, env(o, { x, y }))], f(x, y), 1e-6));
    };
    return plans(o).some(p => fits(p.cpu)) ? true : `no ${kind} row matches`;
  });

/** Some 3D shape (a parametric surface, a solid's faces, a hull) whose sampled points pass `test`. */
export const shape3D = (what: string, test: (samples: number[][]) => boolean) =>
  check(what, o =>
    plans(o).some(p => {
      const samples = shapePoints(o, p.cpu, 21);
      return samples.length > 0 && samples.every(s => s.length === 3) && test(samples);
    })
      ? true
      : 'no 3D shape fits',
  );

/** Some parametric curve (2D or 3D), sampled over u in [0, 1], passes `test`. */
export const parametricCurve = (what: string, test: (samples: number[][]) => boolean, dim?: 2 | 3) =>
  check(what, o => {
    const fits = (cpu: CpuPlan) => {
      if (cpu.type !== 'pcurve' || (dim && cpu.dim !== dim)) return false;
      const samples = Array.from({ length: 201 }, (_, k) =>
        cpu.comps.map(c => tryEval(() => evaluate(c, env(o, { u: k / 200 })))),
      ).filter(p => p.every(Number.isFinite));
      return samples.length > 0 && test(samples);
    };
    return plans(o).some(p => fits(p.cpu)) ? true : `no parametric curve fits`;
  });

/** Some parametric curve (2D or 3D) has every sample satisfying `test`. */
export const parametric = (what: string, test: (p: number[]) => boolean, dim?: 2 | 3) =>
  parametricCurve(what, samples => samples.every(test), dim);

/** The points a solid's faces or a 3D polygon's vertices reach (finite ones), sampled. */
function shapePoints(o: Outcome, cpu: CpuPlan, n = 11): number[][] {
  const at = (exprs: Expr[], vars: Record<string, number>) => exprs.map(e => tryEval(() => evaluate(e, env(o, vars))));
  let pts: number[][] = [];
  if (cpu.type === 'family') return cpu.members.flatMap(m => shapePoints(o, m.cpu, n));
  if (cpu.type === 'psurface')
    pts = Array.from({ length: n * n }, (_, k) =>
      at(cpu.comps, { u: (k % n) / (n - 1), v: Math.floor(k / n) / (n - 1) }),
    );
  if (cpu.type === 'polygon' && cpu.dim === 3) {
    const { over } = cpu;
    pts = over
      ? Array.from({ length: over[0]?.values.length ?? 0 }, (_, k) =>
          at(cpu.pts, Object.fromEntries(over.map(c => [c.name, c.values[k]]))),
        )
      : Array.from({ length: cpu.pts.length / 3 }, (_, k) => at(cpu.pts.slice(3 * k, 3 * k + 3), {}));
  }
  return pts.filter(p => p.every(Number.isFinite));
}

/** Some 3D implicit surface's residual vanishes at every point (and not at `off`). */
export const surfaceThrough = (what: string, points: [number, number, number][], off?: [number, number, number]) =>
  check(what, o => {
    const at = (cpu: CpuPlan & { type: 'implicit3d' }, [x, y, z]: number[]) =>
      Math.abs(tryEval(() => evaluate(cpu.residual, env(o, { x, y, z }))));
    const fits = (cpu: CpuPlan) =>
      cpu.type === 'implicit3d' && points.every(p => at(cpu, p) < 1e-3) && (!off || at(cpu, off) > 1e-3);
    return plans(o).some(p => fits(p.cpu)) ? true : `no surface through ${JSON.stringify(points)}`;
  });

/** Some parametric surface, sampled over u and v in [0, 1], passes `test` (given every finite sample). */
export const parametricSurface = (what: string, test: (samples: number[][]) => boolean) =>
  check(what, o => {
    const fits = (cpu: CpuPlan) => {
      if (cpu.type !== 'psurface') return false;
      const grid = Array.from({ length: 21 * 21 }, (_, k) => ({ u: (k % 21) / 20, v: Math.floor(k / 21) / 20 }));
      const samples = grid
        .map(uv => cpu.comps.map(c => tryEval(() => evaluate(c, env(o, uv)))))
        .filter(p => p.every(Number.isFinite));
      return samples.length > 0 && test(samples);
    };
    return plans(o).some(p => fits(p.cpu)) ? true : `no parametric surface fits`;
  });

/** Passes when any of the checks does. */
export const anyOf = (name: string, ...checks: Check[]) =>
  check(name, o => {
    const why = checks.map(c => c.test(o));
    return why.includes(true) ? true : why.join('; ');
  });

/** Words in a reply that name a shape, and the kinds that would draw it. */
const CLAIMS: [RegExp, string[]][] = [
  [/\b(cube|box|cuboid)\b/i, ['solid', 'polygon in 3D']],
  [/\b(sphere|ball)\b/i, ['implicit3d', 'psurface', 'solid']],
  [/\b(helix|spiral)\b/i, ['pcurve']],
  // Not motion: "goes round in a circle", "orbits the unit circle"; nor a
  // surface's section: "its waist is a circle of radius 2".
  [
    /(?<!\b(in|round|around|along|orbits?|orbiting) (a|the) (unit )?|\b(waist|cross-section|section)\b[^.]{0,40})\bcircle\b/i,
    // A rotational field's streamlines are circles: "the streamlines circle the origin".
    ['implicit2d', 'pcurve', 'polygon', 'pregion', 'spacecurve', 'vfield2d'],
  ],
  [/\b(torus|donut|doughnut)\b/i, ['psurface', 'implicit3d', 'solid']],
  // A solid has a surface: "the filled volume, not just the surface".
  [/\b(surface|paraboloid)\b/i, ['implicit3d', 'psurface', 'solid']],
  // A flow has saddles too: "the circles open into a saddle".
  [/\bsaddle\b/i, ['implicit3d', 'psurface', 'vfield2d', 'vfield3d']],
  [/\b(vector field|streamlines?)\b/i, ['vfield2d', 'vfield3d']],
  [/\blabel(led|s)?\b/i, ['label']],
  // Not "the point where they cross", or "the curve, showing the points where…".
  [
    /\b(plotted|drew|added|placed|marked)\s+(\w+\s+){0,2}points?\b/i,
    // Labels mark points too: "marked both intersection points" with a label at each.
    ['point', 'plist', 'definition (point)', 'system', 'label'],
  ],
  [/\bslider\b/i, ['definition (const)']],
  [/\b(rose|petals?|cardioid)\b/i, ['pcurve', 'implicit2d']],
  // Not "framed the area around them".
  [
    /\b(shaded|shade|area under|area between|region where)\b/i,
    ['ineq2d', 'value', 'pregion', 'projected2d', 'probability (shaded area)'],
  ],
  [/\btangent\b/i, ['implicit2d', 'polygon']],
];

/**
 * The reply names only what was drawn: a reply that names a shape while no
 * row has a kind that draws it fails. Deliberately simple; a reply saying it
 * could NOT draw a cube fails too.
 */
export const honestReply = () =>
  check('reply names only what was drawn', o => {
    const shown = o.rows.filter(r => r.status === 'ok' && !r.warning);
    const present = new Set([...shown.map(r => r.kind), ...shown.filter(r => in3D(o, r)).map(r => `${r.kind} in 3D`)]);
    for (const [word, wanted] of CLAIMS) {
      const said = word.exec(o.reply);
      if (said && !wanted.some(k => present.has(k))) return `says "${said[0]}", but the rows are ${kinds(o.rows)}`;
    }
    return true;
  });

/**
 * The reply is plain text: the app shows it as it is, so LaTeX (`\(x^2\)`,
 * `\pi`, `$x$`) shows its backslashes and dollars.
 */
export const plainReply = () =>
  check('reply has no LaTeX', o => {
    const latex = /\\[()[\]]|\\[a-zA-Z]+|\$[^$\s][^$]*\$/.exec(o.reply);
    return latex ? `reply has ${JSON.stringify(latex[0])}` : true;
  });

/** Applies to every task. */
export const ALWAYS: Check[] = [clean(), oneShapePerRow(), honestReply(), plainReply()];

export function grade(
  checks: Check[],
  o: Outcome,
): { pass: boolean; checks: { name: string; pass: boolean; why?: string }[] } {
  const results = [...ALWAYS, ...checks].map(c => {
    let r: true | string;
    try {
      r = c.test(o);
    } catch (e) {
      r = `check threw: ${e instanceof Error ? e.message : String(e)}`;
    }
    return r === true ? { name: c.name, pass: true } : { name: c.name, pass: false, why: r };
  });
  return { pass: results.every(r => r.pass), checks: results };
}
