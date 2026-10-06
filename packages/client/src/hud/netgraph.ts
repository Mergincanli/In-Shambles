import { type Vec3, vec3 } from "@game/shared";
import {
  type ClientSim,
  STAT_BYTES_IN,
  STAT_BYTES_OUT,
  STAT_CLOCK_ADJUSTMENTS,
  STAT_CORRECTION_DIST,
  STAT_CORRECTION_MAX,
  STAT_CORRECTIONS,
  STAT_COUNT,
  STAT_HARD_RESYNCS,
  STAT_PARAM_RESYNCS,
  STAT_SNAPSHOTS,
  STAT_SNAPSHOTS_LOST,
  STAT_STARVED,
} from "../net";

/**
 * The netgraph (M2 design §2 "HUD", `cl_netgraph`): the link (RTT, jitter, download loss,
 * snapshots per second), corrections (per second, mean and largest size, the render offset
 * left), the input buffer (health, starved cmds per second, clock adjustments) and traffic (bytes
 * in and out per second). Rates are over the last second (NetStats' rolling window). The readout
 * is DOM-free; the lines are text for the HUD's ≤ 15 Hz update.
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
export const NG_BYTES_IN = 11;
export const NG_BYTES_OUT = 12;
/** Since connecting: hard resyncs and pending-parameter resyncs. */
export const NG_HARD_RESYNCS = 13;
export const NG_PARAM_RESYNCS = 14;
export const NG_COUNT = 15;

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
    const corrections = s[STAT_CORRECTIONS] as number;
    v[NG_CORRECTIONS] = corrections;
    v[NG_CORRECTION_MEAN] = corrections > 0 ? (s[STAT_CORRECTION_DIST] as number) / corrections : 0;
    v[NG_CORRECTION_MAX] = s[STAT_CORRECTION_MAX] as number;
    const o = this.offset;
    client.offset.sample(o);
    v[NG_OFFSET] = Math.hypot(o[0] as number, o[1] as number, o[2] as number);
    v[NG_BUFFER] = client.clock.bufferHealth;
    v[NG_STARVED] = s[STAT_STARVED] as number;
    v[NG_CLOCK_ADJUSTMENTS] = totals[STAT_CLOCK_ADJUSTMENTS] as number;
    v[NG_BYTES_IN] = s[STAT_BYTES_IN] as number;
    v[NG_BYTES_OUT] = s[STAT_BYTES_OUT] as number;
    v[NG_HARD_RESYNCS] = totals[STAT_HARD_RESYNCS] as number;
    v[NG_PARAM_RESYNCS] = totals[STAT_PARAM_RESYNCS] as number;
  }
}

function fixed(x: number, digits: number): string {
  return Number.isFinite(x) ? x.toFixed(digits) : "-";
}

function kb(bytes: number): string {
  return `${fixed(bytes / 1000, 1)} kB/s`;
}

/** The netgraph's lines; `profile` names the simulated link, if any. */
export function netgraphLines(v: Float64Array, profile: string | null): string[] {
  const at = (i: number) => v[i] as number;
  return [
    `link   rtt ${fixed(at(NG_RTT), 0)} ms  jitter ${fixed(at(NG_JITTER), 1)} ms  ` +
      `loss ${fixed(at(NG_LOSS), 1)}%  snaps ${fixed(at(NG_SNAPSHOTS), 0)}/s`,
    `corr   ${fixed(at(NG_CORRECTIONS), 0)}/s  mean ${fixed(at(NG_CORRECTION_MEAN), 2)} u  ` +
      `max ${fixed(at(NG_CORRECTION_MAX), 2)} u  offset ${fixed(at(NG_OFFSET), 2)} u`,
    `input  buffer ${fixed(at(NG_BUFFER), 1)} ticks  starved ${fixed(at(NG_STARVED), 0)}/s  ` +
      `clock adj ${fixed(at(NG_CLOCK_ADJUSTMENTS), 0)}`,
    `bytes  in ${kb(at(NG_BYTES_IN))}  out ${kb(at(NG_BYTES_OUT))}`,
    `resync hard ${fixed(at(NG_HARD_RESYNCS), 0)}  params ${fixed(at(NG_PARAM_RESYNCS), 0)}` +
      (profile === null ? "" : `  net ${profile}`),
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
