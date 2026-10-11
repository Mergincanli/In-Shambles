import { DemoRecorder, MemoryDemoSink, WorldHistory } from "@game/server";
import {
  BitWriter,
  CvarBlock,
  createCollisionWorld,
  DEMO_REC_EVENTS,
  EVENTS_MAX_PER_MSG,
  EVK_PLAYER_JOIN,
  EVK_PLAYER_LEAVE,
  EventsMsg,
  encodeEvents,
  FRAME_SLOTS,
  frameDigest,
  MAX_RELIABLE_BYTES,
  PlayerState,
  PMF_CROUCHED,
  playerStateToSlot,
  TEAM_1,
  TEAM_2,
  VIEW_HEIGHT_CROUCHED,
  VIEW_HEIGHT_STANDING,
  validateDemo,
  type WorldFrame,
} from "@game/shared";
import { describe, expect, it } from "vitest";
import { DemoGame } from "../../src/app/demoGame";
import { THIRD_PERSON_DISTANCE } from "../../src/app/game";
import type { DemoHud } from "../../src/hud/overlay";
import { TICK_MS } from "../../src/net/clock";
import { DemoPlayer, FOLLOW_NONE } from "../../src/net/demoPlayer";

// D-044 (M3 design §2.12, playback and key cycling): DemoPlayer plays a recorded demo at 1×,
// every frame equal to the server's world frame, and follows the lowest present player; follownext
// and followprev wrap and skip absent ids, follow <id> jumps to a present one, and a followed
// player who leaves hands the camera to the next present id. Join and leave notices start after
// the start tick's roster burst. DemoGame puts the camera behind the followed eye (eased between
// stances) and tells the HUD whom it follows.

const world = createCollisionWorld([]);
const START = 1;

interface RecordOptions {
  /** Write the JOIN/LEAVE EVENTS a match would (a burst at the start, then each change). */
  readonly events?: boolean;
  /** Ticks on which a player crouches. */
  readonly crouched?: (s: number, t: number) => boolean;
}

/**
 * Players present per tick: `ids(t)`. Records `ticks` ticks as the match does: the roster burst
 * at the start (63 JOINs a message), then a JOIN or LEAVE on each tick an id appears or goes.
 * Returns the file and digests.
 */
function record(ticks: number, ids: (t: number) => number[], o: RecordOptions = {}) {
  const history = new WorldHistory();
  const rec = new DemoRecorder();
  const sink = new MemoryDemoSink();
  rec.start(sink, "test", { name: "movement_lab", hashLo: 1, hashHi: 2 }, "test-build");
  const ps = new PlayerState();
  const digests = new Map<number, number>();
  const w = new BitWriter(MAX_RELIABLE_BYTES);
  const events = o.events ?? true;
  const send = (t: number, list: [kind: number, id: number][]) => {
    for (let i = 0; i < list.length; i += EVENTS_MAX_PER_MSG) {
      const m = new EventsMsg();
      for (const [kind, s] of list.slice(i, i + EVENTS_MAX_PER_MSG)) {
        const e = m.add(kind);
        if (e === null) continue;
        e.clientId = s;
        e.team = s % 2 === 0 ? TEAM_1 : TEAM_2;
      }
      w.reset();
      encodeEvents(w, m);
      rec.write(DEMO_REC_EVENTS, t, w.bytes, w.byteLength);
    }
  };
  let prev: number[] = [];
  for (let t = START; t < START + ticks; t++) {
    const now = ids(t);
    const f = history.frameFor(t);
    f.clear();
    for (const s of now) {
      f.setPresent(s, t);
      ps.origin[0] = s * 100 + t;
      ps.origin[1] = s * 10;
      ps.flags = o.crouched?.(s, t) === true ? PMF_CROUCHED : 0;
      playerStateToSlot(f, s, ps);
      f.serial[s] = 1;
      f.team[s] = s % 2 === 0 ? TEAM_1 : TEAM_2;
      f.teleportSeq[s] = 1;
    }
    history.stored(t);
    digests.set(t, frameDigest(f, -1));
    rec.beginTick(t, new CvarBlock(), 0);
    rec.writeSnapshot(t, history, 0);
    if (events) {
      const list: [number, number][] = [];
      for (const s of now) if (!prev.includes(s)) list.push([EVK_PLAYER_JOIN, s]);
      for (const s of prev) if (!now.includes(s)) list.push([EVK_PLAYER_LEAVE, s]);
      if (list.length > 0) send(t, list);
    }
    prev = now;
  }
  rec.stop();
  return { bytes: sink.bytes(), digests };
}

