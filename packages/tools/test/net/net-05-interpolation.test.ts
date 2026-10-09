import { NeutralInput, RC_RENDER, REMOTE_INTERPOLATED } from "@game/client/net";
import type { PlayerState } from "@game/shared";
import { describe, expect, it } from "vitest";
import {
  expectSmooth,
  LEDGE_ORIGIN_Z,
  MOVER_SPEED,
  moverInput,
  moverTop,
  Outage,
  pair,
  profile,
  RemoteWatch,
} from "./interpolation";
import { MultiHarness } from "./multiHarness";

// NET-05 (docs/05 §14, M3 design §2.8 and §5, D-037): remote players' drawn paths are continuous.
// A mover strafe-jumps a route on arena_greybox that climbs the south ledge's 6 steps of 16 u, at
// up to 760 u/s, while an observer stands still; the observer's remote interpolation is sampled
// after each of its frames, as the page does, and every frame is checked (`RemoteWatch`):
// - the step criterion: each frame's step ≤ speed × dt × 1.5 + 0.5 u, with the bracket's
//   displacement in the speed (stairs) and the rejoin offset's decay after an outage;
// - the render rate within [0.9, 1.1] (down to 0.5 only while past the newest stored tick), no
//   render snap after the clock's placement, the delay within 2–6 ticks and never below its
//   formula (2 × the snapshot interval + the lateness p95, rounded up);
// - no remote drawn with its origin in solid; where the store holds both ticks around the render
//   time, the drawn origin and yaw are the server's path at that time (yaw along the short arc,
//   across 0/65535 too);
// - on wan-150-loss2, extrapolated + held remote-frames ≤ 2%.
// Then the cases: an RTT step on the observer's link (≤ 0.6 s extrapolated or held after it, its
// own clock steps leaving the remote continuous); a 150 ms snapshot outage started with the mover
// at 720 u/s or more, on wan-50 and wan-100-loss1 (at most 2 ticks of the newest sample's velocity
// past it, a hold, a rejoin within the allowance though it is past cl_teleportDist); a 250 ms
// server stall that drops ticks (the render clock's window restarts: ≤ 1 s extrapolated or held);
// a respawn and a same-slot reconnect (a snap keyed on the teleport counter, never a lerp across
// it).
// Tiers (D-032): this file runs wan-50, wan-100-loss1 and wan-150-loss2 at 144 Hz and the cases;
// `packages/tools/long/net-05-interpolation.long.ts` runs the rest of the matrix (bad-250-loss5,
// browser hitches and a slow host on every profile, a second seed), frames turning bad mid-run
// and 16 clients watching each other. The runs and checks are shared (`interpolation.ts`).

const RUN_MS = 15_000;
/** One server tick of harness time, ms. */
const TICK_MS_HARNESS = 1000 / 60;

/** The distance from `p` (x, y, z first) to the polyline through `path`'s points. */
function distanceToPath(p: readonly number[], path: readonly number[][]): number {
  let best = Number.POSITIVE_INFINITY;
  for (let i = 0; i + 1 < path.length; i++) {
    const a = path[i] as number[];
    const b = path[i + 1] as number[];
    let ab2 = 0;
    let dot = 0;
    for (let k = 0; k < 3; k++) {
      const d = (b[k] as number) - (a[k] as number);
      ab2 += d * d;
      dot += ((p[k] as number) - (a[k] as number)) * d;
    }
    const w = ab2 === 0 ? 0 : Math.min(1, Math.max(0, dot / ab2));
    let d2 = 0;
    for (let k = 0; k < 3; k++) {
      const q = (a[k] as number) + ((b[k] as number) - (a[k] as number)) * w;
      d2 += ((p[k] as number) - q) ** 2;
    }
    best = Math.min(best, Math.sqrt(d2));
  }
  return best;
}

