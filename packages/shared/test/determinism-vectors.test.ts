import { describe, expect, it } from "vitest";
import { cosU16, dcos, dsin, sinU16 } from "../src/math/dtrig";
import {
  degreesToU16,
  quantizeOrigin,
  quantizeStaminaHundredths,
  quantizeVelocity,
} from "../src/math/quant";
import { hash32 } from "../src/rng/hash32";
import { Mulberry32 } from "../src/rng/mulberry32";
import { f64ToHex, hexToF64 } from "./helpers/f64";
import {
  DEGREES_TO_U16_VECTORS,
  DTRIG_VECTORS,
  HASH32_VECTORS,
  MULBERRY32_DRAW_VECTORS,
  MULBERRY32_VECTORS,
  QUANT_ORIGIN_VECTORS,
  QUANT_STAMINA_VECTORS,
  QUANT_VELOCITY_VECTORS,
  U16_TRIG_VECTORS,
} from "./vectors/determinism";

// Risk 2 of the M1 plan: the committed vectors pin the exact bits of the D-016 math. This test
// recomputes them here; M2 replays the same file in Chrome, Firefox and Safari.
const fields = (row: string) => row.split(" ");
const u32 = (hex: string | undefined) => Number.parseInt(hex ?? "", 16);
const f64 = (hex: string | undefined) => hexToF64(hex ?? "");

/** Rows whose recomputed fields differ, as "row → recomputed", so a failure shows every case. */
function mismatches(rows: readonly string[], recompute: (f: string[]) => string): string[] {
  return rows.flatMap((row) => {
    const again = recompute(fields(row));
    return again === row ? [] : [`${row} → ${again}`];
  });
}

describe("determinism vectors (D-016)", () => {
  it.each([
    ["DTRIG_VECTORS", DTRIG_VECTORS, 150],
    ["U16_TRIG_VECTORS", U16_TRIG_VECTORS, 256],
    ["QUANT_ORIGIN_VECTORS", QUANT_ORIGIN_VECTORS, 30],
    ["QUANT_VELOCITY_VECTORS", QUANT_VELOCITY_VECTORS, 30],
    ["QUANT_STAMINA_VECTORS", QUANT_STAMINA_VECTORS, 8],
    ["DEGREES_TO_U16_VECTORS", DEGREES_TO_U16_VECTORS, 8],
    ["MULBERRY32_VECTORS", MULBERRY32_VECTORS, 64],
    ["MULBERRY32_DRAW_VECTORS", MULBERRY32_DRAW_VECTORS, 32],
    ["HASH32_VECTORS", HASH32_VECTORS, 16],
  ])("%s has its rows", (_name, rows, min) => {
    expect(rows.length).toBeGreaterThanOrEqual(min);
  });

  it("dsin and dcos", () => {
    const got = mismatches(DTRIG_VECTORS, ([x]) => {
      const v = f64(x);
      return `${x} ${f64ToHex(dsin(v))} ${f64ToHex(dcos(v))}`;
    });
    expect(got).toEqual([]);
  });

  it("sinU16 and cosU16", () => {
    const got = mismatches(U16_TRIG_VECTORS, ([a]) => {
      const v = Number(a);
      return `${a} ${f64ToHex(sinU16(v))} ${f64ToHex(cosU16(v))}`;
    });
    expect(got).toEqual([]);
  });

  it("quantizers", () => {
    expect(
      mismatches(QUANT_ORIGIN_VECTORS, ([x]) => `${x} ${f64ToHex(quantizeOrigin(f64(x)))}`),
    ).toEqual([]);
    expect(
      mismatches(QUANT_VELOCITY_VECTORS, ([x]) => `${x} ${f64ToHex(quantizeVelocity(f64(x)))}`),
    ).toEqual([]);
    expect(
      mismatches(QUANT_STAMINA_VECTORS, ([x]) => `${x} ${quantizeStaminaHundredths(f64(x))}`),
    ).toEqual([]);
    expect(mismatches(DEGREES_TO_U16_VECTORS, ([x]) => `${x} ${degreesToU16(f64(x))}`)).toEqual([]);
  });

  it("Mulberry32", () => {
    const got = mismatches(MULBERRY32_VECTORS, ([seed, index]) => {
      const rng = new Mulberry32(u32(seed));
      for (let i = 0; i < Number(index); i++) rng.nextU32();
      return `${seed} ${index} ${rng.nextU32().toString(16).padStart(8, "0")}`;
    });
    expect(got).toEqual([]);
  });

  it("Mulberry32 nextFloat and nextInt", () => {
    const got = mismatches(MULBERRY32_DRAW_VECTORS, ([seed, row]) => {
      const rng = new Mulberry32(u32(seed));
      for (let i = 0; i < 5 * Number(row); i++) rng.nextU32();
      const x = f64ToHex(rng.nextFloat());
      const ints = [rng.nextInt(3), rng.nextInt(6), rng.nextInt(100), rng.nextInt(0x200000)];
      return `${seed} ${row} ${x} ${ints.join(" ")}`;
    });
    expect(got).toEqual([]);
  });

  it("hash32", () => {
    const got = mismatches(HASH32_VECTORS, (f) => {
      const h = hash32(u32(f[0]), u32(f[1]), u32(f[2]), u32(f[3]), u32(f[4]));
      return `${f.slice(0, 5).join(" ")} ${h.toString(16).padStart(8, "0")}`;
    });
    expect(got).toEqual([]);
  });
});
