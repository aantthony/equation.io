/**
 * Symbolic expression parsing for plotting.
 *
 * Unlike syntax.ts (which eagerly evaluates to multiset values), this module
 * parses input into a small symbolic AST that can retain free variables
 * (x, y, z, ...) so it can be compiled to GLSL or JS for graphing.
 */
import { BinaryInfix, BinaryRightInfix, operators, Postfix, Prefix, shunting } from './lang/parser.ts';
import Tokenizer, { type PatternDict, type Token } from './lang/tokenizer.ts';
import { walk } from './lang/ast.ts';
import {
  betaPdf,
  binomPmf,
  discreteUniformPmf,
  gammaPdf,
  lgamma,
  negBinomPmf,
  poissonPmf,
  studentTPdf,
  weibullPdf,
} from './specfn.ts';

export type IneqOp = '<' | '<=' | '>' | '>=';

export type FigureForm = 'polygon' | 'segment' | 'polyline' | 'vector' | 'square' | 'hull';

export interface Axis {
  id: string;
  n: number;
  /** A tuple's axis: its values sit at positions 1…n, so it indexes, draws
   *  as a path, and meets another tuple by position rather than crossing
   *  (docs/multisets.md §3). Every other axis is a multiset's: no order. */
  ordered?: true;
}

/** A packed column a `lazy` list or packed figure runs over: `name` is the
 *  variable its template reads, bound to values[k] for element k. Names start
 *  with '@', so they never collide with anything a row can write. */
export interface Column {
  readonly name: string;
  readonly values: Float64Array;
}

/** Nodes are immutable. The exception is `axes` and `origin`: list identity
 *  that list lowering records on the nodes it meets (markOrigins, axesOf),
 *  never part of the math — exprKey leaves them out. */
export type Expr = ExprNode & { axes?: readonly Axis[]; origin?: number };

/** The products written with their own glyph (see the bin node). */
export type ProductGlyph = 'dot' | 'cross' | 'outer' | 'wedge' | 'geometric';

type ExprNode =
  | { readonly kind: 'num'; readonly value: number }
  | { readonly kind: 'var'; readonly name: string }
  /** `glyph` records a product written `·`/`⋅` ('dot'), `×` ('cross'),
   *  `⊗` ('outer'), `∧` ('wedge') or `⟑` ('geometric'): between two
   *  vectors, tensors or multivectors lowerGeom reads it as that product;
   *  between numbers it is plain multiplication. */
  | {
      readonly kind: 'bin';
      readonly op: '+' | '-' | '*' | '/' | '^';
      readonly a: Expr;
      readonly b: Expr;
      readonly glyph?: ProductGlyph;
    }
  | { readonly kind: 'neg'; readonly a: Expr }
  | { readonly kind: 'call'; readonly name: string; readonly args: readonly Expr[] }
  | { readonly kind: 'index'; readonly args: readonly [Expr, Expr] }
  | { readonly kind: 'range'; readonly args: readonly [Expr, Expr] }
  | { readonly kind: 'eqtest'; readonly op: '==' | '!='; readonly args: readonly [Expr, Expr] }
  | {
      readonly kind: 'comp';
      readonly value: Expr;
      readonly index: number;
      readonly arity: number;
      readonly functionName: string;
    }
  /** A figure's vertices, flat (dimension numbers per vertex) — or, with
   *  `over`, ONE vertex template evaluated once per element of the columns:
   *  a path through thousands of computed points stays a single template. */
  | {
      readonly kind: 'figure';
      readonly form: FigureForm;
      readonly dimension: 2 | 3;
      readonly vertices: readonly Expr[];
      readonly over?: readonly Column[];
    }
  | { readonly kind: 'trail'; readonly coordinates: readonly Expr[] }
  /** `label(point, "text")`: text anchored at a point. Only the point is math. */
  | { readonly kind: 'label'; readonly coordinates: readonly Expr[]; readonly text: string }
  | { readonly kind: 'hist'; readonly centers: Float64Array; readonly counts: Float64Array; readonly width: number }
  | { readonly kind: 'family'; readonly members: readonly Expr[] }
  | { readonly kind: 'eq'; readonly l: Expr; readonly r: Expr }
  /** An inequality; chains like 0 < y < x nest left: ((0 < y) < x).
   *  `grouped` marks one written in parentheses. Over a list it is an
   *  operand — its kept members, (L > 1) > 2 — not a link of an outer chain
   *  (list.ts lowerCond); over x and y it still reads as the chain. */
  | { readonly kind: 'ineq'; readonly op: IneqOp; readonly l: Expr; readonly r: Expr; readonly grouped?: true }
  /** A vector literal like (2, 3) or (cos(u), sin(u), v): the whole
   *  statement, an equation side, or an operand ((A + (1, 2))/2 — lowerGeom
   *  expands 2-item operands; 3-item vectors stay top-level values). */
  | { readonly kind: 'vec'; readonly items: readonly Expr[] }
  /** A data list [1, 4, 2] or [(1,2), (3,4)]. Plottable as its own row only. */
  | { readonly kind: 'list'; readonly items: readonly Expr[] }
  /**
   * A list of numbers held as a typed array — a CSV column, or anything
   * constant derived from one. Semantically a `list` of num nodes; the point
   * is that a 100k-row column costs two objects instead of 100k. Only list
   * lowering makes or reads one, and like `list` it never survives lowering:
   * GLSL, diff, and the integrator never see it.
   */
  | { readonly kind: 'data'; readonly values: Float64Array }
  /**
   * A list kept as one template over packed columns: element k is `body` with
   * each column's variable bound to its k-th value. What list lowering builds
   * when an operation over numbers involves a slider or t — `sin(a L)` — so
   * the fast path cannot fold it and one tree per element would cost a whole
   * copy of the body each. Like `data`, it never survives lowering unless the
   * caller asks for it (a connected figure, which keeps it as `over`).
   */
  | { readonly kind: 'lazy'; readonly cols: readonly Column[]; readonly body: Expr }
  /**
   * A text literal, `"NYC"`. Text is not a value the plane can draw: it
   * exists so a filter can compare a text column against it, and every
   * numeric context refuses it.
   */
  | { readonly kind: 'str'; readonly value: string }
  /** A text column, the counterpart of `data`. Same rule: only comparisons. */
  | { readonly kind: 'text'; readonly values: readonly string[] }
  /**
   * {cond: value, …, otherwise?}; conditions are inequalities, tried in order.
   * `bare` marks a condition written without a value (`{x > 0, …}`, value 1):
   * as a reduction's argument, `{c1, c2: f}` is f where c1 and c2 both hold,
   * and there (only) a condition may be an equation (lib/measure.ts).
   */
  | {
      readonly kind: 'piecewise';
      readonly cases: ReadonlyArray<{ readonly cond: Expr; readonly value: Expr; readonly bare?: true }>;
      readonly otherwise?: Expr;
    }
  /**
   * A tail-recursive function call run as a bounded loop: `params` start at
   * `seeds`; each pass evaluates `body`, a piecewise whose leaves either give
   * the result or, as a `RECUR` call, the params for the next pass. The
   * params are bound inside body only (a binder, like a Σ index): seeds and
   * everything else in body resolve in the enclosing scope. Undefined (NaN)
   * once `limit` passes run out, a param leaves the finite range, or no
   * case holds and there is no default.
   */
  | {
      readonly kind: 'loop';
      readonly params: readonly string[];
      readonly seeds: readonly Expr[];
      readonly body: Expr;
      readonly limit: number;
    };

/** A continuous interval's hidden parameter (lib/interval.ts): not an
 *  identifier, so no document name or builtin can collide with it. */
export const INTERVAL = '[interval]';

/** The self-call inside a `loop` body: its args are the next pass's params. */
export const RECUR = '@recur';
/** Passes a tail-recursive function may take before it is undefined. Enough
 *  for every self-similar construction (each pass rescales) and a fold over
 *  a few hundred items; bounded so a pixel that never terminates costs about
 *  what an escape-time iteration does. */
export const LOOP_LIMIT = 250;
/** The leaves of a loop body's piecewise tree, in order. */
export function loopLeaves(body: Expr): Expr[] {
  if (body.kind !== 'piecewise') return [body];
  return body.cases.flatMap(c => loopLeaves(c.value)).concat(body.otherwise ? loopLeaves(body.otherwise) : []);
}
export const isRecur = (e: Expr): e is Expr & { kind: 'call' } => e.kind === 'call' && e.name === RECUR;

/** Historical tuple-call spelling, applied before resolving argument values.
 * Only syntax vectors flatten: a named or computed vector is never splatted. */
export function legacyCallArgs(name: string, args: readonly Expr[]): readonly Expr[] {
  const grouped = new Set([
    'segment',
    'polyline',
    'polygon',
    'hull',
    'vector',
    'line',
    'circle',
    'square',
    'distance',
    'angle',
    'dot',
    'cross',
    'midpoint',
    'perp',
    'unit',
    'rotate',
    'grad',
    'div',
    'curl',
    'laplacian',
    // A tuple of rows is one matrix argument: det(((a, b), (c, d))).
    'det',
    'trace',
    'solve',
    'exp',
    // Tensors are nested tuples: outer((1, 0), (0, 1)) takes two vectors.
    'outer',
    'wedge',
    'contract',
    // Multivectors take vectors whole: gp((1, 0), (0, 1)) is e_xy.
    'gp',
    'rev',
    'grade',
    'dual',
    'slerp',
    // A matrix or a map, whole: action(((1, 1), (0, 1))), jacobian((x y, x + y)).
    'action',
    'jacobian',
    'hessian',
    // sort((s, sin(s)), s): the points to order, then their key.
    'sort',
  ]);
  return grouped.has(name) ? args : args.flatMap(x => (x.kind === 'vec' ? x.items : [x]));
}

