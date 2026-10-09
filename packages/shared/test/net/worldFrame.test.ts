import { describe, expect, it } from "vitest";
import {
  copySlot,
  ENTITY_EVENT_SLOTS,
  ENTITY_LAND_VALUE_MAX,
  entityEquals,
  entityEventValue,
  entityVelocity,
  FRAME_SLOTS,
  FrameRing,
  frameDigest,
  MASK_PENDING_HI,
  MASK_PENDING_LO,
  MASK_PRESENT_HI,
  MASK_PRESENT_LO,
  playerStateToSlot,
  pushEntityEvent,
  slotToPlayerState,
  WorldFrame,
} from "../../src/net/worldFrame";
import { Mulberry32 } from "../../src/rng/mulberry32";
import { ENTITY_FLAG_MASK, MATCH_MAX_CLIENTS } from "../../src/sim/entity";
import { PMEV_JUMP, PMEV_LAND, PMEV_NONE, PMEV_STEP, PmoveEvent } from "../../src/sim/events";
import {
  PlayerState,
  PMF_CROUCH_PRESSED_IN_AIR,
  PMF_JUMP_HELD,
  PMF_MASK,
  playerStateEquals,
} from "../../src/sim/playerState";
import { randomEntity, randomFrame, randomState } from "../helpers/netMessages";

