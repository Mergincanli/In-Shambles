import { afterEach, describe, expect, it } from "vitest";
import { setDevAsserts } from "../src/debug/assert";
import { cosU16, dcos, dsin, sinU16 } from "../src/math/dtrig";
import {
  degreesToU16,
  quantizeOrigin,
  quantizeStaminaHundredths,
  quantizeVelocity,
} from "../src/math/quant";
import { hash32 } from "../src/rng/hash32";
import { Mulberry32 } from "../src/rng/mulberry32";
import { PlayerState, quantizePlayerState } from "../src/sim/playerState";
import { sanitizeUserCmd, UserCmd } from "../src/sim/usercmd";
import { f64ToHex, hexToF64 } from "./helpers/f64";
import {
  DEGREES_TO_U16_VECTORS,
  DTRIG_VECTORS,
  HASH32_VECTORS,
  MULBERRY32_DRAW_VECTORS,
  MULBERRY32_VECTORS,
  PLAYER_STATE_QUANT_VECTORS,
  QUANT_ORIGIN_VECTORS,
  QUANT_STAMINA_VECTORS,
  QUANT_VELOCITY_VECTORS,
  U16_TRIG_DIGEST_VECTORS,
  U16_TRIG_VECTORS,
  USERCMD_SANITIZE_VECTORS,
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
  afterEach(() => setDevAsserts(true));

  it.each([
    ["DTRIG_VECTORS", DTRIG_VECTORS, 150],
    ["U16_TRIG_VECTORS", U16_TRIG_VECTORS, 256],
    ["U16_TRIG_DIGEST_VECTORS", U16_TRIG_DIGEST_VECTORS, 4],
    ["QUANT_ORIGIN_VECTORS", QUANT_ORIGIN_VECTORS, 30],
    ["QUANT_VELOCITY_VECTORS", QUANT_VELOCITY_VECTORS, 30],
    ["QUANT_STAMINA_VECTORS", QUANT_STAMINA_VECTORS, 8],
    ["DEGREES_TO_U16_VECTORS", DEGREES_TO_U16_VECTORS, 8],
    ["MULBERRY32_VECTORS", MULBERRY32_VECTORS, 64],
    ["MULBERRY32_DRAW_VECTORS", MULBERRY32_DRAW_VECTORS, 32],
    ["HASH32_VECTORS", HASH32_VECTORS, 16],
    ["PLAYER_STATE_QUANT_VECTORS", PLAYER_STATE_QUANT_VECTORS, 20],
    ["USERCMD_SANITIZE_VECTORS", USERCMD_SANITIZE_VECTORS, 20],
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

  it("sinU16 and cosU16 over all 65536 angles, by digest", () => {
    // FNV-1a 32 over the rows in U16_TRIG_VECTORS format, each followed by a newline.
    let covered = 0;
    const got = mismatches(U16_TRIG_DIGEST_VECTORS, ([first, last]) => {
      let h = 0x811c9dc5;
      for (let a = Number(first); a <= Number(last); a++) {
        const row = `${a} ${f64ToHex(sinU16(a))} ${f64ToHex(cosU16(a))}\n`;
        for (let i = 0; i < row.length; i++) h = Math.imul(h ^ row.charCodeAt(i), 0x01000193);
        covered++;
      }
      return `${first} ${last} ${(h >>> 0).toString(16).padStart(8, "0")}`;
    });
    expect(got).toEqual([]);
    expect(covered).toBe(65536);
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

  it("quantizePlayerState (prod path: DEV_ASSERT off)", () => {
    setDevAsserts(false);
    const ps = new PlayerState();
    const got = mismatches(PLAYER_STATE_QUANT_VECTORS, (f) => {
      const x = (i: number) => f64(f[i]);
      ps.origin.set([x(0), x(1), x(2)]);
      ps.velocity.set([x(3), x(4), x(5)]);
      ps.viewYaw = x(6);
      ps.viewPitch = x(7);
      ps.flags = x(8);
      ps.groundEntity = x(9);
      ps.waterLevel = x(10);
      ps.stamina = x(11);
      quantizePlayerState(ps);
      const vectors = [...ps.origin, ...ps.velocity].map(f64ToHex);
      const ints = [ps.viewYaw, ps.viewPitch, ps.flags, ps.groundEntity, ps.waterLevel, ps.stamina];
      return [...f.slice(0, 12), ...vectors, ...ints].join(" ");
    });
    expect(got).toEqual([]);
  });

  it("sanitizeUserCmd", () => {
    const cmd = new UserCmd();
    const got = mismatches(USERCMD_SANITIZE_VECTORS, (f) => {
      const x = (i: number) => f64(f[i]);
      cmd.tick = x(0);
      cmd.buttons = x(1);
      cmd.forward = x(2);
      cmd.right = x(3);
      cmd.up = x(4);
      cmd.yaw = x(5);
      cmd.pitch = x(6);
      cmd.weaponSlot = x(7);
      sanitizeUserCmd(cmd);
      const out = [cmd.tick, cmd.buttons, cmd.forward, cmd.right, cmd.up, cmd.yaw, cmd.pitch];
      return [...f.slice(0, 8), ...out, cmd.weaponSlot].join(" ");
    });
    expect(got).toEqual([]);
  });
});
