import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Match } from "@game/server";
import {
  buildCollisionWorld,
  CvarRegistry,
  createLoopbackPair,
  decodeCmap,
  degreesToU16,
  ENTITY_NONE,
  MOVE_AXIS_MAX,
  PlayerState,
  registerPmoveCvars,
  TRACE_EPSILON,
  type UserCmd,
  VIEW_HEIGHT_STANDING,
} from "@game/shared";
import { describe, expect, it } from "vitest";
import {
  type CameraOverride,
  Game,
  type GameOptions,
  type StatusSink,
  THIRD_PERSON_DISTANCE,
} from "../../src/app/game";
import { parseBootParams } from "../../src/app/params";
import { ACTION_FORWARD, ACTION_JUMP, Binds } from "../../src/console/binds";
import { registerClientCvars } from "../../src/console/clientCvars";
import { type ConsoleHost, runConsoleCommand } from "../../src/console/commands";
import type { GameHud } from "../../src/hud/overlay";
import { MouseLook } from "../../src/input/mouse";
import { ActionState, PlayerInput } from "../../src/input/sampler";
import {
  ClientSim,
  type CmdSampler,
  NeutralInput,
  STAT_HARD_RESYNCS,
  StrafeCircuit,
} from "../../src/net";

const mapUrl = new URL("../../../../content/maps/movement_lab.cmap", import.meta.url);
const cmap = decodeCmap(new Uint8Array(readFileSync(fileURLToPath(mapUrl))));
const world = buildCollisionWorld(cmap);
const BUILD = "game-test";

