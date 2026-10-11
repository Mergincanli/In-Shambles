import {
  type CollisionWorld,
  TraceResult,
  VIEW_HEIGHT_CROUCHED,
  VIEW_HEIGHT_STANDING,
  vec3,
} from "@game/shared";
import type { DemoHud } from "../hud/overlay";
import { type DemoPlayer, RC_DT_MS, ViewHeight } from "../net";
import { BLEND_DT_MS, BLEND_MS } from "../render/players";
import type { GameRenderer } from "../render/renderer";
import { refreshViewSettings, ViewSettings } from "../render/viewCvars";
import { type StatusSink, thirdPersonPullBack } from "./game";

/** How often the autotest status is written to the page, ms (it allocates strings). */
const STATUS_INTERVAL_MS = 250;

export interface DemoGameOptions {
  readonly demo: DemoPlayer;
  /** The demo's map collision: the follow camera's pull-back is traced against it. */
  readonly world: CollisionWorld;
  /** Null when WebGL is unavailable: playback still runs. */
  readonly renderer: GameRenderer | null;
  readonly status: StatusSink | null;
  readonly hud?: DemoHud | null;
  /** Runs at the end of every frame: the page drains the demo's join notices into the console. */
  readonly onFrame?: (() => void) | null;
  /**
   * Where the camera looks while nobody is followed (before the first player, or an empty
   * match): [0..2] position (sim u), [3] yaw, [4] pitch (degrees). The map's first spawn point.
   */
  readonly idlePose?: readonly [number, number, number, number, number];
}

/**
 * Demo playback's frame loop (D-044, M3 design §2.12): per animation frame the demo player's
 * records and interpolation, then the camera behind the followed player (its drawn origin, eye
 * height and view angles, pulled back as the third-person camera is, whatever `cl_thirdPerson`
 * says: a demo has no server whose `sv_cheats` it could follow), every player's capsule (the
 * followed one included), the scene and the HUD's "following #id" line. It only reads the demo.
 */
export class DemoGame {
  readonly settings = new ViewSettings();
  /** The view this frame: [0..2] eye position (sim u), [3] yaw, [4] pitch (degrees). */
  readonly pose = new Float64Array(5);
  frames = 0;
  private readonly demo: DemoPlayer;
  private readonly world: CollisionWorld;
  private readonly renderer: GameRenderer | null;
  private readonly status: StatusSink | null;
  private readonly hud: DemoHud | null;
  private readonly onFrame: (() => void) | null;
  private readonly camStart = vec3();
  private readonly camEnd = vec3();
  private readonly camTrace = new TraceResult();
  private readonly blend = new Float64Array(2);
  /** The followed player's eye height, eased between stances as the live camera's is. */
  private readonly eye: ViewHeight;
  /** Whom `eye` belongs to: a new player (or a teleport) snaps it. */
  private eyeOf = -1;
  private lastStatus = Number.NEGATIVE_INFINITY;
  private running = false;
  private readonly frameCb: () => void;

  constructor(options: DemoGameOptions) {
    this.demo = options.demo;
    this.world = options.world;
    this.renderer = options.renderer;
    this.status = options.status;
    this.hud = options.hud ?? null;
    this.onFrame = options.onFrame ?? null;
    this.eye = new ViewHeight(this.demo.now);
    const idle = options.idlePose ?? [0, 0, 0, 0, 0];
    for (let i = 0; i < 5; i++) this.pose[i] = idle[i] as number;
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
    const demo = this.demo;
    demo.frame();
    this.frames++;
    refreshViewSettings(demo.cvars, this.settings);
    const view = demo.view;
    const id = demo.following;
    const pose = this.pose;
    if (id >= 0) {
      const target = view.crouched[id] === 1 ? VIEW_HEIGHT_CROUCHED : VIEW_HEIGHT_STANDING;
      const eye = this.eye;
      if (id !== this.eyeOf || view.teleported[id] === 1) eye.reset(target);
      else {
        eye.update(
          target,
          VIEW_HEIGHT_STANDING - VIEW_HEIGHT_CROUCHED,
          this.settings.viewHeightSmoothMs,
        );
      }
      this.eyeOf = id;
      pose[0] = view.x[id] as number;
      pose[1] = view.y[id] as number;
      pose[2] = (view.z[id] as number) + (eye.height[0] as number);
      pose[3] = view.yaw[id] as number;
      pose[4] = view.pitch[id] as number;
      thirdPersonPullBack(this.world, pose, this.camStart, this.camEnd, this.camTrace);
    } else this.eyeOf = -1;
    const r = this.renderer;
    if (r !== null) {
      r.view.pose.set(pose);
      const blend = this.blend;
      blend[BLEND_DT_MS] = demo.remotes.clock.t[RC_DT_MS] as number;
      blend[BLEND_MS] = demo.settings.remoteCrouchBlendMs;
      r.players.update(view, blend);
      r.render(this.settings.fov);
    }
    this.hud?.follow(id, demo.followedTeam);
    if (this.status !== null) this.report();
    if (this.onFrame !== null) this.onFrame();
  }

  /** Autotest status (the `?demo=` e2e), a few times a second. */
  private report(): void {
    const demo = this.demo;
    const now = demo.now[0] as number;
    if (now - this.lastStatus < STATUS_INTERVAL_MS) return;
    this.lastStatus = now;
    const s = this.status as StatusSink;
    if (s.state !== "error") s.state = "running";
    s.demo = "1";
    s.frames = String(this.frames);
    s.demoTick = String(demo.tick);
    s.demoEnded = demo.ended ? "1" : "0";
    s.demoFaults = String(demo.faults);
    s.snapshots = String(demo.snapshots);
    s.following = String(demo.following);
    s.remotes = String(demo.view.count);
    s.roster = String(demo.roster.count);
    s.drawCalls = String(this.renderer?.drawCalls ?? 0);
    s.capsules = String(this.renderer?.players.count ?? 0);
  }
}
