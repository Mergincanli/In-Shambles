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
  ENTITY_NEW_BITS,
  encodeSnapshot,
  SNAP_FULL_FIXED_BITS,
  SNAP_HEADER_BITS,
  SNAP_SPECTATOR_HEADER_BITS,
  SnapshotHeader,
} from "../../src/net/snapshot";
import {
  FRAME_SLOTS,
  frameDigest,
  playerStateToSlot,
  slotToPlayerState,
  WorldFrame,
} from "../../src/net/worldFrame";
import { Mulberry32 } from "../../src/rng/mulberry32";
import { ENTITY_FLAG_MASK } from "../../src/sim/entity";
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
  decodeSnapshotParts,
  encodeSnapshotParts,
  LIVE_FULL_MAX_OTHERS,
  MESSAGE_KINDS,
  type MessageKind,
  newWriter,
  randomCmdFields,
  randomFrame,
  randomSnapshot,
  readerOver,
  SNAP_SELF,
  SnapshotParts,
} from "../helpers/netMessages";

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function kindOf(type: number): MessageKind {
  const k = MESSAGE_KINDS.find((m) => m.type === type);
  if (k === undefined) throw new Error(`no kind ${type}`);
  return k;
}

/**
 * Decodes `bytes` with every decoder; whichever accepts it must re-encode it, and byte for byte
 * (so an accepted packet is exactly what an encoder writes: every value in range and canonical).
 * A decoder that accepts what its encoder refuses fails the test. Returns how many decoders
 * accepted it.
 */
function decodeEverywhere(bytes: Uint8Array, length: number, w: BitWriter): number {
  let accepted = 0;
  for (const k of MESSAGE_KINDS) {
    if (!k.decode(readerOver(bytes, length))) continue;
    accepted++;
    expect(k.type).toBe(bytes[0]);
    expect(
      k.decodeAndReencode(readerOver(bytes, length), w),
      `${k.name} accepted a packet its encoder refuses: ${hex(bytes.subarray(0, length))}`,
    ).toBe(true);
    expect(hex(w.bytes.subarray(0, w.byteLength))).toBe(hex(bytes.subarray(0, length)));
  }
  return accepted;
}

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
      const out = new SnapshotParts();
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
          0,
          h.flags,
          h.cvarHash,
        ]);
        const self = m.selfId;
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

    it("encoders refuse what their layout can't carry", () => {
      expect(snapshotWith(() => {})).toBe(true);
      const other = (m: SnapshotParts) => {
        for (let s = 0; s < FRAME_SLOTS; s++) if (s !== SNAP_SELF && m.frame.present[s]) return s;
        throw new Error("no record");
      };
      const refused: [string, (m: SnapshotParts) => void][] = [
        ["a delta (until D-038)", (m) => (m.hdr.baseBack = 1)],
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
      // A base frame is a delta too, and the encoder masks the flags a record does not carry.
      const m = new SnapshotParts();
      m.hdr.serverTick = 5;
      randomFrame(new Mulberry32(2), m.frame, 5, SNAP_SELF, 1);
      expect(encodeSnapshot(newWriter(), m.hdr, m.frame, m.frame, SNAP_SELF)).toBe(false);
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
        ["a delta (baseBack 1, until D-038)", [40, 6, 1]],
        ["baseBack 63", [40, 6, 63]],
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

    it("SNAPSHOT body decode needs a receiver id unless spectator, and no base frame", () => {
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

    it.each(kinds)("%s: every truncation, an extra byte and dirty padding are refused", (_, k) => {
      const rng = new Mulberry32(0x7a11 + k.type);
      const w = newWriter();
      for (let i = 0; i < 40; i++) {
        const bytes = k.random(rng, w);
        for (let len = 0; len < bytes.length; len++) {
          expect(k.decode(readerOver(bytes, len)), `${len} of ${bytes.length}`).toBe(false);
        }
        const longer = new Uint8Array(bytes.length + 1);
        longer.set(bytes);
        expect(k.decode(readerOver(longer))).toBe(false);
        // Set the first padding bit of the last byte, if the message has one.
        w.reset();
        expect(k.decode(readerOver(bytes))).toBe(true);
        k.decodeAndReencode(readerOver(bytes), w);
        const used = w.bitLength & 7;
        if (used !== 0) {
          const dirty = bytes.slice();
          dirty[dirty.length - 1] = (dirty[dirty.length - 1] as number) | (1 << used);
          expect(k.decode(readerOver(dirty))).toBe(false);
        }
      }
    });
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

    it.each(kinds)("%s: every single-bit flip of valid messages", (_, k) => {
      const rng = new Mulberry32(0xf1f + k.type);
      const w = newWriter();
      for (let i = 0; i < 12; i++) {
        const bytes = k.random(rng, w);
        // Long text and cvar messages: a seeded sample of bits instead of all of them.
        const bits = bytes.length * 8;
        const step = bits > 768 ? Math.ceil(bits / 768) : 1;
        for (let bit = rng.nextInt(step); bit < bits; bit += step) {
          const flipped = bytes.slice();
          flipped[bit >> 3] = (flipped[bit >> 3] as number) ^ (1 << (bit & 7));
          decodeEverywhere(flipped, flipped.length, w);
        }
      }
    });

    it("random multi-byte corruption of snapshots and inputs", () => {
      const rng = new Mulberry32(0xc0de);
      const w = newWriter();
      for (const type of [MSG_SNAPSHOT, MSG_INPUT]) {
        const k = kindOf(type);
        for (let i = 0; i < 2000; i++) {
          const bytes = k.random(rng, w);
          const n = 1 + rng.nextInt(4);
          for (let j = 0; j < n; j++) bytes[rng.nextInt(bytes.length)] = rng.nextInt(256);
          decodeEverywhere(bytes, bytes.length, w);
        }
      }
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
});