function player(bytes: Uint8Array, onSnapshot?: (tick: number, f: WorldFrame) => void) {
  const check = validateDemo(bytes);
  if (!check.ok) throw new Error(check.error);
  const clock = { now: 1000 };
  const demo = new DemoPlayer({
    bytes,
    header: check.header,
    world,
    clock: () => clock.now,
    ...(onSnapshot === undefined ? {} : { onSnapshot }),
  });
  /** Frames at 60 Hz for `ms`. */
  const run = (ms: number) => {
    const end = clock.now + ms;
    while (clock.now < end) {
      clock.now += TICK_MS;
      demo.frame();
    }
  };
  return { demo, run, clock };
}

describe("DemoPlayer (D-044)", () => {
  it("plays every snapshot at 1×, each frame the server's, and ends", () => {
    const { bytes, digests } = record(300, () => [0, 3]);
    const seen = new Map<number, number>();
    const { demo, run } = player(bytes, (t, f) => seen.set(t, frameDigest(f, -1)));
    demo.frame();
    expect(demo.tick).toBe(START);
    run(1000);
    // One second of frames plays about 60 ticks: playback runs at the recording's rate.
    expect(demo.tick).toBeGreaterThanOrEqual(START + 59);
    expect(demo.tick).toBeLessThanOrEqual(START + 61);
    expect(demo.ended).toBe(false);
    run(5000);
    expect(demo.ended).toBe(true);
    expect(seen).toEqual(digests);
    expect(demo.snapshots).toBe(300);
    expect(demo.faults).toBe(0);
    expect(demo.roster.count).toBe(2);
    expect(demo.view.count).toBe(2);
  });

  it("follows the lowest present id, cycles with wrap and skips, and jumps with follow", () => {
    const { bytes } = record(600, () => [2, 5, 9]);
    const { demo, run } = player(bytes);
    expect(demo.following).toBe(FOLLOW_NONE);
    expect(demo.followNext()).toBe(FOLLOW_NONE);
    run(500);
    expect(demo.following).toBe(2);
    expect(demo.followedTeam).toBe(TEAM_1);
    expect(demo.followNext()).toBe(5);
    expect(demo.followedTeam).toBe(TEAM_2);
    expect(demo.followNext()).toBe(9);
    expect(demo.followNext()).toBe(2);
    expect(demo.followPrev()).toBe(9);
    expect(demo.followPrev()).toBe(5);
    expect(demo.follow(3)).toBe(false);
    expect(demo.follow(64)).toBe(false);
    expect(demo.following).toBe(5);
    expect(demo.follow(9)).toBe(true);
    run(200);
    expect(demo.following).toBe(9);
  });

  it("moves the camera to the next present id when the followed player leaves", () => {
    const { bytes } = record(600, (t) => (t < 200 ? [1, 4, 7] : t < 400 ? [1, 7] : [1]));
    const { demo, run } = player(bytes);
    run(500);
    expect(demo.follow(4)).toBe(true);
    run(3000);
    expect(demo.following).toBe(7);
    run(3500);
    expect(demo.following).toBe(1);
    expect(demo.followNext()).toBe(1);
    // The start's roster is no news; the leaves are.
    expect(demo.notices).toEqual(["player 4 left", "player 7 left"]);
  });

  it("announces joins after an empty start (no EVENTS on the start tick)", () => {
    const { bytes } = record(200, (t) => (t < 50 ? [] : t < 150 ? [0, 1] : [1]));
    const { demo } = player(bytes);
    demo.playUntil(START + 200);
    expect(demo.faults).toBe(0);
    expect(demo.notices).toEqual([
      "player 0 joined team 1",
      "player 1 joined team 2",
      "player 0 left",
    ]);
    expect(demo.roster.count).toBe(1);
  });

  it("takes a 64-player start burst (two EVENTS messages) as the roster, not news", () => {
    const all = Array.from({ length: FRAME_SLOTS }, (_, s) => s);
    const { bytes } = record(30, (t) => (t < 20 ? all : all.slice(1)));
    const { demo } = player(bytes);
    demo.playUntil(START + 30);
    expect(demo.faults).toBe(0);
    expect(demo.events).toBe(3);
    expect(demo.roster.count).toBe(FRAME_SLOTS - 1);
    expect(demo.notices).toEqual(["player 0 left"]);
  });
});

