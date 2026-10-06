import { childrenOf } from './expr.ts';
import { exprKey } from './expr.ts';
/**
 * Classify a parsed expression into a plot type, mirroring the old
 * equation.io renderable dispatcher:
 *
 * - "l = r" → implicit curve (2D) or implicit surface (3D when z appears)
 * - bare scalar in x and/or y → 2D scalar field, drawn per pixel (no implicit
 *   graph: `sin(x)` is a field, the curve is `y = sin(x)`); in x, y, z → an
 *   error until fields in space can be drawn
 * - vector literal with no free vars → a point
 * - vector with free u (and v) → parametric curve (u) / surface (u,v), u,v ∈ (0,1)
 * - vector with free x/y → 2D vector field, drawn as animated streamlines (LIC)
 * - ODEs: dy/dx = f and y' = f plot the direction field (1, f); a system
 *   (x', y') = (P, Q) plots the phase-plane field (P, Q) — all as vector fields
 * - t is always allowed and means "animated": bound to seconds since start
 */
import { coordinateRow, lowerCoordinateFlow } from './coordinate.ts';
import { SPECIAL_FORMS, WHOLE_EXPR_NAMES, inferScalarType, isComplexValued, usesComplex } from './complex.ts';
import {
  ANGLE_FN,
  CONSTANTS,
  REVOLVE_AXES,
  legacyCallArgs,
  builtinFn,
  revolveAxis,
  type Expr,
  evaluate,
  freeVars,
  ineqComparisons,
  substVars,
} from './expr.ts';
import { takenNameHint } from './defs.ts';
import { diff } from './diff.ts';
import { type FigureName, STREAMLINES_CALL, STREAMLINES_USAGE } from './geom.ts';
import { HULL_3D_MAX } from './hull.ts';
import { type HiddenInterval, hasInterval, intervalsIn, replaceIntervals, sweep } from './interval.ts';
import { packedTuple, tupleMultiset, tupleRow } from './list.ts';
import { nestedText, tensorOfNode } from './tensor.ts';
import { type Multivector, mvOfNode, mvText } from './clifford.ts';
import { flatFigure, flatOfNode, flatText } from './pga.ts';
import { actionGlyphs, actionOfNode, multivectorGlyphs } from './glyphs.ts';
import type { IntShade, ResolvedRow } from './intshade.ts';
import { SPLIT_NODE_BUDGET, complexParts, splitTooLarge } from './complex-parts.ts';
import { FAMILY_NODES, exceedsNodes } from './size.ts';
import { FIGURE_FAMILY_MAX } from './object-lists.ts';
import { type Prog, compileProg, run } from './vm.ts';

export { publicKind } from './math-object.ts';
export type { Classified, MathObject } from './math-object.ts';
import {
  components,
  objectNeeds3D,
  publicKind,
  type Classified,
  type MathObject,
  type LevelSetSpec,
} from './math-object.ts';
import type { CpuPlan } from './compiler.ts';

const SPACE_VARS = new Set(['x', 'y', 'z']);
/** Values a long tuple's readout shows, as a list's shows 8 (plotReadout). */
const TUPLE_SHOWN = 8;
const PARAM_VARS = new Set(['u', 'v']);

const isVarNamed = (e: Expr, name: string): boolean => e.kind === 'var' && e.name === name;

/**
 * Match an equation that spells an ODE — dy/dx = f, y' = f, or a system
 * (x', y') = (P, Q) — and return its direction field as a tuple.
 */
function matchODE(e: Expr): (Expr & { kind: 'vec' }) | null {
  if (e.kind !== 'eq') return null;
  const { l, r } = e;
  const one: Expr = { kind: 'num', value: 1 };
  const vec = (items: Expr[]): Expr & { kind: 'vec' } => ({ kind: 'vec', items });
  if (l.kind === 'bin' && l.op === '/') {
    if (isVarNamed(l.a, 'dy') && isVarNamed(l.b, 'dx')) return vec([one, r]);
    if (isVarNamed(l.a, 'dx') && isVarNamed(l.b, 'dy')) return vec([r, one]);
  }
  if (isVarNamed(l, "y'")) return vec([one, r]);
  if (l.kind === 'vec' && l.items.length === 3 && l.items.every((e, k) => isVarNamed(e, ["x'", "y'", "z'"][k]))) {
    if (r.kind !== 'vec' || r.items.length !== 3) throw new Error('A 3D flow needs three velocity components.');
    return r;
  }
  if (l.kind === 'vec' && l.items.length === 2 && isVarNamed(l.items[0], "x'") && isVarNamed(l.items[1], "y'")) {
    if (r.kind !== 'vec' || r.items.length !== 2) {
      throw new Error("A system needs two components on the right: (x', y') = (P, Q).");
    }
    return r;
  }
  return null;
}

/** Default sweep radius for tube(…) when no explicit radius is given. */
const DEFAULT_TUBE_RADIUS = 0.1;
/** Nodes across every member of a figure family: 1024 cubes turning about a
 *  fixed axis, or about a hundred turning about a slider-dependent one. */
const FIGURE_FAMILY_NODES = FAMILY_NODES;

/** lowerGeom's figure calls: whether each closes (and fills), and how its
 *  vertices are named in an error, after the statement the user wrote. */
const FIGURES: Partial<Record<string, { closed: boolean; what: string }>> = {
  '[segment]': { closed: false, what: 'Segment endpoints' },
  '[polyline]': { closed: false, what: 'Polyline vertices' },
  '[vector]': { closed: false, what: 'Vector endpoints' },
  '[polygon]': { closed: true, what: 'Polygon vertices' },
  '[square]': { closed: true, what: 'Square vertices' },
  '[hull]': { closed: true, what: 'Hull points' },
} satisfies Record<FigureName, unknown>;

/** Calls that describe the whole plot and cannot appear as a subterm. */
const WHOLE_EXPR_FORMS = new Set([...WHOLE_EXPR_NAMES].map(n => (n === 'trail' ? '[trail]' : n))); // trail arrives lowered

/**
 * tube(curve[, radius]): sweep a 3D parametric curve as a lit tube.
 *
 * Opt-in by design. A bare curve stays a line strip, so a tube can never
 * swallow points, other curves, or anything else sharing the scene — you
 * ask for the solid only when the solid is the point.
 */
function matchTube(e: Expr): { inner: Expr; radius: Expr } | null {
  if (e.kind !== 'call' || e.name !== 'tube') return null;
  e = { ...e, args: legacyCallArgs('tube', e.args) };
  // A parenthesized vector inside a call flattens into the argument list, so
  // tube((x, y, z)) and tube(x, y, z) arrive here identically — both spell
  // the same thing, and a fourth argument is the radius.
  if (e.args.length !== 3 && e.args.length !== 4) {
    throw new Error('tube takes three components and an optional radius: tube(cos(u), sin(u), u/4, 0.1).');
  }
  let radius: Expr = { kind: 'num', value: DEFAULT_TUBE_RADIUS };
  if (e.args.length === 4) {
    const r = e.args[3];
    if (r.kind === 'num' && !(r.value > 0)) throw new Error('The tube radius must be a positive number.');
    radius = r;
  }
  return { inner: { kind: 'vec', items: e.args.slice(0, 3) }, radius };
}

const REVOLVE_USAGE =
  'revolve takes a profile and an optional axis: revolve(sqrt(x)), or revolve(y^2, y) about the y-axis.';

/**
 * revolve(f[, axis]): the surface swept by turning the curve y = f(x) about
 * the x-axis — or a profile in y or z about that axis. It is nothing but the
 * implicit surface y^2 + z^2 = f(x)^2, so the raymarcher and the symbolic
 * gradient render it as they would the hand-written equation. Squaring
 * revolves |f|, which is the same surface: where f is negative the curve has
 * merely swung to the far side of the axis. A no-default piecewise f is NaN
 * outside its conditions, and no surface is drawn there.
 */
function matchRevolve(e: Expr): Expr | null {
  if (e.kind !== 'call' || e.name !== 'revolve') return null;
  if (e.args.length !== 1 && e.args.length !== 2) throw new Error(REVOLVE_USAGE);
  const [f, ax] = e.args;
  const axis = revolveAxis(ax);
  const form = ax ? `revolve(f, ${axis})` : 'revolve(f)';
  if (f.kind === 'list' || f.kind === 'data') {
    throw new Error('revolve of a list is not supported yet — write one revolve(…) row per profile.');
  }
  if (f.kind === 'vec' || f.kind === 'eq' || f.kind === 'ineq' || f.kind === 'str' || f.kind === 'text') {
    throw new Error(`${form} takes a single real expression in ${axis}, like revolve(sqrt(x)).`);
  }
  // The profile was split off before the root-only check in classify, so a
  // whole-expression form hiding inside it needs its own rejection.
  const nested = nestedSpecial(f);
  if (nested) throw new Error(`${nested === '[trail]' ? 'trail' : nested}(…) must be the whole expression.`);
  if (usesComplex(f)) throw new Error(`${form} takes a real expression in ${axis}; complex values cannot be revolved.`);
  for (const v of freeVars(f)) {
    if (v !== axis && (SPACE_VARS.has(v) || PARAM_VARS.has(v))) {
      throw new Error(`${form} takes an expression in ${axis} only.`);
    }
  }
  const sq = (a: Expr): Expr => ({ kind: 'bin', op: '^', a, b: { kind: 'num', value: 2 } });
  const [p, q] = [...REVOLVE_AXES].filter(v => v !== axis);
  return {
    kind: 'eq',
    l: { kind: 'bin', op: '+', a: sq({ kind: 'var', name: p }), b: sq({ kind: 'var', name: q }) },
    r: sq(f),
  };
}

