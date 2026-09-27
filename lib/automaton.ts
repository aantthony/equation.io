/**
 * Cellular automata and tables: the rows that draw on the integer lattice
 * (docs/discrete.md).
 *
 * - `c_{n+1}[i] = …` is a 1D rule. It reads the previous row at fixed
 *   offsets from the cell it computes — `c_n[i-1]`, `c_n[i]`, `c_n[i+1]` —
 *   and may use n, t and constants, so `r = 30` with
 *   `c_{n+1}[i] = mod(floor(r / 2^(4 c_n[i-1] + 2 c_n[i] + c_n[i+1])), 2)`
 *   is every elementary rule on one slider. It draws the space-time
 *   diagram: i across, n down.
 * - `L_{n+1}[i, j] = …` is a 2D rule, reading `L_n[i+1, j-1]` and the like;
 *   it draws one generation of its board at a time, stepping with t. Two
 *   indices read as a matrix's do: row i (down), column j (across).
 * - A Σ/Π with constant bounds unrolls, so a neighbourhood is written once:
 *   `sum(a=-1..1, sum(b=-1..1, L_n[i+a, j+b]))`. A piecewise case may test
 *   equality (`{s = 3: 1, 0}`), which on whole-number cells is exact.
 * - `c_0[i] = …` / `L_0[i, j] = …` is the generation it starts from, any
 *   expression in the cells; `L_0 = [(0, 0), (1, 0)]` lists live cells as
 *   (row, column) (a multiset: a cell listed twice is worth 2). Without one
 *   the start is a single 1 at the origin.
 * - `T[i, j] = …` is a table, a function on the lattice: row i, column j
 *   holds its value, as in a Cayley table or a matrix.
 *
 * Internally a cell is (across, down): CELL_VAR and CELL_VAR2, and cell
 * (a, d) is the unit square centred on (a, -d) in its panel's plane, so the
 * down index runs down the page (a lattice panel, web/main.ts).
 *
 * The lattice is unbounded. Beyond a window around the seed every cell is
 * its side's background, which steps by the rule applied to itself — so a
 * rule mapping 000 to 1 fills the background exactly, and the cells
 * computed near the seed are exact to the last row. Only cells within the
 * rule's reach of a changing region are computed.
 */
import { usesComplex } from './complex.ts';
import { type GetFn, type ResolveOpts, resolveExpr } from './defs.ts';
import { type Expr, evaluate, freeVars, mapChildren, parseExpr, substVars } from './expr.ts';
import type { Classified, MathObject } from './math-object.ts';
import type { SeqScan } from './seq.ts';
import { compileProg, run } from './vm.ts';

/** The last row computed, as for scalar sequences. */
export const AUTOMATON_STEPS = 1000;
/** The seed is read on [-SEED_HALF, SEED_HALF]; past that each side repeats
 *  its outermost value. */
const SEED_HALF = 256;
/** The widest row: a texture every WebGL2 device of note accepts. */
const MAX_WIDTH = 4096;
/** Entries in the table that remembers the rule per neighbourhood. */
const MEMO_SIZE = 1 << 16;
/** A 2D board is cells -BOARD_HALF..BOARD_HALF each way, inside a ring of background. */
export const BOARD_HALF = 256;
/** Generations a 2D rule steps through before it starts over. */
export const BOARD_STEPS = 2000;
/** Terms one unrolled Σ may have. */
const UNROLL_MAX = 25;

/** The rule's previous-generation cell at offset k (1D) or (k, l) (2D). */
export const neighbour = (k: number, l?: number): string => (l === undefined ? `@c${k}` : `@c${k},${l}`);
/** The rule's step n and the seed's cell indices, renamed off the user's names. */
export const STEP_VAR = '@n';
export const CELL_VAR = '@i';
export const CELL_VAR2 = '@j';

/** The object a rule row denotes: `rule` reads neighbour(…) within
 *  `radius` and STEP_VAR; `seed` reads CELL_VAR (and CELL_VAR2). */
