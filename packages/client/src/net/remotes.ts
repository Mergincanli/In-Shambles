import {
  type CollisionWorld,
  ENTITY_EVENT_SLOTS,
  FRAME_SLOTS,
  HULL_CROUCHED_MAXS,
  HULL_MINS,
  HULL_STANDING_MAXS,
  MASK_PLAYERSOLID,
  MASK_PRESENT_HI,
  MASK_PRESENT_LO,
  ORIGIN_SCALE,
  PMF_CROUCHED,
  SNAPSHOT_HISTORY,
  TICK_DT,
  TraceResult,
  traceBox,
  vec3,
  type WorldFrame,
} from "@game/shared";
import { TICK_MS } from "./clock";
import type { ClientNetSettings } from "./cvars";
import type { SnapshotStore } from "./snapshotStore";
import {
  type NetStats,
  STAT_REMOTE_EVENTS,
  STAT_REMOTE_EVENTS_LOST,
  STAT_REMOTE_EXTRAPOLATED,
  STAT_REMOTE_FRAMES,
  STAT_REMOTE_HELD,
  STAT_RENDER_SNAPS,
} from "./stats";

/**
 * Remote entity interpolation (docs/05 §6, M3 design §2.8, D-037): the other players drawn a few
 * ticks in the past, between the two snapshots around the render time, on a render clock of its
 * own that follows when snapshots arrive, not the prediction's clock.
 *
 * - `RenderClock`: the newest arrival offsets (server tick − arrival time in ticks) over 2 s; the
 *   render tick slews toward their maximum minus the interpolation delay.
 * - `InterpDelay`: the delay, from how late snapshots arrive (p95) and how far apart they are.
 * - `RemoteInterpolator`: per slot, the samples (a stored frame where the slot has state, by its
 *   stamp) bracketing the render tick; lerp, short-arc yaw, extrapolation of at most 2 ticks
 *   clamped by a trace, hold, rejoin smoothing, snaps keyed on the teleport counter (D-035).
 * - `RemoteView`: what the renderer reads, one row per slot.
 * - `RemoteJumpMeter`: NET-05's step criterion on the drawn paths, for tests, bots and the page.
 *
 * Nothing here allocates per frame or per snapshot; doubles stay in typed-array slots or locals.
 */

/** Degrees per u16 angle unit. */
const DEG_PER_U16 = 360 / 65536;

/** Interpolation delay bounds, ticks (docs/05 §6: 33–100 ms). */
export const INTERP_DELAY_MIN = 2;
export const INTERP_DELAY_MAX = 6;
/** A remote is drawn at most this far past its newest sample, then held (docs/05 §6). */
export const EXTRAPOLATE_TICKS = 2;
/** Render-clock slew: rate = 1 + (target − render) × gain, within [min, max] (design). */
export const RENDER_SLEW_GAIN = 0.5;
export const RENDER_RATE_MIN = 0.9;
export const RENDER_RATE_MAX = 1.1;
/** The slowest rate while the render tick is past the newest stored tick (design). */
export const RENDER_RATE_PAST_NEWEST = 0.5;
/** A render tick further than this behind its target snaps forward (design), ticks. */
export const RENDER_SNAP_TICKS = 6;
/** Arrivals the render clock and the delay look at: 2 s of snapshots (design). */
export const LATENESS_WINDOW = 120;
/**
 * A lasting drop of the arrival offset (D-037): when this many arrivals in a row (0.5 s) come
 * more than REBASE_LATENESS_TICKS later than the window's largest offset, that offset is stale (a
 * server stall that dropped ticks, or a one-way latency rise past the delay's reach), and the
 * window restarts from those arrivals instead of holding the remotes for the rest of its 2 s.
 */
export const REBASE_ARRIVALS = 30;
export const REBASE_LATENESS_TICKS = 6;
/** The lateness histogram: 1/8-tick buckets up to 8 ticks (design). */
export const LATENESS_BUCKETS = 64;
const LATENESS_PER_TICK = 8;
/** Tick steps between newest snapshots the snapshot interval is the median of (design). */
export const INTERVAL_WINDOW = 30;
/** The delay falls only after this long at a lower value (design), ms. */
export const DELAY_FALL_MS = 2000;
/**
 * The largest staleness of a slot's state in a frame, ticks: the D-046 scheduler's bound (a
 * deferred slot keeps its baseline's stamp; 0 until then), kept so the search already covers it.
 */
export const SAMPLE_STALENESS_TICKS = 2;
/**
 * The stored frames the samples are searched in: from the newest back over at least the delay's
 * maximum plus that staleness (M3 design §2.8), and on past lost frames until one at least that
 * staleness before the render tick, so a slot's older sample is found after an outage too.
 */
export const SAMPLE_SEARCH_FRAMES = INTERP_DELAY_MAX + SAMPLE_STALENESS_TICKS;
/**
 * A rejoin smooths a raw jump up to this × the slot's speed × the time since the sample it was
 * drawn from (plus the extrapolation's 2 ticks), the step criterion's own margin (D-037).
 */
export const REJOIN_SPEED_MARGIN = 1.5;
/** Remote movement events one frame can surface (2 per slot). */
export const REMOTE_EVENTS_CAPACITY = FRAME_SLOTS * ENTITY_EVENT_SLOTS;

/** What a slot showed this frame (`RemoteInterpolator.mode`). */
export const REMOTE_NONE = 0;
/** Between two samples, or exactly at one. */
export const REMOTE_INTERPOLATED = 1;
/** Past its newest sample along its velocity, at most EXTRAPOLATE_TICKS. */
export const REMOTE_EXTRAPOLATED = 2;
/** Held: past the extrapolation's end, or kept where it was with no sample at hand. */
export const REMOTE_HELD = 3;

