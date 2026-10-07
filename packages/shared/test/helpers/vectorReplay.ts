import { devAssertsEnabled, setDevAsserts } from "../../src/debug/assert";
import { cosU16, dcos, dsin, sinU16 } from "../../src/math/dtrig";
import {
  degreesToU16,
  quantizeOrigin,
  quantizeStaminaHundredths,
  quantizeVelocity,
} from "../../src/math/quant";
import { vec3 } from "../../src/math/vec3";
import { hash32 } from "../../src/rng/hash32";
import { Mulberry32 } from "../../src/rng/mulberry32";
import { PmoveEvent, PmoveEvents } from "../../src/sim/events";
import { PlayerState, quantizePlayerState } from "../../src/sim/playerState";
import { PmoveTraceLog } from "../../src/sim/pmove/debug";
import { type PmoveParamField, PmoveParams } from "../../src/sim/pmove/params";
import { lastPmoveSnap, pmove } from "../../src/sim/pmove/pmove";
import { sanitizeUserCmd, UserCmd } from "../../src/sim/usercmd";
import {
  pointContents,
  snapOrigin,
  TraceResult,
  traceBox,
  traceBoxBrute,
} from "../../src/world/trace";
import {
  DEGREES_TO_U16_VECTORS,
  DTRIG_VECTORS,
  HASH32_VECTORS,
  MULBERRY32_DRAW_VECTORS,
  MULBERRY32_VECTORS,
  PLAYER_STATE_QUANT_VECTORS,
  QUANT_ORIGIN_VECTORS,
  QUANT_STAMINA_VECTORS,
  QUANT_VELOCITY_VECTORS,
  U16_TRIG_DIGEST_VECTORS,
  U16_TRIG_VECTORS,
  USERCMD_SANITIZE_VECTORS,
} from "../vectors/determinism";
import { PMOVE_PARAMS, PMOVE_VECTORS, PMOVE_WORLD } from "../vectors/pmove";
import { POINT_CONTENTS_VECTORS, SNAP_VECTORS, TRACE_VECTORS, TRACE_WORLD } from "../vectors/trace";
import { f64ToHex, hexToF64 } from "./f64";
import { worldFromRows } from "./vectorWorld";

/**
 * How every committed vector table (test/vectors/*.ts) is replayed: one recompute per row with the
 * real shared code, rendered back in the row's own format, so a row passes when it comes back
 * unchanged. The Vitest vector tests (Node and `pnpm test:browser`, D-022) and the phone vectors
 * page (packages/client/src/dev/vectorsPage.ts) both run these, so the page checks exactly what
 * the tests check. Plain ES2023 and relative imports only: it runs in any engine.
 */

export interface VectorTable {
  /** The table's export name, with the replay variant in parentheses for tables run twice. */
  readonly name: string;
  /** The test/vectors module that holds it. */
  readonly file: "determinism" | "trace" | "pmove";
  readonly rows: readonly string[];
  /** The row recomputed from its input fields: equal to `row` when the code still matches. */
  readonly recompute: (row: string) => string;
  /** Replays with DEV_ASSERT off: the production path the row pins. */
  readonly prodPath?: boolean;
}

export interface ReplayResult {
  readonly passed: number;
  readonly failed: number;
  /** Each failing row as "row → recomputed". */
  readonly mismatches: string[];
}

/** Replays every row of `table` (DEV_ASSERT restored afterwards). */
export function replayTable(table: VectorTable): ReplayResult {
  const asserts = devAssertsEnabled();
  if (table.prodPath === true) setDevAsserts(false);
  const mismatches: string[] = [];
  let passed = 0;
  try {
    for (const row of table.rows) {
      const again = table.recompute(row);
      if (again === row) passed++;
      else mismatches.push(`${row} → ${again}`);
    }
  } finally {
    setDevAsserts(asserts);
  }
  return { passed, failed: mismatches.length, mismatches };
}

const u32 = (hex: string | undefined) => Number.parseInt(hex ?? "", 16);
const f64 = (hex: string | undefined) => hexToF64(hex ?? "");
const int = (s: string | undefined) => Number(s ?? "");
const vecAt = (f: string[], i: number) => vec3(f64(f[i]), f64(f[i + 1]), f64(f[i + 2]));

// --- determinism (D-016) ---------------------------------------------------------------------