export type Automaton = Extract<MathObject, { kind: 'automaton' }>;
/** A table row's object: `expr` reads CELL_VAR and CELL_VAR2. */
export type LatticeTable = Extract<MathObject, { kind: 'lattice' }>;

/**
 * Classify row `ri`: an automaton's rule or seed, or a table. A seed row
 * draws nothing of its own (null); the rule row carries it.
 */
export function classifyAutomatonRow(
  scans: readonly (SeqScan | null)[],
  ri: number,
  fnNames: ReadonlySet<string>,
  getFn: GetFn,
  constNames: ReadonlySet<string>,
  ropts: ResolveOpts,
): Classified | null {
  const scan = scans[ri]!;
  const same = scans.map((s, k) => [s, k] as const).filter(([s]) => s?.name === scan.name);
  const [plain] = same.find(([s]) => !s!.lattice) ?? [];
  if (plain) throw new Error(`${scan.name} is already a sequence; name the automaton another letter.`);
  if (scan.table) {
    if (same[0][1] < ri) throw new Error(`${scan.name} is already defined.`);
    return classifyTable(scan, fnNames, getFn, constNames, ropts);
  }
  if (same.some(([s]) => s!.table))
    throw new Error(`${scan.name} is already a table; name the automaton another letter.`);
  const [, first] = same.find(([s]) => !!s!.seed === !!scan.seed)!;
  if (first < ri)
    throw new Error(scan.seed ? `${scan.name}_0 is already defined.` : `Automaton ${scan.name} is already defined.`);
  const [rule] = same.find(([s]) => !s!.seed) ?? [];
  if (scan.seed) {
    if (!rule)
      throw new Error(
        `${scan.name}_0[${scan.cell}] starts an automaton: add its rule, like ${scan.name}_{n+1}[${scan.cell}] = ${scan.name}_n[${scan.cell}-1].`,
      );
    // Its errors belong on this row, not the rule's.
    classifySeed(scan, rule, fnNames, getFn, constNames, ropts);
    return null;
  }
  const [seedScan] = same.find(([s]) => s!.seed) ?? [];
  let seed: ReturnType<typeof classifySeed> | undefined;
  // A broken seed is reported on its own row; the rule still draws from the default.
  try {
    if (seedScan) seed = classifySeed(seedScan, scan, fnNames, getFn, constNames, ropts);
  } catch {
    /* see the seed row */
  }
  const ruleExpr = classifyRule(scan, fnNames, getFn, constNames, ropts);
  const params = new Set([...ruleExpr.params, ...(seed?.params ?? [])]);
  const dims = scan.cell2 ? 2 : 1;
  return {
    object: {
      kind: 'automaton',
      rule: ruleExpr.rule,
      radius: ruleExpr.radius,
      ...(seed ? { seed: seed.expr } : {}),
      dims,
      axes: dims === 2 ? [scan.cell2!, scan.cell!] : [scan.cell!, scan.index],
    },
    // A board shows one generation at a time, stepping with t.
    animated: dims === 2 || ruleExpr.animated || !!seed?.animated,
    needs3D: false,
    params: [...params].sort(),
  };
}

/** A constant integer offset: `i + 2`, `i - 1`, `i`. Null for anything else. */
function offsetOf(at: Expr, cell: string): number | null {
  const vars = freeVars(at);
  if (vars.size !== 1 || !vars.has(cell)) return null;
  try {
    const k = evaluate(at, { [cell]: 0 });
    if (!Number.isInteger(k) || evaluate(at, { [cell]: 1 }) - k !== 1) return null;
    return k;
  } catch {
    return null;
  }
}

/** Params, t, and nothing else free once `own` (the row's own names) are out. */
function checkFree(e: Expr, own: ReadonlySet<string>, constNames: ReadonlySet<string>, what: string) {
  const params: string[] = [];
  let animated = false;
  for (const v of freeVars(e)) {
    if (own.has(v)) continue;
    if (v === 't') animated = true;
    else if (constNames.has(v)) params.push(v);
    else throw new Error(`Unknown variable in the ${what}: ${v}. Define "${v} = 1" to make a slider.`);
  }
  return { params, animated };
}

