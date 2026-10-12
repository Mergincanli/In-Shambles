import {
  BitReader,
  BitWriter,
  copySlot,
  decodeInput,
  EVK_PLAYER_JOIN,
  EVK_SERVER_STATS,
  EventsMsg,
  encodeEvents,
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
import {
  CONN_ACTIVE,
  CONN_SPAWNING,
  CONN_SYNCING,
  Connection,
  type ConnectionHandler,
} from "../../src/net/connection";
import { CmdRing } from "../../src/net/predictor";
import { BASELINE_MISSES_BEFORE_FULL } from "../../src/net/snapshotStore";
import {
  NetStats,
  STAT_BASELINE_DROPS,
  STAT_BYTES_IN,
  STAT_BYTES_OUT,
  STAT_DEFERRED,
  STAT_DEFERRED_SNAPSHOTS,
  STAT_FRAMING_IN,
  STAT_FRAMING_OUT,
  STAT_FULL_SNAPSHOTS,
  STAT_SNAPSHOT_BYTES,
  STAT_SNAPSHOT_BYTES_MAX,
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
  inject(bytes: Uint8Array, reliable = false): void {
    this.handler?.(bytes, bytes.length, reliable);
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
    onEvents: () => {},
    onPrint: () => {},
    onClosed: () => {},
  };
  const conn = new Connection(
    transport,
    {} as ClientClock,
    stats,
    handler,
    "test",
    1,
    new Float64Array(1),
  );
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

  it("counts the players the scheduler left out and the snapshots that left any out (D-046)", () => {
    const { transport, stats } = setup();
    transport.inject(snapshot(10));
    // Tick 12 against 10 leaving players 0 and 2 out (their copies of tick 10).
    const sent = serverFrame(12);
    const old = serverFrame(10);
    copySlot(sent, 0, old, 0);
    copySlot(sent, 2, old, 2);
    const h = new SnapshotHeader();
    h.serverTick = 12;
    h.baseBack = 2;
    const w = new BitWriter(MAX_UNRELIABLE_BYTES);
    expect(encodeSnapshot(w, h, sent, old, SELF)).toBe(true);
    transport.inject(w.bytes.slice(0, w.byteLength));
    transport.inject(snapshot(13, 10));
    expect([stats.totals[STAT_DEFERRED], stats.totals[STAT_DEFERRED_SNAPSHOTS]]).toEqual([2, 1]);
  });
});

/** A FakeTransport that holds what the test queues until the connection polls. */
class QueuedTransport extends FakeTransport {
  private readonly pending: [Uint8Array, boolean][] = [];
  queue(bytes: Uint8Array, reliable: boolean): void {
    this.pending.push([bytes, reliable]);
  }
  override poll(): void {
    for (const [bytes, reliable] of this.pending.splice(0)) this.inject(bytes, reliable);
  }
}

/** An EVENTS message: a JOIN of client 2 on team 1 and a SERVER_STATS. */
function eventsBytes(): Uint8Array {
  const m = new EventsMsg();
  const join = m.add(EVK_PLAYER_JOIN);
  const stats = m.add(EVK_SERVER_STATS);
  if (join === null || stats === null) throw new Error("full");
  join.clientId = 2;
  join.team = 1;
  stats.tickP99Us = 300;
  stats.players = 3;
  const w = new BitWriter(MAX_UNRELIABLE_BYTES);
  if (!encodeEvents(w, m)) throw new Error("did not encode");
  return w.bytes.slice(0, w.byteLength);
}

