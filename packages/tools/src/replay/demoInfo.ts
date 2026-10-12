import { resolve } from "node:path";
import { parseArgs } from "node:util";
import {
  type CvarBlockEntry,
  DemoHeader,
  decodeDemoHeader,
  demoMapHash,
  EVK_PLAYER_JOIN,
  FRAME_SLOTS,
  validateDemo,
} from "@game/shared";
import { readDemoFile } from "./validateDemo";

/** One player's stay in a demo: a run of ticks its slot was present. */
export interface DemoPlayerSeen {
  readonly id: number;
  /** Its team from the JOIN event that started the stay (null: no JOIN seen for it). */
  readonly team: number | null;
  readonly firstTick: number;
  readonly lastTick: number;
}

/** A CVARS record: its tick, the block's effective tick and each value that changed. */
export interface DemoCvarChange {
  readonly tick: number;
  readonly effectiveTick: number;
  readonly changes: readonly {
    readonly name: string;
    readonly from: string | number | boolean | null;
    readonly to: string | number | boolean | null;
  }[];
}

/** What `pnpm demo-info` prints (M3 design §2.12); `--json` prints this object. */
export interface DemoInfo {
  readonly header: {
    readonly demoVersion: number;
    readonly protocol: number;
    readonly tickRate: number;
    readonly map: string;
    readonly mapHash: string;
    readonly buildHash: string;
    readonly startTick: number;
  };
  /** From the start tick to the last snapshot's (0 without any). */
  readonly duration: { readonly ticks: number; readonly seconds: number };
  readonly records: {
    readonly snapshot: number;
    readonly events: number;
    readonly cvars: number;
    readonly end: number;
  };
  readonly keyframes: number;
  readonly snapshotBytes: { readonly mean: number; readonly max: number };
  readonly players: readonly DemoPlayerSeen[];
  readonly cvarChanges: readonly DemoCvarChange[];
  readonly bytes: number;
}

function round(x: number, digits: number): number {
  const k = 10 ** digits;
  return Math.round(x * k) / k;
}

/**
 * Reads a demo the way playback does (`validateDemo` with a visitor): the header, the counts, every
 * player's stays (from the snapshots' presence; the team from the JOIN that began each) and the
 * cvar changes against the block before. An invalid demo gives its reason.
 */
export function demoInfo(
  bytes: Uint8Array,
): { readonly ok: true; readonly info: DemoInfo } | { readonly ok: false; readonly error: string } {
  const players: DemoPlayerSeen[] = [];
  const cvarChanges: DemoCvarChange[] = [];
  /** Per slot: the open stay's first and last tick (0: none), and the team its JOIN named. */
  const first = new Int32Array(FRAME_SLOTS);
  const last = new Int32Array(FRAME_SLOTS);
  const joined: (number | null)[] = new Array<number | null>(FRAME_SLOTS).fill(null);
  const stayTeam: (number | null)[] = new Array<number | null>(FRAME_SLOTS).fill(null);
  // Each CVARS is compared with the block before it, the first with the header's.
  const start = new DemoHeader();
  let block: readonly CvarBlockEntry[] =
    decodeDemoHeader(bytes, bytes.length, start) === null ? start.cvars.block.entries.slice() : [];
  const close = (s: number) => {
    const team = stayTeam[s] ?? null;
    players.push({ id: s, team, firstTick: first[s] as number, lastTick: last[s] as number });
    first[s] = 0;
  };
  const check = validateDemo(bytes, bytes.length, {
    snapshot: (tick, _h, f) => {
      for (let s = 0; s < FRAME_SLOTS; s++) {
        if (f.present[s] === 1) {
          if (first[s] === 0) {
            first[s] = tick;
            stayTeam[s] = joined[s] ?? null;
          }
          last[s] = tick;
        } else if (first[s] !== 0) {
          close(s);
        }
      }
    },
    events: (_tick, m) => {
      for (let i = 0; i < m.count; i++) {
        const e = m.events[i];
        if (e !== undefined && e.kind === EVK_PLAYER_JOIN) {
          joined[e.clientId] = e.team;
          // A JOIN on the tick its stay began (the usual case: the events follow the snapshot).
          if (first[e.clientId] !== 0 && first[e.clientId] === last[e.clientId]) {
            stayTeam[e.clientId] = e.team;
          }
        }
      }
    },
    cvars: (tick, m) => {
      const prev = new Map(block.map((e) => [e.name, e.value]));
      const changes: DemoCvarChange["changes"][number][] = [];
      for (const e of m.block.entries) {
        const from = prev.has(e.name) ? (prev.get(e.name) ?? null) : null;
        if (from !== e.value) changes.push({ name: e.name, from, to: e.value });
        prev.delete(e.name);
      }
      for (const [name, from] of prev) changes.push({ name, from, to: null });
      cvarChanges.push({ tick, effectiveTick: m.effectiveTick, changes });
      block = m.block.entries.slice();
    },
  });
  if (!check.ok) return check;
  const { header, summary } = check;
  for (let s = 0; s < FRAME_SLOTS; s++) if (first[s] !== 0) close(s);
  players.sort((a, b) => a.firstTick - b.firstTick || a.id - b.id);
  const ticks = summary.snapshots === 0 ? 0 : summary.lastTick - header.startTick + 1;
  return {
    ok: true,
    info: {
      header: {
        demoVersion: header.demoVersion,
        protocol: header.protocolVersion,
        tickRate: header.tickRate,
        map: header.mapName,
        mapHash: demoMapHash(header),
        buildHash: header.buildHash,
        startTick: header.startTick,
      },
      duration: { ticks, seconds: round(ticks / header.tickRate, 3) },
      records: {
        snapshot: summary.snapshots,
        events: summary.events,
        cvars: summary.cvars,
        end: 1,
      },
      keyframes: summary.keyframes,
      snapshotBytes: {
        mean: summary.snapshots === 0 ? 0 : round(summary.snapshotBytes / summary.snapshots, 1),
        max: summary.snapshotBytesMax,
      },
      players,
      cvarChanges,
      bytes: summary.bytes,
    },
  };
}

