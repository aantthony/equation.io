import { describe, expect, it } from 'vitest';
import { parseCsv } from './csv.ts';
import {
  MissingDataError,
  badTableRow,
  type TableSource,
  buildDefs,
  evalConstEnv,
  formatTableRow,
  freeTableName,
  isListName,
  indexIssue,
  listGetter,
  listNamesOf,
  nameTaken,
  nameable,
  rowSafeFileName,
  resolveExpr,
  scanDefinition,
} from './defs.ts';
import { type Expr, evaluate, freeVars, parseExpr } from './expr.ts';
import { lowerGeom } from './geom.ts';
import { decodePayload, encodePayload } from './link.ts';
import { type Seq, lowerLists, seqLength } from './list.ts';
import { classify } from './plot.ts';

const PEOPLE = 'name,age,height\nada,36,1.70\nbob,41,1.82\ncy,29,1.65\n';
const HASH = 'a1b2c3d4e5f6';

/** A file store holding one file, keyed the way the app's does. */
const store = (files: Record<string, string> = { 'people.csv': PEOPLE }): TableSource =>
  ({ file }) => (files[file] ? parseCsv(files[file]) : null);

/** `null` stands for a device with no local files at all (the worker). */
function build(rows: string[], tables: TableSource | null = store()) {
  return buildDefs(rows.map(r => scanDefinition(r)!), tables ?? undefined);
}

/** Run a plot row through the app's pipeline: parse → resolve → lower. */
function lowerRow(text: string, defRows: string[], tables: TableSource | null = store()) {
  const { defs, errors } = build(defRows, tables);
  expect([...errors]).toEqual([]);
  const consts = evalConstEnv(defs, 0);
  const listNames = listNamesOf(defs);
  // The same options the app and the worker build, so a test cannot pass by
  // skipping a check the real pipeline runs.
  const ropts = {
    consts,
    isList: (n: string) => isListName(listNames, n),
    indexIssue: (idx: Expr) => indexIssue(idx, defs),
  };
  const e = resolveExpr(parseExpr(text, new Set(defs.fns.keys()), listNames), n => defs.fns.get(n), ropts);
  return lowerLists(lowerGeom(e, () => null, () => null), listGetter(defs), ropts);
}

const values = (e: Expr): number[] => {
  // Either representation of a list: a typed array (a column, or constant
  // arithmetic over one) or one expression per element.
  if (e.kind === 'data') return [...e.values];
  if (e.kind !== 'list') throw new Error(`expected a list, got ${e.kind}`);
  return e.items.map(it => evaluate(it, {}));
};

describe('open() rows', () => {
  it('scans as a table definition', () => {
    expect(scanDefinition(`person = open("people.csv", ${HASH})`))
      .toEqual({ kind: 'table', name: 'person', file: 'people.csv', hash: HASH });
  });

  it('takes single quotes and an absent hash, and folds the hash to lower case', () => {
    expect(scanDefinition("p = open('a b.csv')")).toMatchObject({ file: 'a b.csv', hash: '' });
    expect(scanDefinition('p = open("a.csv", ABCDEF123456)')).toMatchObject({ hash: 'abcdef123456' });
  });

  it('is not a table row without the open() shape', () => {
    // A bare name in the parens is ordinary arithmetic, not a file.
    expect(scanDefinition('p = open(x)')).toMatchObject({ kind: 'const' });
    expect(scanDefinition('p = 2 open("a.csv")')).toMatchObject({ kind: 'const' });
  });

  it('finds a free row name for every dropped file', () => {
    const free = (base: string, ...taken: string[]) => freeTableName(base, new Set(taken));
    expect(free('people')).toBe('people');
    expect(free('people', 'people')).toBe('people_2');
    expect(free('people', 'people', 'people_2')).toBe('people_3');
    // A stem no definition may claim gets one that can be. Numbering alone
    // could not rescue these: `u`, `u_2`, `u_3`, … all read as uniform names,
    // so the search went round forever and froze the tab on a dropped `u.csv`
    // — with the bytes already written to storage.
    expect(nameable(free('u'))).toBe(true);
    expect(free('u')).toBe('data_u');
    expect(free('u_sales')).toBe('data_u_sales');
    expect(free('sin')).toBe('data_sin');
    expect(free('u', 'data_u')).toBe('data_u_2');
    // The names it invents are ones a row can actually define.
    for (const stem of ['u', 'u_2', 'x', 'pi', 'sin', 'people']) {
      expect([stem, nameable(free(stem, stem, `data_${stem}`))]).toEqual([stem, true]);
    }
  });

  it('leaves the name open to a graph that already used it', () => {
    // A price series names a column `open`, and graphs shared before data
    // files existed named sliders that. The data syntax is the SHAPE of the
    // row, so those definitions keep their meaning…
    expect(scanDefinition('open = 2')).toMatchObject({ kind: 'const', name: 'open' });
    expect(scanDefinition('open(f) = f')).toMatchObject({ kind: 'fn', name: 'open' });
    // …and a row that opens a file is still a file, whatever else is defined.
    expect(scanDefinition(`p = open("people.csv", ${HASH})`)).toMatchObject({ kind: 'table' });
  });

  it('says so when the row claims a built-in name', () => {
    // `w` is the 4th coordinate, so this row is not a definition at all — but
    // the reason has to be the name, not "quotes are not arithmetic".
    expect(badTableRow('w = open("wave.csv")')).toMatch(/w is a built-in name/);
    expect(badTableRow(`person = open("people.csv", ${HASH})`)).toBeNull();
    expect(badTableRow('y = sin(x)')).toBeNull();
  });

  it('round-trips through the row text the app writes', () => {
    const text = formatTableRow('person', 'people.csv', 'a1b2c3d4e5f6789');
    expect(text).toBe(`person = open("people.csv", ${HASH})`);
    expect(scanDefinition(text)).toMatchObject({ name: 'person', hash: HASH });
  });

  it('writes a file name a row can read back', () => {
    // A row quotes the name with no escape, so a name holding a quote or a
    // line break would produce a row that does not parse. Applied at ingest
    // too, so the stored name and the row agree.
    expect(rowSafeFileName('sales "final".csv')).toBe('sales _final_.csv');
    expect(rowSafeFileName('two\nlines.csv')).toBe('two_lines.csv');
    expect(rowSafeFileName('"')).toBe('_');
    expect(rowSafeFileName('plain.csv')).toBe('plain.csv');
    const text = formatTableRow('p', 'sales "final".csv', '');
    expect(scanDefinition(text)).toMatchObject({ name: 'p', file: 'sales _final_.csv' });
  });

  it('writes a file name a LINK can read back, semicolon and all', () => {
    // The name used to lose its `;` at ingest: the payload joins rows with
    // that character and encodes the quotes, so the row came back split in
    // two. The codec tells the two apart now (lib/link.ts), so the file keeps
    // the name it was saved under — which is also the name the row must say,
    // or re-dropping the same file would not match it.
    expect(rowSafeFileName('sales;2026.csv')).toBe('sales;2026.csv');
    const text = formatTableRow('p', 'sales;2026.csv', '');
    expect(text).toBe('p = open("sales;2026.csv")');
    expect(decodePayload(encodePayload([text, 'y = p.v']))).toEqual([text, 'y = p.v']);
    // …and a hand-typed one is a table row like any other.
    expect(scanDefinition('p = open("a;b.csv")')).toMatchObject({ kind: 'table', file: 'a;b.csv' });
    expect(badTableRow('p = open("a;b.csv")')).toBeNull();
  });

  it('needs a hash long enough to name one file', () => {
    // A row resolves by hash PREFIX, so a short token can match more than one
    // stored file — binding to the wrong bytes is what the pin exists to stop.
    // Not scanned as a constant either, or the row validator — the only
    // thing that can explain the short hash — would never run on it.
    expect(scanDefinition('p = open("a.csv", abc123)')).toBeNull();
    expect(scanDefinition('p = open("a.csv"')).toBeNull();
    expect(badTableRow('p = open("a.csv"')).toMatch(/reads p = open\("file\.csv"\)/);
    expect(scanDefinition('p = open("a.csv", abc123abc123)')).toMatchObject({ hash: 'abc123abc123' });
    // Which would otherwise read as a constant and complain about the quotes.
    expect(badTableRow('p = open("a.csv", abc123)')).toMatch(/hash is 12 hex digits; that is 6/);
    expect(badTableRow(`p = open("a.csv", ${HASH})`)).toBeNull();
  });

  it('registers the file and its columns', () => {
    const { defs, errors } = build([`person = open("people.csv", ${HASH})`]);
    expect([...errors]).toEqual([]);
    const t = defs.tables.get('person')!;
    expect(t.file).toBe('people.csv');
    expect(t.data!.rows).toBe(3);
    expect([...listNamesOf(defs)]).toEqual(['person', 'person.name', 'person.age', 'person.height']);
  });

  it('reports a file this device does not have', () => {
    const { errors } = build([`person = open("nope.csv", ${HASH})`]);
    expect(errors.get('person')).toMatch(/nope\.csv \(a1b2c3d4e5f6\) is not on this device/);
  });
});

