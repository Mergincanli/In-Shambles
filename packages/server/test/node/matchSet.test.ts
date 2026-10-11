import {
  BUTTON_JUMP,
  buildCollisionWorld,
  type Cmap,
  createLoopbackPair,
  EVK_PLAYER_LEAVE,
  frameDigest,
  MSG_SNAPSHOT,
  UserCmd,
} from "@game/shared";
import { describe, expect, it } from "vitest";
import { MemoryDemoSink } from "../../src/match/demo";
import { Match } from "../../src/match/match";
import { SESSION_ACTIVE } from "../../src/match/session";
import { TickHistogram } from "../../src/match/tickStats";
import type { PassClock, ServerMatch } from "../../src/node/host";
import { MATCH_NAME, MatchSet } from "../../src/node/matchSet";
import { matchNameForPath } from "../../src/transport/wsListener";
import { WireTraffic } from "../../src/transport/wsTransport";
import { loadMap, TEST_BUILD, TestClient } from "../match/fixtures";

// Several matches per process (D-047, M3 design §2.17): the set ticks every match once a pass in
// creation order; matches share no state, so two matches ticked in one set give exactly the
// digests each gives ticked alone (a cvar change in one included); `Match.close` is what
// `match_remove` does to a match.

const ARENA = loadMap("arena_greybox");
const LAB = loadMap("movement_lab");
// Built once: a world is read-only, and building arena_greybox's costs more than the play below.
const WORLDS = new Map([ARENA, LAB].map((c) => [c, buildCollisionWorld(c)]));
const TICKS = 150;
const CLIENTS = 3;

/** A clock that only moves when read: whole milliseconds, so every timing is exact. */
function steppingClock(): PassClock {
  let ms = 0;
  return { now: () => ++ms, cpuMicros: () => ms * 100 };
}

function entry(name: string, match: Match): ServerMatch {
  return { name, match, ticks: new TickHistogram(), traffic: new WireTraffic() };
}

function cmdFor(id: number, tick: number, salt: number): UserCmd {
  const c = new UserCmd();
  c.tick = tick;
  c.forward = 127;
  c.right = (id + salt) % 2 === 0 ? 127 : -127;
  c.yaw = (tick * (150 + 70 * id + salt * 13)) & 0xffff;
  c.buttons = (tick + id * 7 + salt) % 41 < 2 ? BUTTON_JUMP : 0;
  return c;
}

/**
 * One match with `CLIENTS` scripted players. Each tick records the world frame's digest and, per
 * client, a hash of every byte the match sent it (WELCOME, CVARS, snapshots, EVENTS): two runs
 * agree only if the match sent each client exactly the same messages.
 */
class Room {
  readonly match: Match;
  readonly clients: TestClient[] = [];
  readonly digests: number[] = [];
  /** Per client: the running FNV-1a hash of what it received, and whether a snapshot came. */
  private readonly hashes = new Uint32Array(CLIENTS);
  private readonly snapped = new Uint8Array(CLIENTS);

  constructor(
    cmap: Cmap,
    private readonly salt: number,
  ) {
    this.match = new Match({ cmap, world: WORLDS.get(cmap), buildHash: TEST_BUILD, primer: false });
    for (let i = 0; i < CLIENTS; i++) {
      const [c, s] = createLoopbackPair();
      this.match.connect(s);
      const tc = new TestClient(c);
      tc.hello();
      // TestClient only sends here: hashing the bytes is far cheaper than decoding each frame.
      this.hashes[i] = 0x811c9dc5;
      c.onMessage((d, len) => {
        let h = this.hashes[i] as number;
        for (let k = 0; k < len; k++) h = Math.imul(h ^ (d[k] as number), 0x01000193) >>> 0;
        this.hashes[i] = h;
        if (d[0] === MSG_SNAPSHOT) this.snapped[i] = 1;
      });
      this.clients.push(tc);
    }
  }

  /** Before a tick: READY, then each player's cmds acking the last tick (and one cvar change). */
  before(): void {
    const tick = this.match.serverTick + 1;
    if (this.salt === 1 && tick === 90) this.match.runAdminCommand("set pm_gravity 500");
    for (let id = 0; id < this.clients.length; id++) {
      const c = this.clients[id] as TestClient;
      // HELLO went at construction; READY once WELCOME is in (an INPUT before it is struck).
      if (tick === 2) c.ready();
      if (tick < 2) continue;
      const ack = this.snapped[id] === 1 ? tick - 1 : 0;
      c.input([cmdFor(id, tick + 1, this.salt), cmdFor(id, tick, this.salt)], ack);
    }
  }

  /** After a tick: the world frame's digest, then each client's hash of what it received. */
  after(): void {
    this.digests.push(frameDigest(this.match.worldFrame, -1));
    for (let id = 0; id < this.clients.length; id++) {
      (this.clients[id] as TestClient).poll();
      this.digests.push(this.hashes[id] as number);
    }
  }
}

/** Ticks `rooms` together in one MatchSet (or one room alone) for TICKS passes. */
function play(rooms: readonly Room[]): void {
  const set = new MatchSet(() => {}, steppingClock());
  rooms.forEach((r, i) => {
    set.add(entry(i === 0 ? "a" : "b", r.match));
  });
  for (let t = 0; t < TICKS; t++) {
    for (const r of rooms) r.before();
    set.tick();
    for (const r of rooms) r.after();
  }
}

