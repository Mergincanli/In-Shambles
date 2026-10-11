import {
  BitReader,
  buildCollisionWorld,
  CHANNEL_RELIABLE,
  createLoopbackPair,
  decodeEvents,
  EV_LEAVE_KICKED,
  EV_LEAVE_LEFT,
  EV_LEAVE_TIMED_OUT,
  EVK_PLAYER_JOIN,
  EVK_PLAYER_LEAVE,
  EVK_SERVER_STATS,
  type EventRecord,
  EventsMsg,
  type MessageHandler,
  MSG_CHANNEL,
  MSG_EVENTS,
  MSG_SNAPSHOT,
  TEAM_1,
  TEAM_2,
  type Transport,
  type TransportStats,
} from "@game/shared";
import { describe, expect, it } from "vitest";
import { SessionLimits } from "../../src/match/limits";
import { Match, type MatchOptions, SERVER_STATS_INTERVAL_TICKS } from "../../src/match/match";
import { EventOutbox } from "../../src/match/session";
import { WsLimits, type WsSocket, WsTransport } from "../../src/transport/wsTransport";
import { loadMap, TEST_BUILD, TestClient } from "./fixtures";

// D-043 (M3 design §2.1 EVENTS, §2.4 roster, §2.5 step 7): the roster burst, JOIN and LEAVE with
// their reasons, SERVER_STATS once a second with the host's tick times, and the 63-event split.

const cmap = loadMap("movement_lab");
const world = buildCollisionWorld(cmap);

function newMatch(options: Partial<MatchOptions> = {}): Match {
  return new Match({ cmap, world, buildHash: TEST_BUILD, primer: false, ...options });
}

class Room {
  readonly clients: TestClient[] = [];
  constructor(readonly match: Match) {}

  connect(): TestClient {
    const [clientEnd, serverEnd] = createLoopbackPair();
    const c = new TestClient(clientEnd);
    this.match.connect(serverEnd);
    this.clients.push(c);
    return c;
  }

  run(n: number): void {
    for (let i = 0; i < n; i++) {
      this.match.tick();
      for (const c of this.clients) c.poll();
    }
  }

  /** HELLO, then READY on the next tick, then the spawn tick read. */
  join(): TestClient {
    const c = this.connect();
    c.hello();
    this.run(1);
    c.ready();
    this.run(1);
    return c;
  }
}

/** A record's kind and payload as a short tag: "J3/1" (join, id 3, team 1), "L3/2", "S". */
function tag(e: EventRecord): string {
  if (e.kind === EVK_PLAYER_JOIN) return `J${e.clientId}/${e.team}`;
  if (e.kind === EVK_PLAYER_LEAVE) return `L${e.clientId}/${e.reason}`;
  return "S";
}

function roster(c: TestClient): string[] {
  return c.events.filter((e) => e.kind !== EVK_SERVER_STATS).map(tag);
}