describe('reductions over a list of points', () => {
  it('counts them, since count never looks inside an element', () => {
    expect(lowerRow('count([(1,2),(3,4),(5,6)])', [])).toEqual({ kind: 'num', value: 3 });
  });

  it('still refuses the reductions that would have to add them up', () => {
    expect(() => lowerRow('mean([(1,2),(3,4)])', [])).toThrow(/list of points is not supported/);
  });
});

describe('columns as lists', () => {
  const rows = [`person = open("people.csv", ${HASH})`];

  it('reads a column under its dotted name', () => {
    expect(values(lowerRow('person.age', rows))).toEqual([36, 41, 29]);
  });

  it('broadcasts and zips columns into a scatter', () => {
    expect(values(lowerRow('person.age / 2', rows))).toEqual([18, 20.5, 14.5]);
    // Two columns stay two typed arrays — the scatter never becomes N points.
    const plot = classify(lowerRow('(person.age, person.height)', rows), new Set()).plot;
    expect(plot).toMatchObject({ type: 'dscatter', dim: 2 });
    expect((plot as { coords: Float64Array[] }).coords.map(c => [...c]))
      .toEqual([[36, 41, 29], [1.7, 1.82, 1.65]]);
  });

  it('rides a constant along as the other coordinate', () => {
    const plot = classify(lowerRow('(person.age, 0)', rows), new Set()).plot;
    expect(plot).toMatchObject({ type: 'dscatter', dim: 2 });
    expect([...(plot as { coords: Float64Array[] }).coords[1]]).toEqual([0, 0, 0]);
  });

  it('reduces and indexes like any other list', () => {
    expect(evaluate(lowerRow('mean(person.age)', rows), {})).toBeCloseTo(35.3333, 4);
    expect(evaluate(lowerRow('count(person.age)', rows), {})).toBe(3);
    expect(evaluate(lowerRow('person.age[2]', rows), {})).toBe(41);
    expect(evaluate(lowerRow('median(person.height)', rows), {})).toBe(1.7);
  });

  it('mixes a column with a plain list of the same length', () => {
    expect(values(lowerRow('person.age + [1, 2, 3]', rows))).toEqual([37, 43, 32]);
    expect(() => lowerRow('person.age + [1, 2]', rows)).toThrow(/different lengths/);
  });

  it('names the columns when one is missing', () => {
    expect(() => lowerRow('person.salary', rows))
      .toThrow(/no column "salary" \(columns: name, age, height\)/);
  });

  it('reads a text column as text, which cannot be plotted', () => {
    expect(() => lowerRow('person.name', rows)).toThrow(/Text cannot be plotted/);
    expect(() => lowerRow('person.name / 2', rows)).toThrow(/Text has no numeric value/);
    expect(evaluate(lowerRow('count(person.name)', rows), {})).toBe(3);
    expect(() => lowerRow('mean(person.name)', rows)).toThrow(/that column holds text/);
    expect(() => lowerRow('hist(person.name)', rows)).toThrow(/that column holds text/);
  });

  it('leaves a dot on anything else alone', () => {
    // A dotted name with no table behind it is just a name.
    expect(lowerRow('foo.bar', rows)).toEqual({ kind: 'var', name: 'foo.bar' });
    expect(evaluate(lowerRow('x.y', []), { 'x.y': 7 })).toBe(7);
  });
});