describe("WorldFrame (M3 design §2.2)", () => {
  it("has a slot per client id, and the entity flag mask drops the owner-only bits", () => {
    expect(FRAME_SLOTS).toBe(MATCH_MAX_CLIENTS);
    expect(MATCH_MAX_CLIENTS).toBe(64);
    expect(ENTITY_FLAG_MASK).toBe(PMF_MASK & ~(PMF_JUMP_HELD | PMF_CROUCH_PRESSED_IN_AIR));
  });

  it("carries a quantized PlayerState through a slot bit for bit", () => {
    const rng = new Mulberry32(0x51a7);
    const f = new WorldFrame();
    const ps = new PlayerState();
    const back = new PlayerState();
    for (let i = 0; i < 2000; i++) {
      randomState(rng, ps);
      const slot = rng.nextInt(FRAME_SLOTS);
      playerStateToSlot(f, slot, ps);
      slotToPlayerState(f, slot, back);
      expect(playerStateEquals(back, ps)).toBe(true);
      for (let a = 0; a < 3; a++) {
        expect(Object.is(back.origin[a], ps.origin[a])).toBe(true);
        expect(Object.is(back.velocity[a], ps.velocity[a])).toBe(true);
      }
      expect(f.entVelX[slot]).toBe(entityVelocity(ps.velocity[0] * 16));
    }
  });

  it("rounds the entity velocity to 1 u/s half up and clamps it to ±32767", () => {
    expect([entityVelocity(0), entityVelocity(7), entityVelocity(8), entityVelocity(-8)]).toEqual([
      0, 0, 1, 0,
    ]);
    expect([entityVelocity(-9), entityVelocity(-24), entityVelocity(-25)]).toEqual([-1, -1, -2]);
    expect([entityVelocity(524287), entityVelocity(-524287)]).toEqual([32767, -32767]);
  });

  it("keeps the present and pending masks in step with the slots", () => {
    const f = new WorldFrame();
    expect([f.presentCount, f.pendingCount]).toEqual([0, 0]);
    f.setPresent(0, 5);
    f.setPresent(31, 5);
    f.setPresent(32, 0);
    f.setPresent(63, 7);
    expect([f.presentCount, f.pendingCount]).toEqual([4, 1]);
    expect(f.masks[MASK_PRESENT_LO]).toBe(1 | (1 << 31) | 0);
    expect(f.masks[MASK_PRESENT_HI]).toBe(1 | (1 << 31) | 0);
    expect([f.masks[MASK_PENDING_LO], f.masks[MASK_PENDING_HI]]).toEqual([0, 1]);
    // Pending → state, state → absent.
    f.setPresent(32, 9);
    f.setAbsent(31);
    expect([f.presentCount, f.pendingCount, f.present[31], f.stamp[31]]).toEqual([3, 0, 0, 0]);
    f.clear();
    expect([f.presentCount, f.pendingCount, f.present[63]]).toEqual([0, 0, 0]);
    expect(Array.from(f.masks)).toEqual([0, 0, 0, 0]);
  });

  /** Every per-slot array of a frame, by name (the event arrays hold ENTITY_EVENT_SLOTS each). */
  const slotArrays = (f: WorldFrame): [string, { [i: number]: number }, number][] => [
    ["serial", f.serial, 1],
    ["originX", f.originX, 1],
    ["originY", f.originY, 1],
    ["originZ", f.originZ, 1],
    ["vel16X", f.vel16X, 1],
    ["vel16Y", f.vel16Y, 1],
    ["vel16Z", f.vel16Z, 1],
    ["entVelX", f.entVelX, 1],
    ["entVelY", f.entVelY, 1],
    ["entVelZ", f.entVelZ, 1],
    ["yaw", f.yaw, 1],
    ["pitch", f.pitch, 1],
    ["flags", f.flags, 1],
    ["ground1", f.ground1, 1],
    ["waterLevel", f.waterLevel, 1],
    ["stamina", f.stamina, 1],
    ["team", f.team, 1],
    ["teleportSeq", f.teleportSeq, 1],
    ["eventSeq", f.eventSeq, 1],
    ["evKind", f.evKind, ENTITY_EVENT_SLOTS],
    ["evValue", f.evValue, ENTITY_EVENT_SLOTS],
  ];

  it("copies every field of a slot, presence and stamp included", () => {
    const rng = new Mulberry32(0xc0b1);
    const a = new WorldFrame();
    const b = new WorldFrame();
    const src = slotArrays(a);
    const dst = slotArrays(b);
    for (let i = 0; i < 200; i++) {
      const s = rng.nextInt(FRAME_SLOTS);
      const d = rng.nextInt(FRAME_SLOTS);
      a.setPresent(s, 1 + rng.nextInt(1000));
      for (let k = 0; k < src.length; k++) {
        const [, sa, n] = src[k] as [string, { [i: number]: number }, number];
        const da = (dst[k] as [string, { [i: number]: number }, number])[1];
        for (let j = 0; j < n; j++) {
          sa[s * n + j] = 1 + rng.nextInt(100);
          da[d * n + j] = (sa[s * n + j] as number) + 1; // so a field left uncopied shows
        }
      }
      copySlot(b, d, a, s);
      expect([b.present[d], b.stamp[d], b.presentCount]).toEqual([1, a.stamp[s], 1]);
      for (let k = 0; k < src.length; k++) {
        const [name, sa, n] = src[k] as [string, { [i: number]: number }, number];
        const da = (dst[k] as [string, { [i: number]: number }, number])[1];
        for (let j = 0; j < n; j++) expect(da[d * n + j], name).toBe(sa[s * n + j]);
      }
      expect(entityEquals(a, s, b, d)).toBe(true);
      a.setAbsent(s);
      b.setAbsent(d);
    }
    // An absent source slot makes the target absent, masks included.
    b.clear();
    b.setPresent(4, 2);
    copySlot(b, 4, a, 3);
    expect([b.present[4], b.presentCount]).toEqual([0, 0]);
  });

  it("compares entity state on exactly the fields a record carries", () => {
    const rng = new Mulberry32(0xe9a1);
    const a = new WorldFrame();
    const b = new WorldFrame();
    randomEntity(rng, a, 7, 50);
    copySlot(b, 12, a, 7);
    expect(entityEquals(a, 7, b, 12)).toBe(true);
    const carried = new Set([
      "originX",
      "originY",
      "originZ",
      "entVelX",
      "entVelY",
      "entVelZ",
      "yaw",
      "pitch",
      "team",
      "teleportSeq",
      "eventSeq",
      "evKind",
      "evValue",
    ]);
    for (const [name, arr, n] of slotArrays(b)) {
      if (name === "flags") continue;
      for (let j = 0; j < n; j++) {
        const at = 12 * n + j;
        const was = arr[at] as number;
        arr[at] = was ^ 1;
        expect(entityEquals(a, 7, b, 12), `${name}[${j}]`).toBe(!carried.has(name));
        arr[at] = was;
      }
    }
    // Each flag bit counts exactly when the entity carries it (ENTITY_FLAG_MASK).
    for (let bit = 0; bit < 16; bit++) {
      const was = b.flags[12] as number;
      b.flags[12] = was ^ (1 << bit);
      expect(entityEquals(a, 7, b, 12), `flag bit ${bit}`).toBe(
        (ENTITY_FLAG_MASK & (1 << bit)) === 0,
      );
      b.flags[12] = was;
    }
    expect(entityEquals(a, 7, b, 12)).toBe(true);
  });

  it("digests what a receiver holds: every carried field counts, nothing else does", () => {
    const rng = new Mulberry32(0xd16e);
    const f = new WorldFrame();
    randomFrame(rng, f, 300, 5, 20);
    const remote = f.present.indexOf(1, 6);
    const base = frameDigest(f, 5);
    expect(frameDigest(f, 5)).toBe(base);
    const changes: [string, () => void, () => void][] = [];
    const field = (name: string, arr: { [i: number]: number }, slot: number, delta = 1) => {
      changes.push([
        `${name}[${slot}]`,
        () => {
          arr[slot] = (arr[slot] as number) + delta;
        },
        () => {
          arr[slot] = (arr[slot] as number) - delta;
        },
      ]);
    };
    for (const [name, arr] of [
      ["originX", f.originX],
      ["originY", f.originY],
      ["originZ", f.originZ],
      ["vel16X", f.vel16X],
      ["vel16Z", f.vel16Z],
      ["yaw", f.yaw],
      ["flags", f.flags],
      ["ground1", f.ground1],
      ["waterLevel", f.waterLevel],
      ["stamina", f.stamina],
      ["teleportSeq", f.teleportSeq],
    ] as const) {
      field(name, arr, 5);
    }
    for (const [name, arr] of [
      ["originX", f.originX],
      ["originZ", f.originZ],
      ["entVelX", f.entVelX],
      ["entVelZ", f.entVelZ],
      ["yaw", f.yaw],
      ["team", f.team],
      ["teleportSeq", f.teleportSeq],
      ["eventSeq", f.eventSeq],
    ] as const) {
      field(name, arr, remote);
    }
    field("pitch", f.pitch, remote, f.pitch[remote] === 0 ? 1 : -1);
    field("flags", f.flags, remote, (f.flags[remote] as number) & 1 ? -1 : 1);
    field("evKind", f.evKind, remote * ENTITY_EVENT_SLOTS, f.evKind[remote * 2] === 3 ? -1 : 1);
    field(
      "evValue",
      f.evValue,
      remote * ENTITY_EVENT_SLOTS + 1,
      f.evValue[remote * 2 + 1] ? -1 : 1,
    );
    field("stamp", f.stamp, remote);
    for (const [label, change, undo] of changes) {
      change();
      expect(frameDigest(f, 5), label).not.toBe(base);
      undo();
      expect(frameDigest(f, 5)).toBe(base);
    }
    // Not carried: the receiver's team, events and entity velocity, a remote's local-block
    // fields and owner-only flags, any serial.
    const ignored: [string, () => void][] = [
      ["team[self]", () => (f.team[5] = (f.team[5] as number) ^ 1)],
      ["eventSeq[self]", () => (f.eventSeq[5] = (f.eventSeq[5] as number) + 1)],
      ["entVelX[self]", () => (f.entVelX[5] = (f.entVelX[5] as number) + 1)],
      ["vel16X[remote]", () => (f.vel16X[remote] = (f.vel16X[remote] as number) + 1)],
      ["stamina[remote]", () => (f.stamina[remote] = (f.stamina[remote] as number) + 1)],
      ["jump held[remote]", () => (f.flags[remote] = (f.flags[remote] as number) ^ PMF_JUMP_HELD)],
      ["serial", () => (f.serial[remote] = (f.serial[remote] as number) + 1)],
    ];
    for (const [label, change] of ignored) {
      change();
      expect(frameDigest(f, 5), label).toBe(base);
    }
    // Presence and pending count, and so does who the receiver is.
    expect(frameDigest(f, remote)).not.toBe(base);
    f.setPresent(remote, 0);
    expect(frameDigest(f, 5)).not.toBe(base);
    f.setAbsent(remote);
    expect(frameDigest(f, 5)).not.toBe(base);
  });
});

