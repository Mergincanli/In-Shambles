import { describe, expect, it } from "vitest";
import { type BuiltBrush, buildBrush } from "../../src/world/brushBuild";
import { rotatedBoxPlanes, wedgePlanes } from "../../src/world/shapes";
import { f64ToHex } from "../helpers/f64";

/**
 * Golden bits for two non-trivial brushes. Compiled maps are byte-identical across runs and
 * engines (docs/07 §2), and cmap output comes from buildBrush, so any change to these bits is a
 * format change that must be deliberate.
 */

interface Golden {
  readonly planes: readonly string[];
  readonly bounds: readonly string[];
  readonly vertices: readonly string[];
  readonly polygons: readonly (readonly number[])[];
}

function bits(b: BuiltBrush): Golden {
  return {
    planes: [...b.planes].map(f64ToHex),
    bounds: [...b.bounds].map(f64ToHex),
    vertices: [...b.vertices].map(f64ToHex),
    polygons: b.polygons.map((p) => [...p]),
  };
}

const BOX_30: Golden = {
  planes: [
    "bfebb67ae0000000",
    "bfe0000000000000",
    "0000000000000000",
    "c029065280000000",
    "3febb67ae0000000",
    "3fe0000000000000",
    "0000000000000000",
    "4061906520000000",
    "3fe0000000000000",
    "bfebb67ae0000000",
    "0000000000000000",
    "405304e920000000",
    "bfe0000000000000",
    "3febb67ae0000000",
    "0000000000000000",
    "c04e09d220000000",
    "0000000000000000",
    "0000000000000000",
    "bff0000000000000",
    "c032000000000000",
    "0000000000000000",
    "0000000000000000",
    "3ff0000000000000",
    "4054800000000000",
    "bff0000000000000",
    "0000000000000000",
    "0000000000000000",
    "c0446feb80000000",
    "3ff0000000000000",
    "0000000000000000",
    "0000000000000000",
    "4063f73860000000",
    "0000000000000000",
    "bff0000000000000",
    "0000000000000000",
    "404dd06920000000",
    "0000000000000000",
    "3ff0000000000000",
    "0000000000000000",
    "40323a6ba0000000",
  ],
  bounds: [
    "40446feb80000000",
    "c04dd06920000000",
    "4032000000000000",
    "4063f73860000000",
    "40323a6ba0000000",
    "4054800000000000",
  ],
  vertices: [
    "40446feb835adefe",
    "c046e2ca382229ad",
    "4054800000000000",
    "40446feb835adefe",
    "c046e2ca382229ae",
    "4032000000000000",
    "40486feb95296100",
    "c04dd0690ef9bc00",
    "4032000000000000",
    "40486feb95296100",
    "c04dd0690ef9bc00",
    "4054800000000000",
    "4063f738549ef300",
    "40117cb77bd38000",
    "4054800000000000",
    "4063f738549ef300",
    "40117cb77bd38000",
    "4032000000000000",
    "4062f738502b51de",
    "40323a6b8ca40e71",
    "4032000000000000",
    "4062f738502b51de",
    "40323a6b8ca40e71",
    "4054800000000000",
  ],
  polygons: [
    [1, 2, 3, 0],
    [6, 7, 4, 5],
    [2, 5, 4, 3],
    [1, 0, 7, 6],
    [1, 6, 5, 2],
    [0, 3, 4, 7],
  ],
};

const WEDGE_071: Golden = {
  planes: [
    "3ff0000000000000",
    "0000000000000000",
    "0000000000000000",
    "4072c00000000000",
    "0000000000000000",
    "bff0000000000000",
    "0000000000000000",
    "401c666660000000",
    "0000000000000000",
    "3ff0000000000000",
    "0000000000000000",
    "4050000000000000",
    "0000000000000000",
    "0000000000000000",
    "bff0000000000000",
    "0000000000000000",
    "bfe688d200000000",
    "0000000000000000",
    "3fe6b851e0000000",
    "c0029746c0000000",
    "bff0000000000000",
    "0000000000000000",
    "0000000000000000",
    "c00a666640000000",
    "0000000000000000",
    "0000000000000000",
    "3ff0000000000000",
    "4072646e80000000",
  ],
  bounds: [
    "400a666640000000",
    "c01c666660000000",
    "0000000000000000",
    "4072c00000000000",
    "4050000000000000",
    "4072646e80000000",
  ],
  vertices: [
    "4072c00000000000",
    "4050000000000000",
    "0000000000000000",
    "4072c00000000000",
    "4050000000000000",
    "4072646e7a97e17b",
    "4072c00000000000",
    "c01c666660000000",
    "4072646e7a97e180",
    "4072c00000000000",
    "c01c666660000000",
    "0000000000000000",
    "400a6666420c0000",
    "c01c666660000000",
    "0000000000000000",
    "400a6666420bf980",
    "4050000000000000",
    "0000000000000000",
  ],
  polygons: [
    [3, 0, 1, 2],
    [4, 3, 2],
    [5, 1, 0],
    [5, 0, 3, 4],
    [5, 4, 2, 1],
  ],
};

describe("buildBrush golden bits", () => {
  it("box rotated 30° about +Z", () => {
    const planes = rotatedBoxPlanes([100.3, -20.7, 50], [64, 8, 32], Math.sqrt(3) / 2, 0.5);
    expect(bits(buildBrush(planes))).toEqual(BOX_30);
  });

  it("wedge with slope normal z = 0.71", () => {
    const run = 296.7;
    const rise = (run * Math.sqrt(1 - 0.71 * 0.71)) / 0.71;
    expect(bits(buildBrush(wedgePlanes([3.3, -7.1, 0], [300, 64, rise], "+x")))).toEqual(WEDGE_071);
  });
});