/** First special-form call at any position other than the root itself. */
function nestedSpecial(e: Expr, isRoot = false): string | undefined {
  if (!isRoot && ['trail', 'label', 'figure', 'hist', 'family'].includes(e.kind))
    return e.kind === 'figure' ? e.form : e.kind;
  if (e.kind === 'call' && !isRoot && WHOLE_EXPR_FORMS.has(e.name)) return e.name;
  switch (e.kind) {
    case 'index':
    case 'range':
    case 'eqtest':
    case 'comp':
    case 'figure':
    case 'trail':
    case 'label':
    case 'hist':
    case 'family':
      return childrenOf(e)
        .map(c => nestedSpecial(c))
        .find(Boolean);
    case 'num':
    case 'var':
      return undefined;
    case 'neg':
      return nestedSpecial(e.a);
    case 'bin':
      return nestedSpecial(e.a) ?? nestedSpecial(e.b);
    case 'call': {
      for (const a of e.args) {
        const f = nestedSpecial(a);
        if (f) return f;
      }
      return undefined;
    }
    case 'eq':
      return nestedSpecial(e.l) ?? nestedSpecial(e.r);
    case 'ineq':
      return nestedSpecial(e.l) ?? nestedSpecial(e.r);
    case 'list':
    case 'vec': {
      for (const a of e.items) {
        const f = nestedSpecial(a);
        if (f) return f;
      }
      return undefined;
    }
    case 'piecewise': {
      for (const c of e.cases) {
        const f = nestedSpecial(c.cond) ?? nestedSpecial(c.value);
        if (f) return f;
      }
      return e.otherwise ? nestedSpecial(e.otherwise) : undefined;
    }
    case 'loop':
      return childrenOf(e)
        .map(c => nestedSpecial(c))
        .find(Boolean);
  }
}

/** Glyphs drawn with the value they picture read out beside them. The row
 *  animates and follows sliders by its value, not only by the parts drawn:
 *  the scalar part of cos(t) + e_xyz has no glyph but still changes. */
function withReadout(drawn: Classified, readout: Classified): { cls: Classified } {
  return {
    cls: {
      ...drawn,
      animated: drawn.animated || readout.animated,
      params: [...new Set([...drawn.params, ...readout.params])].sort(),
      object: { ...(drawn.object as MathObject & { kind: 'family' }), readout },
    },
  };
}

/**
 * `f(x,y) = c` (either way around) where c is a defined constant: build the
 * level-set family of f so the plot can render the whole contour stack.
 * Real-valued f only — the family renderer and CPU spacing sampler both
 * evaluate f as a plain scalar.
 */
function levelFamily(e: Expr, params: readonly string[], defined: ReadonlySet<string>): LevelSetSpec | undefined {
  if (e.kind !== 'eq') return undefined;
  const isLevel = (s: Expr) => s.kind === 'var' && params.includes(s.name);
  const f = isLevel(e.r) ? e.l : isLevel(e.l) ? e.r : undefined;
  if (!f || usesComplex(f)) return undefined;
  const fv = freeVars(f);
  if (!fv.has('x') && !fv.has('y')) return undefined;
  try {
    return {
      name: 'F',
      expr: f,
      params: [...freeVars(f)].filter(n => defined.has(n)).sort(),
      level: isLevel(e.r) && e.r.kind === 'var' ? e.r.name : e.l.kind === 'var' ? e.l.name : undefined,
    };
  } catch {
    return undefined;
  }
}

/**
 * The readout of a `value` row: `= 4` when six significant figures say it
 * all, `≈ 1.41421` when they round, `undefined` when there is no number.
 */
export function valueReadout(value: number): string {
  if (Number.isNaN(value)) return 'undefined';
  if (!isFinite(value)) return value > 0 ? '= ∞' : '= −∞';
  // Six significant digits, and at most six decimals: an animated readout
  // then keeps one width (with .eq-info's tabular figures) instead of
  // flickering between 0.0585821 and 0.600393 and rewrapping the rows below.
  // A value under 0.001 keeps its six digits, so a small one still reads.
  const precise = Number(value.toPrecision(6));
  const shown = Math.abs(value) >= 1e-3 ? Number(precise.toFixed(6)) : precise;
  return `${shown === value ? '=' : '≈'} ${shown}`;
}

const tooLarge = (what: string, verb: string) => splitTooLarge(`This complex ${what}`, verb);

export function classify(
  expr: Expr,
  defined: ReadonlySet<string> = new Set(),
  fields: Record<string, Expr> = {},
  timeDerivative?: (e: Expr) => Expr,
): Classified {
  return classifyLowered(expr, defined, fields, timeDerivative).cls;
}

/** Merge scalar differences into one uniform-selected expression. Structural
 * nodes (equations, vectors and figure calls) retain their shape. */
function familyTemplate(es: readonly Expr[], index: string): Expr {
  if (es.every(e => exprKey(e) === exprKey(es[0]))) return es[0];
  const first = es[0];
  if (es.every(e => e.kind === first.kind)) {
    if (first.kind === 'eq' || first.kind === 'ineq') {
      const rows = es as Array<Expr & { kind: 'eq' | 'ineq' }>;
      if (first.kind === 'eq' || rows.every(r => r.kind === 'ineq' && r.op === first.op))
        return {
          ...first,
          l: familyTemplate(
            rows.map(r => r.l),
            index,
          ),
          r: familyTemplate(
            rows.map(r => r.r),
            index,
          ),
        };
    }
    if (first.kind === 'vec') {
      const vs = es as Array<Expr & { kind: 'vec' }>;
      if (vs.every(v => v.items.length === first.items.length))
        return {
          kind: 'vec',
          items: first.items.map((_, k) =>
            familyTemplate(
              vs.map(v => v.items[k]),
              index,
            ),
          ),
        };
    }
    if (first.kind === 'call') {
      const cs = es as Array<Expr & { kind: 'call' }>;
      if (cs.every(c => c.name === first.name && c.args.length === first.args.length))
        return {
          ...first,
          args: first.args.map((_, k) =>
            familyTemplate(
              cs.map(c => c.args[k]),
              index,
            ),
          ),
        };
    }
    if (first.kind === 'bin') {
      const bs = es as Array<Expr & { kind: 'bin' }>;
      if (bs.every(b => b.op === first.op))
        return {
          ...first,
          a: familyTemplate(
            bs.map(b => b.a),
            index,
          ),
          b: familyTemplate(
            bs.map(b => b.b),
            index,
          ),
        };
    }
  }
  if (es.some(e => e.kind === 'eq' || e.kind === 'ineq' || e.kind === 'vec'))
    throw new Error('Family members need matching object shapes.');
  return {
    kind: 'piecewise',
    cases: es.slice(0, -1).map((value, k) => ({
      cond: { kind: 'ineq', op: '<', l: { kind: 'var', name: index }, r: { kind: 'num', value: k + 0.5 } },
      value,
    })),
    otherwise: es[es.length - 1],
  };
}

/**
 * A point in space over three parameters (intervals, u and v) is a solid:
 * `(interval(0, 1), interval(0, 1), interval(0, 1))` is the unit cube. It is
 * drawn as the six faces of its parameter box, each a parametric surface in
 * u and v. Where the map is a local diffeomorphism inside the box, the
 * interior lands inside the solid (inverse function theorem), so the solid's
 * surface lies within the faces; and the faces being part of the solid,
 * drawn opaque they show exactly what is seen from outside. A face may fall
 * inside (the seam φ = 0 of a ball in spherical coordinates) or collapse to a
 * curve or point (its r = 0 face); opaque, neither shows. A map that folds
 * inside the box takes part of its surface from the fold, which no face
 * draws, so a Jacobian that changes sign there is an error. So is a map
 * undefined in part of the box (`{…}` with no default, or sqrt of a negative):
 * its edge there bounds the solid too, and no face draws that either.
 */
function solidFaces(
  expr: Expr & { kind: 'vec' },
  hidden: readonly HiddenInterval[],
  vars: ReadonlySet<string>,
  defined: ReadonlySet<string>,
): { family: Expr; map: { items: Expr[]; params: string[] } } {
  // Every parameter as a name over [0, 1]: u and v as they are, each
  // interval as a fresh one.
  const names = [...PARAM_VARS].filter(p => vars.has(p));
  const slot = new Map<string, string>();
  for (const h of hidden) {
    let name = `eqioSolid${names.length}`;
    while (vars.has(name) || defined.has(name)) name += 'X';
    slot.set(h.key, name);
    names.push(name);
  }
  const items = expr.items.map(c => replaceIntervals(c, h => sweep(h, slot.get(h.key)!)));
  checkFolds({ items, params: names }, null);
  const u: Expr = { kind: 'var', name: 'u' };
  const v: Expr = { kind: 'var', name: 'v' };
  const members: Expr[] = [];
  for (const fixed of names) {
    const [a, b] = names.filter(n => n !== fixed);
    for (const end of [0, 1]) {
      const env: Record<string, Expr> = { [fixed]: { kind: 'num', value: end }, [a]: u, [b]: v };
      members.push({ kind: 'vec', items: items.map(c => substVars(c, env)) });
    }
  }
  return { family: { kind: 'family', members }, map: { items, params: names } };
}

