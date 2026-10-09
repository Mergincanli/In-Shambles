import { TEAM_1, TEAM_2, TEAM_NONE } from "@game/shared";
import { type Box3, Color, InstancedMesh, Matrix4, Scene, Vector3 } from "three";
import { describe, expect, it } from "vitest";
import { RemoteView } from "../../src/net/remotes";
import {
  CAPSULE_CROUCHED_HEIGHT,
  CAPSULE_RADIUS,
  CAPSULE_STANDING_HEIGHT,
  CROUCH_SCALE,
  PLAYER_INSTANCES,
  PlayerCapsules,
} from "../../src/render/players";
import { METERS_PER_UNIT, toThree, toThreeDir } from "../../src/render/space";
import { TEAM_COLORS, teamColor } from "../../src/render/teamColors";

/** Slot `s` visible at (x, y, z) facing `yaw`. */
function put(view: RemoteView, s: number, x: number, y: number, z: number, yaw = 0, team = 1) {
  view.visible[s] = 1;
  view.x[s] = x;
  view.y[s] = y;
  view.z[s] = z;
  view.yaw[s] = yaw;
  view.team[s] = team;
  view.crouched[s] = 0;
}

function matrixOf(p: PlayerCapsules, i: number): Matrix4 {
  const m = new Matrix4();
  p.capsules.getMatrixAt(i, m);
  return m;
}

function colorOf(p: PlayerCapsules, i: number): Color {
  const c = new Color();
  p.capsules.getColorAt(i, c);
  return c;
}

function expectColor(c: Color, hex: number): void {
  const want = new Color(hex);
  expect([c.r, c.g, c.b].map((v) => v.toFixed(5))).toEqual(
    [want.r, want.g, want.b].map((v) => v.toFixed(5)),
  );
}

