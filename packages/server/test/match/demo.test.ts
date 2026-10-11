import {
  buildCollisionWorld,
  createLoopbackPair,
  DEMO_KEYFRAME_TICKS,
  EVK_PLAYER_JOIN,
  EVK_PLAYER_LEAVE,
  EVK_SERVER_STATS,
  type EventsMsg,
  frameDigest,
  MAX_SPECTATOR_SNAPSHOT_BYTES,
  MSG_EVENTS,
  PRINT_ERROR,
  PRINT_INFO,
  UserCmd,
  validateDemo,
} from "@game/shared";
import { describe, expect, it } from "vitest";
import { type DemoHost, MemoryDemoSink } from "../../src/match/demo";
import { Match, type MatchOptions, SERVER_STATS_INTERVAL_TICKS } from "../../src/match/match";
import { loadMap, TEST_BUILD, TestClient } from "./fixtures";

// D-044 (M3 design §2.12, step 8 of §2.5): the match's spectator recorder. Every snapshot record
// decodes to the server's world frame (frameDigest as a spectator), keyframes every 600 ticks,
// the roster burst on the first tick, a joiner's JOIN on its join tick, CVARS on a change, and
// `record`/`stoprecord` through the match's admin commands.

const cmap = loadMap("movement_lab");
const world = buildCollisionWorld(cmap);

function newMatch(options: Partial<MatchOptions> = {}): Match {
  return new Match({ cmap, world, buildHash: TEST_BUILD, primer: false, ...options });
}

class Room {
  readonly clients: TestClient[] = [];
  /** frameDigest(worldFrame, −1) per tick, from the tick after `track()`. */
  readonly digests = new Map<number, number>();
  constructor(readonly match: Match) {}

  connect(): TestClient {
    const [clientEnd, serverEnd] = createLoopbackPair();
    const c = new TestClient(clientEnd);
    this.match.connect(serverEnd);
    this.clients.push(c);
    return c;
  }

  run(n: number, each?: (t: number) => void): void {
    for (let i = 0; i < n; i++) {
      each?.(this.match.serverTick + 1);
      this.match.tick();
      this.digests.set(this.match.serverTick, frameDigest(this.match.worldFrame, -1));
      for (const c of this.clients) c.poll();
    }
  }

  join(): TestClient {
    const c = this.connect();
    c.hello();
    this.run(1);
    c.ready();
    this.run(1);
    return c;
  }
}

/** Moves a client: forward and strafing by tick, so deltas change every tick. */
function move(c: TestClient, t: number): void {
  const cmd = new UserCmd();
  cmd.tick = t;
  cmd.forward = 127;
  cmd.right = t % 120 < 60 ? 127 : -127;
  cmd.yaw = (t * 97) & 0xffff;
  c.input([cmd], 0);
}

interface Seen {
  snapshots: { tick: number; digest: number; full: boolean; bytes: number }[];
  events: { tick: number; tags: string[] }[];
  cvars: { tick: number; effectiveTick: number }[];
}

function tags(m: EventsMsg): string[] {
  const out: string[] = [];
  for (let i = 0; i < m.count; i++) {
    const e = m.events[i];
    if (e === undefined) continue;
    if (e.kind === EVK_PLAYER_JOIN) out.push(`J${e.clientId}/${e.team}`);
    else if (e.kind === EVK_PLAYER_LEAVE) out.push(`L${e.clientId}/${e.reason}`);
    else if (e.kind === EVK_SERVER_STATS) out.push(`S${e.players}`);
  }
  return out;
}

function read(bytes: Uint8Array): Seen & { check: ReturnType<typeof validateDemo> } {
  const seen: Seen = { snapshots: [], events: [], cvars: [] };
  const check = validateDemo(bytes, bytes.length, {
    snapshot: (tick, h, f, n) =>
      seen.snapshots.push({ tick, digest: frameDigest(f, -1), full: h.baseBack === 0, bytes: n }),
    events: (tick, m) => seen.events.push({ tick, tags: tags(m) }),
    cvars: (tick, m) => seen.cvars.push({ tick, effectiveTick: m.effectiveTick }),
  });
  return { ...seen, check };
}

