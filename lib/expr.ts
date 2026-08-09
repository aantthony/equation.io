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

export type IneqOp = '<' | '<=' | '>' | '>=';

export type Expr =
  | { kind: 'num'; value: number }
  | { kind: 'var'; name: string }
  | { kind: 'bin'; op: '+' | '-' | '*' | '/' | '^'; a: Expr; b: Expr }
  | { kind: 'neg'; a: Expr }
  | { kind: 'call'; name: string; args: Expr[] }
  | { kind: 'eq'; l: Expr; r: Expr }
  /** An inequality; chains like 0 < y < x nest left: ((0 < y) < x). */
  | { kind: 'ineq'; op: IneqOp; l: Expr; r: Expr }
  /** A vector literal like (2, 3) or (cos(u), sin(u), v): the whole
   *  statement, an equation side, or an operand ((A + (1, 2))/2 — lowerGeom
   *  expands 2-item operands; 3-item vectors stay top-level values). */
  | { kind: 'vec'; items: Expr[] }
  /** A data list [1, 4, 2] or [(1,2), (3,4)]. Plottable as its own row only. */
  | { kind: 'list'; items: Expr[] }
  /** {cond: value, …, otherwise?}; conditions are inequalities, tried in order. */
  | { kind: 'piecewise'; cases: Array<{ cond: Expr; value: Expr }>; otherwise?: Expr };

/** Functions available in expressions (all map to GLSL builtins or helpers). */
export const FUNCTIONS = new Set([
  'sin', 'cos', 'tan', 'asin', 'acos', 'atan', 'atan2',
  'sinh', 'cosh', 'tanh', 'sech', 'asinh', 'acosh', 'atanh',
  'sqrt', 'abs', 'exp', 'ln', 'log', 'floor', 'ceil', 'round',
  'min', 'max', 'mod', 'sign', 'fract',
  'erf', 'normalpdf', 'normalcdf',
  'gcd', 'isprime', 'gamma', 'factorial', 'sinc', 'coth',
  're', 'im', 'arg', 'conj',
  // List reductions and transforms: lowered symbolically (or evaluated
  // numerically) by list.ts, so nothing downstream ever sees them.
  'mean', 'total', 'count', 'stdev', 'median', 'sort',
  // Point (2D vector) helpers and geometry statements, lowered symbolically
  // by lowerGeom before anything evaluates or compiles them.
  'dot', 'cross', 'perp', 'midpoint', 'unit',
  'segment', 'line', 'polygon', 'square', 'circle',
  // Small-matrix helpers (det, trace, matvec, linear solve), also lowered
  // symbolically — Cramer's rule for 2×2 and 3×3 (see mat.ts).
  'det', 'trace', 'solve',
  // Not real functions: Σ/Π/∫ binders, expanded symbolically by resolveExpr.
  'sum', 'prod', 'int',
  // Whole-expression plot modes (see classify): domain coloring, conformal
  // grids, escape-time iteration, and swept tubes.
  'domain', 'conformal', 'iter', 'tube',
]);

/**
 * Builtins added after graphs existed in the wild: a definition or random
 * variable may claim these names, shadowing the builtin, so a saved graph
 * that defines its own `gamma(x) = …` or `sinc = …` keeps its meaning.
 */
export const SHADOWABLE_FNS: ReadonlySet<string> = new Set([
  'gamma', 'factorial', 'sinc', 'coth',
  'mean', 'total', 'count', 'stdev', 'median', 'sort',
]);

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
const canonicalFn = (name: string): string =>
  activeUserFns.has(name) ? name : (builtinFn(name) ?? name);

const isFnName = (name: string): boolean => activeUserFns.has(name) || builtinFn(name) !== null;

const num = (value: number): Expr => ({ kind: 'num', value });
const bin = (op: '+' | '-' | '*' | '/' | '^') => (a: Expr, b: Expr): Expr => ({ kind: 'bin', op, a, b });

// Private nodes used only while parsing: a comma-joined argument list, an
// open-bracket marker, and a `cond: value` piecewise part.
type PCase = { kind: 'pcase'; cond: Expr; value: Expr };
type POpen = { kind: 'popen'; bracket: string; call: boolean };
type PNode = Expr | { kind: 'series'; items: Array<Expr | PCase> } | PCase | POpen;

function asExpr(n: PNode | undefined): Expr {
  if (!n) throw new Error('Incomplete expression.');
  if (n.kind === 'series') {
    if (n.items.length === 1) return asExpr(n.items[0]);
    throw new Error('Unexpected argument list.');
  }
  if (n.kind === 'pcase') throw new Error('A "condition: value" pair is only valid inside {…}.');
  if (n.kind === 'popen') throw new Error('Incomplete expression.');
  return n;
}

