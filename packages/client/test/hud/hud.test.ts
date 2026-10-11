import { PlayerState, PMF_GROUNDED, PMF_ON_LADDER } from "@game/shared";
import { describe, expect, it } from "vitest";
import * as ng from "../../src/hud/netgraph";
import { NetgraphReadout, netgraphLines } from "../../src/hud/netgraph";
import { renderStatsText } from "../../src/hud/renderStats";
import { moveState, speedometerText } from "../../src/hud/speedometer";
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
  SV_COUNT,
  SV_PLAYERS,
  SV_REPORTS,
  SV_TICK_MAX_US,
  SV_TICK_P50_US,
  SV_TICK_P99_US,
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
  it("prints the seven lines: link, snapshots, remote, corrections, input, traffic, server", () => {
    const v = new Float64Array(ng.NG_COUNT);
    v[ng.NG_RTT] = 151.6;
    v[ng.NG_LOSS] = 2;
    v[ng.NG_SNAPSHOTS] = 59;
    v[ng.NG_SNAP_MEAN] = 262.4;
    v[ng.NG_SNAP_MAX] = 463;
    v[ng.NG_FULL] = 1;
    v[ng.NG_ENTITIES] = 16;
    v[ng.NG_DEFERRED] = 0.5;
    v[ng.NG_CORRECTION_MEAN] = 0.5;
    v[ng.NG_TELEPORTS] = 1;
    v[ng.NG_HARD_RESYNCS] = 2;
    v[ng.NG_BUFFER] = 4.04;
    v[ng.NG_BUFFER_LOW] = 1;
    v[ng.NG_DILATION] = 1.25;
    v[ng.NG_INTERP_DELAY] = 3;
    v[ng.NG_DEFER_LAG] = 1;
    v[ng.NG_EXTRAPOLATED] = 1.25;
    v[ng.NG_BYTES_IN] = 16_200;
    v[ng.NG_BYTES_OUT] = 3700;
    v[ng.NG_SERVER_P50] = 0.042;
    v[ng.NG_SERVER_P99] = 0.115;
    v[ng.NG_SERVER_MAX] = 1.5;
    v[ng.NG_SERVER_PLAYERS] = 17;
    const lines = netgraphLines(v, "wan-150-loss2");
    expect(lines).toEqual([
      "link   rtt 152 ms  jitter 0.0 ms  loss 2.0%  snaps 59/s  net wan-150-loss2",
      "snaps  mean 262 B  max 463 B  full 1/s  base drops 0/s  ents 16  deferred 0.50/snap",
      "remote interp 3 ticks (50 ms)  defer lag 1  extrap 1.3%  held 0.0%",
      "corr   0/s  mean 0.50 u  max 0.00 u  offset 0.00 u  teleports 1  resync 2/0",
      "input  buffer 4.0 low 1 ticks  starved 0/s  dilation +1.3%  clock steps 0",
      "bytes  in 16.2 kB/s  out 3.7 kB/s",
      "server tick p50 0.04 p99 0.12 max 1.50 ms  players 17",
    ]);
    v[ng.NG_RTT] = Number.NaN;
    v[ng.NG_DILATION] = -3;
    v[ng.NG_SERVER_MAX] = Number.NaN;
    const off = netgraphLines(v, null);
    expect(off[0]).toMatch(/^link {3}rtt - ms.*snaps 59\/s$/);
    expect(off[4]).toContain("dilation -3.0%");
    // Until the first SERVER_STATS arrives.
    expect(off[6]).toBe("server -");
  });
});