/**
 * What the renderer draws of the other players (M3 design §2.8 "Output"): one row per slot, in
 * sim units, filled once per frame by `RemoteInterpolator.update`. The renderer reads only this,
 * never a snapshot.
 */
export class RemoteView {
  /** Origin, u. */
  readonly x = new Float64Array(FRAME_SLOTS);
  readonly y = new Float64Array(FRAME_SLOTS);
  readonly z = new Float64Array(FRAME_SLOTS);
  /** View angles, degrees: yaw in [0, 360), pitch positive looking down. */
  readonly yaw = new Float64Array(FRAME_SLOTS);
  readonly pitch = new Float64Array(FRAME_SLOTS);
  /** 1 while the player crouches (PMF_CROUCHED); the renderer blends the height. */
  readonly crouched = new Uint8Array(FRAME_SLOTS);
  /** TEAM_*. */
  readonly team = new Uint8Array(FRAME_SLOTS);
  /** 1 for a slot to draw. */
  readonly visible = new Uint8Array(FRAME_SLOTS);
  /**
   * 1 on the frame a slot appeared or its teleport counter changed (D-035): it jumped there, so
   * nothing may smooth it from its last place (the crouch blend restarts too).
   */
  readonly teleported = new Uint8Array(FRAME_SLOTS);
  /** 1 while a slot is drawn past its newest snapshot (extrapolated or held). */
  readonly extrapolating = new Uint8Array(FRAME_SLOTS);
  /** Visible slots. */
  count = 0;

  /** Hides every slot. */
  clear(): void {
    this.visible.fill(0);
    this.teleported.fill(0);
    this.extrapolating.fill(0);
    this.count = 0;
  }
}

// RenderClock.t slots.
/** The render tick (server ticks, fractional); NaN before the first frame with a sample. */
export const RC_RENDER = 0;
/** Where the render tick heads: now in ticks + the largest offset − the delay. */
export const RC_TARGET = 1;
/** The largest arrival offset over the window (server tick − arrival time / TICK_MS). */
export const RC_MAX_OFFSET = 2;
/** This frame's rate (render ticks per elapsed tick). */
export const RC_RATE = 3;
const RC_LAST_MS = 4;
/** This frame's elapsed time, ms. */
export const RC_DT_MS = 5;
const RC_SLOTS = 6;

/**
 * The remote players' render clock (M3 design §2.8): independent of the prediction's clock. Each
 * newly stored newest snapshot gives an arrival offset o = serverTick − pollTime / TICK_MS (the
 * poll's time on purpose: frame quantization is part of how late a snapshot is); the target is
 * now / TICK_MS + the largest o over the last 120 − the delay, and the render tick follows it at
 * a rate of 1 + 0.5 × (target − where the plain rate would put it), within [0.9, 1.1] (0.5 at the
 * slowest while it is past the newest stored tick, so a delay rise is absorbed quickly instead of
 * extrapolating and holding). It never runs backwards: more than 6 ticks behind its target it
 * snaps forward (counted), and ahead of it by any amount it only slews down at the rate floor; the
 * first frame places it. When 30 arrivals in a row come more than 6 ticks later than the largest
 * offset (a server stall that dropped ticks), the window restarts from them (D-037).
 */
export class RenderClock {
  readonly t = new Float64Array(RC_SLOTS);
  /** The last LATENESS_WINDOW arrival offsets, a ring (`count` held). */
  readonly offsets = new Float64Array(LATENESS_WINDOW);
  count = 0;
  /** Snaps since the reset, the first placement included. */
  snaps = 0;
  /** The last `advance` snapped. */
  snapped = false;
  /** Times the window restarted after a lasting offset drop (REBASE_ARRIVALS). */
  rebases = 0;
  private head = 0;
  /** Arrivals in a row more than REBASE_LATENESS_TICKS behind the largest offset. */
  private lateRun = 0;
  private readonly scratch = new Float64Array(LATENESS_WINDOW);

  /** `now[0]` is the frame's time (ms), the client's clock slot. */
  constructor(private readonly now: Float64Array) {
    this.reset();
  }

  reset(): void {
    const t = this.t;
    t[RC_RENDER] = Number.NaN;
    t[RC_TARGET] = Number.NaN;
    t[RC_MAX_OFFSET] = Number.NaN;
    t[RC_RATE] = 1;
    t[RC_LAST_MS] = Number.NaN;
    t[RC_DT_MS] = 0;
    this.count = 0;
    this.head = 0;
    this.snaps = 0;
    this.snapped = false;
    this.rebases = 0;
    this.lateRun = 0;
  }

  /** A newly stored newest snapshot of `serverTick`, polled at `now[0]`. */
  onSnapshot(serverTick: number): void {
    const offsets = this.offsets;
    const o = serverTick - (this.now[0] as number) / TICK_MS;
    offsets[this.head] = o;
    this.head = this.head + 1 === LATENESS_WINDOW ? 0 : this.head + 1;
    if (this.count < LATENESS_WINDOW) this.count++;
    let m = Number.NEGATIVE_INFINITY;
    for (let i = 0; i < this.count; i++) m = Math.max(m, offsets[i] as number);
    this.t[RC_MAX_OFFSET] = m;
    this.lateRun = m - o > REBASE_LATENESS_TICKS ? this.lateRun + 1 : 0;
    if (this.lateRun >= REBASE_ARRIVALS) this.rebase();
  }

