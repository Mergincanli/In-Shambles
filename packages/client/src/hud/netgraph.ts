import { TICK_RATE, type Vec3, vec3 } from "@game/shared";
import {
  type ClientSim,
  ID_DEFER_LAG,
  STAT_BASELINE_DROPS,
  STAT_BYTES_IN,
  STAT_BYTES_OUT,
  STAT_CLOCK_ADJUSTMENTS,
  STAT_CORRECTION_DIST,
  STAT_CORRECTION_MAX,
  STAT_CORRECTIONS,
  STAT_COUNT,
  STAT_DEFERRED,
  STAT_DILATION,
  STAT_FRAMING_IN,
  STAT_FRAMING_OUT,
  STAT_FULL_SNAPSHOTS,
  STAT_HARD_RESYNCS,
  STAT_PARAM_RESYNCS,
  STAT_REMOTE_EXTRAPOLATED,
  STAT_REMOTE_FRAMES,
  STAT_REMOTE_HELD,
  STAT_SNAPSHOT_BYTES,
  STAT_SNAPSHOT_BYTES_MAX,
  STAT_SNAPSHOTS,
  STAT_SNAPSHOTS_LOST,
  STAT_STARVED,
  STAT_TELEPORTS,
  SV_PLAYERS,
  SV_REPORTS,
  SV_TICK_MAX_US,
  SV_TICK_P50_US,
  SV_TICK_P99_US,
  TICK_MS,
} from "../net";

/**
 * The netgraph (`cl_netgraph`; docs/05 §13, M3 design §2.9, D-043): seven lines.
 * 1. link: RTT, jitter, snapshot loss %, snapshots per second (and the simulated profile);
 * 2. snapshots: mean and largest size, full snapshots and baseline drops per second, the players
 *    in the newest one, players the server's byte-budget scheduler left out per snapshot (D-046);
 * 3. remote: the interpolation delay in ticks and ms, the defer lag, the share of remote-frames
 *    drawn extrapolated or held (D-037);
 * 4. corrections: per second, mean and largest size, the render offset left; teleports, and hard
 *    and pending-parameter resyncs since connecting;
 * 5. input: the buffer health's mean and low edge (what the clock steers, D-039), starved cmds
 *    per second, the clock's mean dilation, its coarse steps since connecting;
 * 6. traffic: bytes in and out per second, payload plus WebSocket framing on a dedicated server;
 * 7. server: its tick time p50/p99/max over its last second and the players of this match, from
 *    SERVER_STATS (EVENTS, D-043; "-" until the first arrives).
 * Rates are over the last second (NetStats' rolling window). The readout is DOM-free; the lines
 * are text for the HUD's ≤ 15 Hz update.
 */

export const NG_RTT = 0;
export const NG_JITTER = 1;
/** Snapshots lost over the last second, % of those due. */
export const NG_LOSS = 2;
export const NG_SNAPSHOTS = 3;
export const NG_CORRECTIONS = 4;
export const NG_CORRECTION_MEAN = 5;
export const NG_CORRECTION_MAX = 6;
/** The render offset still being smoothed away now, u. */
export const NG_OFFSET = 7;
export const NG_BUFFER = 8;
export const NG_STARVED = 9;
/** Since connecting. */
export const NG_CLOCK_ADJUSTMENTS = 10;
/** Bytes per second, payload plus the WebSocket framing (0 on the Worker's ports). */
export const NG_BYTES_IN = 11;
export const NG_BYTES_OUT = 12;
/** Since connecting: hard resyncs and pending-parameter resyncs. */
export const NG_HARD_RESYNCS = 13;
export const NG_PARAM_RESYNCS = 14;
/** The low edge of the input buffer health (its lowest over the last 1.5 s), ticks. */
export const NG_BUFFER_LOW = 15;
/** The remote interpolation delay, ticks (D-037). */
export const NG_INTERP_DELAY = 16;
/** Of the remote-frames drawn over the last second, % extrapolated and % held. */
export const NG_EXTRAPOLATED = 17;
export const NG_HELD = 18;
/** Snapshots stored over the last second: mean and largest size, B. */
export const NG_SNAP_MEAN = 19;
export const NG_SNAP_MAX = 20;
/** Full snapshots and baseline drops per second (D-038). */
export const NG_FULL = 21;
export const NG_BASELINE_DROPS = 22;
/** Other players in the newest snapshot. */
export const NG_ENTITIES = 23;
/** Players left out per snapshot over the last second (D-046). */
export const NG_DEFERRED = 24;
/** The interpolation delay's defer lag, ticks (D-046; 0 at 37 players or fewer). */
export const NG_DEFER_LAG = 25;
/** Since connecting: teleports of the local player (D-035). */
export const NG_TELEPORTS = 26;
/** The clock's mean dilation over the last second, % (D-039). */
export const NG_DILATION = 27;
/** The server's last SERVER_STATS: tick p50, p99 and max (ms) and players; NaN before one. */
export const NG_SERVER_P50 = 28;
export const NG_SERVER_P99 = 29;
export const NG_SERVER_MAX = 30;
export const NG_SERVER_PLAYERS = 31;
export const NG_COUNT = 32;

