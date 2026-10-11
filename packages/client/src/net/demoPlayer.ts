import {
  BitReader,
  type CollisionWorld,
  CvarRegistry,
  CvarsMsg,
  copyDemoBytes,
  DEMO_REC_CVARS,
  DEMO_REC_EVENTS,
  DEMO_REC_SNAPSHOT,
  DEMO_RECORD_MAX_BYTES,
  type DemoHeader,
  DemoReader,
  decodeCvars,
  decodeEvents,
  EventsMsg,
  FRAME_SLOTS,
  type WorldFrame,
} from "@game/shared";
import { TICK_MS } from "./clock";
import { ClientNetSettings, refreshClientNetSettings, registerClientNetCvars } from "./cvars";
import { RemoteInterpolator, type RemoteView } from "./remotes";
import { Roster } from "./roster";
import { SnapshotStore, STORE_STORED } from "./snapshotStore";
import { NetStats } from "./stats";

/** No player is followed (nobody is present). */
export const FOLLOW_NONE = -1;

export interface DemoPlayerOptions {
  /** The demo file; `validateDemo` passed it, and `header` is what it returned. */
  readonly bytes: Uint8Array;
  readonly header: DemoHeader;
  /** The map's collision (the extrapolation's clamp). */
  readonly world: CollisionWorld;
  /** Monotonic milliseconds: `performance.now` in the browser, a fake clock in tests. */
  readonly clock: () => number;
  /**
   * The page's registry, for the interpolation's settings (`cl_interpDelay`, `cl_remoteSmoothMs`,
   * `cl_teleportDist`); a new one with the client net cvars when absent. The demo's own cvar
   * blocks are read, never applied: nothing in playback predicts.
   */
  readonly cvars?: CvarRegistry;
  /** Each stored snapshot's tick and frame (tests compare them with the server's). */
  readonly onSnapshot?: (tick: number, frame: WorldFrame) => void;
}

/**
 * Demo playback (D-044, M3 design §2.12): a validated `.demo` played at 1× from its start tick.
 * Each frame takes the records due by the playback time (start tick + elapsed ticks): spectator
 * snapshots into a spectator store that times the remote interpolation as live snapshots do
 * (the same `RemoteInterpolator`, every slot a remote), EVENTS into a roster, CVARS counted (a
 * demo's blocks are never applied). No seeking. After the END the players hold where they were.
 *
 * It follows one player for the camera: the lowest present id at first, `followNext` and
 * `followPrev` step to the next or previous present id in ascending order, wrapping and skipping
 * absent ones, `follow(id)` jumps to a present one, and when the followed player leaves (is no
 * longer drawn) the camera moves on to the next present id. DOM-free; a frame allocates nothing.
 */
export class DemoPlayer {
  /** [0] this frame's time (ms), shared with the stats and the interpolation. */
  readonly now = new Float64Array(1);
  readonly header: DemoHeader;
  readonly store = new SnapshotStore(true);
  readonly stats: NetStats;
  readonly settings = new ClientNetSettings();
  readonly cvars: CvarRegistry;
  readonly remotes: RemoteInterpolator;
  /** Who the demo's EVENTS say is in the match (their teams), and the server's tick times. */
  readonly roster = new Roster();
  /** Join and leave notices after the first tick's roster (the page drains them). */
  readonly notices: string[] = [];
  /** The followed player's id, or FOLLOW_NONE. */
  following = FOLLOW_NONE;
  /** The newest tick played (records applied up to it), 0 before the first. */
  tick = 0;
  /** Records applied, by kind. */
  snapshots = 0;
  events = 0;
  cvarChanges = 0;
  /** A record that should not have failed did (a file changed under a validated header). */
  faults = 0;
  /** The END record was reached. */
  ended = false;
  frames = 0;
  private readonly bytes: Uint8Array;
  private readonly clockFn: () => number;
  private readonly onSnapshot: ((tick: number, frame: WorldFrame) => void) | null;
  private readonly reader = new DemoReader();
  private readonly bits = new BitReader();
  private readonly scratch = new Uint8Array(DEMO_RECORD_MAX_BYTES);
  private readonly eventsMsg = new EventsMsg();
  private readonly cvarsMsg = new CvarsMsg();
  /** [0] the time playback started (ms; NaN before the first frame). */
  private readonly t = new Float64Array([Number.NaN]);
  /** A record read but not yet due: applied by a later frame. */
  private pending = false;

