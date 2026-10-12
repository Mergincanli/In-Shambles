import { angleVectors, CMAP_VERTEX_FLOATS, degreesToU16, vec3 } from "@game/shared";
import { Matrix4, Object3D, PerspectiveCamera, Vector3 } from "three";
import { describe, expect, it } from "vitest";
import {
  convertVertices,
  METERS_PER_UNIT,
  setViewAngles,
  toSim,
  toThree,
  toThreeDir,
  UPRIGHT_HEIGHT,
  UPRIGHT_SLOTS,
  UPRIGHT_X,
  UPRIGHT_Y,
  UPRIGHT_YAW,
  UPRIGHT_Z,
  unitsToMeters,
  uprightToThree,
} from "../../src/render/space";

const v = (x: number, y: number, z: number) => new Vector3(x, y, z);
const three = (x: number, y: number, z: number) => toThree(x, y, z, new Vector3());
const dir = (x: number, y: number, z: number) => toThreeDir(x, y, z, new Vector3());

function expectClose(a: Vector3, b: Vector3, eps = 1e-9) {
  expect(a.distanceTo(b), `${a.toArray()} vs ${b.toArray()}`).toBeLessThan(eps);
}

describe("render/space (docs/06 §7)", () => {
  it("maps sim +X, +Y, +Z (Z-up inches) to scene +X, −Z, +Y (Y-up metres)", () => {
    expectClose(three(1, 0, 0), v(METERS_PER_UNIT, 0, 0));
    expectClose(three(0, 1, 0), v(0, 0, -METERS_PER_UNIT));
    expectClose(three(0, 0, 1), v(0, METERS_PER_UNIT, 0));
    expectClose(dir(1, 0, 0), v(1, 0, 0));
    expectClose(dir(0, 1, 0), v(0, 0, -1));
    expectClose(dir(0, 0, 1), v(0, 1, 0));
  });

  it("scales 1 u to 0.0254 m and directions not at all", () => {
    expect(METERS_PER_UNIT).toBe(0.0254);
    expect(three(100, -200, 50).length()).toBeCloseTo(Math.hypot(100, 200, 50) * 0.0254, 12);
    expect(dir(3, 4, 12).length()).toBeCloseTo(13, 12);
  });

  it("inverts exactly enough: toSim(toThree(p)) = p", () => {
    for (const p of [
      [0, 0, 0],
      [1, 2, 3],
      [-3072, 5120, -160],
      [0.03125, -1536.5, 24],
    ] as const) {
      const back = toSim(three(p[0], p[1], p[2]), vec3());
      for (let i = 0; i < 3; i++) expect(back[i]).toBeCloseTo(p[i] as number, 9);
    }
  });

  it("keeps handedness: x × y = z on both sides", () => {
    const cross = new Vector3().crossVectors(dir(1, 0, 0), dir(0, 1, 0));
    expectClose(cross, dir(0, 0, 1));
    // A random pair: the image of the cross product is the cross product of the images.
    const a = [0.3, -1.2, 2.5] as const;
    const b = [-0.7, 0.4, 1.1] as const;
    const c = [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
    const img = new Vector3().crossVectors(dir(a[0], a[1], a[2]), dir(b[0], b[1], b[2]));
    expectClose(img, dir(c[0] as number, c[1] as number, c[2] as number), 1e-12);
  });

  it("converts cmap vertices at load time and keeps triangle winding", () => {
    // One triangle on a floor seen from above (normal +Z), counter-clockwise from outside.
    const n = CMAP_VERTEX_FLOATS;
    const src = new Float32Array(4 * n);
    const verts = [
      [9, 9, 9],
      [0, 0, 0],
      [64, 0, 0],
      [0, 64, 0],
    ];
    verts.forEach((p, i) => {
      src.set([p[0] as number, p[1] as number, p[2] as number, 0, 0, 1, i, -i], i * n);
    });
    const out = convertVertices(src, 1, 3);
    expect(out.length).toBe(3 * n);
    const pos = (i: number) => v(out[i * n] ?? 0, out[i * n + 1] ?? 0, out[i * n + 2] ?? 0);
    const normal = v(out[3] ?? 0, out[4] ?? 0, out[5] ?? 0);
    expectClose(normal, v(0, 1, 0));
    expectClose(pos(1), three(64, 0, 0), 1e-6);
    expect([out[6], out[7], out[n + 6], out[n + 7]]).toEqual([1, -1, 2, -2]);
    const e1 = pos(1).sub(pos(0));
    const e2 = pos(2).sub(pos(0));
    expect(new Vector3().crossVectors(e1, e2).dot(normal)).toBeGreaterThan(0);
    expect(convertVertices(src).length).toBe(src.length);
  });

  it("rotates every component of a slanted normal, keeping it agreeing with the winding", () => {
    const n = CMAP_VERTEX_FLOATS;
    for (const normal of [v(0.36, 0.48, 0.8), v(0.6, -0.8, 0), v(-0.48, 0.6, -0.64)]) {
      // A triangle in the plane of `normal`, counter-clockwise seen from its front.
      const u = new Vector3().crossVectors(
        normal,
        Math.abs(normal.z) < 0.9 ? v(0, 0, 1) : v(1, 0, 0),
      );
      u.normalize();
      const w = new Vector3().crossVectors(normal, u);
      const pts = [
        v(10, -20, 30),
        v(10, -20, 30).addScaledVector(u, 64),
        v(10, -20, 30).addScaledVector(w, 64),
      ];
      const src = new Float32Array(3 * n);
      pts.forEach((p, i) => {
        src.set([p.x, p.y, p.z, normal.x, normal.y, normal.z, 0, 0], i * n);
      });
      const out = convertVertices(src);
      const pos = (i: number) => v(out[i * n] ?? 0, out[i * n + 1] ?? 0, out[i * n + 2] ?? 0);
      const got = v(out[3] ?? 0, out[4] ?? 0, out[5] ?? 0);
      expectClose(got, dir(normal.x, normal.y, normal.z), 1e-6);
      const face = new Vector3().crossVectors(pos(1).sub(pos(0)), pos(2).sub(pos(0))).normalize();
      expectClose(face, got, 1e-5);
    }
  });

  it("setViewAngles looks along angleVectors' forward, right and up over a yaw/pitch grid", () => {
    const cam = new PerspectiveCamera();
    const fwd = vec3();
    const right = vec3();
    const up = vec3();
    const look = new Vector3();
    const camRight = new Vector3();
    const camUp = new Vector3();
    for (let yaw = -180; yaw <= 360; yaw += 15) {
      for (let pitch = -89; pitch <= 89; pitch += 89 / 4) {
        setViewAngles(cam, yaw, pitch);
        cam.updateMatrixWorld();
        cam.getWorldDirection(look);
        camRight.set(1, 0, 0).applyQuaternion(cam.quaternion);
        camUp.set(0, 1, 0).applyQuaternion(cam.quaternion);
        angleVectors(degreesToU16(yaw), degreesToU16(pitch), fwd, right, up);
        const label = `yaw ${yaw} pitch ${pitch}`;
        // u16 angles are within 360/65536° of the float ones.
        expect(look.distanceTo(dir(fwd[0] ?? 0, fwd[1] ?? 0, fwd[2] ?? 0)), label).toBeLessThan(
          1e-3,
        );
        expect(
          camRight.distanceTo(dir(right[0] ?? 0, right[1] ?? 0, right[2] ?? 0)),
          label,
        ).toBeLessThan(1e-3);
        expect(camUp.distanceTo(dir(up[0] ?? 0, up[1] ?? 0, up[2] ?? 0)), label).toBeLessThan(1e-3);
      }
    }
  });

  it("uses YXZ so the horizon stays level at any yaw", () => {
    const o = new Object3D();
    setViewAngles(o, 37, 30);
    expect(o.rotation.order).toBe("YXZ");
    const right = new Vector3(1, 0, 0).applyQuaternion(o.quaternion);
    expect(Math.abs(right.y)).toBeLessThan(1e-12);
  });

  it("places an upright body: feet at the sim position, local +X along the sim yaw, squashed up", () => {
    const pose = new Float64Array(UPRIGHT_SLOTS);
    const out = new Float32Array(32).fill(Number.NaN);
    for (const yaw of [0, 90, 135, 270, 359]) {
      pose[UPRIGHT_X] = 100;
      pose[UPRIGHT_Y] = -200;
      pose[UPRIGHT_Z] = 24;
      pose[UPRIGHT_YAW] = yaw;
      pose[UPRIGHT_HEIGHT] = 40 / 56;
      uprightToThree(pose, out, 16);
      expect(Number.isNaN(out[15] as number)).toBe(true);
      const m = new Matrix4().fromArray(Array.from(out), 16);
      // The local origin is the sim position.
      expectClose(new Vector3().applyMatrix4(m), three(100, -200, 24), 1e-6);
      // Local +X is the facing: sim (cos yaw, sin yaw, 0).
      const r = (yaw * Math.PI) / 180;
      const facing = new Vector3(1, 0, 0).transformDirection(m);
      expectClose(facing, dir(Math.cos(r), Math.sin(r), 0), 1e-6);
      // Up stays up, scaled; the matrix keeps handedness (a rotation times a scale).
      const up = new Vector3(0, 1, 0).applyMatrix4(m).sub(new Vector3().applyMatrix4(m));
      expectClose(up, dir(0, 0, 40 / 56), 1e-6);
      expect(m.determinant()).toBeCloseTo(40 / 56, 6);
    }
    expect(unitsToMeters(56)).toBeCloseTo(56 * METERS_PER_UNIT, 12);
  });
});
