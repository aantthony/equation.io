/**
 * CSV/TSV parsing, with no dependencies (see docs/lists-tables-plan.md).
 *
 * RFC 4180 for the grammar — quoted fields, "" escapes, embedded commas and
 * newlines, CRLF — plus the pragmatics real files need: a UTF-8 BOM, a
 * delimiter that might be ';' or a tab, header names that have to become
 * identifiers, and cells that are blank or spell "N/A".
 *
 * The result is columnar, because that is how the app uses it: a column is a
 * list, and `(person.age, person.height)` zips two of them. Nothing here
 * knows about expressions — defs.ts turns a numeric column into list elements.
 */
import { CONSTANTS } from './expr.ts';

export type ColumnType = 'num' | 'str';

export interface Column {
  /** Identifier used in expressions: `person.age`. */
  name: string;
  /** The header cell as written, for display. */
  label: string;
  type: ColumnType;
  /** type 'num': one value per row; a missing cell is NaN. */
  nums?: Float64Array;
  /** type 'str': one value per row; a missing cell is ''. */
  strs?: string[];
}

export interface Table {
  columns: Column[];
  /** Data rows (the header is not one). */
  rows: number;
  /** Records dropped for having a different field count than the header. */
  skipped: number;
  /** Missing/unparsable cells in numeric columns, by column name. */
  missing: Map<string, number>;
  /** The delimiter that was sniffed. */
  delimiter: string;
  /** Human-readable notes: skipped rows, renamed columns, missing cells. */
  warnings: string[];
}

/** Delimiters we sniff for, in preference order on a tie. */
const DELIMITERS = [',', '\t', ';'];

/** Cells that mean "no value" rather than a string (case-insensitive). */
const BLANKS = new Set(['', 'na', 'n/a', 'nan', 'null', 'nil', 'none', '-', '--', '?']);

/**
 * Pick the delimiter by counting candidates outside quotes in the first few
 * lines. The header alone can mislead (a single column named "a, b"), so the
 * count that wins is the one that is both largest and *consistent* across the
 * sampled lines — a real delimiter appears the same number of times in every
 * record.
 */
export function sniffDelimiter(text: string): string {
  const SAMPLE = 5;
  const perLine = new Map<string, number[]>(DELIMITERS.map(d => [d, [0]]));
  let inQuotes = false;
  let lines = 1;
  for (let i = 0; i < text.length && lines <= SAMPLE; i++) {
    const c = text[i];
    if (c === '"') {
      // A doubled quote inside a quoted field is an escape, not a toggle.
      if (inQuotes && text[i + 1] === '"') i++;
      else inQuotes = !inQuotes;
      continue;
    }
    if (inQuotes) continue;
    if (c === '\n') {
      lines++;
      for (const d of DELIMITERS) perLine.get(d)!.push(0);
      continue;
    }
    const row = perLine.get(c);
    if (row) row[row.length - 1]++;
  }
  let best = ',';
  let bestScore = 0;
  for (const d of DELIMITERS) {
    // The final sampled line may be cut short, so judge on complete ones.
    const seen = perLine.get(d)!;
    const full = seen.length > 1 ? seen.slice(0, -1) : seen;
    if (!full[0]) continue;
    // A real delimiter appears the same number of times in every record.
    const score = full[0] * (full.every(n => n === full[0]) ? 2 : 1);
    if (score > bestScore) {
      bestScore = score;
      best = d;
    }
  }
  return best;
}

/**
 * Split text into records of fields (RFC 4180). Blank lines are dropped.
 *
 * `warnings` collects what the grammar had to paper over — today only a
 * quoted field that never closes, which swallows the rest of the file into
 * one cell. That is nearly always a truncated download, and it is the one
 * malformation the parser cannot make obvious by itself.
 */
export function parseRecords(text: string, delimiter: string, warnings?: string[]): string[][] {
  const out: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let started = false; // this record has at least one field
  const endField = () => {
    row.push(field);
    field = '';
    started = true;
  };
  const endRow = () => {
    if (started) {
      row.push(field);
      // A line of nothing but the delimiter's absence (one empty field) is blank.
      if (!(row.length === 1 && row[0].trim() === '')) out.push(row);
    }
    row = [];
    field = '';
    started = false;
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        field += c;
      }
      continue;
    }
    if (c === '"' && field.trim() === '') {
      // Only a field that has not started yet opens a quote; a stray quote
      // mid-field is data ('5" pipe').
      field = '';
      quoted = true;
      started = true;
      continue;
    }
    if (c === delimiter) {
      endField();
      continue;
    }
    if (c === '\r') continue;
    if (c === '\n') {
      endRow();
      continue;
    }
    field += c;
    started = true;
  }
  if (quoted) {
    warnings?.push('a quoted field never closed — the rest of the file was read as one cell');
  }
  endRow();
  return out;
}

/** Turn a header cell into an identifier usable after a dot. */
function toIdent(label: string, index: number): string {
  let name = label.trim().replace(/[^A-Za-z0-9_]+/g, '_').replace(/^_+|_+$/g, '');
  if (!name) name = `col${index + 1}`;
  if (/^\d/.test(name)) name = `c${name}`;
  // `people.e` would read the constant e, not a column, so nudge the name.
  if (name in CONSTANTS) name += '_';
  return name;
}

