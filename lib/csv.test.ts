import { describe, expect, it } from 'vitest';
import { cellNumber, filterTable, parseCsv, parseRecords, sniffDelimiter, tableNameFor } from './csv.ts';

const col = (t: ReturnType<typeof parseCsv>, name: string) => t.columns.find(c => c.name === name)!;
const nums = (t: ReturnType<typeof parseCsv>, name: string) => [...col(t, name).nums!];

describe('record grammar (RFC 4180)', () => {
  it('reads quoted fields with commas, quotes, and newlines', () => {
    const recs = parseRecords('a,b\n"x, y","he said ""hi"""\n"two\nlines",2', ',');
    expect(recs).toEqual([
      ['a', 'b'],
      ['x, y', 'he said "hi"'],
      ['two\nlines', '2'],
    ]);
  });

  it('handles CRLF and a trailing newline', () => {
    expect(parseRecords('a,b\r\n1,2\r\n', ',')).toEqual([['a', 'b'], ['1', '2']]);
  });

  it('keeps empty fields and drops blank lines', () => {
    expect(parseRecords('a,b,c\n1,,3\n\n4,5,6\n', ',')).toEqual([
      ['a', 'b', 'c'], ['1', '', '3'], ['4', '5', '6'],
    ]);
  });

  it('treats a quote inside a started field as data', () => {
    expect(parseRecords('size\n5" pipe\n', ',')).toEqual([['size'], ['5" pipe']]);
  });

  it('scores the last record when the file has no trailing newline', () => {
    // Dropping it unconditionally left a two-line file judged on its header
    // alone, where a comma inside a title beats the real delimiter.
    expect(sniffDelimiter('coords(x,y);value\na;2')).toBe(';');
    expect(parseCsv('coords(x,y);value\na;2').columns.map(c => c.name)).toEqual(['coords_x_y', 'value']);
    // A trailing newline still leaves an empty counter that must not score.
    expect(sniffDelimiter('a;b\n1;2\n')).toBe(';');
    expect(sniffDelimiter('a,b\n1,2\n')).toBe(',');
  });

  it('keeps a record written as an empty quoted field', () => {
    // `""` is a deliberate empty value; only a line with no syntax at all is
    // a blank line. Dropping it lost a row and a missing value with it.
    expect(parseRecords('v\n""\n1\n', ',')).toEqual([['v'], [''], ['1']]);
    expect(parseCsv('v\n""\n1\n').rows).toBe(2);
    // Truly blank lines are still dropped.
    expect(parseRecords('a\n1\n\n2\n', ',')).toEqual([['a'], ['1'], ['2']]);
    expect(parseRecords('a\n1\n   \n2\n', ',')).toEqual([['a'], ['1'], ['2']]);
  });

  it('refuses a quoted field that never closes', () => {
    // The rest of the file would become one cell, so every row after the
    // stray quote is silently wrong — the file is nearly always truncated.
    expect(() => parseRecords('a,b\n1,"oops\n2,3\n', ',')).toThrow(/never closed/);
    expect(() => parseCsv('a,b\n1,"oops\n2,3\n')).toThrow(/looks truncated/);
    // A quote that opens and closes is still ordinary data.
    expect(parseRecords('a,b\n1,"ok\nthen"\n', ',')).toEqual([['a', 'b'], ['1', 'ok\nthen']]);
  });
});

describe('delimiter sniffing', () => {
  it('picks the delimiter that appears consistently', () => {
    expect(sniffDelimiter('a,b,c\n1,2,3\n')).toBe(',');
    expect(sniffDelimiter('a;b;c\n1;2;3\n')).toBe(';');
    // Consistency outranks sheer count: the prose commas here outnumber the
    // ';' that separates the fields, but they do not line up — and choosing
    // them threw every data row away as ragged.
    expect(sniffDelimiter('notes, with, commas;value\na;2')).toBe(';');
    const t = parseCsv('notes, with, commas;value\na;2');
    expect(t.rows).toBe(1);
    expect(t.columns.map(c => c.name)).toEqual(['notes_with_commas', 'value']);
    expect(sniffDelimiter('a\tb\tc\n1\t2\t3\n')).toBe('\t');
  });

  it('ignores separators inside quotes', () => {
    expect(sniffDelimiter('name;value\n"a,b,c,d,e";2\n')).toBe(';');
  });

  it('falls back to a comma with nothing to go on', () => {
    expect(sniffDelimiter('single\n1\n')).toBe(',');
  });
});

