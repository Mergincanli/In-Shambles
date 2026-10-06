import {
  BUTTON_JUMP,
  cmdScale,
  cosU16,
  MOVE_AXIS_MAX,
  type PlayerState,
  PMF_GROUNDED,
  type PmoveParams,
  sinU16,
  UserCmd,
  vec3,
} from "@game/shared";
import type { CmdSource } from "./runner";

/**
 * Scripted cmd sources for the movement scenarios (M2 design §1, §5). Each bot is a small state
 * machine that reads the state a tick starts from, like a player reacting to the last frame. They
 * use only exact operations and the u16 trig table (D-016), so a run is the same on every machine.
 */

function setCmd(
  cmd: UserCmd,
  forward: number,
  right: number,
  buttons: number,
  yaw: number,
  pitch: number,
): void {
  cmd.forward = forward;
  cmd.right = right;
  cmd.up = 0;
  cmd.buttons = buttons;
  cmd.yaw = yaw;
  cmd.pitch = pitch;
  cmd.weaponSlot = 0;
}

export interface HoldOptions {
  /** −127..127; default 127 (full forward). */
  readonly forward?: number;
  readonly right?: number;
  /** BUTTON_* bits held throughout, e.g. BUTTON_WALK. */
  readonly buttons?: number;
  /** u16; default 0. */
  readonly pitch?: number;
  /**
   * Release every input, for the rest of the run, once the origin's coordinate on `axis` reaches
   * `at` (≥). The step, stair and slope runs use it to stop on the top instead of running off
   * its far edge.
   */
  readonly release?: { readonly axis: 0 | 1 | 2; readonly at: number };
}

/** Holds the same input every tick: run (the default), walk, strafe, or nothing. */
export class HoldInput implements CmdSource {
  private readonly forward: number;
  private readonly right: number;
  private readonly buttons: number;
  private readonly pitch: number;
  private readonly releaseAxis: number;
  private readonly releaseAt: number;
  /** Whether the release line has been reached. */
  released = false;

  constructor(
    private readonly yaw: number,
    options: HoldOptions = {},
  ) {
    this.forward = options.forward ?? MOVE_AXIS_MAX;
    this.right = options.right ?? 0;
    this.buttons = options.buttons ?? 0;
    this.pitch = options.pitch ?? 0;
    this.releaseAxis = options.release?.axis ?? -1;
    this.releaseAt = options.release?.at ?? 0;
  }

  next(cmd: UserCmd, ps: PlayerState): void {
    if (this.releaseAxis >= 0 && (ps.origin[this.releaseAxis] as number) >= this.releaseAt) {
      this.released = true;
    }
    if (this.released) setCmd(cmd, 0, 0, 0, this.yaw, this.pitch);
    else setCmd(cmd, this.forward, this.right, this.buttons, this.yaw, this.pitch);
  }
}

/** No input at all, facing `yaw`. */
export function idle(yaw = 0): HoldInput {
  return new HoldInput(yaw, { forward: 0 });
}

export interface HopOptions {
  /** Ticks of plain running before the first jump; default 60 (1 s, at the run cap). */
  readonly runUpTicks?: number;
  /** Jumps to make; afterwards the bot keeps running. */
  readonly hops: number;
  /** Forward axis, −127..127; default 127. 0 with `runUpTicks: 0` is a standing jump (MV-04). */
  readonly forward?: number;
}

/**
 * Straight hops (MV-07): forward held at a fixed yaw, jump pressed whenever a tick starts
 * grounded and released in the air, so every landing gets a fresh press (pm_autoHop 0) and the
 * jump comes before friction on the tick after the landing.
 */
export class HopForward implements CmdSource {
  private readonly runUpTicks: number;
  private readonly hops: number;
  private readonly forward: number;
  private ticks = 0;
  /** Jump presses made so far. */
  jumps = 0;

  constructor(
    private readonly yaw: number,
    options: HopOptions,
  ) {
    this.runUpTicks = options.runUpTicks ?? 60;
    this.hops = options.hops;
    this.forward = options.forward ?? MOVE_AXIS_MAX;
  }

  next(cmd: UserCmd, ps: PlayerState): void {
    const t = this.ticks++;
    let buttons = 0;
    if (t >= this.runUpTicks && this.jumps < this.hops && (ps.flags & PMF_GROUNDED) !== 0) {
      buttons = BUTTON_JUMP;
      this.jumps++;
    }
    setCmd(cmd, this.forward, 0, buttons, this.yaw, 0);
  }
}

const YAWS = 65536;

export interface StrafeOptions extends Omit<HopOptions, "forward"> {
  /** Strafe side of the first hop: 1 = right, −1 = left. It alternates every hop. */
  readonly firstSide?: 1 | -1;
}

