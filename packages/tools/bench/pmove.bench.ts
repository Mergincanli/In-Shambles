import { readFileSync } from "node:fs";
import { PerformanceObserver, performance } from "node:perf_hooks";
import {
  BUTTON_JUMP,
  BUTTON_WALK,
  buildCollisionWorld,
  type CollisionWorld,
  decodeCmap,
  degreesToU16,
  lastPmoveSnap,
  Mulberry32,
  PlayerState,
  PMEV_JUMP,
  PMEV_LAND,
  PMEV_STEP,
  PMF_GROUNDED,
  PmoveEvent,
  PmoveEvents,
  PmoveParams,
  pmove,
  SNAP_PREVIOUS,
  TICK_DT,
  UserCmd,
} from "@game/shared";
import { COURSE_MAP_DIR, courseFileName } from "../src/greybox/courses";
import { fromRoot } from "../src/paths";
import { countIn, WARMUP_ROUNDS, warmupCalls } from "./trace.bench";

/**
 * The pmove microbenchmark (docs/10 §4.4: ≤ 5 µs per player-tick). PMOVE_PLAYERS players run a
 * seeded movement mix on movement_lab, one tick at a time, as a match does: sticky input (run,
 * strafe, back-pedal, walk, jump presses and holds, turning and looking up and down) drawn once
 * into typed arrays before the clock runs. Each player starts at a spawn or a course anchor and
 * is moved to the next one every RESPAWN_TICKS, so the mix keeps meeting steps, stairs, slopes,
 * walls and ledges instead of ending pressed into a corner. Events are collected, as the server
 * does; the trace log is off, as in production.
 */

/** Players simulated per tick: a full match (docs/10 §4 budgets are for 16 players). */
export const PMOVE_PLAYERS = 16;
/** Ticks between a player's moves to the next spawn point: 10 s. */
export const RESPAWN_TICKS = 600;
/** Length of the drawn cmd table; a power of two, so players cycle it with a mask. */
export const CMD_TICKS = 4096;
/** Integers per cmd in the table: forward, right, buttons, yaw, pitch. */
const CMD_STRIDE = 5;

export const PMOVE_SEED = 0x9e0e;

/** docs/10 §4.4: pmove per player-tick (all mechanics) ≤ 5 µs. */
export const PMOVE_BUDGET_NS = 5000;

export interface PmoveWorkload {
  readonly world: CollisionWorld;
  /** x, y, z, yaw (u16) per spawn point: info_player_start and every course anchor. */
  readonly spawns: Float64Array;
  readonly spawnCount: number;
  /** CMD_TICKS cmds, CMD_STRIDE integers each. */
  readonly cmds: Int32Array;
}

/** movement_lab as the game loads it, with its spawn points and anchors. */
export function buildPmoveWorkload(seed = PMOVE_SEED): PmoveWorkload {
  const bytes = readFileSync(fromRoot(...COURSE_MAP_DIR, courseFileName("movement_lab")));
  const cmap = decodeCmap(new Uint8Array(bytes));
  const world = buildCollisionWorld(cmap);
  const points: number[] = [];
  for (const e of cmap.entities) {
    if (e.classname !== "info_player_start" && e.classname !== "info_target") continue;
    const at = e.origin;
    if (at === undefined) continue;
    points.push(at[0], at[1], at[2], degreesToU16(e.angles?.[1] ?? 0) & 0xffff);
  }
  const rng = new Mulberry32(seed);
  const cmds = new Int32Array(CMD_TICKS * CMD_STRIDE);
  let forward = 0;
  let right = 0;
  let buttons = 0;
  let yaw = 0;
  let yawRate = 0;
  let pitch = 0;
  let hold = 0;
  for (let t = 0; t < CMD_TICKS; t++) {
    if (hold-- <= 0) {
      // A new choice every 6–60 ticks; mostly running forward, as players do.
      hold = 6 + rng.nextInt(55);
      const f = rng.nextFloat();
      forward = f < 0.7 ? 127 : f < 0.85 ? 0 : -127;
      const r = rng.nextFloat();
      right = r < 0.5 ? 0 : r < 0.75 ? 127 : -127;
      const b = rng.nextFloat();
      buttons = (b < 0.25 ? BUTTON_JUMP : 0) | (rng.nextFloat() < 0.15 ? BUTTON_WALK : 0);
      yawRate = rng.nextInt(801) - 400;
      pitch = rng.nextInt(16001) - 8000;
    }
    // Held jumps are re-pressed now and then, so landings chain into hops.
    const jump = (buttons & BUTTON_JUMP) !== 0 && (t & 15) !== 0 ? BUTTON_JUMP : 0;
    yaw = (yaw + yawRate) & 0xffff;
    const o = t * CMD_STRIDE;
    cmds[o] = forward;
    cmds[o + 1] = right;
    cmds[o + 2] = (buttons & ~BUTTON_JUMP) | jump;
    cmds[o + 3] = yaw;
    cmds[o + 4] = pitch & 0xffff;
  }
  return { world, spawns: Float64Array.from(points), spawnCount: points.length / 4, cmds };
}

