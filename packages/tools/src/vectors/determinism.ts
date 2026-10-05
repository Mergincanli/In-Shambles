import {
  cosU16,
  dcos,
  degreesToU16,
  dsin,
  hash32,
  Mulberry32,
  ORIGIN_LIMIT,
  ORIGIN_SCALE,
  quantizeOrigin,
  quantizeStaminaHundredths,
  quantizeVelocity,
  sinU16,
  VELOCITY_LIMIT,
  VELOCITY_SCALE,
} from "@game/shared";

/**
 * Renders packages/shared/test/vectors/determinism.ts: input bits → output bits for the D-016
 * math, frozen from this machine's run. shared's test recomputes them on every run, and M2 replays
 * the same file in real browsers to prove every engine agrees bit for bit.
 */
export const DETERMINISM_VECTORS_FILE = ["packages", "shared", "test", "vectors", "determinism.ts"];

const view = new DataView(new ArrayBuffer(8));

function f64Hex(x: number): string {
  view.setFloat64(0, x);
  return view.getBigUint64(0).toString(16).padStart(16, "0");
}

function u32Hex(x: number): string {
  return (x >>> 0).toString(16).padStart(8, "0");
}

/** The double `steps` places away from x on the ordered line of doubles (x finite, nonzero). */
function nextAfter(x: number, steps: number): number {
  view.setFloat64(0, Math.abs(x));
  const magnitude = view.getBigUint64(0) + BigInt(x < 0 ? -steps : steps);
  view.setBigUint64(0, magnitude);
  return x < 0 ? -view.getFloat64(0) : view.getFloat64(0);
}

function trigInputs(): number[] {
  const halfPi = Math.PI / 2;
  const xs = [
    0,
    -0,
    Number.MIN_VALUE,
    -Number.MIN_VALUE,
    1e-300,
    1 / 1073741824,
    1 / 134217728,
    1e-8,
    0.5,
    1,
    2,
    3,
    Math.PI / 4,
    nextAfter(Math.PI / 4, 1),
    nextAfter(Math.PI / 4, -1),
    Math.PI / 6,
    Math.PI / 3,
    halfPi,
    Math.PI,
    2 * Math.PI,
    1e4,
    99999.99999,
    -99999.99999,
    nextAfter(1e5, -1),
    -nextAfter(1e5, -1),
  ];
  // Next to multiples of π/2, where the reduction cancels, and at the rounding boundaries of k.
  for (const k of [1, 2, 3, 4, 5, 7, 10, 100, 1000, 10000, 40000, 63661]) {
    for (const sign of [1, -1]) {
      const x = sign * k * halfPi;
      xs.push(x, nextAfter(x, 1), nextAfter(x, -1));
      const boundary = sign * (k + 0.5) * halfPi;
      if (Math.abs(boundary) < 1e5) xs.push(boundary, nextAfter(boundary, 1));
    }
  }
  const rng = new Mulberry32(0x0d16);
  for (const range of [1, 10, 1000, 99999]) {
    for (let i = 0; i < 18; i++) xs.push((rng.nextFloat() * 2 - 1) * range);
  }
  return xs;
}

function u16Inputs(): number[] {
  const as: number[] = [];
  for (let a = 0; a < 65536; a += 256) as.push(a);
  as.push(1, 8191, 8193, 16383, 16385, 24575, 32767, 32769, 40961, 49151, 49153, 65535);
  const rng = new Mulberry32(0x0016);
  for (let i = 0; i < 40; i++) as.push(rng.nextU32() & 0xffff);
  return as;
}

function quantInputs(limit: number, quantum: number): number[] {
  const half = quantum / 2;
  const xs = [
    0,
    -0,
    Number.MIN_VALUE,
    -Number.MIN_VALUE,
    half,
    -half,
    nextAfter(half, 1),
    nextAfter(half, -1),
    -nextAfter(half, -1),
    3 * half,
    -3 * half,
    half / 2,
    -half / 2,
    0.1,
    0.2,
    0.3,
    -0.3,
    320.03,
    -1234.5678,
    limit,
    -limit,
    limit - half,
    limit + half,
    nextAfter(limit, 1),
    -nextAfter(limit, 1),
    1e300,
    -1e300,
  ];
  const rng = new Mulberry32(Math.round(limit));
  for (let i = 0; i < 20; i++) xs.push((rng.nextFloat() * 2 - 1) * limit * 1.1);
  return xs;
}

function section(name: string, doc: string, rows: string[]): string {
  return [
    `/** ${doc} */`,
    `export const ${name}: readonly string[] = [`,
    ...rows.map((r) => `  "${r}",`),
    "];",
    "",
  ].join("\n");
}

