import {
  type CollisionWorld,
  ENTITY_NONE,
  ENTITY_WORLD,
  lastPmoveSnap,
  type PlayerState,
  PMF_GROUNDED,
  PmoveEvent,
  PmoveEvents,
  PmoveParams,
  pmove,
  sanitizeUserCmd,
  TICK_DT,
  UserCmd,
} from "@game/shared";
import { anchorYawU16, type CourseAnchor, type P3 } from "./course";

/**
 * The movement scenario runner (D-025, M2 design §1): real pmove on a real course, one tick at a
 * time from a starting state, with input from a scripted CmdSource. Every tick's resulting state,
 * snap outcome and movement events go into preallocated typed arrays, so the tick loop allocates
 * nothing beyond what the cmd source does (the bots in bots.ts allocate nothing either; the
 * native-ESM allocation test runs them), and a long run (the feel report, MV-19) costs no more
 * than pmove itself.
 */

/** Scripted input: one cmd per tick, chosen from the state the tick starts from. */
export interface CmdSource {
  /** Fills every field of `cmd` except `tick`, which the runner sets. `ps` is read only. */
  next(cmd: UserCmd, ps: PlayerState): void;
}

/**
 * Stamina a scenario starts with, in hundredths: full for a fresh spawn without a vest (health
 * 100, docs/04; staminaMax = health, docs/03 §5.2), so the stamina rules, once they land, see a
 * rested player.
 */
export const SCENARIO_STAMINA = 100 * 100;

/** Most events a record keeps; later ones are counted in `eventsDropped`. */
export const SCENARIO_EVENT_CAPACITY = 4096;

/**
 * A run's history. State index 0 is the start; index i is the state after tick i, so tick i
 * (1-based) moved the player from state i − 1 to state i, and an event emitted by tick i carries
 * tick number i. Time at state i is i · dt.
 */
export class ScenarioRecord {
  /** States recorded so far, the start included. */
  count = 0;
  readonly origin: Float64Array;
  readonly velocity: Float64Array;
  readonly flags: Int32Array;
  readonly viewYaw: Int32Array;
  /** lastPmoveSnap() after each tick (index 0 unused). */
  readonly snap: Uint8Array;
  eventCount = 0;
  eventsDropped = 0;
  readonly eventTick: Int32Array;
  readonly eventType: Uint8Array;
  readonly eventValue: Float64Array;

  constructor(
    /** Ticks the record has room for. */
    readonly ticks: number,
    readonly dt: number,
  ) {
    const states = ticks + 1;
    this.origin = new Float64Array(3 * states);
    this.velocity = new Float64Array(3 * states);
    this.flags = new Int32Array(states);
    this.viewYaw = new Int32Array(states);
    this.snap = new Uint8Array(states);
    this.eventTick = new Int32Array(SCENARIO_EVENT_CAPACITY);
    this.eventType = new Uint8Array(SCENARIO_EVENT_CAPACITY);
    this.eventValue = new Float64Array(SCENARIO_EVENT_CAPACITY);
  }

  /** Ticks run so far. */
  get ticksRun(): number {
    return Math.max(0, this.count - 1);
  }

  x(i: number): number {
    return this.origin[3 * i] as number;
  }

  y(i: number): number {
    return this.origin[3 * i + 1] as number;
  }

  z(i: number): number {
    return this.origin[3 * i + 2] as number;
  }

  grounded(i: number): boolean {
    return ((this.flags[i] as number) & PMF_GROUNDED) !== 0;
  }

  /** Empties the record for reuse (the feel report, benches), keeping its arrays. */
  clear(): void {
    this.count = 0;
    this.eventCount = 0;
    this.eventsDropped = 0;
  }

  /** Records `ps` as state `count`. */
  push(ps: PlayerState): void {
    const i = this.count++;
    const o = ps.origin;
    const v = ps.velocity;
    const k = 3 * i;
    this.origin[k] = o[0];
    this.origin[k + 1] = o[1];
    this.origin[k + 2] = o[2];
    this.velocity[k] = v[0];
    this.velocity[k + 1] = v[1];
    this.velocity[k + 2] = v[2];
    this.flags[i] = ps.flags;
    this.viewYaw[i] = ps.viewYaw;
  }
}

/**
 * Puts a player at rest at `origin` facing `yaw` (u16), pitch 0, with full stamina. Grounded on
 * the world unless `grounded` is false (a drop or a spawn on steep ground), so a start on the
 * floor emits no LAND.
 */
export function placePlayer(
  ps: PlayerState,
  origin: P3 | Float64Array,
  yaw: number,
  grounded = true,
): PlayerState {
  ps.origin[0] = origin[0] as number;
  ps.origin[1] = origin[1] as number;
  ps.origin[2] = origin[2] as number;
  ps.velocity.fill(0);
  ps.viewYaw = yaw & 0xffff;
  ps.viewPitch = 0;
  ps.flags = grounded ? PMF_GROUNDED : 0;
  ps.groundEntity = grounded ? ENTITY_WORLD : ENTITY_NONE;
  ps.waterLevel = 0;
  ps.stamina = SCENARIO_STAMINA;
  return ps;
}

/** placePlayer at an anchor, facing the anchor's yaw unless `yaw` (u16) overrides it. */
export function placeAtAnchor(ps: PlayerState, anchor: CourseAnchor, yaw?: number): PlayerState {
  return placePlayer(ps, anchor.origin, yaw ?? anchorYawU16(anchor));
}

/** One world, one parameter set, one tick length; reusable across runs. */
export class ScenarioRunner {
  readonly cmd = new UserCmd();
  private readonly events = new PmoveEvents();
  private readonly event = new PmoveEvent();

  constructor(
    readonly world: CollisionWorld,
    readonly params: PmoveParams = new PmoveParams(),
    /** TICK_DT in play; MV-04 also runs 1/120 (D-023). */
    readonly dt: number = TICK_DT,
  ) {}

  /**
   * Runs `ticks` ticks of pmove on `ps` in place, with cmds from `source` (sanitized as the
   * server does), into a fresh record whose state 0 is `ps` as passed in. `capacity` leaves room
   * for `continue` to append more.
   */
  run(ps: PlayerState, source: CmdSource, ticks: number, capacity = ticks): ScenarioRecord {
    const record = new ScenarioRecord(Math.max(ticks, capacity), this.dt);
    record.push(ps);
    this.continue(ps, source, ticks, record);
    return record;
  }

  /** Appends up to `ticks` more ticks to `record` (as many as it has room for). */
  continue(ps: PlayerState, source: CmdSource, ticks: number, record: ScenarioRecord): void {
    const cmd = this.cmd;
    const events = this.events;
    const event = this.event;
    const world = this.world;
    const params = this.params;
    const dt = this.dt;
    const end = Math.min(record.count + ticks, record.ticks + 1);
    while (record.count < end) {
      const tick = record.count;
      source.next(cmd, ps);
      cmd.tick = tick;
      sanitizeUserCmd(cmd);
      events.clear();
      pmove(ps, cmd, world, params, dt, events, null);
      record.snap[tick] = lastPmoveSnap();
      record.push(ps);
      // Written here rather than through a method: a double crossing a call that isn't inlined
      // is boxed under native ESM.
      for (let k = 0; k < events.count; k++) {
        events.read(k, event);
        const e = record.eventCount;
        if (e === SCENARIO_EVENT_CAPACITY) {
          record.eventsDropped++;
          continue;
        }
        record.eventCount = e + 1;
        record.eventTick[e] = tick;
        record.eventType[e] = event.type;
        record.eventValue[e] = event.value;
      }
      record.eventsDropped += events.dropped;
    }
  }
}
