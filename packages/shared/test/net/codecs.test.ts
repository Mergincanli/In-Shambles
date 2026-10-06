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
  decodeSnapshot,
  decodeWelcome,
  encodeCvars,
  encodeHello,
  encodeInput,
  encodePing,
  encodePong,
  encodePrint,
  encodeReady,
  encodeSnapshot,
  encodeWelcome,
  HelloMsg,
  InputMsg,
  PingMsg,
  PongMsg,
  PrintMsg,
  peekHelloVersion,
  peekMessageType,
  SnapshotMsg,
  WelcomeMsg,
} from "../../src/net/messages";
import {
  INPUT_MAX_CMDS,
  MAX_UNRELIABLE_BYTES,
  MSG_INPUT,
  MSG_SNAPSHOT,
  MSG_TYPE_MAX,
  PROTOCOL_VERSION,
} from "../../src/net/protocol";
import { Mulberry32 } from "../../src/rng/mulberry32";
import {
  copyPlayerState,
  PlayerState,
  playerStateEquals,
  quantizePlayerState,
} from "../../src/sim/playerState";
import { copyUserCmd, sanitizeUserCmd, UserCmd } from "../../src/sim/usercmd";
import { TICK_MAX } from "../../src/time";
import {
  MESSAGE_KINDS,
  type MessageKind,
  newWriter,
  randomCmdFields,
  randomState,
  readerOver,
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

    it("SNAPSHOT: every field and the state come back bit for bit", () => {
      const rng = new Mulberry32(0x5a4b);
      const w = newWriter();
      const m = new SnapshotMsg();
      const out = new SnapshotMsg();
      for (let i = 0; i < 2000; i++) {
        m.serverTick = rng.nextInt(0x200000) * 512;
        m.lastProcessedCmdTick = Math.max(0, m.serverTick - 3);
        m.inputBufferHealth = rng.nextInt(256) - 128;
        m.cvarHash = rng.nextInt(0x10000);
        m.flags = rng.nextInt(4);
        randomState(rng, m.state);
        w.reset();
        expect(encodeSnapshot(w, m)).toBe(true);
        expect(w.byteLength).toBe(42);
        expect(decodeSnapshot(readerOver(w.bytes, w.byteLength), out)).toBe(true);
        expect([out.serverTick, out.baselineTick, out.lastProcessedCmdTick]).toEqual([
          m.serverTick,
          0,
          m.lastProcessedCmdTick,
        ]);
        expect([out.inputBufferHealth, out.cvarHash, out.flags]).toEqual([
          m.inputBufferHealth,
          m.cvarHash,
          m.flags,
        ]);
        expect(playerStateEquals(out.state, m.state)).toBe(true);
        for (let a = 0; a < 3; a++) {
          expect(Object.is(out.state.origin[a], m.state.origin[a])).toBe(true);
          expect(Object.is(out.state.velocity[a], m.state.velocity[a])).toBe(true);
        }
      }
    });

    it("SNAPSHOT: any quantized state with a sanitized pitch encodes, and decodes to itself", () => {
      const rng = new Mulberry32(0x9a17);
      const w = newWriter();
      const m = new SnapshotMsg();
      const out = new SnapshotMsg();
      const again = new PlayerState();
      for (let i = 0; i < 2000; i++) {
        const s = m.state;
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
        w.reset();
        expect(encodeSnapshot(w, m)).toBe(true);
        expect(decodeSnapshot(readerOver(w.bytes, w.byteLength), out)).toBe(true);
        expect(playerStateEquals(out.state, s)).toBe(true);
        copyPlayerState(again, out.state);
        quantizePlayerState(again);
        expect(playerStateEquals(again, out.state)).toBe(true);
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
    function snapshotWith(edit: (m: SnapshotMsg) => void): boolean {
      const m = new SnapshotMsg();
      edit(m);
      return encodeSnapshot(newWriter(), m);
    }

    it("encoders refuse what their layout can't carry", () => {
      expect(snapshotWith(() => {})).toBe(true);
      expect(
        snapshotWith((m) => {
          m.baselineTick = 5;
        }),
      ).toBe(false);
      expect(
        snapshotWith((m) => {
          m.serverTick = TICK_MAX + 1;
        }),
      ).toBe(false);
      expect(
        snapshotWith((m) => {
          m.inputBufferHealth = 128;
        }),
      ).toBe(false);
      expect(
        snapshotWith((m) => {
          m.flags = 4;
        }),
      ).toBe(false);
      for (const edit of [
        (s: PlayerState) => {
          s.origin[0] = 16384.03125;
        },
        (s: PlayerState) => {
          s.origin[1] = 1 / 64;
        },
        (s: PlayerState) => {
          s.velocity[2] = 1 / 32;
        },
        (s: PlayerState) => {
          s.velocity[0] = 32768;
        },
        (s: PlayerState) => {
          s.viewPitch = (PITCH_LIMIT_U16 + 1) & 0xffff;
        },
        (s: PlayerState) => {
          s.viewPitch = -(PITCH_LIMIT_U16 + 1) & 0xffff;
        },
        (s: PlayerState) => {
          s.flags = 0x400;
        },
        (s: PlayerState) => {
          s.groundEntity = -2;
        },
        (s: PlayerState) => {
          s.groundEntity = 32768;
        },
        (s: PlayerState) => {
          s.waterLevel = 4;
        },
        (s: PlayerState) => {
          s.stamina = 0.5;
        },
        (s: PlayerState) => {
          s.origin[2] = Number.NaN;
        },
      ]) {
        expect(snapshotWith((m) => edit(m.state))).toBe(false);
      }
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

    /** A valid snapshot's bytes with one field replaced (offset, width, raw value). */
    function patchedSnapshot(offset: number, width: number, value: number): Uint8Array {
      return patchBits(
        encodedBy((w) => encodeSnapshot(w, new SnapshotMsg())),
        offset,
        width,
        value,
      );
    }

    it("decoders refuse out-of-range values the encoders never write", () => {
      const out = new SnapshotMsg();
      const ok = patchedSnapshot(0, 0, 0);
      expect(decodeSnapshot(readerOver(ok), out)).toBe(true);
      // Header: type 0–7, serverTick 8–39, baselineTick 40–71, lastProcessedCmdTick 72–103,
      // health 104–111, cvarHash 112–127, flags 128–135; state from 136: origin 3×21, velocity
      // 3×20, yaw, pitch, flags, groundEntity + 1, waterLevel, stamina.
      const bad: [string, number, number, number][] = [
        ["type", 0, 8, MSG_INPUT],
        ["serverTick past TICK_MAX", 8, 32, TICK_MAX + 1],
        ["non-zero baseline", 40, 32, 1],
        ["lastProcessedCmdTick past TICK_MAX", 72, 32, 0xffffffff],
        ["unknown flag", 128, 8, 4],
        ["origin x past +16384", 136, 21, 524289],
        ["origin z past −16384", 136 + 42, 21, (1 << 21) - 524289],
        ["velocity −2^19", 136 + 63, 20, 1 << 19],
        ["pitch past +16201", 136 + 123 + 16, 16, PITCH_LIMIT_U16 + 1],
        ["pitch past −16201", 136 + 123 + 16, 16, 0x10000 - PITCH_LIMIT_U16 - 1],
        ["groundEntity past ENTITY_WORLD", 136 + 155 + 10, 16, 32769],
      ];
      for (const [label, offset, width, value] of bad) {
        expect(decodeSnapshot(readerOver(patchedSnapshot(offset, width, value)), out), label).toBe(
          false,
        );
      }
      // The largest values that are in range still decode.
      for (const [offset, width, value] of [
        [136, 21, 524288],
        [136 + 63, 20, (1 << 20) - 524287],
        [136 + 123 + 16, 16, PITCH_LIMIT_U16],
        [136 + 155 + 10, 16, 32768],
      ] as const) {
        expect(decodeSnapshot(readerOver(patchedSnapshot(offset, width, value)), out)).toBe(true);
      }
      expect(out.state.groundEntity).toBe(32767);
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
      const snap = encodedBy((w) => encodeSnapshot(w, new SnapshotMsg()));
      const snapOut = new SnapshotMsg();
      for (const offset of [8, 40, 72]) {
        expect(decodeSnapshot(readerOver(patchBits(snap, offset, 32, 0xffffffff)), snapOut)).toBe(
          false,
        );
      }
      expect([snapOut.serverTick, snapOut.baselineTick, snapOut.lastProcessedCmdTick]).toEqual([
        0, 0, 0,
      ]);
      const pongOut = new PongMsg();
      const pong = encodedBy((w) => encodePong(w, new PongMsg()));
      expect(decodePong(readerOver(patchBits(pong, 24, 32, 0xffffffff)), pongOut)).toBe(false);
      expect(pongOut.serverTick).toBe(0);
    });

    it("HELLO keeps its first 3 B across versions, so a newer client's version is always read", () => {
      const hello = new HelloMsg();
      hello.buildHash = "abc";
      hello.nonce = 7;
      const v1 = encodedBy((w) => encodeHello(w, hello));
      // type 1, protocolVersion 1 (u16, LSB-first): pinned.
      expect(hex(v1.subarray(0, 3))).toBe("010100");
      expect(peekHelloVersion(v1, v1.length)).toBe(PROTOCOL_VERSION);
      // A v2 HELLO with a field v1 doesn't know: v1's decoder refuses it, the peek still works.
      const w = newWriter();
      hello.protocolVersion = 2;
      encodeHello(w, hello);
      w.writeBits(0xabcd, 16);
      const v2 = w.bytes.slice(0, w.byteLength);
      expect(decodeHello(readerOver(v2), new HelloMsg())).toBe(false);
      expect(peekHelloVersion(v2, v2.length)).toBe(2);
      expect(peekHelloVersion(v2, 2)).toBe(-1);
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

  it("fits the M2 sizes: a snapshot in 42 B, an INPUT of 4 cmds in 55 B", () => {
    const w = newWriter();
    const s = new SnapshotMsg();
    s.state.origin[0] = -16384;
    encodeSnapshot(w, s);
    expect(w.bitLength).toBe(335);
    expect(w.byteLength).toBe(42);
    const input = new InputMsg();
    input.count = INPUT_MAX_CMDS;
    for (let i = 0; i < INPUT_MAX_CMDS; i++) (input.cmds[i] as UserCmd).tick = 100 - i;
    w.reset();
    expect(encodeInput(w, input)).toBe(true);
    expect([w.bitLength, w.byteLength]).toEqual([435, 55]);
  });
});