const asVecOrExpr = (n: PNode): Expr =>
  n.kind === 'series' && (n.items.length === 2 || n.items.length === 3)
    ? seriesToVec(n.items)
    : asExpr(n);

// Operators take tuples as operands — a parenthesized pair used in arithmetic
// is a vector literal, so (A + (1, 2))/2 works. Only a function application
// keeps a parenthesized series as an argument list (max(1, 2) stays 2 args):
// the [apply] operator binds before any of these see the series.
const asBin = (op: '+' | '-' | '*' | '/' | '^') =>
  BinaryInfix<PNode>((a, b) => bin(op)(asVecOrExpr(a), asVecOrExpr(b)));

const asIneq = (op: IneqOp) =>
  BinaryInfix<PNode>((a, b): Expr => ({ kind: 'ineq', op, l: asVecOrExpr(a), r: asVecOrExpr(b) }));

/** A comma series of 2–3 scalars in plain brackets is a vector literal. */
function seriesToVec(items: Array<Expr | PCase>): Expr {
  if (items.length === 2 || items.length === 3) return { kind: 'vec', items: items.map(asExpr) };
  throw new Error('Expected 2 or 3 vector components.');
}

/** Assemble {…} content into a piecewise if it contains `cond: value` parts. */
function bracePiecewise(content: PNode): PNode {
  const items = content.kind === 'series' ? content.items : [content];
  if (!items.some(n => n.kind === 'pcase')) {
    return content.kind === 'series' ? seriesToVec(content.items) : content;
  }
  const cases: Array<{ cond: Expr; value: Expr }> = [];
  let otherwise: Expr | undefined;
  items.forEach((n, k) => {
    if (n.kind === 'pcase') {
      if (n.cond.kind !== 'ineq') throw new Error('Piecewise conditions must be inequalities, like x < 0.');
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
    if (marker.bracket !== open) throw new Error(`Mismatched brackets: "${marker.bracket}" closed by "${BRACKET_CLOSE[open]}".`);
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
    return content.kind === 'series' ? seriesToVec(content.items) : content;
  }),
  ']': closer('[', (content, call) => {
    if (!content) throw new Error('Empty list.');
    // A comma series is a data list; a single item keeps its grouping meaning.
    if (content.kind === 'series') return { kind: 'list', items: content.items.map(asExpr) };
    // A lone range is a list too ([1..10] expands during resolution) — but
    // not in a call bracket, where int[a..b] / sum[n=1..N] own the range.
    if (!call && content.kind === 'call' && content.name === '[range]') {
      return { kind: 'list', items: [content] };
    }
    return content;
  }),

  // Either side of '=' may be a tuple, so (x', y') = (y, -sin(x)) parses.
  // (In `sum(n = 1..N, body)` the ',' binds tighter than '=', so the rhs
  // arrives as the tuple (1..N, body); sumCall unpacks that shape.)
  '=': BinaryInfix<PNode>((a, b): Expr => ({ kind: 'eq', l: asVecOrExpr(a), r: asVecOrExpr(b) })),

  ',': BinaryInfix<PNode>((a, b) => {
    const items = (n: PNode): Array<Expr | PCase> =>
      n.kind === 'series' ? n.items : n.kind === 'pcase' ? [n] : [asExpr(n)];
    return { kind: 'series', items: [...items(a), ...items(b)] };
  }),

  ':': BinaryInfix<PNode>((a, b): PNode => ({ kind: 'pcase', cond: asExpr(a), value: asExpr(b) })),

  // Recognized as one token so it never half-matches as postfix '!' followed
  // by '=' — x != 2 would silently graph factorial(x) = 2. There is no ≠
  // relation to plot, so it only explains itself.
  '!=': BinaryInfix<PNode>((): PNode => {
    throw new Error("'!=' is not supported — for a factorial equation, put a space before '=': x! = 2.");
  }),

  '<': asIneq('<'),
  '<=': asIneq('<='),
  '≤': asIneq('<='),
  '>': asIneq('>'),
  '>=': asIneq('>='),
  '≥': asIneq('>='),

  // Σ/Π index ranges: `1..N` (only meaningful inside sum()/prod()).
  '..': BinaryInfix<PNode>((a, b): Expr => ({ kind: 'call', name: '[range]', args: [asExpr(a), asExpr(b)] })),

  '+': asBin('+'),
  '-': asBin('-'),
  '−': asBin('-'),

  '*': asBin('*'),
  '×': asBin('*'),
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
    if (name === 'sum' || name === 'prod') return sumCall(name, b);
    if (name === 'int') return intCall(b);
    // Tuple literals inside a call flatten into the argument list, so
    // tube((a, b, c)) === tube(a, b, c) and |(3, 4)| reaches abs as (3, 4);
    // geometry statements re-pair adjacent scalars into points (lib/geom.ts).
    const items = b?.kind === 'series' ? b.items.map(asExpr) : [asExpr(b)];
    const args = items.flatMap(x => (x.kind === 'vec' ? x.items : [x]));
    return { kind: 'call', name, args };
  }),

  // List indexing: `L[2]` for a known list name L (1-based; list.ts lowers
  // it). Only named lists index — `x[2]` keeps meaning 2x, and a literal
  // `[1,2,3][2]` stays implicit multiplication.
  '[at]': BinaryInfix<PNode>((a, b): Expr =>
    ({ kind: 'call', name: '[index]', args: [asExpr(a), asVecOrExpr(b)] })),

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

