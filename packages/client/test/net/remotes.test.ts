import {
  boxPlanes,
  buildBrush,
  CONTENTS_SOLID,
  createCollisionWorld,
  PMEV_JUMP,
  PMEV_LAND,
  PMF_CROUCHED,
  PMF_GROUNDED,
  pushEntityEvent,
  TEAM_1,
  TEAM_2,
  type WorldFrame,
} from "@game/shared";
import { describe, expect, it } from "vitest";
import { TICK_MS } from "../../src/net/clock";
import { ClientNetSettings } from "../../src/net/cvars";
import {
  DELAY_FALL_MS,
  ID_DEFER_LAG,
  ID_FORMULA,
  ID_INTERVAL,
  ID_P95,
  INTERP_DELAY_MAX,
  INTERP_DELAY_MIN,
  InterpDelay,
  JM_CHECKED,
  JM_FRAME_VIOLATIONS,
  JM_VIOLATIONS,
  RC_MAX_OFFSET,
  RC_RATE,
  RC_RENDER,
  RC_TARGET,
  REMOTE_EXTRAPOLATED,
  REMOTE_HELD,
  REMOTE_INTERPOLATED,
  RENDER_SNAP_TICKS,
  RemoteInterpolator,
  RemoteJumpMeter,
  RenderClock,
} from "../../src/net/remotes";
import { SnapshotStore } from "../../src/net/snapshotStore";
import {
  NetStats,
  STAT_REMOTE_EVENTS,
  STAT_REMOTE_EVENTS_LOST,
  STAT_REMOTE_EXTRAPOLATED,
  STAT_REMOTE_FRAMES,
  STAT_REMOTE_HELD,
  STAT_RENDER_SNAPS,
} from "../../src/net/stats";

const SELF = 0;
const EMPTY = createCollisionWorld([]);

interface Fields {
  x?: number;
  y?: number;
  z?: number;
  vx?: number;
  vy?: number;
  vz?: number;
  yaw?: number;
  pitch?: number;
  flags?: number;
  team?: number;
  seq?: number;
  /** The slot's state stamp (the frame's tick by default; 0 = pending). */
  stamp?: number;
}

/** Writes slot `s` of `f` (origin and velocity in u and u/s). */
function put(f: WorldFrame, tick: number, s: number, o: Fields = {}): void {
  f.setPresent(s, o.stamp ?? tick);
  f.originX[s] = Math.round((o.x ?? 0) * 32);
  f.originY[s] = Math.round((o.y ?? 0) * 32);
  f.originZ[s] = Math.round((o.z ?? 24) * 32);
  f.entVelX[s] = o.vx ?? 0;
  f.entVelY[s] = o.vy ?? 0;
  f.entVelZ[s] = o.vz ?? 0;
  f.yaw[s] = o.yaw ?? 0;
  f.pitch[s] = o.pitch ?? 0;
  f.flags[s] = o.flags ?? PMF_GROUNDED;
  f.team[s] = o.team ?? TEAM_1;
  f.teleportSeq[s] = o.seq ?? 1;
}

/**
 * An interpolator over a hand-filled store on a fake clock: `snap` stores a frame as the store
 * would and reports it at the current time; `frame` advances the clock and updates.
 */
class Rig {
  readonly now = new Float64Array(1);
  readonly store = new SnapshotStore();
  readonly settings = new ClientNetSettings();
  readonly stats = new NetStats(this.now);
  readonly interp: RemoteInterpolator;
  readonly meter = new RemoteJumpMeter();

  constructor(world = EMPTY) {
    this.interp = new RemoteInterpolator(this.store, this.now, this.settings, this.stats, world);
  }

  /** Stores tick `tick`'s frame (filled by `fill`) as received now. */
  snap(tick: number, fill: (f: WorldFrame) => void): void {
    const f = this.store.ring.slot(tick);
    f.clear();
    // The receiver's own slot is always there.
    put(f, tick, SELF);
    fill(f);
    this.store.ring.store(tick);
    if (tick > this.store.newestTick) this.store.newestTick = tick;
    this.interp.onStored(tick);
  }

  /** Every surfaced event, [slot, kind, value] in order. */
  readonly events: number[][] = [];

  frame(dtMs: number): void {
    this.now[0] = (this.now[0] as number) + dtMs;
    this.stats.advance();
    this.interp.update(SELF);
    this.meter.measure(this.interp, true);
    const i = this.interp;
    for (let k = 0; k < i.eventCount; k++) {
      this.events.push([
        i.eventSlot[k] as number,
        i.eventKind[k] as number,
        i.eventValue[k] as number,
      ]);
    }
  }

  get render(): number {
    return this.interp.clock.t[RC_RENDER] as number;
  }

  /** Runs `ms` at 144 Hz with a snapshot of `fill(tick)` arriving on every server tick. */
  stream(fromTick: number, ms: number, fill: (f: WorldFrame, tick: number) => void): number {
    let tick = fromTick;
    let nextSnap = this.now[0] as number;
    const end = (this.now[0] as number) + ms;
    while ((this.now[0] as number) < end) {
      while (nextSnap <= (this.now[0] as number)) {
        const t = tick;
        this.snap(t, (f) => fill(f, t));
        tick++;
        nextSnap += TICK_MS;
      }
      this.frame(1000 / 144);
    }
    return tick;
  }
}

