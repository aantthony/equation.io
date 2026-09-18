/** Pure, tolerant editor assistance. Suggestions write ordinary equation
 * text; an incomplete expression never needs to pass through the parser.
 */
import { type Defs, shadowedFnNames } from './defs.ts';
import { DIST_FAMILIES, distFamily, distUsage, isModelName } from './dist-families.ts';
import { tildeRow } from './regression.ts';
import { FUNCTIONS, builtinFn } from './expr.ts';

export interface Suggestion { name: string; signature: string; description: string; call: boolean }
export interface SyntaxHelp { start: number; end: number; suggestions: Suggestion[]; hint?: string }

const signatures: Record<string, [string, string]> = {
  view: ['view(x = lo..hi, y = lo..hi, ratio = 1)', 'Frame the graph; ratio is pixels per y unit / pixels per x unit'],
  sin: ['sin(x)', 'Sine; angles in radians'], cos: ['cos(x)', 'Cosine; angles in radians'],
  tan: ['tan(x)', 'Tangent; angles in radians'], sqrt: ['sqrt(x)', 'Square root'],
  ln: ['ln(x)', 'Natural logarithm'], log: ['log(x)', 'Base-10 logarithm'],
  atan2: ['atan2(y, x)', 'Angle of the point (x, y)'],
  normalpdf: ['normalpdf(x, mean, sd)', 'Normal probability density'],
  normalcdf: ['normalcdf(x, mean, sd)', 'Normal cumulative probability'],
  mean: ['mean(L)', 'Mean of a numeric list or column'],
  stdev: ['stdev(L)', 'Standard deviation of a numeric list'],
  median: ['median(L)', 'Median of a numeric list'],
  total: ['total(L)', 'Sum of a numeric list'],
  count: ['count(L)', 'Number of elements in a list'],
  hist: ['hist(L)', 'Histogram of a numeric list'],
  sort: ['sort(L)', 'Sort a numeric list'],
  min: ['min(a, b) or min(L)', 'Minimum'], max: ['max(a, b) or max(L)', 'Maximum'],
  mod: ['mod(a, b)', 'Remainder modulo b'], gcd: ['gcd(a, b)', 'Greatest common divisor'],
  segment: ['segment(A, B)', 'Segment joining two points'],
  polyline: ['polyline(A, B, C, …)', 'Open path through points'],
  vector: ['vector(A, B) or vector(V)', 'Arrow from A to B, or from the origin to V'],
  line: ['line(A, B)', 'Line through two points'],
  circle: ['circle(A, r)', 'Circle with center A and radius r'],
  polygon: ['polygon(A, B, C, …)', 'Polygon through points'],
  square: ['square(A, B)', 'Square erected to the left of side A → B'],
  midpoint: ['midpoint(A, B)', 'Midpoint of two points'],
  distance: ['distance(A, B)', 'Distance between two points, |A - B|'],
  angle: ['angle(A, B, C) or angle(U, V)', 'Signed angle at B from A to C, or from U to V, in radians (−π, π]'],
  dot: ['dot(A, B)', 'Vector dot product'], cross: ['cross(A, B)', 'Vector cross product'],
  det: ['det(M)', 'Matrix determinant'], trace: ['trace(M)', 'Matrix trace'],
  solve: ['solve(M, v)', 'Solve the linear system M x = v'],
  sum: ['sum(n=1..N, expression)', 'Finite sum'],
  prod: ['prod(n=1..N, expression)', 'Finite product'],
  int: ['int[a..b] f(x) dx', 'Definite integral; bounds may be omitted. Alone on a row it shades its signed area'],
  domain: ['domain(f(w))', 'Complex domain coloring'],
  conformal: ['conformal(f(w))', 'Image of a complex coordinate grid'],
  iter: ['iter(w^2 + c)', 'Complex escape-time iteration'],
  grad: ['grad(f)', 'Gradient (∂f/∂x, ∂f/∂y), plotted as a vector field'],
  trail: ['trail(point)', 'Draw a moving point’s path'],
  tube: ['tube((x(u), y(u), z(u)))', 'Tube along a parametric space curve'],
  revolve: ['revolve(f(x))', 'Surface of revolution of y = f(x) about the x-axis; revolve(f(y), y) about the y-axis'],
  open: ['data = open("file.csv")', 'Use a CSV file dropped onto the graph'],
  ...Object.fromEntries(DIST_FAMILIES.map(f => [f.name, [`X ~ ${distUsage(f)}`, `Declare ${f.help}`]])),
  P: ['P(X < b)', 'Probability of a random-variable condition, joint ones included: P(X > Y). Over discrete variables < and <= differ, P(X = k) is a stem’s height, and P(X = Y) counts the ties'],
  E: ['E(X)', 'Expected value of a random variable or of an expression in them: E(X Y) — exact over discrete ones'],
};

/** Distributions whose name folds case ANYWHERE in a row, not just at the
 *  head of a ~: all but the spellings that also mean something else (Gamma →
 *  the gamma function, Beta → a coefficient), which are laws only at the head. */
const FOLDED_DISTS = DIST_FAMILIES.map(f => f.name).filter(n => !isModelName(n));

/** Every name the definitions claim — the stand-in for declaredNames(texts)
 *  when the caller has only the built Defs. */
