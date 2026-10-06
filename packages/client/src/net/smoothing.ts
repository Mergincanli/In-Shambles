import { type Vec3, vec3 } from "@game/shared";
import { TICK_MS } from "./clock";

// Slots of RenderOffset.s.
const START_X = 0;
const START_TIME = 3;
const DURATION = 4;

/**
 * The visual half of a correction (docs/05 §5 step 4, M2 design §2): the old render position
 * minus the new one, added to the drawn position and decaying linearly to zero over
 * `cl_correctionSmoothMs`, so a reconciled player glides instead of jumping. The simulation state
 * stays exact; only the drawing moves (rule: smoothing applies to render offsets only).
 *
 * A new offset adds to whatever remains and restarts the decay. Time comes from the caller's
 * clock slot `now[0]` (ms), so no fractional double crosses a call per frame.
 */
export class RenderOffset {
  /** [0..2] the offset when the decay last restarted, [3] that time (ms), [4] its duration. */
  private readonly s = new Float64Array(5);
  private readonly remaining = vec3();

  constructor(private readonly now: Float64Array) {}

  /** Adds `d` to the offset left now and restarts the decay over `durationMs` (0 = no smoothing). */
  add(d: Readonly<Vec3>, durationMs: number): void {
    const r = this.remaining;
    this.sample(r);
    const s = this.s;
    s[START_X] = (r[0] as number) + (d[0] as number);
    s[START_X + 1] = (r[1] as number) + (d[1] as number);
    s[START_X + 2] = (r[2] as number) + (d[2] as number);
    s[START_TIME] = this.now[0] as number;
    s[DURATION] = Math.max(0, durationMs);
  }

  /** Drops the offset at once (teleports and snaps). */
  clear(): void {
    this.s.fill(0);
  }

  /** The offset now, into `out`. */
  sample(out: Vec3): void {
    const s = this.s;
    const duration = s[DURATION] as number;
    let k = 0;
    if (duration > 0) {
      k = Math.max(0, 1 - ((this.now[0] as number) - (s[START_TIME] as number)) / duration);
    }
    out[0] = (s[START_X] as number) * k;
    out[1] = (s[START_X + 1] as number) * k;
    out[2] = (s[START_X + 2] as number) * k;
  }
}

/** Steps the smoother tracks at once; a ninth overwrites the oldest. */
export const STEP_SMOOTH_SLOTS = 8;
/** The summed step offset never exceeds this, u (M2 design §2). */
export const STEP_SMOOTH_MAX = 32;

/**
 * Smooths the view over step-ups (and step-downs) (M2 design §2, docs/06 §7): a STEP event lifts
 * the predicted origin by Δz within one tick, which interpolation would draw as a 16.7 ms jolt.
 * The offset first cancels that rise while the step's tick is being interpolated, so the eye
 * holds its height, then decays linearly to zero over `cl_stepSmoothMs`. Several steps (stairs)
 * add up, capped at STEP_SMOOTH_MAX.
 *
 * Time is render-tick time from the caller's slot `time[0]`: the drawn position is
 * `time[0]` ticks along the predicted path (latestTick − 1 + the accumulator's fraction), so the
 * offset follows the very interpolation it cancels. Presentation only: the predicted state is
 * never touched.
 */
export class StepSmoother {
  private readonly tick = new Float64Array(STEP_SMOOTH_SLOTS);
  private readonly dz = new Float64Array(STEP_SMOOTH_SLOTS);
  /** Decay length per slot, in ticks. */
  private readonly decay = new Float64Array(STEP_SMOOTH_SLOTS);
  private next = 0;

  constructor(private readonly time: Float64Array) {}

  /** A STEP of `dz` u at `tick`, its offset decaying over `durationMs` once the tick is drawn. */
  add(tick: number, dz: number, durationMs: number): void {
    const i = this.next;
    this.next = (i + 1) % STEP_SMOOTH_SLOTS;
    this.tick[i] = tick;
    this.dz[i] = dz;
    this.decay[i] = Math.max(0, durationMs) / TICK_MS;
  }

  clear(): void {
    this.dz.fill(0);
  }

  /**
   * The render-tick clock jumped by `ticks` (ClientSim.pathShift: a fast-forward, a hold or a
   * re-anchor): moves every step with it, so the offsets carry on from where they were drawn.
   */
  shift(ticks: number): void {
    if (ticks === 0) return;
    const t = this.tick;
    for (let i = 0; i < STEP_SMOOTH_SLOTS; i++) t[i] = (t[i] as number) + ticks;
  }

  /** The vertical view offset now (u) into `out[index]`. */
  sample(out: Float64Array, index: number): void {
    const r = this.time[0] as number;
    let sum = 0;
    for (let i = 0; i < STEP_SMOOTH_SLOTS; i++) {
      const dz = this.dz[i] as number;
      if (dz === 0) continue;
      const tick = this.tick[i] as number;
      if (r <= tick - 1) continue;
      if (r < tick) {
        // The interpolation is rising through the step: hold the eye where it was.
        sum -= dz * (r - (tick - 1));
        continue;
      }
      const decay = this.decay[i] as number;
      const k = decay > 0 ? 1 - (r - tick) / decay : 0;
      if (k <= 0) {
        this.dz[i] = 0;
        continue;
      }
      sum -= dz * k;
    }
    out[index] = Math.min(STEP_SMOOTH_MAX, Math.max(-STEP_SMOOTH_MAX, sum));
  }
}

/**
 * The eye height above the origin for the stance (docs/06 §7 "view height smoothing"), moving
 * linearly toward the stance's height (VIEW_HEIGHT_STANDING or _CROUCHED, the caller's choice) at
 * the rate that covers the gap between `from` and `to` in `cl_viewHeightSmoothMs`. Time is the
 * caller's ms clock slot `now[0]`; `height[0]` is the current value.
 */
export class ViewHeight {
  readonly height = new Float64Array(1);
  /** [0] the last update's time (ms), NaN before the first. */
  private readonly last = new Float64Array([Number.NaN]);

  constructor(private readonly now: Float64Array) {}

  /** Snaps to `target` (spawn, teleport). */
  reset(target: number): void {
    this.height[0] = target;
    this.last[0] = this.now[0] as number;
  }

  /** Moves toward `target`, `span` u per `durationMs` (0 = at once). */
  update(target: number, span: number, durationMs: number): void {
    const now = this.now[0] as number;
    const last = this.last[0] as number;
    this.last[0] = now;
    const h = this.height[0] as number;
    if (Number.isNaN(last) || durationMs <= 0) {
      this.height[0] = target;
      return;
    }
    const step = (Math.abs(span) * Math.max(0, now - last)) / durationMs;
    this.height[0] = h < target ? Math.min(target, h + step) : Math.max(target, h - step);
  }
}
