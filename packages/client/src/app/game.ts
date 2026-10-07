import {
  CONTENTS_WATER,
  HULL_CROUCHED_MAXS,
  HULL_MINS,
  HULL_STANDING_MAXS,
  MASK_SOLID,
  PlayerState,
  PMEV_STEP,
  PMF_CROUCHED,
  PmoveTraceLog,
  pointContents,
  TraceResult,
  traceBox,
  u16ToDegrees,
  VIEW_HEIGHT_CROUCHED,
  VIEW_HEIGHT_STANDING,
  vec3,
} from "@game/shared";
import { ClientSettings, refreshClientSettings } from "../console/clientCvars";
import type { GameHud } from "../hud/overlay";
import type { MouseLook } from "../input/mouse";
import {
  type ClientSim,
  STAT_CORRECTIONS,
  STAT_HARD_RESYNCS,
  STAT_SNAPSHOTS,
  STAT_STARVED,
  STAT_STARVED_CORRECTIONS,
  StepSmoother,
  TICK_MS,
  ViewHeight,
} from "../net";
import { DebugLines } from "../render/debug/debugDraw";
import type { GameRenderer } from "../render/renderer";
import { refreshViewSettings, ViewSettings } from "../render/viewCvars";

/** Degrees per u16 angle unit. */
const DEG_PER_U16 = 360 / 65536;
/** How often the autotest status is written to the page, ms (it allocates strings). */
const STATUS_INTERVAL_MS = 250;
const RAD_PER_DEG = Math.PI / 180;
/** `cl_thirdPerson` pulls the camera this far behind the eye, u (M2 design §2). */
export const THIRD_PERSON_DISTANCE = 120;
/** The third-person camera's box, kept clear of walls by a trace (half-size 4 u). */
const CAMERA_MINS = vec3(-4, -4, -4);
const CAMERA_MAXS = vec3(4, 4, 4);

/** Where the autotest hooks report (M2 design §2): `document.documentElement.dataset`. */
export type StatusSink = Record<string, string | undefined>;

/**
 * A fixed camera instead of the player's eye (`?cam=x,y,z,yaw,pitch` in sim units and degrees),
 * for screenshots and look-dev. Presentation only: the player still runs.
 */
export type CameraOverride = readonly [number, number, number, number, number];

export interface GameOptions {
  readonly client: ClientSim;
  /** Null when WebGL is unavailable: the sim and the network still run. */
  readonly renderer: GameRenderer | null;
  /** The autotest status sink, or null outside autotest. */
  readonly status: StatusSink | null;
  readonly camera?: CameraOverride | null;
  /**
   * The player's mouse look: the view uses its live angles (the cmds carry them rounded). Null
   * for scripted input, whose view follows the predicted angles.
   */
  readonly look?: MouseLook | null;
  /** The DOM overlay; null in tests and headless runs. */
  readonly hud?: GameHud | null;
  /** Runs at the end of every frame (the page drains the server's PRINTs into the console). */
  readonly onFrame?: (() => void) | null;
}

/**
 * The frame loop (docs/06 §7 "Render loop", M2 design §2 "Frame order"): per animation frame,
 * the mouse's counts turn the view, then the client's frame (poll and reconcile, then the tick
 * accumulator: sample, predict, send), then the view from the interpolated prediction (render
 * offset, step smoothing, eye height, the third-person pull-back), the debug lines, the scene
 * and the HUD. The view only reads the prediction; it never changes it.
 */
