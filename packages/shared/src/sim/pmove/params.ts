import { CvarFlag } from "../../cvars/flags";
import type { CvarRegistry } from "../../cvars/registry";

/**
 * Movement tunables as plain fields, so pmove never looks a cvar up (M2 design §2). One field
 * per PMOVE_CVARS row; `refreshPmoveParams` copies the registry into it when the registry, or its
 * version, changes. Fields are initialised in a fixed order so every instance has one shape; the
 * defaults equal the PMOVE_CVARS defaults, whose rows carry the FACT/INFERRED/ESTIMATE labels.
 */
export class PmoveParams {
  gravity = 800; // FACT-Q3 (docs/03 §2.1)
  jumpVelocity = 270; // FACT-Q3 (docs/03 §2.1)
  runSpeed = 320; // FACT-Q3 (docs/03 §2.1)
  stopSpeed = 100; // FACT-Q3 (docs/03 §2.1)
  friction = 6; // FACT-Q3 (docs/03 §2.1)
  accelerate = 10; // FACT-Q3 (docs/03 §2.1)
  airAccelerate = 1; // FACT-Q3 (docs/03 §2.1)
  duckScale = 0.25; // FACT-Q3 (docs/03 §2.1)
  walkScale = 0.5; // FACT-Q3 (docs/03 §2.1)
  swimScale = 0.5; // FACT-Q3 (docs/03 §2.1)
  waterAccelerate = 4; // FACT-Q3 (docs/03 §2.1)
  waterFriction = 1; // FACT-Q3 (docs/03 §2.1)
  stepSize = 18; // FACT-Q3 (docs/03 §2.1)
  minWalkNormal = 0.7; // FACT-Q3 (docs/03 §2.1)
  overclip = 1.001; // FACT-Q3 (docs/03 §2.1)
  groundTraceDist = 0.25; // FACT-Q3 (docs/03 §2.1)
  autoHop = 0; // ESTIMATE (docs/03 §2.2)
  ladderScale = 0.5; // ESTIMATE (docs/03 §2.3)
  ladderFacing = 0.5; // ESTIMATE (docs/03 §2.3)
  ladderReach = 2; // ESTIMATE (docs/03 §2.3)
  ladderJumpPush = 150; // ESTIMATE (docs/03 §2.3)
  waterSinkSpeed = 60; // ESTIMATE (docs/03 §2.3)
  /** `CvarRegistry.version` these values were copied at; −1 = never refreshed. */
  version = -1;
  /**
   * The registry they were copied from. Every registry counts its versions from 0, so a version
   * alone can't tell a rebuilt registry (a reconnect, a match restart) from the old one.
   */
  registry: CvarRegistry | null = null;
}

export type PmoveParamField = Exclude<keyof PmoveParams, "version" | "registry">;

/**
 * FACT-Q3: docs/03 §2.1 (FACT for Q3; UrT may have changed it, hence a cvar). FACT: sourced for
 * UrT (docs/03 §2.2); no M2 row uses it yet, the UrT layer adds them in M4.
 */
export type PmoveCvarLabel = "FACT-Q3" | "FACT" | "INFERRED" | "ESTIMATE";

export interface PmoveCvarRow {
  readonly name: string;
  readonly field: PmoveParamField;
  readonly type: "float" | "int";
  readonly default: number;
  readonly min: number;
  readonly max: number;
  readonly label: PmoveCvarLabel;
  readonly description: string;
}

function row(
  name: string,
  field: PmoveParamField,
  type: "float" | "int",
  value: number,
  min: number,
  max: number,
  label: PmoveCvarLabel,
  description: string,
): PmoveCvarRow {
  return Object.freeze({ name, field, type, default: value, min, max, label, description });
}

/**
 * The replicated movement cvars M2 simulates: docs/03 §2.1, `pm_autoHop` from §2.2 and the M2
 * additions in §2.3. Defaults and labels are pinned to those tables by a doc-golden test
 * (packages/tools/test/docs/pmove-cvars-docs.test.ts). Bounds are design limits that keep the
 * sim sane (no negative speeds, overclip ≥ 1 so a clip never points into a plane), not ESTIMATEs.
 */
