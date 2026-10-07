import { PerspectiveCamera } from "three";
import { METERS_PER_UNIT, setViewAngles, toThree } from "./space";

/** `cl_fov` is the horizontal field of view at this aspect (docs/06 §7: Hor+). */
export const FOV_REFERENCE_ASPECT = 4 / 3;
/** Near plane: 2 u, well inside the hull's 15 u half-width, so walls never clip the view. */
export const CAMERA_NEAR_UNITS = 2;
/** Far plane: twice the ±16384 u world limit (docs/07 §2), so a whole map always fits. */
export const CAMERA_FAR_UNITS = 2 * 2 * 16384;

const DEG = Math.PI / 180;

/**
 * The vertical field of view (degrees) for a horizontal `cl_fov` at 4:3 on a screen of `aspect`
 * (width / height). Hor+: the vertical angle is the 4:3 one, so a wider screen sees more to the
 * sides and nothing less above and below; a narrower screen (a phone held upright) keeps the
 * horizontal angle instead, so it never sees less than `cl_fov` across.
 */
export function verticalFovDegrees(horizontalDeg: number, aspect: number): number {
  const h = Math.min(170, Math.max(1, horizontalDeg)) * DEG;
  const a = Math.min(FOV_REFERENCE_ASPECT, aspect > 0 ? aspect : FOV_REFERENCE_ASPECT);
  return (2 * Math.atan(Math.tan(h / 2) / a)) / DEG;
}

/** The horizontal field of view (degrees) a camera with `verticalDeg` shows at `aspect`. */
export function horizontalFovDegrees(verticalDeg: number, aspect: number): number {
  return (2 * Math.atan(Math.tan((verticalDeg * DEG) / 2) * aspect)) / DEG;
}

/**
 * The first-person view (docs/06 §7 "Camera"): a perspective camera placed at a sim eye position
 * and view angles. The caller fills `pose` each frame from the interpolated, smoothed player
 * (game.ts) and calls `apply()`; the conversion to scene space happens in space.ts only.
 */
export class FirstPersonCamera {
  readonly camera = new PerspectiveCamera(
    verticalFovDegrees(90, 16 / 9),
    16 / 9,
    CAMERA_NEAR_UNITS * METERS_PER_UNIT,
    CAMERA_FAR_UNITS * METERS_PER_UNIT,
  );
  /** [0..2] eye position (sim u), [3] yaw, [4] pitch (degrees, positive looks down). */
  readonly pose = new Float64Array(5);
  /** [0] width, [1] height (px), [2] cl_fov the projection was built for. */
  private readonly view = new Float64Array(3);

  /** Rebuilds the projection when the canvas size or `cl_fov` changed. */
  resize(width: number, height: number, fovDeg: number): void {
    const v = this.view;
    if (v[0] === width && v[1] === height && v[2] === fovDeg) return;
    v[0] = width;
    v[1] = height;
    v[2] = fovDeg;
    const aspect = height > 0 ? width / height : FOV_REFERENCE_ASPECT;
    const cam = this.camera;
    cam.aspect = aspect;
    cam.fov = verticalFovDegrees(fovDeg, aspect);
    cam.updateProjectionMatrix();
  }

  /** Moves the camera to `pose`. */
  apply(): void {
    const p = this.pose;
    toThree(p[0] as number, p[1] as number, p[2] as number, this.camera.position);
    setViewAngles(this.camera, p[3] as number, p[4] as number);
  }
}