  /** Keeps only the late run's arrivals (oldest first, from slot 0) and their largest offset. */
  private rebase(): void {
    const n = this.lateRun;
    const offsets = this.offsets;
    const s = this.scratch;
    let i = this.head;
    for (let k = n - 1; k >= 0; k--) {
      i = i === 0 ? LATENESS_WINDOW - 1 : i - 1;
      s[k] = offsets[i] as number;
    }
    let m = Number.NEGATIVE_INFINITY;
    for (let k = 0; k < n; k++) {
      offsets[k] = s[k] as number;
      m = Math.max(m, s[k] as number);
    }
    this.count = n;
    this.head = n === LATENESS_WINDOW ? 0 : n;
    this.t[RC_MAX_OFFSET] = m;
    this.lateRun = 0;
    this.rebases++;
  }

  /** One frame at `now[0]`: slews (or places, or snaps) the render tick. */
  advance(delayTicks: number, newestTick: number): void {
    const t = this.t;
    this.snapped = false;
    if (this.count === 0) return;
    const now = this.now[0] as number;
    const target = now / TICK_MS + (t[RC_MAX_OFFSET] as number) - delayTicks;
    t[RC_TARGET] = target;
    const last = t[RC_LAST_MS] as number;
    t[RC_LAST_MS] = now;
    const render = t[RC_RENDER] as number;
    if (Number.isNaN(render)) {
      t[RC_RENDER] = target;
      t[RC_RATE] = 1;
      t[RC_DT_MS] = 0;
      this.snaps++;
      this.snapped = true;
      return;
    }
    const dt = Math.max(0, now - last);
    t[RC_DT_MS] = dt;
    const ticks = dt / TICK_MS;
    const lo = render > newestTick ? RENDER_RATE_PAST_NEWEST : RENDER_RATE_MIN;
    // The error is measured where the render tick would be at the plain rate: the target is of
    // now, the render tick of the last frame, and a long frame must not read as falling behind.
    const error = target - (render + ticks);
    const rate = Math.min(RENDER_RATE_MAX, Math.max(lo, 1 + error * RENDER_SLEW_GAIN));
    let next = render + ticks * rate;
    if (target - next > RENDER_SNAP_TICKS) {
      next = target;
      this.snaps++;
      this.snapped = true;
    }
    t[RC_RENDER] = next;
    t[RC_RATE] = rate;
  }
}

// InterpDelay.t slots.
/** The lateness p95 over the window, ticks (a bucket's lower edge, 1/8 tick). */
export const ID_P95 = 0;
/** The median tick step between newest snapshots over the last 30. */
export const ID_INTERVAL = 1;
/** clamp(ceil(2 × interval + p95), 2, 6) at the last snapshot. */
export const ID_FORMULA = 2;
/** Since when the formula has been below the delay (ms; NaN when it isn't). */
const ID_LOWER_SINCE = 3;
const ID_SLOTS = 4;

/**
 * The interpolation delay (docs/05 §6, M3 design §2.8): D = clamp(ceil(2 × snapshotInterval +
 * p95 lateness), 2, 6) ticks, where lateness = the render clock's largest offset − each offset over
 * the same 120 arrivals (a histogram of 1/8-tick buckets to 8 ticks) and the interval is the
 * median tick step of the last 30 newest snapshots. D rises at once and falls only after 2 s
 * below it (to the highest value of those 2 s). The scheduler's defer lag joins with D-046.
 */
export class InterpDelay {
  readonly t = new Float64Array(ID_SLOTS);
  readonly lateness = new Uint16Array(LATENESS_BUCKETS);
  /** The delay, ticks. */
  ticks = INTERP_DELAY_MIN;
  private readonly steps = new Int32Array(INTERVAL_WINDOW);
  private readonly sorted = new Int32Array(INTERVAL_WINDOW);
  private stepCount = 0;
  private stepHead = 0;
  /** The highest formula value since it went below `ticks`. */
  private lowerMax = 0;

  constructor(private readonly now: Float64Array) {
    this.reset();
  }

  reset(): void {
    this.t[ID_P95] = 0;
    this.t[ID_INTERVAL] = 1;
    this.t[ID_FORMULA] = INTERP_DELAY_MIN;
    this.t[ID_LOWER_SINCE] = Number.NaN;
    this.ticks = INTERP_DELAY_MIN;
    this.stepCount = 0;
    this.stepHead = 0;
    this.lowerMax = 0;
    this.lateness.fill(0);
  }

  /** After `clock.onSnapshot`: `step` ticks since the previous newest snapshot (0 for the first). */
  onSnapshot(clock: RenderClock, step: number): void {
    const t = this.t;
    if (step > 0) {
      this.steps[this.stepHead] = Math.min(step, SNAPSHOT_HISTORY);
      this.stepHead = this.stepHead + 1 === INTERVAL_WINDOW ? 0 : this.stepHead + 1;
      if (this.stepCount < INTERVAL_WINDOW) this.stepCount++;
    }
    const hist = this.lateness;
    hist.fill(0);
    const n = clock.count;
    const max = clock.t[RC_MAX_OFFSET] as number;
    const offsets = clock.offsets;
    for (let i = 0; i < n; i++) {
      const b = Math.floor((max - (offsets[i] as number)) * LATENESS_PER_TICK);
      const k = Math.min(LATENESS_BUCKETS - 1, Math.max(0, b));
      hist[k] = (hist[k] as number) + 1;
    }
    // Nearest rank: the bucket holding the ceil(0.95 n)-th smallest lateness.
    const rank = Math.ceil(0.95 * n);
    let seen = 0;
    let bucket = 0;
    for (; bucket < LATENESS_BUCKETS; bucket++) {
      seen += hist[bucket] as number;
      if (seen >= rank) break;
    }
    t[ID_P95] = Math.min(bucket, LATENESS_BUCKETS - 1) / LATENESS_PER_TICK;
    t[ID_INTERVAL] = this.medianStep();
    const formula = Math.min(
      INTERP_DELAY_MAX,
      Math.max(INTERP_DELAY_MIN, Math.ceil(2 * (t[ID_INTERVAL] as number) + (t[ID_P95] as number))),
    );
    t[ID_FORMULA] = formula;
    if (formula >= this.ticks) {
      this.ticks = formula;
      t[ID_LOWER_SINCE] = Number.NaN;
      return;
    }
    const now = this.now[0] as number;
    if (Number.isNaN(t[ID_LOWER_SINCE] as number)) {
      t[ID_LOWER_SINCE] = now;
      this.lowerMax = formula;
      return;
    }
    this.lowerMax = Math.max(this.lowerMax, formula);
    if (now - (t[ID_LOWER_SINCE] as number) >= DELAY_FALL_MS) {
      this.ticks = this.lowerMax;
      t[ID_LOWER_SINCE] = Number.NaN;
    }
  }