describe("match EVENTS: roster burst and JOIN/LEAVE (D-043)", () => {
  it("gives a joiner every present player, then itself, and tells the others it joined", () => {
    const room = new Room(newMatch());
    const a = room.join();
    expect(roster(a)).toEqual([`J0/${TEAM_1}`]);
    const b = room.join();
    expect(roster(b)).toEqual([`J0/${TEAM_1}`, `J1/${TEAM_2}`]);
    expect(roster(a)).toEqual([`J0/${TEAM_1}`, `J1/${TEAM_2}`]);
    // A welcomed client that has not joined hears nothing; its own burst covers what it missed.
    const c = room.connect();
    c.hello();
    room.run(1);
    const d = room.join();
    expect(roster(c)).toEqual([]);
    expect(roster(d)).toEqual([`J0/${TEAM_1}`, `J1/${TEAM_2}`, `J3/${TEAM_1}`]);
    c.ready();
    room.run(1);
    expect(roster(c)).toEqual([`J0/${TEAM_1}`, `J1/${TEAM_2}`, `J3/${TEAM_1}`, `J2/${TEAM_2}`]);
    expect(roster(a).slice(2)).toEqual([`J3/${TEAM_1}`, `J2/${TEAM_2}`]);
    for (const x of [a, b, c, d]) expect(x.bad).toBe(0);
  });

  it("orders two joins of one tick by id: the first joiner hears the second after its burst", () => {
    const room = new Room(newMatch());
    const a = room.connect();
    const b = room.connect();
    a.hello();
    b.hello();
    room.run(1);
    a.ready();
    b.ready();
    room.run(1);
    expect(roster(a)).toEqual([`J0/${TEAM_1}`, `J1/${TEAM_2}`]);
    expect(roster(b)).toEqual([`J0/${TEAM_1}`, `J1/${TEAM_2}`]);
    // One EVENTS message each, sent after the tick's snapshot (§2.5 step 7).
    expect(a.eventMessages).toEqual([2]);
    expect(a.snapshots).toHaveLength(1);
  });

  it("sends a tick's EVENTS after that tick's SNAPSHOT (§2.5 step 7)", () => {
    const room = new Room(newMatch());
    room.join();
    const b = room.connect();
    b.hello();
    room.run(1);
    b.ready();
    b.typeLog = [];
    room.run(2);
    const order = b.typeLog.filter((t) => t === MSG_SNAPSHOT || t === MSG_EVENTS);
    expect(order).toEqual([MSG_SNAPSHOT, MSG_EVENTS, MSG_SNAPSHOT]);
  });

  it("says why a player left: left, timed out or kicked; a session that never joined is silent", () => {
    const limits = new SessionLimits();
    const room = new Room(newMatch({ timeouts: true, limits, maxClients: 8 }));
    const watcher = room.join();
    const leaver = room.join();
    const kicked = room.join();
    const silent = room.join();
    // Keep the watcher and the kicked one from timing out: a PING every 2 s.
    const keep = (n: number) => {
      for (let i = 0; i < n; i++) {
        if (i % 120 === 0) for (const c of [watcher, kicked]) c.ping(i);
        room.run(1);
      }
    };
    leaver.transport.close("bye");
    keep(1);
    expect(room.match.kickClient(2, "test")).toBe(true);
    keep(1);
    // A welcomed client that closes before READY was never in the roster: no LEAVE.
    const quitter = room.connect();
    quitter.hello();
    keep(1);
    expect(quitter.welcomes).toHaveLength(1);
    quitter.transport.close("bye");
    keep(1);
    // The silent one is timed out after sv_timeout ticks with no packet.
    const handshake = room.connect();
    keep(limits.timeout);
    expect(silent.kicks.map((k) => k.reason)).toContain("timed out");
    // The handshake that never said HELLO times out too, but had no roster entry.
    expect(handshake.kicks.map((k) => k.reason)).toContain("handshake timed out");
    expect(roster(watcher).slice(4)).toEqual([
      `L1/${EV_LEAVE_LEFT}`,
      `L2/${EV_LEAVE_KICKED}`,
      `L3/${EV_LEAVE_TIMED_OUT}`,
    ]);
    expect(watcher.bad).toBe(0);
  });

  it("sends LEAVE 2 for a strike kick", () => {
    const room = new Room(newMatch());
    const watcher = room.join();
    const bad = room.join();
    for (let i = 0; i < 6; i++) bad.raw(new Uint8Array([0xee, 1, 2]), false);
    room.run(1);
    expect(bad.kicks.map((k) => k.reason)).toEqual(["too many bad packets"]);
    expect(roster(watcher).slice(2)).toEqual([`L1/${EV_LEAVE_KICKED}`]);
  });

  it("keeps a kick between ticks in the broadcast record until the next tick ends (D-044)", () => {
    const room = new Room(newMatch());
    room.join();
    room.join();
    expect(room.match.tickEvents.count).toBe(0);
    room.match.kickClient(1, "bye");
    expect(room.match.tickEvents.count).toBe(1);
    expect(room.match.tickEvents.kind(0)).toBe(EVK_PLAYER_LEAVE);
    expect(room.match.tickEvents.clientId(0)).toBe(1);
    expect(room.match.tickEvents.value(0)).toBe(EV_LEAVE_KICKED);
    room.run(1);
    expect(room.match.tickEvents.count).toBe(0);
    expect(roster(room.clients[0] as TestClient).at(-1)).toBe(`L1/${EV_LEAVE_KICKED}`);
  });

  it("splits more than 63 events of one tick across messages, in order", () => {
    const room = new Room(newMatch({ maxClients: 64 }));
    const all: TestClient[] = [];
    for (let i = 0; i < 64; i++) all.push(room.connect());
    for (const c of all) c.hello();
    room.run(1);
    // Run to just before a stats tick, then all 64 join on it.
    room.run(SERVER_STATS_INTERVAL_TICKS - 2);
    for (const c of all) c.ready();
    room.run(1);
    expect(room.match.serverTick % SERVER_STATS_INTERVAL_TICKS).toBe(0);
    const last = all[63] as TestClient;
    // Its burst: the 63 others, then itself; then the tick's SERVER_STATS.
    expect(last.eventMessages).toEqual([63, 2]);
    expect(last.events.map(tag).slice(-2)).toEqual([`J63/${TEAM_2}`, "S"]);
    expect(last.events.slice(0, 63).map((e) => e.clientId)).toEqual(
      Array.from({ length: 63 }, (_, i) => i),
    );
    // The first joiner: itself, then the 63 joins after it, then the stats.
    const first = all[0] as TestClient;
    expect(first.eventMessages).toEqual([63, 2]);
    expect(first.events.map((e) => e.clientId).slice(0, 64)).toEqual(
      Array.from({ length: 64 }, (_, i) => i),
    );
    expect(first.events.at(-1)?.players).toBe(64);
  });
});

/** A `ws` socket stand-in whose `bufferedAmount` the test raises; it keeps what the server sent. */
class FakeSocket implements WsSocket {
  bufferedAmount = 0;
  readonly sent: Uint8Array[] = [];
  send(data: Uint8Array): void {
    this.sent.push(data);
  }
  close(): void {}
  pause(): void {}
  resume(): void {}
}

