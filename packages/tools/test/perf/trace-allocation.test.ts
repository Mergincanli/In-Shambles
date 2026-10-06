import { PerformanceObserver } from "node:perf_hooks";
import {
  boxContents,
  boxPlanes,
  buildBrush,
  CONTENTS_SOLID,
  CONTENTS_WATER,
  type CollisionBrushSource,
  type CollisionWorld,
  createCollisionWorld,
  HULL_CROUCHED_MAXS,
  HULL_MINS,
  HULL_STANDING_MAXS,
  MASK_PLAYERSOLID,
  Mulberry32,
  pointContents,
  positionContents,
  positionTest,
  rotatedBoxPlanes,
  TraceResult,
  traceBox,
  traceRay,
  type Vec3,
  vec3,
  wedgePlanes,
} from "@game/shared";
import { describe, expect, it } from "vitest";

// M1 design C and docs/10 budgets: BVH queries run every tick, so they must not allocate. A
// scavenge comes after at most a few MB of garbage, so 1e5 queries allocating even one small
// object each would show up as a GC or as heap growth.

function solid(planes: Float64Array, contents = CONTENTS_SOLID): CollisionBrushSource {
  const b = buildBrush(planes);
  return { planes: b.planes, faceCount: b.faceCount, bounds: b.bounds, contents };
}

function makeWorld(): CollisionWorld {
  const rng = new Mulberry32(0xa110c);
  const r = (range: number) => Math.round((rng.nextFloat() * 2 - 1) * range);
  const brushes = [solid(boxPlanes([-2048, -2048, -64], [2048, 2048, 0]))];
  for (let i = 0; i < 120; i++) {
    const x = r(1800);
    const y = r(1800);
    const kind = i % 3;
    if (kind === 0) {
      brushes.push(solid(boxPlanes([x, y, 0], [x + 16 + r(64) + 64, y + 80, 16 + r(8) + 64])));
    } else if (kind === 1) {
      brushes.push(solid(rotatedBoxPlanes([x, y, 48], [64, 12, 48], 0.6, 0.8)));
    } else {
      brushes.push(solid(wedgePlanes([x, y, 0], [x + 128, y + 64, 48], "+x")));
    }
  }
  brushes.push(solid(boxPlanes([-256, -256, 0], [256, 256, 36]), CONTENTS_WATER));
  return createCollisionWorld(brushes);
}

const QUERIES = 1024;

describe("BVH queries", () => {
  const world = makeWorld();
  const rng = new Mulberry32(0xbeef);
  const starts: Vec3[] = [];
  const ends: Vec3[] = [];
  for (let i = 0; i < QUERIES; i++) {
    const s = vec3(
      (rng.nextFloat() * 2 - 1) * 2000,
      (rng.nextFloat() * 2 - 1) * 2000,
      24 + rng.nextFloat() * 100,
    );
    const long = i % 4 === 0;
    const reach = long ? 600 : 12;
    starts.push(s);
    ends.push(
      vec3(
        s[0] + (rng.nextFloat() * 2 - 1) * reach,
        s[1] + (rng.nextFloat() * 2 - 1) * reach,
        s[2] - rng.nextFloat() * reach,
      ),
    );
  }
  const out = new TraceResult();
  const lo = vec3();
  const hi = vec3();

  /** Runs `count` mixed queries; returns a hit count so none can be optimised away. */
  function run(count: number): number {
    let hits = 0;
    for (let n = 0; n < count; n++) {
      const i = n & (QUERIES - 1);
      const s = starts[i] as Vec3;
      const e = ends[i] as Vec3;
      switch (n % 6) {
        case 0:
        case 1:
          traceBox(
            world,
            s,
            e,
            HULL_MINS,
            (n & 8) === 0 ? HULL_STANDING_MAXS : HULL_CROUCHED_MAXS,
            MASK_PLAYERSOLID,
            out,
          );
          if (out.fraction < 1) hits++;
          break;
        case 2:
          traceRay(world, s, e, -1, out);
          if (out.startSolid) hits++;
          break;
        case 3:
          if (!positionTest(world, e, HULL_MINS, HULL_STANDING_MAXS, MASK_PLAYERSOLID)) hits++;
          hits += positionContents(world, s, HULL_MINS, HULL_CROUCHED_MAXS, -1) & 1;
          break;
        case 4:
          hits += pointContents(world, e) & 1;
          break;
        default:
          lo[0] = s[0] - 16;
          lo[1] = s[1] - 16;
          lo[2] = s[2] - 64;
          hi[0] = s[0] + 16;
          hi[1] = s[1] + 16;
          hi[2] = s[2];
          hits += boxContents(world, lo, hi) & 1;
      }
    }
    return hits;
  }

  it("allocate nothing over 1e5 calls (no GC, no heap growth)", async () => {
    const settle = () => new Promise((resolve) => setTimeout(resolve, 20));
    let gcs = 0;
    const observer = new PerformanceObserver((list) => {
      gcs += list.getEntries().length;
    });
    observer.observe({ entryTypes: ["gc"] });
    // Warm-up: lets the JIT optimise every path before anything is measured.
    let hits = run(100_000);
    const attempts: string[] = [];
    let clean = false;
    try {
      // A GC from elsewhere (a finishing incremental mark) can land in one attempt; per-query
      // garbage lands in all of them.
      for (let attempt = 0; attempt < 3 && !clean; attempt++) {
        await settle();
        gcs = 0;
        const before = process.memoryUsage().heapUsed;
        hits += run(100_000);
        const growth = process.memoryUsage().heapUsed - before;
        await settle();
        attempts.push(`${gcs} GCs, heap ${growth >= 0 ? "+" : ""}${growth} B`);
        clean = gcs === 0 && growth < 64 * 1024;
      }
    } finally {
      observer.disconnect();
    }
    expect(hits).toBeGreaterThan(0);
    expect(clean, attempts.join("; ")).toBe(true);
  });
});
