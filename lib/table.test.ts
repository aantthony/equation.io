import { describe, expect, it } from 'vitest';
import { parseCsv } from './csv.ts';
import {
  MissingDataError,
  badTableName,
  type TableSource,
  buildDefs,
  evalConstEnv,
  formatTableRow,
  listGetter,
  listNamesOf,
  resolveExpr,
  scanDefinition,
} from './defs.ts';
import { type Expr, evaluate, parseExpr } from './expr.ts';
import { lowerGeom } from './geom.ts';
import { lowerLists } from './list.ts';
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
  const e = resolveExpr(
    parseExpr(text, new Set(defs.fns.keys()), listNamesOf(defs)),
    n => defs.fns.get(n),
    { consts },
  );
  return lowerLists(lowerGeom(e, () => null, () => null), listGetter(defs), { consts });
}

const values = (e: Expr): number[] => {
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

  it('reserves the name open', () => {
    expect(scanDefinition('open = 2')).toBeNull();
    expect(scanDefinition('open(f) = f')).toBeNull();
  });

  it('says so when the row claims a built-in name', () => {
    // `w` is the 4th coordinate, so this row is not a definition at all — but
    // the reason has to be the name, not "quotes are not arithmetic".
    expect(badTableName('w = open("wave.csv")')).toMatch(/w is a built-in name/);
    expect(badTableName(`person = open("people.csv", ${HASH})`)).toBeNull();
    expect(badTableName('y = sin(x)')).toBeNull();
  });

  it('round-trips through the row text the app writes', () => {
    const text = formatTableRow('person', 'people.csv', 'a1b2c3d4e5f6789');
    expect(text).toBe(`person = open("people.csv", ${HASH})`);
    expect(scanDefinition(text)).toMatchObject({ name: 'person', hash: HASH });
  });

  it('registers the file and its columns', () => {
    const { defs, errors } = build([`person = open("people.csv", ${HASH})`]);
    expect([...errors]).toEqual([]);
    const t = defs.tables.get('person')!;
    expect(t.file).toBe('people.csv');
    expect(t.data!.rows).toBe(3);
    expect([...listNamesOf(defs)]).toEqual(['person.name', 'person.age', 'person.height']);
  });

  it('reports a file this device does not have', () => {
    const { errors } = build([`person = open("nope.csv", ${HASH})`]);
    expect(errors.get('person')).toMatch(/nope\.csv \(a1b2c3d4e5f6\) is not on this device/);
  });
});

describe('columns as lists', () => {
  const rows = [`person = open("people.csv", ${HASH})`];

  it('reads a column under its dotted name', () => {
    expect(values(lowerRow('person.age', rows))).toEqual([36, 41, 29]);
  });

  it('broadcasts and zips columns into a scatter', () => {
    expect(values(lowerRow('person.age / 2', rows))).toEqual([18, 20.5, 14.5]);
    const pts = lowerRow('(person.age, person.height)', rows);
    expect(classify(pts, new Set()).plot).toMatchObject({ type: 'plist', dim: 2 });
    expect((pts as Expr & { kind: 'list' }).items.map(p => evaluate((p as Expr & { kind: 'vec' }).items[1], {})))
      .toEqual([1.7, 1.82, 1.65]);
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

  it('refuses a text column, for now', () => {
    expect(() => lowerRow('person.name', rows)).toThrow(/holds text, not numbers/);
  });

  it('leaves a dot on anything else alone', () => {
    // A dotted name with no table behind it is just a name.
    expect(lowerRow('foo.bar', rows)).toEqual({ kind: 'var', name: 'foo.bar' });
    expect(evaluate(lowerRow('x.y', []), { 'x.y': 7 })).toBe(7);
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

  it('points a row that reads a missing file at the file, not at the name', () => {
    // The device has a store, but not this file: rows below must not degrade
    // into "unknown variable person.age".
    const { defs } = build([`person = open("gone.csv", ${HASH})`]);
    expect(() => listGetter(defs)('person.age'))
      .toThrow(/gone\.csv \(a1b2c3d4e5f6\) is not on this device — drop the file here/);
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

  it('caps how much data one row expands to', () => {
    const big = ['v', ...Array.from({ length: 6000 }, (_, k) => String(k))].join('\n');
    const rows = [`big = open("big.csv", ${HASH})`];
    const tables = store({ 'big.csv': big });
    expect(build(rows, tables).errors.size).toBe(0); // the file itself is fine
    expect(() => lowerRow('big.v', rows, tables)).toThrow(/6000 rows; plotting is limited to 5000/);
  });
});
