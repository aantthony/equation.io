/**
 * Targeted documents for data files (lib/defs.ts `open(…)` rows, tables and
 * their columns, `person[…]` cuts; lib/list.ts over packed columns): each a
 * set of files and the rows that read them. apple/corpus/analysis.ts records
 * every one twice — on the device that has the files (a table source, as
 * web/main.ts gives prepareDocument) and as a shared link opened elsewhere
 * (no source at all, as the worker reads it).
 *
 * A row names a file's hash as `{people.csv}`: the 12-digit token of that
 * file's SHA-256, filled in when the documents are recorded.
 */
import { CSV_FILES } from './cases-leftovers.ts';

export interface DataFile {
  name: string;
  /** The file's text; or `generate` rows of `a,b,c` written by `generated`. */
  content?: string;
  generate?: number;
}

export interface DataCase {
  files: DataFile[];
  rows: string;
}

/** A file too long to carry in the fixture: `rows` rows of whole numbers,
 *  which the Swift tests write the same way. */
export const generated = (rows: number): string => {
  let out = 'a,b,c\n';
  for (let k = 0; k < rows; k++) out += `${k},${(k * 37) % 101},${(k * k) % 53}\n`;
  return out;
};

const people: DataFile = { name: 'people.csv', content: CSV_FILES[0] };
const pairs: DataFile = { name: 'pairs.csv', content: CSV_FILES[1] };
const semis: DataFile = { name: 'wide.csv', content: CSV_FILES[24] };
const ragged: DataFile = { name: 'ragged.csv', content: CSV_FILES[9] };
const percent: DataFile = { name: 'percent.csv', content: CSV_FILES[11] };
const rowed: DataFile = { name: 'rowed.csv', content: CSV_FILES[20] };
const named: DataFile = { name: 'odd names.csv', content: CSV_FILES[10] };
const survey: DataFile = {
  name: 'survey.csv',
  content:
    'city,age,height,weight,score\n' +
    Array.from({ length: 40 }, (_, k) =>
      [
        ['Oslo', 'Lima', 'Pune', ''][k % 4],
        18 + ((k * 7) % 50),
        (1.5 + ((k * 13) % 40) / 100).toFixed(2),
        k % 9 === 4 ? '' : 50 + ((k * 11) % 45),
        ((k * 17) % 100) / 10,
      ].join(','),
    ).join('\n') +
    '\n',
};
const cloud: DataFile = { name: 'cloud.csv', generate: 600 };
const thick: DataFile = { name: 'thick.csv', generate: 10_001 };
const huge: DataFile = { name: 'huge.csv', generate: 200_001 };