interface SolidMap {
  readonly items: readonly Expr[];
  readonly params: readonly string[];
}

/** Each solid's map, over its params in [0, 1], for its fold check in analysis. */
const solidMaps = new WeakMap<MathObject, SolidMap>();

/**
 * The fold and gap check, split by what the Jacobian reads besides the
 * params. Only those names can fold the map or move its gaps: a translation
 * (`… + k`) can do neither, and is read as 0. One undefined there (`log(k)`)
 * is ∞, which leaves the gaps NaN, so they still show; one NaN there
 * (`sqrt(k - 1)`) leaves the whole map NaN, and unchecked. A Jacobian of numbers alone is checked in classification (`consts`
 * null). One reading sliders needs their values, which only analysis has: it
 * passes the resolver's recording proxy, so the sliders read here leave the
 * runtime-uniform set and a drag re-runs the check. A name with no value
 * (t, an animated constant, a state) leaves the map unchecked, read nothing.
 */
function checkFolds(map: SolidMap, consts: Readonly<Record<string, number>> | null): void {
  const { items, params } = map;
  const valued = (n: string) => consts !== null && Object.hasOwn(consts, n);
  // pi and e compile as themselves unless the document redefines them.
  const free = new Set(
    items
      .flatMap(c => [...freeVars(c)])
      .filter(n => !params.includes(n) && (valued(n) || !Object.hasOwn(CONSTANTS, n))),
  );
  let shaping: Set<string>;
  try {
    shaping = new Set(items.flatMap(c => params.flatMap(p => [...freeVars(diff(c, p))])).filter(n => free.has(n)));
  } catch {
    shaping = free;
  }
  if (consts === null ? shaping.size > 0 : shaping.size === 0 || ![...shaping].every(valued)) return;
  const extra = [...free];
  const values = extra.map(n => (shaping.has(n) ? consts![n] : 0));
  const defect = solidDefect(items, params, extra, values);
  if (defect) throw new Error(defect);
}

/** The fold check of a solid row whose map reads sliders, at their values (see checkFolds). */
export function checkSolid(object: MathObject, consts: Readonly<Record<string, number>>): void {
  const map = solidMaps.get(object);
  if (map) checkFolds(map, consts);
}

const SOLID_FOLDS = 'This solid folds over itself inside its parameter box, so its faces do not bound it.';
const SOLID_PARTIAL =
  'This solid is undefined in part of its parameter box, so its faces do not bound it — give its {…} a default, or split it into solids over the parts where it is defined.';

/**
 * Why the faces of `items` over `names` (each in [0, 1]) do not bound it, or
 * null: the map is undefined (NaN; ∞ is a value too large to draw, not a
 * gap) at some samples but not others, or its Jacobian changes sign inside
 * the box, sampled on a grid that reaches to just inside the faces, by
 * central differences. The sign is read from det J / (|J₁| |J₂| |J₃|), the
 * volume of the unit-scaled columns, so it does not depend on the map's size
 * and differencing noise on a flat solid (det J zero throughout, whose faces
 * still draw it) stays far below the threshold. Zeros on the faces (r = 0 or
 * θ = 0 of a ball) are no fold. A fold or gap narrower than the grid can be
 * missed.
 * Other names in the map (`extra`) take `values`; a map that still does not
 * compile is not checked.
 */
function solidDefect(
  items: readonly Expr[],
  names: readonly string[],
  extra: readonly string[] = [],
  values: readonly number[] = [],
): string | null {
  const n = 7;
  const inset = 1e-3;
  const h = 1e-4;
  let progs: Prog[];
  try {
    const slots = new Map([...names, ...extra].map((name, m) => [name, m]));
    progs = items.map(c => compileProg(c, slots));
  } catch {
    return null;
  }
  const stack = new Float64Array(Math.max(...progs.map(p => p.depth)));
  const p = new Float64Array([0, 0, 0, ...values]);
  const col = (d: number): number[] => {
    const x = p[d];
    p[d] = x + h;
    const f = progs.map(prog => run(prog, p, stack));
    p[d] = x - h;
    const g = progs.map(prog => run(prog, p, stack));
    p[d] = x;
    return f.map((y, m) => (y - g[m]) / (2 * h));
  };
  let negative = false;
  let positive = false;
  let defined = false;
  let gap = false;
  for (let i = 0; i < n; i++)
    for (let j = 0; j < n; j++)
      for (let k = 0; k < n; k++) {
        [i, j, k].forEach((s, m) => (p[m] = inset + ((1 - 2 * inset) * s) / (n - 1)));
        if (progs.some(prog => Number.isNaN(run(prog, p, stack)))) {
          gap = true;
          continue;
        }
        defined = true;
        const [a, b, c] = [col(0), col(1), col(2)];
        const det =
          a[0] * (b[1] * c[2] - b[2] * c[1]) - a[1] * (b[0] * c[2] - b[2] * c[0]) + a[2] * (b[0] * c[1] - b[1] * c[0]);
        const volume = det / (Math.hypot(...a) * Math.hypot(...b) * Math.hypot(...c));
        if (volume < -1e-6) negative = true;
        if (volume > 1e-6) positive = true;
        if (negative && positive) return SOLID_FOLDS;
      }
  return defined && gap ? SOLID_PARTIAL : null;
}

/**
 * A row in x and y over one interval: the family of its members, drawn as
 * the region they sweep — `a = interval(1, 2)`; `y = sin(a x)` is every
 * (x, y) that some a ∈ [1, 2] puts on its curve (docs/multisets.md §5). The
 * interval becomes u over [0, 1], so each residual is F(x, y, u), and a pixel
 * is kept when some u satisfies the relation there: a search along u per
 * pixel (render2d's projFrag), not a draw per member.
 */
function projectedRegion(expr: Expr, hidden: readonly HiddenInterval[], vars: ReadonlySet<string>): MathObject {
  if (hidden.length > 1)
    throw new Error(
      `A row in x and y can range over one interval (this one has ${hidden.length}) — fix the others to a value.`,
    );
  if (vars.has('z')) throw new Error('A family over an interval is drawn in the plane; it cannot use z.');
  if (vars.has('u') || vars.has('v')) throw new Error('Cannot mix u/v with x/y/z.');
  if (usesComplex(expr)) throw new Error('A family over an interval must be real.');
  const swept = replaceIntervals(expr, h => sweep(h, 'u'));
  if (swept.kind === 'eq' && swept.l.kind !== 'vec' && swept.r.kind !== 'vec')
    return {
      kind: 'region',
      form: 'projected',
      relation: 'eq',
      constraints: [{ residual: { kind: 'bin', op: '-', a: swept.l, b: swept.r }, strict: false }],
    };
  if (swept.kind === 'ineq') {
    const comps = ineqComparisons(swept);
    if (new Set(comps.map(c => c.op[0])).size > 1) throw new Error('Chained inequalities must point the same way.');
    return {
      kind: 'region',
      form: 'projected',
      relation: 'ineq',
      constraints: comps.map(c => {
        const [lo, hi] = c.op[0] === '<' ? [c.l, c.r] : [c.r, c.l];
        return { residual: { kind: 'bin', op: '-', a: lo, b: hi }, strict: c.op.length === 1 };
      }),
    };
  }
  throw new Error(
    'A field in x and y cannot range over an interval — set it equal to something for the region its family sweeps, like y = sin(a x).',
  );
}

/** classify, also handing back the equation a revolve(…) row desugared to
 *  (`surface`) — the one place that desugaring happens, after coordinate
 *  fields have expanded, so a field hiding y or z is seen for what it is. */
