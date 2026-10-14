import { describe, expect, it } from "vitest";
import { BitReader, BitWriter } from "../../src/net/bitstream";
import { decodePlayerState, encodePlayerState } from "../../src/net/playerStateCodec";
import { MAX_UNRELIABLE_BYTES } from "../../src/net/protocol";
import {
  decodeSnapshotBody,
  decodeSnapshotHeader,
  encodeSnapshot,
  SnapshotHeader,
} from "../../src/net/snapshot";
import {
  copySlot,
  frameDigest,
  LF_COUNT,
  playerStateToSlot,
  slotToPlayerState,
  WorldFrame,
} from "../../src/net/worldFrame";
import { ENTITY_FLAG_MASK } from "../../src/sim/entity";
import {
  ARMOR_VEST,
  copyPlayerState,
  diffPlayerState,
  PlayerState,
  PMF_CLIMBING,
  PMF_GROUNDED,
  playerStateEquals,
  quantizePlayerState,
  resetPlayerStateForSpawn,
} from "../../src/sim/playerState";

// The behavioural field guard (M4 design §2.2, D-053). A list of field names drifts from the code
// and can't see a field copied wrong, so this guard walks the keys of `new PlayerState()` itself:
// for each field (each axis of the vectors) it sets a distinct in-range value on a quantized state
// and checks that every path a predicted state travels keeps it: copy, equals, diff, quantize, the
// full PlayerState codec, the full and delta snapshot codecs, the frame's slot conversions,
// copySlot, frameDigest and the spawn reset, and that a remote's record never carries a field the
// entity record does not (the remote zeroing). A new PlayerState field that one of them misses
// fails here. State kept outside PlayerState is the restart-from-the-wire legs' job.

type Fields = Record<string, number | Float64Array>;
const fieldsOf = (ps: PlayerState): Fields => ps as unknown as Fields;

/** The remote's fields an entity record carries (M3 design §2.1): the rest are local-block only. */
const ENTITY_FIELDS = new Set(["origin", "viewYaw", "viewPitch", "flags"]);
/** Fields the spawn reset leaves to the caller (a spawn point, a teleport, a placement). */
const SPAWN_KEPT = new Set(["origin", "viewYaw", "viewPitch"]);

const SELF = 9;
const REMOTE = 20;
const TICK = 1000;

/** Every field away from 0 and in range, CLIMBING set so the climb fields may hold values. */
function baseState(): PlayerState {
  const ps = new PlayerState();
  ps.origin.set([100.5, -2.25, 64]);
  ps.velocity.set([320, -0.0625, 270]);
  ps.viewYaw = 16384;
  ps.viewPitch = 3000;
  ps.flags = PMF_GROUNDED | PMF_CLIMBING;
  ps.groundEntity = 12;
  ps.waterLevel = 1;
  ps.stamina = 7500;
  ps.wallJumps = 2;
  ps.health = 8000;
  ps.armor = ARMOR_VEST;
  ps.submerged = 300;
  ps.climbHeight = -640;
  ps.climbYaw = 200;
  ps.regenDelay = 30;
  ps.kickCooldown = 12;
  ps.regrab = 9;
  ps.waterJump = 20;
  ps.bandage = 100;
  return quantizePlayerState(ps);
}

interface Mutation {
  /** As diffPlayerState names it: "origin[1]", "health". */
  readonly label: string;
  readonly key: string;
  readonly apply: (ps: PlayerState) => void;
}

/**
 * One mutation per field and axis: the first of value ± 1 (± 1/16 for a vector axis, on both
 * grids) that quantize keeps. A field quantize can't keep at either neighbour fails the guard.
 */
