import { FRAME_SLOTS, ORIGIN_SCALE, PMF_CROUCHED, type WorldFrame } from "@game/shared";

/** Degrees per u16 angle unit. */
const DEG_PER_U16 = 360 / 65536;

/**
 * What the renderer draws of the other players (M3 design §2.8 "Output"): one row per slot, in
 * sim units, filled once per frame. The renderer reads only this, never a snapshot.
 *
 * Until remote interpolation (D-037, increment 7) it is the newest stored frame as it stands
 * (`fillFromFrame`), so remotes move in 60 Hz steps and pause on a lost snapshot; increment 7's
 * `RemoteInterpolator` fills the same rows from the bracketing frames.
 */
export class RemoteView {
  /** Origin, u. */
  readonly x = new Float64Array(FRAME_SLOTS);
  readonly y = new Float64Array(FRAME_SLOTS);
  readonly z = new Float64Array(FRAME_SLOTS);
  /** View angles, degrees: yaw in [0, 360), pitch positive looking down. */
  readonly yaw = new Float64Array(FRAME_SLOTS);
  readonly pitch = new Float64Array(FRAME_SLOTS);
  /** 1 while the player crouches (PMF_CROUCHED). */
  readonly crouched = new Uint8Array(FRAME_SLOTS);
  /** TEAM_*. */
  readonly team = new Uint8Array(FRAME_SLOTS);
  /** 1 for a slot to draw. */
  readonly visible = new Uint8Array(FRAME_SLOTS);
  /**
   * 1 on the frame a slot appeared or its teleport counter changed (D-035): it jumped there, so
   * nothing may smooth it from its last place.
   */
  readonly teleported = new Uint8Array(FRAME_SLOTS);
  /** 1 while a slot is drawn past its newest snapshot (increment 7; always 0 before). */
  readonly extrapolating = new Uint8Array(FRAME_SLOTS);
  /** Visible slots. */
  count = 0;
  /** Each slot's teleport counter when last drawn. */
  private readonly lastSeq = new Uint8Array(FRAME_SLOTS);

  /** Hides every slot. */
  clear(): void {
    this.visible.fill(0);
    this.teleported.fill(0);
    this.extrapolating.fill(0);
    this.count = 0;
  }

  /**
   * Every other player of `f` (a stored frame) as it stands, the receiver `selfId` and pending
   * slots (present, no state yet: D-046) left out. Allocation-free.
   */
  fillFromFrame(f: WorldFrame, selfId: number): void {
    let n = 0;
    for (let s = 0; s < FRAME_SLOTS; s++) {
      if (s === selfId || f.present[s] !== 1 || f.stamp[s] === 0) {
        this.visible[s] = 0;
        this.teleported[s] = 0;
        continue;
      }
      const seq = f.teleportSeq[s] as number;
      this.teleported[s] = this.visible[s] === 0 || this.lastSeq[s] !== seq ? 1 : 0;
      this.lastSeq[s] = seq;
      this.visible[s] = 1;
      this.extrapolating[s] = 0;
      this.x[s] = (f.originX[s] as number) / ORIGIN_SCALE;
      this.y[s] = (f.originY[s] as number) / ORIGIN_SCALE;
      this.z[s] = (f.originZ[s] as number) / ORIGIN_SCALE;
      this.yaw[s] = (f.yaw[s] as number) * DEG_PER_U16;
      this.pitch[s] = (f.pitch[s] as number) * DEG_PER_U16;
      this.crouched[s] = ((f.flags[s] as number) & PMF_CROUCHED) !== 0 ? 1 : 0;
      this.team[s] = f.team[s] as number;
      n++;
    }
    this.count = n;
  }
}
