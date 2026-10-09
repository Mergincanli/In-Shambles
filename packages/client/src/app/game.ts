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
  ID_P95,
  JM_CHECKED,
  JM_VIOLATIONS,
  RC_DT_MS,
  RemoteJumpMeter,
  type RemoteView,
  STAT_CORRECTIONS,
  STAT_HARD_RESYNCS,
  STAT_REMOTE_EXTRAPOLATED,
  STAT_REMOTE_FRAMES,
  STAT_REMOTE_HELD,
  STAT_RENDER_SNAPS,
  STAT_SNAPSHOTS,
  STAT_SNAPSHOTS_LOST,
  STAT_STARVED,
  STAT_STARVED_CORRECTIONS,
  StepSmoother,
  TICK_MS,
  ViewHeight,
} from "../net";
import { DebugLines } from "../render/debug/debugDraw";
import { BLEND_DT_MS, BLEND_MS } from "../render/players";
import type { GameRenderer } from "../render/renderer";
import { refreshViewSettings, ViewSettings } from "../render/viewCvars";

/** Degrees per u16 angle unit. */
const DEG_PER_U16 = 360 / 65536;
/** How often the autotest status is written to the page, ms (it allocates strings). */
const STATUS_INTERVAL_MS = 250;

// Frame timing slots (`Game.timing`).
/** The previous frame's time (ms; NaN before the first). */
const T_PREV = 0;
/** The longest frame gap since the last report (ms). */
const T_MAX_FRAME = 1;
/** The time of the last frame that took a snapshot (ms; NaN before the first). */
const T_LAST_SNAP = 2;
/** The longest snapshot gap since the last report, and since the start (ms). */
const T_MAX_SNAP_GAP = 3;
const T_PEAK_SNAP_GAP = 4;
/** Link gap excuses end at this page time (ms; -Infinity before the first gap). */
const T_EXCUSE_UNTIL = 5;
/** The last link gap: its length and the page time it ended (ms; NaN before the first). */
const T_LINK_GAP_MS = 6;
const T_LINK_GAP_AT = 7;
/** Counters before this frame's client step: hard resyncs, snapshots, lost, starved, corrected. */
const T_RESYNCS = 8;
const T_SNAPS = 9;
const T_LOST = 10;
const T_STARVED = 11;
const T_STARVED_CORR = 12;
/** The prediction's newest tick before this frame's client step. */
const T_TICK = 13;
/** This frame's gap and the snapshot gap it ended (ms; 0 when it took none). */
const T_DT = 14;
const T_SNAP_GAP = 15;
const T_COUNT = 16;

/**
 * The hard resyncs the status keeps (`resyncLog`, newest last): the M2 loaded-run carry-over
 * (one e2e run in 18 with 2 cores busy had a hard resync in a normal-length frame), so a failure
 * shows the frame and server-tick timing around it.
 */
const RESYNC_LOG = 4;
// Fields of a resyncLog record: page time, frame gap and snapshot gap (ms), the predicted tick
// before the frame, the server tick it resynced to, the lead after, the round trip (ms), the
// clock's low edge before.
const RL_AT = 0;
const RL_DT = 1;
const RL_SNAP_GAP = 2;
const RL_PREDICTED = 3;
const RL_SERVER = 4;
const RL_LEAD = 5;
const RL_RTT = 6;
const RL_LOW = 7;
const RL_FIELDS = 8;