/** The players of one run, their tick counter and event tallies. */
export class PmoveBenchState {
  readonly players: PlayerState[] = [];
  readonly cmd = new UserCmd();
  readonly params = new PmoveParams();
  readonly events = new PmoveEvents();
  readonly event = new PmoveEvent();
  tick = 0;
  /** Tallies: grounded player-ticks, jumps, steps, lands, snapOrigin fallbacks. */
  readonly tally = new Float64Array(5);

  constructor(workload: PmoveWorkload) {
    for (let i = 0; i < PMOVE_PLAYERS; i++) {
      const ps = new PlayerState();
      placeAtSpawn(workload, ps, i);
      this.players.push(ps);
    }
  }
}

function placeAtSpawn(workload: PmoveWorkload, ps: PlayerState, n: number): void {
  const o = 4 * (n % workload.spawnCount);
  const s = workload.spawns;
  ps.origin[0] = s[o] as number;
  ps.origin[1] = s[o + 1] as number;
  ps.origin[2] = s[o + 2] as number;
  ps.velocity[0] = 0;
  ps.velocity[1] = 0;
  ps.velocity[2] = 0;
  ps.viewYaw = s[o + 3] as number;
  ps.viewPitch = 0;
  ps.flags = PMF_GROUNDED;
}

/**
 * The timed loop: `ticks` match ticks of every player. Player i reads the cmd table 257·i ticks
 * ahead, so the players never move in step, and is moved to a spawn point when its own respawn
 * phase comes round.
 */
export function runPmoveTicks(
  workload: PmoveWorkload,
  state: PmoveBenchState,
  ticks: number,
): void {
  const world = workload.world;
  const table = workload.cmds;
  const cmd = state.cmd;
  const params = state.params;
  const events = state.events;
  const event = state.event;
  const tally = state.tally;
  const players = state.players;
  for (let n = 0; n < ticks; n++) {
    const t = state.tick++;
    for (let i = 0; i < PMOVE_PLAYERS; i++) {
      const ps = players[i] as PlayerState;
      const phase = t + 37 * i;
      if (phase % RESPAWN_TICKS === 0) placeAtSpawn(workload, ps, i + phase / RESPAWN_TICKS);
      const o = ((t + 257 * i) & (CMD_TICKS - 1)) * CMD_STRIDE;
      cmd.tick = t;
      cmd.forward = table[o] as number;
      cmd.right = table[o + 1] as number;
      cmd.buttons = table[o + 2] as number;
      cmd.yaw = table[o + 3] as number;
      cmd.pitch = table[o + 4] as number;
      pmove(ps, cmd, world, params, TICK_DT, events, null);
      if ((ps.flags & PMF_GROUNDED) !== 0) tally[0] = (tally[0] as number) + 1;
      if (lastPmoveSnap() === SNAP_PREVIOUS) tally[4] = (tally[4] as number) + 1;
      for (let k = 0; k < events.count; k++) {
        events.read(k, event);
        const type = event.type;
        if (type === PMEV_JUMP) tally[1] = (tally[1] as number) + 1;
        else if (type === PMEV_STEP) tally[2] = (tally[2] as number) + 1;
        else if (type === PMEV_LAND) tally[3] = (tally[3] as number) + 1;
      }
      events.clear();
    }
  }
}

