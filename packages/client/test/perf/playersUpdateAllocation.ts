/**
 * Child process of long/view-frame-allocation.long.ts (`pnpm test:long`, D-032): the other
 * players' per-frame path under native ES modules, where V8 boxes a double that crosses a call it
 * doesn't inline (M3 design §5 "playersUpdate"). Each frame moves 16 remotes in a `RemoteView`
 * (as the interpolation fills it, D-037) and updates the capsules on a headless Three.js scene (no
 * WebGL), with team changes, crouches blended over 100 ms (cl_remoteCrouchBlendMs), a teleport
 * mark now and then and remotes leaving and coming back every few frames, so the packing, the
 * blend and the colour rewrites run too. Prints whether the heap stayed flat.
 */
import { PerformanceObserver } from "node:perf_hooks";
import { TEAM_1, TEAM_2 } from "@game/shared";
import { Scene } from "three";
import { RemoteView } from "../../src/net/remotes";
import { BLEND_DT_MS, BLEND_MS, CROUCH_SCALE, PlayerCapsules } from "../../src/render/players";

const FRAMES = 20_000;
const REMOTES = 16;
const SELF = 5;

const view = new RemoteView();
/** 144 Hz frames, a 100 ms blend. */
const blend = new Float64Array(2);
blend[BLEND_DT_MS] = 1000 / 144;
blend[BLEND_MS] = 100;
const players = new PlayerCapsules();
const scene = new Scene();
scene.add(players.object);
/** [0] tick, [1] remotes drawn (summed), [2] teleported marks, [3] crouched draws, [4] blending. */
const counts = new Float64Array(5);

function run(frames: number): void {
  for (let i = 0; i < frames; i++) {
    const tick = (counts[0] as number) + 1;
    counts[0] = tick;
    view.clear();
    let n = 0;
    for (let k = 0; k <= REMOTES; k++) {
      const s = k * 3;
      if (s === SELF * 3) continue;
      // Every 7th frame two remotes are gone (removed, then back: an appearance).
      if ((tick + k) % 7 === 0 && k < 2) continue;
      view.visible[s] = 1;
      view.x[s] = (((tick * (k + 3)) % 40960) - 20480) / 32;
      view.y[s] = (((tick * 7 + k * 911) % 30000) - 15000) / 32;
      view.z[s] = 24 + ((tick + k) % 64) / 32;
      view.yaw[s] = (((tick * 97 + k * 4000) & 0xffff) * 360) / 65536;
      view.pitch[s] = ((((tick + k) % 200) - 100) * 360) / 65536;
      view.crouched[s] = ((tick >> 4) + k) % 3 === 0 ? 1 : 0;
      view.team[s] = ((tick >> 6) + k) % 2 === 0 ? TEAM_1 : TEAM_2;
      view.teleported[s] = (tick + k) % 7 === 1 || (k === 4 && (tick & 31) === 0) ? 1 : 0;
      n++;
    }
    view.count = n;
    players.update(view, blend);
    scene.updateMatrixWorld();
    counts[1] = (counts[1] as number) + players.count;
    for (let s = 0; s < 64; s++) {
      if (view.teleported[s] === 1) counts[2] = (counts[2] as number) + 1;
      if (view.visible[s] === 1 && view.crouched[s] === 1) counts[3] = (counts[3] as number) + 1;
      const h = players.height[s] as number;
      if (h > CROUCH_SCALE && h < 1) counts[4] = (counts[4] as number) + 1;
    }
  }
}

let gcs = 0;
const observer = new PerformanceObserver((list) => {
  gcs += list.getEntries().length;
});
observer.observe({ entryTypes: ["gc"] });
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));
run(FRAMES * 4);
const attempts: string[] = [];
let clean = false;
for (let attempt = 0; attempt < 3 && !clean; attempt++) {
  await settle();
  gcs = 0;
  const before = process.memoryUsage().heapUsed;
  run(FRAMES);
  const growth = process.memoryUsage().heapUsed - before;
  await settle();
  attempts.push(`${gcs} GCs, heap ${growth >= 0 ? "+" : ""}${growth} B`);
  clean = gcs === 0 && growth < 64 * 1024;
}
observer.disconnect();
const outcomes = [
  counts[1],
  counts[2],
  counts[3],
  players.capsules.instanceColor?.version ?? 0,
  counts[4],
];
console.log(JSON.stringify({ clean, attempts, outcomes }));
