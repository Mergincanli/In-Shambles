import { spawnSync } from "node:child_process";
import {
  BUTTON_JUMP,
  HULL_MINS,
  HULL_STANDING_MAXS,
  MASK_PLAYERSOLID,
  PMF_ON_LADDER,
  playerStateEquals,
  positionTest,
  vec3,
} from "@game/shared";
import { describe, expect, it } from "vitest";
import {
  buildPmoveWorkload,
  CMD_TICKS,
  formatPmoveBench,
  LADDER_TOUR_TICKS,
  meetsPmoveBudget,
  PMOVE_PLAYERS,
  PMOVE_SEED,
  type PmoveBenchResult,
  PmoveBenchState,
  pmoveStrictFailure,
  RESPAWN_TICKS,
  runLadderTour,
  runPmoveBench,
  runPmoveTicks,
} from "../../bench/pmove.bench";
import { fromRoot } from "../../src/paths";

// Keeps the pmove half of `pnpm bench` compiling and its workload honest; timings are not
// asserted (machine variance), only the workload, what the loop simulates, and the verdict logic.

const workload = buildPmoveWorkload();

function fakeResult(nsPerPlayerTick: number, gcs: number): PmoveBenchResult {
  return {
    ticks: 1,
    playerTicks: PMOVE_PLAYERS,
    nsPerPlayerTick,
    gcs,
    grounded: 0.5,
    jumps: 0.01,
    steps: 0.001,
    lands: 0.01,
    fallbacks: 0,
    ladder: 0.001,
    swimming: 0.05,
    crouched: 0.1,
    sink: 0,
  };
}

describe("pmove bench workload", () => {
  it("is a pure function of the seed", () => {
    expect(buildPmoveWorkload(PMOVE_SEED).cmds).toEqual(workload.cmds);
    expect(buildPmoveWorkload(1).cmds).not.toEqual(workload.cmds);
    expect(workload.cmds.length).toBe(CMD_TICKS * 5);
  });

  it("spawns at clear standing spots: the course start and its anchors", () => {
    expect(workload.spawnCount).toBeGreaterThan(10);
    const at = vec3();
    for (let i = 0; i < workload.spawnCount; i++) {
      at.set(workload.spawns.subarray(4 * i, 4 * i + 3));
      expect(
        positionTest(workload.world, at, HULL_MINS, HULL_STANDING_MAXS, MASK_PLAYERSOLID),
      ).toBe(true);
    }
  });

  it("draws a movement mix with running, strafing, jumping and turning", () => {
    let forward = 0;
    let strafe = 0;
    let jump = 0;
    const yaws = new Set<number>();
    for (let t = 0; t < CMD_TICKS; t++) {
      const o = 5 * t;
      if ((workload.cmds[o] as number) > 0) forward++;
      if (workload.cmds[o + 1] !== 0) strafe++;
      if (((workload.cmds[o + 2] as number) & BUTTON_JUMP) !== 0) jump++;
      yaws.add(workload.cmds[o + 3] as number);
    }
    expect(forward / CMD_TICKS).toBeGreaterThan(0.5);
    expect(strafe / CMD_TICKS).toBeGreaterThan(0.3);
    expect(jump / CMD_TICKS).toBeGreaterThan(0.1);
    expect(yaws.size).toBeGreaterThan(CMD_TICKS / 2);
  });
});

