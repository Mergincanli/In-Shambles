import { PerformanceObserver } from "node:perf_hooks";
import {
  ACCEL_AIR,
  ACCEL_GROUND,
  accelerate,
  applyFriction,
  BUTTON_JUMP,
  BUTTON_WALK,
  boxContents,
  boxPlanes,
  buildBrush,
  CONTENTS_SOLID,
  type CollisionBrushSource,
  CvarRegistry,
  clipVelocity,
  cmdScale,
  copyPlayerState,
  createCollisionWorld,
  HULL_CROUCHED_MAXS,
  HULL_MINS,
  HULL_STANDING_MAXS,
  MASK_PLAYERSOLID,
  Mulberry32,
  PlayerState,
  PlayerStateRing,
  PMEV_LAND,
  PMEV_STEP,
  PMF_CROUCHED,
  PMF_GROUNDED,
  PMOVE_CVARS,
  PmoveEvent,
  PmoveEvents,
  PmoveParams,
  PmoveTraceLog,
  playerStateEquals,
  pmove,
  pointContents,
  positionContents,
  positionTest,
  quantizePlayerState,
  refreshPmoveParams,
  registerPmoveCvars,
  rotatedBoxPlanes,
  sanitizeUserCmd,
  snapOrigin,
  TICK_DT,
  TraceResult,
  traceBox,
  traceRay,
  UserCmd,
  type Vec3,
  vec3,
  wedgePlanes,
} from "@game/shared";

// Child process for native-esm-allocation.test.ts: `node --import tsx` loads shared as native ES
// modules, as dev:server and bench do. There V8 boxes doubles that the Vitest module runner and
// the bundle keep unboxed, so the in-process allocation test cannot see it. Prints one JSON line.

const CALLS = 200_000;
const CASES = 1024;

function solid(planes: Float64Array): CollisionBrushSource {
  const b = buildBrush(planes);
  return { planes: b.planes, faceCount: b.faceCount, bounds: b.bounds, contents: CONTENTS_SOLID };
}

const world = createCollisionWorld([
  solid(boxPlanes([-512, -512, -64], [512, 512, 0])),
  solid(wedgePlanes([0, -256, 0], [256, 256, 96], "+x")),
  solid(rotatedBoxPlanes([-200, 0, 48], [64, 12, 48], 0.6, 0.8)),
]);

const rng = new Mulberry32(0x5eed);
const exact: Vec3[] = [];
const ps = new PlayerState();
const tr = new TraceResult();
const from = vec3();
const to = vec3();
for (let i = 0; i < CASES; i++) {
  const x = rng.nextFloat() * 600 - 300;
  const y = rng.nextFloat() * 400 - 200;
  if (i % 4 === 3) {
    // Inside the floor: every corner is solid, so the snap falls back to the previous origin.
    exact.push(vec3(x, y, rng.nextFloat() * 20));
  } else {
    // Dropped onto the floor, the slope or the rotated box: a stop in the ε skin.
    from[0] = x;
    from[1] = y;
    from[2] = 200;
    to[0] = x + rng.nextFloat() * 40 - 20;
    to[1] = y;
    to[2] = -100;
    traceBox(world, from, to, HULL_MINS, HULL_STANDING_MAXS, MASK_PLAYERSOLID, tr);
    // Every other stop is pushed a little into the surface, so on the slope and the rotated box
    // the rounded point is solid and a corner of its grid cell is not.
    const sink = (i & 1) === 0 ? 0 : rng.nextFloat() * 0.04;
    exact.push(vec3(tr.endpos[0], tr.endpos[1], tr.endpos[2] - sink));
  }
}
const prev = vec3(0, 400, 24);
const out = vec3();
const outcomes = new Int32Array(3);

function runQuantize(n: number): void {
  const o = ps.origin;
  const v = ps.velocity;
  for (let i = 0; i < n; i++) {
    const e = exact[i & (CASES - 1)] as Vec3;
    o[0] = e[0];
    o[1] = e[1];
    o[2] = e[2];
    v[0] = e[1] * 3.3;
    v[1] = -e[0] * 1.7;
    v[2] = e[2] * 0.1;
    ps.viewYaw = i;
    ps.stamina = i & 4095;
    quantizePlayerState(ps);
  }
}

function runSnap(n: number): void {
  for (let i = 0; i < n; i++) {
    const e = exact[i & (CASES - 1)] as Vec3;
    const r = snapOrigin(world, e, HULL_MINS, HULL_STANDING_MAXS, MASK_PLAYERSOLID, prev, out);
    outcomes[r] = (outcomes[r] as number) + 1;
  }
}

const ring = new PlayerStateRing();
const ps2 = new PlayerState();
const cmd = new UserCmd();