describe('cell numbers', () => {
  it('reads plain, signed, and exponent forms', () => {
    expect(cellNumber(' 42 ')).toBe(42);
    expect(cellNumber('-3.5')).toBe(-3.5);
    expect(cellNumber('+.5')).toBe(0.5);
    expect(cellNumber('1e3')).toBe(1000);
  });

  it('reads thousands separators and percentages', () => {
    expect(cellNumber('1,234,567')).toBe(1234567);
    expect(cellNumber('12.5%')).toBe(0.125);
  });

  it('refuses anything else', () => {
    expect(cellNumber('12px')).toBeNaN();
    expect(cellNumber('1,23')).toBeNaN();
    expect(cellNumber('')).toBeNaN();
  });
});

describe('parseCsv', () => {
  const people = 'name,age,height\nada,36,1.7\nbob,41,1.82\ncy,29,1.65\n';

  it('splits into typed columns', () => {
    const t = parseCsv(people);
    expect(t.rows).toBe(3);
    expect(t.columns.map(c => [c.name, c.type])).toEqual([
      ['name', 'str'], ['age', 'num'], ['height', 'num'],
    ]);
    expect(nums(t, 'age')).toEqual([36, 41, 29]);
    expect(col(t, 'name').strs).toEqual(['ada', 'bob', 'cy']);
    expect(t.warnings).toEqual([]);
  });

  it('strips a UTF-8 BOM from the first header', () => {
    expect(parseCsv('﻿name,age\nada,36\n').columns[0].name).toBe('name');
  });

  it('makes header cells into identifiers, keeping the original label', () => {
    const t = parseCsv('Full Name,3rd try,,e,Full Name\na,1,2,3,b\n');
    expect(t.columns.map(c => c.name)).toEqual(['Full_Name', 'c3rd_try', 'col3', 'e_', 'Full_Name_2']);
    expect(t.columns[0].label).toBe('Full Name');
    expect(t.warnings[0]).toMatch(/column names adjusted/);
  });

  it('skips rows with the wrong field count, and says how many', () => {
    const t = parseCsv('a,b\n1,2\n3\n4,5,6\n7,8\n');
    expect(t.rows).toBe(2);
    expect(t.skipped).toBe(2);
    expect(t.warnings.some(w => /2 rows skipped/.test(w))).toBe(true);
  });

  it('treats blanks and NA markers as missing, keeping the column numeric', () => {
    // The empty line is a blank line, not a row of one missing value.
    const t = parseCsv('v\n1\n\nNA\nn/a\n4\n');
    expect(nums(t, 'v')).toEqual([1, NaN, NaN, 4]);
    expect(t.missing.get('v')).toBe(2);
    expect(t.warnings.some(w => /2 missing values in v/.test(w))).toBe(true);
    // Inside a wider row an empty cell is a real gap.
    expect(nums(parseCsv('u,v\n1,\n2,7\n'), 'v')).toEqual([NaN, 7]);
  });

  it('calls a column with any real text a text column', () => {
    const t = parseCsv('v\n1\ntwo\n3\n');
    expect(col(t, 'v').type).toBe('str');
    // An all-blank column is text too: a run of NaN is not data.
    expect(col(parseCsv('v\n\n\n'), 'v').type).toBe('str');
  });

  it('reads a semicolon file with quoted commas', () => {
    const t = parseCsv('city;pop\n"Paris, FR";2148000\n"Lyon, FR";513275\n');
    expect(t.delimiter).toBe(';');
    expect(col(t, 'city').strs).toEqual(['Paris, FR', 'Lyon, FR']);
    expect(nums(t, 'pop')).toEqual([2148000, 513275]);
  });

  it('refuses an empty document', () => {
    expect(() => parseCsv('')).toThrow(/no rows/);
  });

  it('reads a header-only file as an empty table', () => {
    const t = parseCsv('a,b\n');
    expect(t.rows).toBe(0);
    expect(t.columns.map(c => c.type)).toEqual(['str', 'str']);
  });
});

describe('filterTable', () => {
  it('recounts gaps in text columns as well as numeric ones', () => {
    const t = parseCsv('city,pop\nNYC,10\n,20\nOslo,\n');
    const all = filterTable(t, [true, true, true]);
    expect(all.missing.get('city')).toBe(1);
    expect(all.missing.get('pop')).toBe(1);
    expect(all.warnings[0]).toMatch(/2 missing values/);
    // …and forgets the ones the cut removed.
    const cut = filterTable(t, [true, false, false]);
    expect([...cut.missing]).toEqual([]);
    expect(cut.warnings).toEqual([]);
  });
});

describe('tableNameFor', () => {
  it('turns a file name into a row name', () => {
    expect(tableNameFor('people.csv')).toBe('people');
    expect(tableNameFor('sales 2024.tsv')).toBe('sales_2024');
    expect(tableNameFor('2024.csv')).toBe('data_2024');
    expect(tableNameFor('---.csv')).toBe('data');
  });
});
