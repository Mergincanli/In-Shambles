import { describe, expect, it } from "vitest";
import { BitWriter } from "../../src/net/bitstream";
import {
  copyDemoBytes,
  DEMO_REC_CVARS,
  DEMO_REC_END,
  DEMO_REC_EVENTS,
  DEMO_REC_SNAPSHOT,
  DEMO_RECORD_HEADER_BYTES,
  DemoHeader,
  DemoReader,
  decodeDemoHeader,
  demoMapHash,
  encodeDemoHeader,
  validateDemo,
  writeDemoRecordHeader,
} from "../../src/net/demo";
import { EventsMsg, encodeEvents } from "../../src/net/events";
import { CvarsMsg, encodeCvars } from "../../src/net/messages";
import {
  EVK_PLAYER_JOIN,
  MAX_RELIABLE_BYTES,
  MAX_SPECTATOR_SNAPSHOT_BYTES,
  PROTOCOL_VERSION,
  SNAP_FLAG_SPECTATOR,
} from "../../src/net/protocol";
import { encodeSnapshot, SnapshotHeader } from "../../src/net/snapshot";
import { FRAME_SLOTS, frameDigest, WorldFrame } from "../../src/net/worldFrame";
import { Mulberry32 } from "../../src/rng/mulberry32";
import { TEAM_1, TEAM_2 } from "../../src/sim/entity";
import { TICK_MAX, TICK_RATE } from "../../src/time";

// D-044 (M3 design §2.12): the .demo file layout (header golden), the record walk, and
// validateDemo on valid demos and on hostile ones: every truncation, bit flips, lengths past the
// end, oversize records, unknown kinds, out-of-order ticks, live or baseline-less snapshots. It
// never throws and refuses everything playback could not play.

function header(startTick = 100): DemoHeader {
  const h = new DemoHeader();
  h.startTick = startTick;
  h.mapName = "arena_greybox";
  h.mapHashHi = 0x990efb80 | 0;
  h.mapHashLo = 0xe478cd6c | 0;
  h.buildHash = "abc1234";
  h.cvars.effectiveTick = 0;
  h.cvars.block.entries.push({ name: "sv_cheats", type: "int", value: 0 });
  return h;
}

function hex(b: Uint8Array): string {
  return [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
}

/** Slot `s` of `f` at tick `t`: a moving player whose fields depend on (s, t, salt). */
function fill(f: WorldFrame, s: number, t: number, rng: Mulberry32): void {
  f.setPresent(s, t);
  f.serial[s] = 1;
  f.originX[s] = (rng.nextU32() % 400000) - 200000;
  f.originY[s] = (rng.nextU32() % 400000) - 200000;
  f.originZ[s] = (rng.nextU32() % 40000) - 20000;
  f.entVelX[s] = (rng.nextU32() % 60000) - 30000;
  f.entVelY[s] = (rng.nextU32() % 60000) - 30000;
  f.entVelZ[s] = (rng.nextU32() % 60000) - 30000;
  f.yaw[s] = rng.nextU32() & 0xffff;
  f.pitch[s] = (rng.nextU32() % 30000) - 15000;
  f.flags[s] = rng.nextU32() & 0b11;
  f.team[s] = s % 2 === 0 ? TEAM_1 : TEAM_2;
  f.teleportSeq[s] = 1;
}

/** A demo of `ticks` ticks with `players` slots moving hard: bytes and each tick's digest. */
function build(players: number, ticks: number, keyframe = 600) {
  const h = header();
  const head = encodeDemoHeader(h) as Uint8Array;
  const parts: Uint8Array[] = [head];
  const rec = (kind: number, tick: number, bytes: Uint8Array, len: number) => {
    const out = new Uint8Array(DEMO_RECORD_HEADER_BYTES + len);
    writeDemoRecordHeader(out, 0, kind, tick, len);
    out.set(bytes.subarray(0, len), DEMO_RECORD_HEADER_BYTES);
    parts.push(out);
  };
  const rng = new Mulberry32(7);
  const digests: number[] = [];
  let prev: WorldFrame | null = null;
  const w = new BitWriter(MAX_RELIABLE_BYTES);
  const hdr = new SnapshotHeader();
  for (let i = 0; i < ticks; i++) {
    const t = h.startTick + i;
    const f = new WorldFrame();
    for (let s = 0; s < players; s++) fill(f, s, t, rng);
    hdr.serverTick = t;
    const base = i % keyframe === 0 ? null : prev;
    hdr.baseBack = base === null ? 0 : 1;
    hdr.flags = SNAP_FLAG_SPECTATOR;
    hdr.cvarHash = 0x1234;
    w.reset();
    expect(encodeSnapshot(w, hdr, f, base, -1)).toBe(true);
    rec(DEMO_REC_SNAPSHOT, t, w.bytes, w.byteLength);
    digests.push(frameDigest(f, -1));
    if (i === 0) {
      const m = new EventsMsg();
      for (let s = 0; s < players; s++) {
        const e = m.add(EVK_PLAYER_JOIN);
        if (e !== null) {
          e.clientId = s;
          e.team = s % 2 === 0 ? TEAM_1 : TEAM_2;
        }
      }
      w.reset();
      expect(encodeEvents(w, m)).toBe(true);
      rec(DEMO_REC_EVENTS, t, w.bytes, w.byteLength);
    }
    if (i === 2) {
      const c = new CvarsMsg();
      c.effectiveTick = t + 1;
      c.block.entries.push({ name: "sv_cheats", type: "int", value: 1 });
      w.reset();
      expect(encodeCvars(w, c)).toBe(true);
      rec(DEMO_REC_CVARS, t, w.bytes, w.byteLength);
    }
    prev = f;
  }
  rec(DEMO_REC_END, h.startTick + ticks - 1, new Uint8Array(0), 0);
  const total = parts.reduce((n, p) => n + p.length, 0);
  const bytes = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    bytes.set(p, at);
    at += p.length;
  }
  return { bytes, digests, headerLength: head.length };
}