const num = (value: number): Expr => ({ kind: 'num', value });
const bin = (op: '+' | '-' | '*', a: Expr, b: Expr): Expr => ({ kind: 'bin', op, a, b });
const call = (name: string, ...args: Expr[]): Expr => ({ kind: 'call', name, args });

/**
 * A Σ/Π whose bounds are plain numbers, as its terms: a neighbourhood
 * written once, `sum(a=-1..1, c_n[i+a])`, becomes the fixed offsets the
 * rule reads. Null for anything else (it resolves as an ordinary Σ).
 */
function unrollSum(e: Expr): Expr | null {
  let header: Expr & { kind: 'call' }, body: Expr;
  if (e.kind === 'call' && (e.name === 'sum' || e.name === 'prod') && e.args.length === 4) {
    header = e;
    body = e.args[3];
  } else if (
    // The bracket form, sum[a=-1..1] body: the header multiplies its body.
    e.kind === 'bin' &&
    e.op === '*' &&
    e.a.kind === 'call' &&
    (e.a.name === 'sum' || e.a.name === 'prod') &&
    e.a.args.length === 3
  ) {
    header = e.a;
    body = e.b;
  } else return null;
  const [idx, loE, hiE] = header.args;
  if (idx.kind !== 'var') return null;
  let lo: number, hi: number;
  try {
    lo = evaluate(loE, {});
    hi = evaluate(hiE, {});
  } catch {
    return null;
  }
  if (!Number.isInteger(lo) || !Number.isInteger(hi) || hi - lo + 1 > UNROLL_MAX) return null;
  const op = header.name === 'sum' ? '+' : '*';
  let acc: Expr | null = null;
  for (let k = lo; k <= hi; k++) {
    const term = substVars(body, { [idx.name]: num(k) });
    acc = acc ? bin(op, acc, term) : term;
  }
  return acc ?? num(op === '+' ? 0 : 1);
}

/** A piecewise case testing equality as an inequality the evaluator runs:
 *  r - ε < l < r + ε, which on whole-number cells is exact. */
export function exactCase(l: Expr, r: Expr): Expr {
  // Each side kept whole: over lists, a comparison whose one side mixes two
  // lists (abs(l - r) < ε) does not lower element by element.
  const eps = num(1e-9);
  return { kind: 'ineq', op: '<', l: { kind: 'ineq', op: '<', l: bin('-', r, eps), r: l }, r: bin('+', r, eps) };
}

/** Every equality case below `e` as exactCase. */
export function exactCases(e: Expr): Expr {
  const inner = mapChildren(e, exactCases);
  if (inner.kind !== 'piecewise' || !inner.cases.some(c => c.cond.kind === 'eq')) return inner;
  return {
    ...inner,
    cases: inner.cases.map(c => (c.cond.kind === 'eq' ? { ...c, cond: exactCase(c.cond.l, c.cond.r) } : c)),
  };
}

/** Resolve a lattice row's expression with `own` left open. */
function resolveCells(e: Expr, own: ReadonlySet<string>, getFn: GetFn, ropts: ResolveOpts): Expr {
  const openVars = new Set([...(ropts.openVars ?? []), ...own]);
  // Cells are whole numbers, so a case may test equality: {s = 3: 1, 0},
  // written in the row or in a function it calls (inlined already resolved).
  const resolved = exactCases(resolveExpr(e, getFn, { ...ropts, openVars, exactConditions: true }));
  if (usesComplex(resolved)) throw new Error('Cells are real-valued; use re(…) or im(…).');
  return resolved;
}

