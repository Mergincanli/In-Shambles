import {
  BUTTON_CROUCH,
  BUTTON_JUMP,
  BUTTON_WALK,
  buildCollisionWorld,
  type Cmap,
  type CollisionWorld,
  decodeCmap,
  degreesToU16,
  ENTITY_WORLD,
  lastPmoveSnap,
  MOVE_AXIS_MAX,
  Mulberry32,
  murmur3Bytes,
  PlayerState,
  PMEV_JUMP,
  PMEV_LAND,
  PMEV_STEP,
  PMF_CROUCHED,
  PMF_GROUNDED,
  PMF_ON_LADDER,
  PMOVE_EVENTS_CAPACITY,
  PmoveEvent,
  PmoveEvents,
  PmoveParams,
  pmove,
  SNAP_ROUNDED,
  sanitizeUserCmd,
  TICK_DT,
  UserCmd,
} from "@game/shared";

/**
 * The MV-19 determinism probe (docs/03 §8, M2 design §5): a seeded 10k-tick run of pmove on
 * movement_lab, digesting the state every tick. MV-19 runs it twice in process, then bundled by
 * the server's esbuild build and by Vite's library build (minified) in plain Node, and every run
 * must give the same digests. So this module imports @game/shared only and takes the map as bytes:
 * no Node APIs, so either bundler packs it as is, for Node or the browser.
 */

export const MV19_TICKS = 10_000;
/** Ticks between teleports to the next anchor. */
export const MV19_TELEPORT_TICKS = 1000;
export const MV19_SEED = 0x19de;

/**
 * Where each 1000-tick segment starts, in order: flat ground, steps, stairs, slopes (walkable and
 * steep), the ladder, the pool at three depths and the tunnel.
 */
export const MV19_ANCHORS = [
  "open_center",
  "step_18_base",
  "stairs_base",
  "slope_071_base",
  "slope_069_base",
  "ladder_base",
  "water_wade",
  "water_waist",
  "water_deep",
  "tunnel_entry",
] as const;

/** What a run did, so MV-19 can check the stream reached every mode. */
export interface ProbeTally {
  grounded: number;
  swimming: number;
  ladder: number;
  crouched: number;
  jumps: number;
  steps: number;
  lands: number;
  /** Ticks whose snap was not plain rounding (a corner or the previous origin). */
  snapRepairs: number;
}

export interface ProbeResult {
  /** The chained digest after the last tick (u32). */
  readonly digest: number;
  /** The chained digest after every MV19_TELEPORT_TICKS-th tick. */
  readonly checkpoints: number[];
  readonly tally: ProbeTally;
}

/** x, y, z, yaw (u16) per MV19_ANCHORS entry. */
function anchorTable(cmap: Cmap): Float64Array {
  const out = new Float64Array(4 * MV19_ANCHORS.length);
  for (let i = 0; i < MV19_ANCHORS.length; i++) {
    const name = MV19_ANCHORS[i];
    const e = cmap.entities.find(
      (x) => x.classname === "info_target" && x.props.targetname === name,
    );
    if (e?.origin === undefined) throw new Error(`MV-19: the map has no anchor ${name}`);
    out.set(
      [e.origin[0], e.origin[1], e.origin[2], degreesToU16(e.angles?.[1] ?? 0) & 0xffff],
      4 * i,
    );
  }
  return out;
}

function teleport(ps: PlayerState, anchors: Float64Array, n: number): void {
  const o = 4 * (n % MV19_ANCHORS.length);
  ps.origin[0] = anchors[o] as number;
  ps.origin[1] = anchors[o + 1] as number;
  ps.origin[2] = anchors[o + 2] as number;
  ps.velocity.fill(0);
  ps.viewYaw = anchors[o + 3] as number;
  ps.viewPitch = 0;
  ps.flags = PMF_GROUNDED;
  ps.groundEntity = ENTITY_WORLD;
  ps.waterLevel = 0;
  ps.stamina = 100 * 100;
}

/** State, snap outcome and events of one tick, as little-endian doubles for the digest. */
const DIGEST_DOUBLES = 14 + 2 * PMOVE_EVENTS_CAPACITY;

/**
 * Runs the probe. `perTick`, when given, receives the chained digest after each tick (MV-19's
 * in-process comparison); a run is otherwise allocation-light, so the bundled runs stay quick.
 */