const isBlankCell = (s: string): boolean => BLANKS.has(s.trim().toLowerCase());

/** Numeric reading of a cell, or NaN. Accepts a leading '+', thousands
 *  separators, and a trailing '%' (scaled), which real exports are full of. */
export function cellNumber(s: string): number {
  let t = s.trim();
  if (!t) return NaN;
  let scale = 1;
  if (t.endsWith('%')) {
    scale = 0.01;
    t = t.slice(0, -1).trim();
  }
  if (/^[+-]?\d{1,3}(,\d{3})+(\.\d+)?$/.test(t)) t = t.replace(/,/g, '');
  if (!/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(t)) return NaN;
  return Number(t) * scale;
}

/**
 * Parse a CSV document. The first record is the header; every later record
 * with the header's field count becomes a row. A column whose non-blank cells
 * all read as numbers is numeric (blanks become NaN); everything else is text.
 */
export function parseCsv(text: string): Table {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const delimiter = sniffDelimiter(text);
  const warnings: string[] = [];
  const records = parseRecords(text, delimiter, warnings);
  if (!records.length) throw new Error('That file has no rows.');
  const header = records[0];

  const names: string[] = [];
  const used = new Set<string>();
  let renamed = 0;
  header.forEach((label, k) => {
    const base = toIdent(label, k);
    let name = base;
    for (let n = 2; used.has(name); n++) name = `${base}_${n}`;
    used.add(name);
    if (name !== label.trim()) renamed++;
    names.push(name);
  });
  if (renamed) {
    warnings.push(`${renamed} column name${renamed === 1 ? '' : 's'} adjusted to fit expressions`);
  }

  const body: string[][] = [];
  let skipped = 0;
  for (let r = 1; r < records.length; r++) {
    if (records[r].length !== header.length) {
      skipped++;
      continue;
    }
    body.push(records[r]);
  }
  if (skipped) {
    warnings.push(`${skipped} row${skipped === 1 ? '' : 's'} skipped (wrong number of columns)`);
  }

  const missing = new Map<string, number>();
  const columns: Column[] = names.map((name, c) => {
    const cells = body.map(row => row[c]);
    let numeric = cells.length > 0;
    let seen = 0;
    for (const cell of cells) {
      if (isBlankCell(cell)) continue;
      seen++;
      if (Number.isNaN(cellNumber(cell))) {
        numeric = false;
        break;
      }
    }
    if (!seen) numeric = false; // an all-blank column is text, not a run of NaN
    if (!numeric) return { name, label: header[c].trim(), type: 'str', strs: cells.map(s => s.trim()) };
    const nums = new Float64Array(cells.length);
    let gaps = 0;
    cells.forEach((cell, k) => {
      const v = isBlankCell(cell) ? NaN : cellNumber(cell);
      if (Number.isNaN(v)) gaps++;
      nums[k] = v;
    });
    if (gaps) missing.set(name, gaps);
    return { name, label: header[c].trim(), type: 'num', nums };
  });

  const gaps = [...missing.entries()];
  if (gaps.length) {
    const total = gaps.reduce((a, [, n]) => a + n, 0);
    warnings.push(`${total} missing value${total === 1 ? '' : 's'} in ${gaps.map(([n]) => n).join(', ')}`);
  }

  return { columns, rows: body.length, skipped, missing, delimiter, warnings };
}

/**
 * A table of the rows a mask keeps — `adults = person[person.age >= 18]`.
 * Every column is filtered together, so the rows stay aligned; missing-value
 * counts are recomputed, because dropping rows drops gaps with them.
 */
export function filterTable(table: Table, keep: readonly boolean[]): Table {
  const rows = keep.reduce((n, k) => n + (k ? 1 : 0), 0);
  const missing = new Map<string, number>();
  const columns = table.columns.map((col): Column => {
    if (col.type === 'str') {
      return { ...col, strs: col.strs!.filter((_, k) => keep[k]) };
    }
    const nums = new Float64Array(rows);
    let at = 0;
    let gaps = 0;
    col.nums!.forEach((v, k) => {
      if (!keep[k]) return;
      if (Number.isNaN(v)) gaps++;
      nums[at++] = v;
    });
    if (gaps) missing.set(col.name, gaps);
    return { ...col, nums };
  });
  const warnings = missing.size
    ? [`${[...missing.values()].reduce((a, b) => a + b, 0)} missing values in ${[...missing.keys()].join(', ')}`]
    : [];
  return { columns, rows, skipped: 0, missing, delimiter: table.delimiter, warnings };
}

/** Suggest a row name from a file name: "people 2024.csv" → "people_2024". */
export function tableNameFor(fileName: string): string {
  const stem = fileName.replace(/\.[^.]*$/, '').trim();
  const bare = stem.replace(/[^A-Za-z0-9_]+/g, '_').replace(/^_+|_+$/g, '');
  if (!bare) return 'data';
  // Identifiers cannot start with a digit ("2024.csv" → data_2024).
  return /^\d/.test(bare) ? `data_${bare}` : bare;
}
