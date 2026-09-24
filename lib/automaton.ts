/**
 * One-dimensional cellular automata: a sequence whose terms are rows of cells.
 *
 * - `c_{n+1}[i] = …` is the rule. It reads the previous row at fixed offsets
 *   from the cell it computes — `c_n[i-1]`, `c_n[i]`, `c_n[i+1]` — and may use
 *   n, t and constants, so `r = 30` with
 *   `c_{n+1}[i] = mod(floor(r / 2^(4 c_n[i-1] + 2 c_n[i] + c_n[i+1])), 2)`
 *   is every elementary rule on one slider.
 * - `c_0[i] = …` is the row it starts from, any expression in i; without one
 *   the start is a single 1 at i = 0.
 * - The rule row draws the space-time diagram: cell i of row n is the unit
 *   square centred on (i, -n), so time runs down the page.
 *
 * The lattice is unbounded. Beyond a window around the seed every row is
 * constant on each side, and that constant steps by the rule applied to
 * itself — so a rule mapping 000 to 1 fills the background exactly, and the
 * cells computed near the seed are exact to the last row. Only cells within
 * the rule's reach of a changing region are computed.
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

/** The rule's previous-row cell at offset k from the cell it computes. */
export const neighbour = (k: number): string => `@c${k}`;
/** The rule's step n and the seed's cell index i, renamed off the user's names. */
export const STEP_VAR = '@n';
export const CELL_VAR = '@i';

/** The object a rule row denotes: `rule` reads neighbour(k) for
 *  |k| <= radius and STEP_VAR; `seed` reads CELL_VAR. */
export type Automaton = Extract<MathObject, { kind: 'automaton' }>;