export const PMOVE_CVARS: readonly PmoveCvarRow[] = Object.freeze([
  row("pm_gravity", "gravity", "float", 800, 0, 10000, "FACT-Q3", "Gravity, u/s²"),
  row(
    "pm_jumpVelocity",
    "jumpVelocity",
    "float",
    270,
    0,
    2000,
    "FACT-Q3",
    "Jump velocity, u/s, set (not added)",
  ),
  row("pm_runSpeed", "runSpeed", "float", 320, 0, 2000, "FACT-Q3", "Ground wish-speed cap, u/s"),
  row("pm_stopSpeed", "stopSpeed", "float", 100, 0, 2000, "FACT-Q3", "Friction control floor"),
  row("pm_friction", "friction", "float", 6, 0, 100, "FACT-Q3", "Ground friction"),
  row("pm_accelerate", "accelerate", "float", 10, 0, 1000, "FACT-Q3", "Ground acceleration"),
  row("pm_airAccelerate", "airAccelerate", "float", 1, 0, 1000, "FACT-Q3", "Air acceleration"),
  row("pm_duckScale", "duckScale", "float", 0.25, 0, 1, "FACT-Q3", "Crouch speed multiplier"),
  row("pm_walkScale", "walkScale", "float", 0.5, 0, 1, "FACT-Q3", "Walk speed multiplier"),
  row("pm_swimScale", "swimScale", "float", 0.5, 0, 1, "FACT-Q3", "Swim speed multiplier"),
  row("pm_waterAccelerate", "waterAccelerate", "float", 4, 0, 1000, "FACT-Q3", "Swim acceleration"),
  row("pm_waterFriction", "waterFriction", "float", 1, 0, 100, "FACT-Q3", "Water friction"),
  row("pm_stepSize", "stepSize", "float", 18, 0, 64, "FACT-Q3", "Max auto step-up, u"),
  row(
    "pm_minWalkNormal",
    "minWalkNormal",
    "float",
    0.7,
    0,
    1,
    "FACT-Q3",
    "Walkable ground normal z threshold",
  ),
  row("pm_overclip", "overclip", "float", 1.001, 1, 1.1, "FACT-Q3", "Velocity clip overbounce"),
  // At least 2ε (1/16 u): the probe has to reach a floor the player rests ε above (D-017).
  row(
    "pm_groundTraceDist",
    "groundTraceDist",
    "float",
    0.25,
    0.0625,
    4,
    "FACT-Q3",
    "Downward ground probe, u",
  ),
  row(
    "pm_autoHop",
    "autoHop",
    "int",
    0,
    0,
    1,
    "ESTIMATE",
    "1 = holding jump re-jumps on landing; 0 = re-press (Q3)",
  ),
  row(
    "pm_ladderScale",
    "ladderScale",
    "float",
    0.5,
    0,
    2,
    "ESTIMATE",
    "Ladder speed as a fraction of pm_runSpeed",
  ),
  row(
    "pm_ladderFacing",
    "ladderFacing",
    "float",
    0.5,
    0,
    1,
    "ESTIMATE",
    "Min dot(forward, -ladder normal) to stay attached",
  ),
  row(
    "pm_ladderReach",
    "ladderReach",
    "float",
    2,
    0,
    32,
    "ESTIMATE",
    "Forward ladder probe length, u",
  ),
  row(
    "pm_ladderJumpPush",
    "ladderJumpPush",
    "float",
    150,
    0,
    2000,
    "ESTIMATE",
    "Push along the ladder normal on jump-off, u/s",
  ),
  row(
    "pm_waterSinkSpeed",
    "waterSinkSpeed",
    "float",
    60,
    0,
    2000,
    "ESTIMATE",
    "Sink speed with no swim input, u/s",
  ),
]);

/** Registers every PMOVE_CVARS row as REPLICATED: the server owns them and prediction uses them. */
export function registerPmoveCvars(reg: CvarRegistry): void {
  for (let i = 0; i < PMOVE_CVARS.length; i++) {
    const r = PMOVE_CVARS[i] as PmoveCvarRow;
    reg.register({
      name: r.name,
      type: r.type,
      default: r.default,
      min: r.min,
      max: r.max,
      description: r.description,
      flags: CvarFlag.REPLICATED,
    });
  }
}

/** Scratch for `refreshPmoveParams`, one slot per PMOVE_CVARS row. */
const values = new Float64Array(PMOVE_CVARS.length);

/**
 * Copies the registry's movement cvars into `out` when `reg` or its version differs from the
 * one `out` was last refreshed from; returns whether it did. A cvar the registry lacks, or holds
 * with a non-numeric value, gets its PMOVE_CVARS default. The unchanged case is two comparisons
 * and nothing allocates either way, so callers may run it every tick. Under native ESM a keyed
 * store `out[row.field]`, or 22 calls returning a double, box it; so one call site fills a
 * Float64Array and the fields are stored by name from it, in PMOVE_CVARS order (params.test.ts
 * gives every row a distinct value to pin that order).
 */
export function refreshPmoveParams(reg: CvarRegistry, out: PmoveParams): boolean {
  const version = reg.version;
  if (reg === out.registry && version === out.version) return false;
  const v = values;
  for (let i = 0; i < PMOVE_CVARS.length; i++) {
    const r = PMOVE_CVARS[i] as PmoveCvarRow;
    v[i] = reg.getNumber(r.name, r.default);
  }
  out.gravity = v[0] as number; // pm_gravity
  out.jumpVelocity = v[1] as number; // pm_jumpVelocity
  out.runSpeed = v[2] as number; // pm_runSpeed
  out.stopSpeed = v[3] as number; // pm_stopSpeed
  out.friction = v[4] as number; // pm_friction
  out.accelerate = v[5] as number; // pm_accelerate
  out.airAccelerate = v[6] as number; // pm_airAccelerate
  out.duckScale = v[7] as number; // pm_duckScale
  out.walkScale = v[8] as number; // pm_walkScale
  out.swimScale = v[9] as number; // pm_swimScale
  out.waterAccelerate = v[10] as number; // pm_waterAccelerate
  out.waterFriction = v[11] as number; // pm_waterFriction
  out.stepSize = v[12] as number; // pm_stepSize
  out.minWalkNormal = v[13] as number; // pm_minWalkNormal
  out.overclip = v[14] as number; // pm_overclip
  out.groundTraceDist = v[15] as number; // pm_groundTraceDist
  out.autoHop = v[16] as number; // pm_autoHop
  out.ladderScale = v[17] as number; // pm_ladderScale
  out.ladderFacing = v[18] as number; // pm_ladderFacing
  out.ladderReach = v[19] as number; // pm_ladderReach
  out.ladderJumpPush = v[20] as number; // pm_ladderJumpPush
  out.waterSinkSpeed = v[21] as number; // pm_waterSinkSpeed
  out.version = version;
  out.registry = reg;
  return true;
}