  /** The lower median of the held steps (1 before any). */
  private medianStep(): number {
    const n = this.stepCount;
    if (n === 0) return 1;
    const s = this.sorted;
    for (let i = 0; i < n; i++) {
      const v = this.steps[i] as number;
      let j = i - 1;
      while (j >= 0 && (s[j] as number) > v) {
        s[j + 1] = s[j] as number;
        j--;
      }
      s[j + 1] = v;
    }
    return s[(n - 1) >> 1] as number;
  }
}

// RemoteInterpolator.f (per-update doubles).
const F_RENDER = 0;
const F_NOW = 1;
/** The raw (unsmoothed) origin a slot's samples give this frame, u. */
const F_RAW_X = 2;
const F_RAW_Y = 3;
const F_RAW_Z = 4;
/** The render tick of the last frame (this frame's when there was none). */
const F_PREV_RENDER = 5;
const F_SLOTS = 6;

/** The extrapolation trace's hull, by stance. */
const STAND_MAXS = HULL_STANDING_MAXS;
const CROUCH_MAXS = HULL_CROUCHED_MAXS;

/**
 * The remote players' interpolation (M3 design §2.8, D-037), fed by the client's snapshot store.
 * `onStored` takes every stored snapshot's tick (the newly newest ones time the render clock);
 * `update` once per frame fills `view`.
 *
 * Per slot it works on samples: a stored frame where the slot has state gives one (its stamp,
 * fields and teleport counter); frames sharing a stamp give the same one; pending frames give
 * none. a = the sample with the largest stamp ≤ the render tick, b = the smallest stamp above it,
 * searched in the stored frames from the newest back (SAMPLE_SEARCH_FRAMES).
 * - a and b with the same teleport counter: lerp the origin, the yaw along the shorter arc, the
 *   pitch; crouch and team from a.
 * - a different counter (or a removal between them): a until the render tick reaches b, then b,
 *   marked `teleported`. The first sample (or the first after a hide) appears at its stamp.
 * - Hidden from the first stored frame after a sample that marks the slot absent (an explicit
 *   removal, or absence in a full snapshot); pending slots never hide.
 * - No b: along the entity velocity at most 2 ticks past a, clamped by one trace of the stance's
 *   hull, then held. When samples come back, the drawn − raw difference becomes an offset that
 *   decays over `cl_remoteSmoothMs`, dropped (a snap) only when the raw path's own jump is past
 *   both `cl_teleportDist` and what the slot's speed explains over the hold.
 * - Movement events: an eventSeq step of the drawn sample surfaces up to its 2 newest events
 *   (counted), a larger one counts the lost ones.
 */
export class RemoteInterpolator {
  readonly view = new RemoteView();
  readonly clock: RenderClock;
  readonly delay: InterpDelay;
  /** What each slot showed this frame (REMOTE_*). */
  readonly mode = new Uint8Array(FRAME_SLOTS);
  /**
   * Each slot's NET-05 speed bound this frame, u/s: max(|v_a|, |v_b|, |b − a| / (b − a in time))
   * over every bracket the path crossed since the last frame (a long frame can pass one whole), the
   * displacement term covering a stair's step-up with no vertical velocity (|v_a| alone past the
   * newest sample, 0 while held without one).
   */
  readonly speed = new Float64Array(FRAME_SLOTS);
  /** The length of a slot's rejoin offset while it decays (u; 0 when there is none). */
  readonly offsetLength = new Float64Array(FRAME_SLOTS);
  /** This frame's surfaced events: slot, kind (PMEV_*) and 8-bit value, oldest first per slot. */
  readonly eventSlot = new Uint8Array(REMOTE_EVENTS_CAPACITY);
  readonly eventKind = new Uint8Array(REMOTE_EVENTS_CAPACITY);
  readonly eventValue = new Uint8Array(REMOTE_EVENTS_CAPACITY);
  eventCount = 0;
  /** The delay used this frame, ticks (`cl_interpDelay`, or InterpDelay's). */
  delayTicks = INTERP_DELAY_MIN;
  /** The collision the extrapolation is clamped by (the client sets it with the map). */
  world: CollisionWorld;
  /** Doubles of the current update, F_* slots. */
  private readonly f = new Float64Array(F_SLOTS);
  /** The newest tick `onStored` saw. */
  private newestSeen = 0;
  /** The stored frames searched this frame, newest first, and their ticks. */
  private readonly frames: (WorldFrame | null)[] = new Array<WorldFrame | null>(
    SNAPSHOT_HISTORY,
  ).fill(null);
  private readonly frameTicks = new Int32Array(SNAPSHOT_HISTORY);
  private frameCount = 0;
  /** The stamp of the sample each slot was drawn from last frame (a), 0 for none. */
  private readonly baseStamp = new Int32Array(FRAME_SLOTS);
  private readonly lastSeq = new Uint8Array(FRAME_SLOTS);
  private readonly lastEventSeq = new Uint8Array(FRAME_SLOTS);
  /** Each slot's rejoin offset when it started (u) and when (ms). */
  private readonly offX = new Float64Array(FRAME_SLOTS);
  private readonly offY = new Float64Array(FRAME_SLOTS);
  private readonly offZ = new Float64Array(FRAME_SLOTS);
  private readonly offAt = new Float64Array(FRAME_SLOTS);
  /** Each slot's raw origin last frame (u): a rejoin is judged by the raw path's own jump. */
  private readonly rawX = new Float64Array(FRAME_SLOTS);
  private readonly rawY = new Float64Array(FRAME_SLOTS);
  private readonly rawZ = new Float64Array(FRAME_SLOTS);
  private readonly traceStart = vec3();
  private readonly traceEnd = vec3();
  private readonly trace = new TraceResult();
  /** The present slots of the searched frames (lo/hi masks). */
  private readonly presence = new Int32Array(2);
  /** Any slot visible after the last update (so a hidden view clears once). */
  private shown = false;