describe("PlayerCapsules (M3 design §1, render/players.ts)", () => {
  it("is two instanced meshes of 64 that share one matrix buffer: 2 draw calls", () => {
    const p = new PlayerCapsules();
    expect(p.object.children).toEqual([p.capsules, p.nubs]);
    expect(p.capsules).toBeInstanceOf(InstancedMesh);
    expect(p.nubs).toBeInstanceOf(InstancedMesh);
    expect(PLAYER_INSTANCES).toBe(64);
    expect(p.capsules.instanceMatrix.count).toBe(64);
    expect(p.nubs.instanceMatrix).toBe(p.capsules.instanceMatrix);
    expect(p.capsules.instanceColor?.count).toBe(64);
    // Nothing drawn before the first update.
    expect([p.capsules.visible, p.nubs.visible, p.count]).toEqual([false, false, 0]);
    expect([p.capsules.frustumCulled, p.nubs.frustumCulled]).toEqual([false, false]);
  });

  it("has the hull's size: radius 15 u, 56 u standing, 40 u crouched, feet at its origin", () => {
    expect([CAPSULE_RADIUS, CAPSULE_STANDING_HEIGHT, CAPSULE_CROUCHED_HEIGHT]).toEqual([
      15, 56, 40,
    ]);
    expect(CROUCH_SCALE).toBeCloseTo(40 / 56, 12);
    const p = new PlayerCapsules();
    p.capsules.geometry.computeBoundingBox();
    const box = p.capsules.geometry.boundingBox as Box3;
    // Float32 geometry: to a micrometre.
    expect(box.min.y).toBeCloseTo(0, 6);
    expect(box.max.y).toBeCloseTo(56 * METERS_PER_UNIT, 6);
    expect(box.max.x).toBeCloseTo(15 * METERS_PER_UNIT, 6);
    // The nub sits at the front (local +X), at the standing eye (24 + 26 u above the feet).
    p.nubs.geometry.computeBoundingBox();
    const nub = p.nubs.geometry.boundingBox as Box3;
    expect(nub.getCenter(new Vector3()).x).toBeCloseTo(15 * METERS_PER_UNIT, 6);
    expect(nub.getCenter(new Vector3()).y).toBeCloseTo(50 * METERS_PER_UNIT, 6);
  });

  it("stands each visible player on its hull's feet, turned to its yaw, packed in slot order", () => {
    const p = new PlayerCapsules();
    const view = new RemoteView();
    put(view, 40, -300, 120, 64, 90, TEAM_2);
    put(view, 3, 100, 200, 24.03125, 0);
    p.update(view);
    expect(p.count).toBe(2);
    expect([p.capsules.count, p.nubs.count, p.capsules.visible, p.nubs.visible]).toEqual([
      2,
      2,
      true,
      true,
    ]);
    // Slot 3 first: feet 24 u below its origin.
    const m0 = matrixOf(p, 0);
    const feet0 = new Vector3().applyMatrix4(m0);
    expect(feet0.distanceTo(toThree(100, 200, 0.03125, new Vector3()))).toBeLessThan(1e-6);
    const m1 = matrixOf(p, 1);
    expect(
      new Vector3().applyMatrix4(m1).distanceTo(toThree(-300, 120, 40, new Vector3())),
    ).toBeLessThan(1e-6);
    // Yaw 90 faces sim +Y.
    const facing = new Vector3(1, 0, 0).transformDirection(m1);
    expect(facing.distanceTo(toThreeDir(0, 1, 0, new Vector3()))).toBeLessThan(1e-6);
  });

  it("squashes a crouching player to the crouched hull's height", () => {
    const p = new PlayerCapsules();
    const view = new RemoteView();
    put(view, 0, 0, 0, 24);
    view.crouched[0] = 1;
    p.update(view);
    p.capsules.geometry.computeBoundingBox();
    const box = (p.capsules.geometry.boundingBox as Box3).clone().applyMatrix4(matrixOf(p, 0));
    expect(box.max.y - box.min.y).toBeCloseTo(40 * METERS_PER_UNIT, 6);
    view.crouched[0] = 0;
    p.update(view);
    const standing = (p.capsules.geometry.boundingBox as Box3).clone().applyMatrix4(matrixOf(p, 0));
    expect(standing.max.y - standing.min.y).toBeCloseTo(56 * METERS_PER_UNIT, 6);
  });

  it("colours each capsule by team: orange, blue, neutral grey for none or an unknown team", () => {
    expect(TEAM_COLORS).toEqual({ [TEAM_NONE]: 0x9a9a9a, [TEAM_1]: 0xd9652b, [TEAM_2]: 0x2b8fd9 });
    expect(teamColor(3)).toBe(0x9a9a9a);
    const p = new PlayerCapsules();
    const view = new RemoteView();
    put(view, 0, 0, 0, 24, 0, TEAM_1);
    put(view, 1, 0, 0, 24, 0, TEAM_2);
    put(view, 2, 0, 0, 24, 0, TEAM_NONE);
    put(view, 3, 0, 0, 24, 0, 3);
    p.update(view);
    expectColor(colorOf(p, 0), 0xd9652b);
    expectColor(colorOf(p, 1), 0x2b8fd9);
    expectColor(colorOf(p, 2), 0x9a9a9a);
    expectColor(colorOf(p, 3), 0x9a9a9a);
    // Colours upload only when an instance's team changes (a slot hid and the rest moved up).
    const colors = p.capsules.instanceColor;
    const version = colors?.version ?? -1;
    p.update(view);
    expect(colors?.version).toBe(version);
    view.visible[0] = 0;
    p.update(view);
    expect(colors?.version).toBe(version + 1);
    expectColor(colorOf(p, 0), 0x2b8fd9);
    expect(p.count).toBe(3);
  });

  it("draws all 64 slots, and nothing (no draw call) when none is visible", () => {
    const p = new PlayerCapsules();
    const view = new RemoteView();
    for (let s = 0; s < 64; s++) put(view, s, s * 40, 0, 24, s * 5, (s % 3) as 0 | 1 | 2);
    p.update(view);
    expect(p.count).toBe(64);
    const last = new Vector3().applyMatrix4(matrixOf(p, 63));
    // Float32 matrices: 64 m out, to a hundredth of a millimetre.
    expect(last.distanceTo(toThree(63 * 40, 0, 0, new Vector3()))).toBeLessThan(1e-5);
    view.clear();
    p.update(view);
    expect([p.count, p.capsules.count, p.capsules.visible, p.nubs.visible]).toEqual([
      0,
      0,
      false,
      false,
    ]);
  });

  it("joins a scene and leaves it on dispose", () => {
    const scene = new Scene();
    const p = new PlayerCapsules();
    scene.add(p.object);
    p.dispose();
    expect(scene.children).toEqual([]);
  });
});