/** Ring write/read (copy), the prediction compare and a cmd sanitize. */
function runState(n: number): void {
  for (let i = 0; i < n; i++) {
    const e = exact[i & (CASES - 1)] as Vec3;
    ps.origin[0] = e[0];
    ps.stamina = i & 4095;
    ring.write(i, ps);
    if (ring.has(i - 1) && ring.read(i - 1, ps2) && !playerStateEquals(ps, ps2)) {
      outcomes[0] = (outcomes[0] as number) + 1;
    }
    copyPlayerState(ps2, ps);
    if (playerStateEquals(ps, ps2)) outcomes[1] = (outcomes[1] as number) + 1;
    // Out-of-range integers, as a wire decoder hands them over.
    cmd.tick = i;
    cmd.buttons = i;
    cmd.forward = (i & 511) - 256;
    cmd.right = (i & 255) - 300;
    cmd.up = i & 127;
    cmd.yaw = i * 7;
    cmd.pitch = (i * 13) & 0x1ffff;
    cmd.weaponSlot = (i & 15) - 4;
    sanitizeUserCmd(cmd);
    outcomes[2] = (outcomes[2] as number) + (cmd.forward & 1);
  }
}

const lo = vec3();
const hi = vec3();

/** The BVH query mix of trace-allocation.test.ts, here as native ESM. */
function runTrace(n: number): void {
  for (let i = 0; i < n; i++) {
    const e = exact[i & (CASES - 1)] as Vec3;
    const s = exact[(i + 1) & (CASES - 1)] as Vec3;
    switch (i % 5) {
      case 0:
        traceBox(world, s, e, HULL_MINS, HULL_CROUCHED_MAXS, MASK_PLAYERSOLID, tr);
        if (tr.fraction < 1) outcomes[0] = (outcomes[0] as number) + 1;
        break;
      case 1:
        traceRay(world, s, e, -1, tr);
        if (tr.fraction < 1) outcomes[0] = (outcomes[0] as number) + 1;
        break;
      case 2:
        if (!positionTest(world, e, HULL_MINS, HULL_STANDING_MAXS, MASK_PLAYERSOLID)) {
          outcomes[1] = (outcomes[1] as number) + 1;
        }
        outcomes[1] =
          (outcomes[1] as number) +
          (positionContents(world, s, HULL_MINS, HULL_CROUCHED_MAXS, -1) & 1);
        break;
      case 3:
        outcomes[2] = (outcomes[2] as number) + (pointContents(world, e) & 1);
        break;
      default:
        lo[0] = e[0] - 16;
        lo[1] = e[1] - 16;
        lo[2] = e[2] - 64;
        hi[0] = e[0] + 16;
        hi[1] = e[1] + 16;
        hi[2] = e[2];
        outcomes[2] = (outcomes[2] as number) + (boxContents(world, lo, hi) & 1);
    }
  }
}

const cvars = new CvarRegistry();
registerPmoveCvars(cvars);
// Non-integer values: a double store that boxes shows up here, a small integer would not.
for (let i = 0; i < PMOVE_CVARS.length; i++) {
  const r = PMOVE_CVARS[i] as (typeof PMOVE_CVARS)[number];
  if (r.type === "float") cvars.set(r.name, r.min + (r.max - r.min) * 0.37);
}
const params = new PmoveParams();
const vel = vec3();
const wish = vec3();
const normal = vec3(0.6, 0, 0.8);

/** A forced refresh every 16 calls, the unchanged check on the rest, and the docs/03 §4 steps. */
function runPmoveBasics(n: number): void {
  for (let i = 0; i < n; i++) {
    const e = exact[i & (CASES - 1)] as Vec3;
    if ((i & 15) === 0) params.version = -1;
    if (refreshPmoveParams(cvars, params)) outcomes[0] = (outcomes[0] as number) + 1;
    cmd.forward = (i & 255) - 128;
    cmd.right = ((i * 7) & 255) - 128;
    cmd.buttons = i & BUTTON_WALK;
    cmdScale(wish, cmd, 0, (i & 2) !== 0, params);
    vel[0] = e[0];
    vel[1] = e[1];
    vel[2] = e[2] - 50;
    accelerate(vel, wish, (i & 4) === 0 ? ACCEL_GROUND : ACCEL_AIR, params, 1 / 60);
    applyFriction(vel, (i & 1) === 0, params, 1 / 60);
    clipVelocity(vel, vel, normal, params);
    if (vel[2] + wish[0] > 0) outcomes[1] = (outcomes[1] as number) + 1;
    else outcomes[2] = (outcomes[2] as number) + 1;
  }
}