/** The client's end of a WsTransport on a FakeSocket: sends go into it, poll reads what it sent. */
class WsClientEnd implements Transport {
  private handler: MessageHandler | null = null;
  constructor(
    private readonly server: WsTransport,
    private readonly socket: FakeSocket,
  ) {}
  sendReliable(d: Uint8Array, len: number): void {
    this.server.receive(d.slice(0, len), true);
  }
  sendUnreliable(d: Uint8Array, len: number): void {
    this.server.receive(d.slice(0, len), true);
  }
  onMessage(cb: MessageHandler): void {
    this.handler = cb;
  }
  onClose(): void {}
  poll(): void {
    for (const b of this.socket.sent.splice(0)) {
      this.handler?.(b, b.length, MSG_CHANNEL[b[0] as number] === CHANNEL_RELIABLE);
    }
  }
  close(): void {}
  isOpen(): boolean {
    return true;
  }
  stats(): TransportStats {
    throw new Error("not used");
  }
}

describe("match EVENTS: a close the server's transport forces (docs/05 §10)", () => {
  it("reads as LEAVE 0: the connection closed, like a player who left", () => {
    const room = new Room(newMatch());
    const watcher = room.join();
    const socket = new FakeSocket();
    const ws = new WsTransport(socket, new WsLimits());
    const slow = new TestClient(new WsClientEnd(ws, socket));
    room.match.connect(ws);
    room.clients.push(slow);
    slow.hello();
    room.run(1);
    slow.ready();
    room.run(2);
    expect(roster(watcher)).toEqual([`J0/${TEAM_1}`, `J1/${TEAM_2}`]);
    // A reader that does not drain: the transport closes it 1008 "too slow" from its next poll.
    socket.bufferedAmount = 1e9;
    room.run(1);
    expect(roster(watcher).slice(2)).toEqual([`L1/${EV_LEAVE_LEFT}`]);
    expect(watcher.bad).toBe(0);
  });
});

/** Records the EVENTS a `Match.sendEvents` target gets: each message's tags. */
class EventsSink {
  readonly messages: string[][] = [];
  private readonly r = new BitReader();
  private readonly m = new EventsMsg();
  sendReliable(d: Uint8Array, len: number): void {
    this.r.reset(d, len);
    if (!decodeEvents(this.r, this.m)) throw new Error("bad EVENTS");
    const tags: string[] = [];
    for (let i = 0; i < this.m.count; i++) tags.push(tag(this.m.events[i] as EventRecord));
    this.messages.push(tags);
  }
}

describe("match EVENTS: Match.sendEvents splits at 63 (D-043)", () => {
  it("starts a new message for SERVER_STATS when the roster events fill the last one", () => {
    const match = newMatch();
    for (const n of [62, 63, 126]) {
      const box = new EventOutbox();
      for (let i = 0; i < n; i++) box.push(EVK_PLAYER_JOIN, i % 64, TEAM_1);
      const sink = new EventsSink();
      match.sendEvents(sink, box, true);
      const sizes = sink.messages.map((m) => m.length);
      expect(sizes, `${n} events`).toEqual(n === 62 ? [63] : n === 63 ? [63, 1] : [63, 63, 1]);
      expect(sink.messages.at(-1)?.at(-1)).toBe("S");
      expect(sink.messages.flat().filter((t) => t !== "S")).toHaveLength(n);
    }
    // Nothing to say and no stats: no message.
    const sink = new EventsSink();
    match.sendEvents(sink, new EventOutbox(), false);
    expect(sink.messages).toEqual([]);
  });
});

describe("match EVENTS: SERVER_STATS every 60 ticks with the host's tick times (D-043)", () => {
  it("sends the last report, saturated, and the players in the match, once a second", () => {
    const room = new Room(newMatch());
    const a = room.join();
    room.join();
    const lone = room.connect();
    lone.hello();
    room.run(SERVER_STATS_INTERVAL_TICKS - 4);
    const stats = () => a.events.filter((e) => e.kind === EVK_SERVER_STATS);
    // Tick 60: no report yet, so zeros; two players in the game (the welcomed one is not).
    expect(room.match.serverTick).toBe(SERVER_STATS_INTERVAL_TICKS);
    expect(stats().map((e) => [e.tickP50Us, e.tickP99Us, e.tickMaxUs, e.players])).toEqual([
      [0, 0, 0, 2],
    ]);
    room.match.reportTickStats(42.7, 115, 70_000);
    room.run(SERVER_STATS_INTERVAL_TICKS - 1);
    expect(stats()).toHaveLength(1);
    room.run(1);
    expect(stats().at(-1)).toMatchObject({
      tickP50Us: 42,
      tickP99Us: 115,
      tickMaxUs: 0xffff,
      players: 2,
    });
    room.match.reportTickStats(Number.NaN, -5, Number.POSITIVE_INFINITY);
    room.run(SERVER_STATS_INTERVAL_TICKS);
    expect(stats().at(-1)).toMatchObject({ tickP50Us: 0, tickP99Us: 0, tickMaxUs: 0 });
    expect(stats()).toHaveLength(3);
    expect(lone.events).toEqual([]);
    expect(room.match.metrics.eventsSent).toBeGreaterThan(0);
    expect(a.bad).toBe(0);
  });
});