export class Game {
  readonly settings = new ViewSettings();
  readonly clientSettings = new ClientSettings();
  /** The segments the renderer's debug draw shows (`r_debug*`). */
  readonly debugLines = new DebugLines();
  /** pmove's traces of this frame's first predictions, while `r_debugTraces` is on. */
  readonly traceLog = new PmoveTraceLog();
  /** The camera is inside water this frame (the HUD tints the view). */
  underwater = false;
  /** The view this frame: [0..2] eye position (sim u), [3] yaw, [4] pitch (degrees). */
  readonly pose = new Float64Array(5);
  frames = 0;
  /**
   * Frames that came longer after the previous one than the input buffer the clock keeps
   * (`cl_inputBuffer` ticks, 33 ms by default): the slack of the prediction's lead, whose rest
   * covers the round trip. On `lan` such a gap can starve the server and hard-resync by design
   * (D-028 known limit); it says nothing about the prediction.
   */
  longFrames = 0;
  /** Hard resyncs that came in a long frame (the rest would be prediction faults). */
  lateResyncs = 0;
  private readonly client: ClientSim;
  private readonly renderer: GameRenderer | null;
  private readonly status: StatusSink | null;
  private readonly cameraOverride: CameraOverride | null;
  /** [0] render time in ticks (the step smoother's clock). */
  private readonly renderTick = new Float64Array(1);
  private readonly steps: StepSmoother;
  private readonly eye: ViewHeight;
  private readonly origin = vec3();
  private readonly stepOffset = new Float64Array(1);
  private readonly prev = new PlayerState();
  private wasActive = false;
  private firstTick = -1;
  private lastStatus = Number.NEGATIVE_INFINITY;
  /**
   * Frame timing: [0] the previous frame's time (ms; NaN before the first), [1] the longest gap
   * since the last report, [2] the hard resyncs before this frame's client step.
   */
  private readonly timing = new Float64Array([Number.NaN, 0, 0]);
  /** [0..2] the predicted origin at the last report, [3] horizontal path length since spawn. */
  private readonly travel = new Float64Array([Number.NaN, 0, 0, 0]);
  private running = false;
  private readonly frameCb: () => void;
  private readonly look: MouseLook | null;
  private readonly hud: GameHud | null;
  private readonly onFrame: (() => void) | null;
  private readonly camStart = vec3();
  private readonly camEnd = vec3();
  private readonly camTrace = new TraceResult();

  constructor(options: GameOptions) {
    this.client = options.client;
    this.renderer = options.renderer;
    this.status = options.status;
    this.cameraOverride = options.camera ?? null;
    this.look = options.look ?? null;
    this.hud = options.hud ?? null;
    this.onFrame = options.onFrame ?? null;
    this.steps = new StepSmoother(this.renderTick);
    this.eye = new ViewHeight(this.client.now);
    this.frameCb = () => this.loop();
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    requestAnimationFrame(this.frameCb);
  }

  stop(): void {
    this.running = false;
  }

  private loop(): void {
    if (!this.running) return;
    this.frame();
    requestAnimationFrame(this.frameCb);
  }

  /** One frame (see the class comment). */
  frame(): void {
    const c = this.client;
    const cs = this.clientSettings;
    refreshClientSettings(c.cvars, cs);
    // Mouse look is immediate: this frame's ticks sample the turned view.
    if (this.look !== null) this.look.apply(cs);
    const p = c.predictor;
    if (cs.debugTraces) {
      p.traceLog = this.traceLog;
      this.traceLog.clear();
    } else if (p.traceLog !== null) {
      p.traceLog = null;
      this.debugLines.clearTraces();
    }
    this.timing[2] = c.stats.totals[STAT_HARD_RESYNCS] as number;
    c.frame();
    this.frames++;
    this.timeFrame();
    refreshViewSettings(c.cvars, this.settings);
    const active = c.active;
    if (active) {
      if (!this.wasActive) {
        // Spawned (or reconnected): nothing to smooth from. A resync keeps the session active
        // and is carried by pathShift and the jumped events instead.
        this.steps.clear();
        this.eye.reset(VIEW_HEIGHT_STANDING);
        if (this.firstTick < 0) this.firstTick = c.startTick;
        // Face the way the server spawned us.
        const ps = p.state;
        this.look?.set(u16ToDegrees(ps.viewYaw), (((ps.viewPitch << 16) >> 16) * 360) / 65536);
      }
      this.steps.shift(c.pathShift[0] as number);
      this.fileSteps();
      this.updatePose();
      this.updateDebug();
      const cam = this.camStart;
      cam[0] = this.pose[0] as number;
      cam[1] = this.pose[1] as number;
      cam[2] = this.pose[2] as number;
      this.underwater = (pointContents(c.world, cam) & CONTENTS_WATER) !== 0;
    }
    this.wasActive = active;
    const r = this.renderer;
    if (r !== null && active) {
      r.view.pose.set(this.pose);
      r.debug.update(this.debugLines, cs.debugTraces);
      r.render(this.settings.fov);
    }
    if (this.hud !== null) this.hud.frame(c, cs, active && this.underwater);
    if (this.status !== null) this.report();
    if (this.onFrame !== null) this.onFrame();
  }