export class NetgraphReadout {
  readonly values = new Float64Array(NG_COUNT);
  private readonly second = new Float64Array(STAT_COUNT);
  private readonly offset: Vec3 = vec3();

  read(client: ClientSim): void {
    const v = this.values;
    const s = this.second;
    const totals = client.stats.totals;
    client.stats.lastSecond(s);
    v[NG_RTT] = client.clock.rttMs;
    v[NG_JITTER] = client.clock.jitterMs;
    const got = s[STAT_SNAPSHOTS] as number;
    const lost = s[STAT_SNAPSHOTS_LOST] as number;
    v[NG_LOSS] = got + lost > 0 ? (100 * lost) / (got + lost) : 0;
    v[NG_SNAPSHOTS] = got;
    v[NG_SNAP_MEAN] = got > 0 ? (s[STAT_SNAPSHOT_BYTES] as number) / got : 0;
    v[NG_SNAP_MAX] = s[STAT_SNAPSHOT_BYTES_MAX] as number;
    v[NG_FULL] = s[STAT_FULL_SNAPSHOTS] as number;
    v[NG_BASELINE_DROPS] = s[STAT_BASELINE_DROPS] as number;
    const newest = client.store.lastStored;
    v[NG_ENTITIES] = newest === null ? 0 : Math.max(0, newest.presentCount - 1);
    v[NG_DEFERRED] = got > 0 ? (s[STAT_DEFERRED] as number) / got : 0;
    const corrections = s[STAT_CORRECTIONS] as number;
    v[NG_CORRECTIONS] = corrections;
    v[NG_CORRECTION_MEAN] = corrections > 0 ? (s[STAT_CORRECTION_DIST] as number) / corrections : 0;
    v[NG_CORRECTION_MAX] = s[STAT_CORRECTION_MAX] as number;
    const o = this.offset;
    client.offset.sample(o);
    v[NG_OFFSET] = Math.hypot(o[0] as number, o[1] as number, o[2] as number);
    v[NG_TELEPORTS] = totals[STAT_TELEPORTS] as number;
    v[NG_BUFFER] = client.clock.bufferHealth;
    v[NG_BUFFER_LOW] = client.clock.bufferLow;
    v[NG_STARVED] = s[STAT_STARVED] as number;
    // Ticks dilation added over the last second, per tick of that second: the mean δ.
    v[NG_DILATION] = (100 * (s[STAT_DILATION] as number)) / TICK_RATE;
    v[NG_CLOCK_ADJUSTMENTS] = totals[STAT_CLOCK_ADJUSTMENTS] as number;
    v[NG_BYTES_IN] = (s[STAT_BYTES_IN] as number) + (s[STAT_FRAMING_IN] as number);
    v[NG_BYTES_OUT] = (s[STAT_BYTES_OUT] as number) + (s[STAT_FRAMING_OUT] as number);
    v[NG_HARD_RESYNCS] = totals[STAT_HARD_RESYNCS] as number;
    v[NG_PARAM_RESYNCS] = totals[STAT_PARAM_RESYNCS] as number;
    const remotes = client.remotes;
    v[NG_INTERP_DELAY] = remotes.delayTicks;
    v[NG_DEFER_LAG] = remotes.delay.t[ID_DEFER_LAG] as number;
    const drawn = s[STAT_REMOTE_FRAMES] as number;
    v[NG_EXTRAPOLATED] = drawn > 0 ? (100 * (s[STAT_REMOTE_EXTRAPOLATED] as number)) / drawn : 0;
    v[NG_HELD] = drawn > 0 ? (100 * (s[STAT_REMOTE_HELD] as number)) / drawn : 0;
    const sv = client.roster.server;
    const known = (sv[SV_REPORTS] as number) > 0;
    v[NG_SERVER_P50] = known ? (sv[SV_TICK_P50_US] as number) / 1000 : Number.NaN;
    v[NG_SERVER_P99] = known ? (sv[SV_TICK_P99_US] as number) / 1000 : Number.NaN;
    v[NG_SERVER_MAX] = known ? (sv[SV_TICK_MAX_US] as number) / 1000 : Number.NaN;
    v[NG_SERVER_PLAYERS] = known ? (sv[SV_PLAYERS] as number) : Number.NaN;
  }
}

