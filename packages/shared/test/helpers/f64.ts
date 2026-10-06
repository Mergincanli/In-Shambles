/** binary64 bit helpers for tests and determinism vectors. Plain ES2023: no Node APIs. */
const view = new DataView(new ArrayBuffer(8));

/** The 16 hex digits of x's IEEE-754 bits, sign first. */
export function f64ToHex(x: number): string {
  view.setFloat64(0, x);
  return view.getBigUint64(0).toString(16).padStart(16, "0");
}

export function hexToF64(hex: string): number {
  view.setBigUint64(0, BigInt(`0x${hex}`));
  return view.getFloat64(0);
}

/** Position of x on the ordered line of doubles, so ulp distance is a subtraction. */
function ordinal(x: number): bigint {
  view.setFloat64(0, x);
  const bits = view.getBigInt64(0);
  return bits < 0n ? -(bits & 0x7fffffffffffffffn) : bits;
}

/** Number of doubles between a and b (0 when equal; +0 and −0 count as equal). */
export function ulpDistance(a: number, b: number): number {
  const d = ordinal(a) - ordinal(b);
  return Number(d < 0n ? -d : d);
}

/** The next double after x toward +Infinity (`steps` < 0 goes down). */
export function nextAfter(x: number, steps = 1): number {
  let o = ordinal(x) + BigInt(steps);
  const negative = o < 0n;
  if (negative) o = -o;
  view.setBigUint64(0, negative ? o | 0x8000000000000000n : o);
  return view.getFloat64(0);
}