describe("Connection: EVENTS, snapshot sizes and WebSocket framing (D-043)", () => {
  function eventsSetup(wsFraming: boolean) {
    const transport = new FakeTransport();
    const stats = new NetStats(new Float64Array(1));
    const got: string[] = [];
    const handler: ConnectionHandler = {
      onWelcome: () => null,
      mapReady: () => true,
      onSnapshot: () => {},
      onCvars: () => {},
      onEvents: (m) => {
        for (let i = 0; i < m.count; i++) {
          const e = m.events[i];
          got.push(`${e?.kind}:${e?.clientId}:${e?.team}:${e?.tickP99Us}:${e?.players}`);
        }
      },
      onPrint: () => {},
      onClosed: () => {},
    };
    const conn = new Connection(
      transport,
      {} as ClientClock,
      stats,
      handler,
      "test",
      1,
      new Float64Array(1),
      wsFraming,
    );
    conn.clientId = SELF;
    return { transport, stats, conn, got };
  }

  it("hands EVENTS on from READY on, and strikes them earlier or on the unreliable channel", () => {
    const { transport, stats, conn, got } = eventsSetup(false);
    const bytes = eventsBytes();
    conn.state = CONN_SYNCING;
    transport.inject(bytes, true);
    expect(got).toEqual([]);
    expect(stats.totals[STAT_STRIKES]).toBe(1);
    conn.state = CONN_SPAWNING;
    transport.inject(bytes, true);
    expect(got).toEqual([`${EVK_PLAYER_JOIN}:2:1:0:0`, `${EVK_SERVER_STATS}:0:0:300:3`]);
    conn.state = CONN_ACTIVE;
    transport.inject(bytes, false);
    // A kind the protocol reserves (4) is struck too.
    // The first kind is stream bits 14–17 (LSB-first): bits 6–7 of byte 1, 0–1 of byte 2.
    const reserved = bytes.slice();
    reserved[1] = (reserved[1] as number) & 0x3f;
    reserved[2] = ((reserved[2] as number) & ~0x3) | 0x1;
    transport.inject(reserved, true);
    expect(stats.totals[STAT_STRIKES]).toBe(3);
    expect(got).toHaveLength(2);
  });

  it("handles EVENTS during keepalive(), dropping only the snapshots (D-041, D-043)", () => {
    const transport = new QueuedTransport();
    const stats = new NetStats(new Float64Array(1));
    let events = 0;
    let snapshots = 0;
    const handler: ConnectionHandler = {
      onWelcome: () => null,
      mapReady: () => true,
      onSnapshot: () => {
        snapshots++;
      },
      onCvars: () => {},
      onEvents: (m) => {
        events += m.count;
      },
      onPrint: () => {},
      onClosed: () => {},
    };
    const clock = { keepalivePing: () => 1 } as unknown as ClientClock;
    const conn = new Connection(transport, clock, stats, handler, "test", 1, new Float64Array(1));
    conn.state = CONN_ACTIVE;
    conn.clientId = SELF;
    transport.queue(eventsBytes(), true);
    transport.queue(snapshot(10), false);
    conn.keepalive();
    expect([events, snapshots, stats.totals[STAT_STRIKES]]).toEqual([2, 0, 0]);
    // The keepalive's PING went out.
    expect(transport.sent).toHaveLength(1);
  });

  it("counts stored snapshots' bytes (sum and largest), and WebSocket framing only on a WebSocket", () => {
    const plain = eventsSetup(false);
    plain.conn.state = CONN_ACTIVE;
    const a = snapshot(10);
    const b = snapshot(11, 10);
    plain.transport.inject(a);
    plain.transport.inject(b);
    const t = plain.stats.totals;
    expect(t[STAT_SNAPSHOT_BYTES]).toBe(a.length + b.length);
    expect(t[STAT_SNAPSHOT_BYTES_MAX]).toBe(Math.max(a.length, b.length));
    expect(t[STAT_FRAMING_IN]).toBe(0);
    const ws = eventsSetup(true);
    ws.conn.state = CONN_ACTIVE;
    ws.transport.inject(a);
    ws.conn.sendInput(cmdsUpTo(1), 1);
    // 2 B of header for each frame under 126 B; the client's frames also carry a 4 B mask.
    expect(ws.stats.totals[STAT_FRAMING_IN]).toBe(a.length < 126 ? 2 : 4);
    expect(ws.stats.totals[STAT_FRAMING_OUT]).toBe(6);
    expect(ws.stats.totals[STAT_BYTES_IN]).toBe(a.length);
    expect(ws.stats.totals[STAT_BYTES_OUT]).toBe(ws.transport.sent.at(-1)?.length);
  });
});

function cmdsUpTo(tick: number): CmdRing {
  const ring = new CmdRing();
  for (let t = 1; t <= tick; t++) {
    const c = new UserCmd();
    c.tick = t;
    ring.write(c);
  }
  return ring;
}