function classifyLowered(
  expr: Expr,
  defined: ReadonlySet<string>,
  fields: Record<string, Expr>,
  timeDerivative?: (e: Expr) => Expr,
): { cls: Classified } {
  // streamlines(M): the matrix field it wraps, drawn along its major
  // eigenvector. Nothing else has streamlines to draw.
  if (expr.kind === 'call' && expr.name === STREAMLINES_CALL) {
    const { cls } = classifyLowered(expr.args[0], defined, fields, timeDerivative);
    if (cls.object.kind !== 'tensor-field') throw new Error(STREAMLINES_USAGE);
    return { cls: { ...cls, object: { ...cls.object, streamlines: true } } };
  }
  if (expr.kind === 'family') {
    // Figures are CPU-drawn from a few numbers each; everything else is a draw
    // call (or a shader pass) per member.
    const figures = expr.members.every(e => e.kind === 'figure');
    const limit = figures ? 1024 : 32;
    if (!expr.members.length || expr.members.length > limit)
      throw new Error(`An object family needs 1–${limit} members.`);
    // A figure is drawn from its vertices however large they are, so a figure
    // family is limited by its size in all: a turn about a slider-dependent
    // axis stays symbolic, and a hundred such cubes still draw.
    if (figures ? exceedsNodes(expr.members, FIGURE_FAMILY_NODES) : expr.members.some(e => exceedsNodes(e, 8192))) {
      throw new Error(
        figures
          ? `This object family is too large to render (${FIGURE_FAMILY_NODES} nodes in all) — draw fewer members.`
          : 'A family element is too large to render (8192 nodes).',
      );
    }
    const members = expr.members.map((e, i) => {
      try {
        return classifyLowered(e, defined, fields, timeDerivative).cls;
      } catch (err) {
        throw new Error(`Family element ${i + 1}: ${err instanceof Error ? err.message : err}`);
      }
    });
    const first = publicKind(members[0].object);
    const unsupported = new Set([
      'family',
      'scalar2d',
      'rgb2d',
      'hsl2d',
      'oklch2d',
      'domain2d',
      'complex2d',
      'conformal2d',
      'fractal2d',
      'density',
      'pmf',
      'prob',
      'expect',
      'trail',
      'label',
    ]);
    if (first === 'scalar2d')
      throw new Error(
        'A family of scalar fields cannot be drawn — for curves write y = …, or pick one member, like L[k].',
      );
    if (first === 'solid')
      throw new Error('A list of solids cannot be drawn yet — write each solid on a row of its own.');
    if (first === 'scalar3d')
      throw new Error(
        'A family of fields in space cannot be drawn — for nested level surfaces write f(x, y, z) = [1..5], or pick one member, like L[k].',
      );
    if (unsupported.has(first))
      throw new Error(`Families of ${first} do not superimpose meaningfully — select a list element L[k] instead.`);
    const odd = members.findIndex(m => publicKind(m.object) !== first || m.needs3D !== members[0].needs3D);
    // `y = [1, i] x`: a complex member is a complex equation, solved for
    // points, where the real ones draw curves.
    if (odd >= 0 && usesComplex(expr.members[odd]) !== usesComplex(expr.members[0])) {
      const complex = usesComplex(expr.members[0]) ? 0 : odd;
      const real = complex === 0 ? odd : 0;
      throw new Error(
        `Family element ${complex + 1} is complex where element ${real + 1} is not, so it draws a different kind of object — a list of complex numbers draws as points on a row of its own.`,
      );
    }
    if (odd >= 0) throw new Error(`Family element ${odd + 1} has a different object kind or dimension.`);
    // An implicit surface is raymarched across the whole screen, once per
    // member, and a curve of intersection or a field in space is traced on
    // the worker, again per member (a field every 50 ms while it animates),
    // so their families stay small. Parametric curves, points and meshes in
    // space cost what they do in the plane, and share the plane's limit.
    if (first === 'implicit3d' && members.length > 8)
      throw new Error('A family of implicit surfaces has at most 8 members — each is raymarched across the screen.');
    if ((first === 'spacecurve' || first === 'vfield3d') && members.length > 8)
      throw new Error(
        `A family of ${first === 'spacecurve' ? 'curves of intersection' : 'fields in space'} has at most 8 members — each is traced on its own.`,
      );
    const shaders = new Set(['implicit2d', 'ineq2d', 'implicit3d', 'psurface', 'vfield2d']);
    let shared: { classified: Classified; index: string } | undefined;
    if (shaders.has(first)) {
      let index = 'eqioFamilyIndex';
      while (defined.has(index) || expr.members.some(e => freeVars(e).has(index))) index += 'X';
      // Members already describe the post-field/post-desugaring math; source
      // merging here retains the same desugaring pass before GPU compilation.
      const merged = familyTemplate(expr.members, index);
      if (exceedsNodes(merged, 32768)) throw new Error('The shared family program is too large (32768 nodes).');
      shared = { classified: classifyLowered(merged, new Set([...defined, index]), fields, timeDerivative).cls, index };
    }
    return {
      cls: {
        object: { kind: 'family', members, shared },
        animated: members.some(m => m.animated),
        needs3D: members.some(m => m.needs3D),
        params: [...new Set(members.flatMap(m => m.params))],
      },
    };
  }
  const misread = hasConditions(fields) && conditionAsValue(expr, fields);
  if (misread) throw new Error(`${misread} is a condition, not a number — read it in braces, like {${misread}: 1}.`);
  const coordinate = coordinateRow(expr, fields);
  expr = lowerCoordinateFlow(expr, fields, timeDerivative);
  const ode = matchODE(expr);
  if (ode) expr = ode;
  const tube = matchTube(expr);
  if (tube) expr = tube.inner;
  const surface = matchRevolve(expr) ?? undefined;
  if (surface) expr = surface;
  const special = expr.kind === 'call' && SPECIAL_FORMS.has(expr.name) ? expr.name : undefined;
  const nested = nestedSpecial(expr, true);
  if (nested) throw new Error(`${nested === '[trail]' ? 'trail' : nested}(…) must be the whole expression.`);
  const vars = freeVars(expr);
  if (tube) {
    const r = tube.radius;
    if (
      r.kind === 'vec' ||
      r.kind === 'list' ||
      r.kind === 'eq' ||
      r.kind === 'ineq' ||
      usesComplex(r) ||
      hasInterval(r)
    ) {
      throw new Error('The tube radius must be a single real number.');
    }
    // The radius was split off before the root-only check below, so whole-
    // expression forms hiding inside it need their own rejection.
    const form = nestedSpecial(r);
    if (form) throw new Error(`${form}(…) must be the whole expression.`);
    // The radius sweeps one circle for the whole tube, so it may vary with
    // time and sliders but not along the curve or across space.
    for (const v of freeVars(r)) {
      if (SPACE_VARS.has(v) || PARAM_VARS.has(v)) {
        throw new Error('The tube radius can only use constants, sliders, and t.');
      }
      vars.add(v);
    }
  }
  vars.delete('i');
  // iter binds z as the iterate: z ↦ step(z) starting from the seed.
  if (special === 'iter') vars.delete('z');
  if (vars.delete('w')) {
    vars.add('x');
    vars.add('y');
  }
  const params: string[] = [];
  for (const v of [...vars]) {
    if (defined.has(v)) {
      params.push(v);
      vars.delete(v);
    }
  }
  params.sort();
  for (const v of vars) {
    if (!SPACE_VARS.has(v) && !PARAM_VARS.has(v) && v !== 't') {
      if (v.endsWith("'")) throw new Error(`${v} can only appear on the left of an ODE like y' = x - y.`);
      if (v === 'd' || /^d[A-Za-z]$/.test(v)) throw new Error('Write derivatives as d/dx (…).');
      const fn = builtinFn(v);
      if (fn) throw new Error(`${v} is a function — write it with parentheses, e.g. ${fn}(x).`);
      throw new Error(`Unknown variable: ${v}. Define "${v} = 1" to make a slider.`);
    }
  }
  // Continuous intervals (lib/interval.ts). Beside x and y an interval makes
  // the row a family over it, drawn as the region the family sweeps; anywhere
  // else it is one more sampling parameter, swept over [0, 1] like u and v.
  const hidden = intervalsIn(expr);
  if (hidden.length) {
    if (special) throw new Error(`Cannot use an interval in ${special}(…).`);
    // A parametric system, `(x, y) = (cos(s), sin(s))`, sweeps its one
    // interval as it does u.
    const system =
      expr.kind === 'eq' && expr.l.kind === 'vec' && hidden.length === 1 && !vars.has('u') && !vars.has('v');
    if (!system && (vars.has('x') || vars.has('y') || vars.has('z'))) {
      const object = projectedRegion(expr, hidden, vars);
      return { cls: { object, animated: vars.has('t'), needs3D: false, params } };
    }
    if (expr.kind === 'list') throw new Error('An interval cannot be an item of a list — write it in a tuple.');
    const free = [...PARAM_VARS].filter(p => !vars.has(p));
    const swept = hidden.length + 2 - free.length;
    if (swept === 3 && expr.kind === 'vec' && expr.items.length === 3) {
      if (tube) throw new Error('tube(…) takes a curve; this is a solid over three parameters.');
      // The faces are this row's own surfaces, not a family the user wrote:
      // their errors are the row's.
      let cls: Classified;
      let map: SolidMap;
      try {
        const faces = solidFaces(expr, hidden, vars, defined);
        map = faces.map;
        cls = classifyLowered(faces.family, defined, fields, timeDerivative).cls;
      } catch (err) {
        throw new Error((err instanceof Error ? err.message : String(err)).replace(/^Family element \d+: /, ''));
      }
      const object: MathObject = { ...(cls.object as MathObject & { kind: 'family' }), solid: true };
      solidMaps.set(object, map);
      return { cls: { ...cls, object } };
    }
    if (hidden.length > free.length)
      throw new Error(
        `A row can sweep at most two parameters (intervals, u and v), or three in a point in space — this one has ${swept}.`,
      );
    const slot = new Map(hidden.map((h, k) => [h.key, free[k]]));
    expr = replaceIntervals(expr, h => sweep(h, slot.get(h.key)!));
    for (const p of slot.values()) vars.add(p);
  }
  const animated = vars.has('t');
  const hasParam = vars.has('u') || vars.has('v');
  const hasSpace = vars.has('x') || vars.has('y') || vars.has('z');
  const paramSystem = expr.kind === 'eq' && expr.l.kind === 'vec' && vars.has('u') && !vars.has('v');
  if (hasParam && hasSpace && !paramSystem) throw new Error('Cannot mix u/v with x/y/z.');
  // A bare complex expression in u alone is a path in the plane (below);
  // every other complex use of u, v, or z has no 2D reading.
  const scalar = expr.kind !== 'vec' && expr.kind !== 'list' && expr.kind !== 'eq' && expr.kind !== 'ineq';
  const complexPath = usesComplex(expr) && scalar && !special && !tube && vars.has('u') && !vars.has('v');
  // (Vectors, lists, and domain(…)-style forms each say below what they take.)
  if (usesComplex(expr) && hasParam && !complexPath && !special && expr.kind !== 'vec' && expr.kind !== 'list') {
    throw new Error('A complex path is a bare expression in u alone, like exp(i 2 pi u).');
  }
  if (usesComplex(expr) && vars.has('z')) {
    throw new Error('Complex expressions plot in 2D only (x, y, w).');
  }

  const done = (object: MathObject): { cls: Classified } => ({
    cls: {
      object,
      animated: animated || (object.kind === 'vector-field' && object.components.length === 2),
      needs3D: objectNeeds3D(object),
      params,
    },
  });

  // action(M): what the matrix does to the unit square, circle and axes,
  // drawn, with the matrix read out; over a multiset of matrices, each one's
  // picture in one figure family, and each matrix read out.
  const acting = expr.kind === 'list' ? expr.items.map(actionOfNode) : [actionOfNode(expr)];
  if (acting.some(m => m !== null)) {
    if (acting.some(m => m === null)) throw new Error('action draws matrices only — every element must be one.');
    const ms = acting as Expr[][][];
    const n = ms[0].length;
    if (ms.some(m => m.length !== n))
      throw new Error('action draws a multiset of one size — all 2×2 or all 3×3, not both.');
    if (hasSpace || hasParam)
      throw new Error('action takes a constant matrix — sliders and t are fine, x, y, u and v are not.');
    const readout = done({
      kind: 'tuple',
      values: ms.flatMap(m => m.flat()),
      shape: [n, n],
      ...(expr.kind === 'list' && { count: ms.length }),
    });
    const glyphs = ms.map(m => actionGlyphs(m));
    if (glyphs.flat().length > FIGURE_FAMILY_MAX) {
      const most = Math.floor(FIGURE_FAMILY_MAX / glyphs[0].length);
      throw new Error(`action draws at most ${most} ${n}×${n} matrices at once (got ${ms.length}).`);
    }
    const drawn = classifyLowered({ kind: 'family', members: glyphs.flat() }, defined, fields, timeDerivative).cls;
    return withReadout(drawn, readout.cls);
  }

  // A multivector on a row of its own draws grade by grade, and reads out its
  // value (docs/clifford.md); a multiset of them draws and reads out each.
  const mvs = expr.kind === 'list' && expr.items.length ? expr.items.map(mvOfNode) : [mvOfNode(expr)];
  if (mvs.every(m => m !== null)) {
    if (hasSpace || hasParam) {
      throw new Error(
        'A multivector in x, y, z, u or v has no picture yet — take a part of it, like grade(A, 1), to draw a field or a curve.',
      );
    }
    const dim = mvs.some(m => m.dim === 3) ? 3 : 2;
    const quat = mvs.every(m => m.quat);
    // A plane member lifts into space unchanged: its blades keep their bitmasks.
    const lifted = mvs.map((m): Multivector => ({
      ...m,
      dim,
      data: Array.from({ length: 1 << dim }, (_, k): Expr => m.data[k] ?? { kind: 'num', value: 0 }),
    }));
    const values = lifted.flatMap(m => m.data);
    const readout = done({
      kind: 'tuple',
      values,
      blades: { dim, ...(quat ? { quat: true as const } : {}) },
      ...(expr.kind === 'list' && { count: mvs.length }),
    });
    // Each member draws as it would on a row of its own, over one another.
    // A quaternion that is only a number (i i = -1) has nothing to draw.
    const glyphs = lifted.flatMap(m => multivectorGlyphs(m));
    if (!glyphs.length) return readout;
    const drawn = classifyLowered({ kind: 'family', members: glyphs }, defined, fields, timeDerivative).cls;
    return withReadout(drawn, readout.cls);
  }

  // A point, line or plane of projective geometry draws as the set of points
  // it is, and reads out what it is (docs/pga.md); a multiset of them draws
  // each.
  const flats = expr.kind === 'list' && expr.items.length ? expr.items.map(flatOfNode) : [flatOfNode(expr)];
  if (flats.every(f => f !== null)) {
    if (hasSpace || hasParam) {
      throw new Error(
        'A point, line or plane in x, y, z, u or v has no picture — build it from points, sliders and t.',
      );
    }
    const [{ dim, grade }] = flats;
    if (flats.some(f => f.dim !== dim || f.grade !== grade))
      throw new Error('A multiset mixes points, lines or planes — give each kind a row of its own.');
    const readout = done({
      kind: 'tuple',
      values: flats.flatMap(f => f.data),
      flat: { dim, grade },
      ...(expr.kind === 'list' && { count: flats.length }),
    });
    const drawn = classifyLowered(
      { kind: 'family', members: flats.map(flatFigure) },
      defined,
      fields,
      timeDerivative,
    ).cls;
    return withReadout(drawn, readout.cls);
  }

  // A matrix or tensor on a row of its own — or a multiset of them — has no
  // position, so it is drawn as its values: a readout (docs/multisets.md §5).
  const tensors = expr.kind === 'list' && expr.items.length ? expr.items.map(tensorOfNode) : [tensorOfNode(expr)];
  if (tensors.every(t => t !== null)) {
    // A 2×2 matrix over the plane is a tensor field, drawn as glyphs.
    const [only] = tensors;
    if (
      hasSpace &&
      !hasParam &&
      !vars.has('z') &&
      tensors.length === 1 &&
      expr.kind !== 'list' &&
      only.shape.length === 2 &&
      only.shape[0] === 2 &&
      only.shape[1] === 2
    ) {
      if (usesComplex(expr)) throw new Error('A matrix field must be real.');
      return done({ kind: 'tensor-field', entries: only.data as [Expr, Expr, Expr, Expr] });
    }
    if (hasSpace || hasParam) {
      throw new Error(
        'Only a 2×2 matrix in x and y draws as a field; a larger one has no picture yet — apply it to a vector, like M (x, y, z).',
      );
    }
    const shape = tensors[0].shape;
    return done({
      kind: 'tuple',
      values: tensors.flatMap(t => t.data),
      shape,
      ...(expr.kind === 'list' && { count: tensors.length }),
    });
  }

  if (
    (expr.kind === 'eq' || expr.kind === 'ineq') &&
    expr.l.kind !== 'vec' &&
    expr.r.kind !== 'vec' &&
    !hasSpace &&
    !hasParam
  )
    return done({ kind: 'note', expr, variable: animated || params.length > 0 });
  // `d^2/dt^2 f(x, t) = c^2 ∇^2 f(x, t)`: an equation whose sides agree
  // everywhere has no curve to draw — it is a claim, and it holds.
  if (
    expr.kind === 'eq' &&
    expr.l.kind !== 'vec' &&
    expr.r.kind !== 'vec' &&
    hasSpace &&
    !hasParam &&
    !usesComplex(expr) &&
    holdsEverywhere(expr)
  ) {
    return done({ kind: 'note', expr, variable: false, identity: true });
  }

  if (expr.kind === 'trail') {
    if (
      hasSpace ||
      hasParam ||
      usesComplex(expr) ||
      expr.coordinates.some(c => c.kind === 'data' || c.kind === 'list')
    ) {
      throw new Error('trail needs a real point using constants, states, and t; use u for a parametric curve.');
    }
    return done({ kind: 'trail', coordinates: components(expr.coordinates) });
  }

  if (expr.kind === 'label') {
    if (
      hasSpace ||
      hasParam ||
      usesComplex(expr) ||
      expr.coordinates.some(c => c.kind === 'data' || c.kind === 'list')
    ) {
      throw new Error('label needs a real point using constants, points, sliders, and t: label((1, 2), "peak").');
    }
    return done({ kind: 'label', coordinates: components(expr.coordinates), text: expr.text });
  }

  // Desugared segment()/polyline()/vector()/polygon()/square(): CPU-evaluated
  // each frame with the constants' original names, like points and parametric
  // curves.
  const figureName = expr.kind === 'figure' ? `[${expr.form}]` : '';
  const figure = Object.hasOwn(FIGURES, figureName) ? FIGURES[figureName] : undefined;
  if (expr.kind === 'figure' && figure) {
    if (hasSpace || hasParam) {
      throw new Error(`${figure.what} must be constant — they cannot use x, y, u, or v.`);
    }
    const count = expr.over ? expr.over[0].values.length : expr.vertices.length / expr.dimension;
    if (expr.form === 'hull' && expr.dimension === 3 && count > HULL_3D_MAX) {
      throw new Error(`A 3D hull takes at most ${HULL_3D_MAX} points (got ${count}).`);
    }
    return done({
      kind: 'figure',
      form: expr.form,
      dimension: expr.dimension,
      vertices: expr.vertices,
      ...(expr.over ? { over: expr.over } : {}),
    });
  }

  if (expr.kind === 'text' || expr.kind === 'str') {
    throw new Error('Text cannot be plotted — compare it inside a filter, like people[people.city == "NYC"].');
  }
  // Typed-array lists: a column plots with nothing to evaluate at all.
  if (expr.kind === 'hist')
    return done({ kind: 'histogram', centers: expr.centers, counts: expr.counts, width: expr.width });
  if (expr.kind === 'data') return done({ kind: 'list', element: 'scalar', storage: 'packed', values: expr.values });
  if (expr.kind === 'vec' && expr.items.some(it => it.kind === 'data')) {
    const n = (expr.items.find(it => it.kind === 'data') as Expr & { kind: 'data' }).values.length;
    if (expr.items.length !== 2 && expr.items.length !== 3) {
      throw new Error('Expected 2 or 3 vector components.');
    }
    // A scalar coordinate rides along as a constant column: (col, 0) is a
    // row of points on the axis.
    const coords = expr.items.map(it => {
      if (it.kind === 'data') return it.values;
      if (it.kind !== 'num') throw new Error('A point mixing data with an expression is not supported yet.');
      return new Float64Array(n).fill(it.value);
    });
    return done({
      kind: 'list',
      element: 'point',
      storage: 'packed',
      dimension: expr.items.length as 2 | 3,
      coordinates: coords,
    });
  }

  if (expr.kind === 'list') {
    for (const v of vars) {
      // (w counts as x and y by now; name the one the row wrote.)
      const found = freeVars(expr).has('w') ? 'w' : v;
      if (v !== 't') throw new Error(`A list may only use constants and t (found ${found}).`);
    }
    // One complex member makes the list complex, as one complex term makes
    // a sum complex: the type is the list's, so 1 in [1, i] is 1 + 0i.
    // Members that only pass through complex values (re(…), |…|) are real.
    if (expr.items.some(it => it.kind !== 'vec' && isComplexValued(it))) {
      if (expr.items.some(it => it.kind === 'vec')) throw new Error('Lists cannot mix complex numbers and points.');
      return done({ kind: 'list', element: 'complex', storage: 'expressions', values: expr.items });
    }
    // A point's coordinates are real, in a list as on a row of its own.
    if (expr.items.some(it => it.kind === 'vec' && it.items.some(isComplexValued)))
      throw new Error('Complex values are not supported in vectors.');
    const vecs = expr.items.filter((it): it is Expr & { kind: 'vec' } => it.kind === 'vec');
    if (vecs.length === 0) return done({ kind: 'list', element: 'scalar', storage: 'expressions', values: expr.items });
    if (vecs.length !== expr.items.length) throw new Error('Lists cannot mix numbers and points.');
    const dims = new Set(vecs.map(it => it.items.length));
    if (dims.size > 1) throw new Error('All points in a list need the same number of coordinates.');
    return done({
      kind: 'list',
      element: 'point',
      storage: 'expressions',
      dimension: vecs[0].items.length as 2 | 3,
      values: vecs.map(it => it.items),
    });
  }

  const g = expr;

  if (special) {
    if (vars.has('z')) throw new Error(`Use w (= x + iy) in ${special}(…); z is the 3D axis.`);
    if (vars.has('u') || vars.has('v')) throw new Error(`Cannot use u/v in ${special}(…).`);
    const call = g as Expr & { kind: 'call' };
    if (special === 'rgb' || special === 'hsl' || special === 'oklch') {
      const usage =
        special === 'rgb'
          ? 'rgb(red, green, blue, opacity?), each from 0 to 1'
          : special === 'hsl'
            ? 'hsl(hue in radians, saturation 0–1, lightness 0–1, opacity?)'
            : 'oklch(lightness 0–1, chroma, hue in radians, opacity?)';
      if (call.args.length !== 3 && call.args.length !== 4)
        throw new Error(`${special} takes three channels and an optional opacity: ${usage}.`);
      for (const channel of call.args) {
        if (channel.kind === 'ineq' || channel.kind === 'eq')
          throw new Error(`${special} channels must be real numbers, not comparisons: ${usage}.`);
        if (inferScalarType(channel) !== 'real')
          throw new Error(`${special} channels must be real numbers; use re, im, abs, or arg for complex values.`);
      }
      return done({ kind: 'color-field', space: special, channels: call.args });
    }
    if (special === 'iter') {
      if (call.args.length < 1 || call.args.length > 2) {
        throw new Error('iter takes iter(step) or iter(step, count).');
      }
      let maxIter = 250;
      if (call.args.length === 2) {
        try {
          maxIter = evaluate(call.args[1], {});
        } catch {
          throw new Error('The iteration count must be a plain number.');
        }
        if (!isFinite(maxIter) || maxIter < 1) throw new Error('The iteration count must be at least 1.');
        maxIter = Math.min(5000, Math.round(maxIter));
      }
      inferScalarType(call.args[0], { z: 'complex' });
      // The pixel enters either as a parameter (w/x/y in the step → seed 0,
      // the Mandelbrot convention) or as the seed (fixed map → Julia set).
      const bodyVars = freeVars(call.args[0]);
      const seed = bodyVars.has('w') || bodyVars.has('x') || bodyVars.has('y') ? 'zero' : 'pixel';
      return done({ kind: 'complex-field', form: 'fractal', step: call.args[0], seed, maxIter });
    }
    if (call.args.length !== 1) throw new Error(`${special} takes one argument.`);
    const typed = inferScalarType(call.args[0]);
    if (typed !== 'complex') {
      throw new Error(`${special}(…) needs a complex expression — use w for x + iy.`);
    }
    return done({ kind: 'complex-field', form: special === 'domain' ? 'domain' : 'conformal', expr: call.args[0] });
  }

  if (expr.kind === 'vec') {
    // sort(S, re(S)) of a complex list: its members in order, a tuple.
    if (expr.items.every(isComplexValued))
      throw new Error(
        'A tuple of complex numbers has no picture yet — a list of them draws as points, and T[k] picks one.',
      );
    if (usesComplex(expr)) throw new Error('Complex values are not supported in vectors.');
    // Longer than a point: values at positions, shown as a readout.
    if (expr.items.length > 3) {
      if (hasSpace || hasParam || expr.items.some(it => it.kind === 'vec'))
        throw new Error('A tuple of more than 3 values is a value to read, not a picture: (1, 2, 3, 5, 8).');
      return done(
        expr.items.length > TUPLE_SHOWN
          ? { kind: 'tuple', values: expr.items.slice(0, TUPLE_SHOWN), length: expr.items.length }
          : { kind: 'tuple', values: expr.items },
      );
    }
    const dim = expr.items.length as 2 | 3;
    if (hasSpace || ode) {
      if (hasParam) throw new Error('Vector fields cannot use u or v.');
      if (dim === 3) return done({ kind: 'vector-field', components: components(expr.items) });
      if (vars.has('z')) throw new Error('A field using z needs three components.');
      if (dim !== 2) throw new Error('A vector field needs exactly 2 components.');
      return done({ kind: 'vector-field', components: components(expr.items) });
    }
    if (vars.has('v') && !vars.has('u')) throw new Error('Parametric surfaces use u (and v).');
    if (vars.has('u') && vars.has('v')) {
      // Two parameters in the plane fill the region they trace.
      if (dim === 2) return done({ kind: 'region', form: 'parametric', coordinates: [expr.items[0], expr.items[1]] });
      if (dim !== 3) throw new Error('A parametric surface needs 3 components.');
      return done({ kind: 'surface', form: 'parametric', coordinates: expr.items as [Expr, Expr, Expr] });
    }
    if (vars.has('u'))
      return done({
        kind: 'curve',
        form: 'parametric',
        source: { representation: 'real', coordinates: components(expr.items) },
        tube: tube?.radius,
      });
    if (tube) throw new Error('tube(…) needs a curve in u, like tube((cos(u), sin(u), u/4)).');
    return done({ kind: 'point', source: { representation: 'real', coordinates: components(expr.items) } });
  }

  // A complex-valued expression in u is the image of a path: its real and
  // imaginary parts are an ordinary 2D parametric curve in the Argand plane
  // (the plane of w = x + iy, where complex points and roots already sit).
  if (complexPath) {
    // Sized before anything walks it: typing and splitting a huge inlined
    // composition would cost seconds just to learn it cannot be sampled.
    if (exceedsNodes(expr, SPLIT_NODE_BUDGET)) throw new Error(tooLarge('path', 'sample'));
    // An expression that mentions i but is real (|exp(i u)|) traces nothing
    // in the plane: it is a number for each u, and the row says so.
    if (inferScalarType(g) !== 'complex') {
      throw new Error(
        'This is a real number for each u, not a path — a complex path needs an imaginary part, like exp(i 2 pi u); for a real curve write (u, …).',
      );
    }
    return done({ kind: 'curve', form: 'parametric', source: { representation: 'complex', expr } });
  }
  // (A bare real row in u, v is a random draw — analysis renames them first.)
  if (hasParam && !paramSystem)
    throw new Error(
      hidden.length
        ? 'An interval traces a curve or region in a tuple, like (r cos(2 pi u), r sin(2 pi u)); a number alone draws its density.'
        : 'u and v trace a curve or surface in a tuple, like (cos(u), sin(u)) or (u, v, u v); to set the range one runs over, define it as an interval: u = interval(0, 2pi).',
    );

  // A vector equation is a system, one residual per component: F(x,y,z) =
  // (a, b, c) is the fiber of a map, (f, g) = (0, 0) an intersection of
  // curves. Square systems (as many equations as unknowns) cut out isolated
  // points; the solver finds them numerically.
  if (expr.kind === 'eq' && (expr.l.kind === 'vec' || expr.r.kind === 'vec')) {
    const { l, r } = expr;
    if (l.kind !== 'vec' || r.kind !== 'vec') {
      throw new Error('A vector equation needs components on both sides, like (f, g) = (0, 0).');
    }
    if (l.items.length !== r.items.length) {
      throw new Error(`Mismatched components: ${l.items.length} on the left, ${r.items.length} on the right.`);
    }
    if (usesComplex(expr)) throw new Error('Complex values are not supported in systems.');
    const dim = vars.has('z') ? 3 : 2;
    if (l.items.length === 2 && dim === 3 && !hasParam)
      return done({
        kind: 'intersection',
        residuals: l.items.map((a, k): Expr => {
          const residual: Expr = { kind: 'bin', op: '-', a, b: r.items[k] };
          return a.kind === 'call' &&
            (a.name === 'atan2' || a.name === ANGLE_FN || (a.name === 'atan' && a.args.length === 2))
            ? {
                kind: 'call',
                name: 'atan2',
                args: [
                  { kind: 'call', name: 'sin', args: [residual] },
                  { kind: 'call', name: 'cos', args: [residual] },
                ],
              }
            : residual;
        }) as [Expr, Expr],
      });
    if (l.items.length !== dim) {
      const eqs = `${l.items.length} equation${l.items.length === 1 ? '' : 's'}`;
      throw new Error(`${eqs} in ${dim} unknowns — a system needs one equation per unknown.`);
    }
    const residuals = l.items.map((a, k): Expr => ({ kind: 'bin', op: '-', a, b: r.items[k] }));
    // (Dragging writes the pointer's chart coordinates back, and a pointer
    // ray does not determine a point in space: planar rows only.)
    const positional =
      coordinate &&
      dim === 2 &&
      !hasParam &&
      !coordinate.rhs.some(e => [...freeVars(e)].some(v => ['x', 'y', 'z'].includes(v) || Object.hasOwn(fields, v)));
    // Only a direct angle coordinate — atan2, or the angle(…) measurement —
    // is periodic; nesting one inside a real expression does not make that
    // expression an angle.
    return done({
      kind: 'system',
      source: { representation: 'real', residuals: components(residuals) },
      angular: l.items.map(
        e =>
          e.kind === 'call' &&
          (e.name === 'atan2' || e.name === ANGLE_FN || (e.name === 'atan' && e.args.length === 2)),
      ),
      ...(paramSystem ? { parametric: true } : {}),
      ...(positional ? { coordinates: coordinate.coords } : {}),
    });
  }

  if (g.kind === 'ineq') {
    if (vars.has('z')) throw new Error('Inequalities are 2D only.');
    const comps = ineqComparisons(g);
    if (new Set(comps.map(c => c.op[0])).size > 1) {
      throw new Error('Chained inequalities must point the same way.');
    }
    const constraints = comps.map(c => {
      const [lo, hi] = c.op[0] === '<' ? [c.l, c.r] : [c.r, c.l];
      const residual: Expr = { kind: 'bin', op: '-', a: lo, b: hi };
      if (inferScalarType(residual) === 'complex')
        throw new Error('Complex inequality: compare re(…) or im(…) instead.');
      return { residual, strict: c.op.length === 1 };
    });
    return done({ kind: 'region', constraints });
  }

  if (g.kind === 'eq') {
    if (inferScalarType(g.l) === 'complex' || inferScalarType(g.r) === 'complex') {
      if (!hasSpace) throw new Error('A constant complex comparison has no isolated roots — use w as the unknown.');
      return done({ kind: 'system', source: { representation: 'complex', equation: expr } });
    }
    const residual: Expr = { kind: 'bin', op: '-', a: g.l, b: g.r };
    if (vars.has('z')) return done({ kind: 'surface', form: 'implicit', residual, equation: expr });
    const graphRhs = isVarNamed(g.l, 'y') ? g.r : isVarNamed(g.r, 'y') ? g.l : undefined;
    if (graphRhs && !freeVars(graphRhs).has('y') && !freeVars(graphRhs).has('w')) {
      return done({
        kind: 'curve',
        form: 'graph',
        rhs: graphRhs,
        equation: expr,
        levels: levelFamily(expr, params, defined),
      });
    }
    return done({
      kind: 'curve',
      form: 'implicit',
      residual,
      equation: expr,
      levels: levelFamily(expr, params, defined),
    });
  }

  // Bare scalar expression: typing does not generate shader text.
  const inferred = inferScalarType(g);
  if (inferred === 'complex') {
    if (!hasSpace && !hasParam) return done({ kind: 'point', source: { representation: 'complex', expr } });
    return done({ kind: 'complex-field', form: 'potential', expr });
  }
  // A scalar that depends on the screen's x and y is drawn at every pixel —
  // `sin(x)` too, constant along y. There is no implicit graph: the curve is
  // `y = sin(x)`, and the surface of a field in space is `f = 0`. In space
  // the field is a translucent cloud, denser where it is larger.
  if (vars.has('z')) return done({ kind: 'scalar-field', expr, dimension: 3 });
  if (hasSpace) return done({ kind: 'scalar-field', expr });
  return done({ kind: 'value', expr });
}