  constructor(
    private readonly store: SnapshotStore,
    private readonly now: Float64Array,
    /** The client's net settings (`cl_interpDelay`, `cl_remoteSmoothMs`, `cl_teleportDist`). */
    readonly settings: ClientNetSettings,
    private readonly stats: NetStats,
    world: CollisionWorld,
  ) {
    this.clock = new RenderClock(now);
    this.delay = new InterpDelay(now);
    this.world = world;
  }

  /** A stored snapshot of `tick` (any order): a newly newest one times the clock and the delay. */
  onStored(tick: number): void {
    if (tick <= this.newestSeen) return;
    const step = this.newestSeen > 0 ? tick - this.newestSeen : 0;
    this.newestSeen = tick;
    this.clock.onSnapshot(tick);
    this.delay.onSnapshot(this.clock, step);
  }

  /** Hides everything and starts over (a session ended). */
  clear(): void {
    this.view.clear();
    this.mode.fill(REMOTE_NONE);
    this.speed.fill(0);
    this.offsetLength.fill(0);
    this.baseStamp.fill(0);
    this.eventCount = 0;
    this.clock.reset();
    this.delay.reset();
    this.newestSeen = 0;
    this.shown = false;
  }

  /** One frame at `now[0]`: every slot but the receiver's `selfId` into `view`. */
  update(selfId: number): void {
    const st = this.settings;
    const auto = this.delay.ticks;
    const fixed = st.interpDelay | 0;
    const d = fixed > 0 ? Math.min(INTERP_DELAY_MAX, Math.max(INTERP_DELAY_MIN, fixed)) : auto;
    this.delayTicks = d;
    const store = this.store;
    const newest = store.newestTick;
    const clock = this.clock;
    const f = this.f;
    f[F_PREV_RENDER] = clock.t[RC_RENDER] as number;
    clock.advance(d, newest);
    this.eventCount = 0;
    const render = clock.t[RC_RENDER] as number;
    if (newest === 0 || Number.isNaN(render)) {
      if (this.shown) this.hideAll();
      return;
    }
    if (clock.snapped && clock.snaps > 1) this.stats.add(STAT_RENDER_SNAPS, 1);
    if (Number.isNaN(f[F_PREV_RENDER] as number)) f[F_PREV_RENDER] = render;
    f[F_RENDER] = render;
    f[F_NOW] = this.now[0] as number;
    const presence = this.collectFrames(newest);
    const lo = presence[0] as number;
    const hi = presence[1] as number;
    const view = this.view;
    let drawn = 0;
    let extrapolated = 0;
    let held = 0;
    for (let s = 0; s < FRAME_SLOTS; s++) {
      const inWindow = ((s < 32 ? lo : hi) & (1 << (s & 31))) !== 0;
      if (s === selfId || (!inWindow && view.visible[s] === 0)) {
        if (view.visible[s] === 1) this.hide(s);
        else view.teleported[s] = 0;
        continue;
      }
      this.slot(s);
      if (view.visible[s] === 1) {
        drawn++;
        const m = this.mode[s] as number;
        if (m === REMOTE_EXTRAPOLATED) extrapolated++;
        else if (m === REMOTE_HELD) held++;
      }
    }
    view.count = drawn;
    this.shown = drawn > 0;
    const stats = this.stats;
    stats.add(STAT_REMOTE_FRAMES, drawn);
    if (extrapolated > 0) stats.add(STAT_REMOTE_EXTRAPOLATED, extrapolated);
    if (held > 0) stats.add(STAT_REMOTE_HELD, held);
  }

  // -------------------------------------------------------------------------------------------