describe("RenderClock (M3 design §2.8)", () => {
  it("places itself on the first frame, then slews within [0.9, 1.1] toward its target", () => {
    const now = new Float64Array([1000]);
    const c = new RenderClock(now);
    c.advance(3, 0);
    // Nothing arrived yet: no render time.
    expect(Number.isNaN(c.t[RC_RENDER] as number)).toBe(true);
    c.onSnapshot(100);
    expect(c.t[RC_MAX_OFFSET]).toBeCloseTo(100 - 1000 / TICK_MS, 9);
    c.advance(3, 100);
    expect(c.snaps).toBe(1);
    expect(c.snapped).toBe(true);
    expect(c.t[RC_RENDER]).toBeCloseTo(97, 9);
    // Target 2 ticks ahead (a lower delay): the fastest rate, 1.1.
    now[0] = 1000 + TICK_MS;
    c.advance(1, 100);
    expect(c.t[RC_RATE]).toBeCloseTo(1.1, 9);
    expect(c.t[RC_RENDER]).toBeCloseTo(98.1, 9);
    expect(c.snapped).toBe(false);
    // Target behind (a higher delay): the slowest normal rate, 0.9.
    now[0] = 1000 + 2 * TICK_MS;
    c.advance(6, 100);
    expect(c.t[RC_RATE]).toBeCloseTo(0.9, 9);
    // Close to the target: proportional to the error where the plain rate would put the render
    // tick (D-037: the target is of this frame, the render tick of the last).
    const before = c.t[RC_RENDER] as number;
    now[0] = 1000 + 3 * TICK_MS;
    const target = now[0] / TICK_MS + (c.t[RC_MAX_OFFSET] as number) - 2.9;
    const error = target - (before + 1);
    expect(Math.abs(error)).toBeLessThan(0.2);
    expect(Math.abs(error)).toBeGreaterThan(0.01);
    c.advance(2.9, 100);
    expect(c.t[RC_TARGET]).toBeCloseTo(target, 9);
    expect(c.t[RC_RATE]).toBeCloseTo(1 + error * 0.5, 9);
    expect(c.t[RC_RENDER]).toBeCloseTo(before + 1 + error * 0.5, 9);
  });

  it("slows to 0.5 only while past the newest stored tick", () => {
    const now = new Float64Array([0]);
    const c = new RenderClock(now);
    c.onSnapshot(10);
    c.advance(2, 10);
    expect(c.t[RC_RENDER]).toBeCloseTo(8, 9);
    // A delay of 6 puts the target 4 ticks back: 0.9 while at or before the newest tick…
    now[0] = TICK_MS;
    c.advance(6, 10);
    expect(c.t[RC_RATE]).toBeCloseTo(0.9, 9);
    // …and 0.5 once the render tick is past it.
    const c2 = new RenderClock(now);
    now[0] = 0;
    c2.onSnapshot(10);
    c2.advance(2, 10);
    now[0] = TICK_MS;
    c2.advance(6, 7);
    expect(c2.t[RC_RATE]).toBeCloseTo(0.5, 9);
  });

  it("snaps forward more than 6 ticks behind, counted, and never runs backwards", () => {
    const now = new Float64Array([0]);
    const c = new RenderClock(now);
    c.onSnapshot(100);
    c.advance(2, 100);
    // A 200 ms stall with the delay up to the maximum: still within reach (1.1 × 12 ticks).
    now[0] = 200;
    c.advance(2, 100);
    expect(c.snaps).toBe(1);
    // Newer snapshots far ahead of the render time: more than 6 ticks behind → snap.
    c.onSnapshot(140);
    now[0] = 200 + TICK_MS;
    c.advance(2, 140);
    expect(c.snaps).toBe(2);
    expect(c.snapped).toBe(true);
    expect(c.t[RC_RENDER]).toBeCloseTo(c.t[RC_TARGET] as number, 9);
    // The target falls far behind (a huge delay): the render tick still moves forward.
    let last = c.t[RC_RENDER] as number;
    for (let i = 1; i <= 20; i++) {
      now[0] = 200 + (1 + i) * TICK_MS;
      c.advance(2 + RENDER_SNAP_TICKS * 3, 140);
      const r = c.t[RC_RENDER] as number;
      expect(r).toBeGreaterThan(last);
      last = r;
    }
    expect(c.snaps).toBe(2);
  });

  it("keeps the largest offset of the last 120 arrivals", () => {
    const now = new Float64Array([0]);
    const c = new RenderClock(now);
    // One early arrival (offset +3 ticks), then 120 on time: it ages out.
    c.onSnapshot(3);
    for (let i = 1; i <= 119; i++) {
      now[0] = i * TICK_MS;
      c.onSnapshot(i);
    }
    expect(c.t[RC_MAX_OFFSET]).toBeCloseTo(3, 9);
    now[0] = 120 * TICK_MS;
    c.onSnapshot(120);
    expect(c.t[RC_MAX_OFFSET]).toBeCloseTo(0, 9);
  });

  it("restarts its window after 30 arrivals in a row more than 6 ticks late (a stall that dropped ticks)", () => {
    const now = new Float64Array([0]);
    const c = new RenderClock(now);
    for (let i = 1; i <= 120; i++) {
      now[0] = i * TICK_MS;
      c.onSnapshot(i);
    }
    expect(c.t[RC_MAX_OFFSET]).toBeCloseTo(0, 9);
    // 7 ticks late for 29 arrivals: still the old window.
    for (let i = 121; i <= 149; i++) {
      now[0] = (i + 7) * TICK_MS;
      c.onSnapshot(i);
    }
    expect([c.rebases, c.count]).toEqual([0, 120]);
    // An arrival on time breaks the run; then 30 in a row, the 30th restarts the window.
    now[0] = 150 * TICK_MS;
    c.onSnapshot(150);
    for (let i = 151; i <= 180; i++) {
      now[0] = (i + 7) * TICK_MS;
      c.onSnapshot(i);
      expect(c.rebases).toBe(i === 180 ? 1 : 0);
    }
    expect(c.count).toBe(30);
    expect(c.t[RC_MAX_OFFSET]).toBeCloseTo(-7, 9);
    // Jitter within the delay's reach (6 ticks late at most) never restarts it.
    for (let i = 181; i <= 600; i++) {
      now[0] = (i + 7 + (i % 7 === 0 ? 6 : 0)) * TICK_MS;
      c.onSnapshot(i);
    }
    expect(c.rebases).toBe(1);
    expect(c.count).toBe(120);
    // And the ring goes on from the restart: the largest offset of the last 120.
    now[0] = (601 + 7 - 3) * TICK_MS;
    c.onSnapshot(601);
    expect(c.t[RC_MAX_OFFSET]).toBeCloseTo(-4, 9);
  });
});