/** Functions available in expressions (all map to GLSL builtins or helpers). */
export const FUNCTIONS = new Set([
  'sin',
  'cos',
  'tan',
  'asin',
  'acos',
  'atan',
  'atan2',
  'sinh',
  'cosh',
  'tanh',
  'sech',
  'asinh',
  'acosh',
  'atanh',
  'sqrt',
  'abs',
  'exp',
  'ln',
  'log',
  'floor',
  'ceil',
  'round',
  'min',
  'max',
  'clamp',
  'mod',
  'sign',
  'fract',
  'erf',
  'normalpdf',
  'normalcdf',
  'gcd',
  'isprime',
  'gamma',
  'factorial',
  'sinc',
  'coth',
  're',
  'im',
  'arg',
  'conj',
  // List reductions and transforms: lowered symbolically (or evaluated
  // numerically) by list.ts, so nothing downstream ever sees them.
  'mean',
  'total',
  'count',
  'stdev',
  'median',
  'sort',
  'hist',
  // A continuous interval, resolved into a hidden parameter (lib/interval.ts).
  'interval',
  // Point (2D vector) helpers and geometry statements, lowered symbolically
  // by lowerGeom before anything evaluates or compiles them.
  'dot',
  'cross',
  'perp',
  'midpoint',
  'unit',
  'rotate',
  'distance',
  'angle',
  'segment',
  'polyline',
  'vector',
  'line',
  'polygon',
  'square',
  'circle',
  'hull',
  // Small-matrix helpers (det, trace, matvec, linear solve), also lowered
  // symbolically — Cramer's rule for 2×2 and 3×3 (see mat.ts).
  'det',
  'trace',
  'solve',
  // Tensor products and contraction (see tensor.ts), lowered the same way.
  'outer',
  'wedge',
  'contract',
  // Multivectors and quaternions (see clifford.ts), lowered the same way.
  'gp',
  'rev',
  'grade',
  'dual',
  'quat',
  'slerp',
  // A matrix drawn by what it does (lib/glyphs.ts), and a quaternion's
  // Julia set (lib/clifford.ts juliaSurface).
  'action',
  'qjulia',
  // Not real functions: Σ/Π/∫ binders and the ∇ operators, expanded
  // symbolically by resolveExpr.
  'sum',
  'prod',
  'int',
  'grad',
  'div',
  'curl',
  'laplacian',
  'jacobian',
  'hessian',
  // Whole-expression plot modes (see classify): domain coloring, conformal
  // grids, escape-time iteration, swept tubes, motion trails, and surfaces
  // of revolution.
  'domain',
  'conformal',
  'iter',
  'rgb',
  'hsl',
  'oklch',
  'tube',
  'trail',
  'label',
  'revolve',
]);

/**
 * Builtins added after graphs existed in the wild: a definition or random
 * variable may claim these names, shadowing the builtin, so a saved graph
 * that defines its own `gamma(x) = …` or `sinc = …` keeps its meaning.
 */
export const SHADOWABLE_FNS: ReadonlySet<string> = new Set([
  'gamma',
  'factorial',
  'sinc',
  'coth',
  'clamp',
  'mean',
  'total',
  'count',
  'stdev',
  'median',
  'sort',
  'hist',
  'grad',
  'div',
  'curl',
  'laplacian',
  'polyline',
  'vector',
  'distance',
  'angle',
  'revolve',
  'label',
  'rgb',
  'hsl',
  'oklch',
  'outer',
  'wedge',
  'contract',
  'interval',
  'gp',
  'rev',
  'grade',
  'dual',
  'quat',
  'slerp',
  'action',
  'jacobian',
  'hessian',
  'qjulia',
]);

/** The axes revolve(f, axis) turns a profile about. */
export const REVOLVE_AXES: ReadonlySet<string> = new Set(['x', 'y', 'z']);

/** The axis revolve's optional second argument names: x when there is none,
 *  and an error for anything that is not x, y or z itself. */
export function revolveAxis(ax: Expr | undefined): string {
  if (!ax) return 'x';
  if (ax.kind === 'var' && REVOLVE_AXES.has(ax.name)) return ax.name;
  throw new Error('The revolve axis must be x, y, or z: revolve(y^2, y).');
}

/**
 * Flatten a (possibly chained) inequality into its comparisons; comparison k
 * compares the previous comparison's right side, so 0 < y < x yields
 * [0 < y, y < x].
 */
export function ineqComparisons(e: Expr & { kind: 'ineq' }): Array<{ op: IneqOp; l: Expr; r: Expr }> {
  const chain: Array<Expr & { kind: 'ineq' }> = [];
  let node: Expr = e;
  while (node.kind === 'ineq') {
    chain.unshift(node);
    node = node.l;
  }
  return chain.map((c, k) => ({ op: c.op, l: k === 0 ? c.l : chain[k - 1].r, r: c.r }));
}

export const CONSTANTS: Record<string, number> = {
  pi: Math.PI,
  tau: Math.PI * 2,
  e: Math.E,
};

/** User-defined function names for the parse in progress (set by parseExpr). */
let activeUserFns: ReadonlySet<string> = new Set();

/** Named-list names for the parse in progress: `L[2]` indexes, `x[2]` multiplies. */
let activeListNames: ReadonlySet<string> = new Set();

/**
 * Names the document binds as values (set by parseExpr). A late-addition
 * builtin is only a function while nothing else claims its name: a graph
 * shared before `total` and `count` existed may hold `total = 3`, and there
 * `total(x + 1)` is the product it has always been, not a reduction over a
 * list that isn't there. SHADOWABLE_FNS says which names may be taken;
 * this says which ones a particular document took.
 */
let activeValueNames: ReadonlySet<string> = new Set();

/**
 * Whether `name[…]` indexes rather than multiplies.
 *
 * A dotted path counts when its HEAD is known, not only the full path: a data
 * file whose bytes are on another device cannot list its columns, and without
 * this `person.age[2]` would parse as a product there and as an index on the
 * author's machine — the same row meaning two things.
 */
const indexes = (name: string): boolean => {
  if (activeListNames.has(name)) return true;
  const dot = name.indexOf('.');
  return dot > 0 && activeListNames.has(name.slice(0, dot));
};

/**
 * Resolve a symbol to a built-in function name, folding case so `Sin`, `SIN`
 * and `sin` all reach the same builtin. Returns null if it is not a builtin
 * (user functions, which are case-sensitive, are handled separately).
 */
export const builtinFn = (name: string): string | null => {
  if (FUNCTIONS.has(name)) return name;
  const lower = name.toLowerCase();
  return FUNCTIONS.has(lower) ? lower : null;
};

/** Canonical name for a call: user functions win (exact), then case-folded builtins. */
const canonicalFn = (name: string): string => (activeUserFns.has(name) ? name : (builtinFn(name) ?? name));

/** Whether this document defines the builtin `name` would fold to, so the
 *  name reads as a value. Folds case with builtinFn, so `Total(…)` does not
 *  become a call either: every spelling means what it meant before the
 *  builtin existed. */
const shadowedFn = (name: string): boolean => {
  if (!activeValueNames.size) return false;
  const b = builtinFn(name);
  return b !== null && SHADOWABLE_FNS.has(b) && activeValueNames.has(b);
};

const isFnName = (name: string): boolean => activeUserFns.has(name) || (builtinFn(name) !== null && !shadowedFn(name));

const num = (value: number): Expr => ({ kind: 'num', value });
const bin =
  (op: '+' | '-' | '*' | '/' | '^') =>
  (a: Expr, b: Expr): Expr => ({ kind: 'bin', op, a, b });

// Private nodes used only while parsing: a comma-joined argument list, an
// open-bracket marker, and a `cond: value` piecewise part.
type PCase = { kind: 'pcase'; cond: Expr; value: Expr };
type POpen = { kind: 'popen'; bracket: string; call: boolean };
/** `=` beside a comma series: `{y = x^2, 0 < x < 1: y}` binds `=` loosest,
 *  so braces re-split it into conditions (eqItems); anywhere else it is the
 *  equation it always was (asExpr). */
type PEq = { kind: 'peq'; l: PNode; r: PNode };
type PNode = Expr | { kind: 'series'; items: Array<Expr | PCase> } | PCase | POpen | PEq;

function asExpr(n: PNode | undefined): Expr {
  if (!n) throw new Error('Incomplete expression.');
  if (n.kind === 'series') {
    if (n.items.length === 1) return asExpr(n.items[0]);
    throw new Error('Unexpected argument list.');
  }
  if (n.kind === 'pcase') throw new Error('A "condition: value" pair is only valid inside {…}.');
  // Outside braces, `a = b, c` keeps its old reading: b, c is a tuple.
  if (n.kind === 'peq') return { kind: 'eq', l: asVecOrExpr(n.l), r: asVecOrExpr(n.r) };
  if (n.kind === 'popen') throw new Error('Incomplete expression.');
  return n;
}

/** Whether `=` over these operands may be one condition among others, if
 *  braces close around it: a comma series or a `cond: value` beside it. */
const holdsConditions = (n: PNode): boolean => n.kind === 'pcase' || n.kind === 'peq' || n.kind === 'series';

/** The comma items of `a = b` in braces: `=` joins a's last item to b's first. */
function eqItems(n: PNode): Array<Expr | PCase> {
  if (n.kind === 'series') return n.items;
  if (n.kind === 'pcase') return [n];
  if (n.kind !== 'peq') return [asExpr(n)];
  const l = eqItems(n.l);
  const r = eqItems(n.r);
  const left = l[l.length - 1];
  if (left.kind === 'pcase') throw new Error('A piecewise value cannot be an equation.');
  const right = r[0];
  const joined: Expr | PCase =
    right.kind === 'pcase'
      ? { kind: 'pcase', cond: { kind: 'eq', l: left, r: right.cond }, value: right.value }
      : { kind: 'eq', l: left, r: right };
  return [...l.slice(0, -1), joined, ...r.slice(1)];
}