/**
 * Classify row `ri`, an automaton's rule or seed. A seed row draws nothing of
 * its own (null); the rule row carries it.
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
  const [plain] = same.find(([s]) => !s!.cell) ?? [];
  if (plain) throw new Error(`${scan.name} is already a sequence; name the automaton another letter.`);
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
    classifySeed(scan, fnNames, getFn, constNames, ropts);
    return null;
  }
  const [seedScan] = same.find(([s]) => s!.seed) ?? [];
  let seed: ReturnType<typeof classifySeed> | undefined;
  // A broken seed is reported on its own row; the rule still draws from the default.
  try {
    if (seedScan) seed = classifySeed(seedScan, fnNames, getFn, constNames, ropts);
  } catch {
    /* see the seed row */
  }
  const ruleExpr = classifyRule(scan, fnNames, getFn, constNames, ropts);
  const params = new Set([...ruleExpr.params, ...(seed?.params ?? [])]);
  return {
    object: { kind: 'automaton', rule: ruleExpr.rule, radius: ruleExpr.radius, ...(seed ? { seed: seed.expr } : {}) },
    animated: ruleExpr.animated || !!seed?.animated,
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

function classifyRule(
  scan: SeqScan,
  fnNames: ReadonlySet<string>,
  getFn: GetFn,
  constNames: ReadonlySet<string>,
  ropts: ResolveOpts,
) {
  const { name, index, cell } = scan as SeqScan & { cell: string };
  if (index === cell) throw new Error(`Name the step and the cell differently, like ${name}_{n+1}[i].`);
  const row = `${name}_${index}`;
  const parsed = parseExpr(scan.rhs, fnNames, new Set([row]));
  let radius = 0;
  const reads = (e: Expr): Expr => {
    if (e.kind === 'index' && e.args[0].kind === 'var' && e.args[0].name === row) {
      const k = offsetOf(e.args[1], cell);
      if (k === null)
        throw new Error(
          `Read the previous row at a fixed offset from ${cell}, like ${row}[${cell}-1] or ${row}[${cell}+2].`,
        );
      radius = Math.max(radius, Math.abs(k));
      return { kind: 'var', name: neighbour(k) };
    }
    if (e.kind === 'var' && e.name === row)
      throw new Error(`${row} is a whole row; read one cell of it, like ${row}[${cell}].`);
    if (e.kind === 'var' && e.name === cell)
      throw new Error(`A rule is the same at every cell: read neighbours like ${row}[${cell}-1], not ${cell} itself.`);
    return mapChildren(e, reads);
  };
  let rule = substVars(reads(parsed), { [index]: { kind: 'var', name: STEP_VAR } });
  const own = new Set([STEP_VAR, ...Array.from({ length: 2 * radius + 1 }, (_, k) => neighbour(k - radius))]);
  rule = resolveExpr(rule, getFn, { ...ropts, openVars: new Set([...(ropts.openVars ?? []), ...own]) });
  if (usesComplex(rule)) throw new Error('Cells are real-valued; use re(…) or im(…).');
  return { rule, radius, ...checkFree(rule, own, constNames, 'rule') };
}

function classifySeed(
  scan: SeqScan,
  fnNames: ReadonlySet<string>,
  getFn: GetFn,
  constNames: ReadonlySet<string>,
  ropts: ResolveOpts,
) {
  const parsed = substVars(parseExpr(scan.rhs, fnNames), { [scan.cell!]: { kind: 'var', name: CELL_VAR } });
  const own = new Set([CELL_VAR]);
  const expr = resolveExpr(parsed, getFn, { ...ropts, openVars: new Set([...(ropts.openVars ?? []), CELL_VAR]) });
  if (usesComplex(expr)) throw new Error('Cells are real-valued; use re(…) or im(…).');
  return { expr, ...checkFree(expr, own, constNames, 'seed') };
}

/**
 * The space-time diagram: `rows` rows of `width` cells, row-major, row 0 the
 * seed. Column 0 and column width-1 are each side's background, which runs
 * on without end; cell i sits in column i - x0.
 */
export interface CellGrid {
  readonly values: Float32Array;
  readonly width: number;
  readonly rows: number;
  readonly x0: number;
}

/** Steps the rule `rows - 1` times from its seed. Values are the rule's own
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

  // Every name the programs read, in one slot layout: neighbours, n, i, then params.
  const names = [...new Set([...freeVars(a.rule), ...(a.seed ? freeVars(a.seed) : [])])];
  const slots = new Map<string, number>(names.map((n, k) => [n, k]));
  for (const n of [STEP_VAR, CELL_VAR]) if (!slots.has(n)) slots.set(n, slots.size);
  const vars = new Float64Array(slots.size);
  for (const [n, k] of slots) if (Object.hasOwn(env, n)) vars[k] = env[n];
  const nbr = Array.from({ length: 2 * r + 1 }, (_, k) => slots.get(neighbour(k - r)) ?? -1);
  const rule = compileProg(a.rule, slots);
  const stack = new Float64Array(Math.max(rule.depth, 1));
  const stepSlot = slots.get(STEP_VAR)!;
  // Cells usually take a few whole-number states, so the rule is remembered
  // per neighbourhood: its states in [0, base) spell a key. Stamps retire
  // the table each row when the rule reads n.
  const read = nbr.filter(slot => slot >= 0);
  const base = Math.max(2, Math.floor(MEMO_SIZE ** (1 / Math.max(1, read.length))));
  const memo = new Float64Array(base ** read.length);
  const stamps = new Uint32Array(memo.length);
  const perRow = freeVars(a.rule).has(STEP_VAR);
  let stamp = 1;

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
  const same = (p: number, q: number) => p === q || (p !== p && q !== q);
  let lo = 1,
    hi = width - 2;
  while (lo <= hi && same(values[lo], values[0])) lo++;
  while (hi >= lo && same(values[hi], values[width - 1])) hi--;
  for (let n = 1; n < rows; n++) {
    const prev = (n - 1) * width,
      row = n * width;
    vars[stepSlot] = n - 1;
    if (perRow) stamp++;
    const cellAt = (j: number): number => {
      let key = 0;
      for (let k = 0; k <= 2 * r; k++) {
        if (nbr[k] < 0) continue;
        const v = values[prev + Math.max(0, Math.min(width - 1, j + k - r))];
        vars[nbr[k]] = v;
        key = key >= 0 && v >= 0 && v < base && v === Math.floor(v) ? key * base + v : -1;
      }
      if (key < 0) return run(rule, vars, stack);
      if (stamps[key] !== stamp) {
        memo[key] = run(rule, vars, stack);
        stamps[key] = stamp;
      }
      return memo[key];
    };
    // Each background steps as the rule applied to itself alone.
    const background = (b: number): number => {
      for (const slot of nbr) if (slot >= 0) vars[slot] = b;
      return run(rule, vars, stack);
    };
    const left = background(values[prev]),
      right = background(values[prev + width - 1]);
    // A changing span reaches r cells further each step. An empty one
    // (lo = hi + 1) still marks where the two backgrounds meet.
    lo = Math.max(1, lo - r);
    hi = Math.min(width - 2, hi + r);
    for (let j = 0; j < width; j++) {
      values[row + j] = j < lo ? left : j > hi ? right : cellAt(j);
    }
    // Keep the span tight where a pattern dies back into its background.
    while (lo <= hi && same(values[row + lo], left)) lo++;
    while (hi >= lo && same(values[row + hi], right)) hi--;
  }
  return { values, width, rows, x0 };
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