/** Whether a document's fields hold a named condition, asked once per document. */
const conditionsIn = new WeakMap<object, boolean>();
function hasConditions(fields: Record<string, Expr>): boolean {
  let held = conditionsIn.get(fields);
  if (held === undefined) conditionsIn.set(fields, (held = Object.values(fields).some(e => e.kind === 'ineq')));
  return held;
}

/**
 * A named condition (`within = r < R`, written in with the fields) read as a
 * number — anywhere but a whole row or a piecewise case's condition — which
 * would otherwise surface as a bare "Unexpected inequality" naming nothing.
 */
function conditionAsValue(e: Expr, fields: Record<string, Expr>, whole = true): string | null {
  if (e.kind === 'var') return !whole && fields[e.name]?.kind === 'ineq' ? e.name : null;
  const parts =
    e.kind === 'piecewise'
      ? [
          ...e.cases.flatMap(c => (c.cond.kind === 'var' ? [c.value] : [c.cond, c.value])),
          ...(e.otherwise ? [e.otherwise] : []),
        ]
      : childrenOf(e);
  for (const part of parts) {
    const hit = conditionAsValue(part, fields, false);
    if (hit) return hit;
  }
  return null;
}

/** A stand-in for the integration variable while the integrand is lowered:
 *  no document name can collide with it (it is not an identifier). */