const asVecOrExpr = (n: PNode): Expr =>
  n.kind === 'series' && (n.items.length === 2 || n.items.length === 3) ? seriesToVec(n.items) : asExpr(n);

// Operators take tuples as operands — a parenthesized pair used in arithmetic
// is a vector literal, so (A + (1, 2))/2 works. Only a function application
// keeps a parenthesized series as an argument list (max(1, 2) stays 2 args):
// the [apply] operator binds before any of these see the series.
const asBin = (op: '+' | '-' | '*' | '/' | '^') =>
  BinaryInfix<PNode>((a, b) => bin(op)(asVecOrExpr(a), asVecOrExpr(b)));

/** `·`, `×`, `⊗`, `∧` and `⟑`: multiplication that remembers its glyph (see the bin node). */
const asProduct = (glyph: ProductGlyph) =>
  BinaryInfix<PNode>((a, b): Expr => ({ kind: 'bin', op: '*', a: asVecOrExpr(a), b: asVecOrExpr(b), glyph }));

const asIneq = (op: IneqOp) =>
  BinaryInfix<PNode>((a, b): Expr => ({ kind: 'ineq', op, l: asVecOrExpr(a), r: asVecOrExpr(b) }));

/** A comma series in plain brackets is a tuple: 2–3 numbers are a point, a
 *  longer run is a tuple of values (list lowering reads it as one). */
function seriesToVec(items: Array<Expr | PCase>): Expr {
  if (items.length >= 2) return { kind: 'vec', items: items.map(asExpr) };
  throw new Error('Expected 2 or 3 vector components.');
}

/** Assemble {…} content into a piecewise if it contains `cond: value` parts. */
function bracePiecewise(content: PNode): PNode {
  const items = content.kind === 'series' || content.kind === 'peq' ? eqItems(content) : [content];
  if (content.kind === 'peq' && items.length === 1 && items[0].kind !== 'pcase') return asExpr(items[0]);
  // A bare condition among several parts is Desmos's `{cond, else}`: 1 where
  // it holds. Alone, {x > 0} keeps meaning the inequality itself.
  const bare = items.length > 1 && items.some(n => n.kind === 'ineq' || n.kind === 'eq');
  if (!items.some(n => n.kind === 'pcase') && !bare) {
    return content.kind === 'series' ? seriesToVec(content.items) : content;
  }
  const cases: Array<{ cond: Expr; value: Expr; bare?: true }> = [];
  let otherwise: Expr | undefined;
  items.forEach((n, k) => {
    if ((n.kind === 'ineq' || n.kind === 'eq') && items.length > 1) {
      if (otherwise) throw new Error('The default value must come last in {…}.');
      cases.push({ cond: n, value: num(1), bare: true });
      return;
    }
    if (n.kind === 'pcase') {
      // An equation condition parses, and only a reduction accepts it
      // (lib/measure.ts); the resolver refuses it anywhere else.
      if (n.cond.kind !== 'ineq' && n.cond.kind !== 'eq')
        throw new Error('Piecewise conditions must be inequalities, like x < 0.');
      if (otherwise) throw new Error('The default value must come last in {…}.');
      cases.push({ cond: n.cond, value: n.value });
    } else {
      if (k !== items.length - 1) throw new Error('Each piecewise part needs a "condition: value".');
      otherwise = asExpr(n);
    }
  });
  return { kind: 'piecewise', cases, otherwise };
}

/**
 * Close-bracket handler. Shunting yields "content, openMarker" then the close
 * token, so the marker is the last argument (or the only one, for empty
 * brackets like `f()`).
 */
const closer = (open: string, finish: (content: PNode | null, call: boolean) => PNode) =>
  BinaryInfix<PNode>((a, b) => {
    const marker = b ?? a;
    if (!marker || marker.kind !== 'popen') throw new Error('Mismatched brackets.');
    if (marker.bracket !== open)
      throw new Error(`Mismatched brackets: "${marker.bracket}" closed by "${BRACKET_CLOSE[open]}".`);
    return finish(b === undefined ? null : a, marker.call);
  });

const BRACKET_CLOSE: Record<string, string> = { '(': ')', '[': ']', '{': '}' };

const ops = operators<PNode>({
  EOF: Postfix(a => a),

  '}': closer('{', content => {
    if (!content) throw new Error('Empty braces.');
    return bracePiecewise(content);
  }),
  ')': closer('(', (content, call) => {
    // Function-call parens keep their argument series for [apply]; plain
    // parens turn a comma series into a vector literal like (2, 3).
    if (call) return content ?? { kind: 'series', items: [] };
    if (!content) throw new Error('Empty parentheses.');
    if (content.kind === 'series') return seriesToVec(content.items);
    return content.kind === 'ineq' ? { ...content, grouped: true } : content;
  }),
  ']': closer('[', (content, call) => {
    if (!content) throw new Error('Empty list.');
    // A comma series is a data list; a single item keeps its grouping meaning.
    if (content.kind === 'series') return { kind: 'list', items: content.items.map(asExpr) };
    // A lone range is a list too ([1..10] expands during resolution) — but
    // not in a call bracket, where int[a..b] / sum[n=1..N] own the range.
    if (!call && content.kind === 'range') {
      return { kind: 'list', items: [content] };
    }
    return content;
  }),

  // Either side of '=' may be a tuple, so (x', y') = (y, -sin(x)) parses.
  // (In `sum(n = 1..N, body)` the ',' binds tighter than '=', so the rhs
  // arrives as the tuple (1..N, body); sumCall unpacks that shape.)
  '=': BinaryInfix<PNode>((a, b): PNode =>
    holdsConditions(a) || holdsConditions(b)
      ? { kind: 'peq', l: a, r: b }
      : { kind: 'eq', l: asVecOrExpr(a), r: asVecOrExpr(b) },
  ),

  ',': BinaryInfix<PNode>((a, b) => {
    const items = (n: PNode): Array<Expr | PCase> =>
      n.kind === 'series' ? n.items : n.kind === 'pcase' ? [n] : [asExpr(n)];
    return { kind: 'series', items: [...items(a), ...items(b)] };
  }),

  ':': BinaryInfix<PNode>((a, b): PNode => ({ kind: 'pcase', cond: asExpr(a), value: asExpr(b) })),

  // Equality, for filters only: `people[people.city == "NYC"]`. Unlike <
  // and >, it is not a relation the plane can shade, so it lowers to a mask
  // (list.ts) and reports itself anywhere else. Recognized as one token each
  // so '!=' never half-matches as postfix '!' followed by '=', which would
  // silently graph factorial(x) = 2.
  '==': BinaryInfix<PNode>((a, b): Expr => ({ kind: 'eqtest', op: '==', args: [asVecOrExpr(a), asVecOrExpr(b)] })),
  '!=': BinaryInfix<PNode>((a, b): Expr => ({ kind: 'eqtest', op: '!=', args: [asVecOrExpr(a), asVecOrExpr(b)] })),
  '≠': BinaryInfix<PNode>((a, b): Expr => ({ kind: 'eqtest', op: '!=', args: [asVecOrExpr(a), asVecOrExpr(b)] })),

  '<': asIneq('<'),
  '<=': asIneq('<='),
  '≤': asIneq('<='),
  '>': asIneq('>'),
  '>=': asIneq('>='),
  '≥': asIneq('>='),

  // Σ/Π index ranges: `1..N` (only meaningful inside sum()/prod()).
  '..': BinaryInfix<PNode>((a, b): Expr => ({ kind: 'range', args: [asExpr(a), asExpr(b)] })),

  '+': asBin('+'),
  '-': asBin('-'),
  '−': asBin('-'),

  '*': asBin('*'),
  '×': asProduct('cross'),
  '·': asProduct('dot'),
  '⋅': asProduct('dot'),
  '⊗': asProduct('outer'),
  '⟑': asProduct('geometric'),
  '∧': asProduct('wedge'),
  '/': asBin('/'),
  '÷': asBin('/'),

  '[neg]': Prefix<PNode>((a): Expr => ({ kind: 'neg', a: asVecOrExpr(a) })),

  '[impl]': asBin('*'),

  '^': BinaryRightInfix<PNode>((a, b): PNode => bin('^')(asVecOrExpr(a), asVecOrExpr(b))),

  // Postfix factorial: declared after '^' so 2^3! parses as 2^(3!), and
  // [neg] (sharing '^'s level) stays below it: -x! is -(x!).
  '!': Postfix<PNode>((a): Expr => ({ kind: 'call', name: 'factorial', args: [asExpr(a)] })),

  // Function application: binds tighter than '^' so sin(x)^2 means (sin(x))^2.
  '[apply]': BinaryInfix<PNode>((a, b): Expr => {
    if (a?.kind !== 'var' || !isFnName(a.name)) throw new Error('Expected a function name.');
    const name = canonicalFn(a.name);
    if (name === 'sum' || name === 'prod') return sumCall(name, b?.kind === 'peq' ? asExpr(b) : b);
    if (name === 'int') return intCall(b);
    const args = b?.kind === 'series' ? b.items.map(asExpr) : [asExpr(b)];
    return { kind: 'call', name, args };
  }),

  // List indexing: `L[2]` for a known list name L (1-based; list.ts lowers
  // it), a sort(…) call, or a list literal right against its index (see
  // addImplicitTokens) — `x[2]` keeps meaning 2x.
  '[at]': BinaryInfix<PNode>((a, b): Expr => ({ kind: 'index', args: [asExpr(a), asVecOrExpr(b)] })),

  // Column access: `person.age` is one name, not a product. Binding tighter
  // than everything else, it is purely a naming device — the dotted name
  // reaches list lowering, which substitutes the column (see defs.ts).
  '.': BinaryInfix<PNode>((a, b): Expr => {
    if (a?.kind !== 'var' || b?.kind !== 'var') {
      throw new Error('Write a column as table.column, like people.age.');
    }
    return { kind: 'var', name: `${a.name}.${b.name}` };
  }),
});

