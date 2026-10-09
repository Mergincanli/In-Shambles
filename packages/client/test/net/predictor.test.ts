import {
  BUTTON_JUMP,
  boxPlanes,
  buildBrush,
  CONTENTS_SOLID,
  CvarRegistry,
  copyPlayerState,
  createCollisionWorld,
  PlayerState,
  PMF_GROUNDED,
  PmoveParams,
  PmoveTraceLog,
  playerStateEquals,
  pmove,
  refreshPmoveParams,
  registerPmoveCvars,
  registryCvarHash,
  TICK_DT,
  UserCmd,
} from "@game/shared";
import { describe, expect, it } from "vitest";
import {
  CMD_RING_CAPACITY,
  CmdRing,
  CORRECTION_LOG_CAPACITY,
  CorrectionLog,
  Predictor,
  SNAPSHOT_CORRECTED,
  SNAPSHOT_HARD_RESYNC,
  SNAPSHOT_MATCHED,
  SNAPSHOT_PARAMS_RESYNC,
  SNAPSHOT_STALE,
  SNAPSHOT_TELEPORT,
} from "../../src/net/predictor";

const floor = buildBrush(boxPlanes([-4096, -4096, -64], [4096, 4096, 0]));
const world = createCollisionWorld([
  {
    planes: floor.planes,
    faceCount: floor.faceCount,
    bounds: floor.bounds,
    contents: CONTENTS_SOLID,
  },
]);

function registry(gravity = 800): CvarRegistry {
  const reg = new CvarRegistry();
  registerPmoveCvars(reg);
  reg.set("pm_gravity", gravity);
  return reg;
}

function spawnState(airborne = false): PlayerState {
  const s = new PlayerState();
  s.origin[2] = airborne ? 200 : 24 + 1 / 32;
  s.flags = airborne ? 0 : PMF_GROUNDED;
  s.groundEntity = airborne ? -1 : 32767;
  s.stamina = 10000;
  return s;
}

/** A strafing, turning, jumping cmd for `tick`. */
function cmdFor(tick: number): UserCmd {
  const c = new UserCmd();
  c.tick = tick;
  c.forward = 127;
  c.right = tick % 40 < 20 ? 127 : -127;
  c.yaw = (tick * 300) & 0xffff;
  c.buttons = tick % 30 === 0 ? BUTTON_JUMP : 0;
  return c;
}

/** The server's side: the same pmove from `s` at `from` through `to`, params by tick. */
function simulate(s: PlayerState, from: number, to: number, paramsFor: (t: number) => PmoveParams) {
  const out = copyPlayerState(new PlayerState(), s);
  for (let t = from + 1; t <= to; t++)
    pmove(out, cmdFor(t), world, paramsFor(t), TICK_DT, null, null);
  return out;
}

function params(reg: CvarRegistry): PmoveParams {
  const p = new PmoveParams();
  refreshPmoveParams(reg, p);
  return p;
}

function predictor(reg = registry(), spawn = spawnState(), from = 100, to = 130): Predictor {
  const p = new Predictor(world);
  p.setParams(reg, registryCvarHash(reg));
  p.reset(from, spawn);
  for (let t = from + 1; t <= to; t++) p.predict(cmdFor(t));
  return p;
}