function mutations(): Mutation[] {
  const out: Mutation[] = [];
  const base = baseState();
  for (const [key, value] of Object.entries(fieldsOf(base))) {
    const axes = typeof value === "number" ? 1 : value.length;
    for (let i = 0; i < axes; i++) {
      const label = typeof value === "number" ? key : `${key}[${i}]`;
      const step = typeof value === "number" ? 1 : 1 / 16;
      const read = (ps: PlayerState): number => {
        const v = fieldsOf(ps)[key] as number | Float64Array;
        return typeof v === "number" ? v : (v[i] as number);
      };
      const write = (ps: PlayerState, x: number): void => {
        const f = fieldsOf(ps);
        const v = f[key] as number | Float64Array;
        if (typeof v === "number") f[key] = x;
        else v[i] = x;
      };
      let chosen: number | null = null;
      for (const candidate of [read(base) + step, read(base) - step]) {
        const probe = copyPlayerState(new PlayerState(), base);
        write(probe, candidate);
        if (read(quantizePlayerState(probe)) === candidate) {
          chosen = candidate;
          break;
        }
      }
      if (chosen === null) throw new Error(`quantize keeps no neighbour of ${label}`);
      const x = chosen;
      out.push({ label, key, apply: (ps) => write(ps, x) });
    }
  }
  return out;
}

const writer = new BitWriter(MAX_UNRELIABLE_BYTES);
const reader = new BitReader();
const hdr = new SnapshotHeader();
const hdrIn = new SnapshotHeader();

/** A server frame of TICK: SELF (and REMOTE when given) present with the states. */
function frameOf(self: PlayerState, remote: PlayerState | null = null): WorldFrame {
  const f = new WorldFrame();
  f.setPresent(SELF, TICK);
  playerStateToSlot(f, SELF, self);
  if (remote !== null) {
    f.setPresent(REMOTE, TICK);
    playerStateToSlot(f, REMOTE, remote);
  }
  return f;
}

/**
 * Encodes `cur` for SELF (against `base`, null: full) and decodes it into a frame whose lanes are
 * dirty, as the client's reused spare frame is (`WorldFrame.clear` keeps them), so a remote's lanes
 * read 0 only because the decoder clears them.
 */
function roundTrip(cur: WorldFrame, base: WorldFrame | null, baseBack = 0): WorldFrame {
  hdr.serverTick = TICK;
  hdr.baseBack = base === null ? 0 : baseBack;
  writer.reset();
  expect(encodeSnapshot(writer, hdr, cur, base, SELF)).toBe(true);
  reader.reset(writer.bytes, writer.byteLength);
  const out = new WorldFrame();
  out.locals.fill(77);
  expect(decodeSnapshotHeader(reader, hdrIn)).toBe(true);
  expect(decodeSnapshotBody(reader, hdrIn, base, SELF, out)).toBe(true);
  return out;
}

function stateOf(f: WorldFrame, slot: number): PlayerState {
  const ps = new PlayerState();
  slotToPlayerState(f, slot, ps);
  return ps;
}