// A walled room with a slope, a rotated wall, an 18 u step and a 16 u step, for the whole tick.
const room = createCollisionWorld([
  solid(boxPlanes([-512, -512, -64], [512, 512, 0])),
  solid(boxPlanes([-544, -544, 0], [-512, 544, 256])),
  solid(boxPlanes([512, -544, 0], [544, 544, 256])),
  solid(boxPlanes([-544, -544, 0], [544, -512, 256])),
  solid(boxPlanes([-544, 512, 0], [544, 544, 256])),
  solid(wedgePlanes([0, -256, 0], [256, 0, 200], "+x")),
  solid(rotatedBoxPlanes([-200, 200, 48], [96, 12, 48], 0.6, 0.8)),
  solid(boxPlanes([100, 150, 0], [300, 350, 18])),
  solid(boxPlanes([-350, -350, 0], [-150, -150, 16])),
]);
const pps = new PlayerState();
const pcmd = new UserCmd();
const events = new PmoveEvents();
const traceLog = new PmoveTraceLog();
// Refreshed from a registry with fractional values, as the game does: the fields then hold
// doubles, which V8 represents differently from the integer defaults.
const pmoveCvars = new CvarRegistry();
registerPmoveCvars(pmoveCvars);
pmoveCvars.set("pm_gravity", 799.5);
pmoveCvars.set("pm_runSpeed", 320.25);
pmoveCvars.set("pm_accelerate", 10.5);
pmoveCvars.set("pm_stepSize", 18.5);
const pmoveParams = new PmoveParams();
refreshPmoveParams(pmoveCvars, pmoveParams);
const eventOut = new PmoveEvent();

/**
 * Whole pmove ticks: walk, strafe, jump, walk-modifier and crouched-hull input over slopes,
 * steps and walls, with the events ring and (every other tick) the trace log attached.
 */
function runPmove(n: number): void {
  for (let i = 0; i < n; i++) {
    if ((i & 511) === 0) {
      pps.origin[0] = ((i >> 9) & 7) * 40 - 140;
      pps.origin[1] = 100;
      pps.origin[2] = 24;
      pps.velocity[0] = 0;
      pps.velocity[1] = 0;
      pps.velocity[2] = 0;
      pps.flags = PMF_GROUNDED;
    }
    pcmd.forward = (i & 64) === 0 ? 127 : -90;
    pcmd.right = ((i >> 5) & 3) * 60 - 90;
    pcmd.buttons = ((i & 31) === 0 ? BUTTON_JUMP : 0) | ((i & 256) !== 0 ? BUTTON_WALK : 0);
    pcmd.yaw = (i * 97) & 0xffff;
    pcmd.pitch = (i * 31) & 0x3fff;
    if ((i & 1023) === 512) pps.flags |= PMF_CROUCHED;
    if ((i & 1023) === 0) pps.flags &= ~PMF_CROUCHED;
    pmove(pps, pcmd, room, pmoveParams, TICK_DT, events, (i & 1) === 0 ? traceLog : null);
    if ((pps.flags & PMF_GROUNDED) !== 0) outcomes[0] = (outcomes[0] as number) + 1;
    else outcomes[1] = (outcomes[1] as number) + 1;
    for (let k = 0; k < events.count; k++) {
      events.read(k, eventOut);
      if (eventOut.type === PMEV_STEP || eventOut.type === PMEV_LAND) {
        outcomes[2] = (outcomes[2] as number) + 1;
      }
    }
    events.clear();
    if ((i & 63) === 0) traceLog.clear();
  }
}

const WORKLOADS: Record<string, (n: number) => void> = {
  pmove: runPmove,
  pmoveBasics: runPmoveBasics,
  quantize: runQuantize,
  snap: runSnap,
  state: runState,
  trace: runTrace,
};
const workload = process.argv[2];
const run = workload === undefined ? undefined : WORKLOADS[workload];
if (run === undefined) throw new Error(`unknown workload ${String(workload)}`);

let gcs = 0;
const observer = new PerformanceObserver((list) => {
  gcs += list.getEntries().length;
});
observer.observe({ entryTypes: ["gc"] });
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));
run(CALLS);
const attempts: string[] = [];
let clean = false;
// As in trace-allocation.test.ts: a stray GC can land in one attempt, per-call garbage in all.
for (let attempt = 0; attempt < 3 && !clean; attempt++) {
  await settle();
  gcs = 0;
  const before = process.memoryUsage().heapUsed;
  run(CALLS);
  const growth = process.memoryUsage().heapUsed - before;
  await settle();
  attempts.push(`${gcs} GCs, heap ${growth >= 0 ? "+" : ""}${growth} B`);
  clean = gcs === 0 && growth < 64 * 1024;
}
observer.disconnect();
console.log(JSON.stringify({ clean, attempts, outcomes: Array.from(outcomes) }));