/** FNV-1a 32 over the U16_TRIG_VECTORS-format rows of angles first..last, each with a newline. */
function u16TrigDigest(first: number, last: number): string {
  let h = 0x811c9dc5;
  for (let a = first; a <= last; a++) {
    const row = `${a} ${f64ToHex(sinU16(a))} ${f64ToHex(cosU16(a))}\n`;
    for (let i = 0; i < row.length; i++) h = Math.imul(h ^ row.charCodeAt(i), 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

const quantPs = new PlayerState();
const sanitizeCmd = new UserCmd();

const DETERMINISM_TABLES: readonly VectorTable[] = [
  {
    name: "DTRIG_VECTORS",
    file: "determinism",
    rows: DTRIG_VECTORS,
    recompute: (row) => {
      const [x] = row.split(" ");
      const v = f64(x);
      return `${x} ${f64ToHex(dsin(v))} ${f64ToHex(dcos(v))}`;
    },
  },
  {
    name: "U16_TRIG_VECTORS",
    file: "determinism",
    rows: U16_TRIG_VECTORS,
    recompute: (row) => {
      const [a] = row.split(" ");
      const v = Number(a);
      return `${a} ${f64ToHex(sinU16(v))} ${f64ToHex(cosU16(v))}`;
    },
  },
  {
    name: "U16_TRIG_DIGEST_VECTORS",
    file: "determinism",
    rows: U16_TRIG_DIGEST_VECTORS,
    recompute: (row) => {
      const [first, last] = row.split(" ");
      return `${first} ${last} ${u16TrigDigest(Number(first), Number(last))}`;
    },
  },
  {
    name: "QUANT_ORIGIN_VECTORS",
    file: "determinism",
    rows: QUANT_ORIGIN_VECTORS,
    recompute: (row) => {
      const [x] = row.split(" ");
      return `${x} ${f64ToHex(quantizeOrigin(f64(x)))}`;
    },
  },
  {
    name: "QUANT_VELOCITY_VECTORS",
    file: "determinism",
    rows: QUANT_VELOCITY_VECTORS,
    recompute: (row) => {
      const [x] = row.split(" ");
      return `${x} ${f64ToHex(quantizeVelocity(f64(x)))}`;
    },
  },
  {
    name: "QUANT_STAMINA_VECTORS",
    file: "determinism",
    rows: QUANT_STAMINA_VECTORS,
    recompute: (row) => {
      const [x] = row.split(" ");
      return `${x} ${quantizeStaminaHundredths(f64(x))}`;
    },
  },
  {
    name: "DEGREES_TO_U16_VECTORS",
    file: "determinism",
    rows: DEGREES_TO_U16_VECTORS,
    recompute: (row) => {
      const [x] = row.split(" ");
      return `${x} ${degreesToU16(f64(x))}`;
    },
  },
  {
    name: "MULBERRY32_VECTORS",
    file: "determinism",
    rows: MULBERRY32_VECTORS,
    recompute: (row) => {
      const [seed, index] = row.split(" ");
      const rng = new Mulberry32(u32(seed));
      for (let i = 0; i < Number(index); i++) rng.nextU32();
      return `${seed} ${index} ${rng.nextU32().toString(16).padStart(8, "0")}`;
    },
  },
  {
    name: "MULBERRY32_DRAW_VECTORS",
    file: "determinism",
    rows: MULBERRY32_DRAW_VECTORS,
    recompute: (row) => {
      const [seed, index] = row.split(" ");
      const rng = new Mulberry32(u32(seed));
      for (let i = 0; i < 5 * Number(index); i++) rng.nextU32();
      const x = f64ToHex(rng.nextFloat());
      const ints = [rng.nextInt(3), rng.nextInt(6), rng.nextInt(100), rng.nextInt(0x200000)];
      return `${seed} ${index} ${x} ${ints.join(" ")}`;
    },
  },
  {
    name: "HASH32_VECTORS",
    file: "determinism",
    rows: HASH32_VECTORS,
    recompute: (row) => {
      const f = row.split(" ");
      const h = hash32(u32(f[0]), u32(f[1]), u32(f[2]), u32(f[3]), u32(f[4]));
      return `${f.slice(0, 5).join(" ")} ${h.toString(16).padStart(8, "0")}`;
    },
  },
  {
    name: "PLAYER_STATE_QUANT_VECTORS",
    file: "determinism",
    rows: PLAYER_STATE_QUANT_VECTORS,
    prodPath: true,
    recompute: (row) => {
      const f = row.split(" ");
      const ps = quantPs;
      const x = (i: number) => f64(f[i]);
      ps.origin.set([x(0), x(1), x(2)]);
      ps.velocity.set([x(3), x(4), x(5)]);
      ps.viewYaw = x(6);
      ps.viewPitch = x(7);
      ps.flags = x(8);
      ps.groundEntity = x(9);
      ps.waterLevel = x(10);
      ps.stamina = x(11);
      quantizePlayerState(ps);
      const vectors = [...ps.origin, ...ps.velocity].map(f64ToHex);
      const ints = [ps.viewYaw, ps.viewPitch, ps.flags, ps.groundEntity, ps.waterLevel, ps.stamina];
      return [...f.slice(0, 12), ...vectors, ...ints].join(" ");
    },
  },
  {
    name: "USERCMD_SANITIZE_VECTORS",
    file: "determinism",
    rows: USERCMD_SANITIZE_VECTORS,
    recompute: (row) => {
      const f = row.split(" ");
      const cmd = sanitizeCmd;
      const x = (i: number) => f64(f[i]);
      cmd.tick = x(0);
      cmd.buttons = x(1);
      cmd.forward = x(2);
      cmd.right = x(3);
      cmd.up = x(4);
      cmd.yaw = x(5);
      cmd.pitch = x(6);
      cmd.weaponSlot = x(7);
      sanitizeUserCmd(cmd);
      const out = [cmd.tick, cmd.buttons, cmd.forward, cmd.right, cmd.up, cmd.yaw, cmd.pitch];
      return [...f.slice(0, 8), ...out, cmd.weaponSlot].join(" ");
    },
  },
];

// --- traces (D-017) --------------------------------------------------------------------------

/** TRACE_WORLD rebuilt from its frozen plane bits, not from the polygonizer. */
export const traceVectorWorld = worldFromRows(TRACE_WORLD);

const traceOut = new TraceResult();
const snapOut = vec3();

function traceRow(trace: typeof traceBox): (row: string) => string {
  return (row) => {
    const f = row.split(" ");
    const out = traceOut;
    trace(traceVectorWorld, vecAt(f, 0), vecAt(f, 3), vecAt(f, 6), vecAt(f, 9), u32(f[12]), out);
    const doubles = [out.fraction, ...out.endpos, ...out.normal, out.planeDist].map(f64ToHex);
    const ints = [out.plane, out.brush, out.contents, out.surfaceFlags, out.entity];
    const flags = [out.startSolid ? 1 : 0, out.allSolid ? 1 : 0];
    return [...f.slice(0, 13), ...doubles, ...ints, ...flags].join(" ");
  };
}

const TRACE_TABLES: readonly VectorTable[] = [
  {
    name: "TRACE_VECTORS (traceBox)",
    file: "trace",
    rows: TRACE_VECTORS,
    recompute: traceRow(traceBox),
  },
  {
    name: "TRACE_VECTORS (traceBoxBrute)",
    file: "trace",
    rows: TRACE_VECTORS,
    recompute: traceRow(traceBoxBrute),
  },
  {
    name: "SNAP_VECTORS",
    file: "trace",
    rows: SNAP_VECTORS,
    recompute: (row) => {
      const f = row.split(" ");
      const w = traceVectorWorld;
      const rule = snapOrigin(
        w,
        vecAt(f, 0),
        vecAt(f, 3),
        vecAt(f, 6),
        u32(f[9]),
        vecAt(f, 10),
        snapOut,
      );
      return [...f.slice(0, 13), rule, ...[...snapOut].map(f64ToHex)].join(" ");
    },
  },
  {
    name: "POINT_CONTENTS_VECTORS",
    file: "trace",
    rows: POINT_CONTENTS_VECTORS,
    recompute: (row) => {
      const f = row.split(" ");
      return `${f.slice(0, 3).join(" ")} ${pointContents(traceVectorWorld, vecAt(f, 0))}`;
    },
  },
];

// --- pmove (M2 increment 6) ------------------------------------------------------------------

/** PMOVE_WORLD rebuilt from its frozen plane bits. */
export const pmoveVectorWorld = worldFromRows(PMOVE_WORLD);

/** PMOVE_PARAMS rebuilt from their bits: set 0 is the defaults, set 1 a tuned set. */
export const pmoveVectorParams = PMOVE_PARAMS.map((row) => {
  const f = row.split(" ");
  const p = new PmoveParams();
  for (let i = 0; i < f.length; i += 2) p[f[i] as PmoveParamField] = f64(f[i + 1]);
  return p;
});

/** PMOVE_VECTORS row layout: set, dt, state (12), cmd (8), next state (12), snap, events. */
export const PMOVE_ROW = Object.freeze({
  STATE_IN: 2,
  CMD: 14,
  STATE_OUT: 22,
  SNAP: 34,
  EVENTS: 35,
});

/** Reads the 12 state fields of a PMOVE_VECTORS row from field `at` into `ps`. */
export function readPmoveState(f: string[], at: number, ps: PlayerState): PlayerState {
  for (let k = 0; k < 3; k++) {
    ps.origin[k] = f64(f[at + k]);
    ps.velocity[k] = f64(f[at + 3 + k]);
  }
  ps.viewYaw = int(f[at + 6]);
  ps.viewPitch = int(f[at + 7]);
  ps.flags = int(f[at + 8]);
  ps.groundEntity = int(f[at + 9]);
  ps.waterLevel = int(f[at + 10]);
  ps.stamina = int(f[at + 11]);
  return ps;
}

/** A state as the 12 fields of a PMOVE_VECTORS row. */
export function pmoveStateFields(ps: PlayerState): string[] {
  return [
    ...[...ps.origin, ...ps.velocity].map(f64ToHex),
    ...[ps.viewYaw, ps.viewPitch, ps.flags, ps.groundEntity, ps.waterLevel, ps.stamina].map(String),
  ];
}

function readPmoveCmd(f: string[], cmd: UserCmd): UserCmd {
  const at = PMOVE_ROW.CMD;
  cmd.tick = int(f[at]);
  cmd.buttons = int(f[at + 1]);
  cmd.forward = int(f[at + 2]);
  cmd.right = int(f[at + 3]);
  cmd.up = int(f[at + 4]);
  cmd.yaw = int(f[at + 5]);
  cmd.pitch = int(f[at + 6]);
  cmd.weaponSlot = int(f[at + 7]);
  return cmd;
}

const pmovePs = new PlayerState();
const pmoveCmd = new UserCmd();
const pmoveEvents = new PmoveEvents();
const pmoveEvent = new PmoveEvent();
const pmoveLog = new PmoveTraceLog();

/**
 * Replays one PMOVE_VECTORS row from its input fields and renders it again, as the generator did.
 * With `events` off the row's own events are kept, so only the state and snap are compared; the
 * trace log is an observer, so turning it on must change nothing.
 */
export function replayPmoveRow(row: string, events: boolean, traceLog: boolean): string {
  const f = row.split(" ");
  const p = pmoveVectorParams[int(f[0])] as PmoveParams;
  const ps = readPmoveState(f, PMOVE_ROW.STATE_IN, pmovePs);
  const cmd = readPmoveCmd(f, pmoveCmd);
  const ev = pmoveEvents;
  ev.clear();
  pmoveLog.clear();
  pmove(ps, cmd, pmoveVectorWorld, p, f64(f[1]), events ? ev : null, traceLog ? pmoveLog : null);
  const out = [
    ...f.slice(0, PMOVE_ROW.STATE_OUT),
    ...pmoveStateFields(ps),
    String(lastPmoveSnap()),
  ];
  if (!events) return [...out, ...f.slice(PMOVE_ROW.EVENTS)].join(" ");
  out.push(String(ev.count));
  for (let k = 0; k < ev.count; k++) {
    ev.read(k, pmoveEvent);
    out.push(String(pmoveEvent.type), f64ToHex(pmoveEvent.value));
  }
  return out.join(" ");
}

const PMOVE_TABLES: readonly VectorTable[] = [
  {
    name: "PMOVE_VECTORS (events)",
    file: "pmove",
    rows: PMOVE_VECTORS,
    recompute: (row) => replayPmoveRow(row, true, false),
  },
  {
    name: "PMOVE_VECTORS (trace log on, events off)",
    file: "pmove",
    rows: PMOVE_VECTORS,
    recompute: (row) => replayPmoveRow(row, false, true),
  },
];

/** Every replayed table, in file order. */
export const VECTOR_TABLES: readonly VectorTable[] = [
  ...DETERMINISM_TABLES,
  ...TRACE_TABLES,
  ...PMOVE_TABLES,
];

/** The table called `name`; throws for an unknown one (a test's typo must not pass). */
export function vectorTable(name: string): VectorTable {
  const t = VECTOR_TABLES.find((table) => table.name === name);
  if (t === undefined) throw new Error(`no vector table ${name}`);
  return t;
}

/**
 * The world and parameter rows the tables replay against rather than check (their export names):
 * the vectors-page coverage test counts them as covered.
 */
export const VECTOR_INPUT_TABLES = ["TRACE_WORLD", "PMOVE_WORLD", "PMOVE_PARAMS"] as const;