describe('typed-array columns', () => {
  const rows = [`person = open("people.csv", ${HASH})`];
  const kindOf = (text: string, defs = rows) => lowerRow(text, defs).kind;

  it('keeps constant arithmetic in the array', () => {
    for (const text of ['person.age', 'person.age / 2', '-person.age', 'sin(person.age)',
      'person.age^2 + 1', 'min(person.age, 40)', 'sort(person.age)']) {
      expect([text, kindOf(text)]).toEqual([text, 'data']);
    }
    expect(values(lowerRow('min(person.age, 40)', rows))).toEqual([36, 40, 29]);
  });

  it('falls back to one expression per row when a slider or t is involved', () => {
    // A slider has to stay a name, or the shader it feeds would recompile on
    // every drag; t has no value at all until the frame draws.
    expect(kindOf('person.age t')).toBe('list');
    expect(kindOf('person.age c', [...rows, 'c = 2'])).toBe('list');
    const low = lowerRow('person.age c', [...rows, 'c = 2']) as Expr & { kind: 'list' };
    expect(low.items.map(it => evaluate(it, { c: 2 }))).toEqual([72, 82, 58]);
  });

  it('reduces without building an expression per element', () => {
    // 100k nested adds used to be both the tree and the recursion that read it.
    const long = ['v', ...Array.from({ length: 100_000 }, () => '2')].join('\n');
    const tbl = store({ 'long.csv': long });
    const defs = [`long = open("long.csv", ${HASH})`];
    expect(evaluate(lowerRow('total(long.v)', defs, tbl), {})).toBe(200_000);
    expect(evaluate(lowerRow('mean(long.v)', defs, tbl), {})).toBe(2);
  });
});

describe('a column or list named after a builtin', () => {
  it('still indexes, because indexing beats the function reading', () => {
    // A CSV headed `sin` is perfectly legal, and `mean` is shadowable.
    const src: TableSource = () => parseCsv('sin,age\n7,2\n8,4\n');
    expect(values(lowerRow('p.sin', ['p = open("t.csv")'], src))).toEqual([7, 8]);
    expect(lowerRow('p.sin[2]', ['p = open("t.csv")'], src)).toMatchObject({ kind: 'num', value: 8 });
    // A function that is NOT a list still calls: sin[2] is sin applied to 2.
    expect(lowerRow('sin[0]', ['p = open("t.csv")'], src))
      .toMatchObject({ kind: 'call', name: 'sin' });
  });

  it('indexes a named list that shadows a reduction', () => {
    const { defs, errors } = build(['mean = [3, 1, 4]']);
    expect([...errors]).toEqual([]);
    expect(listNamesOf(defs).has('mean')).toBe(true);
    expect(lowerRow('mean[2]', ['mean = [3, 1, 4]'])).toMatchObject({ kind: 'num', value: 1 });
  });
});

describe('a scatter of three columns', () => {
  const rows = [`person = open("people.csv", ${HASH})`];

  it('asks for a 3D scene, or it would draw nothing at all', () => {
    // The 2D pass deliberately skips dim-3 clouds, so without this the row
    // renders only when some unrelated row happens to turn 3D on.
    const c = classify(lowerRow('(person.age, person.height, person.age)', rows));
    expect(c.plot).toMatchObject({ type: 'dscatter', dim: 3 });
    expect(c.needs3D).toBe(true);
    expect(classify(lowerRow('(person.age, person.height)', rows)).needs3D).toBe(false);
  });
});

describe('the expression budget', () => {
  const column = (n: number): TableSource =>
    () => parseCsv('v\n' + Array.from({ length: n }, (_, i) => i + 1).join('\n') + '\n');
  const rows = ['big = open("big.csv")'];

  it('lets one mapped operation reach the documented 100 000', () => {
    // Charging both the expansion and its result halved this: `col t` used
    // to fail at 50 001 rows against a stated limit of 100 000.
    expect(seqLength(lowerRow('big.v t', rows, column(100000)) as Seq)).toBe(100000);
    expect(() => lowerRow('big.v t', rows, column(100001))).toThrow(/only 100000 can be combined/);
  });

  it('spends the budget again for each further mapped operation', () => {
    // Documented in llms.txt as a per-row budget, not a row count.
    expect(seqLength(lowerRow('big.v t + 1', rows, column(50000)) as Seq)).toBe(50000);
    expect(() => lowerRow('big.v t + 1', rows, column(60000)))
      .toThrow(/too many list elements/);
  });
});

describe('differentiating a list', () => {
  it('says it cannot, rather than answering 0', () => {
    // Derivatives expand at resolve time, before list.ts substitutes, so the
    // list is still a bare name and diff() reads it as a constant.
    expect(() => lowerRow('d/dt L', ['L = [sin(t), t^2]'])).toThrow(/L is a list/);
    expect(() => lowerRow('d/dx L', ['L = [sin(t), t^2]'])).toThrow(/cannot differentiate one/);
    // A column is a list too.
    expect(() => lowerRow('d/dx person.age', [`person = open("people.csv", ${HASH})`]))
      .toThrow(/is a list/);
    // Ordinary derivatives are untouched.
    expect(evaluate(lowerRow('d/dx x^2', []), { x: 3 })).toBe(6);
  });

  it('says it on a device without the file too', () => {
    // Nothing here can enumerate the columns, so `person.age` was not a known
    // list name and diff() differentiated it as an opaque constant: the row
    // errored for the author and drew the line y = 0 in every shared link,
    // preview, and MCP listing. The head of the path is enough to answer.
    const rows = [`person = open("people.csv", ${HASH})`];
    expect(() => lowerRow('d/dx person.age', rows, null)).toThrow(/is a list/);
    expect(() => lowerRow('d/dx (person.age + 1)', rows, null)).toThrow(/is a list/);
  });

  it('says the same about text, instead of the internal "Unreachable"', () => {
    // A text literal is a leaf diff() had no case for, so it fell off the end
    // of the switch. The name guard above cannot catch it: a literal has no
    // free variable to look up.
    expect(() => lowerRow('d/dx "NYC"', [])).toThrow(/Cannot differentiate text/);
    expect(() => lowerRow('d/dx sin("NYC")', [])).toThrow(/Cannot differentiate text/);
    expect(() => lowerRow('d/dx ["a", "b"]', [])).toThrow(/Cannot differentiate a list/);
  });
});

