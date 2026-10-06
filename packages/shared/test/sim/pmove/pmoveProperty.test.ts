import { describe, expect, it } from "vitest";
import { Mulberry32 } from "../../../src/rng/mulberry32";
import { PMEV_JUMP, PMEV_STEP, PmoveEvent, PmoveEvents } from "../../../src/sim/events";
import { HULL_CROUCHED_MAXS, HULL_MINS, HULL_STANDING_MAXS } from "../../../src/sim/hull";
import { PlayerState, PMF_CROUCHED, PMF_GROUNDED } from "../../../src/sim/playerState";
import { PmoveTraceLog } from "../../../src/sim/pmove/debug";
import { PmoveParams } from "../../../src/sim/pmove/params";
import { lastPmoveSnap, pmove } from "../../../src/sim/pmove/pmove";
import { ground } from "../../../src/sim/pmove/scratch";
import { BUTTON_CROUCH, BUTTON_JUMP, BUTTON_WALK, UserCmd } from "../../../src/sim/usercmd";
import { TICK_DT } from "../../../src/time";
import { MASK_PLAYERSOLID } from "../../../src/world/contents";
import { rotatedBoxPlanes, wedgePlanes } from "../../../src/world/shapes";
import { positionTest, SNAP_CORNER, SNAP_PREVIOUS, SNAP_ROUNDED } from "../../../src/world/trace";
import { box, floorBrush, horizontalSpeed, restZ } from "../../helpers/pmoveWorld";
import { brush, worldOf } from "../../helpers/traceWorld";

// M2 design §5 and §7 risk 1 (D-017: tangency is not exact on angled planes): seeded random input
// for 1e4 ticks over slopes either side of the walkable limit, rotated walls and steps. pmove must
// keep the player out of solid every tick, and never fall back to the previous origin twice in a
// row, which would mean it froze in place. A grounded tick on flat ground must not gain more speed
// than the ground acceleration allows: a landing or a step must not turn fall speed into speed.

const SQRT2 = Math.sqrt(2);
const SQRT3 = Math.sqrt(3);
const SQRT6 = Math.sqrt(6);

/** A wedge of normal z `nz` rising toward `rise`, `run` u long, inside [x0, y0] + the run. */
function slope(x0: number, y0: number, nz: number, rise: "+x" | "-x" | "+y" | "-y", run = 256) {
  const h = (run * Math.sqrt(1 - nz * nz)) / nz;
  const alongX = rise === "+x" || rise === "-x";
  return brush(
    wedgePlanes([x0, y0, 0], [x0 + (alongX ? run : 192), y0 + (alongX ? 192 : run), h], rise),
  );
}

function rotated(x: number, y: number, cos: number, sin: number, hx = 96, hy = 12, hz = 96) {
  return brush(rotatedBoxPlanes([x, y, hz], [hx, hy, hz], cos, sin));
}

const world = worldOf(
  floorBrush(1024),
  // The room: 768 u in every direction from the middle, walls 256 u tall.
  box([-800, -800, 0], [-768, 800, 256]),
  box([768, -800, 0], [800, 800, 256]),
  box([-800, -800, 0], [800, -768, 256]),
  box([-800, 768, 0], [800, 800, 256]),
  // Slopes around the walkable limit (docs/03 §2.1 pm_minWalkNormal 0.7), facing every way.
  slope(-700, 200, 0.69, "+y"),
  slope(-450, 200, 0.71, "+y"),
  slope(-200, 300, 0.8, "-x"),
  slope(300, -700, 0.71, "-y"),
  slope(450, 100, 0.69, "+x", 300),
  slope(-700, -700, 0.8, "+x"),
  // Rotated walls at 15°, 30°, 45° and 60°.
  rotated(-100, -300, (SQRT6 + SQRT2) / 4, (SQRT6 - SQRT2) / 4),
  rotated(200, -250, SQRT3 / 2, 0.5),
  rotated(150, 350, SQRT2 / 2, SQRT2 / 2),
  rotated(-350, -100, 0.5, SQRT3 / 2),
  rotated(520, 520, SQRT3 / 2, -0.5, 160),
  // Steps of 16, 18 and 19 u, stairs of 16 u, curbs, and a 50 u ceiling only a crouched hull
  // fits under.
  box([-150, 600, 0], [-50, 760, 16]),
  box([-50, 600, 0], [50, 760, 18]),
  box([50, 600, 0], [150, 760, 19]),
  box([60, -120, 0], [360, 120, 16]),
  box([92, -120, 16], [360, 120, 32]),
  box([124, -120, 32], [360, 120, 48]),
  box([156, -120, 48], [360, 120, 64]),
  box([-300, 380, 0], [-220, 460, 8]),
  box([-560, -160, 0], [-480, -80, 12]),
  box([380, -560, 0], [460, -480, 18]),
  box([-600, -450, 50], [-450, -250, 90]),
);

