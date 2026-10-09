import { describe, expect, it } from "vitest";
import { PITCH_LIMIT_U16 } from "../../src/math/angles";
import type { BitWriter } from "../../src/net/bitstream";
import {
  CvarsMsg,
  decodeCvars,
  decodeHello,
  decodeInput,
  decodePong,
  decodePrint,
  decodeWelcome,
  encodeCvars,
  encodeHello,
  encodeInput,
  encodePing,
  encodePong,
  encodePrint,
  encodeReady,
  encodeWelcome,
  HelloMsg,
  InputMsg,
  PingMsg,
  PongMsg,
  PrintMsg,
  peekHelloVersion,
  peekMessageType,
  WelcomeMsg,
  writeTick,
} from "../../src/net/messages";
import {
  INPUT_MAX_CMDS,
  MAX_SNAPSHOT_BYTES,
  MAX_SPECTATOR_SNAPSHOT_BYTES,
  MAX_UNRELIABLE_BYTES,
  MSG_INPUT,
  MSG_SNAPSHOT,
  MSG_TYPE_MAX,
  PROTOCOL_VERSION,
  SNAP_FLAG_DEFERRED,
  SNAP_FLAG_SPECTATOR,
  SNAP_FLAG_STARVED,
} from "../../src/net/protocol";
import {
  decodeSnapshotBody,
  decodeSnapshotHeader,
  ENTITY_DELTA_MAX_BITS,
  ENTITY_NEW_BITS,
  ENTITY_REMOVED_BITS,
  encodeSnapshot,
  entityRecordBits,
  LOCAL_DELTA_MAX_BITS,
  localBlockBits,
  SNAP_DELTA_FIXED_BITS,
  SNAP_ENTITY_COUNT_BITS,
  SNAP_FIT_MAX_PLAYERS,
  SNAP_FULL_FIXED_BITS,
  SNAP_HEADER_BITS,
  SNAP_SPECTATOR_HEADER_BITS,
  SnapshotHeader,
} from "../../src/net/snapshot";
import {
  copySlot,
  FRAME_SLOTS,
  frameDigest,
  playerStateToSlot,
  slotToPlayerState,
  WorldFrame,
} from "../../src/net/worldFrame";
import { Mulberry32 } from "../../src/rng/mulberry32";
import { ENTITY_FLAG_MASK, TEAM_1 } from "../../src/sim/entity";
import { PMEV_JUMP, PMEV_LAND, PMEV_STEP } from "../../src/sim/events";
import {
  copyPlayerState,
  PlayerState,
  playerStateEquals,
  quantizePlayerState,
} from "../../src/sim/playerState";
import { copyUserCmd, sanitizeUserCmd, UserCmd } from "../../src/sim/usercmd";
import { TICK_MAX } from "../../src/time";
import {
  decodeEverywhere,
  expectBitFlipsSafe,
  expectCorruptionsSafe,
  expectTruncationsRefused,
  FAST_FUZZ,
  hex,
} from "../helpers/codecFuzz";
import {
  decodeSnapshotParts,
  encodeSnapshotParts,
  LIVE_FULL_MAX_OTHERS,
  MESSAGE_KINDS,
  newWriter,
  randomCmdFields,
  randomFrame,
  randomSnapshot,
  readerOver,
  SNAP_SELF,
  SnapshotParts,
} from "../helpers/netMessages";

/** `bytes` with the `width` bits at bit `offset` replaced by `value` (LSB-first), as a copy. */
function patchBits(bytes: Uint8Array, offset: number, width: number, value: number): Uint8Array {
  const b = bytes.slice();
  for (let i = 0; i < width; i++) {
    const bit = offset + i;
    const mask = 1 << (bit & 7);
    b[bit >> 3] =
      ((value >>> i) & 1) === 1 ? (b[bit >> 3] as number) | mask : (b[bit >> 3] as number) & ~mask;
  }
  return b;
}

function encodedBy(encode: (w: BitWriter) => boolean): Uint8Array {
  const w = newWriter();
  expect(encode(w)).toBe(true);
  return w.bytes.slice(0, w.byteLength);
}

const kinds = MESSAGE_KINDS.map((k) => [k.name, k] as const);

// Tiers (D-032): the truncation, bit-flip and corruption fuzz runs the same seeds with smaller
// counts here (FAST_FUZZ); `packages/shared/long/net-01-codec-fuzz.long.ts` runs the full counts
// (FULL_FUZZ) in `pnpm test:long` under its own describe, and `pnpm test:net` runs both.

