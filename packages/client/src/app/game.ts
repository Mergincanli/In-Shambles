import {
  PlayerState,
  PMEV_STEP,
  PMF_CROUCHED,
  VIEW_HEIGHT_CROUCHED,
  VIEW_HEIGHT_STANDING,
  vec3,
} from "@game/shared";
import { type ClientSim, STAT_CORRECTIONS, STAT_SNAPSHOTS, StepSmoother, ViewHeight } from "../net";
import type { GameRenderer } from "../render/renderer";
import { refreshViewSettings, ViewSettings } from "../render/viewCvars";

/** Degrees per u16 angle unit. */
const DEG_PER_U16 = 360 / 65536;
/** How often the autotest status is written to the page, ms (it allocates strings). */
const STATUS_INTERVAL_MS = 250;

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
}

/**
 * The frame loop (docs/06 §7 "Render loop", M2 design §2 "Frame order"): per animation frame,
 * the client's frame (poll and reconcile, then the tick accumulator: sample, predict, send),
 * then the view from the interpolated prediction (render offset, step smoothing, eye height),
 * then the scene. The view only reads the prediction; it never changes it.
 */
export class Game {
  readonly settings = new ViewSettings();
  /** The view this frame: [0..2] eye position (sim u), [3] yaw, [4] pitch (degrees). */
  readonly pose = new Float64Array(5);
  frames = 0;
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
  /** [0..2] the predicted origin at the last report, [3] horizontal path length since spawn. */
  private readonly travel = new Float64Array([Number.NaN, 0, 0, 0]);
  private running = false;
  private readonly frameCb: () => void;

  constructor(options: GameOptions) {
    this.client = options.client;
    this.renderer = options.renderer;
    this.status = options.status;
    this.cameraOverride = options.camera ?? null;
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
    c.frame();
    this.frames++;
    refreshViewSettings(c.cvars, this.settings);
    const active = c.active;
    if (active) {
      if (!this.wasActive) {
        // Spawned (or reconnected): nothing to smooth from. A resync keeps the session active
        // and is carried by pathShift and the jumped events instead.
        this.steps.clear();
        this.eye.reset(VIEW_HEIGHT_STANDING);
        if (this.firstTick < 0) this.firstTick = c.startTick;
      }
      this.steps.shift(c.pathShift[0] as number);
      this.fileSteps();
      this.updatePose();
    }
    this.wasActive = active;
    const r = this.renderer;
    if (r !== null && active) {
      r.view.pose.set(this.pose);
      r.render(this.settings.fov);
    }
    if (this.status !== null) this.report();
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
    c.renderOrigin(this.origin);
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
    // Until mouse look (increment 12) the view follows the predicted angles, interpolated like
    // the origin and along the shorter way round.
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
    s.ticks = String(this.firstTick < 0 ? 0 : Math.max(0, c.predictor.latestTick - this.firstTick));
    s.snapshots = String(t[STAT_SNAPSHOTS]);
    s.corrections = String(t[STAT_CORRECTIONS]);
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
