/**
 * Content hashing for pinned data files.
 *
 * A CSV cannot live in the URL, but its identity can: `open("people.csv",
 * 3a7f…)` names the bytes, IndexedDB holds them. The hash is what makes a
 * shared graph honest — open it against a different file and the row says so
 * instead of quietly plotting other numbers.
 */

/** SHA-256 of the bytes, lowercase hex. */
export async function sha256Hex(data: ArrayBuffer | Uint8Array): Promise<string> {
  const buf = data instanceof Uint8Array
    ? data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)
    : data;
  const digest = await crypto.subtle.digest('SHA-256', buf as ArrayBuffer);
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
}

/** Hex characters of the hash written into a row. 48 bits: collisions need
 *  ~16 million files before they are even worth thinking about, and the token
 *  still fits in a glance. */
export const HASH_TOKEN_LEN = 12;

export const shortHash = (hex: string): string => hex.slice(0, HASH_TOKEN_LEN);
