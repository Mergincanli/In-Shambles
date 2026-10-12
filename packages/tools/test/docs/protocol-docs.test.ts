import { readFileSync } from "node:fs";
import * as shared from "@game/shared";
import {
  BitWriter,
  CHANNEL_RELIABLE,
  CHANNEL_UNKNOWN,
  CHANNEL_UNRELIABLE,
  CmdMsg,
  CVAR_HASH_SEED,
  DELTA_ENTITY_MASK_BITS,
  DELTA_LOCAL_MASK_BITS,
  ENTITY_DELTA_MAX_BITS,
  ENTITY_NEW_BITS,
  ENTITY_REMOVED_BITS,
  EVENTS_MAX_PER_MSG,
  EVK_PLAYER_JOIN,
  EVK_PLAYER_LEAVE,
  EVK_SERVER_STATS,
  EventsMsg,
  encodeCmd,
  encodeEvents,
  encodeHello,
  encodeInput,
  encodeKick,
  encodePing,
  encodePong,
  encodePrint,
  encodeReady,
  encodeSnapshot,
  eventBits,
  HelloMsg,
  InputMsg,
  KickMsg,
  LOCAL_DELTA_MAX_BITS,
  MATCH_MAX_CLIENTS,
  MAX_CLIENT_MESSAGE_BYTES,
  MAX_RELIABLE_BYTES,
  MAX_SNAPSHOT_BYTES,
  MAX_UNRELIABLE_BYTES,
  MSG_CHANNEL,
  PingMsg,
  PLAYER_STATE_BITS,
  PongMsg,
  PROTOCOL_VERSION,
  PrintMsg,
  SHORT_TEXT_MAX,
  SNAP_DEFERRED_COUNT_BITS,
  SNAP_DEFERRED_ID_BITS,
  SNAP_DELTA_FIXED_BITS,
  SNAP_ENTITY_VELOCITY_D1,
  SNAP_ENTITY_VELOCITY_D2,
  SNAP_FIT_MAX_PLAYERS,
  SNAP_FLAG_BITS,
  SNAP_FLAG_DEFERRED,
  SNAP_FLAG_MASK,
  SNAP_FLAG_SPECTATOR,
  SNAP_FLAG_STARVED,
  SNAP_FULL_FIXED_BITS,
  SNAP_HEADER_BITS,
  SNAP_LOCAL_VELOCITY_D1,
  SNAP_LOCAL_VELOCITY_D2,
  SNAP_MIN_CAPACITY,
  SNAP_ORIGIN_D1,
  SNAP_ORIGIN_D2,
  SNAP_STARVE_SEQ_BITS,
  SNAP_STARVE_SEQ_MASK,
  SnapshotHeader,
  TEXT_MAX,
  type UserCmd,
  WorldFrame,
} from "@game/shared";
import { describe, expect, it } from "vitest";
import { firstTable, mdSection } from "../../src/docs/mdTable";
import { fromRoot } from "../../src/paths";

// Doc-golden test (D-026, D-033): docs/05 §3.6 states the protocol layout the codecs implement.
// The type ids, the player-state, snapshot-header and entity-record widths, the delta masks' bit
// assignments, the packet sizes (exact or the largest) and the cvar hash seed must match the
// code, so a layout change can't land without its doc (and its PROTOCOL_VERSION bump).

const doc = readFileSync(fromRoot("docs", "05-netcode.md"), "utf8");
const layout = mdSection(doc, `3.6 Protocol v${PROTOCOL_VERSION} layout`);

/** MSG_* constants of @game/shared, by name (HELLO → 1, …). */
function messageIds(): Map<string, number> {
  const ids = new Map<string, number>();
  for (const [key, value] of Object.entries(shared)) {
    const m = /^MSG_([A-Z]+)$/.exec(key);
    if (m?.[1] && m[1] !== "TYPE" && typeof value === "number") ids.set(m[1], value);
  }
  return ids;
}

/** The sum of a widths table's "Bits" column ("21" or "3 × 21"). */
function tableBits(after: string): number {
  const table = firstTable(layout.slice(layout.indexOf(after)));
  let bits = 0;
  for (const row of table.rows) {
    const cell = row[1] ?? "";
    const m = /^(?:(\d+) × )?(\d+)$/.exec(cell);
    if (!m) throw new Error(`unexpected width "${cell}"`);
    bits += Number(m[1] ?? 1) * Number(m[2]);
  }
  return bits;
}