describe("the behavioural PlayerState field guard (M4 design §2.2, D-053)", () => {
  const all = mutations();

  it("covers every field: 6 vector axes and 17 scalars, 11 of them in the frame's local lanes", () => {
    const keys = Object.keys(new PlayerState());
    expect(all).toHaveLength(keys.length - 2 + 6);
    // The v4 scalars after stamina are exactly the frame's packed local-only lanes.
    expect(keys.length - keys.indexOf("stamina") - 1).toBe(LF_COUNT);
  });

  it.each(all.map((m) => [m.label, m] as const))("%s: copy, equals and diff see it", (label, m) => {
    const a = baseState();
    const b = copyPlayerState(new PlayerState(), a);
    m.apply(b);
    expect(playerStateEquals(a, b)).toBe(false);
    expect(diffPlayerState(a, b)).toHaveLength(1);
    expect(diffPlayerState(a, b)[0]?.startsWith(`${label}: `)).toBe(true);
    const c = copyPlayerState(baseState(), b);
    expect(playerStateEquals(c, b)).toBe(true);
    expect(diffPlayerState(c, b)).toEqual([]);
  });

  it.each(all.map((m) => [m.label, m] as const))("%s: quantize and both codecs keep it", (_, m) => {
    const a = baseState();
    const b = copyPlayerState(new PlayerState(), a);
    m.apply(b);
    expect(diffPlayerState(b, quantizePlayerState(copyPlayerState(new PlayerState(), b)))).toEqual(
      [],
    );
    // The PlayerState codec.
    writer.reset();
    encodePlayerState(writer, b);
    expect(writer.error).toBe(false);
    reader.reset(writer.bytes, writer.byteLength);
    const back = new PlayerState();
    expect(decodePlayerState(reader, back)).toBe(true);
    expect(diffPlayerState(b, back)).toEqual([]);
    // A full snapshot, and a delta against a baseline holding `a`.
    expect(diffPlayerState(b, stateOf(roundTrip(frameOf(b), null), SELF))).toEqual([]);
    const baseFrame = frameOf(a);
    baseFrame.setPresent(SELF, TICK - 1);
    expect(diffPlayerState(b, stateOf(roundTrip(frameOf(b), baseFrame, 1), SELF))).toEqual([]);
  });

  it.each(all.map((m) => [m.label, m] as const))("%s: slots, copySlot and frameDigest", (_, m) => {
    const a = baseState();
    const b = copyPlayerState(new PlayerState(), a);
    m.apply(b);
    const fa = frameOf(a);
    const fb = frameOf(b);
    expect(diffPlayerState(b, stateOf(fb, SELF))).toEqual([]);
    const copy = new WorldFrame();
    copySlot(copy, SELF, fb, SELF);
    expect(diffPlayerState(b, stateOf(copy, SELF))).toEqual([]);
    expect(frameDigest(fb, SELF)).not.toBe(frameDigest(fa, SELF));
  });

  it.each(all.map((m) => [m.label, m] as const))(
    "%s: a remote carries it only if an entity record does",
    (_, m) => {
      const a = baseState();
      const b = copyPlayerState(new PlayerState(), a);
      m.apply(b);
      const carried = ENTITY_FIELDS.has(m.key);
      // A new record (readNewBody).
      const ra = stateOf(roundTrip(frameOf(a, a), null), REMOTE);
      const rb = stateOf(roundTrip(frameOf(a, b), null), REMOTE);
      const masked = m.key === "flags" && ((a.flags ^ b.flags) & ENTITY_FLAG_MASK) === 0;
      expect(playerStateEquals(ra, rb)).toBe(!carried || masked);
      // A remote unlisted in a delta (copyEntity): its local fields read 0 whatever the baseline's
      // frame held, so the receiver's view never depends on history.
      const dirtyBase = frameOf(a, b);
      dirtyBase.setPresent(SELF, TICK - 1);
      dirtyBase.setPresent(REMOTE, TICK - 1);
      const unlisted = stateOf(roundTrip(frameOf(a, b), dirtyBase, 1), REMOTE);
      expect(playerStateEquals(unlisted, stateOf(roundTrip(frameOf(a, b), null), REMOTE))).toBe(
        true,
      );
      // A pending remote (setPending): every field 0.
      const pending = frameOf(a, b);
      pending.setPresent(REMOTE, 0);
      const p = roundTrip(pending, null);
      expect([p.present[REMOTE], p.stamp[REMOTE]]).toEqual([1, 0]);
      const zero = new PlayerState();
      zero.groundEntity = -1;
      expect(diffPlayerState(zero, stateOf(p, REMOTE))).toEqual([]);
    },
  );

  it.each(all.map((m) => [m.label, m] as const))(
    "%s: the spawn reset resets it (or keeps it for the caller)",
    (_, m) => {
      const clean = resetPlayerStateForSpawn(baseState(), ARMOR_VEST);
      const dirty = baseState();
      m.apply(dirty);
      resetPlayerStateForSpawn(dirty, ARMOR_VEST);
      expect(playerStateEquals(dirty, clean)).toBe(!SPAWN_KEPT.has(m.key));
    },
  );
});
