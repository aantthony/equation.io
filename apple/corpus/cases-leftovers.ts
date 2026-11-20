/**
 * Targeted documents for the corners other kinds left: state families,
 * orbits in space, and what the language no longer has (a panel's metric and
 * its rows, which now read as any other row does). apple/corpus/analysis.ts
 * runs them with its own. Also here: what lib/csv.ts and lib/hash.ts make of
 * data files. One concern each, rows separated as the examples' are.
 */
import {
  cellNumber,
  filterTable,
  parseCsv,
  parseRecords,
  positionColumn,
  sniffDelimiter,
  type Table,
  tableNameFor,
} from '../../lib/csv.ts';
import { shortHash } from '../../lib/hash.ts';

export const LEFTOVER_CASES: string[] = [
  // Rows of the metrics the language had: an equation in ds, unknown names.
  'ds^2 = dx^2 + dy^2; y = x',
  'ds^2 = (dx^2 + dy^2)/y^2; geodesic((0, 1), (1, 0)); lightray((0, 1), (1, 0))',
  'ds² = -dy^2 + dx^2; lightcones; lightcone((1, 2)); tidal; tidal((1, 2))',
  'ds = 3; ds^2 = 9; ds^2; ds^2 = ; ds^2 < dx^2',
  'geodesic(P, d) = P + d; geodesic(1, 2); lightcones = 3; lightcones; tidal = 2; tidal',
  'geodesic((0, 1)); lightray((0, 1)); lightcone(); tidal(1, 2); geodesic(1)',
  'ds^2 = 4(dx^2 + dy^2)/(1 - x^2 - y^2)^2; gaussian(x, y); x^2 + y^2 = 1; -gaussian(x, y); gaussian((0, 0))',
  // State families: a list of starting values is a run each.
  "th' = om; om' = -sin(th); th(0) = [1..12]/4; (th, om); th; om; th[2]; mean(th)",
  "p' = (10(p_2 - p_1), p_1(28 - p_3) - p_2, p_1 p_2 - 8 p_3/3); p(0) = (sort([0..9])/10, 1, 20); p; p[1]; p_1",
  "a' = -a; a(0) = [1, 2, 3]; a; 2 a; y = a x; E = a^2/2; E; (t, a)",
  "r' = v; v' = -r; r(0) = [(1, 0), (0, 2)]; r; v; segment((0, 0), r); f = r_1 + v_2; f",
  "a' = -b; b' = a; a(0) = [1, 2]; b(0) = [0, 1, 2]; a; b",
  "a' = -b; b' = a; a(0) = [1, 2]; b(0) = [3, 4]; (a, b); c' = 1; c; c(0) = 2",
  "a' = -a; a(0) = []; a(0) = 2; b' = b; b(0) = [(1, 2)]; q' = (q_2, -q_1); q(0) = [1, 2]",
  "a' = -a; a(0) = [0..2000]; b' = -b; b(0) = [1, 2] x; c' = [1, 2] c; c(0) = 1",
  "k = [1, 2]; a' = -a; a(0) = k; a; P = (a, 1); P; s = 2; b' = s a; b",
  "a' = -a; a(0) = (1, 2, 3)/2; a; a[2]; a(0..3); trail((a, t))",
  // Orbits in space.
  "p' = (10(p_2 - p_1), p_1(28 - p_3) - p_2, p_1 p_2 - 8 p_3/3); p(0) = (1, 1, 20); p(0..5); p_1(0..5); (p_1, p_2)(0..3)",
  "a' = -b; b' = a; a(0) = 1; (a, b, t)(0..6); (a, b, a b)(0..2); (a, b, x)(0..2); (a, b, 1)(3..1)",
];

const text = (v: number) => String(v);

// --- data files (lib/csv.ts, lib/hash.ts) ---