describe("InterpDelay (M3 design §2.8)", () => {
  /** Arrivals of ticks 1… every tick, each `late(i)` ticks late; returns the delay. */
  function feed(
    d: InterpDelay,
    c: RenderClock,
    now: Float64Array,
    n: number,
    late: (i: number) => number,
    step = 1,
    from = 1,
  ): void {
    for (let i = 0; i < n; i++) {
      const tick = from + i * step;
      now[0] = (tick + late(i)) * TICK_MS;
      c.onSnapshot(tick);
      d.onSnapshot(c, i === 0 && from === 1 ? 0 : step);
    }
  }

  it("is 2 ticks on a steady stream, 2 × the interval plus the p95 lateness otherwise", () => {
    const now = new Float64Array(1);
    const c = new RenderClock(now);
    const d = new InterpDelay(now);
    feed(d, c, now, 120, () => 0);
    expect([d.t[ID_P95], d.t[ID_INTERVAL], d.ticks]).toEqual([0, 1, 2]);
    // Every 4th arrival 1.3 ticks late (25% > 5%): p95 1.25 (1/8-tick buckets), D = ceil(3.25).
    const c2 = new RenderClock(now);
    const d2 = new InterpDelay(now);
    feed(d2, c2, now, 120, (i) => (i % 4 === 0 ? 1.3 : 0));
    expect(d2.t[ID_P95]).toBe(1.25);
    expect(d2.ticks).toBe(4);
    // Every other tick (a 30 Hz stream): 2 × 2.
    const c3 = new RenderClock(now);
    const d3 = new InterpDelay(now);
    feed(d3, c3, now, 60, () => 0, 2);
    expect(d3.t[ID_INTERVAL]).toBe(2);
    expect(d3.ticks).toBe(4);
  });

  it("takes the snapshot interval as the median step of the last 30", () => {
    const now = new Float64Array(1);
    const c = new RenderClock(now);
    const d = new InterpDelay(now);
    // 20 steps of 1 and 10 of 3, interleaved: the median is 1 (the mean would be 1.67).
    let tick = 1;
    for (let i = 0; i <= 30; i++) {
      const step = i === 0 ? 0 : i % 3 === 0 ? 3 : 1;
      tick += step;
      now[0] = tick * TICK_MS;
      c.onSnapshot(tick);
      d.onSnapshot(c, step);
    }
    expect(d.t[ID_INTERVAL]).toBe(1);
    expect(d.ticks).toBe(2);
    // Mostly 3 now: the median follows.
    for (let i = 0; i < 20; i++) {
      tick += 3;
      now[0] = tick * TICK_MS;
      c.onSnapshot(tick);
      d.onSnapshot(c, 3);
    }
    expect(d.t[ID_INTERVAL]).toBe(3);
    expect(d.ticks).toBe(6);
  });

  it("stays within 2–6 ticks", () => {
    const now = new Float64Array(1);
    const c = new RenderClock(now);
    const d = new InterpDelay(now);
    feed(d, c, now, 120, (i) => (i % 2 === 0 ? 7 : 0));
    expect(d.t[ID_FORMULA]).toBe(INTERP_DELAY_MAX);
    expect(d.ticks).toBe(INTERP_DELAY_MAX);
    expect(INTERP_DELAY_MIN).toBe(2);
  });

  it("rises at once and falls only after 2 s lower, to the highest value of those 2 s", () => {
    const now = new Float64Array(1);
    const c = new RenderClock(now);
    const d = new InterpDelay(now);
    feed(d, c, now, 120, () => 0);
    expect(d.ticks).toBe(2);
    // One arrival 3 ticks early raises the offset maximum: everything else is 3 late.
    feed(d, c, now, 1, () => -3, 1, 121);
    const high = d.ticks;
    expect(high).toBe(5);
    // That early one ages out after 120 more arrivals (2 s); then 2 s more at the low value.
    feed(d, c, now, 120, () => 0, 1, 122);
    expect(d.t[ID_FORMULA]).toBe(2);
    expect(d.ticks).toBe(high);
    const lowAt = now[0] as number;
    let fellAt = Number.NaN;
    for (let i = 0; i < 200 && Number.isNaN(fellAt); i++) {
      feed(d, c, now, 1, () => 0, 1, 242 + i);
      if (d.ticks < high) fellAt = now[0] as number;
    }
    expect(fellAt - lowAt).toBeGreaterThanOrEqual(DELAY_FALL_MS - TICK_MS);
    expect(fellAt - lowAt).toBeLessThanOrEqual(DELAY_FALL_MS + TICK_MS);
    expect(d.ticks).toBe(2);
  });

  it("falls to the highest formula value of its 2 s below, not the last", () => {
    const now = new Float64Array(1);
    const c = new RenderClock(now);
    const d = new InterpDelay(now);
    feed(d, c, now, 120, () => 0);
    // One arrival 4 ticks early: the rest 4+ late, the formula at its 6 cap.
    feed(d, c, now, 1, () => -4, 1, 121);
    expect(d.ticks).toBe(6);
    // Every 4th arrival 1.3 ticks late (formula 4 once the early one is out of the window)…
    const a = (i: number) => (i % 4 === 0 ? 1.3 : 0);
    feed(d, c, now, 120, a, 1, 122);
    expect(d.t[ID_FORMULA]).toBe(4);
    expect(d.ticks).toBe(6);
    // …then every 4th 0.5 late (formula 3 once those 1.3s are under 5% of the window).
    const formulas = new Set<number>();
    let fell = 0;
    for (let i = 0; i < 200 && fell === 0; i++) {
      feed(d, c, now, 1, () => (i % 4 === 0 ? 0.5 : 0), 1, 242 + i);
      formulas.add(d.t[ID_FORMULA] as number);
      if (d.ticks < 6) fell = d.ticks;
    }
    expect([...formulas].sort()).toEqual([3, 4]);
    expect(fell).toBe(4);
  });
});