const definedNames = (defs: Defs): ReadonlySet<string> => new Set([
  ...defs.consts.keys(), ...defs.fns.keys(), ...defs.fields.keys(), ...defs.states.keys(), ...defs.points,
  ...defs.mats.keys(), ...defs.lists.keys(), ...defs.tables.keys(), ...defs.missingData.keys(),
]);

/** `declared`: the document's `name = …` names (regression.ts declaredNames),
 *  which decide whether `Y ~ gamma(` is a model or a law exactly as the row
 *  itself will be read; without it the built definitions stand in. */
export function syntaxHelp(text: string, offset: number, defs: Defs, declared?: ReadonlySet<string>): SyntaxHelp {
  const before = text.slice(0, offset);
  const empty: SyntaxHelp = { start: offset, end: offset, suggestions: [] };
  if (text.trimStart().startsWith('#')) return empty;
  // Primes after identifiers/values are derivatives, not string delimiters.
  let quote = '', stack: Array<{ name?: string; at: number }> = [];
  for (let i = 0; i < before.length; i++) {
    const c = before[i];
    if (quote) { if (c === quote) quote = ''; continue; }
    if (c === '"' || (c === "'" && !/[\w)\]}']/.test(before[i - 1] ?? ''))) { quote = c; continue; }
    if ('([{'.includes(c)) stack.push({ name: c === '(' ? /([A-Za-z_]\w*)\s*$/.exec(before.slice(0, i))?.[1] : undefined, at: i });
    else if (')]}'.includes(c)) stack.pop();
  }
  if (quote) return empty;
  const candidates = new Map<string, Suggestion>();
  for (const name of new Set([...FUNCTIONS, ...Object.keys(signatures)])) {
    const [signature, description] = signatures[name] ?? [`${name}(x)`, 'Built-in function'];
    candidates.set(name, { name, signature, description, call: true });
  }
  // Only parser-defined case-insensitive names participate in fallback.
  // Snapshot before user definitions overwrite candidates: those names are
  // exact, and must not acquire new spellings just because help is open.
  const foldedBuiltins = new Map([...candidates].filter(([name]) =>
    FUNCTIONS.has(name) || FOLDED_DISTS.includes(name))
    .map(([name, suggestion]) => [name.toLowerCase(), suggestion]));
  const values = (names: Iterable<string>, description: string) => {
    for (const name of names) candidates.set(name, { name, signature: name, description, call: false });
  };
  values(defs.consts.keys(), 'Defined constant');
  values(defs.states.keys(), 'Simulation state');
  values(defs.vecStates.keys(), 'Vector state');
  values(defs.fields.keys(), 'Coordinate field');
  values(defs.points, 'Defined point');
  values(defs.mats.keys(), 'Defined matrix');
  values(defs.lists.keys(), 'Defined list');
  for (const [name, table] of defs.tables) {
    values([name], 'Data table');
    for (const col of table.data?.columns ?? []) values([`${name}.${col.name}`], `${col.type === 'num' ? 'Numeric' : 'Text'} column · ${table.file}`);
  }
  for (const [name, fn] of defs.fns) candidates.set(name,
    { name, signature: `${name}(${fn.params.join(', ')})`, description: 'Defined function', call: true });
  const call = [...stack].reverse().find(s => s.name)?.name;
  const shadowed = shadowedFnNames([...candidates.values()].filter(s => !s.call).map(s => s.name));
  const blocked = call && !defs.fns.has(call) && shadowed.has(builtinFn(call) ?? '');
  // The HEAD of a ~ row — the first token right of the ~, its paren the
  // outermost one open — is a distribution name in any spelling, aliases
  // included: `X ~ gamma(` is the Gamma law there. Anywhere deeper
  // (`X ~ Normal(gamma(`, `Y ~ a gamma(`) a name means what it always does.
  // Whether the row is a declaration at all is regression.ts's call (tildeRow,
  // the predicate scanRegressions runs), so help and behaviour cannot differ.
  const row = tildeRow(before, declared ?? definedNames(defs));
  const head = row && !row.regression
    ? /^\s*([A-Za-z_]\w*)\s*\($/.exec(before.slice(row.tilde + 1, (stack[0]?.at ?? -1) + 1)) : null;
  const family = head && row && stack[0].at > row.tilde && call === head[1] && stack.filter(f => f.name).length === 1
    && !defs.fns.has(call) ? distFamily(call) : undefined;
  const distName = family?.name;
  const entry = distName ? candidates.get(distName)
    : call && !blocked ? candidates.get(call) ?? foldedBuiltins.get(call.toLowerCase()) : undefined;
  let hint = entry?.call ? `${entry.signature} — ${entry.description}` : undefined;
  if (!hint && before.includes('~')) hint = 'Y ~ m X + b fits data lists: unbound coefficients are fitted, defined constants stay fixed. X ~ Normal(mean, sd) declares a random variable.';
  const word = /[A-Za-z_][\w.]*(?:\.[\w]*)?$/.exec(before)?.[0] ?? '';
  if (!word) return { ...empty, hint };
  const start = offset - word.length;
  const end = offset + (/^[\w.]*/.exec(text.slice(offset))?.[0].length ?? 0);
  const suggestions = [...candidates.values()].filter(s =>
    s.name.toLowerCase().startsWith(word.toLowerCase()) && s.name !== text.slice(start, end)
    && (word.length >= 2 || !s.call || defs.fns.has(s.name)))
    .sort((a, b) => Number(a.call) - Number(b.call) || a.name.localeCompare(b.name)).slice(0, 6);
  return { start, end, suggestions, hint };
}
