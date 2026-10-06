import { type CollisionWorld, createCollisionWorld } from "../../src/world/collisionWorld";
import { hexToF64 } from "./f64";

/**
 * Rebuilds a vectors file's world (TRACE_WORLD, PMOVE_WORLD) from its frozen plane bits rather
 * than from the polygonizer, so a replay in any engine checks only the code under test. Row:
 * contents (u32), faceCount, planeCount, bounds (6 f64), planes (4 f64 each), surface flags (u32).
 */
export function worldFromRows(rows: readonly string[]): CollisionWorld {
  return createCollisionWorld(
    rows.map((row) => {
      const f = row.split(" ");
      const faceCount = Number(f[1]);
      const planeCount = Number(f[2]);
      const bounds = Float64Array.from(f.slice(3, 9), (h) => hexToF64(h));
      const planes = Float64Array.from(f.slice(9, 9 + 4 * planeCount), (h) => hexToF64(h));
      const surfaceFlags = f.slice(9 + 4 * planeCount).map((h) => Number.parseInt(h, 16));
      return { contents: Number.parseInt(f[0] ?? "", 16), faceCount, planes, bounds, surfaceFlags };
    }),
  );
}