describe("InterpDelay's defer lag (M3 design §2.8, D-046)", () => {
  it("adds the defer lag to the formula: 0 without deferral, 1 when the scheduler alternates", () => {
    const now = new Float64Array(1);
    const c = new RenderClock(now);
    const d = new InterpDelay(now);
    for (let tick = 1; tick <= 120; tick++) {
      now[0] = tick * TICK_MS;
      c.onSnapshot(tick);
      d.onSnapshot(c, tick === 1 ? 0 : 1, 0);
    }
    expect([d.t[ID_DEFER_LAG], d.ticks]).toEqual([0, 2]);
    // One snapshot with a lag of 1: ceil(2 + 0 + 1) = 3 at once, for the next 120 arrivals.
    now[0] = 121 * TICK_MS;
    c.onSnapshot(121);
    d.onSnapshot(c, 1, 1);
    expect([d.t[ID_DEFER_LAG], d.t[ID_FORMULA], d.ticks]).toEqual([1, 3, 3]);
    for (let tick = 122; tick < 241; tick++) {
      now[0] = tick * TICK_MS;
      c.onSnapshot(tick);
      d.onSnapshot(c, 1, 0);
    }
    expect(d.t[ID_DEFER_LAG]).toBe(1);
    now[0] = 241 * TICK_MS;
    c.onSnapshot(241);
    d.onSnapshot(c, 1, 0);
    expect([d.t[ID_DEFER_LAG], d.t[ID_FORMULA]]).toEqual([0, 2]);
  });

  it("is 1 for a deferred copy carrying an old baseline stamp when the slot went fresh last tick", () => {
    const r = new Rig();
    for (let t = 1; t <= 40; t++) {
      r.snap(t, (f) => {
        put(f, t, 3, { x: t });
        // Slot 4 left out every other snapshot: its copy carries the stamp of a baseline 6 ticks
        // back (an ack 6 ticks old), though the previous snapshot carried it fresh.
        if (t % 2 === 0 && t > 8) put(f, t, 4, { x: t - 7, stamp: t - 7 });
        else put(f, t, 4, { x: t });
      });
      r.frame(TICK_MS);
    }
    expect(r.interp.delay.t[ID_DEFER_LAG]).toBe(1);
    expect(r.interp.delay.t[ID_FORMULA]).toBe(3);
    // Nothing deferred: back to 0 once the window is past the deferrals.
    for (let t = 41; t <= 160; t++) {
      r.snap(t, (f) => {
        put(f, t, 3, { x: t });
        put(f, t, 4, { x: t });
      });
      r.frame(TICK_MS);
    }
    expect(r.interp.delay.t[ID_DEFER_LAG]).toBe(0);
  });

  it("ignores a pending slot with no sample yet, and an older player's samples in that slot", () => {
    const r = new Rig();
    for (let t = 1; t <= 30; t++) {
      r.snap(t, (f) => {
        put(f, t, 3, { x: t });
        // Slot 9: a player until 20, gone at 21, a new one pending (no sample of its own) after.
        if (t <= 20) put(f, t, 9, { x: t });
        else if (t > 21) f.setPresent(9, 0);
      });
      r.frame(TICK_MS);
      // The new player's frames defer it without a sample: no lag, neither from the pending
      // slot itself nor from the old player's stamps behind the absent frame.
      if (t > 21) expect(r.interp.delay.t[ID_DEFER_LAG], `tick ${t}`).toBe(0);
    }
    expect(r.interp.view.visible[9]).toBe(0);
  });

  it("measures 2 when a left-out slot's freshest sample is 2 ticks old (its fresh snapshot lost)", () => {
    const r = new Rig();
    for (let t = 1; t <= 20; t++) {
      if (t === 19) continue;
      r.snap(t, (f) => {
        put(f, t, 3, { x: t });
        // 20 leaves slot 3 out (a copy of 18's state); 19, where it went fresh, never arrived.
        if (t === 20) put(f, t, 5, { x: 18, stamp: 18 });
        else put(f, t, 5, { x: t });
      });
    }
    expect(r.interp.delay.t[ID_DEFER_LAG]).toBe(2);
  });
});

describe("RemoteInterpolator under deferral (M3 design §2.8, D-046)", () => {
  /**
   * Slot 1 runs +5 u a tick. From tick 200 the scheduler leaves it out of every even snapshot,
   * whose copy carries an ack-old baseline's stamp (tick − 21) and state; every odd snapshot that
   * is a multiple of 7 (one carrying it fresh) is lost. With `respawn` it teleports 5000 u on at
   * that tick. The drawn sample must never move back to an older copy: no step backwards, no
   * replayed events, never back on the pre-respawn side once past it.
   */
  it.each([
    [0, 0],
    [6, 0],
    [0, 240],
    [6, 233],
  ])(
    "never draws an old deferred copy over the fresher sample (cl_interpDelay %d, respawn %d)",
    (fixed, respawn) => {
      const r = new Rig();
      r.settings.interpDelay = fixed;
      const S = 1;
      const fill = (f: WorldFrame, tick: number): void => {
        const st = tick >= 200 && tick % 2 === 0 ? tick - 21 : tick;
        const after = respawn > 0 && st >= respawn;
        put(f, tick, S, { x: st * 5 + (after ? 5000 : 0), vx: 300, stamp: st, seq: after ? 2 : 1 });
        f.eventSeq[S] = st & 0xff;
        f.evKind[S * 2] = PMEV_JUMP;
        f.evKind[S * 2 + 1] = PMEV_JUMP;
      };
      let tick = 1;
      let nextSnap = 0;
      let lastX = Number.NEGATIVE_INFINITY;
      let backwards = 0;
      let crossed = false;
      let returned = 0;
      for (let i = 0; i < 144 * 8; i++) {
        while (nextSnap <= (r.now[0] as number)) {
          const lost = tick >= 200 && tick % 2 === 1 && tick % 7 === 0;
          const t = tick;
          if (!lost) r.snap(t, (f) => fill(f, t));
          tick++;
          nextSnap += TICK_MS;
        }
        r.frame(1000 / 144);
        if (r.interp.view.visible[S] !== 1 || tick <= 210) continue;
        const x = r.interp.view.x[S] as number;
        if (x < lastX - 0.01) backwards++;
        if (respawn > 0 && x > respawn * 5 + 2500) crossed = true;
        else if (crossed) returned++;
        lastX = x;
      }
      expect([backwards, returned]).toEqual([0, 0]);
      if (respawn > 0) expect(crossed).toBe(true);
      // Only the lost frames lose events (2 each, about 1 in 14 ticks): no replay of old ones.
      expect(r.stats.totals[STAT_REMOTE_EVENTS_LOST] as number).toBeLessThan(200);
    },
  );
});