function classifyRule(
  scan: SeqScan,
  fnNames: ReadonlySet<string>,
  getFn: GetFn,
  constNames: ReadonlySet<string>,
  ropts: ResolveOpts,
) {
  const { name, index, cell, cell2 } = scan as SeqScan & { cell: string };
  if (index === cell || index === cell2)
    throw new Error(`Name the step and the cells differently, like ${name}_{n+1}[i].`);
  if (cell === cell2) throw new Error(`Name the two cell indices differently, like ${name}_{n+1}[i, j].`);
  const row = `${name}_${index}`;
  const at = cell2 ? `${cell}, ${cell2}` : cell;
  const example = cell2 ? `${row}[${cell}+1, ${cell2}]` : `${row}[${cell}-1] or ${row}[${cell}+2]`;
  const parsed = parseExpr(scan.rhs, fnNames, new Set([row]));
  let radius = 0;
  const reads = (e: Expr): Expr => {
    const unrolled = unrollSum(e);
    if (unrolled) return reads(unrolled);
    if (e.kind === 'index' && e.args[0].kind === 'var' && e.args[0].name === row) {
      const pos = e.args[1];
      if (cell2) {
        // Row first, as in a matrix: L_n[i+1, j] is the cell below.
        const [l, k] =
          pos.kind === 'list' && pos.items.length === 2
            ? [offsetOf(pos.items[0], cell), offsetOf(pos.items[1], cell2)]
            : [null, null];
        if (k === null || l === null)
          throw new Error(`Read the previous generation at fixed offsets from ${at}, like ${example}.`);
        radius = Math.max(radius, Math.abs(k), Math.abs(l));
        return { kind: 'var', name: neighbour(k, l) };
      }
      const k = offsetOf(pos, cell);
      if (k === null) throw new Error(`Read the previous row at a fixed offset from ${cell}, like ${example}.`);
      radius = Math.max(radius, Math.abs(k));
      return { kind: 'var', name: neighbour(k) };
    }
    if (e.kind === 'var' && e.name === row)
      throw new Error(`${row} is a whole ${cell2 ? 'generation' : 'row'}; read one cell of it, like ${row}[${at}].`);
    if (e.kind === 'var' && (e.name === cell || e.name === cell2))
      throw new Error(`A rule is the same at every cell: read neighbours like ${example}, not ${e.name} itself.`);
    return mapChildren(e, reads);
  };
  const stepped = substVars(reads(parsed), { [index]: { kind: 'var', name: STEP_VAR } });
  const own = new Set([STEP_VAR]);
  for (let k = -radius; k <= radius; k++) {
    if (!cell2) own.add(neighbour(k));
    else for (let l = -radius; l <= radius; l++) own.add(neighbour(k, l));
  }
  const rule = resolveCells(stepped, own, getFn, ropts);
  return { rule, radius, ...checkFree(rule, own, constNames, 'rule') };
}

/** `L_0 = [(0, 0), (1, 0)]` as an expression in the cells: each listed cell
 *  adds 1 where it is, so a cell listed twice is worth 2. */
function seedFromCells(rhs: string, dims: 1 | 2, fnNames: ReadonlySet<string>): Expr {
  const usage =
    dims === 2 ? 'List live cells as points: [(0, 0), (1, 0), (2, 1)].' : 'List live cells by index: [0, 3, 4].';
  const list = parseExpr(rhs, fnNames);
  // A bracket around one item is that item: [(0, 0)] parses as the point.
  const items = list.kind === 'list' ? list.items : [list];
  const terms = items.map(item => {
    const coords = dims === 1 ? [item] : item.kind === 'vec' && item.items.length === 2 ? item.items : null;
    if (!coords) throw new Error(usage);
    let where: number[];
    try {
      where = coords.map(c => evaluate(c, {}));
    } catch {
      throw new Error(`Live cells are whole numbers. ${usage}`);
    }
    if (!where.every(Number.isInteger)) throw new Error(`Live cells are whole numbers. ${usage}`);
    // 1 at the cell, and at most 0 at every other whole-number cell. A
    // point is (row, column): down, then across.
    const names = dims === 1 ? [CELL_VAR] : [CELL_VAR2, CELL_VAR];
    const dist = where
      .map((v, k) => call('abs', bin('-', { kind: 'var', name: names[k] }, num(v))))
      .reduce((a, b) => bin('+', a, b));
    return call('max', num(0), bin('-', num(1), dist));
  });
  return terms.length ? terms.reduce((a, b) => bin('+', a, b)) : num(0);
}