describe("MatchSet (D-047)", () => {
  it("keeps matches in creation order, by name, with the oldest left as the default", () => {
    const set = new MatchSet(() => {}, steppingClock());
    const order: string[] = [];
    const fake = (name: string) =>
      entry(name, {
        tick: () => order.push(name),
        reportTickStats: () => {},
      } as unknown as Match);
    expect(set.default).toBeUndefined();
    set.add(fake("main"));
    set.add(fake("lab"));
    set.add(fake("constructor"));
    expect(() => set.add(fake("lab"))).toThrow(/exists/);
    expect(() => set.add(fake("Bad"))).toThrow(/not a match name/);
    // Names are Map keys: nothing on an object's prototype answers.
    expect(set.get("__proto__")).toBeUndefined();
    expect(set.get("toString")).toBeUndefined();
    expect(set.get("constructor")?.name).toBe("constructor");
    set.tick();
    expect(order).toEqual(["main", "lab", "constructor"]);
    expect(set.pass.passes).toBe(1);
    expect(set.remove("nope")).toBeUndefined();
    expect(set.remove("main")?.name).toBe("main");
    // The oldest left is the default now.
    expect(set.default?.name).toBe("lab");
    expect(set.list.map((m) => m.name)).toEqual(["lab", "constructor"]);
    set.tick();
    expect(order.slice(3)).toEqual(["lab", "constructor"]);
    // Each match's tick and the whole pass went into their histograms.
    expect((set.get("lab") as ServerMatch).ticks.run.count).toBe(2);
    expect(set.pass.ticks.run.count).toBe(2);
  });

  it("addresses exactly the names it accepts: /m/<name> resolves where MATCH_NAME holds", () => {
    const names = ["a", "main", "duel_2", "x".repeat(32), "x".repeat(33), "", "A", "a-b", "a.b"];
    for (const n of ["__proto__", "constructor", "a/b", "a%20", "é", ...names]) {
      expect(matchNameForPath(`/m/${n}`), n).toBe(MATCH_NAME.test(n) ? n : null);
    }
    expect(matchNameForPath("/")).toBe("");
  });

  it("two matches ticked in one set give the digests each gives ticked alone", () => {
    const together = [new Room(ARENA, 1), new Room(LAB, 2)];
    play(together);
    const aloneA = new Room(ARENA, 1);
    play([aloneA]);
    const aloneB = new Room(LAB, 2);
    play([aloneB]);
    const [a, b] = together as [Room, Room];
    expect(a.digests).toHaveLength(TICKS * (CLIENTS + 1));
    expect(a.digests).toEqual(aloneA.digests);
    expect(b.digests).toEqual(aloneB.digests);
    // The players moved, and a's cvar change reached a only.
    expect(new Set(a.digests).size).toBeGreaterThan(TICKS);
    expect(a.match.cvars.get("pm_gravity")).toBe(500);
    expect(b.match.cvars.get("pm_gravity")).toBe(800);
    expect(a.match.cvarHash).not.toBe(b.match.cvarHash);
    // Client ids 0–2 in each match, every one playing, nobody struck, deltas in use.
    for (const r of together) {
      for (let id = 0; id < CLIENTS; id++) expect(r.match.session(id)?.state).toBe(SESSION_ACTIVE);
      expect(r.match.metrics.strikes).toBe(0);
      expect(r.match.metrics.fullSnapshots).toBe(CLIENTS);
    }
  });
});

describe("Match.close (D-047's match_remove)", () => {
  it("ends the demo, KICKs every session, drops them with their mirrors, and stays closed", () => {
    const match = new Match({
      cmap: LAB,
      world: WORLDS.get(LAB),
      buildHash: TEST_BUILD,
      primer: false,
      maxClients: 40,
      demos: { open: () => ({ sink, file: "demos/x.demo" }) },
    });
    const sink = new MemoryDemoSink();
    expect(match.record(null).ok).toBe(true);
    const clients: TestClient[] = [];
    for (let i = 0; i < 3; i++) {
      const [c, s] = createLoopbackPair();
      match.connect(s);
      const tc = new TestClient(c);
      tc.hello();
      clients.push(tc);
    }
    match.tick();
    for (const c of clients) {
      c.poll();
      c.ready();
    }
    match.tick();
    expect(match.mirrors.allocated).toBe(3);
    const before = match.serverTick;
    expect(match.close("match closed")).toBe(3);
    expect(match.closed).toBe(true);
    expect([sink.closed, match.recording]).toEqual([true, null]);
    expect(match.sessionCount).toBe(0);
    expect(match.metrics.kicks).toBe(3);
    expect(match.mirrors.spare).toBe(0);
    for (const c of clients) {
      c.poll();
      expect(c.kicks.map((k) => k.reason)).toEqual(["match closed"]);
      expect(c.closed).toBe("match closed");
      // Every session went at once: nobody is left to hear a LEAVE.
      expect(c.events.some((e) => e.kind === EVK_PLAYER_LEAVE)).toBe(false);
    }
    match.tick();
    expect(match.serverTick).toBe(before);
    // A late connect is KICKed with the same reason.
    const [late, lateServer] = createLoopbackPair();
    const lc = new TestClient(late);
    expect(match.connect(lateServer)).toBeNull();
    lc.poll();
    expect(lc.kicks.map((k) => k.reason)).toEqual(["match closed"]);
    expect(match.close("again")).toBe(0);
  });
});