describe('a reduction over a whole column', () => {
  it('nests logarithmically, so the stack survives it', () => {
    // Folding left nested one node per element, and every consumer of an Expr
    // recurses (freeVars, evaluate, toGLSL, diff): a column crossed with t
    // blew the stack well inside the advertised expansion limit.
    const N = 30000;
    const rows = ['big = open("big.csv")'];
    const src: TableSource = () => parseCsv('v\n' + Array.from({ length: N }, (_, i) => i + 1).join('\n') + '\n');
    for (const text of ['total(big.v t)', 'mean(big.v t)', 'min(big.v t)']) {
      const e = lowerRow(text, rows, src);
      let depth = 0;
      for (let n: Expr | undefined = e; n; ) {
        if (n.kind === 'bin') { depth++; n = n.a; }
        else if (n.kind === 'call' && n.args.length) { depth++; n = n.args[0]; }
        else break;
      }
      expect(depth).toBeLessThan(64);
      expect(() => freeVars(e)).not.toThrow();
      expect(evaluate(e, { t: 1 })).toBeGreaterThan(0);
    }
    expect(evaluate(lowerRow('total(big.v t)', rows, src), { t: 2 })).toBe(N * (N + 1));
  });

  it('reduces the values that are there, not the gaps between them', () => {
    // A missing cell is NaN. Reduced with the rest it made mean, total, min,
    // max and stdev NaN outright, and sorted to the END for the median, which
    // then indexed as if the gap were a value: a wrong number, shown with the
    // same confident ≈ as a right one. hist() has always skipped them.
    // The gap sits inside a wider row: a line holding nothing at all is a
    // blank line, not a row of one missing value (see csv.ts).
    const src = store({ 'g.csv': 'a,b\n1,10\n,20\n3,30\n' });
    const defs = [`g = open("g.csv", ${HASH})`];
    const val = (text: string) => evaluate(lowerRow(text, defs, src), {});
    expect(val('median(g.a)')).toBe(2);
    expect(val('mean(g.a)')).toBe(2);
    expect(val('total(g.a)')).toBe(4);
    expect(val('min(g.a)')).toBe(1);
    expect(val('max(g.a)')).toBe(3);
    expect(val('stdev(g.a)')).toBeCloseTo(Math.SQRT2, 12);
    expect(values(lowerRow('sort(g.a)', defs, src))).toEqual([1, 3]);
    // …but `count` answers how many rows there are, gaps included — the same
    // answer it gives for a text column, and what the file's preview shows.
    expect(val('count(g.a)')).toBe(3);
  });

  it('skips them on the symbolic path too, one slider along', () => {
    // A column crossed with t or a slider stops being a typed array and
    // becomes one expression per element — each gap now an expression holding
    // NaN, which folded straight into the answer: `mean(g.a)` was 2 and
    // `mean(g.a t)` was NaN, for the same column and the same rule. The
    // representation a row happens to be in cannot decide what it means.
    const src = store({ 'g.csv': 'a,b\n1,10\n,20\n3,30\n' });
    const defs = [`g = open("g.csv", ${HASH})`, 'k = 2'];
    const val = (text: string) => evaluate(lowerRow(text, defs, src), { t: 1 });
    expect(val('mean(g.a t)')).toBe(2);
    expect(val('total(g.a t)')).toBe(4);
    expect(val('min(g.a t)')).toBe(1);
    expect(val('max(g.a t)')).toBe(3);
    expect(val('median(g.a k)')).toBe(4);
    expect(val('stdev(g.a k)')).toBeCloseTo(2 * Math.SQRT2, 12);
    expect(values(lowerRow('sort(g.a k)', defs, src))).toEqual([2, 6]);
    expect(val('count(g.a t)')).toBe(3); // still how many rows there are
    // hist told the same story: it drops non-finite values off a typed array,
    // and refused the whole row ("not finite") one slider away.
    const bars = (text: string) => lowerRow(text, defs, src) as Expr & { kind: 'call' };
    const counts = (e: Expr & { kind: 'call' }) => [...(e.args[1] as Expr & { kind: 'data' }).values];
    expect(counts(bars('hist(g.a k, 2)'))).toEqual(counts(bars('hist(g.a, 2)')));
    // A list with no gaps in it is untouched by any of this.
    expect(evaluate(lowerRow('mean(L t)', ['L = [1, 2, 3]']), { t: 2 })).toBe(4);
  });

  it('says so when a filter has left it nothing to reduce', () => {
    const src = store({ 'g.csv': 'a,b\n1,1\n,2\n' });
    const defs = [`g = open("g.csv", ${HASH})`, 'late = g[g.b > 1]'];
    expect(() => lowerRow('mean(late.a)', defs, src)).toThrow(/no values to work with/);
  });
});

describe('hist', () => {
  const rows = [`person = open("people.csv", ${HASH})`];
  const histOf = (text: string, defs = rows, tables?: TableSource) =>
    classify(lowerRow(text, defs, tables ?? store()), new Set()).plot as
      { type: string; centers: Float64Array; counts: Float64Array; width: number };

  it('bins a list into touching bars', () => {
    const h = histOf('hist(L, 4)', ['L = [0, 1, 1, 2, 3]']);
    expect(h.type).toBe('histogram');
    expect(h.width).toBeCloseTo(0.75, 12);
    expect([...h.counts]).toEqual([1, 2, 1, 1]); // the top value joins the last bin
    expect([...h.centers]).toEqual([0.375, 1.125, 1.875, 2.625]);
  });

  it('bins a column, choosing a bin count when the row does not', () => {
    const h = histOf('hist(person.age)');
    expect(h.counts.length).toBeGreaterThanOrEqual(5);
    expect([...h.counts].reduce((a, b) => a + b, 0)).toBe(3);
  });

  it('leaves out missing values and survives a flat column', () => {
    const tables = store({ 'g.csv': 'v\n1\n\n5\n' });
    const defs = [`g = open("g.csv", ${HASH})`];
    expect([...histOf('hist(g.v, 2)', defs, tables).counts]).toEqual([1, 1]);
    // One repeated value is one bar, whatever bin count was asked for.
    const flat = store({ 'f.csv': 'v\n3\n3\n3\n' });
    const h = histOf('hist(f.v, 2)', [`f = open("f.csv", ${HASH})`], flat);
    expect([...h.counts]).toEqual([3]);
    expect([...h.centers]).toEqual([3]);
  });

  it('scales, because the plane has one scale for both axes', () => {
    const h = histOf('hist(L, 2) / 4', ['L = [0, 0, 0, 1]']);
    expect([...h.counts]).toEqual([0.75, 0.25]);
    expect([...histOf('2 hist(L, 2)', ['L = [0, 0, 0, 1]']).counts]).toEqual([6, 2]);
  });

  it('is a whole row, not a value', () => {
    expect(() => lowerRow('hist(person.age) + 1', rows)).toThrow(/whole plot/);
    expect(() => lowerRow('sin(hist(person.age))', rows)).toThrow(/whole plot/);
    expect(() => lowerRow('hist(4)', rows)).toThrow(/needs a list/);
    expect(() => lowerRow('hist(person.age, 1)', rows)).toThrow(/2 to 500 bins/);
  });

  it('cannot be named either, rather than storing an unspeakable node', () => {
    // A definition skips the plot-row checks (text is a value worth naming),
    // and the bars slipped through with them: `h` was stored as a constant
    // holding the internal `[hist]` node, and both rows then reported
    // "Unknown function: [hist]" — a token no one can type or fix.
    const { errors } = build([...rows, 'h = hist(person.age)', 'k = h + 1']);
    expect(errors.get('h')).toMatch(/whole plot, not a value/);
    expect([...errors.values()].join(' ')).not.toMatch(/\[hist\]/);
  });
});

