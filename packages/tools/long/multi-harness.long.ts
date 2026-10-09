import { MixedInput, NeutralInput, StrafeCircuit } from "@game/client/net";
import { findNetProfile, MSG_SNAPSHOT, type NetProfile } from "@game/shared";
import { describe, expect, it } from "vitest";
import {
  FRAMES_144HZ,
  FRAMES_BROWSER_HITCHES,
  type HarnessClient,
  MAX_HARNESS_CLIENTS,
  MultiHarness,
} from "../test/net/multiHarness";

// The multi-client harness's long runs (M3 design §5 "Harness", §6 increment 3), the long tier's
// (D-032): a full 37-player match, and the 16-client baseline (30 s of 16 clients on one fake
// clock). The harness's own tests stay in `pnpm test`
// (`packages/tools/test/net/multi-harness.test.ts`).

const profile = (name: string) => findNetProfile(name) as NetProfile;

describe("MultiHarness: clients", () => {
  it("plays a full 37-player match (sv_maxClients 64, clamped until D-046), refuses a 38th, and refills a slot", () => {
    const h = new MultiHarness({ map: "arena_greybox", seed: 9, maxClients: MAX_HARNESS_CLIENTS });
    const full = h.match.maxClients;
    expect(full).toBe(37);
    const wan = profile("wan-100-loss1");
    for (let i = 0; i < full; i++) {
      h.addClient({
        input: i % 2 === 0 ? new MixedInput() : new StrafeCircuit(),
        profile: wan,
        record: i === 3,
      });
    }
    h.run(2000);
    expect(h.clients.map((c) => c.session?.clientId)).toEqual(
      Array.from({ length: full }, (_, i) => i),
    );
    expect(h.active.length).toBe(full);
    for (const c of h.clients) {
      expect(c.client.active).toBe(true);
      // 36 other players in every snapshot once all are in: 86 + 199 + 7 + 36 × 213 bits, 995 B.
      expect(c.tap.down.maxByType[MSG_SNAPSHOT]).toBe(995);
    }
    const watched = h.clients[3] as HarnessClient;
    expect(watched.client.store.newest?.presentCount).toBe(full);
    expect(watched.digestsChecked).toBeGreaterThan(50);
    expect(watched.digestMismatches).toEqual([]);
    expect(h.match.metrics.strikes).toBe(0);
    // The match KICKs a 38th connection itself; the harness refuses a 38th client.
    const extra = h.addRaw();
    h.run(100);
    expect(extra.session).toBeNull();
    expect(extra.closedReason).toBe("server full");
    expect(() => h.addClient({ input: new NeutralInput() })).toThrow(/37 clients/);

    // A left session holds its slot until its close crosses the link.
    const gone = h.clients[5] as HarnessClient;
    gone.leave();
    expect(h.active.length).toBe(full - 1);
    expect(() => h.addClient({ input: new NeutralInput() })).toThrow(/37 clients/);
    h.runUntil(() => h.match.session(5) === undefined, 1000, "slot 5 freed");
    const back = h.addClient({ input: new MixedInput(), profile: wan });
    h.run(1000);
    expect(back.session?.clientId).toBe(5);
    expect(back.client.active).toBe(true);
  });
});

// The M3 starting point (M3 design §6 increment 3, "v1 16-client baseline"): 16 clients on
// arena_greybox, client i spawning at its i-th info_player_start (the spawn rotation, increment 5), on
// wan-150-loss2 with their own NetSim seeds, joining 100 ms apart; client 0 is observed (every tick
// recorded) at 144 Hz, the others alternate 144 Hz and browser hitches. Prediction must hold as
// NET-04 asks of its 16-client leg (< 1 correction/s, mean < 2 u, the observed client's render
// offset < 8 u and every snapshot reconciled), with no strike. It prints the per-client bandwidth
// and the match tick's cost. Under protocol v1 every snapshot was 42 B (2.53 KB/s down, 3.26 up,
// match tick p50 130 µs, p99 400–570 µs; increment 3). Increment 4 made them full v2 snapshots
// that list the other 15 players (436 B, about 26 KB/s), checked against the server's frames;
// increment 9 (deltas) is compared with this.

const BASELINE_CLIENTS = 16;
const BASELINE_SECONDS = 30;
/**
 * A strafe-jump circuit aimed at a square in arena_greybox's south-west yard. At strafe speed
 * the bots overshoot its corners and range across the whole arena, which loads the match more.
 */
const SW_SQUARE = { centerX: -720, centerY: -560, halfSide: 260, maxSpeed: 450 } as const;
/**
 * The clients that run the circuit: those whose spawn point (the rotation gives client i the
 * i-th) lies in or near the south-west yard, so the way to the square is open floor.
 */
const ROUTE_CLIENTS: ReadonlySet<number> = new Set([4, 8, 10, 15]);

