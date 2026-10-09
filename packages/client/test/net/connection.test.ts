import {
  BitReader,
  BitWriter,
  decodeInput,
  encodeSnapshot,
  InputMsg,
  MAX_UNRELIABLE_BYTES,
  type MessageHandler,
  PlayerState,
  playerStateToSlot,
  SnapshotHeader,
  type Transport,
  type TransportStats,
  UserCmd,
  WorldFrame,
} from "@game/shared";
import { describe, expect, it } from "vitest";
import type { ClientClock } from "../../src/net/clock";
import { CONN_ACTIVE, Connection, type ConnectionHandler } from "../../src/net/connection";
import { CmdRing } from "../../src/net/predictor";
import { BASELINE_MISSES_BEFORE_FULL } from "../../src/net/snapshotStore";
import {
  NetStats,
  STAT_BASELINE_DROPS,
  STAT_FULL_SNAPSHOTS,
  STAT_STRIKES,
} from "../../src/net/stats";

// The Connection's snapshot wiring (M3 design §2.3, D-038): what INPUT acks and how SNAPSHOT
// results are counted. The match reads the ack only from increment 9, so these pin it here.

const SELF = 1;

/** A transport that records what the client sends and delivers what the test injects. */
class FakeTransport implements Transport {
  sent: Uint8Array[] = [];
  private handler: MessageHandler | null = null;
  sendUnreliable(d: Uint8Array, len: number): void {
    this.sent.push(d.slice(0, len));
  }
  sendReliable(): void {}
  onMessage(cb: MessageHandler): void {
    this.handler = cb;
  }
  onClose(): void {}
  poll(): void {}
  close(): void {}
  isOpen(): boolean {
    return true;
  }
  stats(): TransportStats {
    throw new Error("not used");
  }
  inject(bytes: Uint8Array): void {
    this.handler?.(bytes, bytes.length, false);
  }
}

/** The server's frame of `tick`: players 0–2 present, moving along x. */
function serverFrame(tick: number): WorldFrame {
  const f = new WorldFrame();
  const ps = new PlayerState();
  for (let s = 0; s < 3; s++) {
    f.setPresent(s, tick);
    ps.origin[0] = tick * 3 + s;
    playerStateToSlot(f, s, ps);
  }
  return f;
}

/** The SNAPSHOT of `tick` for SELF: full, or a delta against the server's frame of `baseTick`. */
function snapshot(tick: number, baseTick = 0): Uint8Array {
  const h = new SnapshotHeader();
  h.serverTick = tick;
  h.baseBack = baseTick === 0 ? 0 : tick - baseTick;
  const w = new BitWriter(MAX_UNRELIABLE_BYTES);
  const base = baseTick === 0 ? null : serverFrame(baseTick);
  if (!encodeSnapshot(w, h, serverFrame(tick), base, SELF)) throw new Error("did not encode");
  return w.bytes.slice(0, w.byteLength);
}

function setup() {
  const transport = new FakeTransport();
  const stats = new NetStats(new Float64Array(1));
  const handler: ConnectionHandler = {
    onWelcome: () => null,
    mapReady: () => true,
    onSnapshot: () => {},
    onCvars: () => {},
    onPrint: () => {},
    onClosed: () => {},
  };
  const conn = new Connection(transport, {} as ClientClock, stats, handler, "test", 1);
  // Past the handshake (covered by the client session tests): a live session as SELF.
  conn.state = CONN_ACTIVE;
  conn.clientId = SELF;
  const cmds = new CmdRing();
  const cmd = new UserCmd();
  const input = new InputMsg();
  const reader = new BitReader();
  let tick = 0;
  /** Sends the next INPUT and returns the ack it carried. */
  const ack = (): number => {
    cmd.tick = ++tick;
    cmds.write(cmd);
    conn.sendInput(cmds, tick);
    const bytes = transport.sent[transport.sent.length - 1] as Uint8Array;
    reader.reset(bytes, bytes.length);
    if (!decodeInput(reader, input)) throw new Error("INPUT did not decode");
    return input.lastSnapshotTick;
  };
  return { transport, stats, ack };
}

describe("Connection: snapshot acks and counts (M3 design §2.3, D-038)", () => {
  it("acks the newest stored snapshot, also after a reordered older one", () => {
    const { transport, stats, ack } = setup();
    expect(ack()).toBe(0);
    transport.inject(snapshot(10));
    expect(ack()).toBe(10);
    transport.inject(snapshot(12, 10));
    expect(ack()).toBe(12);
    transport.inject(snapshot(11, 10));
    expect(ack()).toBe(12);
    expect(stats.totals[STAT_FULL_SNAPSHOTS]).toBe(1);
    expect(stats.totals[STAT_STRIKES]).toBe(0);
  });

  it("counts a missing baseline without striking, and acks 0 after 8 in a row until a full one", () => {
    const { transport, stats, ack } = setup();
    transport.inject(snapshot(20));
    for (let i = 0; i < BASELINE_MISSES_BEFORE_FULL - 1; i++)
      transport.inject(snapshot(30 + i, 25));
    expect(ack()).toBe(20);
    transport.inject(snapshot(40, 25));
    expect(ack()).toBe(0);
    expect(stats.totals[STAT_BASELINE_DROPS]).toBe(BASELINE_MISSES_BEFORE_FULL);
    expect(stats.totals[STAT_STRIKES]).toBe(0);
    transport.inject(snapshot(41));
    expect(ack()).toBe(41);
    expect(stats.totals[STAT_FULL_SNAPSHOTS]).toBe(2);
    // A snapshot that does not decode is struck.
    transport.inject(new Uint8Array([5, 0, 0]));
    expect(stats.totals[STAT_STRIKES]).toBe(1);
  });
});
