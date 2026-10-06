import {
  BUTTON_ATTACK,
  BUTTON_CROUCH,
  BUTTON_JUMP,
  BUTTON_SPRINT,
  BUTTON_WALK,
  degreesToU16,
  MOVE_AXIS_MAX,
  PlayerState,
  UserCmd,
} from "@game/shared";
import { describe, expect, it } from "vitest";
import { ACTION_FORWARD, ACTION_JUMP, Binds } from "../../src/console/binds";
import { KeyRouter } from "../../src/input/keyboard";
import { MouseLook, PITCH_LIMIT_DEG } from "../../src/input/mouse";
import { ActionState, PlayerInput } from "../../src/input/sampler";

const ps = new PlayerState();

function rig() {
  const actions = new ActionState();
  const look = new MouseLook();
  const ran: string[] = [];
  const binds = new Binds();
  const router = new KeyRouter(binds, actions, (c) => ran.push(c));
  const input = new PlayerInput(actions, look);
  const cmd = new UserCmd();
  const sample = () => {
    input.sample(cmd, ps);
    return { ...cmd };
  };
  return { actions, binds, look, router, ran, sample };
}

describe("cmd sampler (M2 design §2 'Buttons')", () => {
  it("maps held actions to axes and buttons", () => {
    const r = rig();
    for (const code of ["KeyW", "KeyD", "Space", "KeyC", "KeyX", "ShiftLeft", "Mouse0"]) {
      expect(r.router.keyDown(code)).toBe(true);
    }
    const c = r.sample();
    expect([c.forward, c.right, c.up]).toEqual([MOVE_AXIS_MAX, MOVE_AXIS_MAX, 0]);
    expect(c.buttons).toBe(
      BUTTON_JUMP | BUTTON_CROUCH | BUTTON_WALK | BUTTON_SPRINT | BUTTON_ATTACK,
    );
    r.router.keyDown("KeyS");
    r.router.keyDown("KeyA");
    expect([r.sample().forward, r.sample().right]).toEqual([0, 0]);
    r.router.keyUp("KeyW");
    r.router.keyUp("KeyD");
    expect([r.sample().forward, r.sample().right]).toEqual([-MOVE_AXIS_MAX, -MOVE_AXIS_MAX]);
  });

  it("latches a tap shorter than a tick into exactly one cmd", () => {
    const r = rig();
    r.router.keyDown("Space");
    r.router.keyUp("Space");
    expect(r.sample().buttons).toBe(BUTTON_JUMP);
    expect(r.sample().buttons).toBe(0);
  });

  it("keeps an action held while either of two keys holds it", () => {
    const r = rig();
    r.binds.bind("KeyQ", "+forward");
    r.router.keyDown("KeyW");
    r.router.keyDown("KeyQ");
    r.router.keyUp("KeyQ");
    // Twice, so the press latch is spent: only the held count keeps it on.
    r.sample();
    expect(r.sample().forward).toBe(MOVE_AXIS_MAX);
    r.router.keyUp("KeyW");
    expect(r.sample().forward).toBe(0);
  });

  it("ignores auto-repeat and runs commands", () => {
    const r = rig();
    r.router.keyDown("Space");
    r.router.keyDown("Space", true);
    expect(r.actions.held[ACTION_JUMP]).toBe(1);
    expect(r.router.keyDown("Backquote")).toBe(true);
    expect(r.ran).toEqual(["toggleconsole"]);
    expect(r.router.keyDown("KeyQ")).toBe(false);
    r.router.keyUp("Space");
    expect(r.actions.held[ACTION_JUMP]).toBe(0);
  });

  it("releases what a key pressed even after a rebind", () => {
    const r = rig();
    r.router.keyDown("KeyW");
    r.binds.bind("KeyW", "+jump");
    r.router.keyUp("KeyW");
    r.sample();
    const c = r.sample();
    expect([c.forward, c.buttons]).toEqual([0, 0]);
    expect(r.actions.held[ACTION_JUMP]).toBe(0);
  });

  it("never reruns a command from a repeat, even after releaseAll forgot the key", () => {
    const r = rig();
    r.router.keyDown("Backquote");
    r.router.releaseAll();
    expect(r.router.keyDown("Backquote", true)).toBe(true);
    expect(r.ran).toEqual(["toggleconsole"]);
    // A held movement key resumes on its repeat (the console closed under it).
    r.router.keyDown("KeyW", true);
    r.sample();
    expect(r.sample().forward).toBe(MOVE_AXIS_MAX);
  });

  it("knows the console keys: Escape and any key bound to toggleconsole, in any case", () => {
    const r = rig();
    expect(r.router.isConsoleKey("Escape")).toBe(true);
    expect(r.router.isConsoleKey("Backquote")).toBe(true);
    expect(r.router.isConsoleKey("KeyT")).toBe(false);
    r.binds.bind("KeyT", "TOGGLECONSOLE");
    expect(r.router.isConsoleKey("KeyT")).toBe(true);
  });

  it("releases everything at once (hidden tab, console)", () => {
    const r = rig();
    r.router.keyDown("KeyW");
    r.router.keyDown("Space");
    r.router.releaseAll();
    expect(r.router.heldCount).toBe(0);
    const c = r.sample();
    expect([c.forward, c.buttons]).toEqual([0, 0]);
    // The key's later release is harmless.
    r.router.keyUp("KeyW");
    expect(r.actions.held[ACTION_FORWARD]).toBe(0);
  });

  it("sends the mouse look's angles in u16 units", () => {
    const r = rig();
    r.look.set(90, -30);
    const c = r.sample();
    expect([c.yaw, c.pitch]).toEqual([degreesToU16(90), degreesToU16(-30)]);
  });

  it("rounds angles exactly as degreesToU16 (its conversion is inlined)", () => {
    const r = rig();
    for (let i = 0; i <= 20000; i++) {
      const yaw = (i * 360) / 20000 + (i % 7) * 1e-7;
      const pitch = ((i % 3561) - 1780) / 20;
      r.look.angles[0] = yaw;
      r.look.angles[1] = pitch;
      const c = r.sample();
      if (c.yaw !== degreesToU16(yaw) || c.pitch !== degreesToU16(pitch)) {
        expect([yaw, pitch, c.yaw, c.pitch]).toEqual([
          yaw,
          pitch,
          degreesToU16(yaw),
          degreesToU16(pitch),
        ]);
      }
    }
  });
});