/** Teleport targets: clear standing spots on the floor. */
const SPAWNS: readonly (readonly [number, number])[] = [
  [0, 0],
  [-600, 0],
  [600, -400],
  [0, 540],
  [-400, -600],
  [400, 300],
];

describe("pmove random-input property (M2 design §5)", () => {
  it("stays out of solid for 1e4 seeded ticks and never repeats the previous-origin fallback", () => {
    const rng = new Mulberry32(0x5eed_0003);
    const ps = new PlayerState();
    const c = new UserCmd();
    const p = new PmoveParams();
    const ev = new PmoveEvents();
    const e = new PmoveEvent();
    const log = new PmoveTraceLog();
    const snaps = [0, 0, 0];
    let jumps = 0;
    let steps = 0;
    let grounded = 0;
    let previousStreak = 0;
    let worstStreak = 0;
    let solidTicks = 0;
    let crouched = 0;
    let speedups = 0;
    let flatChecks = 0;
    let yawRate = 0;
    let hold = 0;
    for (let t = 0; t < 10_000; t++) {
      if (t % 1000 === 0) {
        const s = SPAWNS[(t / 1000) % SPAWNS.length] as readonly [number, number];
        ps.origin.set([s[0], s[1], restZ(0)]);
        ps.velocity.fill(0);
        ps.flags = PMF_GROUNDED;
      }
      if (hold-- <= 0) {
        // Sticky input: a new choice every 5–60 ticks.
        hold = 5 + rng.nextInt(56);
        const axis = () => [0, 127, -127, rng.nextInt(255) - 127][rng.nextInt(4)] as number;
        c.forward = axis();
        c.right = axis();
        c.buttons =
          (rng.nextFloat() < 0.35 ? BUTTON_JUMP : 0) |
          (rng.nextFloat() < 0.15 ? BUTTON_WALK : 0) |
          (rng.nextFloat() < 0.2 ? BUTTON_CROUCH : 0);
        yawRate = rng.nextInt(1201) - 600;
        c.pitch = (rng.nextInt(32402) - 16201) & 0xffff;
      }
      c.yaw = (c.yaw + yawRate) & 0xffff;
      c.tick = t;
      const before = horizontalSpeed(ps.velocity);
      pmove(ps, c, world, p, TICK_DT, ev, (t & 7) === 0 ? log : null);
      const maxs = (ps.flags & PMF_CROUCHED) !== 0 ? HULL_CROUCHED_MAXS : HULL_STANDING_MAXS;
      if (!positionTest(world, ps.origin, HULL_MINS, maxs, MASK_PLAYERSOLID)) solidTicks++;
      if ((ps.flags & PMF_CROUCHED) !== 0) crouched++;
      const snap = lastPmoveSnap();
      snaps[snap] = (snaps[snap] as number) + 1;
      previousStreak = snap === SNAP_PREVIOUS ? previousStreak + 1 : 0;
      worstStreak = Math.max(worstStreak, previousStreak);
      let jumped = false;
      for (let i = 0; i < ev.count; i++) {
        ev.read(i, e);
        if (e.type === PMEV_JUMP) jumped = true;
        if (e.type === PMEV_STEP) steps++;
      }
      if (jumped) jumps++;
      if ((ps.flags & PMF_GROUNDED) !== 0) {
        grounded++;
        if (!jumped && ground.normal[2] === 1) {
          flatChecks++;
          const after = horizontalSpeed(ps.velocity);
          // Turning on the ground may add a little speed (docs/03 §4.3 caps only the component
          // along the wish), never more than one tick of ground acceleration.
          const gain = after - Math.max(before, p.runSpeed);
          if (gain > p.accelerate * p.runSpeed * TICK_DT || (before <= p.runSpeed && gain > 32)) {
            speedups++;
          }
        }
      }
      ev.clear();
    }
    expect(solidTicks).toBe(0);
    expect(worstStreak).toBeLessThanOrEqual(1);
    expect(speedups).toBe(0);
    // The fallback is a last resort the run is not expected to need at all.
    expect(snaps[SNAP_PREVIOUS]).toBe(0);
    // The run covered the ground it was built for. The floors sit well under the seeded run's
    // tallies, so a correct physics change that moves the trajectory does not trip them.
    expect(jumps).toBeGreaterThan(25);
    expect(steps).toBeGreaterThan(0);
    expect(flatChecks).toBeGreaterThan(2000);
    expect(grounded).toBeGreaterThan(3000);
    // Crouch comes from BUTTON_CROUCH through the crouch pre-check, stand-ups included.
    expect(crouched).toBeGreaterThan(1000);
    expect(grounded).toBeLessThan(9500);
    expect(snaps[SNAP_ROUNDED]).toBeGreaterThan(5000);
    expect(snaps[SNAP_CORNER]).toBeGreaterThan(0);
  });
});
