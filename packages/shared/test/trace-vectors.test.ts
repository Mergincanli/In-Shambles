import { describe, expect, it } from "vitest";
import { vec3 } from "../src/math/vec3";
import { createCollisionWorld } from "../src/world/collisionWorld";
import {
  pointContents,
  snapOrigin,
  TraceResult,
  traceBox,
  traceBoxBrute,
} from "../src/world/trace";
import { f64ToHex, hexToF64 } from "./helpers/f64";
import { POINT_CONTENTS_VECTORS, SNAP_VECTORS, TRACE_VECTORS, TRACE_WORLD } from "./vectors/trace";

// The committed trace vectors (D-016, D-017): the world is rebuilt from its frozen plane bits,
// not from the polygonizer, so a replay in any engine checks only the trace code.
const u32 = (hex: string | undefined) => Number.parseInt(hex ?? "", 16);
const f64 = (hex: string | undefined) => hexToF64(hex ?? "");

const world = createCollisionWorld(
  TRACE_WORLD.map((row) => {
    const f = row.split(" ");
    const faceCount = Number(f[1]);
    const planeCount = Number(f[2]);
    const bounds = Float64Array.from(f.slice(3, 9), (h) => f64(h));
    const planes = Float64Array.from(f.slice(9, 9 + 4 * planeCount), (h) => f64(h));
    const surfaceFlags = f.slice(9 + 4 * planeCount).map((h) => u32(h));
    return { contents: u32(f[0]), faceCount, planes, bounds, surfaceFlags };
  }),
);

/** Rows whose recomputed fields differ, as "row → recomputed". */
function mismatches(rows: readonly string[], recompute: (f: string[]) => string): string[] {
  return rows.flatMap((row) => {
    const again = recompute(row.split(" "));
    return again === row ? [] : [`${row} → ${again}`];
  });
}

const vecAt = (f: string[], i: number) => vec3(f64(f[i]), f64(f[i + 1]), f64(f[i + 2]));

describe("trace vectors (D-017)", () => {
  it("have their rows", () => {
    expect(TRACE_WORLD.length).toBeGreaterThanOrEqual(8);
    expect(TRACE_VECTORS.length).toBeGreaterThanOrEqual(150);
    expect(SNAP_VECTORS.length).toBeGreaterThanOrEqual(20);
    expect(SNAP_VECTORS.some((row) => row.split(" ")[13] === "1")).toBe(true);
    expect(POINT_CONTENTS_VECTORS.length).toBeGreaterThanOrEqual(30);
  });

  it.each([
    ["traceBox", traceBox],
    ["traceBoxBrute", traceBoxBrute],
  ])("%s", (_name, trace) => {
    const out = new TraceResult();
    const got = mismatches(TRACE_VECTORS, (f) => {
      trace(world, vecAt(f, 0), vecAt(f, 3), vecAt(f, 6), vecAt(f, 9), u32(f[12]), out);
      const doubles = [out.fraction, ...out.endpos, ...out.normal, out.planeDist].map(f64ToHex);
      const ints = [out.plane, out.brush, out.contents, out.surfaceFlags, out.entity];
      const flags = [out.startSolid ? 1 : 0, out.allSolid ? 1 : 0];
      return [...f.slice(0, 13), ...doubles, ...ints, ...flags].join(" ");
    });
    expect(got).toEqual([]);
  });

  it("snapOrigin", () => {
    const out = vec3();
    const got = mismatches(SNAP_VECTORS, (f) => {
      const rule = snapOrigin(
        world,
        vecAt(f, 0),
        vecAt(f, 3),
        vecAt(f, 6),
        u32(f[9]),
        vecAt(f, 10),
        out,
      );
      return [...f.slice(0, 13), rule, ...[...out].map(f64ToHex)].join(" ");
    });
    expect(got).toEqual([]);
  });

  it("pointContents", () => {
    const got = mismatches(
      POINT_CONTENTS_VECTORS,
      (f) => `${f.slice(0, 3).join(" ")} ${pointContents(world, vecAt(f, 0))}`,
    );
    expect(got).toEqual([]);
  });
});