describe("demo file (D-044)", () => {
  it("has the header layout of M3 design §2.12 (golden)", () => {
    const h = header(0x01020304);
    const bytes = encodeDemoHeader(h) as Uint8Array;
    // "ISDM", demoVersion 1, protocol 2, 60 Hz, startTick 0x01020304 (LE); mapName (u8 13 +
    // "arena_greybox"); the map hash lo then hi; buildHash (u8 7 + "abc1234"); the cvar block's
    // u16 length (24) and the encoded CVARS (type 8, effectiveTick 0, the block's hash, the block).
    expect(hex(bytes)).toBe(
      "4953444d" +
        "0100" +
        "0200" +
        "3c" +
        "04030201" +
        "0d" +
        "6172656e615f67726579626f78" +
        "6ccd78e4" +
        "80fb0e99" +
        "07" +
        "61626331323334" +
        "1800" +
        "080000000033603996012473fb778c2e87e9730000000000",
    );
    expect(PROTOCOL_VERSION).toBe(2);
    expect(TICK_RATE).toBe(60);
    const back = new DemoHeader();
    expect(decodeDemoHeader(bytes, bytes.length, back)).toBeNull();
    expect(back.length).toBe(bytes.length);
    expect(back).toMatchObject({
      demoVersion: 1,
      protocolVersion: PROTOCOL_VERSION,
      tickRate: TICK_RATE,
      startTick: 0x01020304,
      mapName: "arena_greybox",
      buildHash: "abc1234",
    });
    expect(demoMapHash(back)).toBe("990efb80e478cd6c");
    expect(back.cvars.block.entries).toEqual([{ name: "sv_cheats", type: "int", value: 0 }]);
  });

  it("refuses a header field the layout can't carry", () => {
    for (const patch of [
      (h: DemoHeader) => {
        h.mapName = "../x";
      },
      (h: DemoHeader) => {
        h.mapName = "";
      },
      (h: DemoHeader) => {
        h.buildHash = "x".repeat(64);
      },
      (h: DemoHeader) => {
        h.buildHash = "tab\t";
      },
      (h: DemoHeader) => {
        h.startTick = 0;
      },
    ]) {
      const h = header();
      patch(h);
      expect(encodeDemoHeader(h)).toBeNull();
    }
  });

  it("validates a demo, counting its records, and hands the visitor each frame", () => {
    const { bytes, digests } = build(8, 700);
    const got: number[] = [];
    let joins = 0;
    let cvars = 0;
    const check = validateDemo(bytes, bytes.length, {
      snapshot: (_t, _h, f) => got.push(frameDigest(f, -1)),
      events: (_t, m) => {
        joins += m.count;
      },
      cvars: () => {
        cvars++;
      },
    });
    if (!check.ok) throw new Error(check.error);
    expect(got).toEqual(digests);
    expect(joins).toBe(8);
    expect(cvars).toBe(1);
    expect(check.summary).toMatchObject({
      snapshots: 700,
      events: 1,
      cvars: 1,
      keyframes: 2,
      firstTick: 100,
      lastTick: 799,
      endTick: 799,
      bytes: bytes.length,
    });
  });

  it("keeps a 64-player spectator snapshot under 2048 B, with every slot a record", () => {
    const { bytes, digests } = build(FRAME_SLOTS, 30);
    const got: number[] = [];
    const check = validateDemo(bytes, bytes.length, {
      snapshot: (_t, _h, f) => got.push(frameDigest(f, -1)),
    });
    if (!check.ok) throw new Error(check.error);
    expect(got).toEqual(digests);
    expect(check.summary.snapshotBytesMax).toBeLessThanOrEqual(MAX_SPECTATOR_SNAPSHOT_BYTES);
    expect(check.summary.snapshotBytesMax).toBeGreaterThan(1100);
  });

  it("walks records without allocating views, and stops at the END", () => {
    const { bytes, headerLength } = build(2, 3);
    const rd = new DemoReader();
    rd.reset(bytes, bytes.length, headerLength);
    const kinds: number[] = [];
    while (rd.next()) kinds.push(rd.kind);
    expect(kinds).toEqual([
      DEMO_REC_SNAPSHOT,
      DEMO_REC_EVENTS,
      DEMO_REC_SNAPSHOT,
      DEMO_REC_SNAPSHOT,
      DEMO_REC_CVARS,
    ]);
    expect(rd.ended).toBe(true);
    expect(rd.error).toBeNull();
    const dst = new Uint8Array(4);
    copyDemoBytes(dst, Uint8Array.of(9, 8, 7, 6, 5), 1, 3);
    expect([...dst]).toEqual([8, 7, 6, 0]);
  });

  it("refuses every truncation and never throws on bit flips", () => {
    const { bytes } = build(3, 6);
    for (let n = 0; n < bytes.length; n++) {
      const check = validateDemo(bytes, n);
      expect(check.ok, `truncated to ${n}`).toBe(false);
    }
    const rng = new Mulberry32(99);
    let refused = 0;
    for (let i = 0; i < 1000; i++) {
      const b = bytes.slice();
      const flips = 1 + (rng.nextU32() % 3);
      for (let k = 0; k < flips; k++) {
        const bit = rng.nextU32() % (b.length * 8);
        b[bit >> 3] = (b[bit >> 3] as number) ^ (1 << (bit & 7));
      }
      const check = validateDemo(b);
      if (!check.ok) refused++;
    }
    // Flips inside a snapshot's field values often still decode: those are other valid demos.
    expect(refused).toBeGreaterThan(330);
    for (let i = 0; i < 600; i++) {
      const b = new Uint8Array(rng.nextU32() % 200);
      for (let k = 0; k < b.length; k++) b[k] = rng.nextU32() & 0xff;
      if (i % 2 === 0 && b.length >= 4) b.set([0x49, 0x53, 0x44, 0x4d], 0);
      expect(validateDemo(b).ok).toBe(false);
    }
  });

  it.each([
    ["unknown kind", (b: Uint8Array, at: number) => (b[at] = 7), /unknown record kind 7/],
    [
      "a length past the end",
      (b: Uint8Array, at: number) => {
        b[at + 5] = 0xff;
        b[at + 6] = 0x07;
      },
      /runs past the end|over its kind/,
    ],
    [
      "an oversize snapshot",
      (b: Uint8Array, at: number) => {
        b[at + 5] = 0x01;
        b[at + 6] = 0x08;
      },
      /over its kind's 2048 B/,
    ],
    [
      "a tick before the start",
      (b: Uint8Array, at: number) => {
        b[at + 1] = 1;
        b[at + 2] = 0;
      },
      /steps back/,
    ],
  ])("refuses %s, with the byte offset", (_what, patch, reason) => {
    const { bytes, headerLength } = build(2, 4);
    const b = bytes.slice();
    patch(b, headerLength);
    const check = validateDemo(b);
    expect(check.ok).toBe(false);
    if (!check.ok) expect(check.error).toMatch(reason);
  });

  it("refuses bytes after END, a missing END, live snapshots and baselines it doesn't hold", () => {
    const { bytes, headerLength } = build(2, 4);
    const extra = new Uint8Array(bytes.length + 1);
    extra.set(bytes);
    expect(refusal(validateDemo(extra))).toMatch(/after the END/);
    expect(refusal(validateDemo(bytes, bytes.length - DEMO_RECORD_HEADER_BYTES))).toMatch(
      /no END record/,
    );
    // The first snapshot's flags byte: SPECTATOR cleared makes it a live snapshot.
    const live = bytes.slice();
    // The flags follow the type (8), the tick (32) and baseBack (6): SPECTATOR is bit 2 of them.
    expect(SNAP_FLAG_SPECTATOR).toBe(1 << 2);
    const bit = 8 + 32 + 6 + 2;
    const at = headerLength + DEMO_RECORD_HEADER_BYTES + (bit >> 3);
    live[at] = (live[at] as number) & ~(1 << (bit & 7));
    expect(refusal(validateDemo(live))).toMatch(/not a spectator snapshot/);
    // Without its keyframe the first delta has no baseline.
    const { bytes: two } = build(2, 3);
    const h = new DemoHeader();
    decodeDemoHeader(two, two.length, h);
    const rd = new DemoReader();
    rd.reset(two, two.length, h.length);
    rd.next();
    const firstEnd = rd.offset + rd.size;
    const cut = new Uint8Array(two.length - (firstEnd - h.length));
    cut.set(two.subarray(0, h.length));
    cut.set(two.subarray(firstEnd), h.length);
    expect(refusal(validateDemo(cut))).toMatch(
      /a delta against tick 100, which the demo does not hold/,
    );
  });

  it("refuses another demo version or protocol, with the reason", () => {
    const { bytes } = build(1, 2);
    const v2 = bytes.slice();
    v2[4] = 2;
    expect(refusal(validateDemo(v2))).toMatch(/demo version 2 is not supported/);
    const p9 = bytes.slice();
    p9[6] = 9;
    expect(refusal(validateDemo(p9))).toMatch(/recorded with protocol 9/);
    expect(refusal(validateDemo(new Uint8Array([1, 2, 3])))).toMatch(/not a demo/);
  });

  // Records of build(2, 4): SNAPSHOT 100 (keyframe), EVENTS 100, SNAPSHOT 101, SNAPSHOT 102,
  // CVARS 102, SNAPSHOT 103, END 103.
  it.each([
    ["a repeated snapshot tick", (r: Rec[]) => r.splice(3, 0, r[2] as Rec), /repeats tick 101/],
    [
      "a snapshot filed under another tick",
      (r: Rec[]) => setTick(r[2] as Rec, 102),
      /SNAPSHOT at byte \d+ is of tick 101, its record 102/,
    ],
    [
      "an END that steps back",
      (r: Rec[]) => setTick(r[6] as Rec, 101),
      /END record at byte \d+ steps back to tick 101/,
    ],
    [
      "a tick past TICK_MAX",
      (r: Rec[]) => setTick(r[4] as Rec, TICK_MAX + 1),
      /has tick \d+ past TICK_MAX/,
    ],
    [
      "an END with a body",
      (r: Rec[]) => {
        const end = r[6] as Rec;
        end.bytes = Uint8Array.of(end.bytes[0] as number, 103, 0, 0, 0, 1, 0, 0);
      },
      /is 1 B, over its kind's 0 B/,
    ],
  ])("refuses %s, with the reason", (_what, patch, reason) => {
    const { bytes, headerLength } = build(2, 4);
    const r = recordsOf(bytes, headerLength);
    expect(r.map((x) => x.bytes[0])).toEqual([
      DEMO_REC_SNAPSHOT,
      DEMO_REC_EVENTS,
      DEMO_REC_SNAPSHOT,
      DEMO_REC_SNAPSHOT,
      DEMO_REC_CVARS,
      DEMO_REC_SNAPSHOT,
      DEMO_REC_END,
    ]);
    patch(r);
    expect(refusal(validateDemo(join(bytes.subarray(0, headerLength), r)))).toMatch(reason);
  });

  it("accepts a first keyframe after the start tick (a failed start-tick snapshot)", () => {
    const { bytes, headerLength } = build(2, 4);
    const r = recordsOf(bytes, headerLength);
    // The header says 99: tick 99's snapshot did not encode, so the keyframe came at 100.
    const head = bytes.slice(0, headerLength);
    head[9] = 99;
    const check = validateDemo(join(head, r));
    if (!check.ok) throw new Error(check.error);
    expect(check.header.startTick).toBe(99);
    expect(check.summary.firstTick).toBe(100);
  });
});