describe("entity events (M3 design §2.1, §2.4)", () => {
  function value(type: number, v: number): number {
    const ev = new PmoveEvent();
    ev.type = type;
    ev.value = v;
    return entityEventValue(ev);
  }

  it("quantizes STEP to whole u as i8, LAND to impact / 16 up to 255, JUMP and none to 0", () => {
    expect(value(PMEV_STEP, 16)).toBe(16);
    expect(value(PMEV_STEP, 15.5)).toBe(16);
    expect(value(PMEV_STEP, 0.25)).toBe(0);
    // Down steps are two's complement; −0 never leaks.
    expect(value(PMEV_STEP, -16.03125)).toBe(256 - 16);
    expect(value(PMEV_STEP, -0.4)).toBe(0);
    expect(Object.is(value(PMEV_STEP, -0.4), 0)).toBe(true);
    expect(value(PMEV_STEP, 400)).toBe(127);
    expect(value(PMEV_STEP, -400)).toBe(128);
    expect(value(PMEV_LAND, 600)).toBe(38);
    expect(value(PMEV_LAND, 7)).toBe(0);
    expect(value(PMEV_LAND, 4080)).toBe(ENTITY_LAND_VALUE_MAX);
    expect(value(PMEV_LAND, 1e6)).toBe(ENTITY_LAND_VALUE_MAX);
    expect(value(PMEV_LAND, Number.NaN)).toBe(0);
    expect(value(PMEV_JUMP, 123)).toBe(0);
    expect(value(PMEV_NONE, 5)).toBe(0);
  });

  it("keeps the two newest, newest first, and a wrapping count", () => {
    const f = new WorldFrame();
    const s = 9;
    const e = s * ENTITY_EVENT_SLOTS;
    const slots = () => [
      f.eventSeq[s],
      f.evKind[e],
      f.evValue[e],
      f.evKind[e + 1],
      f.evValue[e + 1],
    ];
    pushEntityEvent(f.eventSeq, f.evKind, f.evValue, s, PMEV_JUMP, 0);
    expect(slots()).toEqual([1, PMEV_JUMP, 0, PMEV_NONE, 0]);
    pushEntityEvent(f.eventSeq, f.evKind, f.evValue, s, PMEV_LAND, 38);
    expect(slots()).toEqual([2, PMEV_LAND, 38, PMEV_JUMP, 0]);
    pushEntityEvent(f.eventSeq, f.evKind, f.evValue, s, PMEV_STEP, 240);
    expect(slots()).toEqual([3, PMEV_STEP, 240, PMEV_LAND, 38]);
    // The neighbours are untouched; the count wraps at 8 bits.
    expect([f.eventSeq[s - 1], f.eventSeq[s + 1], f.evKind[e - 1], f.evKind[e + 2]]).toEqual([
      0, 0, 0, 0,
    ]);
    f.eventSeq[s] = 255;
    pushEntityEvent(f.eventSeq, f.evKind, f.evValue, s, PMEV_JUMP, 0);
    expect(slots()).toEqual([0, PMEV_JUMP, 0, PMEV_STEP, 240]);
  });
});

