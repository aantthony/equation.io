/**
 * Point (2D vector) values and geometry statements.
 *
 * A constant whose right-hand side is a pair — `A = (0, 0)`, `C = B + D` —
 * is a named point. Point arithmetic (±, scalar ×/÷, dot, cross, perp,
 * midpoint, unit, distance, angle, |P|) is lowered here into componentwise scalar expressions,
 * with a point name `A` expanding to the derived constants `A_x`, `A_y`.
 * Lowering runs after resolveExpr (functions inlined, Σ expanded) and before
 * classify, so everything downstream — GLSL, evaluate, diff — still sees only
 * scalars, and points stay symbolic all the way to uniforms (dragging a point
 * never recompiles a shader).
 *
 * The statement forms segment/polyline/vector/polygon/square desugar to an
 * internal '[polygon]'-style call holding a flat scalar vertex list (classify
 * turns it into a CPU-drawn polygon plot); line and circle desugar to ordinary
 * implicit equations.
 *
 * Tuple literals inside a call arrive flattened (the parser folds commas into
 * one argument list), so `polygon((0,0), A)` reaches us as [0, 0, A]; adjacent
 * scalar arguments re-pair into points.
 */
import { add, div, mul, neg, sub } from './diff.ts';
import { ANGLE_FN, type Expr } from './expr.ts';
import { SCALAR_REDUCTIONS } from './list.ts';
import { type GetMat, detOf, matVec, matrixFromList, solveVec, traceOf } from './mat.ts';

/** Whole-statement geometry forms (like SPECIAL_FORMS, they never nest). */
export const GEOM_STATEMENTS = new Set(['segment', 'polyline', 'vector', 'line', 'polygon', 'square', 'circle']);

/** The derived scalar constants a point named `name` expands to. */
export const pointComps = (name: string): [string, string] => [name + '_x', name + '_y'];

/** The derived scalar states an n-vector state expands to: om_1, om_2(, om_3). */
export const vecStateComps = (name: string, dim: number): string[] =>
  Array.from({ length: dim }, (_, k) => `${name}_${k + 1}`);

/** A vector value under lowering: 2 components (a point) or 3 (a 3-vector). */
type LV = { vec: false; e: Expr } | { vec: true; items: Expr[] };

const sc = (e: Expr): LV => ({ vec: false, e });
const vc = (...items: Expr[]): LV => ({ vec: true, items });
const toExpr = (v: LV): Expr => (v.vec ? { kind: 'vec', items: v.items } : v.e);

/**
 * Component names for a vector-valued definition, or null for scalars.
 * Named points return [A_x, A_y]; vector states return [om_1, om_2(, om_3)].
 */
export type GetComps = (name: string) => readonly string[] | null;

/** Whether a name is a list (so a measurement or figure can say lists wait). */
type IsList = (name: string) => boolean;

/** Functions over points, by how many point arguments they take. */
const POINT_FNS: Record<string, number> = { dot: 2, cross: 2, midpoint: 2, perp: 1, unit: 1 };

const sq = (e: Expr): Expr => mul(e, e);
const lenOfN = (items: Expr[]): Expr => {
  let s = sq(items[0]);
  for (let k = 1; k < items.length; k++) s = add(s, sq(items[k]));
  return { kind: 'call', name: 'sqrt', args: [s] };
};

/** Both vectors, same length — the shape componentwise arithmetic needs. */
function sameDims(op: string, a: LV, b: LV): asserts a is LV & { vec: true } {
  if (!a.vec || !b.vec) return;
  if (a.items.length !== b.items.length) {
    throw new Error(`Cannot ${op} a ${a.items.length}-component and a ${b.items.length}-component vector.`);
  }
}

/** Re-pair a lowered argument list into vectors of any dimension: vec args
 *  pass through, adjacent scalars (a flattened tuple literal) join into a 2D
 *  point. A scalar left without a partner throws `stray` — a message, or one
 *  made from that argument's index. */
function vecArgs(args: LV[], stray: string | ((index: number) => string)): Expr[][] {
  const vs: Expr[][] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.vec) {
      vs.push(a.items);
      continue;
    }
    const b = args[i + 1];
    if (!b || b.vec) throw new Error(typeof stray === 'string' ? stray : stray(i));
    vs.push([a.e, b.e]);
    i++;
  }
  return vs;
}

/** vecArgs for the figures, which are 2D only. `usage` is the argument list
 *  shown in the error, e.g. 'A' or 'A, B'. */