/** The cells of the row named `name` (first column) in the first table after `after`. */
function tableRow(after: string, name: string): string {
  const table = firstTable(layout.slice(layout.indexOf(after)));
  const row = table.rows.find((r) => r[0] === name);
  if (!row) throw new Error(`no row "${name}" after ${after}`);
  return row.join(" | ");
}

describe("docs/05 §3.6 protocol layout", () => {
  it("names the protocol version the code sends", () => {
    expect(doc).toContain(
      `### 3.6 Protocol v${PROTOCOL_VERSION} layout (\`PROTOCOL_VERSION\` = ${PROTOCOL_VERSION}`,
    );
  });

  it("lists every message type id, and the message table has a row for each", () => {
    const listed = new Map(
      [...layout.matchAll(/(\d+) `([A-Z]+)`/g)].map((m) => [m[2] ?? "", Number(m[1])] as const),
    );
    expect(listed).toEqual(messageIds());
    const rows = firstTable(layout).rows.map((r) => /^`([A-Z]+)`/.exec(r[0] ?? "")?.[1]);
    expect(rows.sort()).toEqual([...messageIds().keys()].sort());
  });

  it("gives the player-state widths the codec writes", () => {
    expect(tableBits("**Player state**")).toBe(PLAYER_STATE_BITS);
    expect(layout).toContain(`(\`shared/src/net/playerStateCodec.ts\`, ${PLAYER_STATE_BITS} bits)`);
  });

  it("gives the snapshot header and entity record widths the codec writes (D-033)", () => {
    expect(tableBits("**Snapshot header**")).toBe(SNAP_HEADER_BITS);
    expect(layout).toContain(`(\`shared/src/net/snapshot.ts\`, ${SNAP_HEADER_BITS} bits with`);
    expect(tableBits("**Entity record**")).toBe(ENTITY_NEW_BITS);
    expect(layout).toContain(`the full ("new") form, ${ENTITY_NEW_BITS} bits:`);
  });

  // Inc. 4 landed the full forms (D-033), inc. 8 the deltas and removals (D-038), inc. 10 the
  // deferred list and pending slots (D-046): nothing is refused "until" a later decision any more.
  it("gives the delta forms (D-038) and the deferred list (D-046)", () => {
    expect(layout).not.toContain("until D-038");
    expect(layout).not.toContain("until D-046");
    expect(tableRow("**Snapshot header**", "baseBack")).toContain("1–63 = a delta");
    expect(tableRow("**Entity record**", "removed")).toContain("1: the player left");
    expect(tableRow("**Entity record**", "new")).toContain("0: a delta body follows");
    expect(tableRow("**Snapshot header**", "flags")).toContain(
      "bit 3 deferred: the deferred list follows the records (D-046)",
    );
    expect(tableRow("**Deferred list**", "count")).toBe(
      `count | ${SNAP_DEFERRED_COUNT_BITS} | 1–63; 0 is refused`,
    );
    expect(tableRow("**Deferred list**", "ids")).toContain(`count × ${SNAP_DEFERRED_ID_BITS}`);
    expect(SNAP_FLAG_DEFERRED).toBe(1 << 3);
  });

  it("splits the flags byte into the flags and the starve counter (D-050)", () => {
    const flags = tableRow("**Snapshot header**", "flags");
    const counter = tableRow("**Snapshot header**", "starveSeq");
    expect(flags).toContain(
      `flags | ${SNAP_FLAG_BITS} | bits 0–3 of the flags byte: bit 0 starved`,
    );
    expect(flags).toContain("bit 2 spectator");
    expect(flags).toContain("bit 1 (v1's teleport flag) must be 0");
    expect(flags).not.toContain("bits 4–7");
    expect(counter).toContain(
      `starveSeq | ${SNAP_STARVE_SEQ_BITS} | bits 4–7 of the flags byte: the receiver's starve ` +
        `counter (D-050), 0–${SNAP_STARVE_SEQ_MASK}`,
    );
    expect(counter).toContain("0 when spectator");
    // One byte between them, the flags in its low half.
    expect(SNAP_FLAG_BITS + SNAP_STARVE_SEQ_BITS).toBe(8);
    expect(SNAP_FLAG_MASK).toBeLessThan(1 << SNAP_FLAG_BITS);
    expect([SNAP_FLAG_STARVED, SNAP_FLAG_SPECTATOR, SNAP_FLAG_DEFERRED]).toEqual([1, 4, 8]);
    // The rows follow the codec's order: flags, then the counter, then cvarHash.
    const rows = firstTable(layout.slice(layout.indexOf("**Snapshot header**"))).rows.map(
      (r) => r[0],
    );
    expect(rows.slice(rows.indexOf("flags"), rows.indexOf("flags") + 3)).toEqual([
      "flags",
      "starveSeq",
      "cvarHash",
    ]);
  });

  it("gives the delta local block and delta record widths at their largest (D-038)", () => {
    expect(tableBits("**Delta local block**")).toBe(LOCAL_DELTA_MAX_BITS);
    expect(layout).toContain(`which must hold state), at most ${LOCAL_DELTA_MAX_BITS} bits:`);
    expect(tableBits("**Delta entity record**")).toBe(ENTITY_DELTA_MAX_BITS);
    expect(layout).toContain(
      `which must hold state for it), at most ${ENTITY_DELTA_MAX_BITS} bits:`,
    );
    expect(layout).toContain(`a removal is its first two fields, ${ENTITY_REMOVED_BITS} bits,`);
    // The class widths (protocol.ts) as the tables give them.
    const classes = (d1: number, d2: number, full: number) =>
      `class 2 + i${d1} / i${d2} / absolute i${full}`;
    expect(tableRow("**Delta local block**", "origin x, y, z")).toContain(
      classes(SNAP_ORIGIN_D1, SNAP_ORIGIN_D2, 21),
    );
    expect(tableRow("**Delta local block**", "velocity x, y, z")).toContain(
      classes(SNAP_LOCAL_VELOCITY_D1, SNAP_LOCAL_VELOCITY_D2, 20),
    );
    expect(tableRow("**Delta entity record**", "origin x, y, z")).toContain(
      classes(SNAP_ORIGIN_D1, SNAP_ORIGIN_D2, 21),
    );
    expect(tableRow("**Delta entity record**", "velocity x, y, z")).toContain(
      classes(SNAP_ENTITY_VELOCITY_D1, SNAP_ENTITY_VELOCITY_D2, 16),
    );
    // The worst delta of 32 and of SNAP_FIT_MAX_PLAYERS players, as the size bullet states.
    const bytes = (others: number) =>
      (SNAP_DELTA_FIXED_BITS + others * ENTITY_DELTA_MAX_BITS + 7) >> 3;
    expect(layout).toContain(
      `${SNAP_DELTA_FIXED_BITS} bits + ${ENTITY_DELTA_MAX_BITS} per other player) takes ` +
        `${bytes(31)} B at 32 players and ${bytes(SNAP_FIT_MAX_PLAYERS - 1)} B at ` +
        `${SNAP_FIT_MAX_PLAYERS},`,
    );
  });

  it("gives the delta masks' bit assignments the codec uses (D-038)", () => {
    // "bit 0 origin, 1 velocity, …[; note]" → each field's mask value.
    const maskBits = (after: string) => {
      const cell = tableRow(after, "mask").split(" | ")[2] ?? "";
      const list = (cell.split(";")[0] ?? "").replace(/^bit /, "").split(", ");
      return Object.fromEntries(
        list.map((item) => {
          const m = /^(\d+) (.+)$/.exec(item);
          if (!m) throw new Error(`unexpected mask item "${item}" after ${after}`);
          return [m[2], 1 << Number(m[1])];
        }),
      );
    };
    expect(maskBits("**Delta local block**")).toEqual(DELTA_LOCAL_MASK_BITS);
    expect(maskBits("**Delta entity record**")).toEqual(DELTA_ENTITY_MASK_BITS);
    // Eight distinct bits each: the 8-bit mask, all of it in use.
    for (const table of [DELTA_LOCAL_MASK_BITS, DELTA_ENTITY_MASK_BITS]) {
      expect(Object.values(table).reduce((a, b) => a | b, 0)).toBe(0xff);
      expect(new Set(Object.values(table)).size).toBe(8);
    }
  });

  it("states the sizes of a full snapshot, the worst delta and a four-cmd INPUT", () => {
    const rows = firstTable(layout).rows;
    const size = (name: string) => rows.find((r) => r[0]?.startsWith(`\`${name}\``))?.[3];
    const w = new BitWriter(MAX_UNRELIABLE_BYTES);
    const h = new SnapshotHeader();
    h.serverTick = 1;
    const frame = new WorldFrame();
    const bytesWith = (others: number) => {
      frame.clear();
      for (let s = 0; s <= others; s++) frame.setPresent(s, 1);
      w.reset();
      expect(encodeSnapshot(w, h, frame, null, 0)).toBe(true);
      return w.byteLength;
    };
    const worstDelta = (others: number) =>
      (SNAP_DELTA_FIXED_BITS + others * ENTITY_DELTA_MAX_BITS + 7) >> 3;
    // The scheduler's worst at 64 players (D-046): SNAP_MIN_CAPACITY records, the rest deferred.
    const left = MATCH_MAX_CLIENTS - 1 - SNAP_MIN_CAPACITY;
    const scheduledBits =
      SNAP_DELTA_FIXED_BITS +
      SNAP_DEFERRED_COUNT_BITS +
      SNAP_MIN_CAPACITY * ENTITY_DELTA_MAX_BITS +
      left * SNAP_DEFERRED_ID_BITS;
    const scheduled = (scheduledBits + 7) >> 3;
    expect(size("SNAPSHOT")).toBe(
      `full: ${SNAP_FULL_FIXED_BITS} bits + ${ENTITY_NEW_BITS} per other player, ` +
        `${bytesWith(0)} B alone, ${bytesWith(31)} B at 32 players; worst delta: ` +
        `${SNAP_DELTA_FIXED_BITS} bits + ${ENTITY_DELTA_MAX_BITS} per other player, ` +
        `${worstDelta(31)} B at 32, ${worstDelta(SNAP_FIT_MAX_PLAYERS - 1)} B at ` +
        `${SNAP_FIT_MAX_PLAYERS}; worst scheduled at ${MATCH_MAX_CLIENTS}: ${scheduled} B ` +
        `(D-046); ≤ ${MAX_SNAPSHOT_BYTES} B`,
    );
    expect(layout).toContain(
      `its worst, ${SNAP_MIN_CAPACITY} records and ${left} deferred ids at ${MATCH_MAX_CLIENTS} ` +
        `players, is ${SNAP_DELTA_FIXED_BITS} + ${SNAP_DEFERRED_COUNT_BITS} + ` +
        `${SNAP_MIN_CAPACITY} × ${ENTITY_DELTA_MAX_BITS} + ${left} × ${SNAP_DEFERRED_ID_BITS} = ` +
        `${scheduledBits} bits, ${scheduled} B.`,
    );
    const input = new InputMsg();
    input.count = 4;
    for (let i = 0; i < 4; i++) (input.cmds[i] as UserCmd).tick = 10 - i;
    w.reset();
    encodeInput(w, input);
    expect(size("INPUT")).toBe(`${w.byteLength} B for 4 cmds`);
  });

  it("gives each EVENTS kind its number and width, and the largest EVENTS (D-043)", () => {
    const table = firstTable(layout.slice(layout.indexOf("**Events**")));
    const kinds: [string, number][] = [
      ["`PLAYER_JOIN`", EVK_PLAYER_JOIN],
      ["`PLAYER_LEAVE`", EVK_PLAYER_LEAVE],
      ["`SERVER_STATS`", EVK_SERVER_STATS],
    ];
    expect(table.rows.map((r) => r[1])).toEqual(kinds.map(([name]) => name));
    for (const [name, kind] of kinds) {
      const row = table.rows.find((r) => r[1] === name) as string[];
      expect(row[0], name).toBe(String(kind));
      expect(row[3], name).toBe(String(eventBits(kind)));
      // The payload's widths add up to the record's, with the kind's 4.
      const widths = [...(row[2] ?? "").matchAll(/[a-zA-Z0-9]+ (\d+)(?= |,|$|\()/g)];
      expect(4 + widths.reduce((a, m) => a + Number(m[1]), 0), name).toBe(eventBits(kind));
    }
    const m = new EventsMsg();
    for (let i = 0; i < EVENTS_MAX_PER_MSG; i++) m.add(EVK_SERVER_STATS);
    const w = new BitWriter(MAX_RELIABLE_BYTES);
    expect(encodeEvents(w, m)).toBe(true);
    const rows = firstTable(layout).rows;
    expect(rows.find((r) => r[0]?.startsWith("`EVENTS`"))?.[3]).toBe(
      `≤ ${w.byteLength} B (${EVENTS_MAX_PER_MSG} SERVER_STATS)`,
    );
  });

  it("states the largest HELLO, READY, PING, PONG, CMD, PRINT and KICK exactly", () => {
    const rows = firstTable(layout).rows;
    const size = (name: string) => rows.find((r) => r[0]?.startsWith(`\`${name}\``))?.[3];
    const w = new BitWriter(MAX_RELIABLE_BYTES);
    const bytes = (encode: (wr: BitWriter) => boolean) => {
      w.reset();
      expect(encode(w)).toBe(true);
      return w.byteLength;
    };
    const hello = new HelloMsg();
    hello.buildHash = "x".repeat(SHORT_TEXT_MAX);
    expect(size("HELLO")).toBe(`≤ ${bytes((wr) => encodeHello(wr, hello))} B`);
    expect(size("READY")).toBe(`${bytes(encodeReady)} B`);
    expect(size("PING")).toBe(`${bytes((wr) => encodePing(wr, new PingMsg()))} B`);
    expect(size("PONG")).toBe(`${bytes((wr) => encodePong(wr, new PongMsg()))} B`);
    const long = "x".repeat(TEXT_MAX);
    const cmd = new CmdMsg();
    cmd.text = long;
    expect(size("CMD")).toBe(`≤ ${bytes((wr) => encodeCmd(wr, cmd))} B`);
    const print = new PrintMsg();
    print.text = long;
    expect(size("PRINT")).toBe(`≤ ${bytes((wr) => encodePrint(wr, print))} B`);
    const kick = new KickMsg();
    kick.reason = long;
    expect(size("KICK")).toBe(`≤ ${bytes((wr) => encodeKick(wr, kick))} B`);
  });

  it("documents the cvar hash seed (§3.5)", () => {
    const section = mdSection(doc, "3.5 Replicated cvars");
    const seed = /seed `(0x[0-9a-f]+)`/.exec(section)?.[1];
    expect(Number(seed)).toBe(CVAR_HASH_SEED);
  });
});

// D-030: a WebSocket carries both channels and the receiver takes a message's channel from its
// type (MSG_CHANNEL), so the §3.3 channel column is wire behaviour too.
describe("docs/05 §3.3 message channels", () => {
  const types = mdSection(doc, "3.3 Message types");

  it("give every message type the channel MSG_CHANNEL assigns it, and no other type one", () => {
    const documented = new Map<number, number>();
    for (const row of firstTable(types).rows) {
      if (!/^v\d/.test(row[4] ?? "")) continue;
      const channel = row[2] === "reliable" ? CHANNEL_RELIABLE : CHANNEL_UNRELIABLE;
      expect(["reliable", "unreliable"], row[1]).toContain(row[2]);
      for (const m of (row[1] ?? "").matchAll(/`([A-Z]+)`/g)) {
        const id = messageIds().get(m[1] ?? "");
        expect(id, m[1]).toBeDefined();
        documented.set(id as number, channel);
      }
    }
    expect([...documented.keys()].sort((a, b) => a - b)).toEqual(
      [...messageIds().values()].sort((a, b) => a - b),
    );
    for (let type = 0; type < 256; type++) {
      expect(MSG_CHANNEL[type], `type ${type}`).toBe(documented.get(type) ?? CHANNEL_UNKNOWN);
    }
  });

  it("states the server's WebSocket frame cap (§3.2)", () => {
    expect(mdSection(doc, "3.2 Framing and versioning")).toContain(
      `\`MAX_CLIENT_MESSAGE_BYTES\` = ${MAX_CLIENT_MESSAGE_BYTES} B`,
    );
  });
});
