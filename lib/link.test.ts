import { describe, expect, it } from 'vitest';
import { decodePayload, encodePayload } from './link.ts';

describe('graph-link payload codec', () => {
  it('round-trips equations', () => {
    const rows = ['f(x) = x^2 - 2x', 'a = 3', 'y = f(a) + (x - a)', 'r = 2(1 + cos(theta))'];
    expect(decodePayload(encodePayload(rows))).toEqual(rows);
  });

  it('emits no characters that break chat-app URL linkification', () => {
    const payload = encodePayload(["y = sin(x)*|x|!", "f(x) = 'x'"]);
    expect(payload).not.toMatch(/[()!'* ]/);
  });

  it('decodes legacy single-encoded payloads (raw parens, %20 spaces)', () => {
    expect(decodePayload('y%20%3D%20sin(x);a%3D2')).toEqual(['y = sin(x)', 'a=2']);
  });

  it('drops empty rows on both sides', () => {
    expect(encodePayload(['', ' y = x ', ''])).toBe('y%20%3D%20x');
    expect(decodePayload(';y%3Dx;;')).toEqual(['y=x']);
  });

  it('separates rows whether the separator arrives raw or encoded', () => {
    // Copying a /g/ link out of the address bar can hand the separator back as
    // %3B. A payload that stops separating becomes one row containing a ';',
    // which then fails to parse with "Invalid character".
    const expected = ['y = sin(x)', 'y=x'];
    expect(decodePayload('y%20%3D%20sin%28x%29;y%3Dx')).toEqual(expected); // as emitted
    expect(decodePayload('y = sin(x);y=x')).toEqual(expected); // fully decoded
    expect(decodePayload('y%20=%20sin(x);y=x')).toEqual(expected); // partly decoded
    expect(decodePayload('y%20=%20sin(x)%3By=x')).toEqual(expected); // separator encoded
    expect(decodePayload('y%20%3D%20sin%28x%29%3By%3Dx')).toEqual(expected); // fully encoded
    expect(decodePayload('y%20=%20sin(x)%3by=x')).toEqual(expected); // lowercase %3b
  });

  it("round-trips a row's own semicolon, and still splits on the separator", () => {
    // The row means the ';' — a city, a category, a file name. Encoded once it
    // was the separator's three characters exactly, and since the reader has
    // to accept `%3B` as a separator (above), the row came back cut in half:
    // `p[p.city == "a;b"]` decoded as `p[p.city == "a` and `b"]`. A row's own
    // semicolons are encoded twice, so the two can never be confused.
    const rows = ['p[p.city == "a;b"]', 't = open("sales;2026.csv")', 'y = 2'];
    const payload = encodePayload(rows);
    expect(payload).toContain('%253B');
    expect(payload.split(';')).toHaveLength(rows.length); // separators, and only those
    expect(decodePayload(payload)).toEqual(rows);
    // One row on its own has no separator to be confused with, and survived
    // neither before nor after by accident: it is the same escape.
    expect(decodePayload(encodePayload(['y = "a;b"']))).toEqual(['y = "a;b"']);
  });

  it('preserves literal percent sequences alongside semicolons', () => {
    const rows = [
      'p[p.url == "https://example.com/a%3Bb"]',
      'p = open("sales%3B2026.csv")',
      'p[p.city == "a;b%3b%25%253B%2525%20%00%"]',
      '# 100% complete; next',
      'y = 2',
    ];
    const payload = encodePayload(rows);
    expect(decodePayload(payload)).toEqual(rows);
    expect(decodePayload(payload.replaceAll(';', '%3B'))).toEqual(rows);
    expect(decodePayload(encodePayload(decodePayload(payload)))).toEqual(rows);
  });

  it('preserves the interpretation of unmarked legacy percent sequences', () => {
    expect(decodePayload('p%5Bp.city%20%3D%3D%20%22a%253Bb%22%5D'))
      .toEqual(['p[p.city == "a;b"]']);
    expect(decodePayload('%23%20100%25')).toEqual(['# 100%']);
  });

  it('round-trips comment rows (# group headings)', () => {
    const rows = ['# Lines', 'y=x', 'y=x^2', '# Another group'];
    expect(decodePayload(encodePayload(rows))).toEqual(rows);
  });

  it('keeps a single row whole', () => {
    expect(decodePayload('y%20%3D%20sin%28x%29')).toEqual(['y = sin(x)']);
    expect(decodePayload('(cos(2pi u), sin(2pi u), u)')).toEqual(['(cos(2pi u), sin(2pi u), u)']);
  });
});
