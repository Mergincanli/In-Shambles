import { describe, expect, it } from "vitest";
import { BitReader, BitWriter } from "../../src/net/bitstream";
import {
  decodePlayerState,
  encodePlayerState,
  PLAYER_STATE_BITS,
} from "../../src/net/playerStateCodec";
import { PLAYER_STATE_CVAR_LIMITS, playerStateCvarWidthError } from "../../src/net/snapshot";
import { Mulberry32 } from "../../src/rng/mulberry32";
import { ENTITY_NONE, ENTITY_WORLD } from "../../src/sim/entity";
import { PlayerState, PMF_CLIMBING, PMF_MASK, playerStateEquals } from "../../src/sim/playerState";
import { PMOVE_CVARS } from "../../src/sim/pmove/params";
import { randomState } from "../helpers/netMessages";

function roundTrip(ps: PlayerState, offset: number): { bits: number; out: PlayerState } {
  const w = new BitWriter(64);
  if (offset > 0) w.writeBits(0, offset);
  encodePlayerState(w, ps);
  expect(w.error).toBe(false);
  const r = new BitReader();
  r.reset(w.bytes, w.byteLength);
  if (offset > 0) r.readBits(offset);
  const out = new PlayerState();
  expect(decodePlayerState(r, out)).toBe(true);
  expect(r.atEnd()).toBe(true);
  return { bits: w.bitLength - offset, out };
}

describe("PlayerState codec (docs/05 §3.6)", () => {
  it("takes 281 bits (protocol v4) at any bit offset and decodes to the same state", () => {
    const rng = new Mulberry32(0x9500);
    const ps = new PlayerState();
    for (let i = 0; i < 800; i++) {
      randomState(rng, ps);
      const { bits, out } = roundTrip(ps, i & 7);
      expect(bits).toBe(PLAYER_STATE_BITS);
      expect(playerStateEquals(out, ps)).toBe(true);
    }
  });

  it("lays the fields out in docs/05 §3.6's order: each read back at its own offset", () => {
    const ps = new PlayerState();
    ps.origin.set([1 / 32, 2 / 32, 3 / 32]);
    ps.velocity.set([4 / 16, 5 / 16, 6 / 16]);
    ps.viewYaw = 7;
    ps.viewPitch = 8;
    ps.flags = PMF_CLIMBING | 1;
    ps.groundEntity = 9;
    ps.waterLevel = 2;
    ps.stamina = 11;
    ps.wallJumps = 5;
    ps.health = 13;
    ps.armor = 1;
    ps.submerged = 14;
    ps.climbHeight = -15;
    ps.climbYaw = 16;
    ps.regenDelay = 17;
    ps.kickCooldown = 18;
    ps.regrab = 3;
    ps.waterJump = 19;
    ps.bandage = 20;
    const w = new BitWriter(64);
    encodePlayerState(w, ps);
    expect(w.error).toBe(false);
    const r = new BitReader();
    r.reset(w.bytes, w.byteLength);
    // [width, signed] per field in the table's order; groundEntity is sent + 1.
    const layout: [number, boolean][] = [
      [21, true],
      [21, true],
      [21, true],
      [20, true],
      [20, true],
      [20, true],
      [16, false],
      [16, false],
      [11, false],
      [16, false],
      [2, false],
      [16, false],
      [3, false],
      [14, false],
      [2, false],
      [11, false],
      [12, true],
      [8, false],
      [7, false],
      [6, false],
      [4, false],
      [6, false],
      [8, false],
    ];
    const got = layout.map(([bits, signed]) => (signed ? r.readSigned(bits) : r.readBits(bits)));
    expect(got).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 2, 11, 5, 13, 1, 14, -15, 16, 17, 18, 3, 19, 20,
    ]);
    expect(r.atEnd()).toBe(true);
  });

  it("carries the ends of every range", () => {
    const ps = new PlayerState();
    ps.origin.set([-16384, 16384, -1 / 32]);
    ps.velocity.set([524287 / 16, -524287 / 16, 1 / 16]);
    ps.viewYaw = 0xffff;
    ps.viewPitch = -16201 & 0xffff;
    ps.flags = PMF_MASK;
    ps.waterLevel = 3;
    ps.stamina = 0xffff;
    ps.wallJumps = 7;
    ps.health = 16383;
    ps.armor = 3;
    ps.submerged = 2047;
    ps.climbYaw = 255;
    ps.regenDelay = 127;
    ps.kickCooldown = 63;
    ps.regrab = 15;
    ps.waterJump = 63;
    ps.bandage = 255;
    for (const g of [ENTITY_NONE, 0, ENTITY_WORLD]) {
      ps.groundEntity = g;
      for (const climb of [-2048, 0, 2047]) {
        ps.climbHeight = climb;
        expect(playerStateEquals(roundTrip(ps, 3).out, ps)).toBe(true);
      }
    }
  });

  it("refuses a state the v4 widths can't carry or the canonical rule forbids (M4 design §2.2)", () => {
    const refused: [string, (ps: PlayerState) => void][] = [
      ["flag bit 11", (ps) => (ps.flags = 1 << 11)],
      ["wallJumps 8", (ps) => (ps.wallJumps = 8)],
      ["health 16384", (ps) => (ps.health = 16384)],
      ["health −1", (ps) => (ps.health = -1)],
      ["armor 4", (ps) => (ps.armor = 4)],
      ["submerged 2048", (ps) => (ps.submerged = 2048)],
      ["regenDelay 128", (ps) => (ps.regenDelay = 128)],
      ["kickCooldown 64", (ps) => (ps.kickCooldown = 64)],
      ["regrab 16", (ps) => (ps.regrab = 16)],
      ["waterJump 64", (ps) => (ps.waterJump = 64)],
      ["bandage 256", (ps) => (ps.bandage = 256)],
      ["health off the grid", (ps) => (ps.health = 1.5)],
      [
        "climbHeight 2048",
        (ps) => {
          ps.flags = PMF_CLIMBING;
          ps.climbHeight = 2048;
        },
      ],
      ["climbHeight without CLIMBING", (ps) => (ps.climbHeight = -1)],
      ["climbYaw without CLIMBING", (ps) => (ps.climbYaw = 1)],
    ];
    for (const [label, edit] of refused) {
      const ps = new PlayerState();
      edit(ps);
      const w = new BitWriter(64);
      encodePlayerState(w, ps);
      expect(w.error, label).toBe(true);
    }
  });

  it("decodes a climb field without CLIMBING to false (the canonical rule)", () => {
    // flags at 155 (11 bits), climbHeight at 230 (i12), climbYaw at 242: patch a valid state.
    const ps = new PlayerState();
    ps.flags = PMF_CLIMBING;
    ps.climbHeight = 5;
    const w = new BitWriter(64);
    encodePlayerState(w, ps);
    const decodes = (flags: number) => {
      const bytes = w.bytes.slice(0, w.byteLength);
      for (let b = 0; b < 11; b++) {
        const at = 155 + b;
        const bit = (flags >> b) & 1;
        bytes[at >> 3] = ((bytes[at >> 3] as number) & ~(1 << (at & 7))) | (bit << (at & 7));
      }
      const r = new BitReader();
      r.reset(bytes, bytes.length);
      return decodePlayerState(r, new PlayerState());
    };
    expect(decodes(PMF_CLIMBING)).toBe(true);
    expect(decodes(0)).toBe(false);
  });

  it("decodes to false on a short read", () => {
    const w = new BitWriter(64);
    encodePlayerState(w, new PlayerState());
    const r = new BitReader();
    r.reset(w.bytes, 24);
    expect(decodePlayerState(r, new PlayerState())).toBe(false);
  });
});

