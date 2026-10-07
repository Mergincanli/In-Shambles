/**
 * Bit-packed writer and reader for the wire protocol (docs/05 §3.2, D-026). Bits are packed
 * LSB-first: stream bit i is bit (i & 7) of byte (i >> 3), and a value's low bit goes first. Widths
 * are explicit (1–32), so a layout is the list of its widths.
 *
 * Neither side throws: a write past the buffer or of a value its width can't carry, and a read
 * past the end, set a sticky `error` flag, after which writes do nothing and reads return 0. The
 * codec checks the flag once per message and drops the packet (docs/05 §3.2: drop and add a
 * strike). Both work over a preallocated Uint8Array and allocate nothing per call.
 */

/** Scratch for the f64 raw-bits helpers; little-endian explicitly, whatever the platform. */
const f64View = new DataView(new ArrayBuffer(8));

function isWidth(width: number): boolean {
  return (width | 0) === width && width >= 1 && width <= 32;
}

/** Whether `value` is an integer in 0..2^width − 1. */
function fitsUnsigned(value: number, width: number): boolean {
  if (value >>> 0 !== value) return false;
  return width === 32 || value >>> width === 0;
}

/** Whether `value` is an integer in −2^(width−1)..2^(width−1) − 1. */
function fitsSigned(value: number, width: number): boolean {
  if ((value | 0) !== value) return false;
  if (width === 32) return true;
  const shift = 32 - width;
  return (value << shift) >> shift === value;
}

export class BitWriter {
  readonly bytes: Uint8Array;
  private readonly capacityBits: number;
  private pos = 0;
  /** Sticky: set by an overflow, a bad width or a value its width can't carry. */
  error = false;

  constructor(capacityBytes: number) {
    this.bytes = new Uint8Array(capacityBytes);
    this.capacityBits = capacityBytes * 8;
  }

  /** Starts a new message at bit 0 and clears the error flag. */
  reset(): void {
    this.pos = 0;
    this.error = false;
  }

  /** Marks the message bad: an encoder found a field its layout can't carry. */
  fail(): void {
    this.error = true;
  }

  get bitLength(): number {
    return this.pos;
  }

  /** Bytes the message occupies; the last byte's unused high bits are zero. */
  get byteLength(): number {
    return (this.pos + 7) >>> 3;
  }

  /** Unsigned `value` in `width` bits (1–32); out of range sets the error flag. */
  writeBits(value: number, width: number): void {
    if (this.error) return;
    if (!isWidth(width) || !fitsUnsigned(value, width) || this.pos + width > this.capacityBits) {
      this.error = true;
      return;
    }
    const buf = this.bytes;
    let pos = this.pos;
    let v = value;
    let left = width;
    while (left > 0) {
      const at = pos >>> 3;
      const off = pos & 7;
      const n = Math.min(8 - off, left);
      const chunk = v & ((1 << n) - 1);
      // A byte's first write assigns, clearing what an earlier message left there.
      if (off === 0) buf[at] = chunk;
      else buf[at] = (buf[at] as number) | (chunk << off);
      v >>>= n;
      pos += n;
      left -= n;
    }
    this.pos = pos;
  }

  /** Two's-complement `value` in `width` bits (1–32). */
  writeSigned(value: number, width: number): void {
    if (this.error) return;
    if (!isWidth(width) || !fitsSigned(value, width)) {
      this.error = true;
      return;
    }
    this.writeBits(width === 32 ? value >>> 0 : value & (0xffffffff >>> (32 - width)), width);
  }

  writeBool(value: boolean): void {
    this.writeBits(value ? 1 : 0, 1);
  }

  /** The IEEE-754 bits of `value`, low word first: exact for every double (cvar values). */
  writeF64(value: number): void {
    f64View.setFloat64(0, value, true);
    this.writeBits(f64View.getUint32(0, true), 32);
    this.writeBits(f64View.getUint32(4, true), 32);
  }

  /** Zero bits up to the next byte boundary. */
  padToByte(): void {
    const pad = (8 - (this.pos & 7)) & 7;
    if (pad !== 0) this.writeBits(0, pad);
  }
}

export class BitReader {
  private bytes: Uint8Array = new Uint8Array(0);
  private endBits = 0;
  private pos = 0;
  /** Sticky: set by a read past the end or a bad width. */
  error = false;

