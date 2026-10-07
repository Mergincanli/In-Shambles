import { Vector3 } from "three";
import { describe, expect, it } from "vitest";
import {
  FirstPersonCamera,
  horizontalFovDegrees,
  verticalFovDegrees,
} from "../../src/render/camera";
import { toThree } from "../../src/render/space";

describe("first-person camera (docs/06 §7)", () => {
  it("cl_fov is horizontal at 4:3 and widens with the screen (Hor+)", () => {
    const v43 = verticalFovDegrees(90, 4 / 3);
    expect(horizontalFovDegrees(v43, 4 / 3)).toBeCloseTo(90, 9);
    expect(v43).toBeCloseTo(73.7398, 3);
    // 16:9 keeps the 4:3 vertical angle and sees more to the sides.
    expect(verticalFovDegrees(90, 16 / 9)).toBeCloseTo(v43, 9);
    expect(horizontalFovDegrees(v43, 16 / 9)).toBeCloseTo(106.26, 2);
    // Narrower than 4:3 keeps the horizontal angle instead.
    expect(horizontalFovDegrees(verticalFovDegrees(90, 1), 1)).toBeCloseTo(90, 9);
    expect(horizontalFovDegrees(verticalFovDegrees(110, 9 / 16), 9 / 16)).toBeCloseTo(110, 9);
  });

  it("resizes the projection only when the size or fov changes", () => {
    const fp = new FirstPersonCamera();
    fp.resize(1600, 900, 90);
    const m = fp.camera.projectionMatrix.clone();
    expect(fp.camera.aspect).toBeCloseTo(16 / 9, 12);
    fp.resize(1600, 900, 90);
    expect(fp.camera.projectionMatrix.equals(m)).toBe(true);
    fp.resize(1600, 900, 100);
    expect(fp.camera.projectionMatrix.equals(m)).toBe(false);
  });

  it("puts the eye at the sim pose through space.ts", () => {
    const fp = new FirstPersonCamera();
    fp.pose.set([-1152, -1536, 50, 90, 0]);
    fp.apply();
    expect(fp.camera.position.distanceTo(toThree(-1152, -1536, 50, new Vector3()))).toBeLessThan(
      1e-12,
    );
    fp.camera.updateMatrixWorld();
    const look = fp.camera.getWorldDirection(new Vector3());
    // Yaw 90 faces sim +Y, which is scene −Z.
    expect(look.distanceTo(new Vector3(0, 0, -1))).toBeLessThan(1e-12);
  });
});
