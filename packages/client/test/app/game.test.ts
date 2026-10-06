import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Match } from "@game/server";
import {
  buildCollisionWorld,
  CvarRegistry,
  createLoopbackPair,
  decodeCmap,
  ENTITY_NONE,
  MOVE_AXIS_MAX,
  type PlayerState,
  registerPmoveCvars,
  TRACE_EPSILON,
  type UserCmd,
  VIEW_HEIGHT_STANDING,
} from "@game/shared";
import { describe, expect, it } from "vitest";
import { type CameraOverride, Game, type StatusSink } from "../../src/app/game";
import { parseBootParams } from "../../src/app/params";
import {
  ClientSim,
  type CmdSampler,
  NeutralInput,
  registerClientNetCvars,
  STAT_HARD_RESYNCS,
  StrafeCircuit,
} from "../../src/net";
import { registerViewCvars } from "../../src/render/viewCvars";

const mapUrl = new URL("../../../../content/maps/movement_lab.cmap", import.meta.url);
const cmap = decodeCmap(new Uint8Array(readFileSync(fileURLToPath(mapUrl))));
const world = buildCollisionWorld(cmap);
const BUILD = "game-test";

/** The page's pieces without the page: a Match, a client over loopback, a Game, a fake clock. */
function session(input: CmdSampler, camera: CameraOverride | null = null) {
  const now = { t: 0 };
  const [clientEnd, serverEnd] = createLoopbackPair();
  const match = new Match({ cmap, world, buildHash: BUILD });
  match.connect(serverEnd, true);
  // The page's registry (boot.ts), so the view cvars are the registered ones.
  const cvars = new CvarRegistry();
  registerPmoveCvars(cvars);
  registerClientNetCvars(cvars);
  registerViewCvars(cvars);
  const client = new ClientSim({
    transport: clientEnd,
    cmap,
    world,
    buildHash: BUILD,
    clock: () => now.t,
    cvars,
    input,
  });
  const status: StatusSink = {};
  const game = new Game({ client, renderer: null, status, camera });
  client.connect();
  let serverTicks = 0;
  let frames = 0;
  /** Runs the server at 60 Hz and frames at 144 Hz for `ms`, in time order. */
  const run = (ms: number, onFrame?: () => void) => {
    const end = now.t + ms;
    for (;;) {
      const nextTick = ((serverTicks + 1) * 1000) / 60;
      const nextFrame = ((frames + 1) * 1000) / 144;
      const next = Math.min(nextTick, nextFrame);
      if (next > end) break;
      now.t = next;
      if (next === nextTick) {
        serverTicks++;
        match.tick();
      } else {
        frames++;
        game.frame();
        onFrame?.();
      }
    }
    now.t = end;
  };
  /** A page stall: the server runs `ms` without a frame (the next frame then catches up). */
  const hitch = (ms: number) => {
    const end = now.t + ms;
    while (((serverTicks + 1) * 1000) / 60 <= end) {
      serverTicks++;
      now.t = (serverTicks * 1000) / 60;
      match.tick();
    }
    now.t = end;
    frames = Math.floor((end * 144) / 1000);
  };
  return { game, client, match, status, run, hitch };
}

/** Walks north (yaw 90°) at full speed while `walking`. */
class North implements CmdSampler {
  walking = true;
  sample(cmd: UserCmd, _ps: Readonly<PlayerState>): void {
    cmd.buttons = 0;
    cmd.forward = this.walking ? MOVE_AXIS_MAX : 0;
    cmd.right = 0;
    cmd.up = 0;
    cmd.yaw = 16384;
    cmd.pitch = 0;
    cmd.weaponSlot = 0;
  }
}

/** Moves the server's player to the anchor `name` at rest; the client resyncs to it. */
function placeAt(s: ReturnType<typeof session>, name: string): void {
  const base = cmap.entities.find((e) => e.props.targetname === name)?.origin;
  const player = s.match.session(0)?.player;
  if (base === undefined || player === undefined) throw new Error(`no ${name} or player`);
  player.origin[0] = base[0];
  player.origin[1] = base[1];
  player.origin[2] = base[2] + TRACE_EPSILON;
  player.velocity.fill(0);
}