describe("Predictor (docs/05 §5)", () => {
  it("predicts like the server and matches an exact snapshot", () => {
    const reg = registry();
    const p = predictor(reg);
    const pp = params(reg);
    const server = simulate(spawnState(), 100, 110, () => pp);
    expect(p.latestTick).toBe(130);
    expect(p.onSnapshot(110, server, registryCvarHash(reg) & 0xffff, 0)).toBe(SNAPSHOT_MATCHED);
    expect(p.snapshotTick).toBe(110);
    expect(p.corrections.total).toBe(0);
    // Older or repeated snapshots are stale.
    expect(p.onSnapshot(110, server, registryCvarHash(reg) & 0xffff, 0)).toBe(SNAPSHOT_STALE);
    expect(p.onSnapshot(105, server, registryCvarHash(reg) & 0xffff, 0)).toBe(SNAPSHOT_STALE);
  });

  it("records movement events and debug traces on first predictions only, not on re-simulation", () => {
    const reg = registry();
    const p = new Predictor(world);
    p.traceLog = new PmoveTraceLog();
    p.setParams(reg, registryCvarHash(reg));
    p.reset(100, spawnState());
    for (let t = 101; t <= 130; t++) p.predict(cmdFor(t));
    // Tick 120 jumps (cmdFor presses jump every 30 ticks).
    expect(p.events.count).toBeGreaterThan(0);
    p.events.clear();
    const traces = p.traceLog.total;
    expect(traces).toBeGreaterThan(0);
    const server = simulate(spawnState(), 100, 110, () => params(reg));
    server.origin[0] = (server.origin[0] as number) + 1;
    expect(p.onSnapshot(110, server, registryCvarHash(reg) & 0xffff, 0)).toBe(SNAPSHOT_CORRECTED);
    expect(p.events.count).toBe(0);
    expect(p.traceLog.total).toBe(traces);
  });

  it("corrects a wrong prediction: adopts the server state, re-simulates and logs it", () => {
    const reg = registry();
    const pp = params(reg);
    const p = predictor(reg);
    const server = simulate(spawnState(), 100, 110, () => pp);
    server.origin[0] = (server.origin[0] as number) + 4;
    const predictedBefore = new PlayerState();
    p.stateAt(110, predictedBefore);
    expect(p.onSnapshot(110, server, registryCvarHash(reg) & 0xffff, 0)).toBe(SNAPSHOT_CORRECTED);
    // The newest state is what the server will reach from its state with the same cmds.
    expect(
      playerStateEquals(
        p.state,
        simulate(server, 110, 130, () => pp),
      ),
    ).toBe(true);
    const latest = new PlayerState();
    p.stateAt(130, latest);
    expect(playerStateEquals(latest, p.state)).toBe(true);
    expect(p.lastCorrection[0]).toBeGreaterThan(3);
    const r = p.corrections.at(0);
    expect(p.corrections.total).toBe(1);
    expect([r.tick, r.latestTick]).toEqual([110, 130]);
    expect(playerStateEquals(r.predicted, predictedBefore)).toBe(true);
    expect(r.diff()[0]).toMatch(/^origin\[0\]: /);
  });

  it("resyncs without a correction when the snapshot's cvar hash differs", () => {
    const reg = registry();
    const p = predictor(reg);
    const pp = params(reg);
    const server = simulate(spawnState(), 100, 110, () => pp);
    server.origin[1] = (server.origin[1] as number) + 2;
    const other = (registryCvarHash(reg) + 1) & 0xffff;
    expect(p.onSnapshot(110, server, other, 0)).toBe(SNAPSHOT_PARAMS_RESYNC);
    expect(p.corrections.total).toBe(0);
    expect(
      playerStateEquals(
        p.state,
        simulate(server, 110, 130, () => pp),
      ),
    ).toBe(true);
  });

  it("switches parameters at the effective tick and re-simulates from the newest snapshot (D-027)", () => {
    const old = registry(800);
    const p = predictor(old, spawnState(true), 100, 130);
    const p800 = params(old);
    const s105 = simulate(spawnState(true), 100, 105, () => p800);
    expect(p.onSnapshot(105, s105, registryCvarHash(old) & 0xffff, 0)).toBe(SNAPSHOT_MATCHED);
    // The mirror takes the new block; ticks from 112 on fall at 400.
    const mirror = registry(400);
    const p400 = params(mirror);
    expect(p.setPendingParams(mirror, registryCvarHash(mirror), 112)).toBe(true);
    expect(p.pendingParams).toBe(true);
    const byTick = (t: number) => (t >= 112 ? p400 : p800);
    expect(playerStateEquals(p.state, simulate(spawnState(true), 100, 130, byTick))).toBe(true);
    // Snapshots before the effective tick carry the old hash, after it the new one: no correction.
    const s110 = simulate(spawnState(true), 100, 110, byTick);
    expect(p.onSnapshot(110, s110, registryCvarHash(old) & 0xffff, 0)).toBe(SNAPSHOT_MATCHED);
    expect(p.pendingParams).toBe(true);
    const s115 = simulate(spawnState(true), 100, 115, byTick);
    expect(p.onSnapshot(115, s115, registryCvarHash(mirror) & 0xffff, 0)).toBe(SNAPSHOT_MATCHED);
    expect(p.pendingParams).toBe(false);
    expect(p.paramsFor(101).gravity).toBe(400);
    expect(p.corrections.total).toBe(0);
  });

  it("takes a block effective at or before the newest snapshot at once", () => {
    const old = registry(800);
    const p = predictor(old, spawnState(true), 100, 130);
    const p800 = params(old);
    const s110 = simulate(spawnState(true), 100, 110, () => p800);
    p.onSnapshot(110, s110, registryCvarHash(old) & 0xffff, 0);
    const mirror = registry(400);
    expect(p.setPendingParams(mirror, registryCvarHash(mirror), 108)).toBe(true);
    expect(p.pendingParams).toBe(false);
    expect(p.hashFor(120)).toBe(registryCvarHash(mirror) & 0xffff);
    const p400 = params(mirror);
    expect(
      playerStateEquals(
        p.state,
        simulate(s110, 110, 130, () => p400),
      ),
    ).toBe(true);
  });

  it("hard-resyncs on a snapshot ahead of the prediction or out of the rings", () => {
    const reg = registry();
    const hash = registryCvarHash(reg) & 0xffff;
    const p = predictor(reg);
    const s = spawnState();
    s.origin[0] = 512;
    expect(p.onSnapshot(140, s, hash, 0)).toBe(SNAPSHOT_HARD_RESYNC);
    expect([p.latestTick, p.snapshotTick]).toEqual([140, 140]);
    expect(playerStateEquals(p.state, s)).toBe(true);
    for (let t = 141; t <= 141 + CMD_RING_CAPACITY + 10; t++) p.predict(cmdFor(t));
    expect(p.onSnapshot(150, s, hash, 0)).toBe(SNAPSHOT_HARD_RESYNC);
    expect(p.latestTick).toBe(150);
    expect(p.corrections.total).toBe(0);
  });

  it("hard-resyncs on a snapshot out of the rings even when its cvar hash differs", () => {
    // A params resync would re-simulate from cmds the ring no longer holds and leave the state
    // at the old tick while latestTick stays ahead.
    const reg = registry();
    const hash = registryCvarHash(reg) & 0xffff;
    const p = predictor(reg);
    const s = spawnState();
    expect(p.onSnapshot(140, s, hash, 0)).toBe(SNAPSHOT_HARD_RESYNC);
    for (let t = 141; t <= 141 + CMD_RING_CAPACITY + 10; t++) p.predict(cmdFor(t));
    s.origin[0] = 256;
    expect(p.onSnapshot(150, s, hash ^ 1, 0)).toBe(SNAPSHOT_HARD_RESYNC);
    expect([p.latestTick, p.snapshotTick]).toEqual([150, 150]);
    expect(playerStateEquals(p.state, s)).toBe(true);
  });
});

