import { PerformanceObserver } from "node:perf_hooks";
import {
  boxPlanes,
  buildBrush,
  CONTENTS_SOLID,
  type CollisionBrushSource,
  createCollisionWorld,
  HULL_MINS,
  HULL_STANDING_MAXS,
  MASK_PLAYERSOLID,
  Mulberry32,
  PlayerState,
  quantizePlayerState,
  rotatedBoxPlanes,
  snapOrigin,
  TraceResult,
  traceBox,
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

const workload = process.argv[2];
const run = workload === "quantize" ? runQuantize : workload === "snap" ? runSnap : undefined;
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