describe("game frame loop (M2 design §2)", () => {
  it("reports the autotest status: running, snapshots, ticks, 0 corrections", () => {
    const { game, status, run } = session(new StrafeCircuit());
    run(3500);
    // Written every 250 ms: up to that much behind.
    expect(status.state).toBe("running");
    expect(Number(status.snapshots)).toBeGreaterThan(150);
    expect(Number(status.ticks)).toBeGreaterThan(150);
    expect(Number(status.corrections)).toBe(0);
    expect(Number(status.frames)).toBeGreaterThan(game.frames - 40);
    expect(Number(status.frames)).toBeLessThanOrEqual(game.frames);
    expect(status.drawCalls).toBe("0");
  });

  it("puts the eye at the interpolated origin plus the eye height, facing the spawn's yaw", () => {
    const { game, client, match, run } = session(new NeutralInput());
    run(1000);
    expect(client.active).toBe(true);
    const o = match.spawnOrigin;
    expect(Array.from(game.pose)).toEqual([
      o[0],
      o[1],
      (o[2] as number) + VIEW_HEIGHT_STANDING,
      0,
      0,
    ]);
    expect(o[2]).toBe(24 + TRACE_EPSILON);
  });

  it("follows a moving player continuously, and a fixed camera when asked", () => {
    const { game, client, run } = session(new StrafeCircuit());
    const xs: number[] = [];
    run(4000, () => {
      if (client.active) xs.push(game.pose[0] as number);
    });
    let maxStep = 0;
    for (let i = 1; i < xs.length; i++) {
      maxStep = Math.max(maxStep, Math.abs((xs[i] as number) - (xs[i - 1] as number)));
    }
    expect(Math.max(...xs) - Math.min(...xs)).toBeGreaterThan(100);
    // At 144 Hz, even 650 u/s moves under 5 u a frame.
    expect(maxStep).toBeLessThan(6);

    const fixed = session(new StrafeCircuit(), [1, 2, 3, 45, -10]);
    fixed.run(2000);
    expect(Array.from(fixed.game.pose)).toEqual([1, 2, 3, 45, -10]);
  });

  it("smooths a step: the eye rises over cl_stepSmoothMs, not in one tick", () => {
    // Walk north up the 18 u step from its base anchor.
    const base = cmap.entities.find((e) => e.props.targetname === "step_18_base")?.origin;
    expect(base).toBeDefined();
    const s = session(new North());
    s.run(500);
    // Teleport the server's player; the client's next snapshot adopts it (teleport flag set by
    // the hard resync's distance, beyond cl_teleportDist).
    placeAt(s, "step_18_base");
    const eye: number[] = [];
    const feet: number[] = [];
    // 160 u from the base to the top anchor at 320 u/s; stop on the step's top.
    s.run(800, () => {
      eye.push(s.game.pose[2] as number);
      feet.push(s.client.predictor.state.origin[2] as number);
    });
    const top = (base?.[2] ?? 0) + 18 + TRACE_EPSILON + VIEW_HEIGHT_STANDING;
    expect(Math.max(...feet)).toBeCloseTo(top - VIEW_HEIGHT_STANDING, 6);
    expect(eye.at(-1)).toBeCloseTo(top, 6);
    // Once settled at the base, the eye never jumps more than 1/6 of the step in a frame.
    const start = eye.findIndex((z, i) => i > 0 && Math.abs(z - (base?.[2] ?? 0) - 26) < 0.01);
    let maxRise = 0;
    for (let i = Math.max(1, start + 1); i < eye.length; i++) {
      maxRise = Math.max(maxRise, (eye[i] as number) - (eye[i - 1] as number));
    }
    expect(maxRise).toBeGreaterThan(0);
    expect(maxRise).toBeLessThan(3);
  });

  /**
   * Climbs the stairs with one path jump at frame `at` of the climb, and returns the largest
   * per-frame drop of the eye. A jump's ticks are already held by the render offset, so the step
   * smoother must neither cancel their rise again nor lose its own clock across the jump.
   */
  function climbWithJump(at: number, jump: (s: ReturnType<typeof session>) => void) {
    const north = new North();
    north.walking = false;
    const s = session(north);
    s.run(500);
    placeAt(s, "stairs_base");
    s.run(500);
    north.walking = true;
    let frame = 0;
    let prev = Number.NaN;
    let minDelta = 0;
    s.run(1200, () => {
      frame++;
      if (frame === at) jump(s);
      const eye = s.game.pose[2] as number;
      if (!Number.isNaN(prev)) minDelta = Math.min(minDelta, eye - prev);
      prev = eye;
    });
    // Up the whole flight, and not yet off its far end.
    expect(s.client.predictor.state.origin[2] as number).toBeGreaterThan(100);
    expect(s.client.predictor.state.groundEntity).not.toBe(ENTITY_NONE);
    return { drop: minDelta, s };
  }

  it("never drops the eye on the stairs across a clock step (fast-forward or hold)", () => {
    for (const k of [3, -3]) {
      for (const at of [9, 11, 13, 25, 40]) {
        const { drop } = climbWithJump(at, (s) => {
          // The clock asks for one k-tick step on the next snapshot.
          const clock = s.client.clock;
          const health = clock.onSnapshotHealth.bind(clock);
          let fired = false;
          clock.onSnapshotHealth = (h, serverTick, clientTick, target) => {
            const step = health(h, serverTick, clientTick, target);
            if (fired) return step;
            fired = true;
            return k;
          };
        });
        expect(drop, `step ${k} at frame ${at}`).toBeGreaterThanOrEqual(-1e-9);
      }
    }
  });

  it("never drops the eye on the stairs across a hard resync after a stall", () => {
    for (const at of [10, 14, 16, 20]) {
      let before = Number.NaN;
      const { drop, s } = climbWithJump(at, (s) => {
        before = s.client.stats.totals[STAT_HARD_RESYNCS] as number;
        s.hitch(150);
      });
      expect(s.client.stats.totals[STAT_HARD_RESYNCS], `stall at frame ${at}`).toBe(before + 1);
      expect(drop, `stall at frame ${at}`).toBeGreaterThanOrEqual(-1e-9);
    }
  });

  it("interpolates the view angles the short way round, through yaw 0 and pitch 0", () => {
    const YAW_RATE = 300;
    const PITCH_RATE = 100;
    class Turn implements CmdSampler {
      private n = 0;
      sample(cmd: UserCmd, ps: Readonly<PlayerState>): void {
        const i = this.n++;
        cmd.buttons = 0;
        cmd.forward = 0;
        cmd.right = 0;
        cmd.up = 0;
        // Clockwise through 0/65535, and pitch in a triangle wave through 0 (±20 steps).
        cmd.yaw = (ps.viewYaw - YAW_RATE) & 0xffff;
        const k = i % 80;
        cmd.pitch = ((k < 40 ? k - 20 : 60 - k) * PITCH_RATE) & 0xffff;
        cmd.weaponSlot = 0;
      }
    }
    const s = session(new Turn());
    const yaws: number[] = [];
    const pitches: number[] = [];
    s.run(3000, () => {
      if (s.client.active) {
        yaws.push(s.game.pose[3] as number);
        pitches.push(s.game.pose[4] as number);
      }
    });
    const perTickYaw = (YAW_RATE * 360) / 65536;
    const perTickPitch = (PITCH_RATE * 360) / 65536;
    let maxYaw = 0;
    let minYaw = 0;
    let maxPitch = 0;
    // Skip the spawn fill's first frames.
    for (let i = 20; i < yaws.length; i++) {
      let d = (yaws[i] as number) - (yaws[i - 1] as number);
      d -= 360 * Math.round(d / 360);
      maxYaw = Math.max(maxYaw, d);
      minYaw = Math.min(minYaw, d);
      maxPitch = Math.max(maxPitch, Math.abs((pitches[i] as number) - (pitches[i - 1] as number)));
    }
    // 144 Hz frames over 60 Hz ticks: about 0.42 of a tick's turn per frame, never a whole one.
    expect(minYaw).toBeLessThan(-0.3 * perTickYaw);
    expect(minYaw).toBeGreaterThan(-0.75 * perTickYaw);
    expect(maxYaw).toBeLessThanOrEqual(1e-9);
    expect(maxPitch).toBeGreaterThan(0.3 * perTickPitch);
    expect(maxPitch).toBeLessThan(0.75 * perTickPitch);
    expect(Math.min(...pitches)).toBeLessThan(-5);
    expect(Math.max(...pitches)).toBeGreaterThan(5);
  });
});

describe("boot URL parameters (M2 design §2 autotest hooks)", () => {
  it("reads autotest, bot and a five-number camera", () => {
    expect(parseBootParams("?autotest=1&bot=circle")).toEqual({
      autotest: true,
      bot: "circle",
      camera: null,
    });
    expect(parseBootParams("").autotest).toBe(false);
    expect(parseBootParams("?autotest=yes").autotest).toBe(false);
    expect(parseBootParams("?cam=1,-2,3.5,90,10").camera).toEqual([1, -2, 3.5, 90, 10]);
    for (const bad of ["1,2,3,4", "1,2,3,4,5,6", "1,2,,4,5", "a,2,3,4,5", "1,2,3,4,Infinity"]) {
      expect(parseBootParams(`?cam=${bad}`).camera, bad).toBeNull();
    }
  });
});