describe("Predictor teleport counter (D-035)", () => {
  /** The server's state at `tick` after a respawn at (x, 0) on the spawn tick `spawnTick`. */
  function respawned(x: number, spawnTick: number, tick: number, pp: PmoveParams): PlayerState {
    const s = spawnState();
    s.origin[0] = x;
    return simulate(s, spawnTick, tick, () => pp);
  }

  it("adopts a changed counter's state as a teleport, not a correction, and re-simulates", () => {
    const reg = registry();
    const pp = params(reg);
    const hash = registryCvarHash(reg) & 0xffff;
    const p = predictor(reg);
    // The first snapshot seeds the counter: nothing to count.
    expect(
      p.onSnapshot(
        105,
        simulate(spawnState(), 100, 105, () => pp),
        hash,
        7,
      ),
    ).toBe(SNAPSHOT_MATCHED);
    expect([p.teleportSeq, p.teleports]).toEqual([7, 0]);
    // A respawn 300 u away on tick 108, seen on 110 with the next counter.
    const server = respawned(300, 108, 110, pp);
    expect(p.onSnapshot(110, server, hash, 8)).toBe(SNAPSHOT_TELEPORT);
    expect([p.teleportSeq, p.teleports, p.corrections.total]).toEqual([8, 1, 0]);
    expect(
      playerStateEquals(
        p.state,
        simulate(server, 110, 130, () => pp),
      ),
    ).toBe(true);
    // Later snapshots with the same counter reconcile as usual.
    expect(
      p.onSnapshot(
        115,
        simulate(server, 110, 115, () => pp),
        hash,
        8,
      ),
    ).toBe(SNAPSHOT_MATCHED);
    expect(p.teleports).toBe(1);
  });

  it("counts a wrapped counter and takes it even when the state happens to match", () => {
    const reg = registry();
    const pp = params(reg);
    const hash = registryCvarHash(reg) & 0xffff;
    const p = predictor(reg);
    p.teleportSeq = 255;
    expect(
      p.onSnapshot(
        110,
        simulate(spawnState(), 100, 110, () => pp),
        hash,
        0,
      ),
    ).toBe(SNAPSHOT_TELEPORT);
    expect([p.teleportSeq, p.teleports, p.corrections.total]).toEqual([0, 1, 0]);
  });

  it("never steps the counter on a stale snapshot, so a reordered old one doesn't snap twice", () => {
    const reg = registry();
    const pp = params(reg);
    const hash = registryCvarHash(reg) & 0xffff;
    const p = predictor(reg);
    p.teleportSeq = 1;
    const server = respawned(-200, 109, 112, pp);
    // The spawn's own snapshot (110) was lost: 112 carries the new counter.
    expect(p.onSnapshot(112, server, hash, 2)).toBe(SNAPSHOT_TELEPORT);
    // 108 and 111, with the old and the new counter, arrive late: stale, the counter stays.
    expect(
      p.onSnapshot(
        108,
        simulate(spawnState(), 100, 108, () => pp),
        hash,
        1,
      ),
    ).toBe(SNAPSHOT_STALE);
    expect(p.onSnapshot(111, respawned(-200, 109, 111, pp), hash, 2)).toBe(SNAPSHOT_STALE);
    expect([p.teleportSeq, p.teleports]).toEqual([2, 1]);
    expect(
      p.onSnapshot(
        114,
        simulate(server, 112, 114, () => pp),
        hash,
        2,
      ),
    ).toBe(SNAPSHOT_MATCHED);
  });

  it("counts a teleport that comes with a hard resync, which adopts the state itself", () => {
    const reg = registry();
    const hash = registryCvarHash(reg) & 0xffff;
    const p = predictor(reg);
    p.teleportSeq = 4;
    const s = spawnState();
    s.origin[1] = 640;
    expect(p.onSnapshot(140, s, hash, 5)).toBe(SNAPSHOT_HARD_RESYNC);
    expect([p.teleportSeq, p.teleports, p.corrections.total]).toEqual([5, 1, 0]);
    expect(playerStateEquals(p.state, s)).toBe(true);
  });
});

describe("CmdRing and CorrectionLog", () => {
  it("the cmd ring remembers which tick a slot holds", () => {
    const ring = new CmdRing();
    ring.write(cmdFor(5));
    expect(ring.get(5)?.right).toBe(127);
    expect(ring.get(5 + CMD_RING_CAPACITY)).toBeNull();
    ring.write(cmdFor(5 + CMD_RING_CAPACITY));
    expect(ring.has(5)).toBe(false);
    expect(ring.get(-1)).toBeNull();
    ring.clear();
    expect(ring.has(5 + CMD_RING_CAPACITY)).toBe(false);
  });

  it("the log keeps the newest corrections, oldest first", () => {
    const log = new CorrectionLog();
    for (let i = 0; i < CORRECTION_LOG_CAPACITY + 3; i++) log.push().tick = i;
    expect(log.count).toBe(CORRECTION_LOG_CAPACITY);
    expect(log.total).toBe(CORRECTION_LOG_CAPACITY + 3);
    expect(log.at(0).tick).toBe(3);
    expect(log.at(CORRECTION_LOG_CAPACITY - 1).tick).toBe(CORRECTION_LOG_CAPACITY + 2);
    log.clear();
    expect(log.count).toBe(0);
  });
});