describe("pmove bench loop", () => {
  it("simulates deterministically and keeps every player out of solid", () => {
    const a = new PmoveBenchState(workload);
    const b = new PmoveBenchState(workload);
    runPmoveTicks(workload, a, RESPAWN_TICKS + 50);
    // The same ticks in other slices end in the same states.
    runPmoveTicks(workload, b, 7);
    runPmoveTicks(workload, b, RESPAWN_TICKS + 43);
    expect(b.tick).toBe(a.tick);
    for (let i = 0; i < PMOVE_PLAYERS; i++) {
      const pa = a.players[i];
      const pb = b.players[i];
      if (pa === undefined || pb === undefined) throw new Error("missing player");
      expect(playerStateEquals(pa, pb)).toBe(true);
      expect(
        positionTest(workload.world, pa.origin, HULL_MINS, HULL_STANDING_MAXS, MASK_PLAYERSOLID),
      ).toBe(true);
    }
    expect(a.tally).toEqual(b.tally);
  });

  it("covers ground and air, jumps, steps and landings, without snap fallbacks", () => {
    const s = new PmoveBenchState(workload);
    const ticks = 2 * RESPAWN_TICKS;
    runPmoveTicks(workload, s, ticks);
    const n = ticks * PMOVE_PLAYERS;
    const [grounded, jumps, steps, lands, fallbacks] = Array.from(s.tally);
    expect((grounded as number) / n).toBeGreaterThan(0.3);
    expect((grounded as number) / n).toBeLessThan(0.95);
    expect(jumps).toBeGreaterThan(50);
    expect(steps).toBeGreaterThan(0);
    expect(lands).toBeGreaterThan(50);
    expect(fallbacks).toBe(0);
  });

  it("swims, crouches and reaches the ladder once the players have toured the anchors", () => {
    const s = new PmoveBenchState(workload);
    // Player i moves to spawn point i + k at its k-th respawn: 8 respawns reach the pool and the
    // ladder anchors from every start.
    runPmoveTicks(workload, s, 8 * RESPAWN_TICKS);
    const [, , , , fallbacks, ladder, swimming, crouched] = Array.from(s.tally);
    expect(ladder).toBeGreaterThan(0);
    expect(swimming).toBeGreaterThan(0);
    expect(crouched).toBeGreaterThan(0);
    expect(fallbacks).toBe(0);
  });

  it("the warm-up's ladder tour climbs, descends and jumps off the ladder", () => {
    const s = new PmoveBenchState(workload);
    const attached = runLadderTour(workload, s);
    // Up for 60 ticks, down for 20, attached until the jump-off at tick 85.
    expect(attached).toBeGreaterThanOrEqual(80);
    expect(attached).toBeLessThan(LADDER_TOUR_TICKS);
    expect(s.climber.flags & PMF_ON_LADDER).toBe(0);
    // Pushed off the −y face.
    expect(s.climber.velocity[1]).toBeLessThan(-100);
  });

  it("times the loop and reports per player-tick", async () => {
    const result = await runPmoveBench(workload, 20, 10);
    expect(result.ticks).toBe(20);
    expect(result.playerTicks).toBe(20 * PMOVE_PLAYERS);
    expect(result.nsPerPlayerTick).toBeGreaterThan(0);
    expect(result.nsPerPlayerTick).toBeLessThan(1_000_000);
    expect(Number.isFinite(result.sink)).toBe(true);
  });
});

describe("pmove bench verdict", () => {
  it("passes at the 5 µs budget and fails above it", () => {
    for (const [ns, verdict] of [
      [4999, "PASS"],
      [5000, "PASS"],
      [5001, "FAIL"],
    ] as const) {
      expect(meetsPmoveBudget(ns)).toBe(verdict === "PASS");
      const report = formatPmoveBench(fakeResult(ns, 2), workload);
      expect(report).toContain(
        `pmove per player-tick: ${ns.toFixed(1)} ns, budget 5000 ns: ${verdict}`,
      );
      expect(report).toContain("GCs during the pmove loop: 2 (expect 0)");
    }
  });

  it("--strict fails on a missed budget or any GC", () => {
    expect(pmoveStrictFailure(fakeResult(2000, 0))).toBe(false);
    expect(pmoveStrictFailure(fakeResult(5001, 0))).toBe(true);
    expect(pmoveStrictFailure(fakeResult(2000, 1))).toBe(true);
  });
});

describe("pnpm bench entry, pmove part", () => {
  const run = (...args: string[]) =>
    spawnSync(
      process.execPath,
      ["--import", "tsx", "bench/run.ts", "--calls", "1000", "--warmup", "1000", ...args],
      { cwd: fromRoot("packages", "tools"), encoding: "utf8" },
    );

  it("prints the pmove report after the trace report, and exits 0", () => {
    const out = run("--pmove-ticks", "50", "--pmove-warmup", "50");
    expect(out.status, out.stderr).toBe(0);
    expect(out.stdout).toMatch(/budget 1000 ns: (PASS|FAIL)[\s\S]*budget 5000 ns: (PASS|FAIL)/);
    expect(out.stdout).toContain(`pmove on movement_lab: ${PMOVE_PLAYERS} players`);
    expect(out.stdout).toMatch(/GCs during the pmove loop: \d+/);
  }, 30_000);

  it("rejects bad pmove counts with exit code 2", () => {
    expect(run("--pmove-ticks", "0").status).toBe(2);
    expect(run("--pmove-warmup", "1.5").status).toBe(2);
  }, 30_000);
});