describe("the v4 cvar width checks (M4 design §2.2, D-053)", () => {
  it("hold for the design ranges and every registered row", () => {
    expect(playerStateCvarWidthError(PMOVE_CVARS)).toBeNull();
    expect(PLAYER_STATE_CVAR_LIMITS.map((l) => l.cvar)).toEqual([
      "st_regenDelay",
      "pm_kickCooldown",
      "pm_regrabDelay",
      "pm_climbFinishTime",
      "pm_waterJumpTime",
      "bd_time",
      "pm_maxWallJumps",
      "pm_ledgeMaxHeight",
      "pm_climbPopHeight",
    ]);
  });

  it("refuse a cvar range its field can't hold", () => {
    const row = (name: string, min: number, max: number) => [{ name, min, max }];
    expect(playerStateCvarWidthError(row("st_regenDelay", 0, 2.1))).toBeNull();
    expect(playerStateCvarWidthError(row("st_regenDelay", 0, 2.2))).toMatch(/st_regenDelay/);
    expect(playerStateCvarWidthError(row("pm_kickCooldown", 0, 1.1))).toMatch(/pm_kickCooldown/);
    expect(playerStateCvarWidthError(row("pm_maxWallJumps", 0, 8))).toMatch(/pm_maxWallJumps/);
    expect(playerStateCvarWidthError(row("pm_ledgeMaxHeight", 0, 88))).toMatch(/ledgeMax/);
    expect(playerStateCvarWidthError(row("pm_ledgeMaxHeight", 0, 87.96875))).toBeNull();
    expect(playerStateCvarWidthError(row("pm_climbPopHeight", -9, 16))).toMatch(/PopHeight/);
    expect(playerStateCvarWidthError(row("bd_time", 0, 4.3))).toMatch(/bd_time/);
    // A cvar the table does not name is not its concern.
    expect(playerStateCvarWidthError(row("pm_runSpeed", 0, 1e6))).toBeNull();
  });
});