const isRange = (e: Expr): e is Expr & { kind: 'range' } => e.kind === 'range';

/**
 * Shape an ∫ into a call node: args are [lo, hi] for the header form
 * `int[a..b] …` (body bound from its product chain, like Σ), [body] for the
 * indefinite `int(f dx)`, and [lo, hi, body] for `int(a..b, f dx)`.
 * resolveExpr integrates all of them symbolically (or expands a quadrature).
 */
function intCall(b: PNode | null | undefined): Expr {
  const usage = () => new Error('Expected int(f(x) dx) or int[a..b] f(x) dx.');
  if (!b || b.kind === 'popen') throw usage();
  const items = b.kind === 'series' ? b.items.map(asExpr) : [asExpr(b)];
  const ranges = items.filter(isRange);
  const bodies = items.filter(x => !isRange(x));
  if (!items.length || ranges.length > 1 || bodies.length > 1) throw usage();
  const bounds = ranges.length ? [ranges[0].args[0], ranges[0].args[1]] : [];
  if (!bodies.length) {
    if (!bounds.length) throw usage();
    return { kind: 'call', name: 'int', args: bounds }; // header awaiting its body
  }
  return { kind: 'call', name: 'int', args: [...bounds, bodies[0]] };
}

/**
 * Shape a Σ/Π header into a call node: args are [index, lo, hi] for the
 * header-only form `sum[n=1..N] …` and [index, lo, hi, body] for
 * `sum(n=1..N, body)` — whose `n = (1..N, body)` arrives as an equation with
 * a tuple rhs. resolveExpr expands both symbolically.
 */
function sumCall(name: 'sum' | 'prod', b: PNode): Expr {
  const usage = () => new Error(`Expected ${name}(n=1..N, …).`);
  if (b.kind !== 'eq' || b.l.kind !== 'var') throw usage();
  const idx = b.l;
  let range = b.r;
  let body: Expr | null = null;
  if (range.kind === 'vec') {
    if (range.items.length !== 2) throw usage();
    [range, body] = range.items;
  }
  if (!isRange(range)) throw usage();
  const args = [idx, range.args[0], range.args[1]];
  if (body) args.push(body);
  return { kind: 'call', name, args };
}

// Unary minus and '^' must share a precedence level (both right-associative):
// '-x^2' parses as -(x^2) and 'x^-1' as x^(-1) without either popping the other.
ops['[neg]'].prec = ops['^'].prec;

// Indexing shares application's level (both associate left), so sort(L)[2]
// indexes the call rather than calling sort on L[2].
ops['[at]'].prec = ops['[apply]'].prec;

// All comparators share one precedence level so chains like 0 <= y < x
// associate left: ((0 <= y) < x), the shape classify flattens.
for (const k of ['<=', '≤', '>', '>=', '≥']) ops[k].prec = ops['<'].prec;

// Unicode spellings share their operator's level (each key otherwise gets its
// own), so 5 − 3 - 1 and 5 - 3 − 1 both associate left: ((5 − 3) - 1).
ops['−'].prec = ops['-'].prec;
for (const k of ['×', '·', '⋅', '⊗', '∧', '⟑']) ops[k].prec = ops['*'].prec;
ops['÷'].prec = ops['/'].prec;
ops['≠'].prec = ops['!='].prec;

const MULTI_CHAR_OPS = Object.keys(ops).filter(o => o.length > 1);

/**
 * Unicode in names. Greek letters are ordinary name characters: θ, φ1 and Δx
 * are variables exactly like a, b1 and dx, and adjacent letters glue into
 * one name the way `xy` always has. Subscript digits may be WRITTEN wherever
 * a name is, but only as the unicode spelling of the `_` subscript the
 * language already has (see canonicalName): T₀ is T_0, never a name of its
 * own. Excluded are the glyphs that stand for
 * something by themselves — π and τ (constants) and the operator-like
 * Σ Π ∫ ∞ ∇ — which tokenize as standalone glyph tokens so πr means π·r
 * (see GLYPH_ALIASES). µ is the micro sign Mac keyboards type for mu; it is
 * just a name character of its own.
 */
export const GREEK_NAME_CHARS = 'αβγδεζηθικλμνξορςσυφχψω' + 'ΑΒΓΔΕΖΗΘΙΚΛΜΝΞΟΡΤΥΦΧΨΩ' + 'ϑϕϖϱϵµ';
/** Regex character-class fragment for a name's first character. */
export const NAME_START_CHARS = `A-Za-z_${GREEK_NAME_CHARS}`;
/**
 * Regex character-class fragment for a name's later characters AS WRITTEN
 * in row text. Subscript digits are matched here because a written name may
 * carry them, but they are not name characters — they are the unicode
 * spelling of the `_` subscript, and canonicalName() rewrites every name
 * the tokenizer or a row scanner captures (T₀ → T_0), so no canonical name
 * (a defs key, a free variable, a suggestion) ever contains one. Everything
 * that READS row text — the symbol pattern, the row-shape regexes, prime
 * detection, the typeahead's word — matches the written form.
 */
export const WRITTEN_NAME_CHARS = `${NAME_START_CHARS}0-9₀₁₂₃₄₅₆₇₈₉`;
/** Regex source for a whole name as written — the app's row-shape regexes
 *  build on it and canonicalize what they capture, so a definition binds
 *  exactly the name the tokenizer produces. */
export const NAME_SRC = `[${NAME_START_CHARS}][${WRITTEN_NAME_CHARS}]*`;

/**
 * Standalone glyphs and the names they mean. Single characters only: a glyph
 * never absorbs a following letter, so πr is π·r and ∇f is grad f — where a
 * plain symbol like xy is one name.
 */
const GLYPH_ALIASES: Record<string, string> = {
  Σ: 'sum',
  '∑': 'sum',
  Π: 'prod',
  '∏': 'prod',
  '∫': 'int',
  '∞': 'inf',
  '∇': 'grad',
  π: 'pi',
  τ: 'tau',
};
export const GLYPH_CHARS = Object.keys(GLYPH_ALIASES).join('');

const SUPERSCRIPTS: Record<string, string> = {
  '⁰': '0',
  '¹': '1',
  '²': '2',
  '³': '3',
  '⁴': '4',
  '⁵': '5',
  '⁶': '6',
  '⁷': '7',
  '⁸': '8',
  '⁹': '9',
  '⁻': '-',
};
export const SUPERSCRIPT_CHARS = Object.keys(SUPERSCRIPTS).join('');

const SUBSCRIPT_RE = /[₀-₉]/;

/**
 * The canonical spelling of a name: subscript digits are the `_` subscript
 * syntax the language already reads, not their own characters — T₀ is T_0
 * and θ₁₂ is θ_12. One rule for every reader of a name: the tokenizer
 * (below) and the raw-text row scanners (definitions, ~ declarations,
 * regressions, drag) all pass captured names through here, so r₁ reaches a
 * vector state's r_1 component and a₃ the third term of a sequence.
 */
export const canonicalName = (name: string): string =>
  name.replace(/[₀-₉]+/g, run => '_' + [...run].map(c => String(c.codePointAt(0)! - 0x2080)).join(''));

const syntax: PatternDict = {
  parenopen: /^[({[]$/,
  parenclose: /^[)}\]]$/,
  number: /^\d+\.?\d*$/,
  superscript: new RegExp(`^[${SUPERSCRIPT_CHARS}]+$`),
  bar: /^\|$/,
  whitespace: /\s$/,
  glyph: new RegExp(`^[${GLYPH_CHARS}]$`),
  symbol: new RegExp(`^[${NAME_START_CHARS}][${WRITTEN_NAME_CHARS}]*'*$`),
  // A quote only opens text where a token can start, so `x'` (prime) and
  // `f'(x)` still tokenize as symbols — the symbol match gets there first.
  string: /^("[^"]*"?|'[^']*'?)$/,
  operator: x => !!ops[x] || MULTI_CHAR_OPS.some(m => m.startsWith(x)),
  invalid(x) {
    if (x === '\\') {
      throw new Error(
        'Invalid character: "\\". Write the symbol itself (π, θ, ∇, …)' +
          ' — in the editor, typing \\pi, \\theta or \\nabla inserts it.',
      );
    }
    throw new Error(`Invalid character: ${JSON.stringify(x)}.`);
  },
};

const tokenize = Tokenizer(syntax);

/**
 * Lower unicode sugar to plain tokens: glyphs to the names they stand for
 * (π → pi, Σ → sum), superscript runs to an exponent — x³ is x ^ 3 and
 * x⁻² is x ^ - 2, whose '-' becomes the [neg] prefix downstream and shares
 * ^'s precedence, so it binds as x^(-2).
 */
function* desugarUnicode(bare: Iterable<Token>): Iterable<Token> {
  for (const token of bare) {
    if (token.type === 'glyph') {
      yield { ...token, type: 'symbol', str: GLYPH_ALIASES[token.str] };
    } else if (token.type === 'symbol' && SUBSCRIPT_RE.test(token.str)) {
      yield { ...token, str: canonicalName(token.str) };
    } else if (token.type === 'superscript') {
      const digits = [...token.str].map(c => SUPERSCRIPTS[c]).join('');
      if (!/^-?\d+$/.test(digits)) throw new Error(`Cannot read the exponent ${token.str}.`);
      yield { ...token, type: 'operator', str: '^' };
      if (digits[0] === '-') yield { ...token, type: 'operator', str: '-' };
      yield { ...token, type: 'number', str: digits.replace('-', '') };
    } else {
      yield token;
    }
  }
}