describe("demo recording in the match (D-044)", () => {
  it("records every tick's world frame exactly, from a keyframe, with the roster, joins and cvars", () => {
    const room = new Room(newMatch());
    const a = room.join();
    const b = room.join();
    // Connected and welcomed but not ready when the recording starts: not in the roster burst.
    const late = room.connect();
    late.hello();
    room.run(1);
    const sink = new MemoryDemoSink();
    const sentBefore = room.match.metrics.eventsSent;
    a.typeLog = [];
    b.typeLog = [];
    late.typeLog = [];
    room.match.startRecording(sink, "memory");
    const start = room.match.serverTick + 1;
    let joiner: TestClient | null = null;
    let joinTick = 0;
    let lateTick = 0;
    let leaveTick = 0;
    let cvarTick = 0;
    room.run(400, (t) => {
      move(a, t);
      move(b, t);
      if (joiner !== null) move(joiner, t);
      if (t === start + 10) {
        late.ready();
        lateTick = t;
      }
      if (t === start + 50) {
        joiner = room.connect();
        joiner.typeLog = [];
        joiner.hello();
      }
      // READY handled in tick t: the player joins (and spawns) at t.
      if (t === start + 52) {
        joiner?.ready();
        joinTick = t;
      }
      if (t === start + 200) {
        expect(room.match.runAdminCommand("set pm_gravity 700").level).toBe(PRINT_INFO);
        cvarTick = t;
      }
      if (t === start + 300) {
        b.transport.close("bye");
        leaveTick = t;
      }
    });
    const end = room.match.serverTick;
    expect(room.match.stopRecording()).toBe("memory");
    expect(sink.closed).toBe(true);
    const got = read(sink.bytes());
    if (!got.check.ok) throw new Error(got.check.error);
    const { header, summary } = got.check;
    expect(header.startTick).toBe(start);
    expect(header.mapName).toBe("movement_lab");
    expect(header.buildHash).toBe(TEST_BUILD);
    expect(summary.snapshots).toBe(end - start + 1);
    expect(summary.endTick).toBe(end);
    // A keyframe at the start, deltas after it (the next keyframe comes DEMO_KEYFRAME_TICKS on:
    // the 64-player replay and the demo-info fixture in packages/tools/test/replay pass it).
    expect(got.snapshots.filter((s) => s.full).map((s) => s.tick)).toEqual([start]);
    expect(summary.keyframes).toBe(1);
    expect(DEMO_KEYFRAME_TICKS).toBe(600);
    for (const s of got.snapshots) {
      expect(s.digest, `tick ${s.tick}`).toBe(room.digests.get(s.tick));
      expect(s.bytes).toBeLessThanOrEqual(MAX_SPECTATOR_SNAPSHOT_BYTES);
    }
    // The first tick's EVENTS is the roster burst; the joiner's JOIN comes on its join tick, the
    // leaver's LEAVE on the tick that polled its close (closed just before it); SERVER_STATS on their ticks.
    const roster = got.events.map((e) => ({
      tick: e.tick,
      tags: e.tags.filter((x) => x[0] !== "S"),
    }));
    expect(roster.filter((e) => e.tags.length > 0)).toEqual([
      { tick: start, tags: ["J0/1", "J1/2"] },
      { tick: lateTick, tags: ["J2/1"] },
      { tick: joinTick, tags: ["J3/2"] },
      { tick: leaveTick, tags: ["L1/0"] },
    ]);
    // SERVER_STATS on every 60th tick, and only then.
    const stats = got.events.filter((e) => e.tags.some((x) => x[0] === "S")).map((e) => e.tick);
    expect(stats.length).toBe(
      Math.floor(end / SERVER_STATS_INTERVAL_TICKS) -
        Math.floor((start - 1) / SERVER_STATS_INTERVAL_TICKS),
    );
    for (const t of stats) expect(t % SERVER_STATS_INTERVAL_TICKS).toBe(0);
    expect(got.cvars).toEqual([{ tick: cvarTick, effectiveTick: cvarTick }]);
    expect(room.match.metrics.demoFailed).toBe(0);
    expect(room.match.metrics.demoRecords).toBe(summary.snapshots + summary.events + summary.cvars);
    // Demo records are not counted as EVENTS sent to clients: the counter moved by what they got.
    let received = 0;
    for (const c of [a, b, late, joiner as TestClient | null]) {
      for (const type of c?.typeLog ?? []) if (type === MSG_EVENTS) received++;
    }
    expect(received).toBeGreaterThan(0);
    expect(room.match.metrics.eventsSent - sentBefore).toBe(received);
    expect(a.bad + b.bad).toBe(0);
  });

  it("starts with the next tick and closes a valid demo even when stopped before it", () => {
    const room = new Room(newMatch());
    room.join();
    const sink = new MemoryDemoSink();
    room.match.startRecording(sink, "early");
    expect(room.match.recording).toBe("early");
    room.match.stopRecording();
    expect(room.match.recording).toBeNull();
    const got = read(sink.bytes());
    if (!got.check.ok) throw new Error(got.check.error);
    expect(got.check.header.startTick).toBe(room.match.serverTick + 1);
    expect(got.check.summary.snapshots).toBe(0);
  });

  it("refuses bad names, a second recording and stoprecord when idle, with a PRINT", () => {
    const opened: (string | null)[] = [];
    const host: DemoHost = {
      open: (name) => {
        opened.push(name);
        return { sink: new MemoryDemoSink(), file: `demos/${name ?? "default"}.demo` };
      },
    };
    const room = new Room(newMatch({ demos: host }));
    const admin = (text: string) => room.match.runAdminCommand(text);
    for (const name of ["../x", "/abs", "a/b", '""', "x".repeat(65), "UPPER", "a.b"]) {
      const r = admin(`record ${name}`);
      expect(r.level, name).toBe(PRINT_ERROR);
      expect(r.text, name).toMatch(/is not a demo name/);
    }
    expect(opened).toEqual([]);
    expect(admin("stoprecord")).toMatchObject({
      level: PRINT_ERROR,
      text: "stoprecord: not recording",
    });
    expect(admin(`record ${"x".repeat(64)}`).text).toBe(`recording demos/${"x".repeat(64)}.demo`);
    expect(admin("record other").text).toMatch(/already recording/);
    room.run(3);
    expect(admin("stoprecord").text).toMatch(
      /^stopped recording demos\/x+\.demo \(3 ticks, \d+ B\)$/,
    );
    expect(admin("record").text).toBe("recording demos/default.demo");
    expect(opened).toEqual(["x".repeat(64), null]);
    expect(newMatch().runAdminCommand("record").text).toBe(
      "record: this server does not record demos",
    );
    // A map name the header can't carry is refused before any file is opened.
    opened.length = 0;
    const odd = new Match({
      cmap: { ...cmap, name: "Movement-Lab" },
      world,
      buildHash: TEST_BUILD,
      primer: false,
      demos: host,
    });
    expect(odd.runAdminCommand("record")).toMatchObject({
      level: PRINT_ERROR,
      text: 'record: the map name "Movement-Lab" is not a map id',
    });
    expect(opened).toEqual([]);
    expect(odd.recording).toBeNull();
  });

  it("is admin-only for clients, and a client's rcon-less record is refused", () => {
    const room = new Room(newMatch({ demos: { open: () => "unused" } }));
    const c = room.join();
    c.cmd("record x");
    room.run(1);
    expect(c.prints.at(-1)?.text).toMatch(/only an admin may record demos/);
    expect(room.match.recording).toBeNull();
  });

  it("records and stops through a client's rcon with the password, names checked the same", () => {
    const opened: (string | null)[] = [];
    const sink = new MemoryDemoSink();
    const room = new Room(
      newMatch({
        rcon: (p) => p === "pw",
        demos: {
          open: (name) => {
            opened.push(name);
            return { sink, file: `demos/${name}.demo` };
          },
        },
      }),
    );
    const c = room.join();
    c.cmd("rcon pw record ../x");
    c.cmd("rcon pw record run");
    room.run(1);
    room.run(10);
    c.cmd("rcon pw stoprecord");
    room.run(1);
    const got = c.prints.map((p) => p.text);
    expect(got[0]).toMatch(/"\.\.\/x" is not a demo name/);
    expect(got[1]).toBe("recording demos/run.demo");
    expect(got[2]).toMatch(/^stopped recording demos\/run\.demo \(1[12] ticks, \d+ B\)$/);
    expect(opened).toEqual(["run"]);
    expect(sink.closed).toBe(true);
    const check = validateDemo(sink.bytes());
    expect(check.ok, check.ok ? "" : check.error).toBe(true);
    expect(c.bad).toBe(0);
  });
});
