import { type Vec3, vec3 } from "@game/shared";

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
