/**
 * Local data files: the bytes behind `person = open("people.csv", 3a7f…)`.
 *
 * The URL is the whole document, and a CSV cannot fit in it — so the row
 * carries the file's *identity* (name + SHA-256 prefix) and the bytes live in
 * IndexedDB on the device that dropped them. Opening the same link elsewhere
 * says so plainly instead of plotting different numbers.
 *
 * Recompiling is synchronous and runs on every keystroke, so IndexedDB (which
 * is not) never sits in that path: files are parsed once into `memory`, and
 * the compiler only ever reads that.
 */
import { type Table, parseCsv } from '../lib/csv.ts';
import { rowSafeFileName } from '../lib/defs.ts';
import { sha256Hex } from '../lib/hash.ts';

export interface LoadedFile {
  /** Full SHA-256 hex of the file's bytes. */
  hash: string;
  /** File name as dropped, e.g. "people.csv". */
  file: string;
  table: Table;
  size: number;
  addedAt: number;
}

/**
 * What a file is, without being the file. Reading a record clones it, so the
 * bytes live in their own store: listing the menu at startup would otherwise
 * copy every CSV in the browser to print its name.
 */
interface Stored {
  hash: string;
  name: string;
  size: number;
  addedAt: number;
  rows: number;
  columns: string[];
}

/** The bytes themselves, fetched only when a row actually opens the file. */
interface StoredBytes {
  hash: string;
  bytes: Uint8Array;
}

const DB_NAME = 'equation-io';
const STORE = 'files';
const BLOBS = 'blobs';

/** Parsed files available to the compiler right now, by full hash. */
const memory = new Map<string, LoadedFile>();

let dbPromise: Promise<IDBDatabase | null> | null = null;

function openDb(): Promise<IDBDatabase | null> {
  dbPromise ??= new Promise<IDBDatabase | null>(resolve => {
    let req: IDBOpenDBRequest;
    try {
      req = indexedDB.open(DB_NAME, 2);
    } catch {
      resolve(null); // storage disabled (some private-browsing modes)
      return;
    }
    req.onupgradeneeded = event => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: 'hash' });
        store.createIndex('name', 'name');
      }
      if (!db.objectStoreNames.contains(BLOBS)) db.createObjectStore(BLOBS, { keyPath: 'hash' });
      // v1 kept the bytes inside the metadata record; move them out so
      // listing files stops reading them.
      if (event.oldVersion === 1) {
        const store = req.transaction!.objectStore(STORE);
        const blobs = req.transaction!.objectStore(BLOBS);
        store.openCursor().onsuccess = e => {
          const cur = (e.target as IDBRequest<IDBCursorWithValue | null>).result;
          if (!cur) return;
          const { bytes, ...meta } = cur.value as Stored & { bytes?: Uint8Array };
          if (bytes) {
            blobs.put({ hash: meta.hash, bytes });
            cur.update(meta);
          }
          cur.continue();
        };
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => resolve(null);
    req.onblocked = () => resolve(null);
  });
  return dbPromise;
}

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB request failed'));
  });
}

async function withStore<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => Promise<T>): Promise<T | null> {
  return withStores(mode, tx => fn(tx.objectStore(STORE)));
}

async function withStores<T>(mode: IDBTransactionMode, fn: (tx: IDBTransaction) => Promise<T>): Promise<T | null> {
  const db = await openDb();
  if (!db) return null;
  try {
    return await fn(db.transaction([STORE, BLOBS], mode));
  } catch {
    return null;
  }
}

const decoder = new TextDecoder();

function remember(rec: Stored, bytes: Uint8Array): LoadedFile {
  const loaded: LoadedFile = {
    hash: rec.hash,
    file: rec.name,
    table: parseCsv(decoder.decode(bytes)),
    size: rec.size,
    addedAt: rec.addedAt,
  };
  memory.set(rec.hash, loaded);
  return loaded;
}