const isRange = (e: Expr): e is Expr & { kind: 'call' } => e.kind === 'call' && e.name === '[range]';

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

// All comparators share one precedence level so chains like 0 <= y < x
// associate left: ((0 <= y) < x), the shape classify flattens.
for (const k of ['<=', '≤', '>', '>=', '≥']) ops[k].prec = ops['<'].prec;

const MULTI_CHAR_OPS = Object.keys(ops).filter(o => o.length > 1);

const syntax: PatternDict = {
  parenopen: /^[\(\{\[]$/,
  parenclose: /^[\)\}\]]$/,
  number: /^\d+\.?\d*$/,
  bar: /^\|$/,
  whitespace: /\s$/,
  symbol: /^[A-Za-z_Σ∑Π∏∫∞][A-Za-z_0-9]*'*$/,
  operator: x => !!ops[x] || MULTI_CHAR_OPS.some(m => m.startsWith(x)),
  invalid(x) {
    if (x === '"' || x === "'") {
      throw new Error('Quoted text only belongs in a data row, like people = open("people.csv").');
    }
    throw new Error(`Invalid character: ${JSON.stringify(x)}.`);
  },
};

const tokenize = Tokenizer(syntax);

function op(str: string): Token {
  return { type: 'operator', str, line: -1, loc: [-1, -1] };
}

const SYMBOL_ALIASES: Record<string, string> =
  { 'Σ': 'sum', '∑': 'sum', 'Π': 'prod', '∏': 'prod', '∫': 'int', '∞': 'inf' };

/**
 * Map Σ/Π glyphs to sum/prod, and settle what a '.' means.
 *
 * The greedy number match takes "1." out of `1..N`, leaving a lone "."
 * operator, so the dot rejoins into "..". A '.' with no value before it and a
 * number after it is a leading-dot decimal (`.5`); every other '.' is the
 * column-access operator (`person.age`).
 */
