import { inflateSync } from "node:zlib";

/** A decoded 8-bit PNG: `channels` bytes per pixel, rows top to bottom. */
export interface Png {
  readonly width: number;
  readonly height: number;
  readonly channels: number;
  readonly data: Uint8Array;
}

const SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];
const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 4: 2, 6: 4 };

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

/**
 * Decodes the PNGs a browser screenshot produces (8-bit grey, RGB or RGBA, not interlaced), so
 * the e2e test can look at the pixels without an image dependency.
 */
export function decodePng(file: Uint8Array): Png {
  for (let i = 0; i < 8; i++) if (file[i] !== SIGNATURE[i]) throw new Error("not a PNG");
  const view = new DataView(file.buffer, file.byteOffset, file.byteLength);
  let width = 0;
  let height = 0;
  let channels = 0;
  const idat: Uint8Array[] = [];
  for (let at = 8; at + 8 <= file.length; ) {
    const len = view.getUint32(at);
    const type = String.fromCharCode(...file.subarray(at + 4, at + 8));
    const body = file.subarray(at + 8, at + 8 + len);
    if (type === "IHDR") {
      width = view.getUint32(at + 8);
      height = view.getUint32(at + 12);
      const depth = body[8];
      channels = CHANNELS[body[9] ?? -1] ?? 0;
      if (depth !== 8 || channels === 0 || body[12] !== 0) {
        throw new Error(
          `unsupported PNG (depth ${depth}, colour ${body[9]}, interlace ${body[12]})`,
        );
      }
    } else if (type === "IDAT") {
      idat.push(body);
    } else if (type === "IEND") {
      break;
    }
    at += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const data = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const src = y * (stride + 1) + 1;
    const row = y * stride;
    for (let x = 0; x < stride; x++) {
      const v = raw[src + x] ?? 0;
      const a = x >= channels ? (data[row + x - channels] ?? 0) : 0;
      const b = y > 0 ? (data[row - stride + x] ?? 0) : 0;
      const c = x >= channels && y > 0 ? (data[row - stride + x - channels] ?? 0) : 0;
      let out = v;
      if (filter === 1) out = v + a;
      else if (filter === 2) out = v + b;
      else if (filter === 3) out = v + ((a + b) >> 1);
      else if (filter === 4) out = v + paeth(a, b, c);
      else if (filter !== 0) throw new Error(`bad PNG filter ${filter}`);
      data[row + x] = out & 0xff;
    }
  }
  return { width, height, channels, data };
}

/** Distinct colours among the image's pixels (every `step`-th pixel in each direction). */
export function distinctColors(png: Png, step = 4): number {
  const seen = new Set<number>();
  const n = Math.min(3, png.channels);
  for (let y = 0; y < png.height; y += step) {
    for (let x = 0; x < png.width; x += step) {
      const i = (y * png.width + x) * png.channels;
      let key = 0;
      for (let k = 0; k < n; k++) key = key * 256 + (png.data[i + k] ?? 0);
      seen.add(key);
    }
  }
  return seen.size;
}