/**
 * The file a row names, from memory only (the compiler is synchronous).
 * A row without a hash matches by file name — that is how a hand-typed
 * `open("people.csv")` finds the file and earns its hash.
 */
export function lookup(file: string, hash: string): LoadedFile | null {
  if (hash) {
    for (const f of memory.values()) if (f.hash.startsWith(hash)) return f;
    return null;
  }
  let best: LoadedFile | null = null;
  for (const f of memory.values()) {
    if (f.file === file && (!best || f.addedAt > best.addedAt)) best = f;
  }
  return best;
}

/** Files already tried against storage, so a missing file is asked for once. */
const attempted = new Set<string>();

/**
 * Pull the files these rows name out of IndexedDB into memory. Resolves to
 * true when something new arrived (the caller recompiles).
 */
export async function loadRefs(refs: Array<{ file: string; hash: string }>): Promise<boolean> {
  let added = false;
  for (const ref of refs) {
    if (lookup(ref.file, ref.hash)) continue;
    const key = `${ref.hash}|${ref.file}`;
    if (attempted.has(key)) continue;
    attempted.add(key);
    const hit = await withStores('readonly', async tx => {
      const store = tx.objectStore(STORE);
      let rec: Stored | null;
      if (ref.hash) {
        // Records are keyed by the full hash, so the 12-hex token in the row
        // is a prefix range over the primary key.
        const hits = await request<Stored[]>(store.getAll(IDBKeyRange.bound(ref.hash, ref.hash + '\uffff')));
        rec = hits[0] ?? null;
      } else {
        const hits = await request<Stored[]>(store.index('name').getAll(IDBKeyRange.only(ref.file)));
        rec = hits.sort((a, b) => b.addedAt - a.addedAt)[0] ?? null;
      }
      if (!rec) return null;
      // Only now are the bytes worth reading.
      const blob = await request<StoredBytes | undefined>(tx.objectStore(BLOBS).get(rec.hash));
      return blob ? { rec, bytes: blob.bytes } : null;
    });
    if (!hit) continue;
    try {
      remember(hit.rec, hit.bytes);
      added = true;
    } catch { /* stored bytes no longer parse: treat as missing */ }
  }
  return added;
}

/** Parse, hash, and persist a dropped file; the result is usable immediately. */
export async function ingest(rawName: string, bytes: Uint8Array): Promise<LoadedFile> {
  const table = parseCsv(decoder.decode(bytes)); // throws before anything is stored
  // Stored under the name a row can quote, so the row and the record agree
  // and re-dropping the same file finds it again.
  const fileName = rowSafeFileName(rawName);
  const hash = await sha256Hex(bytes);
  const rec: Stored = {
    hash,
    name: fileName,
    size: bytes.byteLength,
    addedAt: Date.now(),
    rows: table.rows,
    columns: table.columns.map(c => c.name),
  };
  const loaded: LoadedFile = { hash, file: fileName, table, size: rec.size, addedAt: rec.addedAt };
  memory.set(hash, loaded);
  attempted.delete(`${hash}|${fileName}`);
  // Ask for durable storage the first time the user actually keeps data here.
  navigator.storage?.persist?.().catch(() => {});
  await withStores('readwrite', async tx => {
    tx.objectStore(BLOBS).put({ hash, bytes } satisfies StoredBytes);
    await request(tx.objectStore(STORE).put(rec));
  });
  return loaded;
}

export interface FileMeta {
  hash: string;
  name: string;
  size: number;
  addedAt: number;
  rows: number;
  columns: string[];
}

/** Everything stored on this device, newest first — metadata only. */
export async function listFiles(): Promise<FileMeta[]> {
  const all = await withStore('readonly', s => request<Stored[]>(s.getAll()));
  return (all ?? []).sort((a, b) => b.addedAt - a.addedAt);
}

export async function removeFile(hash: string): Promise<void> {
  memory.delete(hash);
  await withStores('readwrite', async tx => {
    tx.objectStore(BLOBS).delete(hash);
    await request(tx.objectStore(STORE).delete(hash));
  });
}
