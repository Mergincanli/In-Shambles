import type { CameraOverride } from "./game";

/** What the page's URL asks for (M2 design §2 "Autotest hooks"). */
export interface BootParams {
  /** `?autotest=1`: report status into `document.documentElement.dataset`. */
  readonly autotest: boolean;
  /** `?bot=<name>`: a scripted input (scriptedInput.ts) instead of the player's. */
  readonly bot: string | null;
  /** `?cam=x,y,z,yaw,pitch`: a fixed camera (sim u and degrees); ignored unless 5 numbers. */
  readonly camera: CameraOverride | null;
}

export function parseBootParams(search: string): BootParams {
  const q = new URLSearchParams(search);
  let camera: CameraOverride | null = null;
  const cam = q.get("cam");
  if (cam !== null) {
    const n = cam.split(",").map((part) => (part.trim() === "" ? Number.NaN : Number(part)));
    if (n.length === 5 && n.every(Number.isFinite)) {
      camera = [n[0] as number, n[1] as number, n[2] as number, n[3] as number, n[4] as number];
    }
  }
  return { autotest: q.get("autotest") === "1", bot: q.get("bot"), camera };
}