function op(str: string): Token {
  return { type: 'operator', str, line: -1, loc: [-1, -1] };
}

/**
 * Settle what a '.' means.
 *
 * The greedy number match takes "1." out of `1..N`, leaving a lone "."
 * operator, so the dot rejoins into "..". A '.' with no value before it and a
 * number after it is a leading-dot decimal (`.5`); every other '.' is the
 * column-access operator (`person.age`).
 */
function* normalizeTokens(bare: Iterable<Token>): Iterable<Token> {
  let held: Token | null = null;
  let dot: Token | null = null;
  let afterValue = false;
  const ends = (t: Token): boolean =>
    t.type === 'number' ||
    t.type === 'symbol' ||
    t.type === 'parenclose' ||
    t.type === 'string' ||
    (t.type === 'operator' && t.str === '!');
  for (let token of bare) {
    if (held) {
      if (token.type === 'operator' && token.str.startsWith('.')) {
        yield { ...held, str: held.str.slice(0, -1) };
        token = { ...token, str: '.' + token.str };
      } else {
        yield held;
      }
      afterValue = true;
      held = null;
    }
    if (dot) {
      if (!afterValue && token.type === 'number') {
        token = { ...token, str: '0.' + token.str };
        dot = null;
        // `[.5..2]`: the number scan is greedy, so it already took the first
        // dot of the range operator (`5.`). Yielding here would spend it and
        // leave a lone `.`; hand it to `held` instead and let the merge above
        // pair it with the next one.
        if (token.str.endsWith('.')) {
          held = token;
          continue;
        }
        yield token;
        afterValue = true;
        continue;
      }
      yield dot;
      afterValue = false;
      dot = null;
    }
    if (token.type === 'number' && token.str.endsWith('.')) {
      held = token;
      continue;
    }
    if (token.type === 'operator' && token.str === '.') {
      dot = token;
      continue;
    }
    yield token;
    afterValue = ends(token);
  }
  if (held) yield held;
  if (dot) yield dot;
}

/**
 * A subscript written in braces, as recurrence rows are: `T_{c}` is T_c and
 * `a_{10}` is a_10 — one name, as the definition `T_{c} = 300` binds it.
 * Only a single name or whole number; `a_{n+1}` stays an index (a sequence's,
 * see addImplicitTokens).
 */
function* mergeBracedSubscripts(bare: Iterable<Token>): Iterable<Token> {
  const all = [...bare];
  const skip = (k: number) => {
    while (all[k]?.type === 'whitespace') k++;
    return k;
  };
  for (let i = 0; i < all.length; i++) {
    const token = all[i];
    if (
      token.type === 'symbol' &&
      token.str.endsWith('_') &&
      all[i + 1]?.type === 'parenopen' &&
      all[i + 1].str === '{'
    ) {
      const at = skip(i + 2);
      const inner = all[at];
      const close = skip(at + 1);
      if (
        (inner?.type === 'symbol' || (inner?.type === 'number' && /^\d+$/.test(inner.str))) &&
        all[close]?.type === 'parenclose' &&
        all[close].str === '}'
      ) {
        yield { ...token, str: token.str + inner.str };
        i = close;
        continue;
      }
    }
    yield token;
  }
}

/**
 * Insert implicit multiplication tokens (2x, x(x+1), (x+1)(x-1), x y) and
 * rewrite unary +/- into a dedicated prefix operator.
 */
function* addImplicitTokens(bare: Iterable<Token>): Iterable<Token> {
  let last: Token | null = null;
  /** The dotted name ending at `last` when it is a symbol: `person.age`. */
  let path: string | null = null;
  let barDepth = 0;
  /** What each open bracket is: the function it calls, an index, or null. */
  const opened: (string | null)[] = [];
  /** What the bracket `last` closed was. */
  let closed: string | null = null;
  for (const token of bare) {
    if (token.type === 'whitespace') continue;

    // A postfix operator (per the ops table: '!') ends a value, so 5!x and
    // 3!(x+1) multiply implicitly.
    const afterPostfix = last?.type === 'operator' && ops[last.str]?.n === 1 && !ops[last.str].right;
    // Text is a value like any other here: `2 "NYC"` multiplies and `"NYC" + 1`
    // adds, so both reach the check that says text has no numeric value.
    // Without this the '+' reads as a unary sign and the row dies as
    // "Incomplete expression.", which sends the reader hunting for a typo.
    const afterValue =
      last !== null &&
      (last.type === 'number' ||
        last.type === 'symbol' ||
        last.type === 'parenclose' ||
        last.type === 'string' ||
        afterPostfix);

    if (token.type === 'bar') {
      // |x| is abs(x): a bar after a value closes the innermost open bar;
      // any other bar opens one (with implicit multiplication, as in 2|x|).
      if (barDepth > 0 && afterValue) {
        barDepth--;
        const close: Token = { ...token, type: 'parenclose', str: ')' };
        yield close;
        last = close;
        closed = opened.pop() ?? null;
      } else {
        barDepth++;
        if (afterValue) yield op('[impl]');
        yield { ...token, type: 'symbol', str: 'abs' };
        yield op('[apply]');
        const open: Token = { ...token, type: 'parenopen', str: '(', call: true };
        yield open;
        last = open;
        opened.push('abs');
      }
      path = null;
      continue;
    }

    if (token.type === 'operator' && (token.str === '-' || token.str === '−' || token.str === '+')) {
      if (!afterValue) {
        // Unary sign: drop unary plus, rewrite minus as the [neg] prefix op.
        if (token.str !== '+') yield op('[neg]');
        last = token;
        path = null;
        continue;
      }
    }

    let emit = token;
    let indexing = false;
    if (
      afterValue &&
      (token.type === 'number' || token.type === 'symbol' || token.type === 'parenopen' || token.type === 'string')
    ) {
      // A column or list indexes under its full name: person.age[2]. Decided
      // BEFORE the function reading and beating it, because a name can be
      // both: a CSV column headed `sin` gives `person.sin`, and `mean` is
      // shadowable, so `mean = [1, 4, 2]` then `mean[2]` is an index.
      // A sequence also takes its index in braces or parens, as its
      // recurrence row is written: a_{n+1}, a_(n-1), a_{10}.
      // A sort(…) is a tuple, so it indexes as one: sort(L)[2]. A list
      // literal written right against its index, [3, 1, 2][2], is indexed
      // too, so it can say it has no order. A bracket index is written
      // right against what it indexes: with a space, L [2], sort(L) [2] and
      // [1, 2] [3] multiply (docs/multisets.md §9).
      const touching = last!.loc[1] === token.loc[0];
      const isIndex =
        token.type === 'parenopen' &&
        (last!.type === 'symbol'
          ? token.str === '['
            ? touching && indexes(path ?? last!.str)
            : last!.str.endsWith('_') && activeListNames.has(last!.str)
          : token.str === '[' && touching && last!.type === 'parenclose' && (closed === 'sort' || closed === '[list]'));
      const isFnCall =
        !isIndex &&
        !path?.includes('.') &&
        token.type === 'parenopen' &&
        last!.type === 'symbol' &&
        isFnName(last!.str);
      indexing = isIndex;
      yield op(isFnCall ? '[apply]' : isIndex ? '[at]' : '[impl]');
      if (isFnCall) emit = { ...token, call: true };
    }

    const afterDot = last?.type === 'operator' && last.str === '.';
    if (emit.type === 'parenopen') {
      opened.push(
        emit.call ? (builtinFn(last!.str) ?? last!.str) : indexing ? '[at]' : emit.str === '[' ? '[list]' : null,
      );
    }
    closed = emit.type === 'parenclose' ? (opened.pop() ?? null) : null;
    yield emit;
    last = emit;
    path =
      emit.type === 'symbol'
        ? afterDot && path
          ? `${path}.${emit.str}`
          : emit.str
        : emit.type === 'operator' && emit.str === '.'
          ? path
          : null;
  }
}

/** `[]` is the empty multiset, `[1,2] + [] = []` (docs/multisets.md §1). An
 *  operator-precedence parser has no operand to hang an empty bracket on, so
 *  the pair arrives as one symbol token that no user can type. */
const EMPTY_LIST = '[]';

function* mergeEmptyBrackets(tokens: Iterable<Token>): Iterable<Token> {
  let open: Token | null = null;
  for (const token of tokens) {
    if (open) {
      if (token.type === 'whitespace') continue;
      if (token.type === 'parenclose' && token.str === ']') {
        yield { ...open, type: 'symbol', str: EMPTY_LIST };
        open = null;
        continue;
      }
      yield open;
      open = null;
    }
    if (token.type === 'parenopen' && token.str === '[') open = token;
    else yield token;
  }
  if (open) yield open;
}

function createLeaf(token: Token): PNode {
  if (token.type === 'number') return num(Number(token.str));
  if (token.type === 'string') {
    const q = token.str[0];
    if (token.str.length < 2 || !token.str.endsWith(q)) {
      throw new Error(`Unterminated text: ${token.str}`);
    }
    // A `;` inside text used to be refused here, because the link codec could
    // not tell it from the separator between rows and the row came back split.
    // It can now (lib/link.ts encodes a row's own semicolons twice), and text
    // is data — a city, a category — that has no business being narrowed to
    // the characters a URL found convenient.
    return { kind: 'str', value: token.str.slice(1, -1) };
  }
  if (token.type === 'parenopen') return { kind: 'popen', bracket: token.str, call: !!token.call };
  if (token.type === 'symbol') {
    if (token.str === EMPTY_LIST) return { kind: 'list', items: [] };
    if (Object.hasOwn(CONSTANTS, token.str)) return num(CONSTANTS[token.str]);
    return { kind: 'var', name: token.str };
  }
  throw new Error(`Invalid token: ${token.type} ${JSON.stringify(token.str)}`);
}

