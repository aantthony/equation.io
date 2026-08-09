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
  let i = 0;
  for (; i < text.length && lines <= SAMPLE; i++) {
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
  // The last counter is worth nothing when it is the empty row after a
  // trailing newline, or a record the sample limit cut in half — but a file
  // with no trailing newline ends on a REAL record, and dropping that one
  // left a two-line file judged on its header alone.
  const partial = i < text.length || text.endsWith('\n');
  const pick = (skipFirst: boolean): string | null => {
    let best: string | null = null;
    let bestCount = 0;
    let bestEven = false;
    for (const d of DELIMITERS) {
      const seen = perLine.get(d)!;
      const sampled = partial && seen.length > 1 ? seen.slice(0, -1) : seen;
      const full = skipFirst ? sampled.slice(1) : sampled;
      if (!full[0]) continue;
      // A real delimiter appears the same number of times in every record, and
      // that outranks appearing often: in `notes, with, commas;value` the prose
      // commas outnumber the ';' that actually separates the fields, but they
      // do not line up, and choosing them throws every data row away as ragged.
      // Count decides only among candidates that are equally (in)consistent.
      const even = full.every(n => n === full[0]);
      if (best === null || (even === bestEven ? full[0] > bestCount : even)) {
        best = d;
        bestCount = full[0];
        bestEven = even;
      }
    }
    return best;
  };
  // Nothing separates anything on line 1, but the lines below are a table:
  // that line is a title, not a record ("Sales report" over a tab-separated
  // export, as spreadsheets write). Judging the file by it threw the real
  // delimiter away and fell back to ',', which made the whole file ONE text
  // column — silently, since a single field per line is never ragged. Only a
  // fallback, so a file whose header simply lacks the delimiter its rows use
  // is still read by its rows, and a file that HAS an answer keeps it.
  return pick(false) ?? pick(true) ?? ',';
}

/**
 * Split text into records of fields (RFC 4180). Blank lines are dropped.
 *
 * A quoted field that never closes swallows the rest of the file into one
 * cell, so it is refused rather than parsed: the file is nearly always
 * truncated, and every row after the stray quote would be silently wrong.
 */
export function parseRecords(text: string, delimiter: string): string[][] {
  const out: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let started = false; // this record has at least one field
  let explicit = false; // …written as syntax: a quote or a delimiter
  const endField = () => {
    row.push(field);
    field = '';
    started = true;
    explicit = true;
  };
  const endRow = () => {
    if (started) {
      row.push(field);
      // A line holding nothing is blank and dropped — but `""` is a record of
      // one empty field, written deliberately, and so is anything with a
      // delimiter in it. Only whitespace with no syntax at all is nothing.
      if (explicit || !(row.length === 1 && row[0].trim() === '')) out.push(row);
    }
    row = [];
    field = '';
    started = false;
    explicit = false;
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
      explicit = true;
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
    throw new Error('A quoted field never closed — the file looks truncated.');
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

/**
 * Numeric reading of a cell, or NaN. Accepts a leading '+', thousands
 * separators, and a trailing '%' (scaled), which real exports are full of.
 *
 * `decimalComma` says the file writes 1,5 for one and a half: what a comma
 * means cannot be read off the cell, only off the file, and reading `1,500`
 * as fifteen hundred in a ';'-delimited European export made every value in
 * the column 1000× too large with nothing to show for it — no skipped cell,
 * no warning, just wrong numbers. A file that chose ';' or a tab over ','
 * usually did so because the comma was already spoken for (parseCsv decides).
 */
export function cellNumber(s: string, decimalComma = false): number {
  let t = s.trim();
  if (!t) return NaN;
  let scale = 1;
  if (t.endsWith('%')) {
    scale = 0.01;
    t = t.slice(0, -1).trim();
  }
  if (decimalComma) {
    // 1.234.567,89 — dots group, the comma is the point.
    if (/^[+-]?\d{1,3}(\.\d{3})+(,\d+)?$/.test(t)) t = t.replace(/\./g, '').replace(',', '.');
    else if (/^[+-]?\d+,\d+$/.test(t)) t = t.replace(',', '.');
  } else if (/^[+-]?\d{1,3}(,\d{3})+(\.\d+)?$/.test(t)) {
    t = t.replace(/,/g, '');
  }
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
  const records = parseRecords(text, delimiter);
  if (!records.length) throw new Error('That file has no rows.');
  const warnings: string[] = [];
  // A single-field line above the header is a title, not a record ("Sales
  // report" over a tab-separated export). Read as the header it makes every
  // real row ragged, and the file arrives as one column and no rows — so drop
  // it, but only when the lines below agree on a wider shape, which is what
  // tells a title apart from a genuine one-column file.
  const titled = records.length > 2 && records[0].length === 1 && records[1].length > 1
    && records.filter(r => r.length === records[1].length).length > records.length / 2;
  if (titled) warnings.push('1 title line above the header ignored');
  const first = titled ? 1 : 0;
  const header = records[first];
  // What a comma means is a property of the file, not of a cell: only a file
  // that kept ',' for itself can be using it to group thousands.
  const decimalComma = delimiter !== ',';

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
  for (let r = first + 1; r < records.length; r++) {
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
  /** Cells whose comma was read as a decimal point — said out loud below,
   *  because the other reading would have been 1000× larger. */
  let pointedByComma = 0;
  const columns: Column[] = names.map((name, c) => {
    const cells = body.map(row => row[c]);
    let numeric = cells.length > 0;
    let seen = 0;
    for (const cell of cells) {
      if (isBlankCell(cell)) continue;
      seen++;
      if (Number.isNaN(cellNumber(cell, decimalComma))) {
        numeric = false;
        break;
      }
    }
    if (!seen) numeric = false; // an all-blank column is text, not a run of NaN
    if (!numeric) {
      // A gap is a gap in a text column too: the same cell that would read as
      // NaN in a numeric column ("", "N/A", "-") is stored as the empty
      // string, which every comparison answers no to (list.ts), and counted
      // like any other missing value.
      let blanks = 0;
      const strs = cells.map(s => {
        if (!isBlankCell(s)) return s.trim();
        blanks++;
        return '';
      });
      if (blanks) missing.set(name, blanks);
      return { name, label: header[c].trim(), type: 'str', strs };
    }
    const nums = new Float64Array(cells.length);
    let gaps = 0;
    cells.forEach((cell, k) => {
      const v = isBlankCell(cell) ? NaN : cellNumber(cell, decimalComma);
      if (Number.isNaN(v)) gaps++;
      else if (decimalComma && cell.includes(',')) pointedByComma++;
      nums[k] = v;
    });
    if (gaps) missing.set(name, gaps);
    return { name, label: header[c].trim(), type: 'num', nums };
  });

  if (pointedByComma) {
    const named = delimiter === '\t' ? 'tabs' : `"${delimiter}"`;
    warnings.push(`${pointedByComma} value${pointedByComma === 1 ? '' : 's'} read with ',' as the decimal point`
      + ` (the file separates its columns with ${named})`);
  }
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
      const strs = col.strs!.filter((_, k) => keep[k]);
      // A blank text cell is a gap like a NaN, and the cut has to recount
      // them or the derived table's preview claims the data is complete.
      const gaps = strs.reduce((n, s) => n + (s ? 0 : 1), 0);
      if (gaps) missing.set(col.name, gaps);
      return { ...col, strs };
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