export interface PmoveBenchResult {
  readonly ticks: number;
  readonly playerTicks: number;
  readonly nsPerPlayerTick: number;
  /** GC events that started inside the timed loop. */
  readonly gcs: number;
  /** Per player-tick over the timed run: grounded share, then jumps, steps, lands, fallbacks. */
  readonly grounded: number;
  readonly jumps: number;
  readonly steps: number;
  readonly lands: number;
  readonly fallbacks: number;
  /** Every player's final origin, summed: a sink, and a determinism check. */
  readonly sink: number;
}

export function meetsPmoveBudget(nsPerPlayerTick: number): boolean {
  return nsPerPlayerTick <= PMOVE_BUDGET_NS;
}

/** What `--strict` fails on: a missed budget, or any GC in the timed loop. */
export function pmoveStrictFailure(result: PmoveBenchResult): boolean {
  return !meetsPmoveBudget(result.nsPerPlayerTick) || result.gcs > 0;
}

/**
 * Warms up with `warmup` match ticks in WARMUP_ROUNDS short calls (as the trace bench does, so
 * the loop is optimized as a whole function), then times `ticks` match ticks from a fresh state.
 */
export async function runPmoveBench(
  workload: PmoveWorkload,
  ticks = 12_500,
  warmup = 6_250,
): Promise<PmoveBenchResult> {
  const warm = new PmoveBenchState(workload);
  for (let r = 0; r < WARMUP_ROUNDS; r++) runPmoveTicks(workload, warm, warmupCalls(warmup, r));
  const state = new PmoveBenchState(workload);
  const gcTimes: number[] = [];
  const observer = new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) gcTimes.push(entry.startTime);
  });
  observer.observe({ entryTypes: ["gc"] });
  let t0 = 0;
  let t1 = 0;
  let nanos = 0n;
  try {
    // Let a collection the setup and warm-up started finish before the clock runs.
    await new Promise((resolve) => setTimeout(resolve, 50));
    t0 = performance.now();
    const h0 = process.hrtime.bigint();
    runPmoveTicks(workload, state, ticks);
    nanos = process.hrtime.bigint() - h0;
    t1 = performance.now();
    // GC entries are delivered asynchronously.
    await new Promise((resolve) => setTimeout(resolve, 50));
  } finally {
    observer.disconnect();
  }
  const playerTicks = ticks * PMOVE_PLAYERS;
  const per = (k: number) => (state.tally[k] as number) / playerTicks;
  let sink = 0;
  for (const ps of state.players) sink += ps.origin[0] + ps.origin[1] + ps.origin[2];
  return {
    ticks,
    playerTicks,
    nsPerPlayerTick: Number(nanos) / playerTicks,
    gcs: countIn(gcTimes, t0, t1),
    grounded: per(0),
    jumps: per(1),
    steps: per(2),
    lands: per(3),
    fallbacks: per(4),
    sink,
  };
}

/** The report `pnpm bench` prints. */
export function formatPmoveBench(result: PmoveBenchResult, workload: PmoveWorkload): string {
  const pass = meetsPmoveBudget(result.nsPerPlayerTick);
  const k = (x: number) => (1000 * x).toFixed(1);
  return [
    `pmove on movement_lab: ${PMOVE_PLAYERS} players, ${workload.spawnCount} spawn points, ${result.ticks} ticks (${result.playerTicks} player-ticks)`,
    `mix: ${(100 * result.grounded).toFixed(0)}% grounded; per 1000 player-ticks ${k(result.jumps)} jumps, ${k(result.steps)} steps, ${k(result.lands)} landings, ${k(result.fallbacks)} snap fallbacks`,
    `pmove per player-tick: ${result.nsPerPlayerTick.toFixed(1)} ns, budget ${PMOVE_BUDGET_NS} ns: ${pass ? "PASS" : "FAIL"}`,
    `GCs during the pmove loop: ${result.gcs} (expect 0)`,
    `sink: ${result.sink}`,
  ].join("\n");
}
