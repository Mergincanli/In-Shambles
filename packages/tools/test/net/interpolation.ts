import {
  type ClientSim,
  type CmdSampler,
  ID_DEFER_LAG,
  ID_FORMULA,
  INTERP_DELAY_MAX,
  INTERP_DELAY_MIN,
  JM_CHECKED,
  JM_VIOLATIONS,
  JM_WORST_RATIO,
  NeutralInput,
  RC_DT_MS,
  RC_RATE,
  RC_RENDER,
  REMOTE_EXTRAPOLATED,
  REMOTE_HELD,
  REMOTE_INTERPOLATED,
  RENDER_RATE_MAX,
  RENDER_RATE_MIN,
  RENDER_RATE_PAST_NEWEST,
  RemoteJumpMeter,
  RouteInput,
  STAT_CLOCK_ADJUSTMENTS,
  STAT_RENDER_SNAPS,
} from "@game/client/net";
import {
  type CloseHandler,
  CONTENTS_SOLID,
  type CollisionWorld,
  FRAME_SLOTS,
  findNetProfile,
  type MessageHandler,
  type NetProfile,
  type PlayerState,
  pointContents,
  type Transport,
  type TransportStats,
  vec3,
} from "@game/shared";
import { expect } from "vitest";
import { type FrameModel, type HarnessClient, MultiHarness } from "./multiHarness";

// NET-05's runs and checks (docs/05 §14, M3 design §2.8 and §5, D-037), shared by its two tiers
// (D-032): `net-05-interpolation.test.ts` runs the 2-client matrix's representatives in
// `pnpm test`; `packages/tools/long/net-05-interpolation.long.ts` the rest of the matrix and the
// 16-client leg in `pnpm test:long`. Both files' headers say what the runs check.

/**
 * The mover's route on arena_greybox: west along the south wall up the 6 steps of 16 u onto the
 * south ledge (96 u), off its west end (a 96 u drop), then back east through the yard south of
 * the centre ramp and its crates. Strafe-jumped at up to 760 u/s (the design's ≈ 765).
 */
export const STAIRS_ROUTE: readonly number[] = [700, -960, -700, -960, -700, -560, 700, -560];
export const MOVER_SPEED = 760;
/**
 * Frames like the bots' (one `setTimeout` chain at 60 Hz on a busy event loop): 10–33 ms, so a
 * frame often passes a whole tick's bracket (a real bots run found the speed bound missing such a
 * bracket's step-up).
 */
export const FRAMES_BOT_TIMER: FrameModel = (rng) => 10 + rng.nextFloat() * 23;
/** The ledge's top as an origin height (96 u + the hull's 24 u below the origin). */
export const LEDGE_ORIGIN_Z = 96 + 24;

export function profile(name: string): NetProfile {
  const p = findNetProfile(name);
  if (p === undefined) throw new Error(`no profile ${name}`);
  return p;
}

/** The mover's input: the stairs route, strafe-jumped. */
export function moverInput(seed: number): CmdSampler {
  return new RouteInput(STAIRS_ROUTE, seed, { maxSpeed: MOVER_SPEED, idleTicks: 60 });
}

/**
 * Samples one observer's remote interpolation after each of its frames, as the page does, and
 * checks each frame against NET-05 (M3 design §5): the step criterion (`RemoteJumpMeter`), the
 * render rate within [0.9, 1.1] (down to 0.5 only while past the newest stored tick), the delay
 * within 2–6 and never below its formula, no remote drawn with its origin in solid, and, where
 * the store holds the two ticks around the render time and nothing smooths the slot, the drawn
 * origin and yaw equal to the server's path at the render time (the yaw along the shorter arc,
 * also where it crosses 0/65535).
 */
export class RemoteWatch {
  readonly meter = new RemoteJumpMeter();
  frames = 0;
  /** Remote-frames drawn, extrapolated and held. */
  remoteFrames = 0;
  extrapolated = 0;
  held = 0;
  /**
   * From `heldSince` (harness ms) on: the extrapolated + held remote-frames, and their time (the
   * frames' durations summed per remote, ms).
   */
  heldAfter = 0;
  heldMsAfter = 0;
  heldSince = Number.POSITIVE_INFINITY;
  rateOut = 0;
  delayOut = 0;
  inSolid = 0;
  /** Frames compared with the server's path, the largest distance (u) and yaw difference (°). */
  truthChecked = 0;
  truthWorst = 0;
  yawWorst = 0;
  /** Of those, frames whose two server yaws lie across 0/65535 (the short arc wraps). */
  yawWraps = 0;
  /** The observer's own clock steps while watching (they must not move the remotes). */
  clockSteps = 0;
  /** Per slot, the frames marked teleported. */
  readonly teleports = new Int32Array(FRAME_SLOTS);
  /** Per slot, frames drawn. */
  readonly drawn = new Int32Array(FRAME_SLOTS);
  /**
   * Remote-frames of a slot drawn before and present in the newest stored frame (deferred,
   * pending or fresh) yet not drawn: a hide no removal explains (D-046: never).
   */
  hiddenPresent = 0;
  /** The largest defer lag the delay carried (D-046; 0 at 37 players or fewer). */
  maxDeferLag = 0;
  private readonly origin = vec3();
  private prevRender = Number.NaN;
  private clockBase = -1;

