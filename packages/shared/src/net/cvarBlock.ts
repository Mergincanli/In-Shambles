import { CvarFlag } from "../cvars/flags";
import type { CvarRegistry, CvarType, CvarValue } from "../cvars/registry";
import { DEV_ASSERT } from "../debug/assert";
import { murmur3Bytes } from "../rng/hash32";
import { type BitReader, BitWriter, readAscii, writeAscii } from "./bitstream";
import { CVAR_STRING_MAX, MAX_RELIABLE_BYTES, SHORT_TEXT_MAX } from "./protocol";

/**
 * The replicated cvar block (docs/05 §3.5–§3.6, D-027): every REPLICATED cvar, sorted by name,
 * as WELCOME and CVARS carry it. The layout is canonical (one encoding per set of values), so its
 * bytes identify the values and their hash versions them:
 *
 * - count u10;
 * - per entry, in ascending lowercase-name order (no duplicates): name (u6 length + 7-bit ASCII),
 *   kind u2, then the value: int as i32, float as the f64's raw bits (exact; finite, never −0),
 *   bool as 1 bit, string as a u8 length + 7-bit ASCII.
 *
 * The hash is murmur3Bytes over the block encoded alone from bit 0 and zero-padded to a byte,
 * seed CVAR_HASH_SEED. CVARS carries all 32 bits, snapshots the low 16 (`cvarHash16`).
 *
 * The block, apply and hash are rare (join and console changes), so they may allocate.
 */

export const CVAR_KIND_INT = 0;
export const CVAR_KIND_FLOAT = 1;
export const CVAR_KIND_BOOL = 2;
export const CVAR_KIND_STRING = 3;

const KIND_BY_TYPE: Readonly<Record<CvarType, number>> = {
  int: CVAR_KIND_INT,
  float: CVAR_KIND_FLOAT,
  bool: CVAR_KIND_BOOL,
  string: CVAR_KIND_STRING,
};
const TYPE_BY_KIND: readonly CvarType[] = ["int", "float", "bool", "string"];

const COUNT_BITS = 10;
export const CVAR_BLOCK_MAX_ENTRIES = 1023;

/** The ASCII bytes "cvar" read as a big-endian u32 (M2 design §2: seed 'cvar'). */
export const CVAR_HASH_SEED = 0x63766172;

/** The registry's name grammar (cvars/registry.ts), which decode requires too. */
const NAME = /^[a-z][A-Za-z0-9_]*$/;

export interface CvarBlockEntry {
  readonly name: string;
  readonly type: CvarType;
  readonly value: CvarValue;
}

/** A decoded or captured block: entries in canonical order. */
export class CvarBlock {
  readonly entries: CvarBlockEntry[] = [];
}

/** Lowercase-name order, as `CvarRegistry.replicated()` sorts (names are ASCII). */
function before(a: string, b: string): boolean {
  return a.toLowerCase() < b.toLowerCase();
}

function validValue(type: CvarType, value: CvarValue): boolean {
  switch (type) {
    case "int":
      return typeof value === "number" && (value | 0) === value && !Object.is(value, -0);
    case "float":
      return typeof value === "number" && Number.isFinite(value) && !Object.is(value, -0);
    case "bool":
      return typeof value === "boolean";
    case "string":
      return typeof value === "string" && isBlockString(value);
  }
}

/** Printable 7-bit ASCII of at most CVAR_STRING_MAX chars, as writeAscii carries it. */
function isBlockString(s: string): boolean {
  if (s.length > CVAR_STRING_MAX) return false;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x20 || c > 0x7e) return false;
  }
  return true;
}

/** Copies the registry's REPLICATED cvars, sorted by name, into `out`, and returns it. */
export function captureCvarBlock(reg: CvarRegistry, out: CvarBlock): CvarBlock {
  out.entries.length = 0;
  for (const info of reg.replicated()) {
    out.entries.push({ name: info.def.name, type: info.def.type, value: info.value });
  }
  return out;
}

/**
 * Writes `block`. A block that isn't canonical (out of order, a bad name or value, a string that
 * isn't printable ASCII or is too long, too many entries) sets the writer's error flag.
 */
export function encodeCvarBlock(w: BitWriter, block: CvarBlock): void {
  const entries = block.entries;
  const n = entries.length;
  if (n > CVAR_BLOCK_MAX_ENTRIES) {
    w.fail();
    return;
  }
  w.writeBits(n, COUNT_BITS);
  let prev = "";
  for (let i = 0; i < n; i++) {
    const e = entries[i] as CvarBlockEntry;
    if (!NAME.test(e.name) || (i > 0 && !before(prev, e.name)) || !validValue(e.type, e.value)) {
      w.fail();
      return;
    }
    prev = e.name;
    writeAscii(w, e.name, 6, SHORT_TEXT_MAX);
    w.writeBits(KIND_BY_TYPE[e.type], 2);
    const value = e.value;
    if (e.type === "int") w.writeSigned(value as number, 32);
    else if (e.type === "float") w.writeF64(value as number);
    else if (e.type === "bool") w.writeBool(value as boolean);
    else writeAscii(w, value as string, 8, CVAR_STRING_MAX);
  }
}