/** A DemoHud that keeps what it was told. */
class FakeHud implements DemoHud {
  readonly calls: [number, number][] = [];
  follow(id: number, team: number): void {
    const last = this.calls.at(-1);
    if (last === undefined || last[0] !== id || last[1] !== team) this.calls.push([id, team]);
  }
}

describe("DemoGame (D-044): the follow camera and the HUD line", () => {
  function game(bytes: Uint8Array) {
    const p = player(bytes);
    const hud = new FakeHud();
    const g = new DemoGame({
      demo: p.demo,
      world,
      renderer: null,
      status: null,
      hud,
      idlePose: [10, 20, 30, 90, 0],
    });
    /** Frames at 60 Hz for `ms`. */
    const run = (ms: number) => {
      const end = p.clock.now + ms;
      while (p.clock.now < end) {
        p.clock.now += TICK_MS;
        g.frame();
      }
    };
    return { ...p, g, hud, run };
  }

  it("holds the idle pose until someone is followed, then sits behind the followed eye", () => {
    const { bytes } = record(600, (t) => (t < 30 ? [] : [2, 5]));
    const { g, hud, run, demo } = game(bytes);
    run(200);
    expect([...g.pose]).toEqual([10, 20, 30, 90, 0]);
    expect(hud.calls).toEqual([[-1, 0]]);
    run(1000);
    const view = demo.view;
    expect(demo.following).toBe(2);
    // Yaw 0, pitch 0 on an open map: THIRD_PERSON_DISTANCE behind the eye along −x.
    expect(g.pose[0]).toBeCloseTo((view.x[2] as number) - THIRD_PERSON_DISTANCE, 6);
    expect(g.pose[1]).toBeCloseTo(view.y[2] as number, 6);
    expect(g.pose[2]).toBeCloseTo((view.z[2] as number) + VIEW_HEIGHT_STANDING, 6);
    expect([g.pose[3], g.pose[4]]).toEqual([view.yaw[2], view.pitch[2]]);
    demo.followNext();
    run(100);
    expect(hud.calls).toEqual([
      [-1, 0],
      [2, TEAM_1],
      [5, TEAM_2],
    ]);
  });

  it("eases the eye between stances instead of jumping", () => {
    const { bytes } = record(600, () => [0], { crouched: (_s, t) => t >= 120 });
    const { g, run, demo } = game(bytes);
    run(1000);
    const z = (): number => (g.pose[2] as number) - (demo.view.z[0] as number);
    expect(z()).toBeCloseTo(VIEW_HEIGHT_STANDING, 6);
    // Into the crouch: one frame later the eye has moved, but not all the way.
    let first = Number.NaN;
    for (let i = 0; i < 120 && Number.isNaN(first); i++) {
      run(TICK_MS);
      if (demo.view.crouched[0] === 1) first = z();
    }
    expect(first).toBeLessThan(VIEW_HEIGHT_STANDING);
    expect(first).toBeGreaterThan(VIEW_HEIGHT_CROUCHED);
    run(500);
    expect(z()).toBeCloseTo(VIEW_HEIGHT_CROUCHED, 6);
  });
});