const INT_VAR = '[dx]';

/**
 * Lower and classify a resolved row (lib/defs.ts resolveRow) — THE way a
 * plain row is classified, in the app and in analyze() alike, so neither can
 * miss what rides along: a `value` row that is exactly one definite integral
 * of a real integrand also carries the area it shades.
 *
 * `lower` is the row's geometry/list lowering; `known` the names that have a
 * value each frame. Being a `value` is what makes the bounds constant
 * (sliders, states and t included).
 */
export function classifyRow(
  row: ResolvedRow,
  lower: (e: Expr) => Expr,
  known: ReadonlySet<string>,
  fields: Record<string, Expr> = {},
  timeDerivative?: (e: Expr) => Expr,
): { cls: Classified } {
  // A tuple of numbers is shown as what it is (see tupleRow). A long one of
  // packed numbers — a sorted column — keeps only what its readout shows,
  // rather than a node per value.
  const low = lower(row.expr);
  const packed = packedTuple(low);
  if (packed) {
    const values = Array.from(packed.subarray(0, TUPLE_SHOWN), (value): Expr => ({ kind: 'num', value }));
    const object: MathObject = { kind: 'tuple', values, length: packed.length };
    return { cls: { object, animated: false, needs3D: false, params: [] } };
  }
  // A multiset of longer tuples reads out, as a multiset of matrices does.
  const tuples = tupleMultiset(low);
  if (tuples && !tuples.values.some(v => [...freeVars(v)].some(n => ['x', 'y', 'z', 'u', 'v', 't'].includes(n)))) {
    const object: MathObject = { kind: 'tuple', values: tuples.values, shape: [tuples.width], count: tuples.count };
    return { cls: { object, animated: false, needs3D: false, params: [] } };
  }
  const lowered = tupleRow(low);
  // A revolve(…) row hands back the surface it draws, not a call nothing
  // evaluates.
  const { cls } = classifyLowered(lowered, known, fields, timeDerivative);
  if (cls.object.kind === 'value' && row.integral) {
    const shade = lowerShade(row.integral, lower, known);
    if (shade) return { cls: { ...cls, object: { ...cls.object, shade } } };
  }
  return { cls };
}

