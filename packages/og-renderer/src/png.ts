/**
 * A minimal PNG encoder for the renderer's RGB rasters: CompressionStream
 * does the deflate, so there is no image library and it runs anywhere
 * CompressionStream does (Workers, Node, browsers).
 */
import type { Raster } from './render.ts';

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(...parts: Uint8Array[]): number {
  let c = 0xffffffff;
  for (const p of parts) for (let i = 0; i < p.length; i++) c = CRC_TABLE[(c ^ p[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const t = new TextEncoder().encode(type);
  const out = new Uint8Array(12 + data.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  out.set(t, 4);
  out.set(data, 8);
  dv.setUint32(8 + data.length, crc32(t, data));
  return out;
}

async function deflate(data: Uint8Array<ArrayBuffer>): Promise<Uint8Array> {
  // 'deflate' is zlib-wrapped (RFC 1950), which is what PNG IDAT requires.
  const cs = new CompressionStream('deflate');
  const writer = cs.writable.getWriter();
  const written = writer.write(data).then(() => writer.close());
  const out = new Uint8Array(await new Response(cs.readable).arrayBuffer());
  await written;
  return out;
}

export async function encodePng(r: Raster): Promise<Uint8Array> {
  const { w, h, px } = r;
  const raw = new Uint8Array((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0; // filter: none
    raw.set(px.subarray(y * w * 3, (y + 1) * w * 3), y * (w * 3 + 1) + 1);
  }
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, w);
  dv.setUint32(4, h);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type: RGB
  const idat = await deflate(raw);
  const sig = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  const parts = [sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', new Uint8Array(0))];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}