/**
 * Parse an expression or equation, keeping free variables symbolic.
 * Names in userFns parse as function calls (`f(x+1)`) instead of products;
 * names in valueNames that a late-addition builtin would claim parse as
 * variables, so an older graph keeps the meaning it was shared with.
 */
export function parseExpr(
  str: string,
  userFns: ReadonlySet<string> = new Set(),
  listNames: ReadonlySet<string> = new Set(),
  valueNames: ReadonlySet<string> = new Set(),
): Expr {
  activeUserFns = userFns;
  activeListNames = listNames;
  activeValueNames = valueNames;
  try {
    const tokens = addImplicitTokens(
      mergeEmptyBrackets(mergeBracedSubscripts(normalizeTokens(desugarUnicode(tokenize(str))))),
    );
    const stack: PNode[] = [];
    walk(
      ops,
      createLeaf,
      shunting(ops, tokens),
      node => stack.push(node),
      n => stack.splice(stack.length - n),
    );
    if (stack.length !== 1) throw new Error('Incomplete expression.');
    const top = stack[0];
    // A bare top-level comma series (no parens) still reads as a vector.
    if (top.kind === 'series') return seriesToVec(top.items);
    return asExpr(top);
  } finally {
    activeUserFns = new Set();
    activeListNames = new Set();
    activeValueNames = new Set();
  }
}

/** Immediate expression children. Packed numeric and text columns are leaves. */
export function childrenOf(e: Expr): readonly Expr[] {
  switch (e.kind) {
    case 'neg':
      return [e.a];
    case 'bin':
      return [e.a, e.b];
    case 'index':
    case 'range':
    case 'eqtest':
    case 'call':
      return e.args;
    case 'comp':
      return [e.value];
    case 'figure':
      return e.vertices;
    case 'lazy':
      return [e.body];
    case 'trail':
    case 'label':
      return e.coordinates;
    case 'family':
      return e.members;
    case 'eq':
    case 'ineq':
      return [e.l, e.r];
    case 'vec':
    case 'list':
      return e.items;
    case 'piecewise':
      return e.cases.flatMap(c => [c.cond, c.value]).concat(e.otherwise ? [e.otherwise] : []);
    case 'loop':
      return [...e.seeds, e.body];
    default:
      return [];
  }
}

/** Map one child level, preserving metadata and reusing unchanged nodes. */
export function mapChildren(e: Expr, map: (child: Expr) => Expr): Expr {
  const old = childrenOf(e),
    next = old.map(map);
  if (next.every((child, i) => child === old[i])) return e;
  switch (e.kind) {
    case 'neg':
      return { ...e, a: next[0] };
    case 'bin':
      return { ...e, a: next[0], b: next[1] };
    case 'index':
    case 'range':
    case 'eqtest':
      return { ...e, args: [next[0], next[1]] };
    case 'call':
      return { ...e, args: next };
    case 'comp':
      return { ...e, value: next[0] };
    case 'figure':
      return { ...e, vertices: next };
    case 'lazy':
      return { ...e, body: next[0] };
    case 'trail':
    case 'label':
      return { ...e, coordinates: next };
    case 'family':
      return { ...e, members: next };
    case 'eq':
    case 'ineq':
      return { ...e, l: next[0], r: next[1] };
    case 'vec':
    case 'list':
      return { ...e, items: next };
    case 'piecewise':
      return {
        ...e,
        cases: e.cases.map((c, i) => ({
          cond: next[2 * i],
          value: next[2 * i + 1],
          ...(c.bare ? { bare: c.bare } : {}),
        })),
        otherwise: e.otherwise ? next[next.length - 1] : undefined,
      };
    case 'loop':
      return { ...e, seeds: next.slice(0, e.seeds.length), body: next[e.seeds.length] };
    default:
      return e;
  }
}

/** Stable mathematical serialization excludes transient list identity. */
export const exprReplacer = (key: string, value: unknown): unknown =>
  key === 'axes' || key === 'origin' ? undefined : value;
export const exprKey = (value: unknown): string => JSON.stringify(value, exprReplacer);
let origins = 0;
export const originOf = (e: Expr): number | undefined => e.origin;
export function markOrigins(root: Expr): void {
  const seen = new WeakSet<Expr>();
  const walk = (e: Expr): void => {
    if (seen.has(e)) return;
    seen.add(e);
    if (e.kind === 'list' && e.origin === undefined) e.origin = ++origins;
    childrenOf(e).forEach(walk);
  };
  walk(root);
}
export function sameList<T extends Expr>(from: Expr, to: T): T {
  if (from.axes !== undefined) to.axes = from.axes;
  if (from.origin !== undefined) to.origin = from.origin;
  return to;
}

/** Replace free variables by expressions. A surviving Σ/Π binds its index. */
export function substVars(e: Expr, env: Record<string, Expr>): Expr {
  if (e.kind === 'var') return Object.hasOwn(env, e.name) ? env[e.name] : e;
  if (isBoundSum(e) && e.args[0]?.kind === 'var' && Object.hasOwn(env, e.args[0].name)) {
    const bodyEnv = { ...env };
    delete bodyEnv[e.args[0].name];
    const args = e.args.map((a, k) => substVars(a, k === 0 || k === 3 ? bodyEnv : env));
    return args.every((a, k) => a === e.args[k]) ? e : { ...e, args };
  }
  if (e.kind === 'loop') {
    const bodyEnv = { ...env };
    for (const p of e.params) delete bodyEnv[p];
    const seeds = e.seeds.map(a => substVars(a, env));
    // A replacement that mentions a param's name must not be captured by
    // it: rename that param to a name no row can spell before substituting.
    const incoming = new Set<string>();
    for (const x of Object.values(bodyEnv)) for (const v of freeVars(x)) incoming.add(v);
    const renames: Record<string, Expr> = {};
    const params = e.params.map(p => {
      if (!incoming.has(p)) return p;
      let fresh = `${p}.1`;
      for (let k = 2; incoming.has(fresh) || e.params.includes(fresh); k++) fresh = `${p}.${k}`;
      renames[p] = { kind: 'var', name: fresh };
      return fresh;
    });
    const renamed = Object.keys(renames).length ? substVars(e.body, renames) : e.body;
    const body = substVars(renamed, bodyEnv);
    return body === e.body && seeds.every((a, k) => a === e.seeds[k]) ? e : { ...e, params, seeds, body };
  }
  return mapChildren(e, child => substVars(child, env));
}

/** Abramowitz & Stegun 7.1.26; max absolute error ~1.5e-7. */
export function erf(x: number): number {
  const a = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * a);
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-a * a);
  return Math.sign(x) * y;
}

export const normalpdf = (x: number, mean: number, sd: number): number =>
  Math.exp(-0.5 * ((x - mean) / sd) ** 2) / (sd * Math.sqrt(2 * Math.PI));

export const normalcdf = (x: number, mean: number, sd: number): number =>
  0.5 * (1 + erf((x - mean) / (sd * Math.SQRT2)));

/**
 * Largest argument `isprime` decides. Trial division stops at 2048 divisors —
 * the cap the GLSL twin loops to, and within float32's exact-integer range —
 * so both implementations agree wherever they answer at all. Above it they
 * report NaN rather than guessing, and non-finite terms are skipped.
 */
export const ISPRIME_MAX = 2048 * 2048 - 1;

/** a^b tolerance for snapping the exponent to a small rational p/q (real odd roots). */
const POW_RATIONAL_TOL = 1e-6;

/** Largest denominator considered when looking for the exponent's rational form. */
const POW_RATIONAL_MAX_Q = 12;

/**
 * Real-valued a^b, matching how graphing calculators (e.g. Desmos) treat a
 * negative base with a fractional exponent: real odd roots come out real
 * (e.g. (-8)^(1/3) = -2) instead of NaN, while even roots stay undefined
 * (e.g. (-4)^(1/2)).
 *
 * For a >= 0 this is just Math.pow. For a < 0, Math.pow only agrees with the
 * "real odd root" convention when b happens to be an exact integer, so
 * instead we search for the exponent's rational form p/q in lowest terms via
 * a tolerance search over small denominators (q = 1..POW_RATIONAL_MAX_Q — no
 * arbitrary-precision rational type needed, just simple fractions like 1/3,
 * 2/3, 1/5). If q is odd, the root is real: sign * |a|^b, where sign is
 * negative iff p (the reduced numerator) is odd. If no small-denominator
 * match is found within tolerance (an irrational-looking exponent) or q is
 * even (an even root of a negative number), the result is NaN, same as
 * plain Math.pow.
 *
 * The tolerance (1e-6) is deliberately tight: an exponent entered as a
 * fraction (e.g. "1/3") lands within ~1e-16 of the true rational, so it
 * always snaps, but a typed decimal approximation like 0.33333 is ~3.3e-6
 * away from 1/3 — outside tolerance — and is left undefined rather than
 * silently guessed at.
 *
 * Kept in sync with the eq_pow() GLSL twin in glsl.ts (same algorithm, same
 * tolerance and max denominator, adapted to GLSL's lack of a gcd builtin).
 */
