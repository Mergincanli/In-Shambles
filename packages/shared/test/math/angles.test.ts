import { describe, expect, it } from "vitest";
import { angleVectors, clampPitchU16, PITCH_LIMIT_U16 } from "../../src/math/angles";
import { degreesToU16 } from "../../src/math/quant";
import { vec3, vec3Cross, vec3Dot, vec3Length } from "../../src/math/vec3";

const f = vec3();
const r = vec3();
const u = vec3();
const arr = (v: Float64Array) => Array.from(v);

describe("angleVectors", () => {
  it("faces +X with Z up at yaw 0, pitch 0", () => {
    angleVectors(0, 0, f, r, u);
    expect(arr(f)).toEqual([1, 0, 0]);
    expect(arr(r)).toEqual([0, -1, 0]);
    expect(arr(u)).toEqual([0, 0, 1]);
  });

  it("turns yaw about +Z: 90° faces +Y", () => {
    angleVectors(degreesToU16(90), 0, f, r, u);
    expect(arr(f)).toEqual([0, 1, 0]);
    expect(arr(r)).toEqual([1, 0, 0]);
    expect(arr(u)).toEqual([0, 0, 1]);
  });

  it("looks down for positive pitch", () => {
    angleVectors(0, degreesToU16(90), f, r, u);
    expect(arr(f)).toEqual([0, 0, -1]);
    expect(arr(u)).toEqual([1, 0, 0]);
    angleVectors(0, degreesToU16(-90), f, r, u);
    expect(arr(f)).toEqual([0, 0, 1]);
  });

  it("never writes -0", () => {
    // Every yaw quadrant against level and vertical pitch: e.g. (yaw 270°, pitch 0) has
    // sp = +0 and sy = −1, so sp·sy is −0 without the `+ 0`.
    for (let yaw = 0; yaw < 65536; yaw += 4096) {
      for (let pitch = 0; pitch < 65536; pitch += 4096) {
        angleVectors(yaw, pitch, f, r, u);
        for (const v of [f, r, u]) {
          for (const c of v) if (Object.is(c, -0)) expect.fail(`-0 at yaw ${yaw}, pitch ${pitch}`);
        }
      }
    }
  });

  it("returns a right-handed orthonormal basis: right × forward = up", () => {
    const cross = vec3();
    for (let yaw = 0; yaw < 65536; yaw += 997) {
      for (let pitch = -PITCH_LIMIT_U16; pitch <= PITCH_LIMIT_U16; pitch += 1531) {
        angleVectors(yaw, pitch & 0xffff, f, r, u);
        expect(vec3Length(f)).toBeCloseTo(1, 14);
        expect(vec3Length(r)).toBeCloseTo(1, 14);
        expect(vec3Length(u)).toBeCloseTo(1, 14);
        expect(vec3Dot(f, r)).toBeCloseTo(0, 14);
        expect(vec3Dot(f, u)).toBeCloseTo(0, 14);
        vec3Cross(cross, r, f);
        for (let k = 0; k < 3; k++) expect(cross[k]).toBeCloseTo(u[k] ?? Number.NaN, 14);
      }
    }
  });
});

describe("pitch clamp", () => {
  it("limits pitch to floor(89° in u16 units)", () => {
    expect(PITCH_LIMIT_U16).toBe(Math.floor((89 * 65536) / 360));
  });

  it.each([
    [0, 0],
    [1000, 1000],
    [16201, 16201],
    [16202, 16201],
    [32767, 16201],
    [32768, 65536 - 16201],
    [65535, 65535],
    [65536 - 16201, 65536 - 16201],
    [65536 - 16202, 65536 - 16201],
    [65536 + 5, 5],
  ])("clampPitchU16(%i) = %i", (pitch, clamped) => {
    expect(clampPitchU16(pitch)).toBe(clamped);
  });
});