  /**
   * `truth(slot)` gives the server's recorded states of a slot's player by tick, when known (the
   * recording mover's), for the path comparison.
   */
  constructor(
    readonly client: ClientSim,
    private readonly world: CollisionWorld,
    private readonly truth: (slot: number) => Map<number, PlayerState> | null = () => null,
    private readonly now: () => number = () => 0,
  ) {}

  sample(): void {
    const c = this.client;
    const newest = c.store.newestTick;
    c.updateRemotes();
    if (!c.active) return;
    const interp = c.remotes;
    const view = interp.view;
    this.meter.measure(interp, true);
    this.frames++;
    const clock = interp.clock;
    const rate = clock.t[RC_RATE] as number;
    const render = clock.t[RC_RENDER] as number;
    const past = this.prevRender > newest;
    if (!clock.snapped) {
      const lo = past ? RENDER_RATE_PAST_NEWEST : RENDER_RATE_MIN;
      if (rate < lo - 1e-9 || rate > RENDER_RATE_MAX + 1e-9) this.rateOut++;
    }
    this.prevRender = render;
    const d = interp.delayTicks;
    if (
      d < INTERP_DELAY_MIN ||
      d > INTERP_DELAY_MAX ||
      d < (interp.delay.t[ID_FORMULA] as number)
    ) {
      this.delayOut++;
    }
    this.maxDeferLag = Math.max(this.maxDeferLag, interp.delay.t[ID_DEFER_LAG] as number);
    const steps = c.stats.totals[STAT_CLOCK_ADJUSTMENTS] as number;
    if (this.clockBase < 0) this.clockBase = steps;
    this.clockSteps = steps - this.clockBase;
    const late = this.now() >= this.heldSince;
    const o = this.origin;
    const newestFrame = c.store.ring.get(c.store.newestTick);
    for (let s = 0; s < FRAME_SLOTS; s++) {
      if (view.visible[s] !== 1) {
        if ((this.drawn[s] as number) > 0 && newestFrame !== null && newestFrame.present[s] === 1) {
          this.hiddenPresent++;
        }
        continue;
      }
      this.remoteFrames++;
      this.drawn[s] = (this.drawn[s] as number) + 1;
      const mode = interp.mode[s] as number;
      if (mode === REMOTE_EXTRAPOLATED) this.extrapolated++;
      if (mode === REMOTE_HELD) this.held++;
      if (late && mode !== REMOTE_INTERPOLATED) {
        this.heldAfter++;
        this.heldMsAfter += clock.t[RC_DT_MS] as number;
      }
      if (view.teleported[s] === 1) this.teleports[s] = (this.teleports[s] as number) + 1;
      o[0] = view.x[s] as number;
      o[1] = view.y[s] as number;
      o[2] = view.z[s] as number;
      if ((pointContents(this.world, o) & CONTENTS_SOLID) !== 0) this.inSolid++;
      if (mode === REMOTE_INTERPOLATED && interp.offsetLength[s] === 0) this.compare(s, render);
    }
  }

  /** The drawn origin against the server's path at `render`, when the store holds both ticks. */
  private compare(s: number, render: number): void {
    const states = this.truth(s);
    if (states === null) return;
    const t0 = Math.floor(render);
    const f0 = this.client.store.ring.get(t0);
    const f1 = this.client.store.ring.get(t0 + 1);
    // Across a teleport the path is not lerped (the drawn slot snaps): nothing to compare.
    if (f0 === null || f1 === null || f0.teleportSeq[s] !== f1.teleportSeq[s]) return;
    const a = states.get(t0);
    const b = states.get(t0 + 1);
    if (a === undefined || b === undefined) return;
    const w = render - t0;
    const view = this.client.remotes.view;
    let d2 = 0;
    const drawn = [view.x[s] as number, view.y[s] as number, view.z[s] as number];
    for (let k = 0; k < 3; k++) {
      const want =
        (a.origin[k] as number) + ((b.origin[k] as number) - (a.origin[k] as number)) * w;
      d2 += ((drawn[k] as number) - want) ** 2;
    }
    this.truthChecked++;
    this.truthWorst = Math.max(this.truthWorst, Math.sqrt(d2));
    const arc = (((b.viewYaw - a.viewYaw) << 16) >> 16) as number;
    if (a.viewYaw + arc < 0 || a.viewYaw + arc >= 65536) this.yawWraps++;
    const want = (((a.viewYaw + arc * w) * 360) / 65536 + 360) % 360;
    const dyaw = Math.abs((((view.yaw[s] as number) - want + 540) % 360) - 180);
    this.yawWorst = Math.max(this.yawWorst, dyaw);
  }