function lowerShade(int: IntShade, lower: (e: Expr) => Expr, known: ReadonlySet<string>): IntShade | null {
  const { v } = int;
  const isInf = (b: Expr) => {
    const a = b.kind === 'neg' ? b.a : b;
    return a.kind === 'var' && a.name === 'inf';
  };
  try {
    // Inside the integrand v is the bound variable, whatever else the
    // document calls by that name: a slider it merely shadows, but a list or
    // a point would be substituted in by lowering — so it lowers under a
    // stand-in name. In the bounds the name keeps its document meaning.
    const hidden = lower(substVars(int.body, { [v]: { kind: 'var', name: INT_VAR } }));
    const body = substVars(hidden, { [INT_VAR]: { kind: 'var', name: v } });
    const [lo, hi] = [int.lo, int.hi].map(b => (isInf(b) ? b : lower(b)));
    const scalar = (e: Expr) =>
      e.kind !== 'vec' &&
      e.kind !== 'list' &&
      e.kind !== 'data' &&
      e.kind !== 'eq' &&
      e.kind !== 'ineq' &&
      !usesComplex(e);
    if (![body, lo, hi].every(scalar)) return null;
    const free = (e: Expr, bound?: string) => [...freeVars(e)].every(n => n === bound || n === 't' || known.has(n));
    if (!free(body, v) || ![lo, hi].every(b => isInf(b) || free(b))) return null;
    return { body, v, lo, hi };
  } catch {
    return null; // not drawable; the readout is unaffected
  }
}

