import {
  BUTTON_CROUCH,
  BUTTON_JUMP,
  BUTTON_WALK,
  MOVE_AXIS_MAX,
  type PlayerState,
  PMF_GROUNDED,
  type UserCmd,
} from "@game/shared";
import { type CmdSampler, NeutralInput } from "./clientSim";

/**
 * Scripted input (M2 design §1): cmd sources that play by themselves, for the NET tests, the
 * browser smoke test (`?bot=circle`) and the M3 bots. Each reads the predicted state a tick starts
 * from, like a player reacting to the last frame, and counts its own samples, so a script is a
 * pure function of its sample count and the states it saw.
 */

/** u16 angle units per radian. */
const U16_PER_RADIAN = 65536 / (2 * Math.PI);
/**
 * Speed past which a wish direction can no longer add speed in the air: the run speed less one
 * tick of air acceleration (pm_runSpeed 320 × (1 − pm_airAccelerate 1 / 60), the defaults).
 */
const AIR_GAIN_SPEED = 320 - 320 / 60;

export interface StrafeCircuitOptions {
  /** Ticks standing still first (the clock settles while nothing moves). Default 90 (1.5 s). */
  readonly idleTicks?: number;
  /** Centre of the square circuit, u. Default (−600, −600), on movement_lab's open floor. */
  readonly centerX?: number;
  readonly centerY?: number;
  /** Half the square's side, u. Default 700. */
  readonly halfSide?: number;
  /** A corner counts as reached within this distance, u. Default 160. */
  readonly reach?: number;
  /** Above this speed the strafe only turns, it stops gaining. Default 650 u/s. */
  readonly maxSpeed?: number;
  /** Ticks jump stays held after a press on landing, as a key press lasts. Default 8. */
  readonly jumpHoldTicks?: number;
}

/**
 * The strafe-jump circuit (NET-04, `?bot=circle`): laps of a square, strafe-jumping from corner
 * to corner. On the ground it faces the next corner and jumps; in the air it holds forward plus a
 * strafe and keeps the wish direction at the angle to the velocity that gains the most speed
 * (docs/03 strafe jumping), strafing toward the corner when it lies off the flight line and
 * alternating sides hop by hop when it lies ahead. Jump is pressed on every landing and held for
 * a few ticks, like a real key press, so one starved cmd delays a jump by a tick instead of
 * losing it.
 *
 * Input generation, not simulation: the server receives these cmds and never recomputes them, so
 * the script may use Math's trigonometry.
 */
export class StrafeCircuit implements CmdSampler {
  private readonly idleTicks: number;
  private readonly cx: number;
  private readonly cy: number;
  private readonly half: number;
  private readonly reach: number;
  private readonly maxSpeed: number;
  private readonly jumpHoldTicks: number;
  private n = 0;
  private yaw = -1;
  private corner = 0;
  private jumpLeft = 0;
  private jumpWasDown = false;
  private hopSide = 1;
  private wasGrounded = true;

  constructor(options: StrafeCircuitOptions = {}) {
    this.idleTicks = options.idleTicks ?? 90;
    this.cx = options.centerX ?? -600;
    this.cy = options.centerY ?? -600;
    this.half = options.halfSide ?? 700;
    this.reach = options.reach ?? 160;
    this.maxSpeed = options.maxSpeed ?? 650;
    this.jumpHoldTicks = options.jumpHoldTicks ?? 8;
  }

  sample(cmd: UserCmd, ps: Readonly<PlayerState>): void {
    if (this.yaw < 0) this.yaw = ps.viewYaw;
    const i = this.n++;
    cmd.up = 0;
    cmd.pitch = 0;
    cmd.weaponSlot = 0;
    cmd.buttons = 0;
    cmd.forward = 0;
    cmd.right = 0;
    cmd.yaw = this.yaw;
    if (i < this.idleTicks) return;

    // Corners anticlockwise: (+,+), (−,+), (−,−), (+,−).
    const o = ps.origin;
    let dx = 0;
    let dy = 0;
    for (let k = 0; k < 2; k++) {
      const sx = this.corner === 0 || this.corner === 3 ? 1 : -1;
      const sy = this.corner < 2 ? 1 : -1;
      dx = this.cx + sx * this.half - (o[0] as number);
      dy = this.cy + sy * this.half - (o[1] as number);
      if (dx * dx + dy * dy >= this.reach * this.reach) break;
      this.corner = (this.corner + 1) & 3;
    }
    const target = Math.atan2(dy, dx);
    const v = ps.velocity;
    const vx = v[0] as number;
    const vy = v[1] as number;
    const speed = Math.sqrt(vx * vx + vy * vy);
    const grounded = (ps.flags & PMF_GROUNDED) !== 0;

    let jump = false;
    if (this.jumpLeft > 0) {
      this.jumpLeft--;
      jump = true;
    } else if (grounded && !this.jumpWasDown) {
      this.jumpLeft = this.jumpHoldTicks - 1;
      jump = true;
    }
    this.jumpWasDown = jump;
    if (grounded && !this.wasGrounded) this.hopSide = -this.hopSide;
    this.wasGrounded = grounded;

    let yaw = target;
    cmd.forward = MOVE_AXIS_MAX;
    if (!grounded && speed > 100) {
      const heading = Math.atan2(vy, vx);
      let diff = target - heading;
      if (diff > Math.PI) diff -= 2 * Math.PI;
      else if (diff < -Math.PI) diff += 2 * Math.PI;
      // Right (+1) turns clockwise, toward a corner at a negative angle from the heading.
      let side = this.hopSide;
      if (diff < -0.17) side = 1;
      else if (diff > 0.17) side = -1;
      const theta =
        speed > this.maxSpeed ? Math.PI / 2 : Math.acos(Math.min(1, AIR_GAIN_SPEED / speed));
      // Forward plus a strafe wishes 45° off the yaw toward the strafe side.
      yaw = heading - side * theta + (side * Math.PI) / 4;
      cmd.right = side * MOVE_AXIS_MAX;
    }
    this.yaw = Math.round(yaw * U16_PER_RADIAN) & 0xffff;
    cmd.yaw = this.yaw;
    cmd.buttons = jump ? BUTTON_JUMP : 0;
  }
}

