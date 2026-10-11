import { DemoRecorder, MemoryDemoSink, WorldHistory } from "@game/server";
import {
  BitWriter,
  CvarBlock,
  CvarsMsg,
  DEMO_REC_CVARS,
  DEMO_REC_EVENTS,
  EV_LEAVE_LEFT,
  EVK_PLAYER_JOIN,
  EVK_PLAYER_LEAVE,
  EVK_SERVER_STATS,
  EventsMsg,
  encodeCvars,
  encodeEvents,
  MAX_RELIABLE_BYTES,
  Mulberry32,
  TEAM_1,
  TEAM_2,
  type WorldFrame,
} from "@game/shared";

/** A recorded fixture: the file and, per tick, the world frame's spectator digest. */
export interface DemoFixture {
  readonly bytes: Uint8Array;
  readonly history: WorldHistory;
}

/** Slot `s` at tick `t` of `f`, moving hard: every entity field at a random value of its range. */
export function worstSlot(f: WorldFrame, s: number, t: number, rng: Mulberry32): void {
  f.setPresent(s, t);
  f.serial[s] = 1;
  // ±ORIGIN_LIMIT u at 1/32 u: every origin axis an absolute i21, the widest class.
  f.originX[s] = (rng.nextU32() % 1_048_000) - 524_000;
  f.originY[s] = (rng.nextU32() % 1_048_000) - 524_000;
  f.originZ[s] = (rng.nextU32() % 1_048_000) - 524_000;
  f.entVelX[s] = (rng.nextU32() % 65_000) - 32_500;
  f.entVelY[s] = (rng.nextU32() % 65_000) - 32_500;
  f.entVelZ[s] = (rng.nextU32() % 65_000) - 32_500;
  f.yaw[s] = rng.nextU32() & 0xffff;
  f.pitch[s] = (rng.nextU32() % 32_000) - 16_000;
  f.flags[s] = rng.nextU32() & 0b11;
  f.team[s] = s % 2 === 0 ? TEAM_1 : TEAM_2;
  f.teleportSeq[s] = (t >> 4) & 0xff;
  f.eventSeq[s] = t & 0xff;
  f.evKind[s * 2] = 2;
  f.evValue[s * 2] = 0;
  f.evKind[s * 2 + 1] = 1;
  f.evValue[s * 2 + 1] = rng.nextU32() & 0xff;
}

/**
 * The demo-info fixture (D-044): 1300 ticks on arena_greybox recorded by the server's recorder from
 * a scripted world, with no pmove in it, so the golden output moves only with the format: players
 * 0 and 1 from the start (the roster burst), 2 joining at tick 200 on team 1 and leaving at 900,
 * then joining again on team 2 at 1000 (drawn from 1001) and leaving at 1200, a cvar change at 650
 * and a block without sv_cheats at 1100, SERVER_STATS once a second.
 */
export function demoInfoFixture(): DemoFixture {
  const history = new WorldHistory();
  const rec = new DemoRecorder();
  const sink = new MemoryDemoSink();
  rec.start(
    sink,
    "fixture",
    { name: "arena_greybox", hashLo: 0xe478cd6c | 0, hashHi: 0x990efb80 | 0 },
    "fixture-build",
  );
  const block = new CvarBlock();
  block.entries.push({ name: "pm_gravity", type: "float", value: 800 });
  block.entries.push({ name: "sv_cheats", type: "int", value: 0 });
  const w = new BitWriter(MAX_RELIABLE_BYTES);
  const events = new EventsMsg();
  const start = 61;
  for (let t = start; t < start + 1300; t++) {
    const f = history.frameFor(t);
    f.clear();
    for (const s of [0, 1, 2]) {
      if (s === 2 && (t < 200 || (t >= 900 && t <= 1000) || t >= 1200)) continue;
      f.setPresent(s, t);
      f.serial[s] = 1;
      f.originX[s] = (s * 1000 + (t % 300) * 7) * 32;
      f.originY[s] = s * 3200;
      f.originZ[s] = 24 * 32;
      f.entVelX[s] = 420;
      f.yaw[s] = (t * 50) & 0xffff;
      f.team[s] = s === 1 || t > 1000 ? TEAM_2 : TEAM_1;
      f.teleportSeq[s] = 1;
    }
    history.stored(t);
    rec.beginTick(t, block, 0);
    if (t === start + 589) {
      const c = new CvarsMsg();
      c.effectiveTick = t;
      c.block.entries.push({ name: "pm_gravity", type: "float", value: 700 });
      c.block.entries.push({ name: "sv_cheats", type: "int", value: 0 });
      w.reset();
      encodeCvars(w, c);
      rec.write(DEMO_REC_CVARS, t, w.bytes, w.byteLength);
    }
    if (t === 1100) {
      // A block without sv_cheats: demo-info reports it dropped.
      const c = new CvarsMsg();
      c.effectiveTick = t;
      c.block.entries.push({ name: "pm_gravity", type: "float", value: 700 });
      w.reset();
      encodeCvars(w, c);
      rec.write(DEMO_REC_CVARS, t, w.bytes, w.byteLength);
    }
    rec.writeSnapshot(t, history, 0x5a5a);
    events.count = 0;
    const join = (id: number, team: number) => {
      const e = events.add(EVK_PLAYER_JOIN);
      if (e !== null) {
        e.clientId = id;
        e.team = team;
      }
    };
    if (t === start) {
      join(0, TEAM_1);
      join(1, TEAM_2);
    }
    if (t === 200) join(2, TEAM_1);
    // Its JOIN a tick before it is drawn: the stay still takes the JOIN's team.
    if (t === 1000) join(2, TEAM_2);
    if (t === 900 || t === 1200) {
      const e = events.add(EVK_PLAYER_LEAVE);
      if (e !== null) {
        e.clientId = 2;
        e.reason = EV_LEAVE_LEFT;
      }
    }
    if (t % 60 === 0) {
      const e = events.add(EVK_SERVER_STATS);
      if (e !== null) {
        e.tickP50Us = 40;
        e.tickP99Us = 110;
        e.tickMaxUs = 300;
        e.players = (t >= 200 && t < 900) || (t >= 1000 && t < 1200) ? 3 : 2;
      }
    }
    if (events.count > 0) {
      w.reset();
      encodeEvents(w, events);
      rec.write(DEMO_REC_EVENTS, t, w.bytes, w.byteLength);
    }
  }
  rec.stop();
  return { bytes: sink.bytes(), history };
}

/** A seeded generator for the worst-motion frames. */
export function worstRng(seed: number): Mulberry32 {
  return new Mulberry32(seed);
}