function classifySeed(
  scan: SeqScan,
  rule: SeqScan,
  fnNames: ReadonlySet<string>,
  getFn: GetFn,
  constNames: ReadonlySet<string>,
  ropts: ResolveOpts,
) {
  const dims = rule.cell2 ? 2 : 1;
  let parsed: Expr;
  if (scan.seedList) parsed = seedFromCells(scan.rhs, dims, fnNames);
  else {
    if (!!scan.cell2 !== !!rule.cell2)
      throw new Error(
        dims === 2
          ? `${scan.name} is a 2D automaton: write its seed over two cells, ${scan.name}_0[${rule.cell}, ${rule.cell2}] = ….`
          : `${scan.name} is a 1D automaton: write its seed over one cell, ${scan.name}_0[${rule.cell}] = ….`,
      );
    // A 2D seed's first index is its row: down, CELL_VAR2.
    parsed = substVars(
      parseExpr(scan.rhs, fnNames),
      scan.cell2
        ? { [scan.cell!]: { kind: 'var', name: CELL_VAR2 }, [scan.cell2]: { kind: 'var', name: CELL_VAR } }
        : { [scan.cell!]: { kind: 'var', name: CELL_VAR } },
    );
  }
  const own = new Set([CELL_VAR, CELL_VAR2]);
  const expr = resolveCells(parsed, own, getFn, ropts);
  return { expr, ...checkFree(expr, own, constNames, 'seed') };
}

function classifyTable(
  scan: SeqScan,
  fnNames: ReadonlySet<string>,
  getFn: GetFn,
  constNames: ReadonlySet<string>,
  ropts: ResolveOpts,
): Classified {
  const { name, cell, cell2 } = scan as SeqScan & { cell: string; cell2: string };
  if (cell === cell2) throw new Error(`Name the two indices differently, like ${name}[i, j].`);
  const parsed = substVars(parseExpr(scan.rhs, fnNames), {
    [cell]: { kind: 'var', name: CELL_VAR2 },
    [cell2]: { kind: 'var', name: CELL_VAR },
  });
  const own = new Set([CELL_VAR, CELL_VAR2]);
  const expr = resolveCells(parsed, own, getFn, ropts);
  const { params, animated } = checkFree(expr, own, constNames, 'table');
  return {
    object: { kind: 'lattice', expr, axes: [cell2, cell] },
    animated,
    needs3D: false,
    params: params.sort(),
  };
}

/**
 * Cells on the lattice: `rows` rows of `width` cells, row-major. Cell (i, k)
 * sits in column i - x0 of row k - y0, where k is the down index (a 1D
 * rule's step, a board's or table's second index). For an automaton, the
 * outermost columns (and a board's outermost rows) are the background,
 * which runs on without end.
 */
export interface CellGrid {
  readonly values: Float32Array;
  readonly width: number;
  readonly rows: number;
  readonly x0: number;
  readonly y0: number;
}

/** One slot layout for the names the programs read: neighbours, n, the cell
 *  indices, then params, with params filled from `env`. */
function slotsFor(exprs: readonly Expr[], env: Record<string, number>) {
  const names = [...new Set(exprs.flatMap(e => [...freeVars(e)]))];
  const slots = new Map<string, number>(names.map((n, k) => [n, k]));
  for (const n of [STEP_VAR, CELL_VAR, CELL_VAR2]) if (!slots.has(n)) slots.set(n, slots.size);
  const vars = new Float64Array(slots.size);
  for (const [n, k] of slots) if (Object.hasOwn(env, n)) vars[k] = env[n];
  return { slots, vars };
}

/**
 * The rule, remembered per neighbourhood. Cells usually take a few
 * whole-number states, so their states in [0, base) spell a key. `retire`
 * forgets everything, for a rule that reads n.
 */