describe('filters', () => {
  const rows = [`person = open("people.csv", ${HASH})`];

  it('keeps the elements a comparison selects', () => {
    expect(values(lowerRow('person.age[person.age > 30]', rows))).toEqual([36, 41]);
    expect(values(lowerRow('L[L >= 5]', [...rows, 'L = [1, 5, 2, 9]']))).toEqual([5, 9]);
    // A literal list still multiplies (only named lists index), so the mask
    // has nowhere to go and says so rather than plotting nonsense.
    expect(() => lowerRow('[1, 5][[1, 5] >= 5]', rows)).toThrow(/put it in brackets/);
  });

  it('drops a missing cell from every test, including !=', () => {
    // A gap is the absence of a value, not a value that differs — otherwise
    // `!=` would be the one comparison that quietly keeps the gaps.
    const src: TableSource = () => parseCsv('age,name\n30,ada\n,bob\n40,cy\n');
    const rows = ['p = open("gaps.csv")'];
    expect(values(lowerRow('p.age[p.age != 30]', rows, src))).toEqual([40]);
    expect(values(lowerRow('p.age[p.age == 30]', rows, src))).toEqual([30]);
    expect(values(lowerRow('p.age[p.age > 0]', rows, src))).toEqual([30, 40]);
    // …including against text, where the mixed-type answer ("a number is not
    // a string") was returned before either side was asked about gaps, so
    // `!=` kept exactly the rows it was written to exclude.
    expect(values(lowerRow('p.age[p.age != "unknown"]', rows, src))).toEqual([30, 40]);
    expect(() => lowerRow('p.age[p.age == "unknown"]', rows, src)).toThrow(/keeps nothing/);
  });

  it('drops a missing TEXT cell from every test too', () => {
    const src: TableSource = () => parseCsv('city,pop\nNYC,10\n,20\nOslo,30\n');
    const rows = ['p = open("gaps.csv")'];
    expect(values(lowerRow('p.pop[p.city != "NYC"]', rows, src))).toEqual([30]);
    expect(values(lowerRow('p.pop[p.city == "NYC"]', rows, src))).toEqual([10]);
    // An "N/A" reads as a gap in a text column exactly as in a numeric one,
    // so the only other row drops out and the filter keeps nothing at all.
    const na: TableSource = () => parseCsv('city,pop\nNYC,10\nN/A,20\n');
    expect(() => lowerRow('p.pop[p.city != "NYC"]', rows, na)).toThrow(/keeps nothing/);
    expect(parseCsv('city,pop\nNYC,10\n,20\n').missing.get('city')).toBe(1);
  });

  it('reads a chained comparison as one test', () => {
    expect(values(lowerRow('person.age[30 <= person.age < 40]', rows))).toEqual([36]);
  });

  it('selects one column by another, keeping rows aligned', () => {
    expect(values(lowerRow('person.height[person.age > 30]', rows))).toEqual([1.7, 1.82]);
  });

  it('takes its threshold from a slider', () => {
    expect(values(lowerRow('person.age[person.age > c]', [...rows, 'c = 40']))).toEqual([41]);
  });

  it('cuts a whole data file into a new one', () => {
    const { defs, errors } = build([...rows, 'old = person[person.age > 30]']);
    expect([...errors]).toEqual([]);
    const t = defs.tables.get('old')!;
    expect(t.data!.rows).toBe(2);
    expect(t.data!.columns.find(c => c.name === 'name')!.strs).toEqual(['ada', 'bob']);
    expect([...t.data!.columns.find(c => c.name === 'height')!.nums!]).toEqual([1.7, 1.82]);
    // …and the cut is itself a table: its columns plot like any others.
    expect(values(lowerRow('old.age', [...rows, 'old = person[person.age > 30]']))).toEqual([36, 41]);
  });

  it('drops missing values, because a comparison with a gap is false', () => {
    const gappy = store({ 'g.csv': 'a,b\n1,10\n,20\n3,30\n' });
    const gRows = [`g = open("g.csv", ${HASH})`];
    expect(values(lowerRow('g.b[g.a > 0]', gRows, gappy))).toEqual([10, 30]);
  });

  it('refuses a filter that cannot settle, or keeps nothing', () => {
    expect(() => lowerRow('person.age[person.age > t]', rows)).toThrow(/cannot depend on t/);
    expect(() => lowerRow('person.age[person.age > 99]', rows)).toThrow(/keeps nothing \(0 of 3\)/);
    expect(() => lowerRow('person.age[[1, 2] > 0]', rows)).toThrow(/tests 2 values but the list has 3/);
  });

  it('will not let a bare comparison masquerade as a plot', () => {
    expect(() => lowerRow('person.age > 30', rows)).toThrow(/put it in brackets/);
  });

  it('compares text, and says where a comparison belongs', () => {
    const cities = store({ 'c.csv': 'city,pop\nNYC,8\nOslo,1\nNYC,9\n' });
    const defs = [`c = open("c.csv", ${HASH})`];
    expect(values(lowerRow('c.pop[c.city == "NYC"]', defs, cities))).toEqual([8, 9]);
    expect(values(lowerRow("c.pop[c.city != 'NYC']", defs, cities))).toEqual([1]);
    // …and the filtered file keeps every column, text included.
    const { defs: d2 } = build([...defs, 'ny = c[c.city == "NYC"]'], cities);
    expect(d2.tables.get('ny')!.data!.columns[0].strs).toEqual(['NYC', 'NYC']);
    // Text never matches a number, rather than coercing to one.
    expect(() => lowerRow('c.pop[c.city == 3]', defs, cities)).toThrow(/keeps nothing/);
    // A comparison outside brackets says where it belongs, and '!=' still
    // rescues the factorial reading.
    expect(() => lowerRow('c.city == "NYC"', defs, cities)).toThrow(/put it in brackets/);
    expect(() => lowerRow('x != 2', defs, cities)).toThrow(/space before '=': x! = 2/);
  });

  it('says what a bare data-file name would have to be', () => {
    expect(() => lowerRow('person', rows)).toThrow(/data file — plot one of its columns, like person\.age/);
    expect(() => lowerRow('person / 2', rows)).toThrow(/is a data file/);
  });
});