export function realPow(a: number, b: number): number {
  if (a >= 0) return Math.pow(a, b);
  for (let q = 1; q <= POW_RATIONAL_MAX_Q; q++) {
    const p = Math.round(b * q);
    let x = Math.abs(p),
      y = q;
    while (y) {
      const t = x % y;
      x = y;
      y = t;
    } // gcd(|p|, q)
    const g = x || 1;
    const pr = p / g,
      qr = q / g;
    if (Math.abs(b - pr / qr) < POW_RATIONAL_TOL) {
      if (qr % 2 === 0) return NaN; // even root of a negative number: undefined
      const sign = Math.abs(pr) % 2 === 1 ? -1 : 1;
      return sign * Math.pow(-a, b);
    }
  }
  return NaN; // no small-denominator rational found: irrational-looking exponent
}

/** Lanczos coefficients (g = 5, n = 6) of the float32 shader twins eq_gamma /
 *  eq_lgamma (glsl.ts interpolates this array): relative error < 2e-10, far
 *  below what a float carries. The CPU side is lgamma() in specfn.ts (g = 7,
 *  ~1e-15) — one ln Γ for gamma(x) and for the distributions alike. */
export const LANCZOS = [
  // oxlint-disable-next-line no-loss-of-precision -- published coefficients, kept verbatim
  76.18009172947146, -86.50532032941677, 24.01409824083091, -1.231739572450155, 0.1208650973866179e-2,
  -0.5395239384953e-5,
];

/**
 * Real Γ(x). Poles at 0, −1, −2, … evaluate to NaN; other negative reals go
 * through the reflection formula Γ(x)Γ(1−x) = π/sin(πx). Overflows to
 * Infinity above x ≈ 171.62, like the rest of double arithmetic. exp(ln Γ):
 * assembling Γ in log space is what keeps it finite up to there.
 */
export function gammaFn(x: number): number {
  if (x < 0.5) {
    if (Number.isInteger(x)) return NaN; // pole
    return Math.PI / (Math.sin(Math.PI * x) * gammaFn(1 - x));
  }
  return Math.exp(lgamma(x));
}

/** k! for k = 0..170, every factorial a double can hold. */
const FACTORIALS = new Float64Array(171);
FACTORIALS[0] = 1;
for (let k = 1; k < FACTORIALS.length; k++) FACTORIALS[k] = FACTORIALS[k - 1] * k;

/** x! = Γ(x + 1), except exact for the whole numbers a double can hold. */
export function factorialFn(x: number): number {
  if (Number.isInteger(x) && x >= 0 && x <= 170) return FACTORIALS[x];
  return gammaFn(x + 1);
}

/**
 * `[term]("eqioSeq_a_", k, …inputs)`: term k of a recurrence, read from the
 * chain of constants that computes it (lib/seq.ts) — how an explicit sequence
 * reads a recurrence at its own changing index (d_n = a_{n+1} - a_n). The
 * trailing arguments are the recurrence's inputs (sliders, t, its seed): not
 * evaluated, only there so the row depends on what the chain does. NaN past
 * the chain or off the whole numbers.
 */
export const TERM_AT_FN = '[term]';

/** The internal call angle(…) lowers to (lib/geom.ts): [angle](u0, u1, v0, v1).
 *  Unwritable, like '[trail]', so it can never collide with a user's name. */
export const ANGLE_FN = '[angle]';

/**
 * `[comp](value, k, n, "f")`: component k (0-based) of `value`, which must be
 * a point of n components — how `f(P)` hands a point to an n-parameter user
 * function. The resolver emits it (it cannot know yet what is a point);
 * geometry lowering settles a single point, list lowering a list of them.
 */
export function structuralDiagnostic(e: Expr): string {
  if (e.kind === 'comp') return compArity(e.functionName, e.arity);
  if (e.kind === 'range')
    return "'..' ranges only appear in sum(n=1..N, …), prod(…), int[a..b], or a list like [1..10].";
  if (e.kind === 'index') return 'List indexing must resolve before scalar evaluation.';
  if (e.kind === 'eqtest') return `'${e.op}' tests a list inside a filter.`;
  return `${e.kind === 'figure' ? e.form : e.kind}(…) must be the whole expression.`;
}
/** The messages of a `[comp]` whose value is not an n-component point. */
export const compArity = (fn: string, n: number): string => `${fn} takes ${n} arguments.`;
/** A `[comp]` that outlived lowering (a list of points where no list can go:
 *  an ODE, a sampled body) — said in the user's terms, not the node's. */
export const strayComp = (e: Expr): string | null => (e.kind === 'comp' ? compArity(e.functionName, e.arity) : null);
export const compDims = (fn: string, n: number, value: Expr, got: number): string =>
  `${fn} takes ${n} arguments, and ${value.kind === 'var' ? value.name : 'that point'} has ${got} components.`;
/** d/dp of [angle] is a difference of two of these, one per arm (lib/diff.ts):
 *  [angle′](v0, v1, w0, w1) is the turning rate of arm v moving with velocity w. */
export const ANGLE_RATE_FN = '[angle′]';

/** The densities of the distributions that have no elementary closed form a
 *  float32 shader survives (lib/dist.ts pdfExpr emits them; lib/specfn.ts and
 *  the eq_*pdf GLSL twins implement them). Unwritable, like '[angle]', so a
 *  document's own `gammapdf` or `tpdf` is never shadowed or shadowing. */
export const GAMMA_PDF_FN = '[gammapdf]';
export const BETA_PDF_FN = '[betapdf]';
export const T_PDF_FN = '[tpdf]';
export const WEIBULL_PDF_FN = '[weibullpdf]';

/** The probability mass functions of the discrete laws (lib/dist.ts pmfExpr
 *  emits them; lib/specfn.ts implements them). First argument k; exactly 0 off
 *  the support and at any k that is not a whole number. CPU only — a pmf is
 *  drawn as stems, never by a shader (lib/glsl.ts refuses them by name). */
export const BINOM_PMF_FN = '[binomialpmf]';
export const POISSON_PMF_FN = '[poissonpmf]';
export const NEGBINOM_PMF_FN = '[negativebinomialpmf]';
export const DUNIFORM_PMF_FN = '[discreteuniformpmf]';
export const PMF_FNS: ReadonlySet<string> = new Set([BINOM_PMF_FN, POISSON_PMF_FN, NEGBINOM_PMF_FN, DUNIFORM_PMF_FN]);

/** The name an internal call wears in a message: `[polygon]` is written
 *  polygon, and both angle helpers are the user's angle. */
export const plainFnName = (name: string): string =>
  name === ANGLE_RATE_FN ? 'angle' : name.startsWith('[') ? name.slice(1, -1) : name;

/**
 * The signed angle turning from arm u to arm v, counterclockwise positive, in
 * (−π, π]. One function rather than atan2(cross, dot) spelled out, because
 * the spelled-out form is wrong at both edges: a zero-length arm has no
 * direction (NaN here, where atan2(0, 0) claims a confident 0), and a
 * straight angle must read π from either side (atan2(−0, −1) is −π). Arms
 * are scaled by their largest component first, so tiny or huge arms neither
 * underflow to "zero length" nor overflow. The GLSL twin is eq_angle.
 */
export function angleFn(u0: number, u1: number, v0: number, v1: number): number {
  const su = Math.max(Math.abs(u0), Math.abs(u1));
  const sv = Math.max(Math.abs(v0), Math.abs(v1));
  if (!(su > 0 && sv > 0)) return NaN; // a zero arm, or a NaN component
  const a0 = u0 / su,
    a1 = u1 / su,
    b0 = v0 / sv,
    b1 = v1 / sv;
  const cross = a0 * b1 - a1 * b0;
  const dot = a0 * b0 + a1 * b1;
  if (cross === 0) return dot < 0 ? Math.PI : dot > 0 ? 0 : NaN; // −0 === 0: no −π
  return Math.atan2(cross, dot);
}

/**
 * (v × w)/|v|²: how fast the direction of arm v turns when v moves with
 * velocity w. Scaled by v's largest component like angleFn, so an arm of
 * length 1e-200 (or 1e-20 in a float32 shader) has the derivative its
 * direction has, not 0/0. The GLSL twin is eq_angle_rate.
 */
export function angleRateFn(v0: number, v1: number, w0: number, w1: number): number {
  const s = Math.max(Math.abs(v0), Math.abs(v1));
  if (!(s > 0)) return NaN;
  const a0 = v0 / s,
    a1 = v1 / s;
  return (a0 * (w1 / s) - a1 * (w0 / s)) / (a0 * a0 + a1 * a1);
}

/** sin(x)/x with the removable hole filled: sinc(0) = 1. */
export const sincFn = (x: number): number => (x === 0 ? 1 : Math.sin(x) / x);

export const cothFn = (x: number): number => 1 / Math.tanh(x);

export const EVAL_FNS: Record<string, (...xs: number[]) => number> = {
  sin: Math.sin,
  cos: Math.cos,
  tan: Math.tan,
  asin: Math.asin,
  acos: Math.acos,
  atan: Math.atan,
  atan2: Math.atan2,
  sinh: Math.sinh,
  cosh: Math.cosh,
  tanh: Math.tanh,
  sech: x => 1 / Math.cosh(x),
  asinh: Math.asinh,
  acosh: Math.acosh,
  atanh: Math.atanh,
  sqrt: Math.sqrt,
  abs: Math.abs,
  exp: Math.exp,
  ln: Math.log,
  log: Math.log10,
  floor: Math.floor,
  ceil: Math.ceil,
  round: Math.round,
  sign: Math.sign,
  min: Math.min,
  max: Math.max,
  mod: (a, b) => a - Math.floor(a / b) * b,
  fract: a => a - Math.floor(a),
  erf,
  normalpdf,
  normalcdf,
  gcd: (a, b) => {
    a = Math.abs(Math.round(a));
    b = Math.abs(Math.round(b));
    while (b) {
      const t = a % b;
      a = b;
      b = t;
    }
    return a;
  },
  isprime: x => {
    const n = Math.round(x);
    if (!isFinite(x) || Math.abs(x - n) > 1e-6 || n < 2) return 0;
    // Past the shared trial-division limit the answer is unknown, not prime.
    // This runs per frame for sequence terms and points, where scanning √n
    // divisors (3+ seconds once n nears 2^53) would freeze the frame.
    if (n > ISPRIME_MAX) return NaN;
    for (let i = 2; i * i <= n; i++) if (n % i === 0) return 0;
    return 1;
  },
  gamma: gammaFn,
  factorial: factorialFn,
  sinc: sincFn,
  [ANGLE_FN]: angleFn,
  [ANGLE_RATE_FN]: angleRateFn,
  coth: cothFn,
  [GAMMA_PDF_FN]: gammaPdf,
  [BETA_PDF_FN]: betaPdf,
  [T_PDF_FN]: studentTPdf,
  [WEIBULL_PDF_FN]: weibullPdf,
  [BINOM_PMF_FN]: binomPmf,
  [POISSON_PMF_FN]: poissonPmf,
  [NEGBINOM_PMF_FN]: negBinomPmf,
  [DUNIFORM_PMF_FN]: discreteUniformPmf,
};