function fixed(x: number, digits: number): string {
  return Number.isFinite(x) ? x.toFixed(digits) : "-";
}

function signed(x: number, digits: number): string {
  return Number.isFinite(x) && x >= 0 ? `+${x.toFixed(digits)}` : fixed(x, digits);
}

function kb(bytes: number): string {
  return `${fixed(bytes / 1000, 1)} kB/s`;
}

/** The netgraph's seven lines; `profile` names the simulated link, if any. */
export function netgraphLines(v: Float64Array, profile: string | null): string[] {
  const at = (i: number) => v[i] as number;
  return [
    `link   rtt ${fixed(at(NG_RTT), 0)} ms  jitter ${fixed(at(NG_JITTER), 1)} ms  ` +
      `loss ${fixed(at(NG_LOSS), 1)}%  snaps ${fixed(at(NG_SNAPSHOTS), 0)}/s` +
      (profile === null ? "" : `  net ${profile}`),
    `snaps  mean ${fixed(at(NG_SNAP_MEAN), 0)} B  max ${fixed(at(NG_SNAP_MAX), 0)} B  ` +
      `full ${fixed(at(NG_FULL), 0)}/s  base drops ${fixed(at(NG_BASELINE_DROPS), 0)}/s  ` +
      `ents ${fixed(at(NG_ENTITIES), 0)}  deferred ${fixed(at(NG_DEFERRED), 2)}/snap`,
    `remote interp ${fixed(at(NG_INTERP_DELAY), 0)} ticks (${fixed(at(NG_INTERP_DELAY) * TICK_MS, 0)} ms)  ` +
      `defer lag ${fixed(at(NG_DEFER_LAG), 0)}  ` +
      `extrap ${fixed(at(NG_EXTRAPOLATED), 1)}%  held ${fixed(at(NG_HELD), 1)}%`,
    `corr   ${fixed(at(NG_CORRECTIONS), 0)}/s  mean ${fixed(at(NG_CORRECTION_MEAN), 2)} u  ` +
      `max ${fixed(at(NG_CORRECTION_MAX), 2)} u  offset ${fixed(at(NG_OFFSET), 2)} u  ` +
      `teleports ${fixed(at(NG_TELEPORTS), 0)}  ` +
      `resync ${fixed(at(NG_HARD_RESYNCS), 0)}/${fixed(at(NG_PARAM_RESYNCS), 0)}`,
    `input  buffer ${fixed(at(NG_BUFFER), 1)} low ${fixed(at(NG_BUFFER_LOW), 0)} ticks  ` +
      `starved ${fixed(at(NG_STARVED), 0)}/s  dilation ${signed(at(NG_DILATION), 1)}%  ` +
      `clock steps ${fixed(at(NG_CLOCK_ADJUSTMENTS), 0)}`,
    `bytes  in ${kb(at(NG_BYTES_IN))}  out ${kb(at(NG_BYTES_OUT))}`,
    Number.isFinite(at(NG_SERVER_MAX))
      ? `server tick p50 ${fixed(at(NG_SERVER_P50), 2)} p99 ${fixed(at(NG_SERVER_P99), 2)} ` +
        `max ${fixed(at(NG_SERVER_MAX), 2)} ms  players ${fixed(at(NG_SERVER_PLAYERS), 0)}`
      : "server -",
  ];
}

export class Netgraph {
  readonly readout = new NetgraphReadout();
  private text = "";

  constructor(readonly el: HTMLElement) {}

  update(client: ClientSim, profile: string | null): void {
    this.readout.read(client);
    const text = netgraphLines(this.readout.values, profile).join("\n");
    if (text !== this.text) {
      this.text = text;
      this.el.textContent = text;
    }
  }
}