describe("netgraph readout", () => {
  function stub(second: Float64Array, totals: Float64Array, server: Int32Array, present: number) {
    const frame = { presentCount: present };
    return {
      stats: { totals, lastSecond: (out: Float64Array) => out.set(second) },
      clock: { rttMs: 101, jitterMs: 4.5, bufferHealth: 2.25, bufferLow: 1 },
      remotes: {
        delayTicks: 4,
        delay: { t: Object.assign(new Float64Array(8), { [ID_DEFER_LAG]: 1 }) },
      },
      store: { lastStored: present < 0 ? null : frame },
      roster: { server },
      offset: {
        sample: (out: Float64Array) => {
          out[0] = 3;
          out[1] = 0;
          out[2] = 4;
        },
      },
    } as unknown as ClientSim;
  }

  it("maps the last second's stats, the totals, the clock, the roster and the offset to its figures", () => {
    const second = new Float64Array(STAT_COUNT);
    second[STAT_SNAPSHOTS] = 98;
    second[STAT_SNAPSHOTS_LOST] = 2;
    second[STAT_SNAPSHOT_BYTES] = 98 * 250;
    second[STAT_SNAPSHOT_BYTES_MAX] = 436;
    second[STAT_FULL_SNAPSHOTS] = 1;
    second[STAT_BASELINE_DROPS] = 3;
    second[STAT_DEFERRED] = 49;
    second[STAT_CORRECTIONS] = 4;
    second[STAT_CORRECTION_DIST] = 2;
    second[STAT_CORRECTION_MAX] = 1.25;
    second[STAT_STARVED] = 3;
    second[STAT_DILATION] = 0.9;
    second[STAT_BYTES_IN] = 5000;
    second[STAT_FRAMING_IN] = 200;
    second[STAT_BYTES_OUT] = 700;
    second[STAT_FRAMING_OUT] = 60;
    second[STAT_REMOTE_FRAMES] = 400;
    second[STAT_REMOTE_EXTRAPOLATED] = 6;
    second[STAT_REMOTE_HELD] = 2;
    // Totals differ from the last second, so a figure read from the wrong one shows.
    const totals = new Float64Array(STAT_COUNT).fill(1000);
    totals[STAT_CLOCK_ADJUSTMENTS] = 7;
    totals[STAT_HARD_RESYNCS] = 5;
    totals[STAT_PARAM_RESYNCS] = 6;
    totals[STAT_TELEPORTS] = 2;
    const server = new Int32Array(SV_COUNT);
    server[SV_TICK_P50_US] = 40;
    server[SV_TICK_P99_US] = 120;
    server[SV_TICK_MAX_US] = 2500;
    server[SV_PLAYERS] = 17;
    server[SV_REPORTS] = 3;
    const r = new NetgraphReadout();
    r.read(stub(second, totals, server, 17));
    const v = r.values;
    const want: [number, number][] = [
      [ng.NG_RTT, 101],
      [ng.NG_JITTER, 4.5],
      [ng.NG_LOSS, 2],
      [ng.NG_SNAPSHOTS, 98],
      [ng.NG_CORRECTIONS, 4],
      [ng.NG_CORRECTION_MEAN, 0.5],
      [ng.NG_CORRECTION_MAX, 1.25],
      [ng.NG_OFFSET, 5],
      [ng.NG_BUFFER, 2.25],
      [ng.NG_STARVED, 3],
      [ng.NG_CLOCK_ADJUSTMENTS, 7],
      [ng.NG_BYTES_IN, 5200],
      [ng.NG_BYTES_OUT, 760],
      [ng.NG_HARD_RESYNCS, 5],
      [ng.NG_PARAM_RESYNCS, 6],
      [ng.NG_BUFFER_LOW, 1],
      [ng.NG_INTERP_DELAY, 4],
      [ng.NG_EXTRAPOLATED, 1.5],
      [ng.NG_HELD, 0.5],
      [ng.NG_SNAP_MEAN, 250],
      [ng.NG_SNAP_MAX, 436],
      [ng.NG_FULL, 1],
      [ng.NG_BASELINE_DROPS, 3],
      [ng.NG_ENTITIES, 16],
      [ng.NG_DEFERRED, 0.5],
      [ng.NG_DEFER_LAG, 1],
      [ng.NG_TELEPORTS, 2],
      [ng.NG_DILATION, 1.5],
      [ng.NG_SERVER_P50, 0.04],
      [ng.NG_SERVER_P99, 0.12],
      [ng.NG_SERVER_MAX, 2.5],
      [ng.NG_SERVER_PLAYERS, 17],
    ];
    expect(want).toHaveLength(ng.NG_COUNT);
    for (const [i, x] of want) expect([i, v[i]]).toEqual([i, x]);
    // No snapshots due, no corrections, no stats yet, no snapshot stored: zeros and NaN, as shown.
    second.fill(0);
    server.fill(0);
    r.read(stub(second, totals, server, -1));
    expect([
      v[ng.NG_LOSS],
      v[ng.NG_CORRECTION_MEAN],
      v[ng.NG_EXTRAPOLATED],
      v[ng.NG_HELD],
      v[ng.NG_SNAP_MEAN],
      v[ng.NG_DEFERRED],
      v[ng.NG_ENTITIES],
    ]).toEqual([0, 0, 0, 0, 0, 0, 0]);
    expect(v[ng.NG_SERVER_MAX]).toBeNaN();
    expect(netgraphLines(v, null)[6]).toBe("server -");
  });
});