describe("16 clients on arena_greybox over full v2 snapshots (the M3 baseline)", () => {
  it("predict without rubber-banding at wan-150-loss2, 436 B full snapshots, no strikes", () => {
    const h = new MultiHarness({ map: "arena_greybox", seed: 1, timeTicks: true });
    const link = profile("wan-150-loss2");
    for (let i = 0; i < BASELINE_CLIENTS; i++) {
      h.addClient({
        input: ROUTE_CLIENTS.has(i)
          ? new StrafeCircuit({ idleTicks: 90 + 7 * i, ...SW_SQUARE })
          : new MixedInput(),
        profile: link,
        frameIntervalMs: i % 2 === 0 ? FRAMES_144HZ : FRAMES_BROWSER_HITCHES,
        record: i === 0,
      });
      h.run(100);
    }
    expect(h.clients.map((c) => c.joinedAt)).toEqual(
      Array.from({ length: BASELINE_CLIENTS }, (_, i) => i * 100),
    );
    // What the server simulated: each player's top horizontal speed and the x/y extent covered.
    const top = new Float64Array(BASELINE_CLIENTS);
    const box = Array.from({ length: BASELINE_CLIENTS }, () => [
      Infinity,
      -Infinity,
      Infinity,
      -Infinity,
    ]);
    h.afterServerTick = () => {
      for (let i = 0; i < h.clients.length; i++) {
        const p = (h.clients[i] as HarnessClient).session?.player;
        if (p === undefined) continue;
        const [x, y] = [p.origin[0] as number, p.origin[1] as number];
        const [vx, vy] = [p.velocity[0] as number, p.velocity[1] as number];
        top[i] = Math.max(top[i] as number, Math.hypot(vx, vy));
        const b = box[i] as number[];
        b[0] = Math.min(b[0] as number, x);
        b[1] = Math.max(b[1] as number, x);
        b[2] = Math.min(b[2] as number, y);
        b[3] = Math.max(b[3] as number, y);
      }
    };
    const t0 = h.now;
    const bytes0 = h.clients.map((c) => [c.tap.down.bytes, c.tap.up.bytes]);
    h.run(BASELINE_SECONDS * 1000);
    h.afterServerTick = null;
    const seconds = (h.now - t0) / 1000;

    const observed = h.clients[0] as HarnessClient;
    expect(observed.unreconciled()).toEqual([]);
    expect(observed.snapshotTicks.length).toBeGreaterThan(BASELINE_SECONDS * 60 * 0.5);
    expect(Math.max(...observed.frames.offset)).toBeLessThan(8);
    expect(observed.digestsChecked).toBeGreaterThan(BASELINE_SECONDS * 60 * 0.5);
    expect(observed.digestMismatches).toEqual([]);

    let worstRate = 0;
    let worstMean = 0;
    let down = 0;
    let up = 0;
    for (let i = 0; i < h.clients.length; i++) {
      const c = h.clients[i] as HarnessClient;
      const t = c.totals();
      expect(c.client.active, `client ${i}`).toBe(true);
      expect(c.session?.stats.strikes, `client ${i}`).toBe(0);
      expect(t.hardResyncs, `client ${i}`).toBeLessThanOrEqual(2);
      // The link really was wan-150-loss2: packets lost, an RTT of 150 ms plus jitter and ticks.
      expect(c.sim?.stats().lost, `client ${i}`).toBeGreaterThan(0);
      expect(c.client.clock.rttMs, `client ${i}`).toBeGreaterThanOrEqual(2 * link.delayMs);
      expect(c.client.clock.rttMs, `client ${i}`).toBeLessThan(2 * link.delayMs + 120);
      // And the player moved: at running speed or faster, over hundreds of units.
      const b = box[i] as number[];
      expect(top[i], `client ${i}`).toBeGreaterThan(ROUTE_CLIENTS.has(i) ? 400 : 300);
      expect(
        Math.max((b[1] as number) - (b[0] as number), (b[3] as number) - (b[2] as number)),
      ).toBeGreaterThan(500);
      worstRate = Math.max(worstRate, t.corrections / seconds);
      worstMean = Math.max(worstMean, t.meanCorrection);
      // 86 + 199 + 7 + 15 × 213 bits once all 16 are in.
      expect(c.tap.down.maxByType[MSG_SNAPSHOT]).toBe(436);
      const [d0, u0] = bytes0[i] as number[];
      down = Math.max(down, (c.tap.down.bytes - (d0 as number)) / seconds);
      up = Math.max(up, (c.tap.up.bytes - (u0 as number)) / seconds);
    }
    expect(worstRate).toBeLessThan(1);
    expect(worstMean).toBeLessThan(2);
    expect(h.match.metrics.strikes).toBe(0);

    const ticks = h.tickTimes;
    console.log(
      `M3 baseline (full v2 snapshots): ${BASELINE_CLIENTS} clients, arena_greybox, wan-150-loss2, ` +
        `${seconds.toFixed(0)} s: corrections worst ${worstRate.toFixed(2)}/s (mean ≤ ` +
        `${worstMean.toFixed(2)} u); per client down ≤ ${(down / 1000).toFixed(2)} KB/s, ` +
        `up ≤ ${(up / 1000).toFixed(2)} KB/s (payload, KB = 1000 B); 436 B snapshots; match tick ` +
        `p50 ${ticks?.percentileUs(50)} µs, p99 ${ticks?.percentileUs(99)} µs, ` +
        `max ${ticks?.maxUs} µs (in-process, Vitest)`,
    );
  });
});
