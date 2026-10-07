import { PlayerState, PMF_GROUNDED, PMF_ON_LADDER } from "@game/shared";
import { describe, expect, it } from "vitest";
import {
  NetgraphReadout,
  NG_BUFFER,
  NG_BUFFER_LOW,
  NG_BYTES_IN,
  NG_BYTES_OUT,
  NG_CLOCK_ADJUSTMENTS,
  NG_CORRECTION_MAX,
  NG_CORRECTION_MEAN,
  NG_CORRECTIONS,
  NG_COUNT,
  NG_HARD_RESYNCS,
  NG_JITTER,
  NG_LOSS,
  NG_OFFSET,
  NG_PARAM_RESYNCS,
  NG_RTT,
  NG_SNAPSHOTS,
  NG_STARVED,
  netgraphLines,
} from "../../src/hud/netgraph";
import { renderStatsText } from "../../src/hud/renderStats";
import { moveState, speedometerText } from "../../src/hud/speedometer";
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
} from "../../src/net";

describe("speedometer", () => {
  it("shows horizontal speed, vertical velocity and the movement mode", () => {
    const ps = new PlayerState();
    ps.velocity.set([192, 256, -270.4]);
    expect(speedometerText(ps)).toBe("320 u/s  vz -270  air");
    ps.flags = PMF_GROUNDED;
    ps.velocity.set([0, 0, -0.2]);
    expect(speedometerText(ps)).toBe("0 u/s  vz 0  ground");
    ps.waterLevel = 2;
    expect(moveState(ps)).toBe("water");
    ps.flags |= PMF_ON_LADDER;
    expect(moveState(ps)).toBe("ladder");
  });
});

describe("renderer panel", () => {
  it("shows the last frame's draw calls and triangles and the live geometries and textures", () => {
    const s = { drawCalls: 12, frameTriangles: 3400, geometries: 9, textures: 4 };
    expect(renderStatsText(s)).toBe("render calls 12  tris 3400  geo 9  tex 4");
  });
});

describe("netgraph", () => {
  it("prints the link, correction, input, traffic and resync lines", () => {
    const v = new Float64Array(NG_COUNT);
    v[NG_RTT] = 151.6;
    v[NG_LOSS] = 2;
    v[NG_CORRECTION_MEAN] = 0.5;
    v[NG_BUFFER] = 4.04;
    v[NG_BUFFER_LOW] = 1;
    const lines = netgraphLines(v, "wan-150-loss2");
    expect(lines).toHaveLength(5);
    expect(lines[0]).toBe("link   rtt 152 ms  jitter 0.0 ms  loss 2.0%  snaps 0/s");
    expect(lines[1]).toBe("corr   0/s  mean 0.50 u  max 0.00 u  offset 0.00 u");
    expect(lines[2]).toBe("input  buffer 4.0 low 1 ticks  starved 0/s  clock adj 0");
    expect(lines[3]).toBe("bytes  in 0.0 kB/s  out 0.0 kB/s");
    expect(lines[4]).toBe("resync hard 0  params 0  net wan-150-loss2");
    v[NG_RTT] = Number.NaN;
    expect(netgraphLines(v, null)[0]).toMatch(/^link {3}rtt - ms/);
    expect(netgraphLines(v, null)[4]).toBe("resync hard 0  params 0");
  });
});

describe("netgraph readout", () => {
  it("maps the last second's stats, the totals, the clock and the offset to its figures", () => {
    const second = new Float64Array(STAT_COUNT);
    second[STAT_SNAPSHOTS] = 98;
    second[STAT_SNAPSHOTS_LOST] = 2;
    second[STAT_CORRECTIONS] = 4;
    second[STAT_CORRECTION_DIST] = 2;
    second[STAT_CORRECTION_MAX] = 1.25;
    second[STAT_STARVED] = 3;
    second[STAT_BYTES_IN] = 5000;
    second[STAT_BYTES_OUT] = 700;
    // Totals differ from the last second, so a figure read from the wrong one shows.
    const totals = new Float64Array(STAT_COUNT).fill(1000);
    totals[STAT_CLOCK_ADJUSTMENTS] = 7;
    totals[STAT_HARD_RESYNCS] = 5;
    totals[STAT_PARAM_RESYNCS] = 6;
    const stub = {
      stats: { totals, lastSecond: (out: Float64Array) => out.set(second) },
      clock: { rttMs: 101, jitterMs: 4.5, bufferHealth: 2.25, bufferLow: 1 },
      offset: {
        sample: (out: Float64Array) => {
          out[0] = 3;
          out[1] = 0;
          out[2] = 4;
        },
      },
    };
    const r = new NetgraphReadout();
    r.read(stub as unknown as ClientSim);
    const v = r.values;
    const want: [number, number][] = [
      [NG_RTT, 101],
      [NG_JITTER, 4.5],
      [NG_LOSS, 2],
      [NG_SNAPSHOTS, 98],
      [NG_CORRECTIONS, 4],
      [NG_CORRECTION_MEAN, 0.5],
      [NG_CORRECTION_MAX, 1.25],
      [NG_OFFSET, 5],
      [NG_BUFFER, 2.25],
      [NG_STARVED, 3],
      [NG_CLOCK_ADJUSTMENTS, 7],
      [NG_BYTES_IN, 5000],
      [NG_BYTES_OUT, 700],
      [NG_HARD_RESYNCS, 5],
      [NG_PARAM_RESYNCS, 6],
      [NG_BUFFER_LOW, 1],
    ];
    expect(want).toHaveLength(NG_COUNT);
    for (const [i, x] of want) expect([i, v[i]]).toEqual([i, x]);
    // No snapshots due, no corrections: zeros, not NaN.
    second.fill(0);
    r.read(stub as unknown as ClientSim);
    expect([v[NG_LOSS], v[NG_CORRECTION_MEAN]]).toEqual([0, 0]);
  });
});