describe("NET-05: remote interpolation is continuous", () => {
  it.each(["wan-50", "wan-100-loss1", "wan-150-loss2"])(
    "%s, 144 Hz: a stairs-climbing strafe-jumper is drawn smoothly",
    (name) => {
      const r = pair({ profile: name });
      r.h.run(RUN_MS);
      console.log(r.watch.summary(`NET-05 ${name} 144 Hz`));
      expectSmooth(r.watch);
      // The route climbed onto the ledge, and the strafe-jumping reached its speed.
      expect(moverTop(r.mover)).toBeGreaterThan(LEDGE_ORIGIN_Z - 1);
      expect(r.watch.truthChecked).toBeGreaterThan(r.watch.frames / 2);
      expect(r.watch.yawWraps).toBeGreaterThan(0);
      if (name === "wan-150-loss2") expect(r.watch.heldShare).toBeLessThanOrEqual(0.02);
      // Nobody is ever left out at 2 players: the delay carries no defer lag (D-046).
      expect(r.watch.maxDeferLag).toBe(0);
    },
  );

  it("an RTT step up on the observer's link: ≤ 0.6 s extrapolated or held, its clock steps unseen", () => {
    const r = pair({ profile: "wan-50", seed: 2 });
    r.h.run(8000);
    const steps = r.watch.clockSteps;
    r.watch.heldSince = r.h.now;
    r.observer.sim?.setProfile(profile("wan-150-loss2"));
    r.h.run(8000);
    console.log(
      `${r.watch.summary("NET-05 RTT step 50 → 150 ms")}, after it ${r.watch.heldMsAfter.toFixed(0)} ms`,
    );
    expectSmooth(r.watch);
    expect(r.watch.heldMsAfter).toBeLessThanOrEqual(600);
    // The observer's own prediction clock stepped for the new round trip; the remote didn't jump.
    expect(r.watch.clockSteps - steps).toBeGreaterThanOrEqual(1);
  });

  it.each(["wan-50", "wan-100-loss1"])(
    "%s: a 150 ms snapshot outage at top speed: ≤ 2 ticks extrapolated, held, a smooth rejoin",
    (name) => {
      let from = Number.POSITIVE_INFINITY;
      let h: MultiHarness | null = null;
      const down = () => h !== null && h.now >= from && h.now < from + 150;
      const r = pair({ profile: name, observerWrap: (t) => new Outage(t, down) });
      h = r.h;
      r.h.run(3000);
      // The outage starts once the mover's server state is at the route's top speed.
      const fast = () => {
        let last: PlayerState | undefined;
        for (const st of r.mover.server.values()) last = st;
        return last === undefined ? 0 : Math.hypot(last.velocity[0], last.velocity[1]);
      };
      for (let k = 0; k < 2000 && fast() < 720; k++) r.h.run(TICK_MS_HARNESS);
      expect(fast()).toBeGreaterThanOrEqual(720);
      // Of the frames past the newest stored tick: how far the drawn mover got from the newest
      // sample beyond its velocity's 2 ticks (the trace clamp only shortens it), and the speeds.
      let beyond = Number.NEGATIVE_INFINITY;
      let pastFrames = 0;
      let slowest = Number.POSITIVE_INFINITY;
      const c = r.observer.client;
      const slot = r.mover.session?.clientId ?? -1;
      const watch = r.watch;
      const sample = watch.sample.bind(watch);
      watch.sample = () => {
        sample();
        const newest = c.store.newest;
        const v = c.remotes.view;
        const render = c.remotes.clock.t[RC_RENDER] as number;
        if (newest === null || v.visible[slot] !== 1 || render <= c.store.newestTick) return;
        if (c.remotes.offsetLength[slot] !== 0) return;
        const speed = Math.hypot(newest.entVelX[slot] as number, newest.entVelY[slot] as number);
        slowest = Math.min(slowest, speed);
        const dx = (v.x[slot] as number) - (newest.originX[slot] as number) / 32;
        const dy = (v.y[slot] as number) - (newest.originY[slot] as number) / 32;
        beyond = Math.max(beyond, Math.hypot(dx, dy) - (speed * 2) / 60);
        pastFrames++;
      };
      from = r.h.now;
      const extrapolated = watch.extrapolated;
      const held = watch.held;
      r.h.run(3000);
      console.log(
        `${watch.summary(`NET-05 ${name} 150 ms outage at top speed`)}, ${pastFrames} frames ` +
          `past the newest at ≥ ${slowest.toFixed(0)} u/s, at most ${beyond.toFixed(2)} u beyond ` +
          "2 ticks of velocity",
      );
      expectSmooth(watch);
      expect(watch.extrapolated - extrapolated).toBeGreaterThan(0);
      expect(watch.held - held).toBeGreaterThan(0);
      // At speed all through, and never further than 2 ticks of it (1 u/s velocity rounding).
      expect(pastFrames).toBeGreaterThan(5);
      expect(slowest).toBeGreaterThan(400);
      expect(beyond).toBeLessThanOrEqual(0.1);
    },
  );

  it("a 250 ms server stall that drops ticks: remotes interpolated again within 1 s", () => {
    const r = pair({ profile: "wan-50", seed: 5 });
    r.h.run(6000);
    const ticks = r.h.match.serverTick;
    r.watch.heldSince = r.h.now;
    r.h.stallServer(250);
    r.h.run(4000);
    // 15 ticks were due in the stall; the loop ran at most 5 of them late and dropped the rest.
    expect(r.h.match.serverTick - ticks).toBeLessThan(240 - 5);
    console.log(
      `${r.watch.summary("NET-05 250 ms server stall")}, after it ` +
        `${r.watch.heldMsAfter.toFixed(0)} ms, window restarts ` +
        `${r.observer.client.remotes.clock.rebases}`,
    );
    expectSmooth(r.watch);
    expect(r.watch.heldMsAfter).toBeLessThanOrEqual(1000);
  });

  it("a respawn snaps the remote to its spawn point, never lerping across", () => {
    const r = pair({ profile: "wan-100-loss1", seed: 3 });
    r.h.run(6000);
    const slot = r.mover.session?.clientId ?? -1;
    const c = r.observer.client;
    const xs: number[][] = [];
    const watch = r.watch;
    const sample = watch.sample.bind(watch);
    watch.sample = () => {
      sample();
      const v = c.remotes.view;
      xs.push([
        v.x[slot] as number,
        v.y[slot] as number,
        v.z[slot] as number,
        v.teleported[slot] as number,
        c.remotes.clock.t[RC_RENDER] as number,
        c.remotes.mode[slot] === REMOTE_INTERPOLATED && c.remotes.offsetLength[slot] === 0 ? 1 : 0,
      ]);
    };
    const marks = watch.teleports[slot] as number;
    const session = r.mover.session;
    if (session === null) throw new Error("no mover session");
    r.h.match.respawn(session);
    const respawnTick = r.h.match.serverTick + 1;
    r.h.run(2000);
    expectSmooth(watch);
    expect(watch.teleports[slot]).toBe(marks + 1);
    const spawn = r.mover.server.get(respawnTick)?.origin;
    if (spawn === undefined) throw new Error("no state of the respawn tick");
    const at = xs.findIndex((p) => p[3] === 1);
    expect(at).toBeGreaterThan(0);
    // Before the mark: render time short of the respawn, far from the spawn point, and every
    // interpolated frame on the server's path before the respawn (within quantization), so
    // nothing is drawn between the old path and the spawn.
    const path: number[][] = [];
    for (let t = respawnTick - 240; t < respawnTick; t++) {
      const st = r.mover.server.get(t);
      if (st !== undefined) path.push([st.origin[0], st.origin[1], st.origin[2]]);
    }
    let onPath = 0;
    for (const p of xs.slice(0, at)) {
      expect(p[4] as number).toBeLessThan(respawnTick);
      expect(Math.hypot((p[0] as number) - spawn[0], (p[1] as number) - spawn[1])).toBeGreaterThan(
        100,
      );
      if (p[5] === 1) {
        expect(distanceToPath(p, path)).toBeLessThan(0.1);
        onPath++;
      }
    }
    expect(onPath).toBeGreaterThan(5);
    const mark = xs[at] as number[];
    expect(Math.hypot((mark[0] as number) - spawn[0], (mark[1] as number) - spawn[1])).toBeLessThan(
      MOVER_SPEED / 60 + 1,
    );
  });

  it("a same-slot reconnect hides the old player, then snaps the new one in", () => {
    const h = new MultiHarness({ map: "arena_greybox", seed: 4 });
    let mover = h.addClient({
      input: moverInput(4),
      profile: profile("wan-100-loss1"),
      record: true,
    });
    let watch: RemoteWatch | null = null;
    const observer = h.addClient({
      input: new NeutralInput(),
      profile: profile("wan-100-loss1"),
      onFrame: () => watch?.sample(),
    });
    const hidden: number[] = [];
    watch = new RemoteWatch(
      observer.client,
      observer.client.world,
      (s) => (s === mover.session?.clientId ? mover.server : null),
      () => h.now,
    );
    const w = watch;
    const sample = w.sample.bind(w);
    w.sample = () => {
      sample();
      hidden.push(observer.client.remotes.view.visible[0] === 1 ? 0 : 1);
    };
    h.run(5000);
    expect(mover.session?.clientId).toBe(0);
    mover.leave();
    h.runUntil(() => h.match.session(0) === undefined, 3000, "leave");
    const gapFrom = hidden.length;
    mover = h.addClient({ input: moverInput(5), profile: profile("wan-100-loss1"), record: true });
    expect(mover.session?.clientId).toBe(0);
    h.run(3000);
    expectSmooth(w);
    // Appeared, hidden while the slot was empty, back with a snap (a new teleport counter).
    expect(w.teleports[0]).toBe(2);
    expect(hidden.slice(gapFrom - 30).some((x) => x === 1)).toBe(true);
    expect(hidden.at(-1)).toBe(0);
  });
});
