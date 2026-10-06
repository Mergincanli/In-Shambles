import { type PlayerState, PMF_GROUNDED, PMF_ON_LADDER } from "@game/shared";

/**
 * The speedometer (M2 design §2 "HUD", `cl_speedometer`): horizontal and vertical speed of the
 * predicted player and how it moves (the pmove mode the flags and water level name). A read-only
 * view of the prediction; text is built at the HUD's ≤ 15 Hz, never per frame.
 */

export type MoveState = "ladder" | "water" | "ground" | "air";

/** The mode pmove dispatches on (ladder, then swimming at water level ≥ 2, then ground or air). */
export function moveState(ps: Readonly<PlayerState>): MoveState {
  if ((ps.flags & PMF_ON_LADDER) !== 0) return "ladder";
  if (ps.waterLevel >= 2) return "water";
  return (ps.flags & PMF_GROUNDED) !== 0 ? "ground" : "air";
}

/** "320 u/s  vz −270  air": horizontal speed, vertical velocity (u/s, rounded) and mode. */
export function speedometerText(ps: Readonly<PlayerState>): string {
  const v = ps.velocity;
  const h = Math.round(Math.hypot(v[0] as number, v[1] as number));
  const vz = Math.round(v[2] as number);
  return `${h} u/s  vz ${vz === 0 ? 0 : vz}  ${moveState(ps)}`;
}

export class Speedometer {
  constructor(readonly el: HTMLElement) {}

  update(ps: Readonly<PlayerState>): void {
    const text = speedometerText(ps);
    if (this.el.textContent !== text) this.el.textContent = text;
  }
}