export const DATA_CASES: DataCase[] = [
  // A file, its readout, its columns as rows.
  {
    files: [people],
    rows:
      'person = open("people.csv", {people.csv}); person.age; person.height; (person.age, person.height);' +
      ' mean(person.age); person.name; person; person.nope; person.age.length; person.name.length',
  },
  {
    files: [people],
    rows:
      'person = open("people.csv", {people.csv}); hist(person.age); hist(person.height, 2); count(person.age);' +
      ' total(person.height); max(person.age); min(person.height); median(person.age); sd(person.height)',
  },
  // Arithmetic over columns, with sliders and t.
  {
    files: [people],
    rows:
      'person = open("people.csv", {people.csv}); a = 2; person.age + 1; 2 person.height; a person.age;' +
      ' (person.age, a person.height); person.age t; y = mean(person.age) x; person.age/person.height;' +
      ' sin(person.age); (person.age + a, person.height)',
  },
  // Naming: lists, scatters, numbers, and what reads them.
  {
    files: [people],
    rows:
      'person = open("people.csv", {people.csv}); ages = person.age / 2; ages; avg = mean(person.age); avg + 1;' +
      ' y = avg x; P = (person.age, person.height); P; P.x; ages[2]; sort(ages)[2]; p ∈ person.age; p; 2 p',
  },
  // Filters, cuts and positions.
  {
    files: [people],
    rows:
      'person = open("people.csv", {people.csv}); person.age[person.age > 36]; adults = person[person.age >= 40];' +
      ' adults; adults.height; (adults.age, adults.height); person[5]; person[person.age]; person.age[2];' +
      ' person[person.name = "Ada"]; ada = person[person.name == "Ada"]; ada.age; bad = person[person.name = "Ada"]; person[mean(person.age) > 0]',
  },
  {
    files: [people],
    rows:
      'person = open("people.csv", {people.csv}); person.row; sort(person.age); sort(person.height, person.age);' +
      ' sort(person.age)[1]; person.age[person.row < 2]; q = person[person.row > 1]; q.age; q.row; person[1 < 2];' +
      ' person[person.age > t]; person.age[person.name != "Bob"]; p ∈ adults; adults = person[person.age > 1]',
  },
  // Text columns.
  {
    files: [survey],
    rows:
      'sv = open("survey.csv", {survey.csv}); sv.city; sv.city == "Oslo"; sv.age[sv.city == "Lima"]; mean(sv.age[sv.city == "Pune"]);' +
      ' sv.city.length; hist(sv.city.length); 2 sv.city; o = sv[sv.city == "Oslo"]; (o.age, o.height); count(o.age)',
  },
  // A longer file: scatters, histograms, statistics, fits.
  {
    files: [survey],
    rows:
      'sv = open("survey.csv", {survey.csv}); (sv.age, sv.height); hist(sv.age); hist(sv.score, 8); mean(sv.weight);' +
      ' sv.weight; (sv.age, sv.weight); sv.height ~ m sv.age + b; y = m x + b; var(sv.score); (sv.age, sv.height, sv.score)',
  },
  {
    files: [survey],
    rows:
      'sv = open("survey.csv", {survey.csv}); n = 6; hist(sv.age, n); k = 1.5; (sv.age, k sv.height); tall = sv[sv.height > 1.7];' +
      ' (tall.age, tall.score); mean(tall.score) - mean(sv.score); sv.score[sv.age < 30]; segment((0, 0), (sv.age, sv.height))',
  },
  // Two files, a file named twice, names files may not take.
  {
    files: [people, pairs],
    rows:
      'person = open("people.csv", {people.csv}); t2 = open("pairs.csv", {pairs.csv}); (t2.a, t2.b);' +
      ' person.age + t2.a; (person.age, t2.a); again = open("people.csv", {people.csv}); again.age;' +
      ' person = open("pairs.csv", {pairs.csv}); mean(t2.a) + mean(person.age)',
  },
  {
    files: [people],
    rows:
      'w = open("people.csv"); e = open("people.csv", {people.csv}); p = open("people.csv", abc123);' +
      ' open = open("people.csv"); sin = open("people.csv"); r := open("people.csv", {people.csv});' +
      ' r.age; s = open(people.csv); u_1 = open("people.csv"); d = open("people.csv"); e := open("people.csv", {people.csv}); e.age; x := open("a.csv"); q = open("people.csv"',
  },
  {
    files: [people],
    rows: 'p = open("people.csv", {people.csv}, 3); p2 = open("people.csv" {people.csv}); p3 = open(); p4 = open(""); p4.x; y = open("people.csv"); open("people.csv")',
  },
  // Rows that do not pin a hash find the file by name; quotes either way.
  {
    files: [people, pairs],
    rows:
      'person = open("people.csv"); person.age; t2 = open(\'pairs.csv\'); t2.b; other = open("nowhere.csv");' +
      ' other.x; (other.x, person.age); person = 3; T = open("pairs.csv", {pairs.csv}) # a note; T.a',
  },
  // A hash no file answers to: the missing-data state, on every row that reads it.
  {
    files: [people],
    rows:
      'person = open("people.csv", 0123456789ab); person.age; (person.age, person.height); mean(person.age) + 1;' +
      ' ages = person.age / 2; ages; ages[2]; avg = mean(person.age); avg + 1; y = avg x; adults = person[person.age > 2];' +
      ' adults.age; y = x; person; person[5]; person.age[1 < 2]; P = (person.age, person.height); P; hist(person.age)',
  },
  {
    files: [people],
    rows:
      'person = open("people.csv", 0123456789ab); person.height ~ m person.age + b; y = m x + b; m; p ∈ person.age;' +
      ' p; person.age[2]; person.age[person.age > 2]; ages = person.age; ages ~ Normal(0, 1); sort(person.age)[1];' +
      ' person[domain(person.age) > 0]; a = 2; a + 1; person.nope',
  },
  // Files as real exports write them: semicolons, ragged rows, percents, awkward names.
  {
    files: [semis, ragged, percent],
    rows:
      'w = 1; wide = open("wide.csv", {wide.csv}); (wide.a, wide.b); wide.c; rag = open("ragged.csv", {ragged.csv});' +
      ' rag.a; (rag.a, rag.b); pc = open("percent.csv", {percent.csv}); pc.p; (pc.p, pc.q); mean(pc.p)',
  },
  {
    files: [rowed, named],
    rows:
      'r = open("rowed.csv", {rowed.csv}); r.row; r.row_index; r.row_2; n = open("odd names.csv", {odd names.csv});' +
      ' n.a; n.a_2; n.constructor; n.toString; n.x_y; n.pi; n.e; n.col_7; (n.a, n.a_3)',
  },
  // In space, and the clouds: over 400 points a cloud, over 10 000 too many for a scene in space.
  {
    files: [people, cloud],
    rows:
      'person = open("people.csv", {people.csv}); (person.age, person.height, person.age/10); c = open("cloud.csv", {cloud.csv});' +
      ' (c.a, c.b); c.b; hist(c.c); (c.a, c.b, c.c); mean(c.b); sort(c.b)[1]; z = x + y',
  },
  {
    files: [thick],
    rows:
      'c = open("thick.csv", {thick.csv}); (c.a, c.b); (c.a, c.b, c.c); few = c[c.a < 100]; (few.a, few.b, few.c);' +
      ' mean(c.c); a = 2; (c.a, a c.b); c.b; hist(c.b, 20)',
  },
  // More rows than a file may plot.
  {
    files: [huge],
    rows: 'c = open("huge.csv", {huge.csv}); (c.a, c.b); c.b; mean(c.b); hist(c.c); few = c[c.a < 50]; (few.a, few.b); count(few.a)',
  },
];
