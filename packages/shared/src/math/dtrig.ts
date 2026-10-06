import { DEV_ASSERT } from "../debug/assert";

/**
 * Deterministic sine and cosine (D-016). ECMA-262 lets engines approximate Math.sin/cos, so
 * these use only operations the spec rounds exactly (+ − * /, Math.round, Math.abs) and give the
 * same bits in every engine. Results are within 1–2 ulp of the true value, except next to zeros
 * of sin/cos, where the reduction limits them to an absolute error below about 1e-21. What
 * matters is that every engine agrees.
 */

const TWO_OVER_PI = 0.6366197723675814;
/** π/2 cut to 31 significant bits, so k·P1 is exact for |k| < 2^22 (|x| < 1e5 needs 2^16). */
const PIO2_1 = 1.5707963267341256;
/** π/2 − PIO2_1 to double precision: together they carry π/2 to about 2^-87. */
const PIO2_2 = 6.077100506506192e-11;

/** Largest |x| the two-part reduction keeps exact. */
export const DTRIG_MAX_ARG = 1e5;

// Taylor coefficients ±1/n! as decimal literals; literal parsing rounds correctly per spec.
const S3 = -0.16666666666666666;
const S5 = 0.008333333333333333;
const S7 = -0.0001984126984126984;
const S9 = 0.0000027557319223985893;
const S11 = -2.505210838544172e-8;
const S13 = 1.6059043836821613e-10;
const S15 = -7.647163731819816e-13;

const C2 = -0.5;
const C4 = 0.041666666666666664;
const C6 = -0.001388888888888889;
const C8 = 0.0000248015873015873;
const C10 = -2.755731922398589e-7;
const C12 = 2.08767569878681e-9;
const C14 = -1.1470745597729725e-11;
const C16 = 4.779477332387385e-14;

/** sin(r) for |r| ≤ π/4: degree-15 Taylor polynomial, Horner in r². */
function sinPoly(r: number): number {
  const z = r * r;
  return r + r * z * (S3 + z * (S5 + z * (S7 + z * (S9 + z * (S11 + z * (S13 + z * S15))))));
}

/** cos(r) for |r| ≤ π/4: degree-16 Taylor polynomial, Horner in r². */
function cosPoly(r: number): number {
  const z = r * r;
  return (
    1 + z * (C2 + z * (C4 + z * (C6 + z * (C8 + z * (C10 + z * (C12 + z * (C14 + z * C16)))))))
  );
}

/*
 * Cody–Waite reduction: x = k·π/2 + r with |r| ≲ π/4. x − k·P1 is exact (k·P1 is exact and
 * close to x); the P2 term leaves r with an absolute error of about |k|·2^-87 (below 1e-21 for
 * |x| < 1e5). That is sub-ulp unless r itself is tiny, i.e. next to a multiple of π/2, where the
 * result is accurate in absolute rather than relative terms. Far beyond what gameplay needs.
 */

/** Deterministic sin for |x| < 1e5. */
export function dsin(x: number): number {
  DEV_ASSERT(Math.abs(x) < DTRIG_MAX_ARG, "dsin argument must be finite and below 1e5", x);
  const k = Math.round(x * TWO_OVER_PI);
  const r = x - k * PIO2_1 - k * PIO2_2;
  const q = k & 3;
  if (q === 0) return sinPoly(r);
  if (q === 1) return cosPoly(r);
  if (q === 2) return 0 - sinPoly(r);
  return 0 - cosPoly(r);
}

/** Deterministic cos for |x| < 1e5. */
export function dcos(x: number): number {
  DEV_ASSERT(Math.abs(x) < DTRIG_MAX_ARG, "dcos argument must be finite and below 1e5", x);
  const k = Math.round(x * TWO_OVER_PI);
  const r = x - k * PIO2_1 - k * PIO2_2;
  const q = k & 3;
  if (q === 0) return cosPoly(r);
  if (q === 1) return 0 - sinPoly(r);
  if (q === 2) return 0 - cosPoly(r);
  return sinPoly(r);
}

/**
 * Quarter-wave table for u16 angles (65536 units per turn): QUARTER[i] = sin(i·2π/65536) for
 * i in 0..16384. The upper half is dcos of the complementary angle, built from the integer
 * 16384 − i, so values near 90° never depend on reducing an argument close to π/2.
 * QUARTER[0] = 0 and QUARTER[16384] = 1 exactly.
 */
const QUARTER = new Float64Array(16385);
{
  const step = Math.PI / 32768;
  for (let i = 0; i <= 8192; i++) QUARTER[i] = dsin(i * step);
  for (let i = 8193; i <= 16384; i++) QUARTER[i] = dcos((16384 - i) * step);
  QUARTER[0] = 0;
  QUARTER[16384] = 1;
}

/**
 * sin of a u16 angle by table lookup. Exact at the cardinal angles, exactly odd
 * (sinU16(−a) === −sinU16(a)) and symmetric about 90°. Never returns −0.
 */
export function sinU16(a: number): number {
  const u = a & 0xffff;
  const i = u & 16383;
  const quadrant = u >> 14;
  if (quadrant === 0) return QUARTER[i] as number;
  if (quadrant === 1) return QUARTER[16384 - i] as number;
  if (quadrant === 2) return 0 - (QUARTER[i] as number);
  return 0 - (QUARTER[16384 - i] as number);
}

/** cos of a u16 angle: sinU16 a quarter turn ahead, so it is exactly even. */
export function cosU16(a: number): number {
  return sinU16(a + 16384);
}

/**
 * Writes sinU16(a) to out[offset] and cosU16(a) to out[offset + 1], bit for bit for integer
 * angles, which is all pmove passes (sanitized u16 cmd angles); a fractional or non-finite `a` may
 * give a different cosine, since cosU16 adds before it truncates. The lookups are repeated here
 * rather than called: a call that isn't inlined boxes its double result, and per-tick callers
 * (the view basis in pmove) can't rely on the JIT inlining it.
 */
export function sinCosU16(a: number, out: Float64Array, offset: number): void {
  const u = a & 0xffff;
  const i = u & 16383;
  const quadrant = u >> 14;
  // cos(a) = sin(a + 16384): the next quadrant, same index.
  const c = (quadrant + 1) & 3;
  if (quadrant === 0) out[offset] = QUARTER[i] as number;
  else if (quadrant === 1) out[offset] = QUARTER[16384 - i] as number;
  else if (quadrant === 2) out[offset] = 0 - (QUARTER[i] as number);
  else out[offset] = 0 - (QUARTER[16384 - i] as number);
  if (c === 0) out[offset + 1] = QUARTER[i] as number;
  else if (c === 1) out[offset + 1] = QUARTER[16384 - i] as number;
  else if (c === 2) out[offset + 1] = 0 - (QUARTER[i] as number);
  else out[offset + 1] = 0 - (QUARTER[16384 - i] as number);
}
