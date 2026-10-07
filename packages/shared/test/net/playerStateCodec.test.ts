import { describe, expect, it } from "vitest";
import { BitReader, BitWriter } from "../../src/net/bitstream";
import {
  decodePlayerState,
  encodePlayerState,
  PLAYER_STATE_BITS,
} from "../../src/net/playerStateCodec";
import { Mulberry32 } from "../../src/rng/mulberry32";
import { ENTITY_NONE, ENTITY_WORLD } from "../../src/sim/entity";
import { PlayerState, playerStateEquals } from "../../src/sim/playerState";
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
  it("takes 199 bits at any bit offset and decodes to the same state", () => {
    const rng = new Mulberry32(0x9500);
    const ps = new PlayerState();
    for (let i = 0; i < 800; i++) {
      randomState(rng, ps);
      const { bits, out } = roundTrip(ps, i & 7);
      expect(bits).toBe(PLAYER_STATE_BITS);
      expect(playerStateEquals(out, ps)).toBe(true);
    }
  });

  it("carries the ends of every range", () => {
    const ps = new PlayerState();
    ps.origin.set([-16384, 16384, -1 / 32]);
    ps.velocity.set([524287 / 16, -524287 / 16, 1 / 16]);
    ps.viewYaw = 0xffff;
    ps.viewPitch = -16201 & 0xffff;
    ps.flags = 0x3ff;
    ps.waterLevel = 3;
    ps.stamina = 0xffff;
    for (const g of [ENTITY_NONE, 0, ENTITY_WORLD]) {
      ps.groundEntity = g;
      expect(playerStateEquals(roundTrip(ps, 3).out, ps)).toBe(true);
    }
  });

  it("decodes to false on a short read", () => {
    const w = new BitWriter(64);
    encodePlayerState(w, new PlayerState());
    const r = new BitReader();
    r.reset(w.bytes, 24);
    expect(decodePlayerState(r, new PlayerState())).toBe(false);
  });
});
