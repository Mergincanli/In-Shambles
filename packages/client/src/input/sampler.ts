import {
  BUTTON_ATTACK,
  BUTTON_CROUCH,
  BUTTON_JUMP,
  BUTTON_SPRINT,
  BUTTON_WALK,
  MOVE_AXIS_MAX,
  type PlayerState,
  type UserCmd,
} from "@game/shared";
import {
  ACTION_ATTACK,
  ACTION_BACK,
  ACTION_COUNT,
  ACTION_CROUCH,
  ACTION_FORWARD,
  ACTION_JUMP,
  ACTION_MOVELEFT,
  ACTION_MOVERIGHT,
  ACTION_SPRINT,
  ACTION_WALK,
} from "../console/binds";
import type { CmdSampler } from "../net";
import type { MouseLook } from "./mouse";

/**
 * The `+action` states behind the player's cmds (M2 design §2 "Buttons"): each action counts the
 * keys holding it (two keys may share one) and latches a press until the next sample, so a tap
 * shorter than a tick still reaches one cmd.
 */
export class ActionState {
  /** Keys holding each action down. */
  readonly held = new Int32Array(ACTION_COUNT);
  /** 1 when the action was pressed since the last sample. */
  readonly pressed = new Uint8Array(ACTION_COUNT);

  press(action: number): void {
    this.held[action] = (this.held[action] as number) + 1;
    this.pressed[action] = 1;
  }

  release(action: number): void {
    this.held[action] = Math.max(0, (this.held[action] as number) - 1);
  }

  /** Everything up, latched presses dropped (a hidden tab, the console opening). */
  releaseAll(): void {
    this.held.fill(0);
    this.pressed.fill(0);
  }

  /** 1 when the action is held or was pressed since the last sample, else 0. */
  on(action: number): number {
    return (this.held[action] as number) > 0 || this.pressed[action] === 1 ? 1 : 0;
  }

  /** A sample consumed the latched presses. */
  endSample(): void {
    this.pressed.fill(0);
  }
}

/**
 * The player's CmdSampler: movement axes and buttons from the actions, angles from the mouse look
 * rounded to u16 units (the predictor then sanitizes the cmd as the server does).
 */
export class PlayerInput implements CmdSampler {
  constructor(
    readonly actions: ActionState,
    readonly look: MouseLook,
  ) {}

  sample(cmd: UserCmd, _ps: Readonly<PlayerState>): void {
    const a = this.actions;
    cmd.forward = (a.on(ACTION_FORWARD) - a.on(ACTION_BACK)) * MOVE_AXIS_MAX;
    cmd.right = (a.on(ACTION_MOVERIGHT) - a.on(ACTION_MOVELEFT)) * MOVE_AXIS_MAX;
    cmd.up = 0;
    cmd.buttons =
      (a.on(ACTION_JUMP) === 1 ? BUTTON_JUMP : 0) |
      (a.on(ACTION_CROUCH) === 1 ? BUTTON_CROUCH : 0) |
      (a.on(ACTION_WALK) === 1 ? BUTTON_WALK : 0) |
      (a.on(ACTION_SPRINT) === 1 ? BUTTON_SPRINT : 0) |
      (a.on(ACTION_ATTACK) === 1 ? BUTTON_ATTACK : 0);
    // degreesToU16, inlined: passing the fractional angle to a call that is not inlined boxes
    // it per tick (test/input/sampler.test.ts checks the two agree).
    const angles = this.look.angles;
    cmd.yaw = Math.round(((angles[0] as number) * 65536) / 360) & 0xffff;
    cmd.pitch = Math.round(((angles[1] as number) * 65536) / 360) & 0xffff;
    cmd.weaponSlot = 0;
    a.endSample();
  }
}
