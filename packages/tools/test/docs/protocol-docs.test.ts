import { readFileSync } from "node:fs";
import * as shared from "@game/shared";
import {
  BitWriter,
  CmdMsg,
  CVAR_HASH_SEED,
  encodeCmd,
  encodeHello,
  encodeInput,
  encodeKick,
  encodePing,
  encodePong,
  encodePrint,
  encodeReady,
  encodeSnapshot,
  HelloMsg,
  InputMsg,
  KickMsg,
  MAX_RELIABLE_BYTES,
  MAX_UNRELIABLE_BYTES,
  PingMsg,
  PLAYER_STATE_BITS,
  PongMsg,
  PROTOCOL_VERSION,
  PrintMsg,
  SHORT_TEXT_MAX,
  SnapshotMsg,
  TEXT_MAX,
  type UserCmd,
} from "@game/shared";
import { describe, expect, it } from "vitest";
import { firstTable, mdSection } from "../../src/docs/mdTable";
import { fromRoot } from "../../src/paths";

// Doc-golden test (D-026): docs/05 §3.6 states the protocol v1 layout the codecs implement. The
// type ids, the player-state widths, the packet sizes (exact or the largest) and the cvar hash
// seed must match the code, so a layout change can't land without its doc (and its
// PROTOCOL_VERSION bump).

const doc = readFileSync(fromRoot("docs", "05-netcode.md"), "utf8");
const layout = mdSection(doc, "3.6 Protocol v1 layout");

/** MSG_* constants of @game/shared, by name (HELLO → 1, …). */
function messageIds(): Map<string, number> {
  const ids = new Map<string, number>();
  for (const [key, value] of Object.entries(shared)) {
    const m = /^MSG_([A-Z]+)$/.exec(key);
    if (m?.[1] && m[1] !== "TYPE" && typeof value === "number") ids.set(m[1], value);
  }
  return ids;
}

describe("docs/05 §3.6 protocol v1 layout", () => {
  it("names the protocol version the code sends", () => {
    expect(doc).toContain(`### 3.6 Protocol v1 layout (\`PROTOCOL_VERSION\` = ${PROTOCOL_VERSION}`);
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
    const table = firstTable(layout.slice(layout.indexOf("**Player state**")));
    let bits = 0;
    for (const row of table.rows) {
      const cell = row[1] ?? "";
      const m = /^(?:(\d+) × )?(\d+)$/.exec(cell);
      if (!m) throw new Error(`unexpected width "${cell}"`);
      bits += Number(m[1] ?? 1) * Number(m[2]);
    }
    expect(bits).toBe(PLAYER_STATE_BITS);
    expect(layout).toContain(`(\`shared/src/net/playerStateCodec.ts\`, ${PLAYER_STATE_BITS} bits)`);
  });

  it("states the sizes of a full snapshot and a four-cmd INPUT", () => {
    const rows = firstTable(layout).rows;
    const size = (name: string) => rows.find((r) => r[0]?.startsWith(`\`${name}\``))?.[3];
    const w = new BitWriter(MAX_UNRELIABLE_BYTES);
    encodeSnapshot(w, new SnapshotMsg());
    expect(size("SNAPSHOT")).toBe(`${w.bitLength} bits, ${w.byteLength} B`);
    const input = new InputMsg();
    input.count = 4;
    for (let i = 0; i < 4; i++) (input.cmds[i] as UserCmd).tick = 10 - i;
    w.reset();
    encodeInput(w, input);
    expect(size("INPUT")).toBe(`${w.byteLength} B for 4 cmds`);
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