export function renderDeterminismVectors(): string {
  const trig = trigInputs().map((x) => `${f64Hex(x)} ${f64Hex(dsin(x))} ${f64Hex(dcos(x))}`);
  const u16 = u16Inputs().map((a) => `${a} ${f64Hex(sinU16(a))} ${f64Hex(cosU16(a))}`);
  const origin = quantInputs(ORIGIN_LIMIT, 1 / ORIGIN_SCALE).map(
    (x) => `${f64Hex(x)} ${f64Hex(quantizeOrigin(x))}`,
  );
  const velocity = quantInputs(VELOCITY_LIMIT, 1 / VELOCITY_SCALE).map(
    (x) => `${f64Hex(x)} ${f64Hex(quantizeVelocity(x))}`,
  );
  const stamina = [0, 0.4999999999999999, 0.5, 1.5, 2.5, 9999.5, 65534.5, 65535, 70000, -3].map(
    (x) => `${f64Hex(x)} ${quantizeStaminaHundredths(x)}`,
  );
  const degrees = [
    0, 45, 89, 90, -90, 179.99, 180, 359.999, 720.5, 0.00274658203125, -0.00274658203125,
  ].map((x) => `${f64Hex(x)} ${degreesToU16(x)}`);
  const mulberry: string[] = [];
  for (const seed of [0, 1, 42, 0x9e3779b9, 0xffffffff]) {
    const rng = new Mulberry32(seed);
    for (let i = 0; i < 16; i++) mulberry.push(`${u32Hex(seed)} ${i} ${u32Hex(rng.nextU32())}`);
  }
  // Draws in a fixed order per row, so a change to nextFloat or nextInt's mapping shows up.
  const draws: string[] = [];
  for (const seed of [7, 0x9e3779b9]) {
    const rng = new Mulberry32(seed);
    for (let i = 0; i < 16; i++) {
      const x = rng.nextFloat();
      const ints = [rng.nextInt(3), rng.nextInt(6), rng.nextInt(100), rng.nextInt(0x200000)];
      draws.push(`${u32Hex(seed)} ${i} ${f64Hex(x)} ${ints.join(" ")}`);
    }
  }
  const hashes: string[] = [];
  const words = new Mulberry32(0x4a54);
  const fixed = [
    [0, 0, 0, 0, 0],
    [1, 0, 0, 0, 0],
    [0, 1, 2, 3, 4],
    [0xffffffff, 0xffffffff, 0xffffffff, 0xffffffff, 0xffffffff],
    [0x9747b28c, 7, 3600, 0, 0],
  ];
  for (const w of fixed) {
    const [s, a, b, c, d] = w as [number, number, number, number, number];
    hashes.push([s, a, b, c, d, hash32(s, a, b, c, d)].map(u32Hex).join(" "));
  }
  for (let i = 0; i < 15; i++) {
    const w = [words.nextU32(), words.nextU32(), words.nextU32(), words.nextU32(), words.nextU32()];
    const [s, a, b, c, d] = w as [number, number, number, number, number];
    hashes.push([s, a, b, c, d, hash32(s, a, b, c, d)].map(u32Hex).join(" "));
  }

  return [
    "// GENERATED by packages/tools/src/vectors/determinism.ts. Do not edit by hand.",
    "// Regenerate with `pnpm --filter @game/tools vectors`. A diff here means the sim's math",
    "// changed bits: say why in the change (D-016).",
    "//",
    "// Frozen input → output bits for the deterministic math (D-016). Each row is one string of",
    "// space-separated fields: f64 values as the 16 hex digits of their IEEE-754 bits, u32 values",
    "// as 8 hex digits, small integers in decimal. Plain data with no imports, so M2 can replay it",
    "// in real browsers.",
    "",
    section("DTRIG_VECTORS", "x, dsin(x), dcos(x)", trig),
    section("U16_TRIG_VECTORS", "a (decimal), sinU16(a), cosU16(a)", u16),
    section("QUANT_ORIGIN_VECTORS", "x, quantizeOrigin(x)", origin),
    section("QUANT_VELOCITY_VECTORS", "x, quantizeVelocity(x)", velocity),
    section("QUANT_STAMINA_VECTORS", "x, quantizeStaminaHundredths(x) (decimal)", stamina),
    section("DEGREES_TO_U16_VECTORS", "deg, degreesToU16(deg) (decimal)", degrees),
    section("MULBERRY32_VECTORS", "seed, index (decimal), index-th nextU32()", mulberry),
    section(
      "MULBERRY32_DRAW_VECTORS",
      `seed, row (decimal), then from Mulberry32(seed) after 5·row draws: nextFloat(), nextInt(3), nextInt(6), nextInt(100), nextInt(${0x200000}) (decimal)`,
      draws,
    ),
    section("HASH32_VECTORS", "seed, a, b, c, d, hash32(seed, a, b, c, d)", hashes),
  ].join("\n");
}