describe('data that is not on this device', () => {
  const rows = [`person = open("people.csv", ${HASH})`];

  it('still defines the table, so the rows are not wrong — only unrenderable', () => {
    const { defs, errors } = build(rows, null);
    expect([...errors]).toEqual([]);
    expect(defs.tables.get('person')!.data).toBeNull();
    expect(() => lowerRow('person.age', rows, null)).toThrow(MissingDataError);
    expect(() => lowerRow('person.age', rows, null)).toThrow(/does not travel in the link/);
  });

  it('carries through a filter, so the cut is not reported as broken either', () => {
    const { defs, errors } = build([
      `person = open("people.csv", ${HASH})`,
      'adults = person[person.age >= 18]',
    ], null);
    expect([...errors]).toEqual([]);
    expect(defs.tables.get('adults')!.data).toBeNull();
    expect(() => listGetter(defs)('adults.age')).toThrow(MissingDataError);
  });

  it('holds on to the name, so a random variable cannot take it on one device', () => {
    // With the file, `ages` is a list and `avg` a constant; without it, both
    // live only in `missingData`. A `~` row asking whether the name is free
    // has to get the same answer either way, or the author is the only person
    // the document is broken for.
    for (const [name, rhs] of [['ages', 'person.age / 2'], ['avg', 'mean(person.age)']]) {
      const rows = [`person = open("people.csv", ${HASH})`, `${name} = ${rhs}`];
      for (const tables of [store(), null]) {
        expect([nameTaken(build(rows, tables).defs, name), name, !!tables])
          .toEqual([true, name, !!tables]);
      }
    }
    expect(nameTaken(build([`person = open("people.csv", ${HASH})`], null).defs, 'ages'))
      .toBe(false);
  });

  it('still judges what a filter looks like, so a link is not valid only here', () => {
    // The rows it keeps need the file; whether it is a comparison at all does
    // not. Without this a shared link calls `person[5]` fine and the author's
    // own device rejects it the moment the data arrives.
    const shape = 'person[…] needs a comparison, like person[person.x > 0].';
    for (const cond of ['5', 'person.age', 'sin(person.age)', 'person.age + 1', '1 < 2',
      // A list has to REACH the comparison: these collapse to one scalar
      // first, so they decide the same answer for every row.
      'mean(person.age) > 0', 'person.age[1] > 0', 'min(person.age) > 0',
      // hist is a whole plot, so it is not a value a filter can compare.
      'hist(person.age) > 0']) {
      expect([...build([...rows, `adults = person[${cond}]`], null).errors])
        .toEqual([['adults', shape]]);
      // …and the device WITH the data agrees, which is the whole point.
      expect([...build([...rows, `adults = person[${cond}]`]).errors])
        .toEqual([['adults', shape]]);
    }
    expect([...build([...rows, 'adults = person[person.age > t]'], null).errors])
      .toEqual([['adults', 'A filter cannot depend on t — the list would change length every frame.']]);
    // And a well-formed one is still accepted, data or no data.
    expect([...build([...rows, 'adults = person[person.age >= 18]'], null).errors]).toEqual([]);
  });

  it('refuses a list inside a whole-plot call the same way on both devices', () => {
    // `domain(…)`, `iter(…)`, `tube(…)` and the geometry statements take a
    // whole plot, not a list, and list.ts says so the moment the bytes are
    // here. Judged by shape alone the call looked like any other mapping
    // over a list, so the filter was device-local (valid!) without the file
    // and an error with it — the one thing this path exists to prevent.
    for (const fn of ['domain', 'conformal', 'iter', 'tube']) {
      const cut = [...rows, `adults = person[${fn}(person.age) > 0]`];
      const message = `Lists cannot appear inside ${fn}(…).`;
      expect([...build(cut, null).errors]).toEqual([['adults', message]]);
      expect([...build(cut).errors]).toEqual([['adults', message]]);
    }
  });

  it('names the file on the filtered definition, not only on its source', () => {
    // `adults` was the one row in the chain that said nothing: `person` asked
    // for the file and every use of `adults` did too, but the cut itself
    // showed no error and offered no file picker.
    const missing = ['person = open("gone.csv", a1b2c3d4e5f6)', 'adults = person[person.age >= 18]'];
    const { defs, errors, needsFile } = build(missing);
    expect([...needsFile]).toEqual(['person', 'adults']);
    expect(errors.get('adults')).toMatch(/gone\.csv \(a1b2c3d4e5f6\) is not on this device/);
    // Still registered, so the rows below report the file rather than
    // "unknown variable" — the reason the null table exists at all.
    expect(defs.tables.has('adults')).toBe(true);
  });

  it('refuses a slice the same way with the file and without it', () => {
    // Whether an index is a slice is a question about shape, so it must be
    // answered identically on a device that has not got the bytes — otherwise
    // a shared link reports valid and the author's device rejects the row.
    const rows = [`person = open("people.csv", ${HASH})`];
    expect(() => lowerRow('person.age[person.age]', rows)).toThrow(/Slicing/);
    const away = ['person = open("people.csv", a1b2c3d4e5f6)'];
    const { defs } = build(away, null);
    const names = listNamesOf(defs);
    const e = resolveExpr(parseExpr('person.age[person.age]', new Set(), names), () => undefined, {
      isList: (n: string) => names.has(n),
      indexIssue: (idx: Expr) => indexIssue(idx, defs),
    });
    expect(() => lowerLists(e, listGetter(defs), { indexIssue: idx => indexIssue(idx, defs) }))
      .toThrow(/Slicing/);
  });

  it('refuses a filter no list reaches, with the file and without it', () => {
    // The other half of the same question. `person.age[1 < 2]` IS a
    // comparison, so it was not a slice — but no list reaches it, so it
    // decides one answer for every element. With the bytes it died deep in
    // lowering ("Cannot evaluate an inequality"); without them the column
    // threw for its file first and the row was reported merely device-local,
    // which is the shared-link-valid / author-broken split all over again.
    const rows = [`person = open("people.csv", ${HASH})`];
    for (const idx of ['1 < 2', 'mean(person.age) > 0', 'person.age[1] > 0']) {
      for (const tables of [store(), null]) {
        expect(() => lowerRow(`person.age[${idx}]`, rows, tables), `${idx} ${!!tables}`)
          .toThrow(/has to test the list itself/);
      }
    }
    // A whole-plot call over a list is refused on both devices too, as it is
    // for a whole-table filter, and the honest shapes still work.
    for (const tables of [store(), null]) {
      expect(() => lowerRow('person.age[domain(person.age) > 0]', rows, tables))
        .toThrow(/Lists cannot appear inside domain/);
    }
    expect(values(lowerRow('person.age[person.age > 30]', rows))).toEqual([36, 41]);
    expect(lowerRow('person.age[1]', rows)).toMatchObject({ kind: 'num', value: 36 });
  });

  it('carries through a NAMED list, so the row below still reports the file', () => {
    // `ages` cannot be built without the bytes, but it is still a list whose
    // file is elsewhere — a row using it must not degrade into "not defined".
    const { defs, errors, needsFile } = build([...rows, 'ages = person.age / 2'], null);
    expect([...errors]).toEqual([['ages', expect.stringMatching(/does not travel in the link/)]]);
    expect([...needsFile]).toEqual(['ages']);
    expect(() => listGetter(defs)('ages')).toThrow(MissingDataError);
    // …and so does a row that uses it (lowerRow's helper insists the defs are
    // clean, which they deliberately are not here).
    const use = parseExpr('mean(ages)', new Set(), listNamesOf(defs));
    expect(() => lowerLists(use, listGetter(defs), {})).toThrow(/does not travel in the link/);
  });

  it('tells a missing LIST from a missing number', () => {
    // Both keep their provenance, but only the list-shaped one is a list:
    // calling a scalar one would make `avg` index here and multiply on the
    // device that has the bytes, and would let a filter over it pass here.
    const { defs, errors } = build([...rows, 'ages = person.age / 2', 'avg = mean(person.age)'], null);
    expect([...errors].map(e => e[0])).toEqual(['ages', 'avg']);
    expect(defs.missingData.get('ages')).toMatchObject({ list: true });
    expect(defs.missingData.get('avg')).toMatchObject({ list: false });
    expect(listNamesOf(defs).has('ages')).toBe(true);
    expect(listNamesOf(defs).has('avg')).toBe(false);
    // Both still report the file wherever they are used: the flag decides how
    // the name parses, not whether a row gets a straight answer.
    expect(() => listGetter(defs)('avg')).toThrow(MissingDataError);
    expect(() => listGetter(defs)('ages')).toThrow(MissingDataError);
    // So a filter over the scalar is refused here exactly as it is there.
    const shape = 'person[…] needs a comparison, like person[person.x > 0].';
    expect(build([...rows, 'avg = mean(person.age)', 'adults = person[avg > 30]'], null)
      .errors.get('adults')).toBe(shape);
  });

  it('points a row that reads a missing file at the file, not at the name', () => {
    // The device has a store, but not this file: rows below must not degrade
    // into "unknown variable person.age".
    const { defs } = build([`person = open("gone.csv", ${HASH})`]);
    expect(() => listGetter(defs)('person.age'))
      .toThrow(/gone\.csv \(a1b2c3d4e5f6\) is not on this device — drop the file here/);
  });
});