/** Ticks per phase of MixedInput. */
export const MIXED_PHASE_TICKS = 150;
/** Phases of MixedInput's cycle. */
export const MIXED_PHASES = 8;

/**
 * A mixed session for NET-03 (docs/05 §5): idle, running, strafe-jumping, crouch-walking,
 * walking backwards, jump spam, looking around, and raw input out of every range a sampler could
 * produce (axes past ±127 and −128, NaN and fractions, yaw past u16, pitch past ±89°, spare button
 * bits, a bad weapon slot). The predictor sanitizes it as the server does, so prediction must
 * still match exactly. Every moving phase turns, so the player circles near the start.
 */
export class MixedInput implements CmdSampler {
  private n = 0;
  private yaw = -1;

  sample(cmd: UserCmd, ps: Readonly<PlayerState>): void {
    if (this.yaw < 0) this.yaw = ps.viewYaw;
    const i = this.n++;
    const k = i % MIXED_PHASE_TICKS;
    const phase = ((i / MIXED_PHASE_TICKS) | 0) % MIXED_PHASES;
    cmd.buttons = 0;
    cmd.forward = 0;
    cmd.right = 0;
    cmd.up = 0;
    cmd.pitch = 0;
    cmd.weaponSlot = 0;
    if (phase !== 0) this.yaw = (this.yaw + 200) & 0xffff;
    cmd.yaw = this.yaw;
    switch (phase) {
      case 0: // idle
        break;
      case 1: // run
        cmd.forward = MOVE_AXIS_MAX;
        break;
      case 2: // strafe-jump, jump held for six ticks every 40
        cmd.forward = MOVE_AXIS_MAX;
        cmd.right = -MOVE_AXIS_MAX;
        cmd.buttons = k % 40 < 6 ? BUTTON_JUMP : 0;
        break;
      case 3: // crouch-walk
        cmd.forward = MOVE_AXIS_MAX;
        cmd.buttons = BUTTON_CROUCH;
        break;
      case 4: // walk backwards with a strafe
        cmd.forward = -MOVE_AXIS_MAX;
        cmd.right = 64;
        cmd.buttons = BUTTON_WALK;
        break;
      case 5: // out of range
        cmd.forward = k % 3 === 0 ? 300 : k % 3 === 1 ? Number.NaN : 12.7;
        cmd.right = k % 2 === 0 ? -128 : -200.5;
        cmd.up = 999;
        cmd.buttons = 0xffff;
        cmd.yaw = this.yaw + 70000;
        cmd.pitch = k % 2 === 0 ? 30000 : -30000;
        cmd.weaponSlot = 99;
        break;
      case 6: // jump spam while strafing
        cmd.forward = MOVE_AXIS_MAX;
        cmd.right = MOVE_AXIS_MAX;
        cmd.buttons = k % 2 === 0 ? BUTTON_JUMP : 0;
        break;
      default: // look around: pitch sweeps past the limits both ways
        cmd.forward = 64;
        cmd.pitch = ((k * 437) & 0xffff) - 32768;
        break;
    }
  }
}

/** Names `createScriptedInput` knows (`?bot=<name>`). */
export const SCRIPTED_INPUTS = ["idle", "circle", "mixed"] as const;

/** A fresh script by name, or null for an unknown one. */
export function createScriptedInput(name: string): CmdSampler | null {
  switch (name) {
    case "idle":
      return new NeutralInput();
    case "circle":
      return new StrafeCircuit();
    case "mixed":
      return new MixedInput();
    default:
      return null;
  }
}