export function runDeterminismProbe(
  cmapBytes: Uint8Array,
  ticks: number = MV19_TICKS,
  perTick: Uint32Array | null = null,
): ProbeResult {
  const cmap = decodeCmap(cmapBytes);
  const world: CollisionWorld = buildCollisionWorld(cmap);
  const anchors = anchorTable(cmap);
  const params = new PmoveParams();
  const ps = new PlayerState();
  const cmd = new UserCmd();
  const events = new PmoveEvents();
  const event = new PmoveEvent();
  const rng = new Mulberry32(MV19_SEED);
  const bytes = new Uint8Array(8 * DIGEST_DOUBLES);
  const view = new DataView(bytes.buffer);
  const tally: ProbeTally = {
    grounded: 0,
    swimming: 0,
    ladder: 0,
    crouched: 0,
    jumps: 0,
    steps: 0,
    lands: 0,
    snapRepairs: 0,
  };
  const checkpoints: number[] = [];
  // The "sticky" stream: each choice holds for 6–60 ticks, as a player holds keys (pmove bench).
  let hold = 0;
  let forward = 0;
  let right = 0;
  let buttons = 0;
  let yawRate = 0;
  let pitch = 0;
  let digest = 0;
  for (let t = 0; t < ticks; t++) {
    if (t % MV19_TELEPORT_TICKS === 0) teleport(ps, anchors, t / MV19_TELEPORT_TICKS);
    if (hold-- <= 0) {
      hold = 6 + rng.nextInt(55);
      const f = rng.nextFloat();
      forward = f < 0.7 ? MOVE_AXIS_MAX : f < 0.85 ? 0 : -MOVE_AXIS_MAX;
      const r = rng.nextFloat();
      right = r < 0.5 ? 0 : r < 0.75 ? MOVE_AXIS_MAX : -MOVE_AXIS_MAX;
      buttons = rng.nextFloat() < 0.25 ? BUTTON_JUMP : 0;
      if (rng.nextFloat() < 0.15) buttons |= BUTTON_WALK;
      if (rng.nextFloat() < 0.1) buttons |= BUTTON_CROUCH;
      yawRate = rng.nextInt(801) - 400;
      pitch = rng.nextInt(16001) - 8000;
    }
    // Held jumps are released for a tick now and then, so landings chain into hops.
    cmd.tick = t;
    cmd.forward = forward;
    cmd.right = right;
    cmd.up = 0;
    cmd.buttons = (t & 15) === 0 ? buttons & ~BUTTON_JUMP : buttons;
    cmd.yaw = (ps.viewYaw + yawRate) & 0xffff;
    cmd.pitch = pitch & 0xffff;
    cmd.weaponSlot = 0;
    sanitizeUserCmd(cmd);
    events.clear();
    pmove(ps, cmd, world, params, TICK_DT, events, null);

    const snap = lastPmoveSnap();
    const o = ps.origin;
    const v = ps.velocity;
    view.setFloat64(0, o[0], true);
    view.setFloat64(8, o[1], true);
    view.setFloat64(16, o[2], true);
    view.setFloat64(24, v[0], true);
    view.setFloat64(32, v[1], true);
    view.setFloat64(40, v[2], true);
    view.setFloat64(48, ps.viewYaw, true);
    view.setFloat64(56, ps.viewPitch, true);
    view.setFloat64(64, ps.flags, true);
    view.setFloat64(72, ps.groundEntity, true);
    view.setFloat64(80, ps.waterLevel, true);
    view.setFloat64(88, ps.stamina, true);
    view.setFloat64(96, snap, true);
    view.setFloat64(104, events.count, true);
    for (let k = 0; k < PMOVE_EVENTS_CAPACITY; k++) {
      let type = 0;
      let value = 0;
      if (k < events.count) {
        events.read(k, event);
        type = event.type;
        value = event.value;
        if (type === PMEV_JUMP) tally.jumps++;
        else if (type === PMEV_STEP) tally.steps++;
        else if (type === PMEV_LAND) tally.lands++;
      }
      view.setFloat64(112 + 16 * k, type, true);
      view.setFloat64(120 + 16 * k, value, true);
    }
    digest = murmur3Bytes(bytes, digest);
    if (perTick !== null) perTick[t] = digest;
    if ((t + 1) % MV19_TELEPORT_TICKS === 0) checkpoints.push(digest);

    const flags = ps.flags;
    if ((flags & PMF_GROUNDED) !== 0) tally.grounded++;
    if ((flags & PMF_ON_LADDER) !== 0) tally.ladder++;
    if ((flags & PMF_CROUCHED) !== 0) tally.crouched++;
    if (ps.waterLevel >= 2) tally.swimming++;
    if (snap !== SNAP_ROUNDED) tally.snapRepairs++;
  }
  return { digest, checkpoints, tally };
}