function pairPoints(name: string, args: LV[], usage: string): Array<[Expr, Expr]> {
  const vs = vecArgs(args, `${name} takes points — write ${name}(${usage}), with A = (0, 0) defined above.`);
  const big = vs.find(v => v.length !== 2);
  if (big) throw new Error(`${name} takes 2D points, not ${big.length}-component vectors.`);
  return vs as Array<[Expr, Expr]>;
}

/** An argument that is itself a list: a literal, a named list, or a named
 *  2×2/3×3 one, which reads as a matrix. (A list deeper inside — (L, 0),
 *  total(L), M A — is a scalar or a point by the time it matters.) */
const isListArg = (a: Expr, getMat: GetMat, isList: IsList): boolean =>
  a.kind === 'list' || a.kind === 'data' || (a.kind === 'var' && (isList(a.name) || getMat(a.name) !== null));

/** Why an argument that failed to be a point is list-shaped, if it is: a
 *  'list' value (L, 2L, -P, sort(L), sin(L)) or one 'element' of a list
 *  (P[1]). A reduction is one number, so total(L) is neither. */
function listShape(a: Expr, getMat: GetMat, isList: IsList): 'list' | 'element' | null {
  if (isListArg(a, getMat, isList)) return 'list';
  const first = (es: Expr[]) => es.map(x => listShape(x, getMat, isList)).find(s => s !== null) ?? null;
  switch (a.kind) {
    case 'neg': return first([a.a]);
    case 'bin': return first([a.a, a.b]);
    case 'call':
      if (a.name === '[index]') return 'element';
      if (SCALAR_REDUCTIONS.has(a.name) || ((a.name === 'min' || a.name === 'max') && a.args.length === 1)) return null;
      return first(a.args);
    default: return null;
  }
}

const DISTANCE_USAGE = 'distance takes two points: distance(A, B) with A = (0, 0) defined above, or distance((0, 0), (3, 4)).';
const ANGLE_USAGE = 'angle takes three 2D points — angle(A, B, C), the angle at B — or two 2D vectors: angle(U, V).';

/** distance(A, B) ≡ |A - B|, in any dimension |A - B| has. `usage` is thrown
 *  for every arity failure: tuple literals arrive flattened — (1, 2, 3) is
 *  three loose scalars — so it is the one message true however they pair. */
function lowerDistance(args: LV[], usage: string, stray: (index: number) => string): Expr {
  const vs = vecArgs(args, stray);
  if (vs.length !== 2) throw new Error(usage);
  const [p, q] = vs;
  if (p.length !== q.length) {
    throw new Error(`distance needs points with the same number of components, not ${p.length} and ${q.length}.`);
  }
  return lenOfN(p.map((pk, k) => sub(pk, q[k])));
}

/** angle(A, B, C), the angle at B turning from B→A to B→C, or angle(U, V):
 *  signed, counterclockwise positive, in (−π, π]. It lowers to one internal
 *  call over the two arms' components (see angleFn), so each component
 *  appears once however large it is. */
function lowerAngle(args: LV[], usage: string, stray: (index: number) => string): Expr {
  const vs = vecArgs(args, stray);
  if (vs.length !== 2 && vs.length !== 3) throw new Error(usage);
  if (vs.some(v => v.length !== 2)) {
    throw new Error('angle measures 2D points and vectors only — 3-component vectors are not supported yet.');
  }
  const [u, v] = vs.length === 3
    ? [vs[0].map((c, k) => sub(c, vs[1][k])), vs[2].map((c, k) => sub(c, vs[1][k]))]
    : vs;
  return { kind: 'call', name: ANGLE_FN, args: [...u, ...v] };
}

