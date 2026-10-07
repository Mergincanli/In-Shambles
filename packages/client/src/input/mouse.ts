/**
 * Mouse look (docs/06 §7 "Input", M2 design §2 "Mouse"): raw counts in, view angles out, with no
 * smoothing or acceleration. Counts gathered between frames are applied once at the start of the
 * next frame, before its ticks sample the angles, so the camera and the cmds see the same turn.
 * The camera uses these live float angles; each cmd carries them rounded to u16 units
 * (sampler.ts). DOM-free except `attachMouse`, so the maths is tested in Node.
 */

/** Pitch stops short of straight up and down (docs/03 §2: ±89°). */
export const PITCH_LIMIT_DEG = 89;

/** What `apply` reads: the CLIENT_CVARS sensitivity fields (console/clientCvars.ts). */
export interface LookSettings {
  readonly sensitivity: number;
  readonly mYaw: number;
  readonly mPitch: number;
}

export class MouseLook {
  /** [0] yaw in [0, 360), [1] pitch in ±PITCH_LIMIT_DEG (degrees, positive looks down). */
  readonly angles = new Float64Array(2);
  /** Counts since the last `apply`: [0] x (right), [1] y (down). */
  private readonly pending = new Float64Array(2);

  /** One mouse event's movement, in counts. */
  addCounts(dx: number, dy: number): void {
    if (!Number.isFinite(dx) || !Number.isFinite(dy)) return;
    this.pending[0] = (this.pending[0] as number) + dx;
    this.pending[1] = (this.pending[1] as number) + dy;
  }

  /** Turns by the pending counts: yaw −= dx·sensitivity·m_yaw, pitch += dy·sensitivity·m_pitch. */
  apply(s: LookSettings): void {
    const p = this.pending;
    const a = this.angles;
    let yaw = (a[0] as number) - (p[0] as number) * s.sensitivity * s.mYaw;
    yaw %= 360;
    if (yaw < 0) yaw += 360;
    // −1e-15 + 360 rounds to 360.
    if (yaw >= 360) yaw = 0;
    a[0] = yaw;
    const pitch = (a[1] as number) + (p[1] as number) * s.sensitivity * s.mPitch;
    a[1] = Math.min(PITCH_LIMIT_DEG, Math.max(-PITCH_LIMIT_DEG, pitch));
    p[0] = 0;
    p[1] = 0;
  }

  /** Faces `yawDeg`, `pitchDeg` (a spawn) and drops pending counts. */
  set(yawDeg: number, pitchDeg: number): void {
    let yaw = yawDeg % 360;
    if (yaw < 0) yaw += 360;
    if (yaw >= 360) yaw = 0;
    this.angles[0] = yaw;
    this.angles[1] = Math.min(PITCH_LIMIT_DEG, Math.max(-PITCH_LIMIT_DEG, pitchDeg));
    this.pending[0] = 0;
    this.pending[1] = 0;
  }
}

/** Feeds `look` from mouse movement while `captured()` (pointer lock); returns a detach. */
export function attachMouse(doc: Document, look: MouseLook, captured: () => boolean): () => void {
  const move = (e: MouseEvent) => {
    if (captured()) look.addCounts(e.movementX, e.movementY);
  };
  doc.addEventListener("mousemove", move);
  return () => doc.removeEventListener("mousemove", move);
}
