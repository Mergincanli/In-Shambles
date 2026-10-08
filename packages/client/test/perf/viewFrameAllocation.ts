/**
 * Child process of long/view-frame-allocation.long.ts (`pnpm test:long`, D-032): runs `Game.frame`
 * (renderer and status off) under native ES modules, where V8 boxes a double returned by a call
 * it doesn't inline, and prints whether the heap stayed flat. Each cycle runs MixedInput's phases
 * (crouch, turns, pitch sweeps, jumps), then a 120-tick walk north from `stairs_base` (the
 * server's player moved there), and a frame hitch every 2048 ticks forces a hard resync: STEP
 * events, eye-height changes, angle interpolation and the step smoother's re-timing all run. The
 * walk climbs the stairs, crosses the landing and walks off its north edge, so the next cycle
 * starts in mid-air over a 128 u drop: a fall and a landing run too. No wall is met. The first
 * such walk deopts pmove's late branches once per process (docs/10 §4 known limit, D-023); this
 * test warms up past it.
 *
 * The player's per-frame paths run too (M2 increment 12): mouse look with counts every frame,
 * the cmd sampler with keys going up and down, the third-person pull-back, the underwater test,
 * every `r_debug*` line (hull, ground normal, pmove's trace log) and their three.js upload.
 */
import { readFileSync } from "node:fs";
import { PerformanceObserver } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { Match } from "@game/server";
import {
  buildCollisionWorld,
  CvarRegistry,
  createLoopbackPair,
  decodeCmap,
  MOVE_AXIS_MAX,
  type PlayerState,
  PMEV_STEP,
  PMF_CROUCHED,
  registerPmoveCvars,
  TRACE_EPSILON,
  UserCmd,
} from "@game/shared";
import { Game } from "../../src/app/game";
import { ACTION_FORWARD, ACTION_JUMP } from "../../src/console/binds";
import { registerClientCvars } from "../../src/console/clientCvars";
import { MouseLook } from "../../src/input/mouse";
import { ActionState, PlayerInput } from "../../src/input/sampler";
import { ClientSim, type CmdSampler, MixedInput, STAT_HARD_RESYNCS } from "../../src/net";
import { DebugDraw } from "../../src/render/debug/debugDraw";

const FRAMES = 20_000;
const FRAME_MS = 1000 / 144;
const SERVER_TICK_MS = 1000 / 60;
/** Server ticks per cycle: MixedInput, then a walk up the stairs and off the landing. */
const CYCLE = 1200;
const STAIRS_FROM = 1080;

const mapUrl = new URL("../../../../content/maps/movement_lab.cmap", import.meta.url);
const cmap = decodeCmap(new Uint8Array(readFileSync(fileURLToPath(mapUrl))));
const world = buildCollisionWorld(cmap);
const stairs = cmap.entities.find((e) => e.props.targetname === "stairs_base")?.origin;
if (stairs === undefined) throw new Error("movement_lab has no stairs_base");

/** MixedInput, or a walk north while `stairs`. */
class Cycle implements CmdSampler {
  stairs = false;
  private readonly mixed = new MixedInput();
  sample(cmd: UserCmd, ps: Readonly<PlayerState>): void {
    this.mixed.sample(cmd, ps);
    if (!this.stairs) return;
    cmd.buttons = 0;
    cmd.forward = MOVE_AXIS_MAX;
    cmd.right = 0;
    cmd.up = 0;
    cmd.yaw = 16384;
    cmd.pitch = 0;
    cmd.weaponSlot = 0;
  }
}

const time = new Float64Array(2);
const input = new Cycle();
const [clientEnd, serverEnd] = createLoopbackPair();
const match = new Match({ cmap, world, buildHash: "alloc" });
match.connect(serverEnd, true);
const cvars = new CvarRegistry();
registerPmoveCvars(cvars);
registerClientCvars(cvars);
for (const name of ["cl_thirdPerson", "r_debugHull", "r_debugTraces", "r_debugGround"]) {
  cvars.set(name, true);
}
const client = new ClientSim({
  transport: clientEnd,
  cmap,
  world,
  buildHash: "alloc",
  clock: () => time[0] as number,
  cvars,
  input,
});
const look = new MouseLook();
const actions = new ActionState();
const player = new PlayerInput(actions, look);
const playerCmd = new UserCmd();
const draw = new DebugDraw();
const game = new Game({ client, renderer: null, status: null, look });
client.connect();
/** Client frames are skipped until this server tick (a hitch: a hard resync). */
let pausedUntil = 0;
/** [0] STEP events filed, [1] crouched frames. */
const counts = new Float64Array(2);

function run(frames: number): void {
  for (let f = 0; f < frames; f++) {
    time[0] = (time[0] as number) + FRAME_MS;
    time[1] = (time[1] as number) + FRAME_MS;
    while ((time[1] as number) >= SERVER_TICK_MS) {
      time[1] = (time[1] as number) - SERVER_TICK_MS;
      match.tick();
      const t = match.serverTick;
      const phase = match.serverTick % CYCLE;
      if ((t & 2047) === 1024) pausedUntil = t + 8;
      if (phase === 0 || phase === STAIRS_FROM) {
        input.stairs = phase === STAIRS_FROM;
        const player = match.session(0)?.player;
        if (input.stairs && player !== undefined && stairs !== undefined) {
          player.origin[0] = stairs[0];
          player.origin[1] = stairs[1];
          player.origin[2] = stairs[2] + TRACE_EPSILON;
          player.velocity.fill(0);
        }
      }
    }
    if (match.serverTick < pausedUntil) continue;
    look.addCounts((f & 7) - 3, (f & 2) - 1);
    game.frame();
    draw.update(game.debugLines, true);
    if ((f & 15) === 0) actions.press(ACTION_FORWARD);
    if ((f & 15) === 8) actions.release(ACTION_FORWARD);
    if ((f & 31) === 4) actions.press(ACTION_JUMP);
    if ((f & 31) === 5) actions.release(ACTION_JUMP);
    player.sample(playerCmd, client.predictor.state);
    const ev = client.events;
    for (let i = 0; i < ev.count; i++) {
      if (ev.types[i] === PMEV_STEP) counts[0] = (counts[0] as number) + 1;
    }
    if ((client.predictor.state.flags & PMF_CROUCHED) !== 0) counts[1] = (counts[1] as number) + 1;
  }
}

let gcs = 0;
const observer = new PerformanceObserver((list) => {
  gcs += list.getEntries().length;
});
observer.observe({ entryTypes: ["gc"] });
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));
// Warm-up: V8 keeps optimizing the match and client paths for some 250000 ticks.
run(FRAMES * 36);
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
  counts[0],
  counts[1],
  client.stats.totals[STAT_HARD_RESYNCS],
  game.frames,
  game.debugLines.traces.count,
  game.debugLines.shapes.count,
];
console.log(JSON.stringify({ clean, attempts, outcomes }));