function lower(e: Expr, getComps: GetComps, getMat: GetMat, isList: IsList): LV {
  const lo = (n: Expr): LV => lower(n, getComps, getMat, isList);
  switch (e.kind) {
    case 'num': return sc(e);
    case 'var': {
      if (getMat(e.name)) {
        throw new Error(`${e.name} is a matrix — use ${e.name} v, solve(${e.name}, v), det(${e.name}), or trace(${e.name}).`);
      }
      const comps = getComps(e.name);
      if (!comps) return sc(e);
      return vc(...comps.map((name): Expr => ({ kind: 'var', name })));
    }
    case 'neg': {
      const a = lo(e.a);
      if (a.vec) return vc(...a.items.map(neg));
      return a.e === e.a ? sc(e) : sc({ kind: 'neg', a: a.e });
    }
    case 'bin': {
      // The matvec M v: a matrix name as the direct left factor of a product.
      if (e.op === '*') {
        const m = e.a.kind === 'var' ? getMat(e.a.name) : null;
        if (m) {
          const v = lo(e.b);
          if (!v.vec || v.items.length !== m.length) {
            throw new Error(`${(e.a as Expr & { kind: 'var' }).name} is ${m.length}×${m.length}, so it multiplies a ${m.length}-component vector: ${(e.a as Expr & { kind: 'var' }).name} (x, y${m.length === 3 ? ', z' : ''}).`);
          }
          return vc(...matVec(m, v.items));
        }
        if (e.b.kind === 'var' && getMat(e.b.name)) {
          throw new Error(`Matrices multiply on the left — write ${e.b.name} v.`);
        }
      }
      const a = lo(e.a);
      const b = lo(e.b);
      if (!a.vec && !b.vec) {
        // Untouched scalar subtrees pass through unchanged, so existing plots
        // keep their exact GLSL (and shader cache keys).
        if (a.e === e.a && b.e === e.b) return sc(e);
        return sc({ kind: 'bin', op: e.op, a: a.e, b: b.e });
      }
      switch (e.op) {
        case '+':
        case '-':
          if (a.vec && b.vec) {
            sameDims(e.op === '+' ? 'add' : 'subtract', a, b);
            const f = e.op === '+' ? add : sub;
            return vc(...a.items.map((ai, k) => f(ai, (b as LV & { vec: true }).items[k])));
          }
          throw new Error(`Cannot ${e.op === '+' ? 'add' : 'subtract'} a point and a number.`);
        case '*':
          if (a.vec && b.vec) throw new Error('Use dot(A, B) or cross(A, B) to multiply points.');
          if (a.vec && !b.vec) return vc(...a.items.map(ai => mul(ai, (b as LV & { vec: false }).e)));
          if (!a.vec && b.vec) return vc(...b.items.map(bi => mul((a as LV & { vec: false }).e, bi)));
          break;
        case '/':
          if (a.vec && !b.vec) return vc(...a.items.map(ai => div(ai, (b as LV & { vec: false }).e)));
          throw new Error('Cannot divide by a point.');
        case '^':
          throw new Error('Cannot raise a point to a power — |A| is its length.');
      }
      break;
    }
    case 'call': {
      if (GEOM_STATEMENTS.has(e.name)) throw new Error(`${e.name}(…) must be a whole statement.`);
      if (e.name === 'trail') {
        const args = e.args.map(lo);
        const coords = args.length === 1 && args[0].vec
          ? args[0].items
          : args.every(a => !a.vec) ? args.map(a => (a as LV & { vec: false }).e) : [];
        if (coords.length !== 2 && coords.length !== 3) {
          throw new Error('trail takes a 2D or 3D point: trail(A) or trail((cos(t), sin(t))).');
        }
        return sc({ kind: 'call', name: '[trail]', args: coords });
      }
      if (e.name === 'det' || e.name === 'trace' || e.name === 'solve') {
        const matArg = (raw: Expr | undefined): ReturnType<GetMat> => {
          if (!raw) return null;
          if (raw.kind === 'var') return getMat(raw.name);
          if (raw.kind === 'list') {
            // Inline literal: lower the rows, then read the shape.
            return matrixFromList(toExpr(lo(raw)));
          }
          return null;
        };
        const m = matArg(e.args[0]);
        if (!m) {
          throw new Error(`${e.name} takes a matrix — define one with M = [(a, b), (c, d)].`);
        }
        if (e.name === 'det' || e.name === 'trace') {
          if (e.args.length !== 1) throw new Error(`${e.name} takes one matrix.`);
          return sc(e.name === 'det' ? detOf(m) : traceOf(m));
        }
        // solve(M, v): the remaining arguments are the right-hand side — one
        // vector, or its components flattened out of a tuple literal.
        const rest = e.args.slice(1).map(lo);
        let v: Expr[];
        if (rest.length === 1 && rest[0].vec) v = rest[0].items;
        else if (rest.length === m.length && rest.every(r => !r.vec)) {
          v = rest.map(r => (r as LV & { vec: false }).e);
        } else {
          throw new Error(`solve takes solve(M, v) with v a ${m.length}-component vector.`);
        }
        if (v.length !== m.length) {
          throw new Error(`${m.length}×${m.length} matrix, ${v.length}-component vector — solve needs them to match.`);
        }
        return vc(...solveVec(m, v));
      }
      if (e.name === 'distance' || e.name === 'angle') {
        // Scalars like dot and cross: they work inside any expression, read out
        // as a bare row, and draw nothing (an arc marker would be its own
        // wrapper, not a side effect of the readout). Lists inside a component
        // broadcast later like any scalar's; a list *as* an argument would be
        // a list of points, which is plan #13's.
        const usage = e.name === 'distance' ? DISTANCE_USAGE : ANGLE_USAGE;
        const form = e.name === 'distance' ? 'distance(A, B)' : 'angle(A, B, C)';
        const listy = `${e.name} takes points, and a list cannot stand for a point yet — ${form}, one point each.`;
        // The argument left without a partner says what went wrong: a list,
        // an element of one (a point on its own row, but not yet a point
        // *value* — P[1] + A fails the same way; plan #13), or a plain number.
        const stray = (index: number): string => {
          const shape = listShape(e.args[index], getMat, isList);
          if (shape === 'list') return listy;
          if (shape === 'element') {
            return `${e.name} takes points, and an element of a list cannot stand for a point yet — name the point (Q = (1, 1)) and write ${form}.`;
          }
          return usage;
        };
        // (A named 2×2 list reads as a matrix, which lowering would reject first.)
        if (e.args.some(a => a.kind === 'var' && getMat(a.name) !== null)) throw new Error(listy);
        const args = e.args.map(lo);
        return sc(e.name === 'distance' ? lowerDistance(args, usage, stray) : lowerAngle(args, usage, stray));
      }
      const args = e.args.map(lo);
      const nPts = Object.hasOwn(POINT_FNS, e.name) ? POINT_FNS[e.name] : undefined;
      if (nPts !== undefined) {
        // Vector args of any dim pass straight through; runs of flattened
        // scalars still pair into 2D points as before.
        const vs = vecArgs(args, `${e.name} takes points — write ${e.name}(${nPts === 1 ? 'A' : 'A, B'}), with A = (0, 0) defined above.`);
        if (vs.length !== nPts) {
          throw new Error(`${e.name} takes ${nPts} point${nPts === 1 ? '' : 's'}.`);
        }
        const dim = vs[0].length;
        if (vs.some(v => v.length !== dim)) {
          throw new Error(`${e.name} needs vectors with the same number of components.`);
        }
        const twoOnly = () => {
          if (dim !== 2) throw new Error(`${e.name} is only defined for 2D points.`);
        };
        const p = vs[0];
        const q = vs[1];
        switch (e.name) {
          case 'dot': {
            let s = mul(p[0], q[0]);
            for (let k = 1; k < dim; k++) s = add(s, mul(p[k], q[k]));
            return sc(s);
          }
          case 'cross': twoOnly(); return sc(sub(mul(p[0], q[1]), mul(p[1], q[0])));
          case 'midpoint': return vc(...p.map((pk, k) => div(add(pk, q[k]), num2)));
          case 'perp': twoOnly(); return vc(neg(p[1]), p[0]);
          case 'unit': return vc(...p.map(pk => div(pk, lenOfN(p))));
        }
      }
      // |P| is a point's length; |(3, 4)| arrives as abs(3, 4) because the
      // tuple flattens into the argument list, so a scalar pair re-pairs too.
      if (e.name === 'abs' && args.length === 1 && args[0].vec) {
        return sc(lenOfN(args[0].items));
      }
      if (e.name === 'abs' && args.length === 2) {
        const pts = pairPoints('abs', args, 'A');
        if (pts.length === 1) return sc(lenOfN([pts[0][0], pts[0][1]]));
      }
      const flatArgs: Expr[] = [];
      for (const a of args) {
        if (a.vec) throw new Error(`${e.name} is not defined for points.`);
        flatArgs.push(a.e);
      }
      if (flatArgs.every((a, k) => a === e.args[k])) return sc(e);
      return sc({ kind: 'call', name: e.name, args: flatArgs });
    }
    case 'eq': {
      const l = lo(e.l);
      const r = lo(e.r);
      if (l.vec !== r.vec) throw new Error('One side is a point and the other is a number.');
      if (!l.vec && l.e === e.l && (r as LV & { vec: false }).e === e.r) return sc(e);
      return sc({ kind: 'eq', l: toExpr(l), r: toExpr(r) });
    }
    case 'ineq': {
      const l = lo(e.l);
      const r = lo(e.r);
      if (l.vec || r.vec) throw new Error('Points cannot be compared — compare |A - B| instead.');
      if (l.e === e.l && r.e === e.r) return sc(e);
      return sc({ kind: 'ineq', op: e.op, l: l.e, r: r.e });
    }
    case 'vec': {
      const items = e.items.map(lo);
      if (items.some(a => a.vec)) {
        if (e.items.length === 2 && items.every(a => a.vec)) {
          throw new Error('A pair of points — did you mean segment(A, B)?');
        }
        throw new Error('A point cannot be a component of a vector.');
      }
      const flat = items.map(a => (a as LV & { vec: false }).e);
      // 2- and 3-vectors become vector values so arithmetic works on both;
      // toExpr rebuilds the same node shape for anything that reaches root.
      if (e.items.length === 2 || e.items.length === 3) return vc(...flat);
      if (flat.every((f, k) => f === e.items[k])) return sc(e);
      return sc({ kind: 'vec', items: flat });
    }
    // Data and text lists hold no geometry: they pass straight through to
    // list lowering, which is the pass that knows what to do with them.
    case 'data':
    case 'str':
    case 'text':
      return sc(e);
    case 'list': {
      // Items lower independently; a named point becomes its (A_x, A_y) vec,
      // so [A, B] scatters named points like [(1, 2), (3, 4)] does literals.
      const items = e.items.map(a => toExpr(lo(a)));
      if (items.every((it, k) => it === e.items[k])) return sc(e);
      return sc({ kind: 'list', items });
    }
    case 'piecewise': {
      const one = (n: Expr): Expr => {
        const v = lo(n);
        if (v.vec) throw new Error('Points cannot appear in a piecewise expression.');
        return v.e;
      };
      const cases = e.cases.map(c => ({ cond: one(c.cond), value: one(c.value) }));
      const otherwise = e.otherwise && one(e.otherwise);
      if (otherwise === e.otherwise
        && cases.every((c, k) => c.cond === e.cases[k].cond && c.value === e.cases[k].value)) return sc(e);
      return sc({ kind: 'piecewise', cases, otherwise });
    }
  }
  throw new Error('Unreachable');
}

