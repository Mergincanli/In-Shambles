import type { PlayerState } from "@game/shared";

/**
 * The vitals readout (M4 design §2.12, D-053's placeholder; M8 styles it): the predicted player's
 * health and stamina in points, always on while playing. Health is shown rounded up, so a living
 * player never reads 0 (plan default 15); stamina rounded down, so "ST 0" only when below one
 * point. A read-only view of the prediction; text is built at the HUD's ≤ 15 Hz, never per frame.
 */

/** Health in whole points as shown: rounded up, from hundredths. */
function shownHp(ps: Readonly<PlayerState>): number {
  return Math.ceil(ps.health / 100);
}

/** Stamina in whole points as shown: rounded down, from hundredths. */
function shownSt(ps: Readonly<PlayerState>): number {
  return Math.floor(ps.stamina / 100);
}

/** "HP 100  ST 100": both from their hundredths (PlayerState `health`, `stamina`). */
export function vitalsText(ps: Readonly<PlayerState>): string {
  return `HP ${shownHp(ps)}  ST ${shownSt(ps)}`;
}

export class Vitals {
  /** The points last shown; −1 before the first update. */
  private hp = -1;
  private st = -1;

  constructor(readonly el: HTMLElement) {}

  /** Builds and writes the text only when a shown value changes (the panel is always on). */
  update(ps: Readonly<PlayerState>): void {
    const hp = shownHp(ps);
    const st = shownSt(ps);
    if (hp === this.hp && st === this.st) return;
    this.hp = hp;
    this.st = st;
    this.el.textContent = vitalsText(ps);
  }
}