interface Rec {
  /** The record's header and message. */
  bytes: Uint8Array;
}

/** The records of a demo, END included, each as its own bytes. */
function recordsOf(bytes: Uint8Array, start: number): Rec[] {
  const rd = new DemoReader();
  rd.reset(bytes, bytes.length, start);
  const out: Rec[] = [];
  while (rd.next()) out.push({ bytes: bytes.slice(rd.at, rd.offset + rd.size) });
  expect(rd.ended).toBe(true);
  out.push({ bytes: bytes.slice(rd.at, rd.offset + rd.size) });
  return out;
}

function setTick(r: Rec, tick: number): void {
  const b = r.bytes;
  writeDemoRecordHeader(b, 0, b[0] as number, tick, (b[5] as number) | ((b[6] as number) << 8));
}

function join(head: Uint8Array, recs: readonly Rec[]): Uint8Array {
  const total = recs.reduce((n, r) => n + r.bytes.length, head.length);
  const out = new Uint8Array(total);
  out.set(head);
  let at = head.length;
  for (const r of recs) {
    out.set(r.bytes, at);
    at += r.bytes.length;
  }
  return out;
}

/** The reason a validation refused (fails the test when it passed). */
function refusal(check: ReturnType<typeof validateDemo>): string {
  if (check.ok) throw new Error("validateDemo accepted it");
  return check.error;
}