/**
 * The scripted ideal strafe-jumper (docs/03 §8 MV-08): runs up at `yaw`, then hops like
 * HopForward while holding forward plus a strafe key, the side alternating each hop. Every
 * airborne tick, and every jump tick (the jump runs the air move), it picks the u16 yaw whose
 * air acceleration leaves the most horizontal speed, by exact search over all 65536 yaws with
 * the accelerate formula of docs/03 §4.3. The wish direction for each yaw is built as the air
 * move builds it (sinU16/cosU16 basis, cmdScale), once per side, so the search is exact
 * arithmetic only (D-016) and the same on every machine. It ignores walls: the open floor has
 * none.
 */
export class StrafeHop implements CmdSource {
  private readonly runUpTicks: number;
  private readonly hops: number;
  /** Wish velocity (x, y) per yaw for side +1 and side −1. */
  private readonly wishRight: Float64Array;
  private readonly wishLeft: Float64Array;
  private readonly accelStep: number;
  private side: number;
  private ticks = 0;
  /** Jump presses made so far. */
  jumps = 0;

  constructor(
    private readonly yaw: number,
    params: Readonly<PmoveParams>,
    dt: number,
    options: StrafeOptions,
  ) {
    this.runUpTicks = options.runUpTicks ?? 60;
    this.hops = options.hops;
    this.side = options.firstSide ?? 1;
    this.wishRight = StrafeHop.wishTable(params, 1);
    this.wishLeft = StrafeHop.wishTable(params, -1);
    // accelerate: the most speed one tick adds along wishDir is pm_airAccelerate · dt · wishSpeed.
    this.accelStep = params.airAccelerate * dt;
  }

  /** wishVel (x, y) for every yaw, as airMove builds it with pitch 0 and no walk or crouch. */
  private static wishTable(params: Readonly<PmoveParams>, side: number): Float64Array {
    const cmd = new UserCmd();
    cmd.forward = MOVE_AXIS_MAX;
    cmd.right = side * MOVE_AXIS_MAX;
    const axes = vec3();
    cmdScale(axes, cmd, 0, false, params);
    const out = new Float64Array(2 * YAWS);
    for (let a = 0; a < YAWS; a++) {
      // Pitch 0: forward = (cos, sin, 0), right = (sin, −cos, 0), each normalized as airMove does.
      const c = cosU16(a);
      const s = sinU16(a);
      const len = Math.sqrt(c * c + s * s);
      const fx = c / len;
      const fy = s / len;
      const rx = s / len;
      const ry = (0 - c) / len;
      out[2 * a] = fx * axes[0] + rx * axes[1] + 0;
      out[2 * a + 1] = fy * axes[0] + ry * axes[1] + 0;
    }
    return out;
  }

  next(cmd: UserCmd, ps: PlayerState): void {
    const t = this.ticks++;
    if (t < this.runUpTicks) {
      setCmd(cmd, MOVE_AXIS_MAX, 0, 0, this.yaw, 0);
      return;
    }
    let buttons = 0;
    const grounded = (ps.flags & PMF_GROUNDED) !== 0;
    if (grounded && this.jumps < this.hops) {
      buttons = BUTTON_JUMP;
      if (this.jumps > 0) this.side = -this.side;
      this.jumps++;
    }
    if (grounded && buttons === 0) {
      // Done hopping: run on along the velocity.
      setCmd(cmd, MOVE_AXIS_MAX, 0, 0, ps.viewYaw, 0);
      return;
    }
    const yaw = this.bestYaw(ps.velocity);
    setCmd(cmd, MOVE_AXIS_MAX, this.side * MOVE_AXIS_MAX, buttons, yaw, 0);
  }

  /**
   * The yaw maximizing |v'|² for v' = accelerate(v, wishVel(yaw)) (docs/03 §4.3) on the
   * horizontal part of `velocity`; the lowest such yaw wins a tie. The velocity comes in as an
   * array and the loop's doubles stay in locals: a double crossing a call that isn't inlined is
   * boxed under native ESM.
   */
  bestYaw(velocity: Readonly<Float64Array>): number {
    const table = this.side > 0 ? this.wishRight : this.wishLeft;
    const step = this.accelStep;
    const vx = velocity[0] as number;
    const vy = velocity[1] as number;
    let best = -1;
    let bestYaw = 0;
    for (let a = 0; a < YAWS; a++) {
      const wx = table[2 * a] as number;
      const wy = table[2 * a + 1] as number;
      const wishSpeed = Math.sqrt(wx * wx + wy * wy);
      let nx = vx;
      let ny = vy;
      if (wishSpeed > 0) {
        const add = wishSpeed - (vx * wx + vy * wy) / wishSpeed;
        if (add > 0) {
          const k = Math.min(step * wishSpeed, add) / wishSpeed;
          nx = vx + wx * k;
          ny = vy + wy * k;
        }
      }
      const speed2 = nx * nx + ny * ny;
      if (speed2 > best) {
        best = speed2;
        bestYaw = a;
      }
    }
    return bestYaw;
  }
}