/**
 * Reads a block into `out`; false on a short read or anything encodeCvarBlock would not write
 * (order, duplicates, names, non-finite or −0 floats, bad string chars). `out` is then partial.
 */
export function decodeCvarBlock(r: BitReader, out: CvarBlock): boolean {
  out.entries.length = 0;
  const n = r.readBits(COUNT_BITS);
  if (r.error) return false;
  let prev = "";
  for (let i = 0; i < n; i++) {
    const name = readAscii(r, 6, SHORT_TEXT_MAX);
    if (name === null || !NAME.test(name) || (i > 0 && !before(prev, name))) return false;
    prev = name;
    const type = TYPE_BY_KIND[r.readBits(2)] as CvarType;
    let value: CvarValue;
    if (type === "int") value = r.readSigned(32);
    else if (type === "float") value = r.readF64();
    else if (type === "bool") value = r.readBool();
    else {
      const s = readAscii(r, 8, CVAR_STRING_MAX);
      if (s === null) return false;
      value = s;
    }
    if (r.error || !validValue(type, value)) return false;
    out.entries.push({ name, type, value });
  }
  return !r.error;
}

const hashWriter = new BitWriter(MAX_RELIABLE_BYTES);

/** The block's hash (u32), or −1 when it can't be encoded. */
export function cvarBlockHash(block: CvarBlock): number {
  const w = hashWriter;
  w.reset();
  encodeCvarBlock(w, block);
  if (w.error) return -1;
  return murmur3Bytes(w.bytes.subarray(0, w.byteLength), CVAR_HASH_SEED);
}

const captured = new CvarBlock();

/**
 * The hash of the registry's current replicated values (what the server's snapshots carry). The
 * registry keeps replicated names and strings within the block's limits, so this is −1 only past
 * CVAR_BLOCK_MAX_ENTRIES replicated cvars.
 */
export function registryCvarHash(reg: CvarRegistry): number {
  return cvarBlockHash(captureCvarBlock(reg, captured));
}

/** The low 16 bits that snapshots carry. `hash` must be a real hash, not the −1 of a bad block. */
export function cvarHash16(hash: number): number {
  DEV_ASSERT(hash >= 0, "cvarHash16 needs a valid block hash", hash);
  return hash & 0xffff;
}

export type CvarApplyResult =
  | { readonly ok: true; readonly changed: number }
  | {
      readonly ok: false;
      readonly error: "order" | "missing" | "unknown" | "not-replicated" | "type" | "range";
      readonly name: string;
    };

/**
 * Applies a server block to a client's mirror registry, all or nothing. The block must list
 * exactly the registry's REPLICATED cvars, spelled as registered, with their types and values
 * within their bounds; otherwise nothing changes (a client with another cvar set is another build,
 * and a clamped value would mispredict). The server already applied its CHEAT and LATCH rules to
 * the values it sends, so the mirror stores them as they are (`CvarRegistry.setReplicated`),
 * whatever its own cheat setting: prediction uses the server's values only.
 * On success the registry's `registryCvarHash` equals the block's `cvarBlockHash`.
 */
export function applyCvarBlock(reg: CvarRegistry, block: CvarBlock): CvarApplyResult {
  const entries = block.entries;
  const replicated = reg.replicated();
  let prev = "";
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i] as CvarBlockEntry;
    if (i > 0 && !before(prev, e.name)) return { ok: false, error: "order", name: e.name };
    prev = e.name;
    const info = reg.info(e.name);
    if (info === undefined || info.def.name !== e.name) {
      return { ok: false, error: "unknown", name: e.name };
    }
    const def = info.def;
    if (((def.flags ?? 0) & CvarFlag.REPLICATED) === 0) {
      return { ok: false, error: "not-replicated", name: e.name };
    }
    if (def.type !== e.type || !validValue(def.type, e.value)) {
      return { ok: false, error: "type", name: e.name };
    }
    const v = e.value;
    if (typeof v === "number" && (v < (def.min ?? v) || v > (def.max ?? v))) {
      return { ok: false, error: "range", name: e.name };
    }
  }
  // Every entry is a distinct REPLICATED cvar (the order is strict), so equal counts mean the
  // block covers the whole set.
  if (entries.length !== replicated.length) {
    const listed = new Set(entries.map((e) => e.name));
    const missing = replicated.find((info) => !listed.has(info.def.name));
    return { ok: false, error: "missing", name: missing?.def.name ?? "" };
  }
  let changed = 0;
  for (const e of entries) {
    if (reg.get(e.name) !== e.value) changed++;
    // Cannot fail: the loop above checked the name, kind, value and range of every entry.
    reg.setReplicated(e.name, e.value);
  }
  return { ok: true, changed };
}
