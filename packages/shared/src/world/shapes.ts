import { BrushError } from "./brushValidate";

/**
 * Plane sets for the brush shapes M1 needs (M1 design B): each is exact with axial bevels alone,
 * so it needs no edge bevels. Planes are half-spaces n·x ≤ d with outward unit normals, 4 numbers
 * per plane, ready for buildBrush(). Build time only: these allocate.
 */

export type Triple = readonly [number, number, number];

/** The direction a wedge's slope rises toward. */
export type WedgeRise = "+x" | "-x" | "+y" | "-y";

function checkBox(min: Triple, max: Triple, shape: string): void {
  for (let k = 0; k < 3; k++) {
    const lo = min[k] as number;
    const hi = max[k] as number;
    if (!Number.isFinite(lo) || !Number.isFinite(hi) || !(lo < hi)) {
      throw new BrushError("input", `${shape}: needs finite min < max on every axis`);
    }
  }
}

/** Axis-aligned box, planes in the order −x, +x, −y, +y, −z, +z. */
export function boxPlanes(min: Triple, max: Triple): Float64Array {
  checkBox(min, max, "box");
  return Float64Array.of(
    -1,
    0,
    0,
    -min[0] + 0,
    1,
    0,
    0,
    max[0] + 0,
    0,
    -1,
    0,
    -min[1] + 0,
    0,
    1,
    0,
    max[1] + 0,
    0,
    0,
    -1,
    -min[2] + 0,
    0,
    0,
    1,
    max[2] + 0,
  );
}

/**
 * Box rotated about +Z by the angle whose cosine and sine are given. No trig happens here (D-016):
 * pass closed forms (sin 15° = (√6 − √2)/4) or dtrig values. (cos, sin) is renormalised with
 * Math.sqrt, so closed forms one ulp off unit length are fine. Planes are ordered −u, +u, −v, +v,
 * −z, +z, where u = (cos, sin, 0) is the rotated x axis and v = (−sin, cos, 0) the rotated y axis.
 */
export function rotatedBoxPlanes(
  center: Triple,
  half: Triple,
  cos: number,
  sin: number,
): Float64Array {
  const [cx, cy, cz] = center;
  const [hx, hy, hz] = half;
  if (
    !Number.isFinite(cx) ||
    !Number.isFinite(cy) ||
    !Number.isFinite(cz) ||
    !(
      hx > 0 &&
      hy > 0 &&
      hz > 0 &&
      Number.isFinite(hx) &&
      Number.isFinite(hy) &&
      Number.isFinite(hz)
    )
  ) {
    throw new BrushError("input", "rotated box: needs a finite center and positive half extents");
  }
  const len = Math.sqrt(cos * cos + sin * sin);
  if (!(Math.abs(len - 1) <= 1e-6)) {
    throw new BrushError("input", `rotated box: (cos, sin) has length ${len}, not 1`);
  }
  const c = cos / len;
  const s = sin / len;
  const uc = c * cx + s * cy;
  const vc = c * cy - s * cx;
  return Float64Array.of(
    -c + 0,
    -s + 0,
    0,
    hx - uc + 0,
    c + 0,
    s + 0,
    0,
    uc + hx + 0,
    s + 0,
    -c + 0,
    0,
    hy - vc + 0,
    -s + 0,
    c + 0,
    0,
    vc + hy + 0,
    0,
    0,
    -1,
    hz - cz + 0,
    0,
    0,
    1,
    cz + hz + 0,
  );
}

/**
 * Wedge filling the box [min, max]: the floor is min.z, and the slope climbs from min.z on the
 * low side to max.z on the side named by `rise`, where a vertical face closes it. The two sides
 * along the slope are axis-aligned. Planes keep the box order (−x, +x, −y, +y, −z) without the
 * low side, followed by the slope, whose normal z is run/√(run² + rise²).
 */
export function wedgePlanes(min: Triple, max: Triple, rise: WedgeRise): Float64Array {
  checkBox(min, max, "wedge");
  const box = boxPlanes(min, max);
  const axis = rise === "+x" || rise === "-x" ? 0 : 1;
  const up = rise === "+x" || rise === "+y";
  const lowSide = 2 * axis + (up ? 0 : 1);
  const run = (max[axis] as number) - (min[axis] as number);
  const height = max[2] - min[2];
  const len = Math.sqrt(run * run + height * height);
  // Outward normal: up and away from the high side.
  const nAxis = (up ? -height : height) / len;
  const nz = run / len;
  const nx = axis === 0 ? nAxis : 0;
  const ny = axis === 1 ? nAxis : 0;
  // The slope passes through the low edge: (low end of the axis, min.z).
  const lowEnd = up ? (min[axis] as number) : (max[axis] as number);
  const d = nAxis * lowEnd + nz * min[2] + 0;
  const out = new Float64Array(20);
  let o = 0;
  for (let p = 0; p < 5; p++) {
    if (p === lowSide) continue;
    out.set(box.subarray(4 * p, 4 * p + 4), o);
    o += 4;
  }
  out[o] = nx + 0;
  out[o + 1] = ny + 0;
  out[o + 2] = nz;
  out[o + 3] = d;
  return out;
}