function memoRule(rule: Expr, slots: ReadonlyMap<string, number>, vars: Float64Array, nbr: readonly number[]) {
  const prog = compileProg(rule, slots);
  const stack = new Float64Array(Math.max(prog.depth, 1));
  const read = nbr.filter(slot => slot >= 0);
  const base = Math.max(2, Math.floor(MEMO_SIZE ** (1 / Math.max(1, read.length))));
  const memo = new Float64Array(base ** read.length);
  const stamps = new Uint32Array(memo.length);
  let stamp = 1;
  return {
    retire: () => void stamp++,
    /** The rule at the neighbourhood `at(k)` gives, k indexing nbr. */
    apply(at: (k: number) => number): number {
      let key = 0;
      for (let k = 0; k < nbr.length; k++) {
        if (nbr[k] < 0) continue;
        const v = at(k);
        vars[nbr[k]] = v;
        key = key >= 0 && v >= 0 && v < base && v === Math.floor(v) ? key * base + v : -1;
      }
      if (key < 0) return run(prog, vars, stack);
      if (stamps[key] !== stamp) {
        memo[key] = run(prog, vars, stack);
        stamps[key] = stamp;
      }
      return memo[key];
    },
    /** The rule applied to a background alone. */
    background(b: number): number {
      for (const slot of nbr) if (slot >= 0) vars[slot] = b;
      return run(prog, vars, stack);
    },
  };
}

const same = (p: number, q: number) => p === q || (p !== p && q !== q);

/** Steps a 1D rule `rows - 1` times from its seed. Values are the rule's own
 *  numbers; one that is not finite stays so (and draws as empty). */
export function runAutomaton(a: Pick<Automaton, 'rule' | 'radius' | 'seed'>, env: Record<string, number>): CellGrid {
  const r = a.radius;
  const steps =
    r === 0 ? AUTOMATON_STEPS : Math.min(AUTOMATON_STEPS, Math.floor((MAX_WIDTH - 2 - (2 * SEED_HALF + 1)) / (2 * r)));
  const reach = SEED_HALF + r * steps;
  const width = 2 * reach + 3;
  const rows = steps + 1;
  const x0 = -reach - 1;
  const values = new Float32Array(width * rows);

  const { slots, vars } = slotsFor(a.seed ? [a.rule, a.seed] : [a.rule], env);
  const nbr = Array.from({ length: 2 * r + 1 }, (_, k) => slots.get(neighbour(k - r)) ?? -1);
  const rule = memoRule(a.rule, slots, vars, nbr);
  const stepSlot = slots.get(STEP_VAR)!;
  const perRow = freeVars(a.rule).has(STEP_VAR);

  // Row 0 over the whole lattice, so a patterned seed reaches its edges too.
  if (a.seed) {
    const seed = compileProg(a.seed, slots);
    const seedStack = new Float64Array(Math.max(seed.depth, 1));
    const cellSlot = slots.get(CELL_VAR)!;
    for (let j = 1; j < width - 1; j++) {
      vars[cellSlot] = Math.max(-SEED_HALF, Math.min(SEED_HALF, j + x0));
      values[j] = run(seed, vars, seedStack);
    }
  } else values[-x0] = 1;
  values[0] = values[1];
  values[width - 1] = values[width - 2];

  // Cells [lo, hi] may differ from their side's background; outside it the
  // row is that background. The span grows by the rule's reach each step.
  let lo = 1,
    hi = width - 2;
  // The neighbour k of cell `col` in row `prevRow`: one closure for every cell.
  let prevRow = 0,
    col = 0;
  const cellAt = (k: number) => values[prevRow + Math.max(0, Math.min(width - 1, col + k - r))];
  while (lo <= hi && same(values[lo], values[0])) lo++;
  while (hi >= lo && same(values[hi], values[width - 1])) hi--;
  for (let n = 1; n < rows; n++) {
    const prev = (n - 1) * width,
      row = n * width;
    vars[stepSlot] = n - 1;
    if (perRow) rule.retire();
    // Each background steps as the rule applied to itself alone.
    const left = rule.background(values[prev]),
      right = rule.background(values[prev + width - 1]);
    // A changing span reaches r cells further each step. An empty one
    // (lo = hi + 1) still marks where the two backgrounds meet.
    lo = Math.max(1, lo - r);
    hi = Math.min(width - 2, hi + r);
    prevRow = prev;
    for (let j = 0; j < width; j++) {
      col = j;
      values[row + j] = j < lo ? left : j > hi ? right : rule.apply(cellAt);
    }
    // Keep the span tight where a pattern dies back into its background.
    while (lo <= hi && same(values[row + lo], left)) lo++;
    while (hi >= lo && same(values[row + hi], right)) hi--;
  }
  return { values, width, rows, x0, y0: 0 };
}

