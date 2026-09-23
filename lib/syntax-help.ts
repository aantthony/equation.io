import { type Env } from './env.ts';
/** Pure, tolerant editor assistance. Suggestions write ordinary equation
 * text; an incomplete expression never needs to pass through the parser.
 */
import { pointComponentNames, shadowedFnNames } from './defs.ts';
import { DIST_FAMILIES, distFamily, distUsage, isModelName } from './dist-families.ts';
import { tildeRow } from './regression.ts';
import { FUNCTIONS, NAME_SRC, NAME_START_CHARS, WRITTEN_NAME_CHARS, builtinFn, canonicalName } from './expr.ts';
import { ESCAPES } from './escapes.ts';
import { VALUE_END } from './statements.ts';

export interface Suggestion {
  name: string;
  signature: string;
  description: string;
  call: boolean;
  /** Replacement text when it differs from `name`: \pi inserts π. */
  insert?: string;
}

/** The name a '(' follows, for call signatures. */
const CALL_NAME_RE = new RegExp(String.raw`(${NAME_SRC})\s*$`);
/** The head of a ~ row's right side. */
const HEAD_NAME_RE = new RegExp(String.raw`^\s*(${NAME_SRC})\s*\($`);
/** The (possibly dotted) name under the caret, as written. */
const WORD_RE = new RegExp(`[${NAME_START_CHARS}][${WRITTEN_NAME_CHARS}.]*(?:\\.[${WRITTEN_NAME_CHARS}]*)?$`);
const WORD_END_RE = new RegExp(`^[${WRITTEN_NAME_CHARS}.]*`);
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
  segment: ['segment(A, B)', 'Segment joining two 2D or 3D points'],
  polyline: ['polyline(A, B, C, …)', 'Open path through 2D/3D points; also polyline(P) for a point list'],
  vector: ['vector(A, B) or vector(V)', 'Arrow from A to B, or from the origin to V'],
  line: ['line(A, B)', 'Line through two points'],
  circle: ['circle(A, r)', 'Circle with center A and radius r'],
  polygon: ['polygon(A, B, C, …)', 'Polygon through points or a point list; 3D triangles fill, larger 3D polygons outline'],
  square: ['square(A, B)', 'Square erected to the left of side A → B'],
  midpoint: ['midpoint(A, B)', 'Midpoint of two points'],
  distance: ['distance(A, B)', 'Distance between two points, |A - B|'],
  angle: ['angle(A, B, C) or angle(U, V)', 'Angle at B, or between U and V: signed in 2D (−π, π], unsigned in 3D [0, pi]'],
  dot: ['dot(A, B)', 'Vector dot product'], cross: ['cross(A, B) or cross(n)', 'Vector cross product; cross(n) alone is the rotation generator about n, as in e^(a cross(n)) v'],
  hull: ['hull(A, B, C, …) or hull(P)', 'Convex hull of points or a point list: a filled polygon in 2D, a solid in 3D'],
  rotate: ['rotate(P, angle), rotate(P, angle, center) or rotate(P, angle, axis)', 'Turn a point: about the origin or a center in 2D, about an axis in 3D'],
  det: ['det(M)', 'Matrix determinant'], trace: ['trace(M)', 'Matrix trace'],
  solve: ['solve(M, v)', 'Solve the linear system M x = v'],
  sum: ['sum(n=1..N, expression)', 'Finite sum'],
  prod: ['prod(n=1..N, expression)', 'Finite product'],
  int: ['int[a..b] f(x) dx', 'Definite integral; bounds may be omitted. Alone on a row it shades its signed area'],
  domain: ['domain(f(w))', 'Complex domain coloring'],
  rgb: ['rgb(red, green, blue)', '2D color field; real channels from 0 to 1'],
  hsl: ['hsl(hue, saturation, lightness)', '2D color field; hue in radians, saturation and lightness 0–1'],
  oklch: ['oklch(lightness, chroma, hue)', '2D color field; lightness 0–1, chroma typically 0–0.4, hue in radians'],
  conformal: ['conformal(f(w))', 'Image of a complex coordinate grid'],
  iter: ['iter(w^2 + c)', 'Complex escape-time iteration'],
  grad: ['grad(f)', 'Gradient in 2D or 3D, plotted as a vector field'],
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
 *  when the caller has only the built Env. */
const definedNames = (defs: Env): ReadonlySet<string> => new Set([
  ...defs.consts.keys(), ...defs.fns.keys(), ...defs.fields.keys(), ...defs.states.keys(), ...defs.points,
  ...defs.mats.keys(), ...defs.lists.keys(), ...defs.tables.keys(), ...defs.missingData.keys(),
]);

/** `declared`: the document's `name = …` names (regression.ts declaredNames),
 *  which decide whether `Y ~ gamma(` is a model or a law exactly as the row
 *  itself will be read; without it the built definitions stand in. */