function newTiming(): Float64Array {
  const g = new Float64Array(T_COUNT);
  g[T_PREV] = Number.NaN;
  g[T_LAST_SNAP] = Number.NaN;
  g[T_EXCUSE_UNTIL] = Number.NEGATIVE_INFINITY;
  g[T_LINK_GAP_MS] = Number.NaN;
  g[T_LINK_GAP_AT] = Number.NaN;
  return g;
}
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
  /**
   * NET-05's step criterion on the drawn remotes (D-037), judged on the frames that are not long
   * (a long frame's gap is the host's, as for the prediction's health): `remoteJumps`.
   */
  readonly remoteJumps = new RemoteJumpMeter();
  frames = 0;
  /**
   * Frames that came longer after the previous one than the input buffer (`cl_inputBuffer` ticks,
   * 33 ms by default): the slack of the prediction's lead with steady frames, whose rest covers
   * the round trip (the clock keeps the health's low edge at it − 1 or more, lifting it to it, so
   * steady frames keep the health at it; bursty frames grow the lead, D-028). On `lan` such a gap
   * can starve the server and hard-resync by design until the clock has grown the lead for it; it
   * says nothing about the prediction.
   */
  longFrames = 0;
  /** Hard resyncs that came in a long frame (the rest would be prediction faults). */
  lateResyncs = 0;
  /**
   * Link gaps: frames that ended a gap in the snapshot stream longer than `cl_inputBuffer` ticks
   * plus their own frame gap (50 ms at 60 fps; frames on time take snapshots at most two frames
   * apart) by taking a burst of two or more with none lost in between. That is the trace of a link
   * that held the snapshots and then let them through together (the browser's network process,
   * stalled on a busy host, holds them both ways at once: seen in the e2e, 8 INPUTs sent at 60 fps
   * reaching the Node server together 60–120 ms late, the snapshots 35–50 ms late). A gap a lost
   * snapshot or a NetSim drop leaves ends with a tick jump and is not one. Such a stall can starve
   * the server with no long frame, like one on a real link (D-028).
   */
  linkGaps = 0;
  /**
   * Starved flags (and starved corrections) taken by the frame that ended a link gap or within
   * the gap's length plus the round trip and twice the input buffer after it: the cmds that link
   * stall held. The e2e excuses only these, never the rest of its window.
   */
  starvedAfterGap = 0;
  starvedCorrectionsAfterGap = 0;
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
  /** Frame timing, indexed by the T_* constants (allocation-free in `frame`). */
  private readonly timing = newTiming();
  /**
   * The last starve the client heard of (a probe for the e2e's failure messages): [0] the page
   * time (ms; NaN before any), [1] the prediction's lead over the snapshot (ticks), [2] the
   * clock's low edge and [3] mean of the input buffer health (ticks), [4] the frame's gap and
   * [5] the snapshot gap it ended (ms), [6] the round trip (ms).
   */
  private readonly lastStarve = new Float64Array(7).fill(Number.NaN);
  /** The last RESYNC_LOG hard resyncs, RL_FIELDS each, a ring from `resyncHead`. */
  private readonly resyncs = new Float64Array(RESYNC_LOG * RL_FIELDS);
  private resyncHead = 0;
  private resyncCount = 0;
  /** The clock's low edge before this frame's step. */
  private resyncLow = 0;
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
  /** The capsules' crouch blend: [BLEND_DT_MS] this frame's time, [BLEND_MS] its length. */
  private readonly blend = new Float64Array(2);

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

  /** The other players this frame, as the renderer draws them (D-037). */
  get remotes(): RemoteView {
    return this.client.remotes.view;
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
    const g = this.timing;
    const totals = c.stats.totals;
    g[T_RESYNCS] = totals[STAT_HARD_RESYNCS] as number;
    g[T_SNAPS] = totals[STAT_SNAPSHOTS] as number;
    g[T_LOST] = totals[STAT_SNAPSHOTS_LOST] as number;
    g[T_STARVED] = totals[STAT_STARVED] as number;
    g[T_STARVED_CORR] = totals[STAT_STARVED_CORRECTIONS] as number;
    g[T_TICK] = p.latestTick;
    this.resyncLow = c.clock.bufferLow;
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
    c.updateRemotes();
    if (active) {
      const long = (c.remotes.clock.t[RC_DT_MS] as number) > c.settings.inputBuffer * TICK_MS;
      this.remoteJumps.measure(c.remotes, !long);
    } else if (this.wasActive) {
      this.remoteJumps.reset();
    }
    this.wasActive = active;
    const r = this.renderer;
    if (r !== null && active) {
      r.view.pose.set(this.pose);
      const blend = this.blend;
      blend[BLEND_DT_MS] = c.remotes.clock.t[RC_DT_MS] as number;
      blend[BLEND_MS] = c.settings.remoteCrouchBlendMs;
      r.players.update(c.remotes.view, blend);
      r.debug.update(this.debugLines, cs.debugTraces);
      r.render(this.settings.fov);
    }
    if (this.hud !== null) this.hud.frame(c, cs, active && this.underwater);
    if (this.status !== null) this.report();
    if (this.onFrame !== null) this.onFrame();
  }

  /**
   * The gap since the previous frame (the longest per report, the long frames and their resyncs)
   * and, when this frame took snapshots, the gap since the last frame that did (the longest per
   * report and overall, the link gaps and the starves they excuse).
   */
  private timeFrame(): void {
    const c = this.client;
    const g = this.timing;
    const totals = c.stats.totals;
    const prev = g[T_PREV] as number;
    const now = c.now[0] as number;
    g[T_PREV] = now;
    const buffer = c.settings.inputBuffer * TICK_MS;
    const dt = Number.isNaN(prev) ? 0 : now - prev;
    const took = (totals[STAT_SNAPSHOTS] as number) - (g[T_SNAPS] as number);
    let snapGap = 0;
    if (took > 0) {
      const last = g[T_LAST_SNAP] as number;
      g[T_LAST_SNAP] = now;
      if (!Number.isNaN(last)) {
        snapGap = now - last;
        if (snapGap > (g[T_MAX_SNAP_GAP] as number)) g[T_MAX_SNAP_GAP] = snapGap;
        if (snapGap > (g[T_PEAK_SNAP_GAP] as number)) g[T_PEAK_SNAP_GAP] = snapGap;
        // A held stream comes through as a burst; a lost snapshot leaves a tick jump instead.
        const lost = (totals[STAT_SNAPSHOTS_LOST] as number) > (g[T_LOST] as number);
        if (snapGap > buffer + dt && took >= 2 && !lost) {
          this.linkGaps++;
          g[T_LINK_GAP_MS] = snapGap;
          g[T_LINK_GAP_AT] = now;
          g[T_EXCUSE_UNTIL] = now + snapGap + c.clock.rttMs + 2 * buffer;
        }
      }
    }
    const starved = (totals[STAT_STARVED] as number) - (g[T_STARVED] as number);
    if (starved > 0) {
      const excused = now <= (g[T_EXCUSE_UNTIL] as number);
      if (excused) {
        this.starvedAfterGap += starved;
        this.starvedCorrectionsAfterGap +=
          (totals[STAT_STARVED_CORRECTIONS] as number) - (g[T_STARVED_CORR] as number);
      }
      const p = c.predictor;
      const st = this.lastStarve;
      st[0] = now;
      st[1] = p.latestTick - p.snapshotTick;
      st[2] = c.clock.bufferLow;
      st[3] = c.clock.bufferHealth;
      st[4] = dt;
      st[5] = snapGap;
      st[6] = c.clock.rttMs;
    }
    if ((totals[STAT_HARD_RESYNCS] as number) > (g[T_RESYNCS] as number)) {
      // Doubles go through the slots: a call taking them would box them under native ESM.
      g[T_DT] = dt;
      g[T_SNAP_GAP] = snapGap;
      this.logResync();
    }
    if (Number.isNaN(prev)) return;
    if (dt > (g[T_MAX_FRAME] as number)) g[T_MAX_FRAME] = dt;
    if (dt <= buffer) return;
    this.longFrames++;
    if ((totals[STAT_HARD_RESYNCS] as number) > (g[T_RESYNCS] as number)) this.lateResyncs++;
  }

  /** Files this frame's hard resync in the resyncLog ring (its gaps from T_DT, T_SNAP_GAP). */
  private logResync(): void {
    const c = this.client;
    const p = c.predictor;
    const g = this.timing;
    const r = this.resyncs;
    const at = this.resyncHead * RL_FIELDS;
    r[at + RL_AT] = c.now[0] as number;
    r[at + RL_DT] = g[T_DT] as number;
    r[at + RL_SNAP_GAP] = g[T_SNAP_GAP] as number;
    r[at + RL_PREDICTED] = g[T_TICK] as number;
    r[at + RL_SERVER] = p.snapshotTick;
    r[at + RL_LEAD] = p.latestTick - p.snapshotTick;
    r[at + RL_RTT] = c.clock.rttMs;
    r[at + RL_LOW] = this.resyncLow;
    this.resyncHead = (this.resyncHead + 1) % RESYNC_LOG;
    this.resyncCount = Math.min(RESYNC_LOG, this.resyncCount + 1);
  }

  /** The resyncLog status text: the kept resyncs, oldest first, "; "-separated. */
  private resyncText(): string {
    const r = this.resyncs;
    let out = "";
    for (let i = 0; i < this.resyncCount; i++) {
      const at = ((this.resyncHead - this.resyncCount + i + RESYNC_LOG) % RESYNC_LOG) * RL_FIELDS;
      if (out !== "") out += "; ";
      out +=
        `at ${Math.round(r[at + RL_AT] as number)} dt ${Math.round(r[at + RL_DT] as number)} ` +
        `snapGap ${Math.round(r[at + RL_SNAP_GAP] as number)} predicted ${r[at + RL_PREDICTED]} ` +
        `server ${r[at + RL_SERVER]} lead ${r[at + RL_LEAD]} rtt ${Math.round(r[at + RL_RTT] as number)} ` +
        `low ${r[at + RL_LOW]}`;
    }
    return out;
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
    s.resyncLog = this.resyncText();
    const g = this.timing;
    s.maxFrameMs = String(Math.round(g[T_MAX_FRAME] as number));
    g[T_MAX_FRAME] = 0;
    // The snapshot stream: its gaps per report and overall, and the link gaps (D-028).
    s.maxSnapGapMs = String(Math.round(g[T_MAX_SNAP_GAP] as number));
    g[T_MAX_SNAP_GAP] = 0;
    s.peakSnapGapMs = String(Math.round(g[T_PEAK_SNAP_GAP] as number));
    s.linkGaps = String(this.linkGaps);
    s.lastLinkGap = Number.isNaN(g[T_LINK_GAP_AT] as number)
      ? ""
      : `${Math.round(g[T_LINK_GAP_MS] as number)}ms@${Math.round(g[T_LINK_GAP_AT] as number)}`;
    s.starvedAfterGap = String(this.starvedAfterGap);
    s.starvedCorrectionsAfterGap = String(this.starvedCorrectionsAfterGap);
    const st = this.lastStarve;
    s.lastStarve = Number.isNaN(st[0] as number)
      ? ""
      : `at ${Math.round(st[0] as number)} lead ${st[1]} low ${st[2]} mean ${(st[3] as number).toFixed(2)} ` +
        `dt ${Math.round(st[4] as number)} snapGap ${Math.round(st[5] as number)} rtt ${Math.round(st[6] as number)}`;
    s.drawCalls = String(this.renderer?.drawCalls ?? 0);
    s.triangles = String(this.renderer?.triangles ?? 0);
    // Capsule instances drawn (the e2e's "4 capsules": what the renderer drew, not the view).
    s.capsules = String(this.renderer?.players.count ?? 0);
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
    // Other players drawn this frame (two tabs on one server see 1 each), and how smoothly
    // (D-037): NET-05 violations on frames that were not long and the remote-frames judged, the
    // remote-frames drawn past the newest snapshot (extrapolated or held) and the render clock's
    // snaps after the first, the interpolation delay (ticks) and its lateness p95.
    const remotes = c.remotes;
    s.remotes = String(remotes.view.count);
    s.remoteJumps = String(this.remoteJumps.t[JM_VIOLATIONS]);
    s.remoteJudged = String(this.remoteJumps.t[JM_CHECKED]);
    s.remoteFrames = String(t[STAT_REMOTE_FRAMES]);
    s.extrapolations = String(
      (t[STAT_REMOTE_EXTRAPOLATED] as number) + (t[STAT_REMOTE_HELD] as number),
    );
    s.renderSnaps = String(t[STAT_RENDER_SNAPS]);
    s.interpDelay = String(remotes.delayTicks);
    s.interpP95 = (remotes.delay.t[ID_P95] as number).toFixed(3);
  }
}