/**
 * A 2D rule's board, stepped one generation at a time: `grid` is
 * generation `generation`, cells -BOARD_HALF..BOARD_HALF each way inside a
 * one-cell ring of background. Past the ring every cell is the background,
 * which steps by the rule applied to itself. Unlike a 1D rule's row, the
 * board does not grow: a pattern that reaches its edge is cut off there (a
 * glider crashes into it and settles as a block), so it is exact until
 * then — 1000 generations of a glider from the origin.
 */
export interface Board {
  readonly generation: number;
  readonly grid: CellGrid;
  /** Step to generation `n` (from the seed again when n is behind). */
  advance(n: number): void;
}

export function runBoard(a: Pick<Automaton, 'rule' | 'radius' | 'seed'>, env: Record<string, number>): Board {
  const r = a.radius;
  const side = 2 * BOARD_HALF + 3;
  const x0 = -BOARD_HALF - 1;
  const { slots, vars } = slotsFor(a.seed ? [a.rule, a.seed] : [a.rule], env);
  const offsets: Array<[number, number]> = [];
  for (let k = -r; k <= r; k++) for (let l = -r; l <= r; l++) offsets.push([k, l]);
  const nbr = offsets.map(([k, l]) => slots.get(neighbour(k, l)) ?? -1);
  const rule = memoRule(a.rule, slots, vars, nbr);
  const stepSlot = slots.get(STEP_VAR)!;
  const perGen = freeVars(a.rule).has(STEP_VAR);
  // Each offset as a step through the row-major board (k across, l down).
  const deltas = offsets.map(([k, l]) => l * side + k);

  let cur = new Float32Array(side * side);
  let next = new Float32Array(side * side);
  let generation = 0;
  /** The box that may differ from the background: [x lo, x hi, y lo, y hi] in columns and rows. */
  let box: [number, number, number, number] = [1, side - 2, 1, side - 2];

  const fillRing = (grid: Float32Array, b: number) => {
    for (let k = 0; k < side; k++) {
      grid[k] = grid[(side - 1) * side + k] = b;
      grid[k * side] = grid[k * side + side - 1] = b;
    }
  };
  /** Shrink the box to the cells that differ from the background. */
  const tighten = (grid: Float32Array, b: number) => {
    let [xl, xh, yl, yh] = box;
    const rowClear = (y: number) => {
      for (let x = xl; x <= xh; x++) if (!same(grid[y * side + x], b)) return false;
      return true;
    };
    const colClear = (x: number) => {
      for (let y = yl; y <= yh; y++) if (!same(grid[y * side + x], b)) return false;
      return true;
    };
    while (yl <= yh && rowClear(yl)) yl++;
    while (yh >= yl && rowClear(yh)) yh--;
    while (xl <= xh && colClear(xl)) xl++;
    while (xh >= xl && colClear(xh)) xh--;
    box = [xl, xh, yl, yh];
  };

  const reset = () => {
    generation = 0;
    cur.fill(0);
    if (a.seed) {
      const seed = compileProg(a.seed, slots);
      const stack = new Float64Array(Math.max(seed.depth, 1));
      const [si, sj] = [slots.get(CELL_VAR)!, slots.get(CELL_VAR2)!];
      for (let y = 1; y < side - 1; y++)
        for (let x = 1; x < side - 1; x++) {
          vars[si] = x + x0;
          vars[sj] = y + x0;
          cur[y * side + x] = run(seed, vars, stack);
        }
    } else cur[-x0 * side - x0] = 1;
    // The seed's background is its corner cell's.
    const b = cur[side + 1];
    fillRing(cur, b);
    box = [1, side - 2, 1, side - 2];
    tighten(cur, b);
  };

  // Neighbour k of cell (cx, cy): `inner` away from the ring, `edge` clamped to it.
  let cx = 0,
    cy = 0;
  const inner = (k: number) => cur[cy * side + cx + deltas[k]];
  const edge = (k: number) => {
    const [dx, dy] = offsets[k];
    return cur[Math.max(0, Math.min(side - 1, cy + dy)) * side + Math.max(0, Math.min(side - 1, cx + dx))];
  };

  const step = () => {
    vars[stepSlot] = generation;
    if (perGen) rule.retire();
    const b = rule.background(cur[0]);
    next.fill(b);
    const [xl, xh, yl, yh] = box;
    // An empty box (a background alone) has nothing to grow.
    if (xl <= xh && yl <= yh) {
      const [gxl, gxh, gyl, gyh] = [
        Math.max(1, xl - r),
        Math.min(side - 2, xh + r),
        Math.max(1, yl - r),
        Math.min(side - 2, yh + r),
      ];
      for (let y = gyl; y <= gyh; y++)
        for (let x = gxl; x <= gxh; x++) {
          cx = x;
          cy = y;
          // Reads past the ring clamp to it: the background.
          next[y * side + x] = rule.apply(x > r && x + r < side && y > r && y + r < side ? inner : edge);
        }
      box = [gxl, gxh, gyl, gyh];
    }
    fillRing(next, b);
    [cur, next] = [next, cur];
    generation++;
    tighten(cur, b);
  };

  reset();
  return {
    get generation() {
      return generation;
    },
    get grid() {
      return { values: cur, width: side, rows: side, x0, y0: x0 };
    },
    advance(n: number) {
      const target = Math.max(0, Math.min(BOARD_STEPS, Math.floor(n)));
      if (target < generation) reset();
      while (generation < target) step();
    },
  };
}