const num2: Expr = { kind: 'num', value: 2 };
const VECTOR_USAGE = 'vector takes one or two 2D points: vector(A, B) from A to B, or vector(V) from the origin. 3-component vectors are not drawn yet.';
const spaceVar = (name: 'x' | 'y'): Expr => ({ kind: 'var', name });

/** Internal figure calls with flat scalar vertices: '[segment]' and
 *  '[polyline]' are open, '[vector]' is open with an arrowhead at its last
 *  vertex, '[polygon]' and '[square]' close and fill (otherwise the name only
 *  differs so classify can word its errors after the statement the user
 *  wrote). */
export type FigureName = '[polygon]' | '[segment]' | '[polyline]' | '[vector]' | '[square]';
const polyCall = (name: FigureName, pts: Array<[Expr, Expr]>): Expr =>
  ({ kind: 'call', name, args: pts.flat() });

/**
 * Lower a whole statement: desugar a root-level geometry form, expand all
 * point arithmetic, and return an expression classify already understands.
 */
export function lowerGeom(
  e: Expr, getComps: GetComps, getMat: GetMat = () => null, isList: IsList = () => false,
): Expr {
  if (e.kind === 'call' && GEOM_STATEMENTS.has(e.name)) {
    // A list of points — literal, named, or a named 2×2/3×3 one that reads as
    // a matrix — is plan #13's; until then say so rather than "takes points".
    if ((e.name === 'polyline' || e.name === 'vector') && e.args.some(a => isListArg(a, getMat, isList))) {
      throw new Error(`${e.name} takes its points one by one for now — ${e.name === 'polyline' ? 'polyline(A, B, C)' : 'vector(A, B)'} — not as a list.`);
    }
    const args = e.args.map(a => lower(a, getComps, getMat, isList));
    if (e.name === 'circle') {
      // circle(C, r): the trailing argument is the scalar radius.
      const r = args[args.length - 1];
      if (args.length < 2 || !r || r.vec) throw new Error('circle takes circle(center, radius).');
      const pts = pairPoints('circle', args.slice(0, -1), 'center, radius');
      if (pts.length !== 1) throw new Error('circle takes circle(center, radius).');
      const [cx, cy] = pts[0];
      return {
        kind: 'eq',
        l: add(sq(sub(spaceVar('x'), cx)), sq(sub(spaceVar('y'), cy))),
        r: sq(r.e),
      };
    }
    // Tuple literals arrive flattened, so (1, 2, 3) cannot be told from
    // (1, 2), 3: an odd run of scalars gets the one message true of both.
    if (e.name === 'vector' && args.every(a => !a.vec) && args.length % 2 === 1) throw new Error(VECTOR_USAGE);
    const pts = pairPoints(e.name, args, e.name === 'polygon' || e.name === 'polyline' ? 'A, B, C' : 'A, B');
    if (e.name === 'line') {
      if (pts.length !== 2) {
        throw new Error('line takes two points: line(A, B), with A = (0, 0) defined above.');
      }
      // The infinite line through A and B: cross(P - A, B - A) = 0, an
      // ordinary implicit equation (so it renders on the GPU like any curve).
      const [[ax, ay], [bx, by]] = pts;
      return {
        kind: 'eq',
        l: sub(
          mul(sub(spaceVar('x'), ax), sub(by, ay)),
          mul(sub(spaceVar('y'), ay), sub(bx, ax)),
        ),
        r: { kind: 'num', value: 0 },
      };
    }
    if (e.name === 'segment') {
      if (pts.length !== 2) {
        throw new Error('segment takes two points: segment(A, B), with A = (0, 0) defined above.');
      }
      return polyCall('[segment]', pts);
    }
    if (e.name === 'polyline') {
      if (pts.length < 2) throw new Error('polyline needs at least 2 points: polyline(A, B, C).');
      return polyCall('[polyline]', pts);
    }
    if (e.name === 'vector') {
      // vector(A, B) is the arrow from A to B; vector(V) starts at the origin.
      if (pts.length !== 1 && pts.length !== 2) throw new Error(VECTOR_USAGE);
      const zero: Expr = { kind: 'num', value: 0 };
      return polyCall('[vector]', pts.length === 1 ? [[zero, zero], pts[0]] : pts);
    }
    if (e.name === 'square') {
      if (pts.length !== 2) throw new Error('square takes two points: square(A, B).');
      // The square erected on side A→B, on the left of the direction A→B.
      const [[ax, ay], [bx, by]] = pts;
      const px = neg(sub(by, ay)); // perp(B - A)
      const py = sub(bx, ax);
      return polyCall('[square]', [
        [ax, ay],
        [bx, by],
        [add(bx, px), add(by, py)],
        [add(ax, px), add(ay, py)],
      ]);
    }
    if (pts.length < 3) throw new Error('polygon needs at least 3 vertices.');
    return polyCall('[polygon]', pts);
  }
  return toExpr(lower(e, getComps, getMat, isList));
}