  /**
   * The stored frames searched this frame, newest first: at least SAMPLE_SEARCH_FRAMES, and on
   * until one SAMPLE_STALENESS_TICKS before the render tick (at most the ring); and the slots
   * present in any of them (lo/hi masks).
   */
  private collectFrames(newest: number): Int32Array {
    const ring = this.store.ring;
    const until = (this.f[F_RENDER] as number) - SAMPLE_STALENESS_TICKS;
    const from = Math.max(1, newest - (SNAPSHOT_HISTORY - 1));
    let n = 0;
    let lo = 0;
    let hi = 0;
    for (let tick = newest; tick >= from; tick--) {
      const fr = ring.get(tick);
      if (fr === null) continue;
      this.frames[n] = fr;
      this.frameTicks[n] = tick;
      n++;
      lo |= fr.masks[MASK_PRESENT_LO] as number;
      hi |= fr.masks[MASK_PRESENT_HI] as number;
      if (n >= SAMPLE_SEARCH_FRAMES && tick <= until) break;
    }
    this.frameCount = n;
    const p = this.presence;
    p[0] = lo;
    p[1] = hi;
    return p;
  }

  private hide(s: number): void {
    const view = this.view;
    view.visible[s] = 0;
    view.teleported[s] = 0;
    view.extrapolating[s] = 0;
    this.mode[s] = REMOTE_NONE;
    this.speed[s] = 0;
    this.offsetLength[s] = 0;
    this.baseStamp[s] = 0;
  }

  private hideAll(): void {
    for (let s = 0; s < FRAME_SLOTS; s++) this.hide(s);
    this.view.count = 0;
    this.shown = false;
  }