describe('naming a column, or arithmetic over one', () => {
  const rows = [`person = open("people.csv", ${HASH})`];

  it('is a list definition, and keeps the typed array', () => {
    // A compact list is still a list: without this the row lands among the
    // scalar constants and is thrown out as "List in scalar context".
    const { defs, errors } = build([...rows, 'half = person.age / 2']);
    expect([...errors]).toEqual([]);
    expect(defs.lists.get('half')).toMatchObject({ kind: 'data' });
    expect([...(defs.lists.get('half') as { values: Float64Array }).values]).toEqual([18, 20.5, 14.5]);
  });

  it('reads back as a list wherever it is used', () => {
    expect(values(lowerRow('half', [...rows, 'half = person.age / 2']))).toEqual([18, 20.5, 14.5]);
    expect(lowerRow('mean(half)', [...rows, 'half = person.age / 2']))
      .toMatchObject({ kind: 'num' });
  });

  it('names a text column too', () => {
    const { defs, errors } = build([...rows, 'who = person.name']);
    expect([...errors]).toEqual([]);
    expect(defs.lists.get('who')).toMatchObject({ kind: 'text' });
  });

  it('names a scatter of two columns, and it is still a scatter', () => {
    // `P = (person.age, person.height)` was read as a named POINT — two
    // scalars — so the columns were stored as its components and the row died
    // with "List in scalar context". The typed-array zip is the whole reason a
    // 200 000-row file draws, and naming it must not spend that.
    const defRows = [...rows, 'P = (person.age, person.height)'];
    const { defs, errors } = build(defRows);
    expect([...errors]).toEqual([]);
    expect(defs.points.has('P')).toBe(false);
    expect(listNamesOf(defs).has('P')).toBe(true);
    const plot = classify(lowerRow('P', defRows), new Set()).plot as
      { type: string; dim: number; coords: Float64Array[] };
    expect(plot.type).toBe('dscatter');
    expect(plot.coords.map(c => [...c])).toEqual([[36, 41, 29], [1.7, 1.82, 1.65]]);
    // An alias of one is one, and three columns still name a 3D cloud.
    expect(classify(lowerRow('Q', [...defRows, 'Q = P']), new Set()).plot.type).toBe('dscatter');
    const c3 = [...rows, 'C = (person.age, person.height, person.age)'];
    expect(classify(lowerRow('C', c3), new Set()).plot).toMatchObject({ type: 'dscatter', dim: 3 });
    // …while a pair of numbers is a named point, exactly as before.
    expect(build(['A = (1, 2)']).defs.points.has('A')).toBe(true);
  });
});