describe("RemoteInterpolator (M3 design §2.8, D-037)", () => {
  it("lerps between the bracketing samples, yaw along the short arc across 0/65535", () => {
    const r = new Rig();
    r.settings.interpDelay = 2;
    // Slot 3 moves +x 10 u per tick, its yaw crossing 0 (65000 → 535: +1071 units per tick).
    r.stream(100, 500, (f, t) =>
      put(f, t, 3, {
        x: (t - 100) * 10,
        vx: 600,
        yaw: (65000 + (t - 100) * 1071) & 0xffff,
        pitch: -200 + (t - 100) * 4,
        team: TEAM_2,
      }),
    );
    const i = r.interp;
    const v = i.view;
    expect(v.visible[3]).toBe(1);
    expect(v.count).toBe(1);
    expect(i.mode[3]).toBe(REMOTE_INTERPOLATED);
    const rt = r.render;
    expect(v.x[3]).toBeCloseTo((rt - 100) * 10, 6);
    const yawUnits = (65000 + (rt - 100) * 1071) % 65536;
    expect(v.yaw[3]).toBeCloseTo((yawUnits * 360) / 65536, 6);
    expect(v.pitch[3]).toBeCloseTo(((-200 + (rt - 100) * 4) * 360) / 65536, 6);
    expect([v.team[3], v.crouched[3], v.extrapolating[3], v.teleported[3]]).toEqual([
      TEAM_2,
      0,
      0,
      0,
    ]);
    // Never its own slot.
    expect(v.visible[SELF]).toBe(0);
    // Smooth: the meter judged every frame after the first and found no jump.
    expect(r.meter.t[JM_CHECKED]).toBeGreaterThan(50);
    expect(r.meter.t[JM_VIOLATIONS]).toBe(0);
    expect(r.stats.totals[STAT_REMOTE_FRAMES]).toBeGreaterThan(50);
    expect(r.stats.totals[STAT_REMOTE_EXTRAPOLATED]).toBe(0);
  });

  it("follows the render clock and the auto delay on a steady 60 Hz stream", () => {
    const r = new Rig();
    r.stream(1, 3000, (f, t) => put(f, t, 5, { x: t, vx: 60 }));
    const i = r.interp;
    // Arrivals on the frame grid are up to a 144 Hz frame late: p95 under half a tick, D 3.
    expect(i.delay.t[ID_P95]).toBeLessThan(0.5);
    expect(i.delayTicks).toBe(3);
    const newest = r.store.newestTick;
    expect(r.render).toBeGreaterThan(newest - 4);
    expect(r.render).toBeLessThan(newest - 1);
    expect(i.clock.snaps).toBe(1);
    expect(r.stats.totals[STAT_RENDER_SNAPS]).toBe(0);
    expect(r.meter.t[JM_VIOLATIONS]).toBe(0);
  });

  it("snaps on a teleport counter change, never lerping across it", () => {
    const r = new Rig();
    r.settings.interpDelay = 3;
    const tick = r.stream(10, 500, (f, t) => put(f, t, 2, { x: 0, seq: 4 }));
    const v = r.interp.view;
    // The next tick it is 900 u away with a new counter.
    let t = tick;
    const jumpTick = t;
    const xs: number[] = [];
    const marks: number[] = [];
    for (let k = 0; k < 120; k++) {
      if (k % 2 === 0 && k < 60) {
        const tt = t;
        r.snap(tt, (f) =>
          put(f, tt, 2, { x: tt >= jumpTick ? 900 : 0, seq: tt >= jumpTick ? 5 : 4 }),
        );
        t++;
      }
      r.frame(TICK_MS / 2);
      xs.push(v.x[2] as number);
      marks.push(v.teleported[2] as number);
    }
    // Only ever at 0 or at 900, marked once on the jump.
    for (const x of xs) expect(x === 0 || x === 900).toBe(true);
    expect(marks.filter((m) => m === 1).length).toBe(1);
    expect(xs.indexOf(900)).toBe(marks.indexOf(1));
    expect(r.meter.t[JM_VIOLATIONS]).toBe(0);
  });

  it("does not snap when a slot's record is re-sent as new with the same counter, or pending between", () => {
    const r = new Rig();
    r.settings.interpDelay = 3;
    let t = r.stream(10, 300, (f, tt) => put(f, tt, 6, { x: tt * 5, vx: 300 }));
    const v = r.interp.view;
    let marks = 0;
    for (let k = 0; k < 40; k++) {
      const tt = t;
      // Every third frame holds the slot pending (present, no state yet: D-046's re-sent "new").
      r.snap(tt, (f) => {
        if (tt % 3 === 0) f.setPresent(6, 0);
        else put(f, tt, 6, { x: tt * 5, vx: 300 });
      });
      t++;
      r.frame(TICK_MS);
      marks += v.teleported[6] as number;
      expect(v.visible[6]).toBe(1);
    }
    expect(marks).toBe(0);
    expect(r.meter.t[JM_VIOLATIONS]).toBe(0);
  });

  it("takes samples by stamp: a frame holding an older stamp is that older sample", () => {
    const r = new Rig();
    r.settings.interpDelay = 2;
    r.snap(10, (f) => put(f, 10, 1, { x: 100 }));
    r.snap(11, (f) => put(f, 11, 1, { x: 110 }));
    // Frame 12 carries the slot as of tick 10 (a deferred copy), frame 13 fresh.
    r.snap(12, (f) => put(f, 12, 1, { x: 100, stamp: 10 }));
    r.snap(13, (f) => put(f, 13, 1, { x: 130 }));
    r.frame(0);
    // Placed at 13 − 2 = 11: exactly the stamp-11 sample (the copy is not "tick 12").
    expect(r.render).toBeCloseTo(11, 6);
    expect(r.interp.view.x[1]).toBeCloseTo(110, 6);
    // Half way between 11 and 13 (the copy gives no sample of tick 12): 120.
    r.frame(TICK_MS);
    const rt = r.render;
    expect(rt).toBeGreaterThan(11.5);
    expect(r.interp.view.x[1]).toBeCloseTo(110 + (rt - 11) * 10, 6);
  });

  it("extrapolates at most 2 ticks along the velocity, then holds, then rejoins smoothly", () => {
    const r = new Rig();
    r.settings.interpDelay = 3;
    let t = r.stream(1, 500, (f, tt) => put(f, tt, 4, { x: tt * 10, vx: 600 }));
    const i = r.interp;
    const v = i.view;
    const last = t - 1;
    // A 150 ms outage (9 snapshots lost).
    let extrapolated = 0;
    let held = 0;
    for (let k = 0; k < 22; k++) {
      r.frame(1000 / 144);
      if (i.mode[4] === REMOTE_EXTRAPOLATED) extrapolated++;
      if (i.mode[4] === REMOTE_HELD) held++;
      expect(v.x[4]).toBeLessThanOrEqual(last * 10 + 20 + 1e-9);
    }
    expect(extrapolated).toBeGreaterThan(0);
    expect(held).toBeGreaterThan(0);
    expect(v.extrapolating[4]).toBe(1);
    expect(v.x[4]).toBeCloseTo(last * 10 + 20, 6);
    expect(r.stats.totals[STAT_REMOTE_EXTRAPOLATED]).toBe(extrapolated);
    expect(r.stats.totals[STAT_REMOTE_HELD]).toBe(held);
    // Snapshots return (the stream went on meanwhile): an offset decays over cl_remoteSmoothMs.
    t = last + 10;
    r.stream(t, 400, (f, tt) => put(f, tt, 4, { x: tt * 10, vx: 600 }));

    expect(i.mode[4]).toBe(REMOTE_INTERPOLATED);
    expect(i.offsetLength[4]).toBe(0);
    expect(v.x[4]).toBeCloseTo((r.render as number) * 10, 6);
    // Within the rejoin allowance all along, and never a render snap (12 ticks were absorbed).
    expect(r.meter.t[JM_VIOLATIONS]).toBe(0);
  });

  it("smooths a rejoin past cl_teleportDist that the speed explains (a 150 ms outage at 760 u/s)", () => {
    const r = new Rig();
    r.settings.interpDelay = 3;
    const v = 760 / 60;
    const fill = (f: WorldFrame, tt: number) => put(f, tt, 4, { x: tt * v, vx: 760 });
    const t = r.stream(1, 500, fill);
    // 150 ms without snapshots: 9 ticks lost, ~5 of them held.
    for (let k = 0; k < 22; k++) r.frame(1000 / 144);
    expect(r.interp.mode[4]).toBe(REMOTE_HELD);
    let largest = 0;
    let tick = t + 9;
    let next = r.now[0] as number;
    for (let k = 0; k < 60; k++) {
      while (next <= (r.now[0] as number)) {
        const tt = tick;
        r.snap(tt, (f) => fill(f, tt));
        tick++;
        next += TICK_MS;
      }
      r.frame(1000 / 144);
      largest = Math.max(largest, r.interp.offsetLength[4] as number);
    }
    // Some 68 u behind (more than cl_teleportDist), decayed over cl_remoteSmoothMs: no jump.
    expect(largest).toBeGreaterThan(r.settings.teleportDist);
    expect(r.interp.offsetLength[4]).toBe(0);
    expect(Math.abs((r.interp.view.x[4] as number) - r.render * v)).toBeLessThan(0.05);
    expect(r.meter.t[JM_VIOLATIONS]).toBe(0);
  });

  it("snaps a rejoin farther than cl_teleportDist that no speed explains", () => {
    const r = new Rig();
    r.settings.interpDelay = 2;
    const t = r.stream(1, 500, (f, tt) => put(f, tt, 4, { x: 0 }));
    for (let k = 0; k < 43; k++) r.frame(1000 / 144);
    expect(r.interp.mode[4]).toBe(REMOTE_HELD);
    // Back 300 u away, standing still, with the same teleport counter (no teleport said so), the
    // first sample already behind the render tick (no bracket across the gap to explain it).
    r.stream(t, 100, (f, tt) => put(f, tt, 4, { x: 300 }));
    expect(r.interp.offsetLength[4]).toBe(0);
    expect(r.interp.view.x[4]).toBeCloseTo(300, 6);
    // That jump is NET-05's: the meter counts it (and a bots run fails on it).
    expect(r.meter.t[JM_VIOLATIONS]).toBe(1);
  });

  it("carries a decaying rejoin offset into the next rejoin instead of snapping it", () => {
    // 760 u/s; the snapshots stop, and come back 100 ms later than before, each already behind
    // the render tick: every sample re-bases the slot while the last rejoin's offset still decays.
    const r = new Rig();
    r.settings.interpDelay = 3;
    const v = 760 / 60;
    const fill = (f: WorldFrame, tt: number) => put(f, tt, 4, { x: tt * v, vx: 760 });
    const last = r.stream(1, 500, fill) - 1;
    while (r.render - last < 8) r.frame(1000 / 144);
    expect(r.interp.mode[4]).toBe(REMOTE_HELD);
    // The first is 5 ticks (63 u) past the held place: within cl_teleportDist. Then one per tick:
    // 12.7 u more each, on an offset decayed by a sixth, which carried is past cl_teleportDist.
    let tick = last + 5;
    let next = r.now[0] as number;
    let largest = 0;
    for (let k = 0; k < 144; k++) {
      while (next <= (r.now[0] as number)) {
        const tt = tick;
        r.snap(tt, (f) => fill(f, tt));
        tick++;
        next += TICK_MS;
      }
      r.frame(1000 / 144);
      largest = Math.max(largest, r.interp.offsetLength[4] as number);
    }
    expect(largest).toBeGreaterThan(r.settings.teleportDist);
    expect(r.meter.t[JM_CHECKED]).toBeGreaterThan(100);
    expect(r.meter.t[JM_VIOLATIONS]).toBe(0);
  });

  it("clamps the extrapolation with a trace of the stance's hull, never into a wall", () => {
    const wall = buildBrush(boxPlanes([100, -512, -64], [164, 512, 256]));
    const world = createCollisionWorld([
      {
        planes: wall.planes,
        faceCount: wall.faceCount,
        bounds: wall.bounds,
        contents: CONTENTS_SOLID,
      },
    ]);
    const r = new Rig(world);
    r.settings.interpDelay = 2;
    // Running at the wall at 1200 u/s, stopping 1 u short of it (hull 15 u: x 84).
    r.stream(1, 1000, (f, tt) => put(f, tt, 7, { x: Math.min(84, tt * 20 - 700), vx: 1200 }));
    for (let k = 0; k < 20; k++) r.frame(1000 / 144);
    expect(r.interp.mode[7]).toBe(REMOTE_HELD);
    expect(r.interp.view.x[7]).toBeLessThanOrEqual(85);
    expect(r.interp.view.x[7]).toBeGreaterThanOrEqual(84);
  });

  it("hides a slot from its removal's tick, keeps pending slots, and shows a new one at its first stamp", () => {
    const r = new Rig();
    r.settings.interpDelay = 3;
    const v = r.interp.view;
    r.stream(1, 300, (f, tt) => put(f, tt, 9, { x: 1 }));
    let t = r.store.newestTick + 1;
    const removedAt = t;
    // Removed at `removedAt`; slot 10 appears there too.
    const seen: { rt: number; v9: number; v10: number }[] = [];
    for (let k = 0; k < 12; k++) {
      const tt = t;
      r.snap(tt, (f) => put(f, tt, 10, { x: 50 }));
      t++;
      r.frame(TICK_MS);
      seen.push({ rt: r.render, v9: v.visible[9] as number, v10: v.visible[10] as number });
    }
    for (const s of seen) {
      expect(s.v9, `slot 9 at ${s.rt}`).toBe(s.rt >= removedAt ? 0 : 1);
      expect(s.v10, `slot 10 at ${s.rt}`).toBe(s.rt >= removedAt ? 1 : 0);
    }
    expect(seen.some((s) => s.v9 === 1) && seen.some((s) => s.v9 === 0)).toBe(true);
    // A pending slot (present, no state) never hides what it showed.
    for (let k = 0; k < 10; k++) {
      const tt = t;
      r.snap(tt, (f) => f.setPresent(10, 0));
      t++;
      r.frame(TICK_MS);
      expect(v.visible[10]).toBe(1);
    }
  });

  it("surfaces a slot's new movement events, at most the 2 it carries, counting the lost", () => {
    const r = new Rig();
    r.settings.interpDelay = 2;
    const seqs = new Uint8Array(64);
    const kinds = new Uint8Array(128);
    const values = new Uint8Array(128);
    const fill = (f: WorldFrame, tt: number) => {
      put(f, tt, 8);
      f.eventSeq[8] = seqs[8] as number;
      f.evKind.set(kinds.subarray(16, 18), 16);
      f.evValue.set(values.subarray(16, 18), 16);
    };
    let t = r.stream(1, 200, fill);
    const add = (count: number) => {
      for (let i = 0; i < count; i++) {
        pushEntityEvent(seqs, kinds, values, 8, i % 2 === 0 ? PMEV_JUMP : PMEV_LAND, i);
      }
    };
    // One event, then three in one tick (the oldest lost), surfaced oldest first.
    add(1);
    t = r.stream(t, 100, fill);
    expect(r.events).toEqual([[8, PMEV_JUMP, 0]]);
    add(3);
    r.stream(t, 200, fill);
    expect(r.events).toEqual([
      [8, PMEV_JUMP, 0],
      [8, PMEV_LAND, 1],
      [8, PMEV_JUMP, 2],
    ]);
    expect(r.stats.totals[STAT_REMOTE_EVENTS]).toBe(3);
    expect(r.stats.totals[STAT_REMOTE_EVENTS_LOST]).toBe(1);
  });

  it("takes the crouch from a until the render tick reaches b", () => {
    const r = new Rig();
    r.settings.interpDelay = 2;
    const crouched = PMF_GROUNDED | PMF_CROUCHED;
    let t = r.stream(1, 400, (f, tt) => put(f, tt, 5, { flags: crouched }));
    expect(r.interp.view.crouched[5]).toBe(1);
    const standAt = t + 10;
    const seen: number[][] = [];
    for (let k = 0; k < 80; k++) {
      if (k % 2 === 0) {
        const tt = t++;
        r.snap(tt, (f) => put(f, tt, 5, { flags: tt >= standAt ? PMF_GROUNDED : crouched }));
      }
      r.frame(TICK_MS / 2);
      seen.push([r.render, r.interp.view.crouched[5] as number]);
    }
    for (const [rt, c] of seen) expect(c, `at ${rt}`).toBe((rt as number) < standAt ? 1 : 0);
    expect(seen.filter((x) => x[1] === 1 && (x[0] as number) > standAt - 1).length).toBeGreaterThan(
      0,
    );
  });

  it("does not draw a pending slot before its first sample, then shows it at that stamp", () => {
    const r = new Rig();
    r.settings.interpDelay = 3;
    const v = r.interp.view;
    let t = r.stream(1, 300, (f, tt) => put(f, tt, 9, { x: 1 }));
    // Slot 11 pending (present, no state yet) for 20 frames, then stamped from `first` on.
    const first = t + 20;
    const seen: number[][] = [];
    for (let k = 0; k < 40; k++) {
      const tt = t++;
      r.snap(tt, (f) => {
        put(f, tt, 9, { x: 1 });
        if (tt < first) f.setPresent(11, 0);
        else put(f, tt, 11, { x: 70 });
      });
      r.frame(TICK_MS);
      seen.push([r.render, v.visible[11] as number]);
    }
    for (const [rt, vis] of seen) expect(vis, `at ${rt}`).toBe((rt as number) >= first ? 1 : 0);
    expect(seen.some((x) => x[1] === 1)).toBe(true);
    expect(v.x[11]).toBeCloseTo(70, 6);
  });

  it("uses a fixed cl_interpDelay (clamped to 2–6) instead of the auto delay", () => {
    const r = new Rig();
    r.settings.interpDelay = 5;
    r.stream(1, 300, (f, tt) => put(f, tt, 1));
    expect(r.interp.delayTicks).toBe(5);
    r.settings.interpDelay = 1;
    r.frame(TICK_MS);
    expect(r.interp.delayTicks).toBe(2);
    r.settings.interpDelay = 0;
    r.frame(TICK_MS);
    expect(r.interp.delayTicks).toBe(r.interp.delay.ticks);
  });

  it("clears everything when the session ends", () => {
    const r = new Rig();
    r.stream(1, 300, (f, tt) => put(f, tt, 1, { flags: PMF_GROUNDED | PMF_CROUCHED }));
    expect(r.interp.view.crouched[1]).toBe(1);
    r.interp.clear();
    expect([r.interp.view.count, r.interp.view.visible[1]]).toEqual([0, 0]);
    expect(Number.isNaN(r.render)).toBe(true);
  });
});