/** The widest table window evaluated, in cells each way. */
export const TABLE_MAX = 512;

/**
 * A table's values over the cells [i0, i0 + width) × [j0, j0 + rows);
 * undefined values (a piecewise with no case) are NaN.
 */
export function evalTable(
  t: Pick<LatticeTable, 'expr'>,
  env: Record<string, number>,
  i0: number,
  j0: number,
  width: number,
  rows: number,
): CellGrid {
  const { slots, vars } = slotsFor([t.expr], env);
  const prog = compileProg(t.expr, slots);
  const stack = new Float64Array(Math.max(prog.depth, 1));
  const [si, sj] = [slots.get(CELL_VAR)!, slots.get(CELL_VAR2)!];
  const values = new Float32Array(width * rows);
  for (let y = 0; y < rows; y++) {
    vars[sj] = j0 + y;
    for (let x = 0; x < width; x++) {
      vars[si] = i0 + x;
      values[y * width + x] = run(prog, vars, stack);
    }
  }
  return { values, width, rows, x0: i0, y0: j0 };
}

/**
 * Cell values as 0–255 shades of the row's colour: 0 (and below, and
 * anything not finite) is empty, the largest value is solid.
 */
export function cellShades(grid: CellGrid): Uint8Array {
  const { values } = grid;
  let max = 0;
  for (let k = 0; k < values.length; k++) if (values[k] > max && values[k] < Infinity) max = values[k];
  const out = new Uint8Array(values.length);
  if (max <= 0) return out;
  const scale = 255 / max;
  for (let k = 0; k < values.length; k++) {
    const v = values[k];
    if (v > 0 && v < Infinity) out[k] = Math.max(1, (v * scale + 0.5) | 0);
  }
  return out;
}

/**
 * A table's values as shades: every finite value shows, the smallest faint
 * and the largest solid (a Cayley table's identity 0 is still a cell), and
 * undefined cells are empty.
 */
export function tableShades(grid: CellGrid): Uint8Array {
  const { values } = grid;
  let lo = Infinity,
    hi = -Infinity;
  for (const v of values)
    if (Number.isFinite(v)) {
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
  const out = new Uint8Array(values.length);
  const span = hi - lo;
  for (let k = 0; k < values.length; k++) {
    const v = values[k];
    if (Number.isFinite(v)) out[k] = span > 0 ? 40 + Math.round(((v - lo) / span) * 215) : 160;
  }
  return out;
}