  constructor(options: DemoPlayerOptions) {
    this.bytes = options.bytes;
    this.header = options.header;
    this.clockFn = options.clock;
    this.onSnapshot = options.onSnapshot ?? null;
    let cvars = options.cvars;
    if (cvars === undefined) {
      cvars = new CvarRegistry();
      registerClientNetCvars(cvars);
    }
    this.cvars = cvars;
    refreshClientNetSettings(cvars, this.settings);
    this.stats = new NetStats(this.now);
    this.remotes = new RemoteInterpolator(
      this.store,
      this.now,
      this.settings,
      this.stats,
      options.world,
    );
    this.reader.reset(this.bytes, this.bytes.length, this.header.length);
  }

  /** What the renderer draws this frame: every player of the demo. */
  get view(): RemoteView {
    return this.remotes.view;
  }

  /**
   * One frame: the records due by now (the first frame starts the playback clock at the start
   * tick), the interpolation, then the followed player kept on someone present.
   */
  frame(): void {
    const now = this.now;
    now[0] = this.clockFn();
    refreshClientNetSettings(this.cvars, this.settings);
    this.stats.advance();
    this.frames++;
    const t = this.t;
    if (Number.isNaN(t[0] as number)) t[0] = now[0] as number;
    const due =
      this.header.startTick + Math.floor(((now[0] as number) - (t[0] as number)) / TICK_MS);
    this.playUntil(due);
    this.remotes.update(-1);
    const view = this.remotes.view;
    const f = this.following;
    if (f < 0 || view.visible[f] !== 1) this.following = this.nextPresent(f, 1);
  }

  /**
   * Applies every record with tick ≤ `tick` not applied yet (tests drive playback by tick with
   * this; `frame` calls it with the playback time's tick).
   */
  playUntil(tick: number): void {
    const rd = this.reader;
    for (;;) {
      if (!this.pending) {
        if (!rd.next()) {
          if (rd.ended) this.ended = true;
          else if (rd.error !== null && !this.ended) {
            this.faults++;
            this.ended = true;
          }
          return;
        }
        this.pending = true;
      }
      if (rd.tick > tick) return;
      this.pending = false;
      this.apply(rd.kind, rd.tick, rd.offset, rd.size);
    }
  }

  /** Follows the next present player after the followed one (wrapping); its id, or FOLLOW_NONE. */
  followNext(): number {
    this.following = this.nextPresent(this.following, 1);
    return this.following;
  }

  /** Follows the previous present player (wrapping); its id, or FOLLOW_NONE. */
  followPrev(): number {
    this.following = this.nextPresent(this.following, -1);
    return this.following;
  }

  /** Follows player `id` if it is present (drawn); false, changing nothing, if not. */
  follow(id: number): boolean {
    if (!(id >= 0 && id < FRAME_SLOTS) || this.remotes.view.visible[id] !== 1) return false;
    this.following = id;
    return true;
  }

  /** The team of the followed player (TEAM_*), 0 when none. */
  get followedTeam(): number {
    const f = this.following;
    return f < 0 ? 0 : (this.remotes.view.team[f] as number);
  }

  /**
   * The first present id after `from` stepping by `dir` (±1) through every slot, wrapping; `from`
   * itself last, so a lone player stays followed. FOLLOW_NONE when nobody is present.
   */
  private nextPresent(from: number, dir: number): number {
    const visible = this.remotes.view.visible;
    const start = from < 0 ? (dir > 0 ? -1 : 0) : from;
    for (let k = 1; k <= FRAME_SLOTS; k++) {
      const s = (((start + dir * k) % FRAME_SLOTS) + FRAME_SLOTS) % FRAME_SLOTS;
      if (visible[s] === 1) return s;
    }
    return FOLLOW_NONE;
  }

  private apply(kind: number, tick: number, offset: number, size: number): void {
    // The start tick's EVENTS (one message or several: 63 events a message) are the recording's
    // roster burst; any record after that tick is news. By tick, not by record: an empty start has
    // no EVENTS at all.
    if (tick !== this.header.startTick) this.roster.burstDone = true;
    const scratch = this.scratch;
    copyDemoBytes(scratch, this.bytes, offset, size);
    const r = this.bits;
    r.reset(scratch, size);
    if (kind === DEMO_REC_SNAPSHOT) {
      if (this.store.receive(r, -1) !== STORE_STORED) {
        this.faults++;
        return;
      }
      this.snapshots++;
      this.tick = tick;
      this.remotes.onStored(tick);
      const f = this.store.lastStored;
      if (this.onSnapshot !== null && f !== null) this.onSnapshot(tick, f);
    } else if (kind === DEMO_REC_EVENTS) {
      if (!decodeEvents(r, this.eventsMsg)) {
        this.faults++;
        return;
      }
      this.events++;
      this.roster.apply(this.eventsMsg, -1, this.notices);
    } else if (kind === DEMO_REC_CVARS) {
      if (!decodeCvars(r, this.cvarsMsg)) {
        this.faults++;
        return;
      }
      this.cvarChanges++;
    }
  }
}