/**
 * The head of an arrow whose shaft runs (x0, y0) → (x1, y1) in screen pixels:
 * the triangle tip/left/right with its tip at (x1, y1), plus shaftEnd, where
 * the stroke should stop instead of at the tip — a little inside the head, so
 * its blunt end never pokes through the point and no seam opens at the base.
 * `size` is the head length in pixels — fixed on screen, so the head does not
 * scale with zoom — shrinking only when the shaft itself is shorter. Null for
 * a zero-length (or non-finite) shaft, which has no direction. Shared by
 * render2d and the og rasterizer so both draw the same arrow.
 */
export interface ArrowHead {
  tip: [number, number];
  left: [number, number];
  right: [number, number];
  shaftEnd: [number, number];
}
export function arrowHead(x0: number, y0: number, x1: number, y1: number, size: number): ArrowHead | null {
  const len = Math.hypot(x1 - x0, y1 - y0);
  if (!(len > 0) || !Number.isFinite(len)) return null;
  const ux = (x1 - x0) / len, uy = (y1 - y0) / len;
  const h = Math.min(size, len);
  const w = h * 0.4; // half-width: a 2.5:2 head, slim enough to read as a direction
  const bx = x1 - ux * h, by = y1 - uy * h;
  return {
    tip: [x1, y1],
    left: [bx - uy * w, by + ux * w],
    right: [bx + uy * w, by - ux * w],
    shaftEnd: [bx + ux * h * 0.25, by + uy * h * 0.25],
  };
}