  /** Extrapolated + held remote-frames, as a share of all drawn. */
  get heldShare(): number {
    return this.remoteFrames === 0 ? 0 : (this.extrapolated + this.held) / this.remoteFrames;
  }

  summary(label: string): string {
    const c = this.client;
    const interp = c.remotes;
    return (
      `${label}: ${this.frames} frames, ${this.remoteFrames} remote-frames, ` +
      `jumps ${this.meter.t[JM_VIOLATIONS]} of ${this.meter.t[JM_CHECKED]} ` +
      `(worst ${(this.meter.t[JM_WORST_RATIO] as number).toFixed(2)} of the allowance), ` +
      `extrapolated ${this.extrapolated} held ${this.held} ` +
      `(${(100 * this.heldShare).toFixed(2)}%), delay ${interp.delayTicks} ticks, ` +
      `render snaps ${c.stats.totals[STAT_RENDER_SNAPS]}, truth ${this.truthChecked} worst ` +
      `${this.truthWorst.toFixed(3)} u ${this.yawWorst.toFixed(6)}° (${this.yawWraps} across 0), ` +
      `observer clock steps ${this.clockSteps}`
    );
  }
}

/** The checks every NET-05 run passes, whatever its profile. */
export function expectSmooth(w: RemoteWatch): void {
  expect(w.frames).toBeGreaterThan(100);
  expect(w.meter.t[JM_VIOLATIONS], w.summary("jumps")).toBe(0);
  expect(w.client.stats.totals[STAT_RENDER_SNAPS], w.summary("render snaps")).toBe(0);
  expect(w.rateOut, w.summary("render rate")).toBe(0);
  expect(w.delayOut, w.summary("delay")).toBe(0);
  expect(w.inSolid, w.summary("in solid")).toBe(0);
  // The interpolation is of the server's path: within quantization (1/32 u per axis).
  if (w.truthChecked > 0) {
    expect(w.truthWorst, w.summary("truth")).toBeLessThan(0.06);
    expect(w.yawWorst, w.summary("yaw")).toBeLessThan(1e-6);
  }
}

export interface PairRun {
  readonly h: MultiHarness;
  readonly mover: HarnessClient;
  readonly observer: HarnessClient;
  readonly watch: RemoteWatch;
}

export interface PairOptions {
  readonly profile: string;
  readonly seed?: number;
  readonly frames?: FrameModel;
  /** The observer's link instead of `profile` (the mover's). */
  readonly observerProfile?: string;
  /** Wraps the observer's transport (after NetSim). */
  readonly observerWrap?: (t: Transport) => Transport;
}

/**
 * A mover strafe-jumping the stairs route and an observer standing still on arena_greybox, each
 * on its own link (`profile`), the observer's remote interpolation watched every frame.
 */
export function pair(o: PairOptions): PairRun {
  const seed = o.seed ?? 1;
  const h = new MultiHarness({ map: "arena_greybox", seed });
  const mover = h.addClient({
    input: moverInput(seed),
    profile: profile(o.profile),
    record: true,
    frameIntervalMs: o.frames,
  });
  let watch: RemoteWatch | null = null;
  const observer = h.addClient({
    input: new NeutralInput(),
    profile: profile(o.observerProfile ?? o.profile),
    frameIntervalMs: o.frames,
    wrap: o.observerWrap,
    onFrame: () => watch?.sample(),
  });
  watch = new RemoteWatch(
    observer.client,
    observer.client.world,
    (s) => (s === mover.session?.clientId ? mover.server : null),
    () => h.now,
  );
  return { h, mover, observer, watch };
}

/** The mover's highest server origin z over the run (the ledge is LEDGE_ORIGIN_Z). */
export function moverTop(mover: HarnessClient): number {
  let top = Number.NEGATIVE_INFINITY;
  for (const s of mover.server.values()) top = Math.max(top, s.origin[2] as number);
  return top;
}

/**
 * A client link that loses every unreliable message coming down while `down()` holds: a snapshot
 * outage (the server and the uplink go on).
 */
export class Outage implements Transport {
  constructor(
    private readonly inner: Transport,
    private readonly down: () => boolean,
  ) {}

  sendUnreliable(d: Uint8Array, len: number): void {
    this.inner.sendUnreliable(d, len);
  }

  sendReliable(d: Uint8Array, len: number): void {
    this.inner.sendReliable(d, len);
  }

  onMessage(cb: MessageHandler): void {
    this.inner.onMessage((d, len, reliable) => {
      if (!reliable && this.down()) return;
      cb(d, len, reliable);
    });
  }

  onClose(cb: CloseHandler): void {
    this.inner.onClose(cb);
  }

  poll(): void {
    this.inner.poll();
  }

  close(reason?: string): void {
    this.inner.close(reason);
  }

  isOpen(): boolean {
    return this.inner.isOpen();
  }

  stats(): TransportStats {
    return this.inner.stats();
  }
}