  /** One slot's samples, raw origin, smoothing and row (see the class comment). */
  private slot(s: number): void {
    const f = this.f;
    const render = f[F_RENDER] as number;
    const frames = this.frames;
    const ticks = this.frameTicks;
    const n = this.frameCount;
    const from = f[F_PREV_RENDER] as number;
    // a: the largest stamp ≤ render; b: the smallest above it; any absence seen. And the NET-05
    // speed of the path this frame crossed (from the last frame's render tick to this one's): a
    // long frame can pass a whole bracket, a stair's step-up in it, that neither end lies in.
    let ai = -1;
    let aStamp = 0;
    let bi = -1;
    let bStamp = 0;
    let sawAbsent = false;
    let pathSpeed = 0;
    let lastStamp = 0;
    let lastX = 0;
    let lastY = 0;
    let lastZ = 0;
    let lastSeq = -1;
    let lastSpeed = 0;
    for (let k = 0; k < n; k++) {
      const fr = frames[k] as WorldFrame;
      if (fr.present[s] !== 1) {
        sawAbsent = true;
        continue;
      }
      const stamp = fr.stamp[s] as number;
      if (stamp === 0) continue;
      const x = (fr.originX[s] as number) / ORIGIN_SCALE;
      const y = (fr.originY[s] as number) / ORIGIN_SCALE;
      const z = (fr.originZ[s] as number) / ORIGIN_SCALE;
      const vx = fr.entVelX[s] as number;
      const vy = fr.entVelY[s] as number;
      const vz = fr.entVelZ[s] as number;
      const v = Math.sqrt(vx * vx + vy * vy + vz * vz);
      // Samples come newest first: (stamp, lastStamp) is a segment of the drawn path.
      if (
        lastStamp > stamp &&
        lastSeq === (fr.teleportSeq[s] as number) &&
        lastStamp > from &&
        stamp <= render
      ) {
        const dx = lastX - x;
        const dy = lastY - y;
        const dz = lastZ - z;
        const seg = Math.sqrt(dx * dx + dy * dy + dz * dz) / ((lastStamp - stamp) * TICK_DT);
        pathSpeed = Math.max(pathSpeed, seg, v, lastSpeed);
      }
      if (lastStamp !== stamp) {
        lastStamp = stamp;
        lastX = x;
        lastY = y;
        lastZ = z;
        lastSeq = fr.teleportSeq[s] as number;
        lastSpeed = v;
      }
      if (stamp <= render) {
        if (ai < 0 || stamp > aStamp) {
          ai = k;
          aStamp = stamp;
        }
      } else if (bi < 0 || stamp < bStamp) {
        bi = k;
        bStamp = stamp;
      }
    }
    const view = this.view;
    const visible = view.visible[s] === 1;
    // An absence after a's frame: hidden once render time reaches it, and never lerped across.
    let removedAt = 0;
    if (sawAbsent) {
      const aTick = ai < 0 ? 0 : (ticks[ai] as number);
      for (let k = 0; k < n; k++) {
        const t = ticks[k] as number;
        if (t > aTick && (frames[k] as WorldFrame).present[s] !== 1) {
          if (removedAt === 0 || t < removedAt) removedAt = t;
        }
      }
    }
    if (removedAt !== 0 && removedAt <= render) {
      if (visible) this.hide(s);
      return;
    }
    if (ai < 0) {
      // No sample at or before render time: not drawn yet, or held where it was.
      if (!visible) return;
      view.teleported[s] = 0;
      view.extrapolating[s] = 1;
      this.mode[s] = REMOTE_HELD;
      this.speed[s] = 0;
      return;
    }
    const a = frames[ai] as WorldFrame;
    const seq = a.teleportSeq[s] as number;
    const appeared = !visible;
    const teleported = appeared || this.lastSeq[s] !== seq;
    const prevMode = this.mode[s] as number;
    const prevBase = this.baseStamp[s] as number;
    const prevX = view.x[s] as number;
    const prevY = view.y[s] as number;
    const prevZ = view.z[s] as number;
    const ax = (a.originX[s] as number) / ORIGIN_SCALE;
    const ay = (a.originY[s] as number) / ORIGIN_SCALE;
    const az = (a.originZ[s] as number) / ORIGIN_SCALE;
    const avx = a.entVelX[s] as number;
    const avy = a.entVelY[s] as number;
    const avz = a.entVelZ[s] as number;
    const aSpeed = Math.sqrt(avx * avx + avy * avy + avz * avz);
    let yawU = a.yaw[s] as number;
    let pitchU = a.pitch[s] as number;
    let mode = REMOTE_INTERPOLATED;
    const b = bi < 0 ? null : (frames[bi] as WorldFrame);
    if (b !== null) {
      const lerp =
        b.teleportSeq[s] === seq && (removedAt === 0 || removedAt > (ticks[bi] as number));
      if (lerp) {
        const w = (render - aStamp) / (bStamp - aStamp);
        const bx = (b.originX[s] as number) / ORIGIN_SCALE;
        const by = (b.originY[s] as number) / ORIGIN_SCALE;
        const bz = (b.originZ[s] as number) / ORIGIN_SCALE;
        f[F_RAW_X] = ax + (bx - ax) * w;
        f[F_RAW_Y] = ay + (by - ay) * w;
        f[F_RAW_Z] = az + (bz - az) * w;
        const dyaw = ((((b.yaw[s] as number) - yawU) << 16) >> 16) * w;
        yawU = yawU + dyaw;
        pitchU = pitchU + ((b.pitch[s] as number) - pitchU) * w;
        const bvx = b.entVelX[s] as number;
        const bvy = b.entVelY[s] as number;
        const bvz = b.entVelZ[s] as number;
        const dx = bx - ax;
        const dy = by - ay;
        const dz = bz - az;
        const span = (bStamp - aStamp) * TICK_DT;
        this.speed[s] = Math.max(
          pathSpeed,
          aSpeed,
          Math.sqrt(bvx * bvx + bvy * bvy + bvz * bvz),
          Math.sqrt(dx * dx + dy * dy + dz * dz) / span,
        );
      } else {
        f[F_RAW_X] = ax;
        f[F_RAW_Y] = ay;
        f[F_RAW_Z] = az;
        this.speed[s] = Math.max(pathSpeed, aSpeed);
      }
    } else {
      const past = render - aStamp;
      this.speed[s] = Math.max(pathSpeed, aSpeed);
      if (past <= 0) {
        f[F_RAW_X] = ax;
        f[F_RAW_Y] = ay;
        f[F_RAW_Z] = az;
      } else {
        mode = past <= EXTRAPOLATE_TICKS ? REMOTE_EXTRAPOLATED : REMOTE_HELD;
        const e = Math.min(past, EXTRAPOLATE_TICKS) * TICK_DT;
        const start = this.traceStart;
        const end = this.traceEnd;
        start[0] = ax;
        start[1] = ay;
        start[2] = az;
        end[0] = ax + avx * e;
        end[1] = ay + avy * e;
        end[2] = az + avz * e;
        const crouched = ((a.flags[s] as number) & PMF_CROUCHED) !== 0;
        const tr = this.trace;
        traceBox(
          this.world,
          start,
          end,
          HULL_MINS,
          crouched ? CROUCH_MAXS : STAND_MAXS,
          MASK_PLAYERSOLID,
          tr,
        );
        const ep = tr.startSolid ? start : tr.endpos;
        f[F_RAW_X] = ep[0] as number;
        f[F_RAW_Y] = ep[1] as number;
        f[F_RAW_Z] = ep[2] as number;
      }
    }
    // Smoothing: a teleport or an appearance drops it; samples back after extrapolating or
    // holding start a rejoin offset (drawn − raw) that decays over cl_remoteSmoothMs. It snaps
    // instead only when the raw path's own jump this frame (an offset still decaying is carried,
    // not judged) is past both cl_teleportDist and what the slot's speed explains over the hold
    // (D-037: a 150 ms outage at 760 u/s leaves some 68 u, and a real teleport is keyed on the
    // counter anyway).
    const now = f[F_NOW] as number;
    const smoothMs = this.settings.remoteSmoothMs;
    const rx = f[F_RAW_X] as number;
    const ry = f[F_RAW_Y] as number;
    const rz = f[F_RAW_Z] as number;
    if (teleported) {
      this.offsetLength[s] = 0;
    } else if (
      (prevMode === REMOTE_EXTRAPOLATED || prevMode === REMOTE_HELD) &&
      (mode === REMOTE_INTERPOLATED || aStamp !== prevBase)
    ) {
      const ox = prevX - rx;
      const oy = prevY - ry;
      const oz = prevZ - rz;
      const len = Math.sqrt(ox * ox + oy * oy + oz * oz);
      const jx = (this.rawX[s] as number) - rx;
      const jy = (this.rawY[s] as number) - ry;
      const jz = (this.rawZ[s] as number) - rz;
      const jump = Math.sqrt(jx * jx + jy * jy + jz * jz);
      const explained =
        REJOIN_SPEED_MARGIN *
        (this.speed[s] as number) *
        (render - prevBase + EXTRAPOLATE_TICKS) *
        TICK_DT;
      const limit = Math.max(this.settings.teleportDist, explained);
      if (len > 0 && jump <= limit && smoothMs > 0) {
        this.offX[s] = ox;
        this.offY[s] = oy;
        this.offZ[s] = oz;
        this.offAt[s] = now;
        this.offsetLength[s] = len;
      } else {
        this.offsetLength[s] = 0;
      }
    }
    this.rawX[s] = rx;
    this.rawY[s] = ry;
    this.rawZ[s] = rz;
    let x = rx;
    let y = ry;
    let z = rz;
    if ((this.offsetLength[s] as number) > 0) {
      const k = 1 - (now - (this.offAt[s] as number)) / smoothMs;
      if (k > 0 && smoothMs > 0) {
        x += (this.offX[s] as number) * k;
        y += (this.offY[s] as number) * k;
        z += (this.offZ[s] as number) * k;
      } else {
        this.offsetLength[s] = 0;
      }
    }
    view.x[s] = x;
    view.y[s] = y;
    view.z[s] = z;
    if (yawU < 0) yawU += 65536;
    else if (yawU >= 65536) yawU -= 65536;
    view.yaw[s] = yawU * DEG_PER_U16;
    view.pitch[s] = pitchU * DEG_PER_U16;
    view.crouched[s] = ((a.flags[s] as number) & PMF_CROUCHED) !== 0 ? 1 : 0;
    view.team[s] = a.team[s] as number;
    view.visible[s] = 1;
    view.teleported[s] = teleported ? 1 : 0;
    view.extrapolating[s] = mode === REMOTE_INTERPOLATED ? 0 : 1;
    this.mode[s] = mode;
    this.baseStamp[s] = aStamp;
    this.lastSeq[s] = seq;
    this.events(s, a, appeared);
  }