export function syntaxHelp(text: string, offset: number, defs: Env, declared?: ReadonlySet<string>): SyntaxHelp {
  const before = text.slice(0, offset);
  const empty: SyntaxHelp = { start: offset, end: offset, suggestions: [] };
  if (text.trimStart().startsWith('#')) return empty;
  // Primes after identifiers/values are derivatives, not string delimiters.
  let quote = '', stack: Array<{ name?: string; at: number }> = [];
  for (let i = 0; i < before.length; i++) {
    const c = before[i];
    if (quote) { if (c === quote) quote = ''; continue; }
    if (c === '"' || (c === "'" && !VALUE_END.test(before[i - 1] ?? ''))) { quote = c; continue; }
    if ('([{'.includes(c)) {
      // Canonicalize the captured call name so f₁( finds the f_1 signature.
      const name = c === '(' ? CALL_NAME_RE.exec(before.slice(0, i))?.[1] : undefined;
      stack.push({ name: name && canonicalName(name), at: i });
    } else if (')]}'.includes(c)) stack.pop();
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
  values([...defs.fields.keys()].filter(n => !pointComponentNames(defs).has(n)), 'Coordinate field');
  values(defs.points, 'Defined point');
  values(defs.mats.keys(), 'Defined matrix');
  values(defs.lists.keys(), 'Defined list');
  for (const [name, table] of defs.tables) {
    values([name], 'Data table');
    for (const col of table.data?.columns ?? []) values([`${name}.${col.name}`], `${col.type === 'num' ? 'Numeric' : 'Text'} column · ${table.file}`);
  }
  for (const [name, fn] of defs.fns) candidates.set(name,
    { name, signature: `${name}(${fn.params.join(', ')})`, description: 'Defined function', call: true });
  // \pi, \nabla, \trail, …: a \word suggests from the escape table instead
  // (`start` covers the backslash). A function-name escape completes like
  // the function itself — real signature, parens on accept — which makes a
  // bare `\` a function search that works from the first letter, where the
  // plain word path holds built-in calls back until two characters. A symbol
  // escape carries `insert`, the replacement text for the whole \word.
  const esc = /\\([A-Za-z]*)$/.exec(before);
  if (esc && before[before.length - esc[0].length - 1] !== '\\') {
    const start = offset - esc[0].length;
    const end = offset + (/^[A-Za-z0-9]*/.exec(text.slice(offset))?.[0].length ?? 0);
    const suggestions = ESCAPES.filter(s => s.name.startsWith(esc[1])).slice(0, 6)
      .map(({ name, text: replacement, description }): Suggestion => {
        const fn = candidates.get(replacement);
        if (fn?.call) return { ...fn, signature: `${fn.signature}   \\${name}` };
        return { name: `\\${name}`, signature: `${replacement}   \\${name}`, description, call: false, insert: replacement };
      });
    const hint = suggestions.length ? undefined
      : '\\name inserts a symbol or function: \\pi → π, \\theta → θ, \\nabla → ∇ (\\\\ for a backslash)';
    return { start, end, suggestions, hint };
  }
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
    ? HEAD_NAME_RE.exec(before.slice(row.tilde + 1, (stack[0]?.at ?? -1) + 1)) : null;
  const family = head && row && stack[0].at > row.tilde && call === canonicalName(head[1]) && stack.filter(f => f.name).length === 1
    && !defs.fns.has(call) ? distFamily(call) : undefined;
  const distName = family?.name;
  const entry = distName ? candidates.get(distName)
    : call && !blocked ? candidates.get(call) ?? foldedBuiltins.get(call.toLowerCase()) : undefined;
  let hint = entry?.call ? `${entry.signature} — ${entry.description}` : undefined;
  if (!hint && before.includes('~')) hint = 'Y ~ m X + b fits data lists: unbound coefficients are fitted, defined constants stay fixed. X ~ Normal(mean, sd) declares a random variable.';
  const word = WORD_RE.exec(before)?.[0] ?? '';
  if (!word) return { ...empty, hint };
  const start = offset - word.length;
  const end = offset + (WORD_END_RE.exec(text.slice(offset))?.[0].length ?? 0);
  // Candidates live under canonical names, so T₀ matches (and becomes) T_0.
  const canon = canonicalName(word);
  const suggestions = [...candidates.values()].filter(s =>
    s.name.toLowerCase().startsWith(canon.toLowerCase()) && s.name !== canonicalName(text.slice(start, end))
    && (word.length >= 2 || !s.call || defs.fns.has(s.name)))
    .sort((a, b) => Number(a.call) - Number(b.call) || a.name.localeCompare(b.name)).slice(0, 6);
  return { start, end, suggestions, hint };
}