function *normalizeTokens(bare: Iterable<Token>): Iterable<Token> {
  let held: Token | null = null;
  let dot: Token | null = null;
  let afterValue = false;
  const ends = (t: Token): boolean => t.type === 'number' || t.type === 'symbol'
    || t.type === 'parenclose' || (t.type === 'operator' && t.str === '!');
  for (let token of bare) {
    if (token.type === 'symbol' && SYMBOL_ALIASES[token.str]) {
      token = { ...token, str: SYMBOL_ALIASES[token.str] };
    }
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
        yield { ...token, str: '0.' + token.str };
        afterValue = true;
        dot = null;
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
 * Insert implicit multiplication tokens (2x, x(x+1), (x+1)(x-1), x y) and
 * rewrite unary +/- into a dedicated prefix operator.
 */
function *addImplicitTokens(bare: Iterable<Token>): Iterable<Token> {
  let last: Token | null = null;
  /** The dotted name ending at `last` when it is a symbol: `person.age`. */
  let path: string | null = null;
  let barDepth = 0;
  for (const token of bare) {
    if (token.type === 'whitespace') continue;

    // A postfix operator (per the ops table: '!') ends a value, so 5!x and
    // 3!(x+1) multiply implicitly.
    const afterPostfix = last?.type === 'operator' && ops[last.str]?.n === 1 && !ops[last.str].right;
    const afterValue = last !== null && (last.type === 'number' || last.type === 'symbol'
      || last.type === 'parenclose' || afterPostfix);

    if (token.type === 'bar') {
      // |x| is abs(x): a bar after a value closes the innermost open bar;
      // any other bar opens one (with implicit multiplication, as in 2|x|).
      if (barDepth > 0 && afterValue) {
        barDepth--;
        const close: Token = { ...token, type: 'parenclose', str: ')' };
        yield close;
        last = close;
      } else {
        barDepth++;
        if (afterValue) yield op('[impl]');
        yield { ...token, type: 'symbol', str: 'abs' };
        yield op('[apply]');
        const open: Token = { ...token, type: 'parenopen', str: '(', call: true };
        yield open;
        last = open;
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
    if (afterValue && (token.type === 'number' || token.type === 'symbol' || token.type === 'parenopen')) {
      const isFnCall = token.type === 'parenopen' && last!.type === 'symbol' && isFnName(last!.str);
      // A column indexes under its full name: person.age[2].
      const isIndex = !isFnCall && token.type === 'parenopen' && token.str === '['
        && last!.type === 'symbol' && activeListNames.has(path ?? last!.str);
      yield op(isFnCall ? '[apply]' : isIndex ? '[at]' : '[impl]');
      if (isFnCall) emit = { ...token, call: true };
    }

    const afterDot = last?.type === 'operator' && last.str === '.';
    yield emit;
    last = emit;
    path = emit.type === 'symbol' ? (afterDot && path ? `${path}.${emit.str}` : emit.str)
      : emit.type === 'operator' && emit.str === '.' ? path
        : null;
  }
}

function createLeaf(token: Token): PNode {
  if (token.type === 'number') return num(Number(token.str));
  if (token.type === 'parenopen') return { kind: 'popen', bracket: token.str, call: !!token.call };
  if (token.type === 'symbol') {
    if (token.str in CONSTANTS) return num(CONSTANTS[token.str]);
    return { kind: 'var', name: token.str };
  }
  throw new Error(`Invalid token: ${token.type} ${JSON.stringify(token.str)}`);
}

/**
 * Parse an expression or equation, keeping free variables symbolic.
 * Names in userFns parse as function calls (`f(x+1)`) instead of products.
 */
export function parseExpr(
  str: string,
  userFns: ReadonlySet<string> = new Set(),
  listNames: ReadonlySet<string> = new Set(),
): Expr {
  activeUserFns = userFns;
  activeListNames = listNames;
  try {
    const tokens = addImplicitTokens(normalizeTokens(tokenize(str)));
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
  }
}

/** Replace free variables by expressions. There are no binders, so no capture. */
export function substVars(e: Expr, env: Record<string, Expr>): Expr {
  switch (e.kind) {
    case 'num': return e;
    case 'var': return env[e.name] ?? e;
    case 'neg': return { kind: 'neg', a: substVars(e.a, env) };
    case 'bin': return { kind: 'bin', op: e.op, a: substVars(e.a, env), b: substVars(e.b, env) };
    case 'call': return { kind: 'call', name: e.name, args: e.args.map(a => substVars(a, env)) };
    case 'eq': return { kind: 'eq', l: substVars(e.l, env), r: substVars(e.r, env) };
    case 'ineq': return { kind: 'ineq', op: e.op, l: substVars(e.l, env), r: substVars(e.r, env) };
    case 'vec': return { kind: 'vec', items: e.items.map(a => substVars(a, env)) };
    case 'list': return { kind: 'list', items: e.items.map(a => substVars(a, env)) };
    case 'piecewise': return {
      kind: 'piecewise',
      cases: e.cases.map(c => ({ cond: substVars(c.cond, env), value: substVars(c.value, env) })),
      otherwise: e.otherwise && substVars(e.otherwise, env),
    };
  }
}

/** Abramowitz & Stegun 7.1.26; max absolute error ~1.5e-7. */
export function erf(x: number): number {
  const a = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * a);
  const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592)
    * t * Math.exp(-a * a);
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
    let x = Math.abs(p), y = q;
    while (y) { const t = x % y; x = y; y = t; } // gcd(|p|, q)
    const g = x || 1;
    const pr = p / g, qr = q / g;
    if (Math.abs(b - pr / qr) < POW_RATIONAL_TOL) {
      if (qr % 2 === 0) return NaN; // even root of a negative number: undefined
      const sign = Math.abs(pr) % 2 === 1 ? -1 : 1;
      return sign * Math.pow(-a, b);
    }
  }
  return NaN; // no small-denominator rational found: irrational-looking exponent
}

/** Lanczos coefficients (g = 5, n = 6): relative error < 2e-10 over the
 *  reals. Interpolated into the eq_gamma() GLSL twin (glsl.ts) too, so both
 *  implementations share this one array. */
export const LANCZOS = [
  76.18009172947146, -86.50532032941677, 24.01409824083091,
  -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5,
];

/**
 * Real Γ(x). Poles at 0, −1, −2, … evaluate to NaN; other negative reals go
 * through the reflection formula Γ(x)Γ(1−x) = π/sin(πx). Overflows to
 * Infinity above x ≈ 171.62, like the rest of double arithmetic.
 *
 * Kept in sync with the eq_gamma() GLSL twin in glsl.ts (same Lanczos
 * coefficients and reflection, minus the exact-pole check float32 can't do).
 */
export function gammaFn(x: number): number {
  if (x < 0.5) {
    if (Number.isInteger(x)) return NaN; // pole
    return Math.PI / (Math.sin(Math.PI * x) * gammaFn(1 - x));
  }
  const z = x - 1;
  let ser = 1.000000000190015;
  for (let i = 0; i < LANCZOS.length; i++) ser += LANCZOS[i] / (z + i + 1);
  const t = z + 5.5;
  // Assembled in log space: a bare pow(t, z + 0.5) factor overflows a double
  // from x ≈ 143, well before Γ itself does.
  return Math.exp((z + 0.5) * Math.log(t) - t + Math.log(2.5066282746310002 * ser));
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

/** sin(x)/x with the removable hole filled: sinc(0) = 1. */
export const sincFn = (x: number): number => (x === 0 ? 1 : Math.sin(x) / x);

export const cothFn = (x: number): number => 1 / Math.tanh(x);

export const EVAL_FNS: Record<string, (...xs: number[]) => number> = {
  sin: Math.sin, cos: Math.cos, tan: Math.tan,
  asin: Math.asin, acos: Math.acos, atan: Math.atan, atan2: Math.atan2,
  sinh: Math.sinh, cosh: Math.cosh, tanh: Math.tanh,
  sech: x => 1 / Math.cosh(x),
  asinh: Math.asinh, acosh: Math.acosh, atanh: Math.atanh,
  sqrt: Math.sqrt, abs: Math.abs, exp: Math.exp, ln: Math.log, log: Math.log10,
  floor: Math.floor, ceil: Math.ceil, round: Math.round, sign: Math.sign,
  min: Math.min, max: Math.max,
  mod: (a, b) => a - Math.floor(a / b) * b,
  fract: a => a - Math.floor(a),
  erf, normalpdf, normalcdf,
  gcd: (a, b) => {
    a = Math.abs(Math.round(a));
    b = Math.abs(Math.round(b));
    while (b) { const t = a % b; a = b; b = t; }
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
  coth: cothFn,
};

/** Numerically evaluate a scalar expression with the given variable bindings. */
export function evaluate(e: Expr, env: Record<string, number>): number {
  switch (e.kind) {
    case 'num': return e.value;
    case 'var': {
      if (!(e.name in env)) throw new Error(`Unbound variable: ${e.name}`);
      return env[e.name];
    }
    case 'neg': return -evaluate(e.a, env);
    case 'bin': {
      const a = evaluate(e.a, env);
      const b = evaluate(e.b, env);
      switch (e.op) {
        case '+': return a + b;
        case '-': return a - b;
        case '*': return a * b;
        case '/': return a / b;
        case '^': return realPow(a, b);
      }
    }
    case 'call': {
      const fn = EVAL_FNS[e.name];
      if (!fn) throw new Error(`Unknown function: ${e.name}`);
      return fn(...e.args.map(a => evaluate(a, env)));
    }
    case 'eq': return evaluate(e.l, env) - evaluate(e.r, env);
    case 'ineq': throw new Error('Cannot evaluate an inequality.');
    case 'vec': throw new Error('Vector in scalar context.');
    case 'list': throw new Error('List in scalar context.');
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
  }
}

/** Collect free variable names (excluding function names and constants). */
export function freeVars(e: Expr, out = new Set<string>()): Set<string> {
  switch (e.kind) {
    case 'num': break;
    case 'var': out.add(e.name); break;
    case 'bin': freeVars(e.a, out); freeVars(e.b, out); break;
    case 'neg': freeVars(e.a, out); break;
    case 'call': e.args.forEach(a => freeVars(a, out)); break;
    case 'eq': freeVars(e.l, out); freeVars(e.r, out); break;
    case 'ineq': freeVars(e.l, out); freeVars(e.r, out); break;
    case 'vec': e.items.forEach(a => freeVars(a, out)); break;
    case 'list': e.items.forEach(a => freeVars(a, out)); break;
    case 'piecewise':
      e.cases.forEach(c => { freeVars(c.cond, out); freeVars(c.value, out); });
      if (e.otherwise) freeVars(e.otherwise, out);
      break;
  }
  return out;
}