/** The text `pnpm demo-info` prints for `info` of `file`. */
export function formatDemoInfo(file: string, info: DemoInfo): string {
  const h = info.header;
  const lines = [
    `demo ${file}`,
    `format: demo version ${h.demoVersion}, protocol ${h.protocol}, ${h.tickRate} Hz`,
    `map: ${h.map} (${h.mapHash})`,
    `build: ${h.buildHash === "" ? "-" : h.buildHash}`,
    `start tick: ${h.startTick}`,
    `duration: ${info.duration.ticks} ticks (${info.duration.seconds.toFixed(2)} s)`,
    `records: ${info.records.snapshot} SNAPSHOT, ${info.records.events} EVENTS, ` +
      `${info.records.cvars} CVARS, ${info.records.end} END`,
    `keyframes: ${info.keyframes}`,
    `snapshot bytes: mean ${info.snapshotBytes.mean.toFixed(1)}, max ${info.snapshotBytes.max}`,
    `players seen: ${info.players.length}`,
  ];
  for (const p of info.players) {
    lines.push(
      `  #${p.id} team ${p.team === null ? "-" : p.team}, ticks ${p.firstTick}-${p.lastTick}`,
    );
  }
  lines.push(`cvar changes: ${info.cvarChanges.length}`);
  for (const c of info.cvarChanges) {
    const what =
      c.changes.length === 0
        ? "no value changed"
        : c.changes.map((x) => `${x.name} ${String(x.from)} -> ${String(x.to)}`).join(", ");
    lines.push(`  tick ${c.tick} (effective ${c.effectiveTick}): ${what}`);
  }
  lines.push(`size: ${info.bytes} B`);
  return lines.join("\n");
}

export interface DemoInfoIo {
  readonly out: (text: string) => void;
  readonly err: (text: string) => void;
  /** Where a relative path resolves: the directory `pnpm demo-info` was typed in. */
  readonly cwd: string;
}

/**
 * `pnpm demo-info <file> [--json]` (D-044): prints the demo's header, duration, records,
 * keyframes, snapshot sizes, players and cvar changes (one JSON object with `--json`); returns
 * the exit code: 0, or 1 with the reason for an invalid file or bad arguments.
 */
export function runDemoInfo(argv: readonly string[], io: DemoInfoIo): number {
  let parsed: { values: { json?: boolean; help?: boolean }; positionals: string[] };
  try {
    parsed = parseArgs({
      args: [...argv],
      options: { json: { type: "boolean" }, help: { type: "boolean", short: "h" } },
      allowPositionals: true,
    });
  } catch (e) {
    io.err(`demo-info: ${e instanceof Error ? e.message : e}`);
    return 1;
  }
  const file = parsed.positionals[0];
  if (parsed.values.help === true || file === undefined || parsed.positionals.length > 1) {
    (parsed.values.help === true ? io.out : io.err)("usage: pnpm demo-info <file.demo> [--json]");
    return parsed.values.help === true ? 0 : 1;
  }
  // Read only: demoInfo validates it once, with its visitor.
  const read = readDemoFile(resolve(io.cwd, file));
  if (!read.ok) {
    io.err(`demo-info: ${read.error}`);
    return 1;
  }
  const got = demoInfo(read.bytes);
  if (!got.ok) {
    io.err(`demo-info: ${file} is not a valid demo: ${got.error}`);
    return 1;
  }
  io.out(parsed.values.json === true ? JSON.stringify(got.info) : formatDemoInfo(file, got.info));
  return 0;
}