describe('tables and the rest of the definition system', () => {
  it('lets a constant read a reduction of a column', () => {
    const { defs, errors } = build([
      `person = open("people.csv", ${HASH})`,
      'avg = mean(person.age)',
    ]);
    expect([...errors]).toEqual([]);
    expect(evalConstEnv(defs, 0).avg).toBeCloseTo(35.3333, 4);
  });

  it('needs the data row above the rows that use it', () => {
    const { errors } = build([
      'avg = mean(person.age)',
      `person = open("people.csv", ${HASH})`,
    ]);
    expect(errors.get('avg')).toMatch(/person\.age/);
  });

  it('plots a big column whole, and expands it only when it must', () => {
    const big = ['v', ...Array.from({ length: 120_000 }, (_, k) => String(k))].join('\n');
    const rows = [`big = open("big.csv", ${HASH})`];
    const tables = store({ 'big.csv': big });
    expect(build(rows, tables).errors.size).toBe(0);
    // Constant arithmetic stays a typed array however long the column is…
    const col = lowerRow('(big.v, big.v / 2)', rows, tables);
    expect(classify(col, new Set()).plot).toMatchObject({ type: 'dscatter' });
    // …but a slider or t needs one expression per row, and that has a limit.
    expect(() => lowerRow('big.v sin(t)', rows, tables))
      .toThrow(/120000 values; only 100000 can be combined/);
  });
});

describe('rules the file cannot change', () => {
  const rows = [`person = open("people.csv", ${HASH})`];

  // Whether a row is well formed must not depend on whether the bytes are
  // here, or a shared link previews as valid and fails for its author. These
  // are decided by the row alone, so they are settled before the column —
  // which can be absent — is resolved. `null` for tables is the worker.
  it.each([
    ['hist(person.age, 1)', /2 to 500 bins/],
    ['hist(person.age, 0)', /2 to 500 bins/],
    ['hist(person.age, 501)', /2 to 500 bins/],
    ['hist(person.age, 2.5)', /whole number of bins/],
    ['hist(person.age, 4, 9)', /a list and, optionally, a number of bins/],
  ])('refuses %s with and without the file', (row, message) => {
    expect(() => lowerRow(row, rows)).toThrow(message);
    expect(() => lowerRow(row, rows, null)).toThrow(message);
  });

  it('still draws a well-formed hist, and still defers to the file for it', () => {
    expect(classify(lowerRow('hist(person.age, 3)', rows)).plot.type).toBe('histogram');
    // Without the bytes the row is not wrong — it just cannot be drawn here.
    expect(() => lowerRow('hist(person.age, 3)', rows, null)).toThrow(MissingDataError);
  });
});

describe('text column character counts', () => {
  const rows = ['p = open("p.csv")'];
  const tables = store({ 'p.csv': 'name,age,length\nAda,36,short\n😀é,41,longer\n,29,NA\n' });

  it('plots one Unicode code-point count per row, preserving missing cells', () => {
    const e = lowerRow('p.name.length', rows, tables);
    expect(values(e)).toEqual([3, 2, NaN]);
    expect(classify(e).plot.type).toBe('dlist');
    expect(lowerRow('p.name.length[2]', rows, tables)).toEqual({ kind: 'num', value: 2 });
    expect(values(lowerRow('p.length.length', rows, tables))).toEqual([5, 6, NaN]);
  });

  it('supports arithmetic, reductions, named lists, and histograms', () => {
    expect(values(lowerRow('p.name.length * 2', rows, tables))).toEqual([6, 4, NaN]);
    expect(lowerRow('mean(p.name.length)', rows, tables)).toEqual({ kind: 'num', value: 2.5 });
    expect(values(lowerRow('sizes', [...rows, 'sizes = p.name.length'], tables))).toEqual([3, 2, NaN]);
    const plot = classify(lowerRow('hist(p.name.length, 2)', rows, tables)).plot;
    expect(plot.type).toBe('histogram');
    if (plot.type === 'histogram') expect([...plot.counts]).toEqual([1, 1]);
  });

  it('filters columns and whole tables by character count', () => {
    expect(values(lowerRow('p.age[p.name.length > 2]', rows, tables))).toEqual([36]);
    const filtered = [...rows, 'long_names = p[p.name.length > 2]'];
    expect(values(lowerRow('long_names.name.length', filtered, tables))).toEqual([3]);
  });

  it('reports missing files and rejects numeric column lengths', () => {
    expect(() => lowerRow('p.name.length', rows, null)).toThrow(MissingDataError);
    const missing = build([...rows, 'sizes = p.name.length'], null);
    expect(missing.defs.missingData.get('sizes')?.list).toBe(true);
    expect(() => lowerRow('p.age.length', rows, tables)).toThrow(/numeric column/);
    expect(() => lowerRow('p.unknown.length', rows, tables)).toThrow(/no column "unknown"/);
  });

  it('reuses the derived array until the parsed column changes', () => {
    const { defs } = build(rows, tables);
    const get = listGetter(defs);
    const first = get('p.name.length');
    const second = get('p.name.length');
    expect(first?.kind).toBe('data');
    if (first?.kind === 'data' && second?.kind === 'data') expect(first.values).toBe(second.values);
  });
});

describe('columns named after functions', () => {
  it.each(['sin', 'mean', 'Sin'])('multiplies the %s column before parentheses', name => {
    const rows = ['p = open("p.csv")'];
    const tables = store({ 'p.csv': `${name},a\n1,2\n3,4\n` });
    expect(values(lowerRow(`p.${name}(2+1)`, rows, tables))).toEqual([3, 9]);
    expect(lowerRow(`p.${name}[2]`, rows, tables)).toEqual({ kind: 'num', value: 3 });
  });
});

describe('text in arithmetic', () => {
  const rows = [`person = open("people.csv", ${HASH})`];

  // The text may be the scalar being broadcast rather than the list: asking
  // only the lists let this build a list of number-plus-text elements that
  // classified fine and then drew nothing.
  it.each(['person.age + "NYC"', '"NYC" + person.age', 'person.age * "x"'])(
    'refuses %s, as it does every other spelling',
    row => expect(() => lowerRow(row, rows)).toThrow(/Text has no numeric value/),
  );

  it('leaves comparisons alone — that is what text is for', () => {
    expect(values(lowerRow('person.age[person.name == "ada"]', rows))).toEqual([36]);
    expect(values(lowerRow('person.age + 1', rows))).toEqual([37, 42, 30]);
  });
});
