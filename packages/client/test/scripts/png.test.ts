import { crc32, deflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { decodePng, distinctColors } from "../../scripts/png";

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

function chunk(type: string, body: Uint8Array): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(body.length, 0);
  head.write(type, 4, "latin1");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), body])), 0);
  return Buffer.concat([head, body, crc]);
}

/** An 8-bit PNG of `pixels` whose row y uses filter `filters[y % filters.length]`. */
function encodePng(
  width: number,
  height: number,
  channels: number,
  pixels: Uint8Array,
  filters: readonly number[],
): Uint8Array {
  const stride = width * channels;
  const raw = new Uint8Array((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    const f = filters[y % filters.length] as number;
    raw[y * (stride + 1)] = f;
    for (let x = 0; x < stride; x++) {
      const at = (yy: number, xx: number) =>
        yy < 0 || xx < 0 ? 0 : (pixels[yy * stride + xx] as number);
      const v = at(y, x);
      const a = at(y, x - channels);
      const b = at(y - 1, x);
      const c = at(y - 1, x - channels);
      const pred = [0, a, b, (a + b) >> 1, paeth(a, b, c)][f] as number;
      raw[y * (stride + 1) + 1 + x] = (v - pred) & 0xff;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = { 1: 0, 2: 4, 3: 2, 4: 6 }[channels] as number;
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const z = deflateSync(raw);
  // Two IDAT chunks: the decoder must join them.
  const half = z.length >> 1;
  return new Uint8Array(
    Buffer.concat([
      sig,
      chunk("IHDR", ihdr),
      chunk("IDAT", z.subarray(0, half)),
      chunk("IDAT", z.subarray(half)),
      chunk("IEND", new Uint8Array(0)),
    ]),
  );
}

describe("decodePng (the e2e test's pixel reader)", () => {
  it("undoes every row filter, for grey, RGB and RGBA", () => {
    for (const channels of [1, 3, 4]) {
      const width = 7;
      const height = 10;
      const pixels = new Uint8Array(width * height * channels);
      for (let i = 0; i < pixels.length; i++) pixels[i] = (i * 37 + ((i * i) % 11) * 19) & 0xff;
      const png = decodePng(encodePng(width, height, channels, pixels, [0, 1, 2, 3, 4]));
      expect([png.width, png.height, png.channels]).toEqual([width, height, channels]);
      expect(Array.from(png.data)).toEqual(Array.from(pixels));
    }
  });

  it("refuses what it cannot read, and counts colours", () => {
    expect(() => decodePng(new Uint8Array(16))).toThrow("not a PNG");
    const flat = decodePng(encodePng(8, 8, 3, new Uint8Array(8 * 8 * 3).fill(200), [0]));
    expect(distinctColors(flat, 1)).toBe(1);
    const two = new Uint8Array(8 * 8 * 4).fill(255);
    two.fill(0, 0, 4);
    expect(distinctColors(decodePng(encodePng(8, 8, 4, two, [1])), 1)).toBe(2);
  });
});