describe("NET-01: codec round trips and fuzzed decoders (docs/05 §3.6, §14)", () => {
  it("covers every message type", () => {
    expect(MESSAGE_KINDS.map((k) => k.type).sort((a, b) => a - b)).toEqual(
      Array.from({ length: MSG_TYPE_MAX }, (_, i) => i + 1),
    );
  });

  describe("round trips", () => {
    it.each(kinds)("%s: 300 seeded random messages decode and re-encode exactly", (_, k) => {
      const rng = new Mulberry32(0x7e57 + k.type);
      const w = newWriter();
      for (let i = 0; i < 300; i++) {
        const bytes = k.random(rng, w);
        expect(peekMessageType(bytes, bytes.length)).toBe(k.type);
        expect(decodeEverywhere(bytes, bytes.length, w)).toBe(1);
      }
    });

    it("SNAPSHOT: the header, the local block and every record come back bit for bit", () => {
      const rng = new Mulberry32(0x5a4b);
      const w = newWriter();
      const m = new SnapshotParts();
      const out = new SnapshotParts(m.base);
      let deltas = 0;
      const sent = new PlayerState();
      const got = new PlayerState();
      for (let i = 0; i < 1500; i++) {
        randomSnapshot(rng, m);
        w.reset();
        expect(encodeSnapshotParts(w, m)).toBe(true);
        expect(decodeSnapshotParts(readerOver(w.bytes, w.byteLength), out)).toBe(true);
        const h = m.hdr;
        const spectator = (h.flags & SNAP_FLAG_SPECTATOR) !== 0;
        expect([out.hdr.serverTick, out.hdr.baseBack, out.hdr.flags, out.hdr.cvarHash]).toEqual([
          h.serverTick,
          h.baseBack,
          h.flags,
          h.cvarHash,
        ]);
        const self = m.selfId;
        if (h.baseBack > 0) deltas++;
        // The exact size functions add up to what the encoder wrote (M3 design §2.3).
        let bits = spectator
          ? SNAP_SPECTATOR_HEADER_BITS
          : SNAP_HEADER_BITS + localBlockBits(m.frame, m.baseline, self);
        bits += SNAP_ENTITY_COUNT_BITS;
        for (let s = 0; s < FRAME_SLOTS; s++) {
          if (s !== self) bits += entityRecordBits(m.frame, m.baseline, s);
        }
        expect(bits).toBe(w.bitLength);
        expect(out.hdr.inputBufferHealth).toBe(spectator ? 0 : h.inputBufferHealth);
        expect(out.hdr.teleportSeq).toBe(spectator ? 0 : m.frame.teleportSeq[self]);
        // What the receiver holds equals the frame it was encoded from, as it sees it.
        expect(frameDigest(out.frame, self)).toBe(frameDigest(m.frame, self));
        expect(out.frame.presentCount).toBe(m.frame.presentCount);
        expect(out.frame.pendingCount).toBe(0);
        // Per-slot checks count mismatches in plain loops (an expect per slot made this test the
        // slowest of the file), then assert the count once.
        let bad = 0;
        for (let s = 0; s < FRAME_SLOTS; s++) {
          if (out.frame.present[s] !== m.frame.present[s]) bad++;
          else if (m.frame.present[s] === 1 && out.frame.stamp[s] !== h.serverTick) bad++;
        }
        if (!spectator) {
          slotToPlayerState(m.frame, self, sent);
          slotToPlayerState(out.frame, self, got);
          expect(playerStateEquals(got, sent)).toBe(true);
          for (let a = 0; a < 3; a++) {
            expect(Object.is(got.origin[a], sent.origin[a])).toBe(true);
            expect(Object.is(got.velocity[a], sent.velocity[a])).toBe(true);
          }
        }
        // A record's flags arrive masked, the rest as sent.
        for (let s = 0; s < FRAME_SLOTS; s++) {
          if (m.frame.present[s] !== 1 || s === self) continue;
          if (out.frame.flags[s] !== ((m.frame.flags[s] as number) & ENTITY_FLAG_MASK)) bad++;
          if (out.frame.originX[s] !== m.frame.originX[s]) bad++;
          if (out.frame.entVelZ[s] !== m.frame.entVelZ[s]) bad++;
          if (out.frame.pitch[s] !== m.frame.pitch[s]) bad++;
        }
        expect(bad).toBe(0);
      }
      expect(deltas).toBeGreaterThan(500);
    });

    it("SNAPSHOT: any quantized state with a sanitized pitch encodes, and decodes to itself", () => {
      const rng = new Mulberry32(0x9a17);
      const w = newWriter();
      const m = new SnapshotParts();
      m.hdr.serverTick = 77;
      const out = new SnapshotParts();
      const s = new PlayerState();
      const got = new PlayerState();
      const again = new PlayerState();
      for (let i = 0; i < 2000; i++) {
        for (let a = 0; a < 3; a++) {
          s.origin[a] = (rng.nextFloat() - 0.5) * (i % 10 === 0 ? 1e6 : 40000);
          s.velocity[a] = (rng.nextFloat() - 0.5) * (i % 10 === 0 ? 1e7 : 4000);
        }
        s.viewYaw = rng.nextU32();
        s.viewPitch = sanitizeUserCmd(Object.assign(new UserCmd(), { pitch: rng.nextU32() })).pitch;
        s.flags = rng.nextU32();
        s.groundEntity = rng.nextInt(70000) - 2000;
        s.waterLevel = rng.nextInt(6) - 1;
        s.stamina = (rng.nextFloat() - 0.1) * 80000;
        quantizePlayerState(s);
        m.frame.clear();
        m.frame.setPresent(SNAP_SELF, 77);
        playerStateToSlot(m.frame, SNAP_SELF, s);
        w.reset();
        expect(encodeSnapshotParts(w, m)).toBe(true);
        expect(decodeSnapshotParts(readerOver(w.bytes, w.byteLength), out)).toBe(true);
        slotToPlayerState(out.frame, SNAP_SELF, got);
        expect(playerStateEquals(got, s)).toBe(true);
        copyPlayerState(again, got);
        quantizePlayerState(again);
        expect(playerStateEquals(again, got)).toBe(true);
      }
    });

    it("SNAPSHOT: each record field alone and every field at its extremes round-trips", () => {
      const w = newWriter();
      const m = new SnapshotParts();
      const out = new SnapshotParts();
      m.hdr.serverTick = 1000;
      randomFrame(new Mulberry32(3), m.frame, 1000, SNAP_SELF, 0);
      const f = m.frame;
      const s = 40;
      f.setPresent(s, 1000);
      const edits: [string, (v: number) => void, number[]][] = [
        ["originX", (v) => (f.originX[s] = v), [-524288, -1, 0, 1, 524288]],
        ["originY", (v) => (f.originY[s] = v), [-524288, 524288]],
        ["originZ", (v) => (f.originZ[s] = v), [-524288, 524288]],
        ["entVelX", (v) => (f.entVelX[s] = v), [-32767, 0, 32767]],
        ["entVelY", (v) => (f.entVelY[s] = v), [-32767, 32767]],
        ["entVelZ", (v) => (f.entVelZ[s] = v), [-32767, 32767]],
        ["yaw", (v) => (f.yaw[s] = v), [0, 1, 0xffff]],
        ["pitch", (v) => (f.pitch[s] = v), [-PITCH_LIMIT_U16, 0, PITCH_LIMIT_U16]],
        ["flags", (v) => (f.flags[s] = v), [ENTITY_FLAG_MASK, 1, 1 << 9]],
        ["team", (v) => (f.team[s] = v), [0, 1, 2]],
        ["teleportSeq", (v) => (f.teleportSeq[s] = v), [0, 255]],
        ["eventSeq", (v) => (f.eventSeq[s] = v), [0, 255]],
      ];
      let previous = "";
      for (const [name, set, values] of edits) {
        for (const v of values) {
          set(v);
          w.reset();
          expect(encodeSnapshotParts(w, m), `${name} ${v}`).toBe(true);
          const bytes = hex(w.bytes.subarray(0, w.byteLength));
          expect(decodeSnapshotParts(readerOver(w.bytes, w.byteLength), out)).toBe(true);
          expect(frameDigest(out.frame, SNAP_SELF), `${name} ${v}`).toBe(frameDigest(f, SNAP_SELF));
          if (v !== 0) expect(bytes, `${name} ${v} changes the bytes`).not.toBe(previous);
          previous = bytes;
        }
        set(0);
      }
      // Events: STEP and LAND carry any byte, JUMP 0; one or two slots.
      const e = s * 2;
      for (const [k0, v0, k1, v1] of [
        [PMEV_STEP, 255, 0, 0],
        [PMEV_JUMP, 0, PMEV_LAND, 255],
        [PMEV_LAND, 1, PMEV_STEP, 0],
      ] as const) {
        f.evKind[e] = k0;
        f.evValue[e] = v0;
        f.evKind[e + 1] = k1;
        f.evValue[e + 1] = v1;
        w.reset();
        expect(encodeSnapshotParts(w, m)).toBe(true);
        expect(decodeSnapshotParts(readerOver(w.bytes, w.byteLength), out)).toBe(true);
        expect([
          ...out.frame.evKind.subarray(e, e + 2),
          ...out.frame.evValue.subarray(e, e + 2),
        ]).toEqual([k0, k1, v0, v1]);
      }
    });

    it("INPUT: four cmds newest first, with their ticks rebuilt from the offsets, in 55 B", () => {
      const rng = new Mulberry32(0x1a9b);
      const w = newWriter();
      const m = new InputMsg();
      const out = new InputMsg();
      m.packetSeq = 0xbeef;
      m.lastSnapshotTick = 1000;
      m.count = INPUT_MAX_CMDS;
      for (let i = 0; i < INPUT_MAX_CMDS; i++) {
        const c = m.cmds[i] as UserCmd;
        c.tick = 1004 - i;
        randomCmdFields(rng, c);
      }
      expect(encodeInput(w, m)).toBe(true);
      expect(w.bitLength).toBe(435);
      expect(w.byteLength).toBe(55);
      expect(decodeInput(readerOver(w.bytes, w.byteLength), out)).toBe(true);
      expect([out.packetSeq, out.lastSnapshotTick, out.count]).toEqual([0xbeef, 1000, 4]);
      for (let i = 0; i < INPUT_MAX_CMDS; i++) {
        const got = out.cmds[i] as UserCmd;
        expect({ ...got }).toEqual({ ...(m.cmds[i] as UserCmd) });
        // Already in the sanitized ranges.
        const copy = copyUserCmd(new UserCmd(), got);
        expect({ ...sanitizeUserCmd(copy) }).toEqual({ ...got });
      }
    });
  });

  describe("rejections", () => {
    /** A valid live snapshot (tick 1000, receiver SNAP_SELF, two records) after `edit`. */
    function snapshotWith(edit: (m: SnapshotParts) => void): boolean {
      const m = new SnapshotParts();
      m.hdr.serverTick = 1000;
      randomFrame(new Mulberry32(11), m.frame, 1000, SNAP_SELF, 2);
      edit(m);
      return encodeSnapshotParts(newWriter(), m);
    }

    /** A delta of tick `t`, 10 back (within the window), its players restamped to `t`. */
    function earlyDelta(m: SnapshotParts, t: number): void {
      m.hdr.serverTick = t;
      m.hdr.baseBack = 10;
      for (let s = 0; s < FRAME_SLOTS; s++) if (m.frame.present[s] === 1) m.frame.setPresent(s, t);
      copySlot(m.base, SNAP_SELF, m.frame, SNAP_SELF);
    }

    it("encoders refuse what their layout can't carry", () => {
      expect(snapshotWith(() => {})).toBe(true);
      // The earliest baseline, tick 1 (tick 10 before it is refused below).
      expect(snapshotWith((m) => earlyDelta(m, 11))).toBe(true);
      const other = (m: SnapshotParts) => {
        for (let s = 0; s < FRAME_SLOTS; s++) if (s !== SNAP_SELF && m.frame.present[s]) return s;
        throw new Error("no record");
      };
      const refused: [string, (m: SnapshotParts) => void][] = [
        ["a delta whose baseline lacks the receiver", (m) => (m.hdr.baseBack = 1)],
        [
          "a delta whose baseline holds the receiver as pending (D-046)",
          (m) => {
            m.hdr.baseBack = 1;
            m.base.setPresent(SNAP_SELF, 0);
          },
        ],
        [
          "baseBack 64",
          (m) => {
            m.hdr.baseBack = 64;
            copySlot(m.base, SNAP_SELF, m.frame, SNAP_SELF);
          },
        ],
        ["a baseline before tick 1", (m) => earlyDelta(m, 10)],
        ["tick 0", (m) => (m.hdr.serverTick = 0)],
        ["tick past TICK_MAX", (m) => (m.hdr.serverTick = TICK_MAX + 1)],
        ["health 128", (m) => (m.hdr.inputBufferHealth = 128)],
        ["v1's teleport bit", (m) => (m.hdr.flags = 1 << 1)],
        ["DEFERRED (until D-046)", (m) => (m.hdr.flags = SNAP_FLAG_DEFERRED)],
        ["flag bit 7", (m) => (m.hdr.flags = 1 << 7)],
        ["spectator + starved", (m) => (m.hdr.flags = SNAP_FLAG_SPECTATOR | SNAP_FLAG_STARVED)],
        ["receiver absent", (m) => m.frame.setAbsent(SNAP_SELF)],
        ["receiver's stamp not the tick", (m) => m.frame.setPresent(SNAP_SELF, 999)],
        ["a pending record (D-046)", (m) => m.frame.setPresent(other(m), 0)],
        ["a record of another tick", (m) => m.frame.setPresent(other(m), 999)],
        ["origin past +16384 u", (m) => (m.frame.originY[other(m)] = 524289)],
        ["origin past −16384 u", (m) => (m.frame.originZ[other(m)] = -524289)],
        ["velocity −32768", (m) => (m.frame.entVelX[other(m)] = -32768)],
        ["pitch past +16201", (m) => (m.frame.pitch[other(m)] = PITCH_LIMIT_U16 + 1)],
        ["pitch past −16201", (m) => (m.frame.pitch[other(m)] = -PITCH_LIMIT_U16 - 1)],
        ["team 3", (m) => (m.frame.team[other(m)] = 3)],
        [
          "event kind 4",
          (m) => {
            m.frame.evKind[other(m) * 2] = 4;
          },
        ],
        [
          "an empty slot with a value",
          (m) => {
            const e = other(m) * 2;
            m.frame.evKind[e] = 0;
            m.frame.evKind[e + 1] = 0;
            m.frame.evValue[e] = 1;
          },
        ],
        [
          "an empty slot before a full one",
          (m) => {
            const e = other(m) * 2;
            m.frame.evKind[e] = 0;
            m.frame.evValue[e] = 0;
            m.frame.evKind[e + 1] = PMEV_STEP;
          },
        ],
        [
          "JUMP with a value",
          (m) => {
            const e = other(m) * 2;
            m.frame.evKind[e] = PMEV_JUMP;
            m.frame.evValue[e] = 3;
          },
        ],
        [
          "a local state off the grid",
          (m) => {
            m.frame.ground1[SNAP_SELF] = 32769;
          },
        ],
      ];
      for (const [label, edit] of refused) expect(snapshotWith(edit), label).toBe(false);
      // A base frame needs baseBack > 0 and is never the frame itself; with one, the same frame
      // is a delta of nothing but its mask. The encoder masks the flags a record does not carry.
      const m = new SnapshotParts();
      m.hdr.serverTick = 5;
      randomFrame(new Mulberry32(2), m.frame, 5, SNAP_SELF, 1);
      expect(encodeSnapshot(newWriter(), m.hdr, m.frame, m.base, SNAP_SELF)).toBe(false);
      m.hdr.baseBack = 1;
      expect(encodeSnapshot(newWriter(), m.hdr, m.frame, m.frame, SNAP_SELF)).toBe(false);
      for (let s = 0; s < FRAME_SLOTS; s++) copySlot(m.base, s, m.frame, s);
      const unchanged = newWriter();
      expect(encodeSnapshot(unchanged, m.hdr, m.frame, m.base, SNAP_SELF)).toBe(true);
      expect(unchanged.bitLength).toBe(SNAP_HEADER_BITS + 8 + SNAP_ENTITY_COUNT_BITS);
      expect(snapshotWith((p) => (p.frame.flags[other(p)] = 0x3ff))).toBe(true);
      const input = new InputMsg();
      expect(encodeInput(newWriter(), input)).toBe(false);
      input.count = 2;
      (input.cmds[0] as UserCmd).tick = 10;
      (input.cmds[1] as UserCmd).tick = 10;
      expect(encodeInput(newWriter(), input)).toBe(false);
      (input.cmds[1] as UserCmd).tick = 9;
      expect(encodeInput(newWriter(), input)).toBe(true);
      for (const axis of ["forward", "right", "up"] as const) {
        (input.cmds[1] as UserCmd)[axis] = -128;
        expect(encodeInput(newWriter(), input), axis).toBe(false);
        (input.cmds[1] as UserCmd)[axis] = -127;
        expect(encodeInput(newWriter(), input), axis).toBe(true);
      }
      (input.cmds[1] as UserCmd).pitch = -(PITCH_LIMIT_U16 + 1) & 0xffff;
      expect(encodeInput(newWriter(), input)).toBe(false);
      (input.cmds[1] as UserCmd).pitch = -PITCH_LIMIT_U16 & 0xffff;
      expect(encodeInput(newWriter(), input)).toBe(true);
      // An older cmd before tick 0 (the decoder would refuse it).
      (input.cmds[0] as UserCmd).tick = 1;
      (input.cmds[1] as UserCmd).tick = -1;
      expect(encodeInput(newWriter(), input)).toBe(false);
      (input.cmds[1] as UserCmd).tick = 0;
      expect(encodeInput(newWriter(), input)).toBe(true);
      const print = new PrintMsg();
      print.level = 3;
      expect(encodePrint(newWriter(), print)).toBe(false);
      const welcome = new WelcomeMsg();
      welcome.tickRate = 0;
      expect(encodeWelcome(newWriter(), welcome)).toBe(false);
      const cvars = new CvarsMsg();
      cvars.block.entries.push(
        { name: "b", type: "int", value: 1 },
        { name: "a", type: "int", value: 1 },
      );
      expect(encodeCvars(newWriter(), cvars)).toBe(false);
    });

    /**
     * A valid live snapshot of tick 1000 for receiver SNAP_SELF (9) with records 3, 20 and 40,
     * every field 0: header 0–85 (type 0, serverTick 8, baseBack 40, flags 46, cvarHash 54, health
     * 70, teleportSeq 78), local block 86–284 (origin 86/107/128, velocity 149/169/189, yaw 209,
     * pitch 225, flags 241, groundEntity + 1 251, waterLevel 267, stamina 269), entityCount 285,
     * then 213-bit records from 292.
     */
    function baseSnapshot(): Uint8Array {
      const m = new SnapshotParts();
      m.hdr.serverTick = 1000;
      m.frame.clear();
      m.frame.setPresent(SNAP_SELF, 1000);
      for (const id of [3, 20, 40]) m.frame.setPresent(id, 1000);
      return encodedBy((w) => encodeSnapshotParts(w, m));
    }

    /** Bit offsets of a record's fields (record k starts at 292 + 213 k). */
    const REC = {
      id: 0,
      removed: 16,
      isNew: 17,
      originX: 18,
      originZ: 60,
      velX: 81,
      velY: 97,
      yaw: 129,
      pitch: 145,
      flags: 161,
      team: 171,
      teleportSeq: 173,
      eventSeq: 181,
      k0: 189,
      v0: 193,
      k1: 201,
      v1: 205,
    } as const;
    const rec = (k: number, field: keyof typeof REC) => SNAP_FULL_FIXED_BITS + k * 213 + REC[field];

    function decodesParts(bytes: Uint8Array, out = new SnapshotParts()): boolean {
      return decodeSnapshotParts(readerOver(bytes), out);
    }

    it("decoders refuse out-of-range values the encoders never write", () => {
      const ok = baseSnapshot();
      expect(decodesParts(ok)).toBe(true);
      type Patch = [number, number, number];
      const bad: [string, ...Patch[]][] = [
        ["type", [0, 8, MSG_INPUT]],
        ["serverTick 0", [8, 32, 0]],
        ["serverTick past TICK_MAX", [8, 32, TICK_MAX + 1]],
        ["a delta against a baseline without the receiver", [40, 6, 1]],
        ["baseBack 63", [40, 6, 63]],
        ["a baseline before tick 1", [8, 32, 10], [40, 6, 10]],
        ["flag bit 1 (v1's teleport)", [46, 8, 2]],
        ["DEFERRED (until D-046)", [46, 8, SNAP_FLAG_DEFERRED]],
        ["flag bits 4–7", [46, 8, 0xf0]],
        ["spectator + starved", [46, 8, SNAP_FLAG_SPECTATOR | SNAP_FLAG_STARVED]],
        ["local origin x past +16384", [86, 21, 524289]],
        ["local origin z past −16384", [128, 21, (1 << 21) - 524289]],
        ["local velocity −2^19", [149, 20, 1 << 19]],
        ["local pitch past +16201", [225, 16, PITCH_LIMIT_U16 + 1]],
        ["local pitch past −16201", [225, 16, 0x10000 - PITCH_LIMIT_U16 - 1]],
        ["groundEntity past ENTITY_WORLD", [251, 16, 32769]],
        ["count over the live cap", [285, 7, 64]],
        ["count 127", [285, 7, 127]],
        ["id ≥ 64", [rec(0, "id"), 16, 64]],
        ["id 0xffff", [rec(2, "id"), 16, 0xffff]],
        ["ids unsorted", [rec(0, "id"), 16, 30]],
        ["a duplicate id", [rec(1, "id"), 16, 3]],
        ["the receiver's own id", [rec(0, "id"), 16, SNAP_SELF]],
        ["removed in a full snapshot", [rec(1, "removed"), 1, 1]],
        ["a delta record in a full snapshot", [rec(1, "isNew"), 1, 0]],
        ["origin x past +16384", [rec(0, "originX"), 21, 524289]],
        ["origin z past −16384", [rec(2, "originZ"), 21, (1 << 21) - 524289]],
        ["velocity −32768", [rec(1, "velY"), 16, 0x8000]],
        ["pitch past +16201", [rec(0, "pitch"), 16, PITCH_LIMIT_U16 + 1]],
        ["pitch past −16201", [rec(0, "pitch"), 16, 0x10000 - PITCH_LIMIT_U16 - 1]],
        ["entity flag bit 5 (jump held)", [rec(0, "flags") + 5, 1, 1]],
        ["entity flag bit 6 (crouch pressed in air)", [rec(2, "flags") + 6, 1, 1]],
        ["team 3", [rec(1, "team"), 2, 3]],
        ["event kind 4", [rec(0, "k0"), 4, 4]],
        ["event kind 15", [rec(0, "k0"), 4, 15], [rec(0, "k1"), 4, 15]],
        ["an empty first slot before a second", [rec(0, "k1"), 4, PMEV_STEP]],
        ["a value in an empty slot", [rec(0, "v0"), 8, 1]],
        ["a value in an empty second slot", [rec(0, "k0"), 4, PMEV_LAND], [rec(0, "v1"), 8, 9]],
        ["JUMP with a value", [rec(1, "k0"), 4, PMEV_JUMP], [rec(1, "v0"), 8, 1]],
      ];
      for (const [label, ...patches] of bad) {
        let bytes = ok;
        for (const [offset, width, value] of patches)
          bytes = patchBits(bytes, offset, width, value);
        expect(decodesParts(bytes), label).toBe(false);
      }
      // The largest values that are in range still decode.
      const good: [string, ...Patch[]][] = [
        ["local origin +16384", [86, 21, 524288]],
        ["local velocity −(2^19 − 1)", [149, 20, (1 << 20) - 524287]],
        ["local pitch +16201", [225, 16, PITCH_LIMIT_U16]],
        ["groundEntity ENTITY_WORLD", [251, 16, 32768]],
        ["origin −16384", [rec(0, "originX"), 21, (1 << 21) - 524288]],
        ["velocity −32767", [rec(1, "velY"), 16, 0x8001]],
        ["pitch −16201", [rec(2, "pitch"), 16, 0x10000 - PITCH_LIMIT_U16]],
        ["every entity flag", [rec(0, "flags"), 10, ENTITY_FLAG_MASK]],
        ["team 2", [rec(1, "team"), 2, 2]],
        ["counters 255", [rec(2, "teleportSeq"), 8, 255], [rec(2, "eventSeq"), 8, 255]],
        [
          "LAND 255 then STEP 255",
          [rec(0, "k0"), 4, PMEV_LAND],
          [rec(0, "v0"), 8, 255],
          [rec(0, "k1"), 4, PMEV_STEP],
          [rec(0, "v1"), 8, 255],
        ],
        ["the receiver's id between two records", [rec(0, "id"), 16, SNAP_SELF - 1]],
      ];
      const out = new SnapshotParts();
      for (const [label, ...patches] of good) {
        let bytes = ok;
        for (const [offset, width, value] of patches)
          bytes = patchBits(bytes, offset, width, value);
        expect(decodesParts(bytes, out), label).toBe(true);
      }
    });

    it("SNAPSHOT decode refuses a live snapshot past 1100 B, as its encoder does", () => {
      const w = newWriter();
      const m = new SnapshotParts();
      m.hdr.serverTick = 50;
      randomFrame(new Mulberry32(4), m.frame, 50, SNAP_SELF, LIVE_FULL_MAX_OTHERS + 1);
      // The encoder writes the whole packet before its size check refuses it.
      expect(encodeSnapshotParts(w, m)).toBe(false);
      expect(w.bitLength).toBe(SNAP_FULL_FIXED_BITS + (LIVE_FULL_MAX_OTHERS + 1) * ENTITY_NEW_BITS);
      expect(w.byteLength).toBeGreaterThan(MAX_SNAPSHOT_BYTES);
      expect(w.byteLength).toBeLessThanOrEqual(MAX_UNRELIABLE_BYTES);
      expect(decodesParts(w.bytes.slice(0, w.byteLength))).toBe(false);
      // One record fewer fits, and decodes.
      m.frame.setAbsent(m.frame.present.indexOf(1, SNAP_SELF + 1));
      w.reset();
      expect(encodeSnapshotParts(w, m)).toBe(true);
      expect(w.byteLength).toBeLessThanOrEqual(MAX_SNAPSHOT_BYTES);
      expect(decodesParts(w.bytes.slice(0, w.byteLength))).toBe(true);
    });

    it("SNAPSHOT body decode needs a receiver id unless spectator, and a base frame only for a delta", () => {
      const ok = baseSnapshot();
      const hdr = new SnapshotHeader();
      const f = new WorldFrame();
      const body = (selfId: number, base: WorldFrame | null) => {
        const r = readerOver(ok);
        return decodeSnapshotHeader(r, hdr) && decodeSnapshotBody(r, hdr, base, selfId, f);
      };
      expect(body(SNAP_SELF, null)).toBe(true);
      expect(body(-1, null)).toBe(false);
      expect(body(64, null)).toBe(false);
      // Receiver 3 is listed as a record: its own id.
      expect(body(3, null)).toBe(false);
      expect(body(SNAP_SELF, new WorldFrame())).toBe(false);
    });

    it("INPUT decode refuses a count outside 1–4, ticks out of order or below 0, and bad axes", () => {
      const w = newWriter();
      const m = new InputMsg();
      m.count = 3;
      for (let i = 0; i < 3; i++) (m.cmds[i] as UserCmd).tick = 100 - i;
      encodeInput(w, m);
      const good = w.bytes.slice(0, w.byteLength);
      const out = new InputMsg();
      expect(decodeInput(readerOver(good), out)).toBe(true);
      // lastSnapshotTick is bits 24–55, count 56–58, newestTick 59–90, cmd 0 91–170 (buttons,
      // forward +16, right +24, up +32, yaw +40, pitch +56, weaponSlot +72), cmd 1's tickBack 171.
      const patch = (offset: number, width: number, value: number) =>
        patchBits(good, offset, width, value);
      expect(decodeInput(readerOver(patch(24, 32, TICK_MAX + 1)), out)).toBe(false);
      expect(decodeInput(readerOver(patch(24, 32, TICK_MAX)), out)).toBe(true);
      expect(decodeInput(readerOver(patch(56, 3, 0)), out)).toBe(false);
      expect(decodeInput(readerOver(patch(56, 3, 5)), out)).toBe(false);
      expect(decodeInput(readerOver(patch(59, 32, TICK_MAX + 1)), out)).toBe(false);
      // newestTick 1 with cmd 1 two ticks back: a tick below 0.
      expect(decodeInput(readerOver(patch(59, 32, 1)), out)).toBe(false);
      // cmd 1's tickBack 0 (a duplicate of cmd 0) and cmd 2 at the same offset as cmd 1.
      expect(decodeInput(readerOver(patch(171, 8, 0)), out)).toBe(false);
      expect(decodeInput(readerOver(patch(171, 8, 2)), out)).toBe(false);
      // cmd 0: a spare button bit, any axis −128, pitch past either limit, weapon slot 8.
      expect(decodeInput(readerOver(patch(91 + 15, 1, 1)), out)).toBe(false);
      expect(decodeInput(readerOver(patch(91 + 16, 8, 0x80)), out)).toBe(false);
      expect(decodeInput(readerOver(patch(91 + 24, 8, 0x80)), out)).toBe(false);
      expect(decodeInput(readerOver(patch(91 + 32, 8, 0x80)), out)).toBe(false);
      expect(decodeInput(readerOver(patch(91 + 24, 8, 0x81)), out)).toBe(true);
      expect(decodeInput(readerOver(patch(91 + 56, 16, PITCH_LIMIT_U16 + 1)), out)).toBe(false);
      expect(decodeInput(readerOver(patch(91 + 56, 16, 0x10000 - PITCH_LIMIT_U16 - 1)), out)).toBe(
        false,
      );
      expect(decodeInput(readerOver(patch(91 + 56, 16, 0x10000 - PITCH_LIMIT_U16)), out)).toBe(
        true,
      );
      expect(decodeInput(readerOver(patch(91 + 72, 8, 8)), out)).toBe(false);
      expect(decodeInput(readerOver(patch(91 + 72, 8, 7)), out)).toBe(true);
    });

    it("WELCOME, PONG, CVARS and PRINT decode refuse a zero tick rate, ticks past TICK_MAX, level 3", () => {
      const welcome = encodedBy((w) => encodeWelcome(w, new WelcomeMsg()));
      const welcomeOut = new WelcomeMsg();
      expect(decodeWelcome(readerOver(welcome), welcomeOut)).toBe(true);
      // WELCOME: protocolVersion 8–23, clientId 24–31, tickRate 32–39, serverTick 40–71.
      expect(decodeWelcome(readerOver(patchBits(welcome, 32, 8, 0)), welcomeOut)).toBe(false);
      expect(decodeWelcome(readerOver(patchBits(welcome, 32, 8, 255)), welcomeOut)).toBe(true);
      expect(decodeWelcome(readerOver(patchBits(welcome, 40, 32, TICK_MAX + 1)), welcomeOut)).toBe(
        false,
      );
      expect(decodeWelcome(readerOver(patchBits(welcome, 40, 32, TICK_MAX)), welcomeOut)).toBe(
        true,
      );
      // PONG: pingId 8–23, serverTick 24–55.
      const pong = encodedBy((w) => encodePong(w, new PongMsg()));
      const pongOut = new PongMsg();
      expect(decodePong(readerOver(patchBits(pong, 24, 32, TICK_MAX + 1)), pongOut)).toBe(false);
      expect(decodePong(readerOver(patchBits(pong, 24, 32, 0xffffffff)), pongOut)).toBe(false);
      expect(decodePong(readerOver(patchBits(pong, 24, 32, TICK_MAX)), pongOut)).toBe(true);
      // CVARS: effectiveTick 8–39, blockHash 40–71.
      const cvars = encodedBy((w) => encodeCvars(w, new CvarsMsg()));
      const cvarsOut = new CvarsMsg();
      expect(decodeCvars(readerOver(patchBits(cvars, 8, 32, TICK_MAX + 1)), cvarsOut)).toBe(false);
      expect(decodeCvars(readerOver(patchBits(cvars, 8, 32, TICK_MAX)), cvarsOut)).toBe(true);
      expect(
        decodeCvars(readerOver(patchBits(cvars, 40, 1, 1 ^ (cvars[5] as number))), cvarsOut),
      ).toBe(false);
      // PRINT: level 8–9.
      const print = encodedBy((w) => encodePrint(w, new PrintMsg()));
      const printOut = new PrintMsg();
      expect(decodePrint(readerOver(patchBits(print, 8, 2, 3)), printOut)).toBe(false);
      expect(decodePrint(readerOver(patchBits(print, 8, 2, 2)), printOut)).toBe(true);
    });

    it("rejected INPUT, SNAPSHOT and PONG packets never store an out-of-range tick", () => {
      // The decoders check a u32 tick in a local first (a stored 2^32 − 1 would box, D-026).
      const input = new InputMsg();
      input.count = 1;
      const inBytes = encodedBy((w) => encodeInput(w, input));
      const inOut = new InputMsg();
      expect(decodeInput(readerOver(patchBits(inBytes, 24, 32, 0xffffffff)), inOut)).toBe(false);
      expect(decodeInput(readerOver(patchBits(inBytes, 59, 32, 0xffffffff)), inOut)).toBe(false);
      expect([inOut.lastSnapshotTick, (inOut.cmds[0] as UserCmd).tick]).toEqual([0, 0]);
      const snap = baseSnapshot();
      const snapOut = new SnapshotHeader();
      expect(decodeSnapshotHeader(readerOver(patchBits(snap, 8, 32, 0xffffffff)), snapOut)).toBe(
        false,
      );
      expect(snapOut.serverTick).toBe(0);
      const pongOut = new PongMsg();
      const pong = encodedBy((w) => encodePong(w, new PongMsg()));
      expect(decodePong(readerOver(patchBits(pong, 24, 32, 0xffffffff)), pongOut)).toBe(false);
      expect(pongOut.serverTick).toBe(0);
    });

    it("HELLO keeps its first 3 B across versions, so a newer client's version is always read", () => {
      const hello = new HelloMsg();
      hello.buildHash = "abc";
      hello.nonce = 7;
      const now = encodedBy((w) => encodeHello(w, hello));
      // type 1, protocolVersion 2 (u16, LSB-first): pinned.
      expect(hex(now.subarray(0, 3))).toBe("010200");
      expect(peekHelloVersion(now, now.length)).toBe(PROTOCOL_VERSION);
      // A v1 HELLO's first 3 B, which the server reads to KICK it with a reason.
      hello.protocolVersion = 1;
      expect(hex(encodedBy((w) => encodeHello(w, hello)).subarray(0, 3))).toBe("010100");
      // A v3 HELLO with a field v2 doesn't know: v2's decoder refuses it, the peek still works.
      const w = newWriter();
      hello.protocolVersion = 3;
      encodeHello(w, hello);
      w.writeBits(0xabcd, 16);
      const v3 = w.bytes.slice(0, w.byteLength);
      expect(decodeHello(readerOver(v3), new HelloMsg())).toBe(false);
      expect(peekHelloVersion(v3, v3.length)).toBe(3);
      expect(peekHelloVersion(v3, 2)).toBe(-1);
      expect(peekHelloVersion(encodedBy(encodeReady), 1)).toBe(-1);
      const ping = encodedBy((wr) => encodePing(wr, new PingMsg()));
      expect(peekHelloVersion(ping, ping.length)).toBe(-1);
    });

    it.each(kinds)("%s: every truncation, an extra byte and dirty padding are refused", (_, k) =>
      expectTruncationsRefused(k, FAST_FUZZ.truncations),
    );
  });

  describe("fuzz: decoders never throw, and accept only what an encoder writes", () => {
    it("1e4 random byte strings", () => {
      const rng = new Mulberry32(0xf022);
      const w = newWriter();
      const bytes = new Uint8Array(MAX_UNRELIABLE_BYTES);
      let accepted = 0;
      for (let i = 0; i < 10_000; i++) {
        const len = rng.nextInt(8) === 0 ? rng.nextInt(MAX_UNRELIABLE_BYTES + 1) : rng.nextInt(64);
        for (let b = 0; b < len; b++) bytes[b] = rng.nextInt(256);
        // Mostly a real type byte, so the decoders get past it.
        if (len > 0 && rng.nextInt(4) !== 0) bytes[0] = 1 + rng.nextInt(MSG_TYPE_MAX);
        // Short PING-sized strings are often valid: re-encoding checks those too.
        accepted += decodeEverywhere(bytes, len, w);
      }
      // Random bits rarely make a whole valid message, but PING (3 B) and READY (1 B) do.
      expect(accepted).toBeGreaterThan(0);
      expect(accepted).toBeLessThan(2000);
    });

    it.each(kinds)("%s: every single-bit flip of valid messages", (_, k) =>
      expectBitFlipsSafe(k, FAST_FUZZ.bitFlips),
    );

    it("random multi-byte corruption of snapshots and inputs", () =>
      expectCorruptionsSafe(FAST_FUZZ.corruptions));
  });

  describe("deltas (D-038)", () => {
    const E_ORIGIN = 1;
    const E_VELOCITY = 2;
    const E_YAW = 4;
    const E_PITCH = 8;
    const E_FLAGS = 16;
    const E_TEAM = 32;
    const E_TELEPORT = 64;
    const E_EVENTS = 128;
    const L_ORIGIN = 1;
    const L_VELOCITY = 2;
    const L_YAW = 4;
    const L_PITCH = 8;
    const L_FLAGS = 16;
    const L_GROUND = 32;
    const L_WATER = 64;
    const L_STAMINA = 128;

    /**
     * The baseline of the hand-written deltas: tick 990, the receiver SNAP_SELF and players 3, 20
     * and 40 (serial 7), every field 0; 40 pending when asked, the receiver left out when asked.
     */
    function handBase(pending40 = false, withSelf = true): WorldFrame {
      const f = new WorldFrame();
      if (withSelf) f.setPresent(SNAP_SELF, 990);
      for (const id of [3, 20, 40]) {
        f.setPresent(id, 990);
        f.serial[id] = 7;
      }
      if (pending40) f.setPresent(40, 0);
      return f;
    }

    /** A delta of tick `tick`, `baseBack` back: the header (all 0), then what `body` writes. */
    function handDelta(body: (w: BitWriter) => void, tick = 1000, baseBack = 10): Uint8Array {
      const w = newWriter();
      w.writeBits(MSG_SNAPSHOT, 8);
      writeTick(w, tick);
      w.writeBits(baseBack, 6);
      zeros(w, 8 + 16 + 8 + 8);
      body(w);
      expect(w.error).toBe(false);
      return w.bytes.slice(0, w.byteLength);
    }

    function zeros(w: BitWriter, bits: number): void {
      for (let left = bits; left > 0; left -= 16) w.writeBits(0, Math.min(16, left));
    }

    /** A record's id, removed and new bits, and (for a delta body) its mask. */
    function rec(w: BitWriter, id: number, removed: number, isNew = 0, mask = -1): void {
      w.writeBits(id, 16);
      w.writeBits(removed, 1);
      if (removed === 1) return;
      w.writeBits(isNew, 1);
      if (mask >= 0) w.writeBits(mask, 8);
    }

    /** No local change, then `count` records. */
    function records(count: number, body: (w: BitWriter) => void): (w: BitWriter) => void {
      return (w) => {
        w.writeBits(0, 8);
        w.writeBits(count, 7);
        body(w);
      };
    }

    const decoded = new WorldFrame();
    const hdr = new SnapshotHeader();
    /** Decodes against `base`; an accepted packet must re-encode to the same bytes. */
    function decodesAgainst(bytes: Uint8Array, base: WorldFrame): boolean {
      const r = readerOver(bytes);
      if (!decodeSnapshotHeader(r, hdr) || !decodeSnapshotBody(r, hdr, base, SNAP_SELF, decoded)) {
        return false;
      }
      const w = newWriter();
      expect(encodeSnapshot(w, hdr, decoded, base, SNAP_SELF)).toBe(true);
      expect(hex(w.bytes.subarray(0, w.byteLength))).toBe(hex(bytes));
      return true;
    }

    it("keeps unlisted players, drops removed ones, and re-sends a new incarnation in full", () => {
      const base = handBase();
      expect(decodesAgainst(handDelta(records(0, () => {})), base)).toBe(true);
      expect([...[SNAP_SELF, 3, 20, 40].map((s) => decoded.stamp[s])]).toEqual([
        1000, 1000, 1000, 1000,
      ]);
      expect([decoded.presentCount, decoded.serial[3]]).toEqual([4, 7]);
      // 20 left, 3 turned, 40 holds another player: "new" sets the serial past the baseline's
      // (the client reads none; it keeps re-encoding canonical), 50 joined.
      const changes = records(4, (w) => {
        rec(w, 3, 0, 0, E_YAW);
        w.writeBits(5, 16);
        rec(w, 20, 1);
        rec(w, 40, 0, 1);
        zeros(w, ENTITY_NEW_BITS - 18);
        rec(w, 50, 0, 1);
        zeros(w, ENTITY_NEW_BITS - 18);
      });
      expect(decodesAgainst(handDelta(changes), base)).toBe(true);
      expect([decoded.present[20], decoded.yaw[3], decoded.serial[40], decoded.serial[50]]).toEqual(
        [0, 5, 8, 0],
      );
      expect(decoded.presentCount).toBe(4);
      // A pending baseline slot (D-046) may be removed or sent new, never left out or sent a delta.
      const pending = handBase(true);
      expect(decodesAgainst(handDelta(records(1, (w) => rec(w, 40, 1))), pending)).toBe(true);
      const renew = records(1, (w) => {
        rec(w, 40, 0, 1);
        zeros(w, ENTITY_NEW_BITS - 18);
      });
      expect(decodesAgainst(handDelta(renew), pending)).toBe(true);
      expect(decoded.serial[40]).toBe(0);
      expect(decodesAgainst(handDelta(records(0, () => {})), pending)).toBe(false);
      const deltaOfPending = records(1, (w) => {
        rec(w, 40, 0, 0, E_YAW);
        w.writeBits(5, 16);
      });
      expect(decodesAgainst(handDelta(deltaOfPending), pending)).toBe(false);
      // A baseline holding the receiver as pending has no local state to code against.
      const selfPending = handBase();
      selfPending.setPresent(SNAP_SELF, 0);
      expect(decodesAgainst(handDelta(records(0, () => {})), selfPending)).toBe(false);
    });

    it("sends a slot the baseline holds as pending in full, even with the same serial", () => {
      const base = handBase(true);
      const cur = new WorldFrame();
      for (const id of [SNAP_SELF, 3, 20, 40]) {
        cur.setPresent(id, 1000);
        cur.serial[id] = id === SNAP_SELF ? 0 : 7;
      }
      cur.yaw[40] = 5;
      expect(entityRecordBits(cur, base, 40)).toBe(ENTITY_NEW_BITS);
      const w = newWriter();
      const h = new SnapshotHeader();
      h.serverTick = 1000;
      h.baseBack = 10;
      expect(encodeSnapshot(w, h, cur, base, SNAP_SELF)).toBe(true);
      // Header, no local change, count 1, then the record: id 40, removed 0, new 1.
      expect(w.bitLength).toBe(86 + 8 + 7 + ENTITY_NEW_BITS);
      const bytes = w.bytes.slice(0, w.byteLength);
      expect(decodesAgainst(bytes, base)).toBe(true);
      expect([decoded.yaw[40], decoded.stamp[40]]).toEqual([5, 1000]);
    });

    it("refuses what the delta encoder never writes (the NET-01 patched-field table)", () => {
      const base = handBase();
      type Body = (w: BitWriter) => void;
      const one = (id: number, mask: number, fields: Body): Body =>
        records(1, (w) => {
          rec(w, id, 0, 0, mask);
          fields(w);
        });
      const origin = (c: number, width: number, v: number): Body =>
        one(3, E_ORIGIN, (w) => {
          w.writeBits(c, 2);
          if (c !== 0) w.writeSigned(v, width);
          w.writeBits(0, 4);
        });
      const velocity = (c: number, width: number, v: number): Body =>
        one(3, E_VELOCITY, (w) => {
          w.writeBits(c, 2);
          if (c !== 0) w.writeSigned(v, width);
          w.writeBits(0, 4);
        });
      const local =
        (mask: number, fields: Body): Body =>
        (w) => {
          w.writeBits(mask, 8);
          fields(w);
          w.writeBits(0, 7);
        };
      const events = (seq: number, k0: number, v0: number): Body =>
        one(3, E_EVENTS, (w) => {
          w.writeBits(seq, 8);
          w.writeBits(k0, 4);
          w.writeBits(v0, 8);
          w.writeBits(0, 12);
        });
      const accepted: [string, Body][] = [
        ["origin +1 (class 1)", origin(1, 7, 1)],
        ["origin −64 (class 1)", origin(1, 7, -64)],
        ["origin 64 (class 2)", origin(2, 13, 64)],
        ["origin −4096 (class 2)", origin(2, 13, -4096)],
        ["origin 4096 (absolute)", origin(3, 21, 4096)],
        ["origin −524288 (absolute)", origin(3, 21, -524288)],
        ["velocity −32 (class 1)", velocity(1, 6, -32)],
        ["velocity 32 (class 2)", velocity(2, 11, 32)],
        ["velocity 1024 (absolute)", velocity(3, 16, 1024)],
        ["velocity −32767", velocity(3, 16, -32767)],
        ["team 2", one(3, E_TEAM, (w) => w.writeBits(2, 2))],
        ["a teleport", one(3, E_TELEPORT, (w) => w.writeBits(1, 8))],
        ["an event", events(1, PMEV_STEP, 3)],
        ["every entity flag", one(3, E_FLAGS, (w) => w.writeBits(ENTITY_FLAG_MASK, 10))],
        ["pitch −16201", one(3, E_PITCH, (w) => w.writeBits(-PITCH_LIMIT_U16 & 0xffff, 16))],
        ["local yaw", local(L_YAW, (w) => w.writeBits(7, 16))],
        ["local pitch", local(L_PITCH, (w) => w.writeBits(7, 16))],
        ["local flags", local(L_FLAGS, (w) => w.writeBits(1, 10))],
        ["local waterLevel", local(L_WATER, (w) => w.writeBits(3, 2))],
        ["local stamina", local(L_STAMINA, (w) => w.writeBits(100, 16))],
        ["local ground ENTITY_WORLD", local(L_GROUND, (w) => w.writeBits(32768, 16))],
        [
          "local velocity −524287 (absolute)",
          local(L_VELOCITY, (w) => {
            w.writeBits(3, 2);
            w.writeSigned(-524287, 20);
            w.writeBits(0, 4);
          }),
        ],
      ];
      for (const [label, body] of accepted) {
        expect(decodesAgainst(handDelta(body), base), label).toBe(true);
      }
      const refused: [string, Body][] = [
        ["mask 0", one(3, 0, () => {})],
        ["an origin group of class 0 only", origin(0, 0, 0)],
        ["origin class 1 of 0", origin(1, 7, 0)],
        ["origin class 2 that fits i7", origin(2, 13, 63)],
        ["origin class 2 of 0", origin(2, 13, 0)],
        ["origin absolute that fits i13", origin(3, 21, 4095)],
        ["origin absolute past +16384 u", origin(3, 21, 524289)],
        ["a velocity group of class 0 only", velocity(0, 0, 0)],
        ["velocity class 1 of 0", velocity(1, 6, 0)],
        ["velocity class 2 that fits i6", velocity(2, 11, 31)],
        ["velocity absolute that fits i11", velocity(3, 16, 1023)],
        ["velocity −32768", velocity(3, 16, -32768)],
        ["yaw equal to the baseline", one(3, E_YAW, (w) => w.writeBits(0, 16))],
        ["pitch equal to the baseline", one(3, E_PITCH, (w) => w.writeBits(0, 16))],
        ["pitch past +16201", one(3, E_PITCH, (w) => w.writeBits(PITCH_LIMIT_U16 + 1, 16))],
        ["flags equal to the baseline", one(3, E_FLAGS, (w) => w.writeBits(0, 10))],
        ["entity flag bit 5", one(3, E_FLAGS, (w) => w.writeBits(1 << 5, 10))],
        ["team equal to the baseline", one(3, E_TEAM, (w) => w.writeBits(0, 2))],
        ["team 3", one(3, E_TEAM, (w) => w.writeBits(3, 2))],
        ["teleportSeq equal to the baseline", one(3, E_TELEPORT, (w) => w.writeBits(0, 8))],
        ["events equal to the baseline", events(0, 0, 0)],
        ["event kind 4", events(1, 4, 0)],
        ["JUMP with a value", events(1, PMEV_JUMP, 1)],
        ["a delta for a slot the baseline lacks", one(4, E_YAW, (w) => w.writeBits(5, 16))],
        ["a removal of a slot the baseline lacks", records(1, (w) => rec(w, 4, 1))],
        ["the receiver's own id", one(SNAP_SELF, E_YAW, (w) => w.writeBits(5, 16))],
        [
          "ids unsorted",
          records(2, (w) => {
            rec(w, 20, 1);
            rec(w, 3, 1);
          }),
        ],
        ["a local yaw equal to the baseline", local(L_YAW, (w) => w.writeBits(0, 16))],
        ["a local pitch equal to the baseline", local(L_PITCH, (w) => w.writeBits(0, 16))],
        ["local flags equal to the baseline", local(L_FLAGS, (w) => w.writeBits(0, 10))],
        ["a local ground equal to the baseline", local(L_GROUND, (w) => w.writeBits(0, 16))],
        ["a local waterLevel equal to the baseline", local(L_WATER, (w) => w.writeBits(0, 2))],
        ["a local stamina equal to the baseline", local(L_STAMINA, (w) => w.writeBits(0, 16))],
        ["a local origin group of class 0 only", local(L_ORIGIN, (w) => w.writeBits(0, 6))],
        ["a local velocity group of class 0 only", local(L_VELOCITY, (w) => w.writeBits(0, 6))],
        ["local ground past ENTITY_WORLD", local(L_GROUND, (w) => w.writeBits(32769, 16))],
        [
          "local velocity −2^19",
          local(L_VELOCITY, (w) => {
            w.writeBits(3, 2);
            w.writeSigned(-524288, 20);
            w.writeBits(0, 4);
          }),
        ],
      ];
      for (const [label, body] of refused) {
        expect(decodesAgainst(handDelta(body), base), label).toBe(false);
      }
      // The header: a baseline before tick 1. The body: a baseline without the receiver.
      expect(
        decodesAgainst(
          handDelta(
            records(0, () => {}),
            10,
            10,
          ),
          base,
        ),
      ).toBe(false);
      expect(
        decodesAgainst(
          handDelta(
            records(0, () => {}),
            11,
            10,
          ),
          base,
        ),
      ).toBe(true);
      expect(decodesAgainst(handDelta(records(0, () => {})), handBase(false, false))).toBe(false);
    });

    it("picks the smallest class at every boundary, and the size functions match the bytes", () => {
      const base = handBase();
      const cur = new WorldFrame();
      const hdrOut = new SnapshotHeader();
      hdrOut.serverTick = 1000;
      hdrOut.baseBack = 10;
      const w = newWriter();
      const roundTrip = (label: string): number => {
        w.reset();
        expect(encodeSnapshot(w, hdrOut, cur, base, SNAP_SELF), label).toBe(true);
        expect(decodesAgainst(w.bytes.slice(0, w.byteLength), base), label).toBe(true);
        expect(frameDigest(decoded, SNAP_SELF), label).toBe(frameDigest(cur, SNAP_SELF));
        const total =
          SNAP_HEADER_BITS +
          localBlockBits(cur, base, SNAP_SELF) +
          SNAP_ENTITY_COUNT_BITS +
          entityRecordBits(cur, base, 3);
        expect(total, label).toBe(w.bitLength);
        return w.bitLength;
      };
      const reset = () => {
        for (let s = 0; s < FRAME_SLOTS; s++) copySlot(cur, s, base, s);
        for (const s of [SNAP_SELF, 3, 20, 40]) cur.setPresent(s, 1000);
      };
      const fixed = SNAP_HEADER_BITS + 8 + SNAP_ENTITY_COUNT_BITS;
      // [delta, payload bits] per class: i7 / i13 / absolute i21 for origins, i6 / i11 / i16 for
      // entity velocities, i7 / i13 / i20 for the local velocity.
      const originCases: [number, number][] = [
        [1, 7],
        [-1, 7],
        [63, 7],
        [-64, 7],
        [64, 13],
        [-65, 13],
        [4095, 13],
        [-4096, 13],
        [4096, 21],
        [-4097, 21],
        [524288, 21],
      ];
      for (const [d, bits] of originCases) {
        reset();
        cur.originY[3] = d;
        expect(roundTrip(`entity origin ${d}`)).toBe(fixed + 26 + 6 + bits);
        reset();
        cur.originZ[SNAP_SELF] = d;
        expect(roundTrip(`local origin ${d}`)).toBe(fixed + 6 + bits);
      }
      const velocityCases: [number, number][] = [
        [1, 6],
        [31, 6],
        [-32, 6],
        [32, 11],
        [-33, 11],
        [1023, 11],
        [-1024, 11],
        [1024, 16],
        [-32767, 16],
      ];
      for (const [d, bits] of velocityCases) {
        reset();
        cur.entVelX[3] = d;
        expect(roundTrip(`entity velocity ${d}`)).toBe(fixed + 26 + 6 + bits);
      }
      const localVelocityCases: [number, number][] = [
        [-64, 7],
        [64, 13],
        [4096, 20],
        [-524287, 20],
      ];
      for (const [d, bits] of localVelocityCases) {
        reset();
        cur.vel16X[SNAP_SELF] = d;
        expect(roundTrip(`local velocity ${d}`)).toBe(fixed + 6 + bits);
      }
      // Each other field alone, at its width.
      const alone: [string, () => void, number][] = [
        ["yaw", () => (cur.yaw[3] = 0xffff), 16],
        ["pitch", () => (cur.pitch[3] = PITCH_LIMIT_U16), 16],
        ["flags", () => (cur.flags[3] = 1), 10],
        ["team", () => (cur.team[3] = TEAM_1), 2],
        ["teleportSeq", () => (cur.teleportSeq[3] = 255), 8],
        ["eventSeq", () => (cur.eventSeq[3] = 1), 32],
        ["an event slot", () => (cur.evKind[6] = PMEV_JUMP), 32],
      ];
      for (const [label, set, bits] of alone) {
        reset();
        set();
        expect(roundTrip(label)).toBe(fixed + 26 + bits);
      }
      // Flags the record does not carry change nothing; a new serial is a new body.
      reset();
      cur.flags[3] = 1 << 5;
      expect(roundTrip("an owner-only flag")).toBe(fixed);
      reset();
      cur.serial[3] = 8;
      expect(roundTrip("another incarnation")).toBe(fixed + ENTITY_NEW_BITS);
      reset();
      cur.setAbsent(3);
      expect(roundTrip("a removal")).toBe(fixed + ENTITY_REMOVED_BITS);
      // Every local field changed at once, each origin and velocity axis absolute: the worst.
      reset();
      cur.originX[SNAP_SELF] = 524288;
      cur.originY[SNAP_SELF] = -524288;
      cur.originZ[SNAP_SELF] = 5000;
      cur.vel16X[SNAP_SELF] = 524287;
      cur.vel16Y[SNAP_SELF] = -524287;
      cur.vel16Z[SNAP_SELF] = 5000;
      cur.yaw[SNAP_SELF] = 1;
      cur.pitch[SNAP_SELF] = 1;
      cur.flags[SNAP_SELF] = 1;
      cur.ground1[SNAP_SELF] = 1;
      cur.waterLevel[SNAP_SELF] = 1;
      cur.stamina[SNAP_SELF] = 1;
      expect(localBlockBits(cur, base, SNAP_SELF)).toBe(LOCAL_DELTA_MAX_BITS);
      expect(roundTrip("every local field")).toBe(fixed - 8 + LOCAL_DELTA_MAX_BITS);
    });
  });

  it("fits the v2 sizes (M3 design §2.1 goldens): 862 B full at 32 players, an INPUT of 4 cmds in 55 B", () => {
    const w = newWriter();
    const m = new SnapshotParts();
    const rng = new Mulberry32(0x512e);
    const size = (others: number, spectator = false): [number, number] => {
      m.hdr.serverTick = 600;
      m.hdr.flags = spectator ? SNAP_FLAG_SPECTATOR : 0;
      randomFrame(rng, m.frame, 600, spectator ? -1 : SNAP_SELF, others);
      w.reset();
      expect(encodeSnapshotParts(w, m), `${others} others`).toBe(true);
      expect(decodeSnapshotParts(readerOver(w.bytes, w.byteLength), new SnapshotParts())).toBe(
        true,
      );
      return [w.bitLength, w.byteLength];
    };
    expect(SNAP_HEADER_BITS).toBe(86);
    expect(SNAP_SPECTATOR_HEADER_BITS).toBe(70);
    expect(ENTITY_NEW_BITS).toBe(213);
    // Alone: 86 + 199 + 7. The full snapshot of a 32-player match: + 31 × 213. 37 players (the
    // cap until the scheduler, D-034): + 36 × 213. The most a live full snapshot holds: 39.
    expect(size(0)).toEqual([292, 37]);
    expect(size(15)).toEqual([3487, 436]);
    expect(size(31)).toEqual([6895, 862]);
    expect(size(36)).toEqual([7960, 995]);
    expect(size(LIVE_FULL_MAX_OTHERS)).toEqual([8599, 1075]);
    // Spectator (demo files only): 70 + 7 + 213 per player, up to all 64, within 2048 B.
    expect(size(0, true)).toEqual([77, 10]);
    const allSpectated = size(64, true);
    expect(allSpectated).toEqual([13709, 1714]);
    expect(allSpectated[1]).toBeLessThanOrEqual(MAX_SPECTATOR_SNAPSHOT_BYTES);
    const input = new InputMsg();
    input.count = INPUT_MAX_CMDS;
    for (let i = 0; i < INPUT_MAX_CMDS; i++) (input.cmds[i] as UserCmd).tick = 100 - i;
    w.reset();
    expect(encodeInput(w, input)).toBe(true);
    expect([w.bitLength, w.byteLength]).toEqual([435, 55]);
  });

  it("fits the worst deltas (M3 design §2.1 goldens): 942 B at 32 players, 1088 B at 37", () => {
    const w = newWriter();
    const m = new SnapshotParts();
    /**
     * The worst delta with `others` remotes and `removals` players gone since the baseline: every
     * local and entity field changed, origins and velocities absolute (D-034's bound).
     */
    const worst = (others: number, spectator = false, removals = 0): [number, number] => {
      const h = m.hdr;
      h.serverTick = 600;
      h.baseBack = 10;
      h.flags = spectator ? SNAP_FLAG_SPECTATOR : 0;
      const base = m.base;
      const cur = m.frame;
      base.clear();
      cur.clear();
      const self = spectator ? -1 : SNAP_SELF;
      if (!spectator) {
        base.setPresent(SNAP_SELF, 590);
        cur.setPresent(SNAP_SELF, 600);
        cur.originX[SNAP_SELF] = 524288;
        cur.originY[SNAP_SELF] = -524288;
        cur.originZ[SNAP_SELF] = 524288;
        cur.vel16X[SNAP_SELF] = 524287;
        cur.vel16Y[SNAP_SELF] = -524287;
        cur.vel16Z[SNAP_SELF] = 524287;
        cur.yaw[SNAP_SELF] = 1;
        cur.pitch[SNAP_SELF] = 1;
        cur.flags[SNAP_SELF] = 1;
        cur.ground1[SNAP_SELF] = 1;
        cur.waterLevel[SNAP_SELF] = 1;
        cur.stamina[SNAP_SELF] = 1;
      }
      let s = 0;
      for (let n = 0; n < others + removals; n++, s++) {
        if (s === self) s++;
        base.setPresent(s, 590);
        if (n >= others) continue;
        cur.setPresent(s, 600);
        cur.originX[s] = 524288;
        cur.originY[s] = -524288;
        cur.originZ[s] = 524288;
        cur.entVelX[s] = 32767;
        cur.entVelY[s] = -32767;
        cur.entVelZ[s] = 32767;
        cur.yaw[s] = 1;
        cur.pitch[s] = 1;
        cur.flags[s] = 1;
        cur.team[s] = 1;
        cur.teleportSeq[s] = 1;
        cur.eventSeq[s] = 1;
        cur.evKind[s * 2] = PMEV_STEP;
        cur.evValue[s * 2] = 1;
      }
      w.reset();
      if (!encodeSnapshotParts(w, m)) return [w.bitLength, -1];
      const out = new SnapshotParts(m.base);
      expect(decodeSnapshotParts(readerOver(w.bytes, w.byteLength), out)).toBe(true);
      expect(frameDigest(out.frame, self)).toBe(frameDigest(cur, self));
      return [w.bitLength, w.byteLength];
    };
    expect([LOCAL_DELTA_MAX_BITS, ENTITY_DELTA_MAX_BITS, ENTITY_REMOVED_BITS]).toEqual([
      219, 233, 17,
    ]);
    expect(SNAP_DELTA_FIXED_BITS).toBe(312);
    // The smallest delta record (docs/05 §3.6: 28–233 bits): id, removed, new, mask, a team.
    const smallBase = new WorldFrame();
    const small = new WorldFrame();
    smallBase.setPresent(3, 590);
    small.setPresent(3, 600);
    small.team[3] = 1;
    expect(entityRecordBits(small, smallBase, 3)).toBe(28);
    // 86 + 219 + 7 + 31 × 233 at 32 players; + 36 × 233 at 37 (SNAP_FIT_MAX_PLAYERS: the cap
    // until the scheduler, D-034), within 1100 B by construction.
    expect(worst(31)).toEqual([7535, 942]);
    expect(SNAP_FIT_MAX_PLAYERS).toBe(37);
    expect(worst(SNAP_FIT_MAX_PLAYERS - 1)).toEqual([8700, 1088]);
    // 36 remotes and 6 removals (43 → 37 players inside the ack window) are 8802 bits: past the
    // budget, so the encoder refuses (the D-046 scheduler's case).
    expect(worst(36, false, 6)).toEqual([8802, -1]);
    // Spectator (demo files only): 70 + 7 + 233 per player.
    expect(worst(32, true)).toEqual([7533, 942]);
    const all = worst(64, true);
    expect(all).toEqual([14989, 1874]);
    expect(all[1]).toBeLessThanOrEqual(MAX_SPECTATOR_SNAPSHOT_BYTES);
  });
});