/**
 * How many terms one Σ/Π may run. Symbolic expansion (defs.ts) and a sum
 * whose bound is a sequence index share this cap.
 */
export const SUM_MAX_TERMS = 500;

/** A Σ/Π that survived resolve: args are [index, lo, hi, body]. Its index is bound. */
const isBoundSum = (e: Expr): e is Expr & { kind: 'call'; name: 'sum' | 'prod' } =>
  e.kind === 'call' && (e.name === 'sum' || e.name === 'prod') && e.args.length >= 4 && e.args[0]?.kind === 'var';

/** Σ/Π left for evaluate() because a bound uses a sequence index. */
function evalReduce(e: Expr & { kind: 'call' }, env: Record<string, number>): number {
  const idxE = e.args[0];
  if (idxE?.kind !== 'var') throw new Error(`Expected ${e.name}(n=1..N, …).`);
  const sym = e.name === 'sum' ? 'Σ' : 'Π';
  const lo = evaluate(e.args[1], env);
  const hi = evaluate(e.args[2], env);
  if (!isFinite(lo) || !isFinite(hi)) throw new Error(`${sym} bound is not finite.`);
  const start = Math.ceil(lo - 1e-9);
  const end = Math.floor(hi + 1e-9);
  const count = end - start + 1;
  if (count > SUM_MAX_TERMS) throw new Error(`${sym} expands to ${count} terms (limit ${SUM_MAX_TERMS}).`);
  const idx = idxE.name;
  const prev = env[idx];
  const had = Object.hasOwn(env, idx);
  try {
    let acc = e.name === 'sum' ? 0 : 1;
    for (let k = start; k <= end; k++) {
      env[idx] = k;
      const term = evaluate(e.args[3], env);
      acc = e.name === 'sum' ? acc + term : acc * term;
    }
    return acc;
  } finally {
    if (had) env[idx] = prev;
    else delete env[idx];
  }
}

/** Numerically evaluate a scalar expression with the given variable bindings. */
export function evaluate(e: Expr, env: Record<string, number>): number {
  switch (e.kind) {
    case 'num':
      return e.value;
    case 'var': {
      if (!(e.name in env)) throw new Error(`Unbound variable: ${e.name}`);
      return env[e.name];
    }
    case 'neg':
      return -evaluate(e.a, env);
    case 'bin': {
      const a = evaluate(e.a, env);
      const b = evaluate(e.b, env);
      switch (e.op) {
        case '+':
          return a + b;
        case '-':
          return a - b;
        case '*':
          return a * b;
        case '/':
          return a / b;
        case '^':
          return realPow(a, b);
      }
    }
    case 'call': {
      if (isBoundSum(e)) return evalReduce(e, env);
      if (e.name === TERM_AT_FN) {
        const [chain, at] = e.args;
        const k = evaluate(at, env);
        const v = chain.kind === 'str' && Number.isInteger(k) ? env[`${chain.value}${k}`] : undefined;
        return v ?? NaN;
      }
      const fn = EVAL_FNS[e.name];
      if (!fn && e.name === INTERVAL)
        throw new Error(
          'An interval is a range of numbers, not one value: draw it in a row of its own, in a tuple, or beside x and y.',
        );
      if (!fn) throw new Error(strayComp(e) ?? `Unknown function: ${e.name}`);
      return fn(...e.args.map(a => evaluate(a, env)));
    }
    case 'eq':
      return evaluate(e.l, env) - evaluate(e.r, env);
    case 'index':
    case 'range':
    case 'eqtest':
    case 'comp':
    case 'figure':
    case 'lazy':
    case 'trail':
    case 'label':
    case 'hist':
    case 'family':
      throw new Error(structuralDiagnostic(e));
    case 'ineq':
      throw new Error('Cannot evaluate an inequality.');
    case 'vec':
      throw new Error('Vector in scalar context.');
    case 'list':
    case 'data':
      throw new Error('List in scalar context.');
    case 'str':
    case 'text':
      throw new Error('Text has no numeric value — it can only be compared, inside a filter.');
    case 'piecewise': {
      for (const c of e.cases) {
        if (c.cond.kind !== 'ineq') throw new Error('Piecewise conditions must be inequalities.');
        const holds = ineqComparisons(c.cond).every(({ op, l, r }) => {
          const a = evaluate(l, env);
          const b = evaluate(r, env);
          return op === '<' ? a < b : op === '<=' ? a <= b : op === '>' ? a > b : a >= b;
        });
        if (holds) return evaluate(c.value, env);
      }
      return e.otherwise ? evaluate(e.otherwise, env) : NaN;
    }
    case 'loop':
      return evalLoop(e, env);
  }
}

/** Run a loop: like Σ, the params shadow env entries for the duration. */
function evalLoop(e: Expr & { kind: 'loop' }, env: Record<string, number>): number {
  const saved = e.params.map(p => [Object.hasOwn(env, p), env[p]] as const);
  let state = e.seeds.map(a => evaluate(a, env));
  try {
    for (let pass = 0; pass < e.limit; pass++) {
      if (!state.every(isFinite)) return NaN;
      e.params.forEach((p, k) => {
        env[p] = state[k];
      });
      // The taken leaf: the piecewise selects it; a NaN pick is "no case".
      const leaf = pickLeaf(e.body, env);
      if (!leaf) return NaN;
      if (!isRecur(leaf)) return evaluate(leaf, env);
      state = leaf.args.map(a => evaluate(a, env));
    }
    return NaN;
  } finally {
    saved.forEach(([had, value], k) => {
      if (had) env[e.params[k]] = value;
      else delete env[e.params[k]];
    });
  }
}

function pickLeaf(body: Expr, env: Record<string, number>): Expr | null {
  if (body.kind !== 'piecewise') return body;
  for (const c of body.cases) {
    if (c.cond.kind !== 'ineq') throw new Error('Piecewise conditions must be inequalities.');
    const holds = ineqComparisons(c.cond).every(({ op, l, r }) => {
      const a = evaluate(l, env);
      const b = evaluate(r, env);
      return op === '<' ? a < b : op === '<=' ? a <= b : op === '>' ? a > b : a >= b;
    });
    if (holds) return pickLeaf(c.value, env);
  }
  return body.otherwise ? pickLeaf(body.otherwise, env) : null;
}

/** Collect free variable names (excluding function names and constants). */
export function freeVars(e: Expr, out = new Set<string>()): Set<string> {
  switch (e.kind) {
    case 'num':
      break;
    case 'var':
      out.add(e.name);
      break;
    case 'bin':
      freeVars(e.a, out);
      freeVars(e.b, out);
      break;
    case 'neg':
      freeVars(e.a, out);
      break;
    case 'call': {
      const idx = e.args[0];
      if (isBoundSum(e) && idx?.kind === 'var') {
        freeVars(e.args[1], out);
        freeVars(e.args[2], out);
        const inner = freeVars(e.args[3]);
        inner.delete(idx.name);
        for (const v of inner) out.add(v);
        break;
      }
      e.args.forEach(a => freeVars(a, out));
      break;
    }
    case 'figure':
    case 'lazy': {
      // A template's column variables are bound by the template itself.
      const cols = e.kind === 'lazy' ? e.cols : e.over;
      if (!cols) {
        childrenOf(e).forEach(a => freeVars(a, out));
        break;
      }
      const inner = new Set<string>();
      childrenOf(e).forEach(a => freeVars(a, inner));
      for (const c of cols) inner.delete(c.name);
      for (const v of inner) out.add(v);
      break;
    }
    case 'index':
    case 'range':
    case 'eqtest':
    case 'comp':
    case 'trail':
    case 'label':
    case 'hist':
    case 'family':
      childrenOf(e).forEach(a => freeVars(a, out));
      break;
    case 'eq':
      freeVars(e.l, out);
      freeVars(e.r, out);
      break;
    case 'ineq':
      freeVars(e.l, out);
      freeVars(e.r, out);
      break;
    case 'vec':
      e.items.forEach(a => freeVars(a, out));
      break;
    case 'list':
      e.items.forEach(a => freeVars(a, out));
      break;
    case 'data':
    case 'str':
    case 'text':
      break;
    case 'piecewise':
      e.cases.forEach(c => {
        freeVars(c.cond, out);
        freeVars(c.value, out);
      });
      if (e.otherwise) freeVars(e.otherwise, out);
      break;
    case 'loop': {
      e.seeds.forEach(a => freeVars(a, out));
      const inner = freeVars(e.body);
      for (const p of e.params) inner.delete(p);
      for (const v of inner) out.add(v);
      break;
    }
  }
  return out;
}