  /** Reads `byteLength` bytes of `bytes` from bit 0 and clears the error flag. Keeps a reference. */
  reset(bytes: Uint8Array, byteLength: number): void {
    this.bytes = bytes;
    const len = Math.max(0, Math.min(byteLength | 0, bytes.length));
    this.endBits = len * 8;
    this.pos = 0;
    this.error = false;
  }

  get bitPosition(): number {
    return this.pos;
  }

  get bitsLeft(): number {
    return this.endBits - this.pos;
  }

  /** Unsigned value of `width` bits (1–32), or 0 with the error flag set. */
  readBits(width: number): number {
    if (this.error) return 0;
    if (!isWidth(width) || this.pos + width > this.endBits) {
      this.error = true;
      return 0;
    }
    const buf = this.bytes;
    let pos = this.pos;
    let v = 0;
    let got = 0;
    while (got < width) {
      const off = pos & 7;
      const n = Math.min(8 - off, width - got);
      const chunk = ((buf[pos >>> 3] as number) >>> off) & ((1 << n) - 1);
      v |= chunk << got;
      pos += n;
      got += n;
    }
    this.pos = pos;
    return v >>> 0;
  }

  /** Two's-complement value of `width` bits (1–32). */
  readSigned(width: number): number {
    const u = this.readBits(width);
    if (width === 32) return u | 0;
    const shift = 32 - width;
    return (u << shift) >> shift;
  }

  readBool(): boolean {
    return this.readBits(1) === 1;
  }

  readF64(): number {
    const lo = this.readBits(32);
    const hi = this.readBits(32);
    f64View.setUint32(0, lo, true);
    f64View.setUint32(4, hi, true);
    return f64View.getFloat64(0, true);
  }

  /**
   * Whether the message ended cleanly: no error, fewer than 8 bits left, and those (the padding
   * of the last byte) all zero. A decoder that returns true has consumed the whole packet.
   */
  atEnd(): boolean {
    if (this.error) return false;
    const left = this.endBits - this.pos;
    if (left >= 8) return false;
    if (left === 0) return true;
    return this.readBits(left) === 0;
  }
}

/**
 * Short ASCII (build hash, map name, cvar names and string values): a `lengthBits` length, then
 * 7 bits per char, printable 0x20–0x7e only. A string that doesn't fit sets the error flag.
 */
export function writeAscii(
  w: BitWriter,
  text: string,
  lengthBits: number,
  maxLength: number,
): void {
  const n = text.length;
  if (n > maxLength) {
    w.fail();
    return;
  }
  w.writeBits(n, lengthBits);
  for (let i = 0; i < n; i++) {
    const c = text.charCodeAt(i);
    if (c < 0x20 || c > 0x7e) {
      w.fail();
      return;
    }
    w.writeBits(c, 7);
  }
}

/** The inverse of writeAscii, or null (a short read, a long length or a non-printable char). Allocates. */
export function readAscii(r: BitReader, lengthBits: number, maxLength: number): string | null {
  const n = r.readBits(lengthBits);
  if (r.error || n > maxLength || n * 7 > r.bitsLeft) return null;
  let s = "";
  for (let i = 0; i < n; i++) {
    const c = r.readBits(7);
    if (c < 0x20 || c > 0x7e) return null;
    s += String.fromCharCode(c);
  }
  return r.error ? null : s;
}

/** Whether a console-text char may go on the wire: Latin-1, no control chars but tab and newline. */
function isTextChar(c: number): boolean {
  return c === 0x09 || c === 0x0a || (c >= 0x20 && c <= 0x7e) || (c >= 0xa0 && c <= 0xff);
}

/** Console text (CMD, PRINT, KICK): a `lengthBits` length, then 8 bits per Latin-1 char. */
export function writeText(w: BitWriter, text: string, lengthBits: number, maxLength: number): void {
  const n = text.length;
  if (n > maxLength) {
    w.fail();
    return;
  }
  w.writeBits(n, lengthBits);
  for (let i = 0; i < n; i++) {
    const c = text.charCodeAt(i);
    if (!isTextChar(c)) {
      w.fail();
      return;
    }
    w.writeBits(c, 8);
  }
}

/** The inverse of writeText, or null. Allocates. */
export function readText(r: BitReader, lengthBits: number, maxLength: number): string | null {
  const n = r.readBits(lengthBits);
  if (r.error || n > maxLength || n * 8 > r.bitsLeft) return null;
  let s = "";
  for (let i = 0; i < n; i++) {
    const c = r.readBits(8);
    if (!isTextChar(c)) return null;
    s += String.fromCharCode(c);
  }
  return r.error ? null : s;
}