describe("FrameRing", () => {
  it("holds 64 ticks by tick & 63, and misses a tick it no longer (or never) held", () => {
    const ring = new FrameRing();
    expect([ring.has(0), ring.get(0), ring.get(1)]).toEqual([false, null, null]);
    ring.slot(5).setPresent(2, 5);
    ring.store(5);
    expect(ring.get(5)?.present[2]).toBe(1);
    expect([ring.has(5), ring.has(69), ring.tickAt(5), ring.tickAt(6)]).toEqual([
      true,
      false,
      5,
      0,
    ]);
    ring.store(69);
    expect([ring.has(5), ring.has(69), ring.get(5)]).toEqual([false, true, null]);
    ring.invalidate(5);
    expect(ring.has(69)).toBe(true);
    ring.invalidate(69);
    expect(ring.has(69)).toBe(false);
    ring.store(70);
    ring.clear();
    expect(ring.has(70)).toBe(false);
  });

  it("swaps a decoded frame in without a copy and hands back the one it replaced", () => {
    const ring = new FrameRing();
    const held = ring.slot(7);
    const decoded = new WorldFrame();
    decoded.setPresent(1, 7);
    const old = ring.swapIn(7, decoded);
    expect(old).toBe(held);
    expect(ring.get(7)).toBe(decoded);
    expect(ring.swapIn(71, old)).toBe(decoded);
    expect([ring.has(7), ring.get(71)]).toEqual([false, old]);
  });
});
