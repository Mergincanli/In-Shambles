import {
  BUTTON_CROUCH,
  BUTTON_JUMP,
  BUTTON_WALK,
  MOVE_AXIS_MAX,
  Mulberry32,
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
 * The strafe-jump steering the circuit and the routes share: on the ground it faces the target
 * and jumps; in the air it holds forward plus a strafe and keeps the wish direction at the angle
 * to the velocity that gains the most speed (docs/03 strafe jumping), strafing toward the target
 * when it lies off the flight line and alternating sides hop by hop when it lies ahead. Jump is
 * pressed on every landing and held for a few ticks, like a real key press, so one starved cmd
 * delays a jump by a tick instead of losing it.
 *
 * Input generation, not simulation: the server receives these cmds and never recomputes them, so
 * the script may use Math's trigonometry.
 */
class StrafeSteer {
  /** The last yaw sent (u16), −1 until the first sample takes the player's. */
  yaw = -1;
  /**
   * [0], [1]: the target's x and y offset from the player (u), written before each `steer`. A
   * typed array rather than arguments: a fractional double passed to a call V8 doesn't inline is
   * boxed under native ESM.
   */
  readonly aim = new Float64Array(2);
  private jumpLeft = 0;
  private jumpWasDown = false;
  private hopSide = 1;
  private wasGrounded = true;

  constructor(
    private readonly maxSpeed: number,
    private readonly jumpHoldTicks: number,
    /**
     * On the ground, hold the next jump while the velocity points more than this far (radians)
     * off the target, so the player turns on the ground, where it can, instead of in a wide air
     * arc. Infinity (the circuit's) never holds it.
     */
    private readonly groundTurn: number = Number.POSITIVE_INFINITY,
  ) {}

  /** Clears `cmd` to standing still at the current yaw. */
  idle(cmd: UserCmd, ps: Readonly<PlayerState>): void {
    if (this.yaw < 0) this.yaw = ps.viewYaw;
    cmd.up = 0;
    cmd.pitch = 0;
    cmd.weaponSlot = 0;
    cmd.buttons = 0;
    cmd.forward = 0;
    cmd.right = 0;
    cmd.yaw = this.yaw;
  }

  /** Steers toward the target `aim` holds. */
  steer(cmd: UserCmd, ps: Readonly<PlayerState>): void {
    const target = Math.atan2(this.aim[1] as number, this.aim[0] as number);
    const v = ps.velocity;
    const vx = v[0] as number;
    const vy = v[1] as number;
    const speed = Math.sqrt(vx * vx + vy * vy);
    const grounded = (ps.flags & PMF_GROUNDED) !== 0;

    // A route's landing far off course turns on the ground: no jump until it points the way.
    let offCourse = false;
    if (grounded && this.groundTurn !== Number.POSITIVE_INFINITY && speed >= 100) {
      let off = target - Math.atan2(vy, vx);
      if (off > Math.PI) off -= 2 * Math.PI;
      else if (off < -Math.PI) off += 2 * Math.PI;
      offCourse = Math.abs(off) > this.groundTurn;
    }
    let jump = false;
    if (this.jumpLeft > 0) {
      this.jumpLeft--;
      jump = true;
    } else if (grounded && !this.jumpWasDown && !offCourse) {
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
      // Right (+1) turns clockwise, toward a target at a negative angle from the heading.
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

/**
 * The strafe-jump circuit (NET-04, `?bot=circle`): laps of a square, strafe-jumping from corner
 * to corner with `StrafeSteer`.
 */
export class StrafeCircuit implements CmdSampler {
  private readonly idleTicks: number;
  private readonly cx: number;
  private readonly cy: number;
  private readonly half: number;
  private readonly reach: number;
  private readonly steering: StrafeSteer;
  private n = 0;
  private corner = 0;

  constructor(options: StrafeCircuitOptions = {}) {
    this.idleTicks = options.idleTicks ?? 90;
    this.cx = options.centerX ?? -600;
    this.cy = options.centerY ?? -600;
    this.half = options.halfSide ?? 700;
    this.reach = options.reach ?? 160;
    this.steering = new StrafeSteer(options.maxSpeed ?? 650, options.jumpHoldTicks ?? 8);
  }

  sample(cmd: UserCmd, ps: Readonly<PlayerState>): void {
    this.steering.idle(cmd, ps);
    const i = this.n++;
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
    this.steering.aim[0] = dx;
    this.steering.aim[1] = dy;
    this.steering.steer(cmd, ps);
  }
}

/** Ticks of a stuck detector's window (M3 design §2.15: 2 s; design value). */
export const ROUTE_STUCK_WINDOW_TICKS = 120;
/** Progress toward the waypoint under which a window counts as stuck, u (design value). */
export const ROUTE_STUCK_PROGRESS = 32;
/**
 * How far off the waypoint's direction (radians, about 34°) a landed route bot runs on the ground
 * to turn before it hops again (design value, tuned on arena_greybox's ring).
 */
export const ROUTE_GROUND_TURN = 0.6;
/** Ticks of random walk that free a stuck route bot before it heads for the next waypoint. */
export const ROUTE_ESCAPE_TICKS = 60;

export interface RouteInputOptions {
  /** Ticks standing still first. Default 90 (1.5 s), as the circuit. */
  readonly idleTicks?: number;
  /** A waypoint counts as reached within this distance, u. Default 160. */
  readonly reach?: number;
  /** Above this speed the strafe only turns, it stops gaining. Default 650 u/s. */
  readonly maxSpeed?: number;
  /** Ticks jump stays held after a press on landing. Default 8. */
  readonly jumpHoldTicks?: number;
  /** Radians off the target past which a landing turns on the ground. Default ROUTE_GROUND_TURN. */
  readonly groundTurn?: number;
}

/**
 * A strafe-jump route (M3 design §2.15, the bots): laps of a closed list of waypoints, steered
 * like the circuit, except that a landing more than ROUTE_GROUND_TURN off the waypoint's direction
 * turns on the ground before it hops again (D-036). It starts at the waypoint nearest to where it
 * stands, so one route serves every spawn point. A stuck detector watches the progress toward the waypoint: under
 * ROUTE_STUCK_PROGRESS u in ROUTE_STUCK_WINDOW_TICKS, it random-walks for ROUTE_ESCAPE_TICKS
 * (`RandomWalk`, seeded) and then heads for the next waypoint. Deterministic in its samples, its
 * seed and the states it saw.
 */
export class RouteInput implements CmdSampler {
  /** Waypoints reached (laps = reached / waypoints). */
  reached = 0;
  /** Times the stuck detector fired. */
  stuckEvents = 0;
  /**
   * Ticks spent stuck: each detector window that made no progress (ROUTE_STUCK_WINDOW_TICKS) plus
   * the random walk out of it, so a share of `movingTicks` is the time the route was lost.
   */
  stuckTicks = 0;
  /** Ticks sampled after the idle start. */
  movingTicks = 0;
  private readonly xs: Float64Array;
  private readonly ys: Float64Array;
  private readonly idleTicks: number;
  private readonly reach: number;
  private readonly steering: StrafeSteer;
  private readonly walk: RandomWalk;
  private n = 0;
  /** The waypoint headed for; −1 until the first moving sample picks the nearest. */
  private target = -1;
  private escapeLeft = 0;
  private windowStart = 0;
  /** [0] the distance to the waypoint when the stuck window started (u; NaN: restart it). */
  private readonly windowDist = new Float64Array(1);

  /** `waypoints`: x, y pairs in u, visited in order and then again from the first. */
  constructor(waypoints: ArrayLike<number>, seed: number, options: RouteInputOptions = {}) {
    const n = waypoints.length >> 1;
    if (n < 2 || waypoints.length !== n * 2) throw new Error("a route needs 2+ x, y waypoints");
    this.xs = new Float64Array(n);
    this.ys = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      this.xs[i] = waypoints[i * 2] as number;
      this.ys[i] = waypoints[i * 2 + 1] as number;
    }
    this.idleTicks = options.idleTicks ?? 90;
    this.reach = options.reach ?? 160;
    this.steering = new StrafeSteer(
      options.maxSpeed ?? 650,
      options.jumpHoldTicks ?? 8,
      options.groundTurn ?? ROUTE_GROUND_TURN,
    );
    this.walk = new RandomWalk(seed, { idleTicks: 0 });
  }

  /** Waypoints on the route. */
  get waypoints(): number {
    return this.xs.length;
  }

  /** Whole laps since the first waypoint was reached. */
  get laps(): number {
    return Math.floor(this.reached / this.xs.length);
  }

  sample(cmd: UserCmd, ps: Readonly<PlayerState>): void {
    this.steering.idle(cmd, ps);
    const i = this.n++;
    if (i < this.idleTicks) return;
    this.movingTicks++;
    const startDist = this.windowDist;
    if (this.target < 0) {
      this.target = this.nearest(ps);
      startDist[0] = Number.NaN;
    }
    if (this.escapeLeft === 0) {
      // Waypoint changes only mark the window for a restart (NaN): this hot path restarts it, so
      // no rarely run method handles doubles (unoptimized code boxes them).
      const aim = this.steering.aim;
      this.aimAt(ps);
      let ax = aim[0] as number;
      let ay = aim[1] as number;
      if (ax * ax + ay * ay < this.reach * this.reach) {
        this.reached++;
        this.target = (this.target + 1) % this.xs.length;
        startDist[0] = Number.NaN;
        this.aimAt(ps);
        ax = aim[0] as number;
        ay = aim[1] as number;
      }
      const dist = Math.sqrt(ax * ax + ay * ay);
      if (Number.isNaN(startDist[0] as number)) {
        this.windowStart = this.n;
        startDist[0] = dist;
      }
      if (this.n - this.windowStart < ROUTE_STUCK_WINDOW_TICKS) {
        this.steering.steer(cmd, ps);
        return;
      }
      if ((startDist[0] as number) - dist >= ROUTE_STUCK_PROGRESS) {
        this.windowStart = this.n;
        startDist[0] = dist;
        this.steering.steer(cmd, ps);
        return;
      }
      this.stuckEvents++;
      this.stuckTicks += ROUTE_STUCK_WINDOW_TICKS;
      this.escapeLeft = ROUTE_ESCAPE_TICKS;
    }
    this.escapeLeft--;
    this.stuckTicks++;
    this.walk.sample(cmd, ps);
    // The walk turns the player; the steering picks up from the yaw it sent.
    this.steering.yaw = cmd.yaw & 0xffff;
    if (this.escapeLeft === 0) {
      this.target = (this.target + 1) % this.xs.length;
      startDist[0] = Number.NaN;
    }
  }

  /** The waypoint's offset from the player into the steering's `aim`. */
  private aimAt(ps: Readonly<PlayerState>): void {
    const aim = this.steering.aim;
    aim[0] = (this.xs[this.target] as number) - (ps.origin[0] as number);
    aim[1] = (this.ys[this.target] as number) - (ps.origin[1] as number);
  }

  /** The waypoint nearest to the player (once, at the first moving sample). */
  private nearest(ps: Readonly<PlayerState>): number {
    const x = ps.origin[0] as number;
    const y = ps.origin[1] as number;
    let best = 0;
    let bestD = Number.POSITIVE_INFINITY;
    for (let k = 0; k < this.xs.length; k++) {
      const dx = (this.xs[k] as number) - x;
      const dy = (this.ys[k] as number) - y;
      const d = dx * dx + dy * dy;
      if (d < bestD) {
        bestD = d;
        best = k;
      }
    }
    return best;
  }
}

/** Shortest and longest time between RandomWalk's heading changes, ticks (1–3 s, design). */
export const WALK_TURN_MIN_TICKS = 60;
export const WALK_TURN_MAX_TICKS = 180;
/** Ticks a hopping walk holds jump per press, as the circuit's key press. */
const WALK_JUMP_HOLD_TICKS = 8;

export interface RandomWalkOptions {
  /** Ticks standing still first. Default 90 (1.5 s). */
  readonly idleTicks?: number;
}

/**
 * A random walk (M3 design §2.15, the bots): runs forward on a heading drawn every 1–3 s; on
 * about half of the headings it also hops, pressing jump whenever it stands (held 8 ticks). Seeded
 * Mulberry32, drawn only when a heading changes, so the walk is a pure function of its seed, its
 * sample count and the states it saw.
 */
export class RandomWalk implements CmdSampler {
  private readonly rng: Mulberry32;
  private readonly idleTicks: number;
  private n = 0;
  private yaw = -1;
  private turnLeft = 0;
  private hopping = false;
  private jumpLeft = 0;
  private jumpWasDown = false;

  constructor(seed: number, options: RandomWalkOptions = {}) {
    this.rng = new Mulberry32(seed);
    this.idleTicks = options.idleTicks ?? 90;
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
    if (i >= this.idleTicks) {
      if (this.turnLeft <= 0) {
        const r = this.rng;
        this.yaw = r.nextU32() & 0xffff;
        this.turnLeft =
          WALK_TURN_MIN_TICKS + (r.nextU32() % (WALK_TURN_MAX_TICKS - WALK_TURN_MIN_TICKS + 1));
        this.hopping = (r.nextU32() & 1) === 1;
      }
      this.turnLeft--;
      cmd.forward = MOVE_AXIS_MAX;
      let jump = false;
      if (this.jumpLeft > 0) {
        this.jumpLeft--;
        jump = true;
      } else if (this.hopping && (ps.flags & PMF_GROUNDED) !== 0 && !this.jumpWasDown) {
        this.jumpLeft = WALK_JUMP_HOLD_TICKS - 1;
        jump = true;
      }
      this.jumpWasDown = jump;
      if (jump) cmd.buttons = BUTTON_JUMP;
    }
    cmd.yaw = this.yaw;
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
