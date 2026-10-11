/**
 * Child process of long/view-frame-allocation.long.ts (`pnpm test:long`, D-032): demo playback's
 * frame (D-044, M3 design §2.12) under native ES modules, where V8 boxes a double that crosses a
 * call it doesn't inline. `DemoGame.frame` (renderer and status off) plays a long recorded demo
 * at 1× in 144 Hz frames: the records due each frame into the spectator store, the remote
 * interpolation of 16 players, the follow camera with its pull-back, a player leaving and coming
 * back every 10 s (the camera moves on when it was the followed one), `followNext` and
 * `followPrev` now and then, and the EVENTS records (joins, leaves, SERVER_STATS once a second).
 * The demo is recorded by the server's recorder from a scripted world before the measurement.
 * Prints whether the heap stayed flat.
 */
import { readFileSync } from "node:fs";
import { PerformanceObserver } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { DemoRecorder, MemoryDemoSink, WorldHistory } from "@game/server";
import {
  BitWriter,
  buildCollisionWorld,
  CvarBlock,
  DEMO_REC_EVENTS,
  decodeCmap,
  EV_LEAVE_LEFT,
  EVK_PLAYER_JOIN,
  EVK_PLAYER_LEAVE,
  EVK_SERVER_STATS,
  EventsMsg,
  encodeEvents,
  MAX_RELIABLE_BYTES,
  PMF_CROUCHED,
  PMF_GROUNDED,
  validateDemo,
} from "@game/shared";
import { DemoGame } from "../../src/app/demoGame";
import { DemoPlayer } from "../../src/net/demoPlayer";

const FRAMES = 10_000;
const FRAME_MS = 1000 / 144;
const PLAYERS = 16;
/** Ticks the demo holds: the warm-up and three measured runs, with room to spare. */
const TICKS = Math.ceil(((FRAMES * 7 * FRAME_MS) / (1000 / 60)) * 1.05);
const LEAVER = 6;

const cmap = decodeCmap(
  new Uint8Array(
    readFileSync(
      fileURLToPath(new URL("../../../../content/maps/arena_greybox.cmap", import.meta.url)),
    ),
  ),
);
const world = buildCollisionWorld(cmap);

/** The leaver is gone for 2 s of every 10. */
function present(s: number, t: number): boolean {
  return s !== LEAVER || t % 600 < 480;
}

function record(): Uint8Array {
  const history = new WorldHistory();
  const rec = new DemoRecorder();
  const sink = new MemoryDemoSink();
  rec.start(sink, "alloc", { name: cmap.name, hashLo: 0, hashHi: 0 }, "alloc-build");
  const block = new CvarBlock();
  const w = new BitWriter(MAX_RELIABLE_BYTES);
  const m = new EventsMsg();
  for (let t = 1; t <= TICKS; t++) {
    const f = history.frameFor(t);
    f.clear();
    for (let s = 0; s < PLAYERS; s++) {
      if (!present(s, t)) continue;
      f.setPresent(s, t);
      f.serial[s] = 1 + Math.floor(t / 600);
      const a = ((t * 3 + s * 400) % 4096) / 4096;
      const r = 200 + s * 20;
      // A square path (no trig in the scripted world), 1/32 u.
      const side = Math.floor(a * 4);
      const u = a * 4 - side;
      const x = side === 0 ? u : side === 1 ? 1 : side === 2 ? 1 - u : 0;
      const y = side === 0 ? 0 : side === 1 ? u : side === 2 ? 1 : 1 - u;
      f.originX[s] = Math.round((x * 2 - 1) * r * 32);
      f.originY[s] = Math.round((y * 2 - 1) * r * 32);
      f.originZ[s] = 24 * 32 + 16;
      f.entVelX[s] = 300;
      f.yaw[s] = (t * 120 + s * 4000) & 0xffff;
      f.pitch[s] = ((t * 7) % 4000) - 2000;
      f.flags[s] = PMF_GROUNDED | ((t + s * 37) % 240 < 40 ? PMF_CROUCHED : 0);
      f.team[s] = 1 + (s & 1);
      f.teleportSeq[s] = (1 + Math.floor(t / 600)) & 0xff;
    }
    history.stored(t);
    rec.beginTick(t, block, 0);
    rec.writeSnapshot(t, history, 0);
    m.count = 0;
    if (t === 1) {
      for (let s = 0; s < PLAYERS; s++) {
        const e = m.add(EVK_PLAYER_JOIN);
        if (e !== null) {
          e.clientId = s;
          e.team = 1 + (s & 1);
        }
      }
    } else if (t % 600 === 480) {
      const e = m.add(EVK_PLAYER_LEAVE);
      if (e !== null) {
        e.clientId = LEAVER;
        e.reason = EV_LEAVE_LEFT;
      }
    } else if (t % 600 === 0) {
      const e = m.add(EVK_PLAYER_JOIN);
      if (e !== null) {
        e.clientId = LEAVER;
        e.team = 1;
      }
    }
    if (t % 60 === 0) {
      const e = m.add(EVK_SERVER_STATS);
      if (e !== null) e.players = PLAYERS;
    }
    if (m.count > 0) {
      w.reset();
      encodeEvents(w, m);
      rec.write(DEMO_REC_EVENTS, t, w.bytes, w.byteLength);
    }
  }
  rec.stop();
  return sink.bytes();
}

const bytes = record();
const check = validateDemo(bytes);
if (!check.ok) throw new Error(check.error);
/** [0] the fake clock (ms). */
const clock = new Float64Array(1);
const demo = new DemoPlayer({
  bytes,
  header: check.header,
  world,
  clock: () => clock[0] as number,
});
let followed = 0;
const hud = {
  follow: (id: number) => {
    if (id !== followed) followed = id;
  },
};
const game = new DemoGame({ demo, world, renderer: null, status: null, hud });
/** [0] frames, [1] follow changes seen by the HUD, [2] auto-advances, [3] steps asked. */
const counts = new Float64Array(4);
let last = -1;

function run(frames: number): void {
  for (let i = 0; i < frames; i++) {
    clock[0] = (clock[0] as number) + FRAME_MS;
    game.frame();
    const n = (counts[0] as number) + 1;
    counts[0] = n;
    if (followed !== last) {
      counts[1] = (counts[1] as number) + 1;
      if (last === LEAVER) counts[2] = (counts[2] as number) + 1;
      last = followed;
    }
    if (n % 700 === 0) {
      demo.followNext();
      counts[3] = (counts[3] as number) + 1;
    } else if (n % 1100 === 0) {
      demo.followPrev();
      counts[3] = (counts[3] as number) + 1;
    } else if (n % 2900 === 0) {
      demo.follow(LEAVER);
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
  demo.snapshots,
  demo.events,
  counts[1] as number,
  counts[2] as number,
  counts[3] as number,
  demo.view.count,
];
console.log(JSON.stringify({ clean, attempts, outcomes, ended: demo.ended, faults: demo.faults }));