  /** The gap since the previous frame: the longest per report, the long frames and their resyncs. */
  private timeFrame(): void {
    const c = this.client;
    const g = this.timing;
    const prev = g[0] as number;
    g[0] = c.now[0] as number;
    if (Number.isNaN(prev)) return;
    const dt = (g[0] as number) - prev;
    if (dt > (g[1] as number)) g[1] = dt;
    if (dt <= c.settings.inputBuffer * TICK_MS) return;
    this.longFrames++;
    if ((c.stats.totals[STAT_HARD_RESYNCS] as number) > (g[2] as number)) this.lateResyncs++;
  }

  /** The `r_debug*` segments: this frame's traces, the hull where it is drawn, the ground. */
  private updateDebug(): void {
    const cs = this.clientSettings;
    const d = this.debugLines;
    if (cs.debugTraces) d.takeTraces(this.traceLog);
    d.beginShapes();
    if (!cs.debugHull && !cs.debugGround) return;
    const p = this.client.predictor;
    const maxs = (p.state.flags & PMF_CROUCHED) !== 0 ? HULL_CROUCHED_MAXS : HULL_STANDING_MAXS;
    if (cs.debugHull) d.hull(this.origin, HULL_MINS, maxs);
    // Traced from the predicted state, which pmove left on the grid and out of solid; drawn
    // under the interpolated origin with the hull.
    if (cs.debugGround) {
      const params = p.paramsFor(p.latestTick);
      d.ground(this.client.world, p.state.origin, HULL_MINS, maxs, params, this.origin);
    }
  }

  /**
   * `cl_thirdPerson`: the camera THIRD_PERSON_DISTANCE behind the eye along the view, pulled in
   * where a wall is closer (a small box traced from the eye). Presentation only.
   */
  private pullBack(): void {
    const pose = this.pose;
    const yaw = (pose[3] as number) * RAD_PER_DEG;
    const pitch = (pose[4] as number) * RAD_PER_DEG;
    const cp = Math.cos(pitch);
    const a = this.camStart;
    const b = this.camEnd;
    a[0] = pose[0] as number;
    a[1] = pose[1] as number;
    a[2] = pose[2] as number;
    // Forward is (cos p · cos y, cos p · sin y, −sin p): positive pitch looks down.
    b[0] = (a[0] as number) - cp * Math.cos(yaw) * THIRD_PERSON_DISTANCE;
    b[1] = (a[1] as number) - cp * Math.sin(yaw) * THIRD_PERSON_DISTANCE;
    b[2] = (a[2] as number) + Math.sin(pitch) * THIRD_PERSON_DISTANCE;
    const tr = this.camTrace;
    traceBox(this.client.world, a, b, CAMERA_MINS, CAMERA_MAXS, MASK_SOLID, tr);
    if (tr.allSolid) return;
    pose[0] = tr.endpos[0] as number;
    pose[1] = tr.endpos[1] as number;
    pose[2] = tr.endpos[2] as number;
  }

  /**
   * Gives the step smoother this frame's STEP events, except those predicted under a path jump:
   * the render offset already holds the drawn position across their rise.
   */
  private fileSteps(): void {
    const ev = this.client.events;
    for (let i = 0; i < ev.count; i++) {
      if (ev.types[i] !== PMEV_STEP || ev.jumped[i] === 1) continue;
      this.steps.add(ev.ticks[i] as number, ev.values[i] as number, this.settings.stepSmoothMs);
    }
  }