  /** Surfaces the drawn sample's new movement events (up to the 2 it carries). */
  private events(s: number, a: WorldFrame, appeared: boolean): void {
    const seq = a.eventSeq[s] as number;
    const last = this.lastEventSeq[s] as number;
    this.lastEventSeq[s] = seq;
    if (appeared || seq === last) return;
    const step = (seq - last) & 0xff;
    const keep = Math.min(step, ENTITY_EVENT_SLOTS);
    const e = s * ENTITY_EVENT_SLOTS;
    for (let i = keep - 1; i >= 0; i--) {
      const n = this.eventCount;
      if (n === REMOTE_EVENTS_CAPACITY) break;
      this.eventSlot[n] = s;
      this.eventKind[n] = a.evKind[e + i] as number;
      this.eventValue[n] = a.evValue[e + i] as number;
      this.eventCount = n + 1;
    }
    this.stats.add(STAT_REMOTE_EVENTS, keep);
    if (step > keep) this.stats.add(STAT_REMOTE_EVENTS_LOST, step - keep);
  }
}

// RemoteJumpMeter.t slots.
/** Remote-frames judged and violations since the reset; the largest step / allowance seen. */
export const JM_CHECKED = 0;
export const JM_VIOLATIONS = 1;
export const JM_WORST_RATIO = 2;
/** Violations in the last measured frame. */
export const JM_FRAME_VIOLATIONS = 3;
const JM_SLOTS = 4;

/**
 * NET-05's step criterion on the drawn remotes (M3 design §2.8): per frame and slot, the step
 * from the last drawn position ≤ speed × dt × 1.5 + 0.5 u, speed being the interpolator's bound
 * this frame or last (the bracket's velocities and its displacement, which covers stairs), plus
 * the rejoin offset's decay (its length × dt / `cl_remoteSmoothMs`, this frame's or last's, so the
 * frame it runs out in is covered). A teleport, an appearance and
 * the render clock's first placement are exempt. Measure after every `update`.
 */
export class RemoteJumpMeter {
  readonly t = new Float64Array(JM_SLOTS);
  private readonly px = new Float64Array(FRAME_SLOTS);
  private readonly py = new Float64Array(FRAME_SLOTS);
  private readonly pz = new Float64Array(FRAME_SLOTS);
  private readonly pSpeed = new Float64Array(FRAME_SLOTS);
  private readonly pOffset = new Float64Array(FRAME_SLOTS);
  private readonly pVisible = new Uint8Array(FRAME_SLOTS);

  reset(): void {
    this.t.fill(0);
    this.pVisible.fill(0);
  }

  /**
   * Judges this frame of `interp` (when `judge`; a page leaves out its long frames) and keeps it
   * as the next frame's start.
   */
  measure(interp: RemoteInterpolator, judge: boolean): void {
    const view = interp.view;
    const smoothMs = interp.settings.remoteSmoothMs;
    const t = this.t;
    const clock = interp.clock;
    const dtS = (clock.t[RC_DT_MS] as number) / 1000;
    const decay = smoothMs > 0 ? (clock.t[RC_DT_MS] as number) / smoothMs : 1;
    const placed = clock.snapped && clock.snaps === 1;
    let violations = 0;
    for (let s = 0; s < FRAME_SLOTS; s++) {
      const visible = view.visible[s] === 1;
      const x = view.x[s] as number;
      const y = view.y[s] as number;
      const z = view.z[s] as number;
      const speed = interp.speed[s] as number;
      const offset = interp.offsetLength[s] as number;
      if (judge && !placed && visible && this.pVisible[s] === 1 && view.teleported[s] === 0) {
        const dx = x - (this.px[s] as number);
        const dy = y - (this.py[s] as number);
        const dz = z - (this.pz[s] as number);
        const step = Math.sqrt(dx * dx + dy * dy + dz * dz);
        const allowed =
          Math.max(speed, this.pSpeed[s] as number) * dtS * 1.5 +
          0.5 +
          Math.max(offset, this.pOffset[s] as number) * decay;
        t[JM_CHECKED] = (t[JM_CHECKED] as number) + 1;
        const ratio = step / allowed;
        if (ratio > (t[JM_WORST_RATIO] as number)) t[JM_WORST_RATIO] = ratio;
        if (step > allowed) violations++;
      }
      this.px[s] = x;
      this.py[s] = y;
      this.pz[s] = z;
      this.pSpeed[s] = speed;
      this.pOffset[s] = offset;
      this.pVisible[s] = visible ? 1 : 0;
    }
    t[JM_FRAME_VIOLATIONS] = violations;
    t[JM_VIOLATIONS] = (t[JM_VIOLATIONS] as number) + violations;
  }
}