/**
 * Whether the two sides of an equation agree at every x, y, z, t and slider
 * value — a numerical check, not a proof: they are compared at seeded random
 * points spread over several scales, where both are defined. An ordinary
 * implicit curve fails at the first point; `sin(x)^2 + cos(x)^2 = 1.0001`
 * fails too, since the tolerance is relative rounding error, not 1e-4.
 */
export function holdsEverywhere(e: Expr & { kind: 'eq' }): boolean {
  const names = [...freeVars(e)].filter(n => n !== 'pi' && n !== 'e' && n !== 'tau');
  let seed = 0x9e3779b9;
  const random = (): number => {
    seed = (seed + 0x6d2b79f5) | 0;
    let r = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
  // Magnitudes from 0.1 to 100, either sign: a cutoff like min(x, 10) = x
  // agrees near the origin and nowhere else.
  const sample = (): number => (random() < 0.5 ? -1 : 1) * 10 ** (3 * random() - 1);
  let agreed = 0;
  try {
    for (let k = 0; k < 64 && agreed < 24; k++) {
      const env = Object.fromEntries(names.map(n => [n, sample()]));
      const a = evaluate(e.l, env),
        b = evaluate(e.r, env);
      if (!Number.isFinite(a) || !Number.isFinite(b)) continue;
      if (Math.abs(a - b) > 1e-9 * (1 + Math.abs(a) + Math.abs(b))) return false;
      agreed++;
    }
  } catch {
    return false;
  }
  return agreed >= 24;
}

/** A decided comparison is a note, independent of the view and render mode. */
export function comparisonReadout(plot: Extract<CpuPlan, { type: 'note' }>, env: Record<string, number>): string {
  const e = plot.expr;
  if (plot.identity) return 'Holds everywhere (checked numerically)';
  if (e.kind !== 'eq' && e.kind !== 'ineq') return '';
  let truth: boolean;
  let values: string;
  if (e.kind === 'eq') {
    const parts = (x: Expr) => (usesComplex(x) ? complexParts(x).map(c => evaluate(c, env)) : [evaluate(x, env), 0]);
    const a = parts(e.l),
      b = parts(e.r);
    if (![...a, ...b].every(Number.isFinite)) return 'Undefined comparison';
    truth = a.every((v, k) => v === b[k]);
    const fmt = (p: number[]) =>
      p[1] === 0
        ? String(Number(p[0].toPrecision(6)))
        : `${Number(p[0].toPrecision(6))}${p[1] < 0 ? '' : '+'}${Number(p[1].toPrecision(6))}i`;
    values = `${fmt(a)} ${truth ? '=' : '≠'} ${fmt(b)}`;
  } else {
    const comparisons = ineqComparisons(e);
    const vals = comparisons.map(c => [evaluate(c.l, env), evaluate(c.r, env)]);
    if (!vals.flat().every(Number.isFinite)) return 'Undefined comparison';
    truth = comparisons.every((c, k) => {
      const [a, b] = vals[k];
      return c.op === '<' ? a < b : c.op === '<=' ? a <= b : c.op === '>' ? a > b : a >= b;
    });
    values = comparisons
      .map((c, k) => `${Number(vals[k][0].toPrecision(6))} ${c.op} ${Number(vals[k][1].toPrecision(6))}`)
      .join(', ');
  }
  const verdict = `${plot.variable ? (truth ? 'True now' : 'False now') : truth ? 'Always true' : 'Never true'} (${values})`;
  // `e = 0.6` meant as a slider: the constant cannot be one, so say why the
  // row became a (false) claim instead.
  return plot.constant && !truth ? `${verdict} — ${takenNameHint(plot.constant)}` : verdict;
}

/** One readout per source row, including lists and families of readouts. */
export function plotReadout(plot: CpuPlan, env: Record<string, number>): string | null {
  if (plot.type === 'value') return valueReadout(evaluate(plot.expr, env));
  if (plot.type === 'note') return comparisonReadout(plot, env);
  if (plot.type === 'tuple' && plot.blades) {
    // A multivector reads as its blades, a multiset of them as a list.
    const each = 1 << plot.blades.dim;
    const count = plot.count ?? 1;
    const shown = Math.min(count, 8);
    let approx = false;
    const parts = Array.from({ length: shown }, (_, k) => {
      const values = plot.values.slice(k * each, (k + 1) * each).map(e => evaluate(e, env));
      return mvText(plot.blades!, values, v => {
        const r = valueReadout(v);
        if (r.startsWith('≈')) approx = true;
        return r.replace(/^[=≈] /, '');
      });
    });
    const prefix = approx ? '≈' : '=';
    if (plot.count === undefined) return `${prefix} ${parts[0]}`;
    return `${prefix} [${parts.join(', ')}${count > shown ? ', …' : ''}]`;
  }
  if (plot.type === 'tuple' && plot.flat) {
    // A point, line or plane reads as what it is, a multiset of them as a list.
    const each = 1 << (plot.flat.dim + 1);
    const count = plot.count ?? 1;
    const shown = Math.min(count, 8);
    let approx = false;
    const parts = Array.from({ length: shown }, (_, k) => {
      const values = plot.values.slice(k * each, (k + 1) * each).map(e => evaluate(e, env));
      return flatText(plot.flat!, values, v => {
        const r = valueReadout(v);
        if (r.startsWith('≈')) approx = true;
        return r.replace(/^[=≈] /, '');
      });
    });
    const prefix = approx ? '≈' : '=';
    if (plot.count === undefined) return `${prefix} ${parts[0]}`;
    return `${prefix} [${parts.join('; ')}${count > shown ? '; …' : ''}]`;
  }
  if (plot.type === 'tuple') {
    // A tensor's values nest as the tuples that write it; a multiset of
    // them is listed like one of numbers.
    const shape = plot.shape ?? [plot.values.length];
    const each = shape.reduce((n, d) => n * d, 1);
    const shown = plot.count === undefined ? 1 : Math.min(plot.count, 8);
    const values = plot.values.slice(0, shown * each).map(e => valueReadout(evaluate(e, env)));
    const prefix = values.some(v => v.startsWith('≈')) ? '≈' : '=';
    const bare = values.map(v => v.replace(/^[=≈] /, ''));
    const parts = Array.from({ length: shown }, (_, k) => nestedText(shape, bare.slice(k * each, (k + 1) * each)));
    // (A long tuple kept only the values it shows: see TUPLE_SHOWN.)
    if (plot.length !== undefined) return `${prefix} (${bare.join(', ')}, …)`;
    if (plot.count === undefined) return `${prefix} ${parts[0]}`;
    return `${prefix} [${parts.join(', ')}${plot.count > shown ? ', …' : ''}]`;
  }
  if (plot.type === 'vlist') {
    const values = plot.values.slice(0, 8).map(e => valueReadout(evaluate(e, env)));
    const prefix = values.some(v => v.startsWith('≈')) ? '≈' : '=';
    return `${prefix} [${values.map(v => v.replace(/^[=≈] /, '')).join(', ')}${plot.values.length > 8 ? ', …' : ''}]`;
  }
  if (plot.type === 'family') {
    if (plot.readout) return plotReadout(plot.readout, env);
    // `i = [0..9]`: claims about a taken name explain it once, not per member.
    const first = plot.members[0]?.cpu;
    const taken = first?.type === 'note' ? first.constant : undefined;
    const parts = plot.members.map(m =>
      plotReadout(taken && m.cpu.type === 'note' ? { ...m.cpu, constant: undefined } : m.cpu, env),
    );
    if (parts.every(p => p !== null)) {
      const list = `[${parts.slice(0, 8).join('; ')}${parts.length > 8 ? '; …' : ''}]`;
      return taken && parts.some(p => /^(Never true|False now)/.test(p)) ? `${list} — ${takenNameHint(taken)}` : list;
    }
  }
  return null;
}

/**
 * A list of numbers drawn as its values (docs/multisets.md §5): a dot plot on
 * the number line. Each value sits at x = value and its copies stack upward,
 * the j-th at y = j, so a column's height is the value's multiplicity. No
 * index is drawn — a multiset has no order.
 *
 * With `width` > 0, values are first gathered into columns that wide (the
 * dot's width on screen), so a large column of distinct measurements stacks
 * into its shape instead of drawing every dot on top of the last at y = 1.
 */
export function dotPlot(values: ArrayLike<number>, width = 0): { xs: Float64Array; ys: Float64Array } {
  const xs = new Float64Array(values.length);
  const ys = new Float64Array(values.length);
  const heights = new Map<number, number>();
  let n = 0;
  for (let k = 0; k < values.length; k++) {
    const v = values[k];
    if (!Number.isFinite(v)) continue;
    const x = width > 0 ? (Math.floor(v / width) + 0.5) * width : v;
    const j = (heights.get(x) ?? 0) + 1;
    heights.set(x, j);
    xs[n] = x;
    ys[n++] = j;
  }
  return { xs: xs.subarray(0, n), ys: ys.subarray(0, n) };
}