  /** The eye: interpolated origin + render offset + step smoothing + eye height; the angles. */
  private updatePose(): void {
    const c = this.client;
    const pose = this.pose;
    // The drawn origin first: the debug hull and ground normal follow the player even when a
    // fixed camera watches.
    c.renderOrigin(this.origin);
    const o = this.cameraOverride;
    if (o !== null) {
      pose[0] = o[0];
      pose[1] = o[1];
      pose[2] = o[2];
      pose[3] = o[3];
      pose[4] = o[4];
      return;
    }
    const p = c.predictor;
    const ps = p.state;
    c.renderTick(this.renderTick, 0);
    this.steps.sample(this.stepOffset, 0);
    const crouched = (ps.flags & PMF_CROUCHED) !== 0;
    this.eye.update(
      crouched ? VIEW_HEIGHT_CROUCHED : VIEW_HEIGHT_STANDING,
      VIEW_HEIGHT_STANDING - VIEW_HEIGHT_CROUCHED,
      this.settings.viewHeightSmoothMs,
    );
    const origin = this.origin;
    pose[0] = origin[0] as number;
    pose[1] = origin[1] as number;
    pose[2] =
      (origin[2] as number) + (this.stepOffset[0] as number) + (this.eye.height[0] as number);
    // Scripted input's view follows the predicted angles, interpolated like the origin and
    // along the shorter way round; the player's mouse look replaces them below.
    const prev = this.prev;
    if (!p.stateAt(p.latestTick - 1, prev)) {
      prev.viewYaw = ps.viewYaw;
      prev.viewPitch = ps.viewPitch;
    }
    // The accumulator's fraction, from the render tick (a getter's double would box per frame).
    const a = (this.renderTick[0] as number) - (p.latestTick - 1);
    // Wrapped to signed 16 bits inline: a call taking a double operand would box it per frame.
    const yaw0 = prev.viewYaw | 0;
    const dyaw = (((ps.viewYaw | 0) - yaw0) << 16) >> 16;
    const pitch0 = ((prev.viewPitch | 0) << 16) >> 16;
    const pitch1 = ((ps.viewPitch | 0) << 16) >> 16;
    pose[3] = (yaw0 + dyaw * a) * DEG_PER_U16;
    pose[4] = (pitch0 + (pitch1 - pitch0) * a) * DEG_PER_U16;
    const look = this.look;
    if (look !== null) {
      // The player's view: the live mouse angles, not the cmds' rounded ones.
      pose[3] = look.angles[0] as number;
      pose[4] = look.angles[1] as number;
    }
    if (this.clientSettings.thirdPerson) this.pullBack();
  }

  /** Autotest status (M2 design §2), a few times a second. */
  private report(): void {
    const c = this.client;
    const now = c.now[0] as number;
    if (now - this.lastStatus < STATUS_INTERVAL_MS) return;
    this.lastStatus = now;
    const s = this.status as StatusSink;
    const t = c.stats.totals;
    if (s.state !== "error") s.state = c.closed ? "closed" : c.active ? "running" : "connecting";
    s.frames = String(this.frames);
    // The page clock at this report (ms), so a reader can rate `frames` without its own read lag.
    s.statusAt = String(Math.round(now));
    s.ticks = String(this.firstTick < 0 ? 0 : Math.max(0, c.predictor.latestTick - this.firstTick));
    s.snapshots = String(t[STAT_SNAPSHOTS]);
    s.corrections = String(t[STAT_CORRECTIONS]);
    s.hardResyncs = String(t[STAT_HARD_RESYNCS]);
    s.starved = String(t[STAT_STARVED]);
    s.starvedCorrections = String(t[STAT_STARVED_CORRECTIONS]);
    // Frame timing, which explains the hard resyncs and starved cmds of a slow host (D-028).
    s.longFrames = String(this.longFrames);
    s.lateResyncs = String(this.lateResyncs);
    s.maxFrameMs = String(Math.round(this.timing[1] as number));
    this.timing[1] = 0;
    s.drawCalls = String(this.renderer?.drawCalls ?? 0);
    s.triangles = String(this.renderer?.triangles ?? 0);
    // How far the player went (u, horizontal, sampled per report): proof a bot moves.
    const tr = this.travel;
    if (c.active) {
      const o = c.predictor.state.origin;
      if (!Number.isNaN(tr[0] as number)) {
        tr[3] =
          (tr[3] as number) +
          Math.hypot((o[0] as number) - (tr[0] as number), (o[1] as number) - (tr[1] as number));
      }
      tr[0] = o[0] as number;
      tr[1] = o[1] as number;
      tr[2] = o[2] as number;
    }
    s.distance = String(Math.round(tr[3] as number));
  }
}
