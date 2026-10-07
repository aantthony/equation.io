/**
 * What an eval task checks, against what a run left behind: the graph's rows
 * as the analyzer reads them, every tool call in order, and the reply.
 */
import type { CpuPlan } from '../../lib/compiler.ts';
import { evaluate } from '../../lib/expr.ts';
import type { RowStatus } from '../../web/voice.ts';
import type { EvalGraph } from './graph.ts';

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
export const drawn = (o: Outcome) =>
  o.rows.filter(r => r.status === 'ok' && r.kind && !r.kind.startsWith('definition') && !r.kind.startsWith('comment'));
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

/** The rows are exactly the starting rows. */
export const unchanged = () =>
  check('rows unchanged', o =>
    o.rows.length === o.start.length && o.rows.every((r, i) => same(r.text, o.start[i].text))
      ? true
      : `rows now ${JSON.stringify(o.rows.map(r => r.text))}`,
  );

/** Between min and max rows draw something. */
export const drawnCount = (min: number, max = Infinity) =>
  check(`${min}${max === min ? '' : max === Infinity ? '+' : `–${max}`} drawn rows`, o => {
    const n = drawn(o).length;
    return n >= min && n <= max ? true : `${n} drawn rows (${kinds(drawn(o))})`;
  });

/** Whether a row draws in 3D: a 2D figure in a 3D scene stays in the plane z = 0. */
const in3D = (o: Outcome, r: RowStatus) => !!o.graph.analysis.rows[r.index]?.cls?.needs3D;

/** A cube's kinds: a solid, or a polygon in 3D (a hull of 3D points); not a 2D figure. */
export const solid3D = () =>
  check('a solid or 3D polygon row', o =>
    o.rows.some(r => r.status === 'ok' && (r.kind === 'solid' || (r.kind === 'polygon' && in3D(o, r))))
      ? true
      : `kinds: ${kinds(o.rows)}`,
  );

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
      const n = parseFloat(v.replace(/^=\s*/, ''));
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
const env = (o: Outcome, vars: Record<string, number>) => ({ ...o.graph.analysis.constEnv, t: 0, ...vars });
const plans = (o: Outcome) =>
  o.graph.analysis.rows.flatMap((r, i) => (r.error || !r.cpu ? [] : [{ text: o.graph.rows[i], cpu: r.cpu }]));
const tryEval = (f: () => number) => {
  try {
    return f();
  } catch {
    return NaN;
  }
};

/**
 * Some 2D curve passes through every point: an implicit curve's residual
 * vanishes there, or a parametric curve comes within `tolerance` of it.
 */
export const curveThrough = (what: string, points: [number, number][], tolerance = 1e-3) =>
  check(what, o => {
    const on = (cpu: CpuPlan) => {
      if (cpu.type === 'implicit2d')
        return points.every(([x, y]) => Math.abs(tryEval(() => evaluate(cpu.residual, env(o, { x, y })))) < tolerance);
      if (cpu.type === 'pcurve' && cpu.dim === 2) {
        const samples = Array.from({ length: 2001 }, (_, k) =>
          cpu.comps.map(c => tryEval(() => evaluate(c, env(o, { u: k / 2000 })))),
        );
        return points.every(([x, y]) =>
          samples.some(([sx, sy]) => Math.hypot(sx - x, sy - y) < Math.max(tolerance, 0.02)),
        );
      }
      return false;
    };
    return plans(o).some(p => on(p.cpu)) ? true : `no curve through ${JSON.stringify(points)}`;
  });

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
  // Not motion: "goes round in a circle".
  [/(?<!\b(in|round|around|along) (a|the) )\bcircle\b/i, ['implicit2d', 'pcurve', 'polygon', 'pregion']],
  [/\b(torus|donut|doughnut)\b/i, ['psurface', 'implicit3d', 'solid']],
  [/\b(surface|saddle|paraboloid)\b/i, ['implicit3d', 'psurface']],
  [/\b(vector field|streamlines?)\b/i, ['vfield2d', 'vfield3d']],
  [/\blabel(led|s)?\b/i, ['label']],
  // Not "the point where they cross", or "the curve, showing the points where…".
  [
    /\b(plotted|drew|added|placed|marked)\s+(\w+\s+){0,2}points?\b/i,
    ['point', 'plist', 'definition (point)', 'system'],
  ],
  [/\bslider\b/i, ['definition (const)']],
  [/\b(rose|petals?|cardioid)\b/i, ['pcurve', 'implicit2d']],
  // Not "framed the area around them".
  [/\b(shaded|shade|area under|area between|region where)\b/i, ['ineq2d', 'value', 'pregion', 'projected2d', 'prob']],
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

/** Applies to every task. */
export const ALWAYS: Check[] = [clean(), oneShapePerRow(), honestReply()];

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