/** Files as text: what a parser of real exports meets. */
const CSV_FILES: string[] = [
  'name,age,height\nAda,36,1.7\nBob,41,1.82\nCy,,1.6\n',
  'a,b\n1,2\n3,4',
  '﻿x;y\n1,5;2\n2,5;3\n',
  'x\ty\n1.234\t2\n5.5\t3\n',
  'x;y\n1.234,5;2\n1.500;3\n',
  'Sales report\nregion\tunits\nnorth\t1,200\nsouth\t950\n',
  'Sales, report\nregion;units\nnorth;12\nsouth;9\n',
  'notes, with, commas;value\nfirst, second;1\nthird;2\n',
  '"a, b",c\n"1,5",2\n"say ""hi""",3\n',
  'a,b\n1,2,3\n4,5\n6\n\n7,8\n',
  'a,a,a,e,pi,2nd, ,x y,constructor,toString\n1,2,3,4,5,6,7,8,9,10\n',
  'p,q\n50%,+3\n12.5 %,-4e2\n,.5\nN/A,5.\n',
  'v\n1,000\n2,500,000\n3,5\n',
  'v\n1e5\n0x10\n1_000\n٣\n',
  't,n\n-,?\nnull,--\nNaN,none\n',
  'a,b\n,\n"",x\n   \n1,y\n',
  'a,b\r\n1,2\r\n3,4\r\n',
  'a,b\n"multi\nline",2\n5" pipe,3\n',
  'only\n',
  'a\n1\n2\nx\n',
  'row,row_index\n1,2\n',
  '',
  '\n\n',
  'a,b\n"open,2\n',
  'x,y\n 1 , 2 \n3,"4"\n',
  'a;b;c\n1;2;3\n4;5;6\n7;8;9\n10;11;12\n13;14;15\n16,5;17;18\n',
  'd\n1.234.567,89\n2,5\n',
  'x;y\n1.234.567,89;1\n12,5%;2\n',
  'ß,naïve,日本\n1,2,3\n',
];

const FILE_NAMES = ['people 2024.csv', '2024.csv', '.csv', 'a.b.tsv', 'data', '  spaced name .txt', '___.csv', 'é.csv'];

const HASHED = [
  '',
  'abc',
  'a,b\n1,2\n',
  'x'.repeat(55),
  'x'.repeat(56),
  'x'.repeat(64),
  'x'.repeat(1000),
  'héllo 日本',
];

const CELLS = [
  '1',
  ' 2.5 ',
  '+3',
  '-4e2',
  '.5',
  '5.',
  '1,000',
  '1,00',
  '12%',
  '1.234,5',
  '1,5',
  'x',
  '',
  '1e',
  '--1',
  '1.2.3',
  '1 000',
  '٣',
  '0x10',
  'Infinity',
];

/** What lib/csv.ts makes of each file, a cut of it, and the hashes rows pin files by. */
export function recordData(sha256: (bytes: Uint8Array) => string): unknown {
  const nums = (values: ArrayLike<number> | undefined) => values && Array.from(values, text);
  const record = (table: Table) => ({
    columns: table.columns.map(c => ({ name: c.name, label: c.label, type: c.type, nums: nums(c.nums), strs: c.strs })),
    rows: table.rows,
    skipped: table.skipped,
    missing: [...table.missing],
    delimiter: table.delimiter,
    warnings: table.warnings,
    positions: nums(table.positions) ?? null,
    positionColumn: positionColumn(table),
  });
  return {
    files: CSV_FILES.map(file => {
      try {
        const table = parseCsv(file);
        const keep = Array.from({ length: table.rows }, (_, k) => k % 2 === 0);
        return {
          file,
          sniffed: sniffDelimiter(file),
          records: parseRecords(file, ','),
          table: record(table),
          cut: record(filterTable(table, keep)),
        };
      } catch (err) {
        return { file, sniffed: sniffDelimiter(file), error: (err as Error).message };
      }
    }),
    cells: CELLS.map(cell => ({ cell, plain: text(cellNumber(cell)), comma: text(cellNumber(cell, true)) })),
    names: FILE_NAMES.map(file => ({ file, name: tableNameFor(file) })),
    hashes: HASHED.map(content => {
      const hex = sha256(new TextEncoder().encode(content));
      return { content, hex, short: shortHash(hex) };
    }),
  };
}