describe("mouse look (M2 design §2 'Mouse')", () => {
  const q3 = { sensitivity: 5, mYaw: 0.022, mPitch: 0.022 };

  it("turns by counts × sensitivity × m_yaw / m_pitch: right turns right, down looks down", () => {
    const look = new MouseLook();
    look.set(90, 0);
    look.addCounts(10, 20);
    look.addCounts(10, 0);
    look.apply(q3);
    expect(look.angles[0]).toBeCloseTo(90 - 20 * 5 * 0.022, 12);
    expect(look.angles[1]).toBeCloseTo(20 * 5 * 0.022, 12);
    // Applied once: the counts are spent.
    look.apply(q3);
    expect(look.angles[0]).toBeCloseTo(87.8, 12);
  });

  it("wraps yaw into [0, 360) and clamps pitch to ±89", () => {
    const look = new MouseLook();
    look.addCounts(100, 100000);
    look.apply(q3);
    expect(look.angles[0]).toBeCloseTo(349, 9);
    expect(look.angles[1]).toBe(PITCH_LIMIT_DEG);
    look.addCounts(-1000, -1e6);
    look.apply(q3);
    expect(look.angles[0]).toBeCloseTo(99, 9);
    expect(look.angles[1]).toBe(-PITCH_LIMIT_DEG);
    look.set(-450, 120);
    expect([look.angles[0], look.angles[1]]).toEqual([270, 89]);
    // A tiny negative yaw plus 360 rounds to 360: folded back to 0.
    look.set(-1e-15, 0);
    expect(look.angles[0]).toBe(0);
    look.addCounts(1, 0);
    look.apply({ sensitivity: 1e-15, mYaw: 0.022, mPitch: 0.022 });
    expect(look.angles[0]).toBe(0);
  });

  it("inverts pitch with a negative m_pitch and drops events with non-finite counts", () => {
    const look = new MouseLook();
    look.addCounts(Number.NaN, 10);
    look.addCounts(0, Number.POSITIVE_INFINITY);
    look.addCounts(0, 10);
    look.apply({ sensitivity: 1, mYaw: 0.022, mPitch: -0.5 });
    expect([look.angles[0], look.angles[1]]).toEqual([0, -5]);
  });
});