describe("RemoteJumpMeter (NET-05's criterion, M3 design §2.8)", () => {
  it("allows a stair's step-up with no vertical velocity, through the bracket displacement", () => {
    const r = new Rig();
    r.settings.interpDelay = 2;
    // 300 u/s along x; every 4th tick a 16 u step up (vz 0, as pmove's step-up leaves it).
    r.stream(1, 1000, (f, tt) =>
      put(f, tt, 3, { x: tt * 5, vx: 300, z: 24 + Math.min(6, Math.floor(tt / 4)) * 16 }),
    );
    expect(r.meter.t[JM_VIOLATIONS]).toBe(0);
  });

  it("allows a step-up inside a bracket a long frame passes whole", () => {
    // A slow walker (60 u/s) stepping 16 u up within one tick, drawn at 30 ms frames (1.8 ticks):
    // some frames pass the step's whole bracket, which neither frame end lies in.
    const r = new Rig();
    r.settings.interpDelay = 3;
    let tick = 1;
    let next = 0;
    const z = (t: number) => 24 + Math.min(4, Math.max(0, Math.floor((t - 60) / 20))) * 16;
    for (let k = 0; k < 400; k++) {
      while (next <= (r.now[0] as number)) {
        const t = tick;
        r.snap(t, (f) => put(f, t, 3, { x: t, vx: 60, z: z(t) }));
        tick++;
        next += TICK_MS;
      }
      r.frame(30);
    }
    expect(r.meter.t[JM_CHECKED]).toBeGreaterThan(300);
    expect(r.meter.t[JM_VIOLATIONS]).toBe(0);
  });

  it("bounds the speed by the bracket's displacement: a 16 u step-up in one tick at 300 u/s", () => {
    const r = new Rig();
    r.settings.interpDelay = 2;
    let stepAt = 1000;
    const z = (tt: number) => 24 + (tt >= stepAt ? 16 : 0);
    let t = r.stream(1, 500, (f, tt) => put(f, tt, 3, { x: tt * 5, vx: 300, z: z(tt) }));
    stepAt = t + 6;
    expect(r.interp.speed[3]).toBeCloseTo(300, 6);
    // Frames a quarter tick apart through the step's bracket (stepAt − 1, stepAt].
    const inBracket: number[] = [];
    for (let k = 0; k < 80 && r.render < stepAt + 4; k++) {
      if (k % 4 === 0) {
        const tt = t++;
        r.snap(tt, (f) => put(f, tt, 3, { x: tt * 5, vx: 300, z: z(tt) }));
      }
      const before = r.render;
      r.frame(TICK_MS / 4);
      if (before > stepAt - 1 && r.render < stepAt) inBracket.push(r.interp.speed[3] as number);
    }
    // max(|v_a|, |v_b|, |b − a| / Δt) = |(5, 0, 16)| × 60 ≈ 1006 u/s, not more.
    expect(inBracket.length).toBeGreaterThan(1);
    for (const v of inBracket) expect(v).toBeCloseTo(Math.hypot(5, 16) * 60, 6);
    expect(r.meter.t[JM_VIOLATIONS]).toBe(0);
  });

  it("allows a step up to speed × dt × 1.5 + 0.5 u plus the rejoin offset's decay, no more", () => {
    const r = new Rig();
    r.settings.interpDelay = 2;
    // Standing at x 0 with a velocity of 300 u/s (the bound is the velocity's, the step ours).
    r.stream(1, 500, (f, tt) => put(f, tt, 3, { vx: 300 }));
    const dt = 1000 / 144;
    /** One more frame with the drawn origin moved `dx` from the last; its violations. */
    const judge = (dx: number): number => {
      const v = r.interp.view;
      const x0 = v.x[3] as number;
      r.now[0] = (r.now[0] as number) + dt;
      r.interp.update(SELF);
      v.x[3] = x0 + dx;
      r.meter.measure(r.interp, true);
      const violations = r.meter.t[JM_FRAME_VIOLATIONS] as number;
      // Forget the moved position: the next frame is not judged against it.
      r.meter.reset();
      r.frame(dt);
      return violations;
    };
    r.frame(dt);
    const allowed = 300 * (dt / 1000) * 1.5 + 0.5;
    expect(judge(allowed - 0.01)).toBe(0);
    expect(judge(allowed + 0.01)).toBe(1);
  });

  it("allows a rejoin's decay of offset × dt / cl_remoteSmoothMs on top, no more", () => {
    const r = new Rig();
    r.settings.interpDelay = 3;
    const v = 600 / 60;
    const fill = (f: WorldFrame, tt: number) => put(f, tt, 4, { x: tt * v, vx: 600 });
    const t = r.stream(1, 500, fill);
    for (let k = 0; k < 22; k++) r.frame(1000 / 144);
    // Snapshots back: run until a frame starts a rejoin offset.
    let tick = t + 9;
    let next = r.now[0] as number;
    const step = () => {
      while (next <= (r.now[0] as number) + 1000 / 144) {
        const tt = tick;
        r.snap(tt, (f) => fill(f, tt));
        tick++;
        next += TICK_MS;
      }
    };
    for (let k = 0; k < 40 && r.interp.offsetLength[4] === 0; k++) {
      step();
      r.frame(1000 / 144);
    }
    const offset = r.interp.offsetLength[4] as number;
    expect(offset).toBeGreaterThan(10);
    // The next frame, with its drawn origin placed at the allowance's edge from the last.
    const dt = 1000 / 144;
    const allowedAt = (): number[] => {
      const vw = r.interp.view;
      const p = [vw.x[4] as number, vw.y[4] as number, vw.z[4] as number];
      const pSpeed = r.interp.speed[4] as number;
      const pOffset = r.interp.offsetLength[4] as number;
      step();
      r.now[0] = (r.now[0] as number) + dt;
      r.interp.update(SELF);
      const allowed =
        Math.max(pSpeed, r.interp.speed[4] as number) * (dt / 1000) * 1.5 +
        0.5 +
        Math.max(pOffset, r.interp.offsetLength[4] as number) * (dt / r.settings.remoteSmoothMs);
      return [p[0] as number, p[1] as number, p[2] as number, allowed];
    };
    const place = (dx: number): number => {
      const [x, y, z, allowed] = allowedAt() as [number, number, number, number];
      const vw = r.interp.view;
      vw.x[4] = x + allowed + dx;
      vw.y[4] = y;
      vw.z[4] = z;
      r.meter.measure(r.interp, true);
      return r.meter.t[JM_FRAME_VIOLATIONS] as number;
    };
    // The meter's last position is the true drawn one: run one ordinary frame between.
    expect(place(-0.01)).toBe(0);
    r.meter.reset();
    step();
    r.frame(dt);
    expect(r.interp.offsetLength[4]).toBeGreaterThan(0);
    expect(place(0.01)).toBe(1);
  });

  it("counts a jump that no velocity explains", () => {
    const r = new Rig();
    r.settings.interpDelay = 2;
    let t = r.stream(1, 300, (f, tt) => put(f, tt, 3, { x: 0 }));
    // A 30 u move in one tick with zero velocity and the same counter: a violation… unless the
    // displacement term covers it (30 u per tick = 1800 u/s): it does, the step is continuous.
    t = r.stream(t, 300, (f, tt) => put(f, tt, 3, { x: tt === t ? 0 : 30 }));
    expect(r.meter.t[JM_VIOLATIONS]).toBe(0);
    // A drawn position moved by hand (a renderer reading raw snapshots would do this): caught.
    r.interp.view.x[3] = (r.interp.view.x[3] as number) + 40;
    r.meter.measure(r.interp, true);
    expect(r.meter.t[JM_VIOLATIONS]).toBe(1);
    // Not judged (a page's long frame): not counted.
    r.interp.view.x[3] = (r.interp.view.x[3] as number) + 40;
    r.meter.measure(r.interp, false);
    expect(r.meter.t[JM_VIOLATIONS]).toBe(1);
  });
});