/** The page's pieces without the page: a Match, a client over loopback, a Game, a fake clock. */
function session(
  input: CmdSampler,
  camera: CameraOverride | null = null,
  extra: Pick<GameOptions, "look" | "hud"> = {},
) {
  const now = { t: 0 };
  const [clientEnd, serverEnd] = createLoopbackPair();
  const match = new Match({ cmap, world, buildHash: BUILD });
  match.connect(serverEnd, true);
  // The page's registry (boot.ts), so the client cvars are the registered ones.
  const cvars = new CvarRegistry();
  registerPmoveCvars(cvars);
  registerClientCvars(cvars);
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
  const game = new Game({ client, renderer: null, status, camera, ...extra });
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

describe("player input, console, HUD and debug draw in the frame (M2 increment 12)", () => {
  /** The player's input path: actions and mouse look feeding PlayerInput. */
  function player() {
    const actions = new ActionState();
    const look = new MouseLook();
    const frames: { underwater: boolean; speedometer: boolean }[] = [];
    const hud: GameHud = {
      frame: (_client, settings, underwater) => {
        frames.push({ underwater, speedometer: settings.speedometer });
      },
    };
    const s = session(new PlayerInput(actions, look), null, { look, hud });
    return { ...s, actions, look, frames };
  }

  it("faces the spawn, turns with the mouse at once and sends the turned yaw", () => {
    const p = player();
    p.run(1000);
    expect(p.client.active).toBe(true);
    expect([p.game.pose[3], p.game.pose[4]]).toEqual([0, 0]);
    // 409.09 counts × 5 × 0.022 = 45° to the right (yaw decreases).
    p.look.addCounts(409.0909090909091, 0);
    p.game.frame();
    expect(p.game.pose[3]).toBeCloseTo(315, 9);
    p.actions.press(ACTION_FORWARD);
    p.run(1000);
    const ps = p.client.predictor.state;
    expect(ps.viewYaw).toBe(degreesToU16(315));
    // Running at 45° below +X: x grows and y falls by the same amount.
    const v = ps.velocity;
    expect(v[0] as number).toBeGreaterThan(200);
    expect((v[0] as number) + (v[1] as number)).toBeCloseTo(0, 6);
    expect(p.match.session(0)?.player.viewYaw).toBe(degreesToU16(315));
    expect(Number(p.status.corrections)).toBe(0);
  });

  it("turns the view before the frame's ticks sample it", () => {
    const p = player();
    p.run(1000);
    const before = p.client.predictor.latestTick;
    p.look.addCounts(409.0909090909091, 0);
    // A tick's worth of stall (short of a resync), so the next frame predicts: its first tick
    // already carries the turn.
    p.hitch(18);
    p.game.frame();
    expect(p.client.predictor.latestTick).toBeGreaterThan(before);
    const first = new PlayerState();
    expect(p.client.predictor.stateAt(before + 1, first)).toBe(true);
    expect(first.viewYaw).toBe(degreesToU16(315));
  });

  it("faces the server's spawn yaw when it spawns", () => {
    const spawn = cmap.entities.find((e) => e.classname === "info_player_start");
    if (spawn === undefined) throw new Error("movement_lab has no info_player_start");
    const angles = spawn.angles;
    // The Match reads the spawn angle when it is built.
    (spawn as { angles?: unknown }).angles = [0, 135, 0];
    let p: ReturnType<typeof player>;
    try {
      p = player();
    } finally {
      (spawn as { angles?: unknown }).angles = angles;
    }
    p.run(1000);
    expect(p.client.active).toBe(true);
    expect(p.look.angles[0]).toBeCloseTo(135, 9);
    expect(p.look.angles[1]).toBe(0);
    expect(p.game.pose[3]).toBeCloseTo(135, 9);
    expect(p.match.session(0)?.player.viewYaw).toBe(degreesToU16(135));
  });

  it("hands the HUD every frame and tints it under water", () => {
    const p = player();
    p.run(800);
    expect(p.frames.length).toBeGreaterThan(100);
    expect(p.frames.some((f) => f.underwater)).toBe(false);
    p.client.cvars.set("cl_speedometer", true);
    placeAt(p, "water_deep");
    p.run(1500);
    expect(p.frames.at(-1)).toEqual({ underwater: true, speedometer: true });
  });

  it("pulls the camera 120 u back in third person, short of walls", () => {
    const p = player();
    p.run(1000);
    const eye = Array.from(p.game.pose.subarray(0, 3));
    p.client.cvars.set("cl_thirdPerson", true);
    p.game.frame();
    expect(p.game.pose[0]).toBeCloseTo((eye[0] as number) - THIRD_PERSON_DISTANCE, 9);
    expect([p.game.pose[1], p.game.pose[2]]).toEqual([eye[1], eye[2]]);
    // Looking down 45°: the camera rises behind the eye.
    p.look.set(0, 45);
    p.game.frame();
    const d = THIRD_PERSON_DISTANCE * Math.SQRT1_2;
    expect(p.game.pose[0]).toBeCloseTo((eye[0] as number) - d, 9);
    expect(p.game.pose[2]).toBeCloseTo((eye[2] as number) + d, 9);
    // Facing the ladder wall from its base, the back is open; turned around, the wall is close.
    placeAt(p, "ladder_base");
    p.look.set(270, 0);
    p.run(600);
    const o = p.client.predictor.state.origin;
    const back = Math.hypot((p.game.pose[0] as number) - o[0], (p.game.pose[1] as number) - o[1]);
    expect(back).toBeLessThan(THIRD_PERSON_DISTANCE - 20);
  });

  it("draws the hull, the ground normal and pmove's traces, keeping the traces between ticks", () => {
    const p = player();
    p.run(1000);
    const lines = p.game.debugLines;
    expect([lines.shapes.count, lines.traces.count]).toEqual([0, 0]);
    p.client.cvars.set("r_debugHull", true);
    p.client.cvars.set("r_debugGround", true);
    p.client.cvars.set("r_debugTraces", true);
    p.run(100);
    // 12 hull edges and the ground normal, straight up from the hull's bottom (it rests within
    // TRACE_EPSILON of the floor, so the short probe stops where it starts).
    expect(lines.shapes.count).toBe(13);
    const g = lines.shapes.positions.subarray(12 * 6, 13 * 6);
    const o = p.client.predictor.state.origin;
    expect(Array.from(g)).toEqual(
      [o[0], o[1], o[2] - 24, o[0], o[1], o[2] - 24 + 32].map(Math.fround),
    );
    expect(lines.traces.count).toBeGreaterThan(0);
    // A frame that predicts no tick keeps the last traces.
    const before = lines.traces.count;
    p.game.frame();
    expect(lines.traces.count).toBe(before);
    p.client.cvars.set("r_debugTraces", false);
    p.game.frame();
    expect(lines.traces.count).toBe(0);
    expect(p.client.predictor.traceLog).toBeNull();
  });

  it("round-trips a console set on a replicated cvar through the server with 0 corrections", () => {
    const p = player();
    p.run(1000);
    const printed: string[] = [];
    const host: ConsoleHost = {
      cvars: p.client.cvars,
      binds: new Binds(),
      print: (t) => printed.push(t),
      clear: () => {},
      toggleConsole: () => {},
      sendServer: (t) => p.client.sendCommand(t),
      net: null,
    };
    p.actions.press(ACTION_FORWARD);
    p.actions.press(ACTION_JUMP);
    runConsoleCommand("set pm_gravity 400", host);
    expect(p.client.cvars.get("pm_gravity")).toBe(800);
    p.run(1500);
    expect(p.client.cvars.get("pm_gravity")).toBe(400);
    expect(p.match.cvars.get("pm_gravity")).toBe(400);
    expect(p.client.prints).toContain("pm_gravity = 400");
    runConsoleCommand("pm_gravity", host);
    expect(printed.at(-1)).toMatch(/^pm_gravity = 400 \(default 800/);
    expect(Number(p.status.corrections)).toBe(0);
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
