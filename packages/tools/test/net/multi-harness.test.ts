import { MixedInput, NeutralInput, StrafeCircuit } from "@game/client/net";
import {
  BitWriter,
  createLoopbackPair,
  encodeHello,
  findNetProfile,
  HelloMsg,
  MSG_INPUT,
  MSG_SNAPSHOT,
  MSG_WELCOME,
  type NetProfile,
} from "@game/shared";
import { describe, expect, it } from "vitest";
import {
  clientSeed,
  FRAMES_144HZ,
  FRAMES_BROWSER_HITCHES,
  HARNESS_BUILD,
  type HarnessClient,
  MAX_HARNESS_CLIENTS,
  MultiHarness,
  SessionTap,
} from "./multiHarness";

// The multi-client harness (M3 design §5 "Harness"): its event loop, joins, leaves and rejoins,
// raw endpoints, per-session byte counts and the frame digests against the server's, then the
// 16-client baseline that later increments measure against: 16 clients on arena_greybox at
// wan-150-loss2, each predicting only itself, now over full v2 snapshots that list every player.

const profile = (name: string) => findNetProfile(name) as NetProfile;

/** Per-client counters that pin a run (a seed gives one run). */
function fingerprint(h: MultiHarness): string {
  return h.clients
    .map((c) => {
      const t = c.totals();
      return [
        c.session?.clientId,
        t.snapshots,
        t.corrections,
        t.starved,
        t.clockAdjustments,
        c.client.predictor.latestTick,
        c.tap.down.bytes,
        c.tap.up.bytes,
      ].join(",");
    })
    .join(" | ");
}

function helloBytes(build = HARNESS_BUILD): Uint8Array {
  const w = new BitWriter(64);
  const m = new HelloMsg();
  m.buildHash = build;
  encodeHello(w, m);
  return w.bytes.slice(0, w.byteLength);
}

/** A harness whose match loop is stopped: only the timers a test schedules do anything. */
function idleHarness(): MultiHarness {
  const h = new MultiHarness();
  h.loop.stop();
  return h;
}

describe("MultiHarness: event loop", () => {
  it("runs timers in time order, ties in the order they were scheduled", () => {
    const k = idleHarness();
    const due: [number, number][] = [];
    const ran: number[] = [];
    let x = 12345;
    for (let i = 0; i < 300; i++) {
      x = (x * 1103515245 + 12345) & 0x7fffffff;
      const at = 1000 + (x % 50);
      due.push([at, i]);
      k.at(at, () => ran.push(i));
    }
    k.run(999);
    expect(ran).toEqual([]);
    k.run(1000);
    expect(ran).toEqual([...due].sort((a, b) => a[0] - b[0] || a[1] - b[1]).map((d) => d[1]));
  });

  it("runs a timer scheduled for now after the ones already due then", () => {
    const k = idleHarness();
    const ran: string[] = [];
    k.at(10, () => {
      ran.push("a");
      k.at(10, () => ran.push("c"));
    });
    k.at(10, () => ran.push("b"));
    k.at(5, () => ran.push("first"));
    k.run(20);
    expect(ran).toEqual(["first", "a", "b", "c"]);
    expect(k.now).toBe(20);
  });

  it("runs a timer scheduled in the past now, never stepping the clock back", () => {
    const k = idleHarness();
    const seen: number[] = [];
    k.at(10, () => k.at(5, () => seen.push(k.now)));
    k.at(12, () => seen.push(k.now));
    k.run(20);
    k.at(3, () => seen.push(k.now));
    k.run(1);
    expect(seen).toEqual([10, 12, 20]);
    expect(k.now).toBe(21);
  });

  it("gives every client its own default seed, the first the harness seed", () => {
    expect(clientSeed(1, 0)).toBe(1);
    const seeds = Array.from({ length: MAX_HARNESS_CLIENTS }, (_, i) => clientSeed(7, i));
    expect(new Set(seeds).size).toBe(MAX_HARNESS_CLIENTS);
  });
});

describe("MultiHarness: clients", () => {
  it("plays several clients at once, each in its own session, all reconciled", () => {
    const h = new MultiHarness({ seed: 3 });
    const clients: HarnessClient[] = [];
    for (let i = 0; i < 4; i++) {
      clients.push(
        h.addClient({ input: new MixedInput(), profile: profile("wan-100-loss1"), record: true }),
      );
      h.run(50);
    }
    h.run(5000);
    expect(clients.map((c) => c.session?.clientId)).toEqual([0, 1, 2, 3]);
    for (const c of clients) {
      expect(c.client.active).toBe(true);
      expect(c.totals().snapshots).toBeGreaterThan(200);
      expect(c.server.size).toBeGreaterThan(200);
      expect(c.unreconciled()).toEqual([]);
      expect(c.session?.stats.strikes).toBe(0);
      // Every frame the client stored is the server's world frame of that tick, as it sees it.
      expect(c.digestsChecked).toBeGreaterThan(200);
      expect(c.digestMismatches).toEqual([]);
      expect(c.client.store.newest?.presentCount).toBe(4);
    }
  });

  it("draws each client's link and frames from its own seed", () => {
    // Two clients joining at once with the same input and link play the same packets and frames,
    // so only their seeds can tell their losses and frame gaps apart. Frames are compared on a
    // lossless link, where nothing else moves their recording's start.
    const pair = (link: NetProfile, seeds: [number, number] | null) => {
      const h = new MultiHarness({ seed: 4 });
      const cs = [0, 1].map((k) =>
        h.addClient({
          input: new NeutralInput(),
          profile: link,
          record: true,
          ...(seeds === null ? {} : { seed: seeds[k] }),
        }),
      );
      h.run(3000);
      return cs.map((c) => ({ link: c.sim?.stats(), frames: c.frames.time.slice(0, 200) }));
    };
    const same: [number, number] = [clientSeed(4, 0), clientSeed(4, 0)];
    const bad = profile("bad-250-loss5");
    const [a, b] = pair(bad, null);
    expect(a?.link?.lost).toBeGreaterThan(0);
    expect(a?.link).not.toEqual(b?.link);
    const [c, d] = pair(bad, same);
    expect(c).toEqual(d);
    expect(c).toEqual(a);
    const lan = profile("lan");
    const [e, f] = pair(lan, null);
    expect(e?.frames.length).toBe(200);
    expect(e?.frames).not.toEqual(f?.frames);
    const [g, k] = pair(lan, same);
    expect(g).toEqual(k);
  });

  it("gives one run per seed, and another for another seed", () => {
    const play = (seed: number) => {
      const h = new MultiHarness({ seed });
      for (let i = 0; i < 3; i++) {
        h.addClient({
          input: i === 0 ? new StrafeCircuit() : new MixedInput(),
          profile: profile("bad-250-loss5"),
          frameIntervalMs: i === 2 ? FRAMES_BROWSER_HITCHES : FRAMES_144HZ,
        });
        h.run(30);
      }
      h.run(4000);
      return fingerprint(h);
    };
    expect(play(5)).toBe(play(5));
    expect(play(6)).not.toBe(play(5));
  });

  it("counts each session's traffic by message type, as the server end sees it", () => {
    const h = new MultiHarness();
    const c = h.addClient({ input: new MixedInput() });
    h.run(3000);
    const s = c.session;
    expect(s).not.toBeNull();
    if (s === null) return;
    const down = c.tap.down;
    const up = c.tap.up;
    // Every snapshot the match sent: alone in the match, a full v2 one is 37 B (292 bits).
    expect(down.messagesByType[MSG_SNAPSHOT]).toBe(s.stats.snapshots);
    expect(down.bytesByType[MSG_SNAPSHOT]).toBe(37 * s.stats.snapshots);
    expect(down.maxByType[MSG_SNAPSHOT]).toBe(37);
    expect(down.messagesByType[MSG_WELCOME]).toBe(1);
    // The totals are the server end's own counters.
    const end = c.tap.inner.stats();
    expect(down.bytes).toBe(end.sentBytes);
    expect(down.messages).toBe(end.sent);
    expect(up.bytes).toBe(end.deliveredBytes);
    expect(up.messages).toBe(end.delivered);
    // About one INPUT a tick since the client joined.
    expect(up.messagesByType[MSG_INPUT]).toBeGreaterThan(150);
  });

  it("lets a client join late, leave, and a new one rejoin into the freed slot", () => {
    const h = new MultiHarness({ seed: 2 });
    const wan = profile("wan-100-loss1");
    const a = h.addClient({ input: new MixedInput(), profile: wan });
    const b = h.addClient({ input: new StrafeCircuit(), profile: wan, record: true });
    h.run(2000);
    const late = h.addClient({ input: new MixedInput(), profile: wan, record: true });
    expect(late.joinedAt).toBe(2000);
    // Its first frame comes one frame gap (144 Hz ± 1 ms) after it joined, not at once.
    h.run(1000 / 144 - 1.5);
    expect(late.client.frames).toBe(0);
    h.run(3);
    expect(late.client.frames).toBe(1);
    h.run(2000 - 1000 / 144 - 1.5);
    expect(late.session?.clientId).toBe(2);
    expect(late.client.active).toBe(true);
    expect(late.unreconciled()).toEqual([]);

    b.leave();
    const bId = b.session?.clientId;
    expect(bId).toBe(1);
    // The close crosses the link (50 ms one way), then the match drops the session.
    h.run(500);
    expect(h.match.session(1)).toBeUndefined();
    const framesAtLeave = b.client.frames;
    const recordedAtLeave = b.server.size;
    h.run(500);
    expect(b.client.frames).toBe(framesAtLeave);
    expect(b.server.size).toBe(recordedAtLeave);

    const back = h.addClient({ input: new StrafeCircuit(), profile: wan, record: true });
    h.run(3000);
    expect(back.session?.clientId).toBe(1);
    expect(back.session).not.toBe(b.session);
    expect(back.client.active).toBe(true);
    expect(back.unreconciled()).toEqual([]);
    expect(a.client.active).toBe(true);
    for (const c of [a, late, back]) expect(c.session?.stats.strikes).toBe(0);
    expect(h.active).toEqual([a, late, back]);
    // The old session's records stopped with it, though its slot now holds another player.
    expect(b.server.size).toBe(recordedAtLeave);
  });

  it("counts on the server end only what its transport took", () => {
    const [, serverEnd] = createLoopbackPair();
    const tap = new SessionTap(serverEnd);
    tap.sendUnreliable(new Uint8Array([MSG_SNAPSHOT, 1, 2]), 3);
    tap.close();
    tap.sendUnreliable(new Uint8Array([MSG_SNAPSHOT, 1, 2]), 3);
    tap.sendReliable(new Uint8Array([MSG_WELCOME, 1]), 2);
    expect(tap.down.messages).toBe(1);
    expect(tap.down.messages).toBe(serverEnd.stats().sent);
    expect(tap.down.bytes).toBe(3);
    expect(tap.down.messagesByType[MSG_WELCOME]).toBe(0);
  });

  it("drives raw endpoints: a valid HELLO gets a WELCOME, garbage gets strikes", () => {
    const h = new MultiHarness();
    const honest = h.addClient({ input: new NeutralInput() });
    const raw = h.addRaw();
    const junk = h.addRaw();
    raw.send(helloBytes(), true);
    junk.send(new Uint8Array([0xee, 1, 2, 3]), false);
    junk.send(new Uint8Array([MSG_SNAPSHOT, 0, 0]), false);
    h.run(1000);
    expect(raw.session?.clientId).toBe(1);
    expect(raw.ofType(MSG_WELCOME).length).toBe(1);
    expect(raw.received[0]?.reliable).toBe(true);
    expect(raw.tap.up.messages).toBe(1);
    expect(junk.received).toEqual([]);
    expect(junk.session?.stats.strikes).toBe(2);
    expect(honest.client.active).toBe(true);
    expect(honest.session?.stats.strikes).toBe(0);
  });

  it("holds the match's maxClients clients and raw endpoints together, as the match counts them", () => {
    expect(new MultiHarness().match.maxClients).toBe(32);
    const h = new MultiHarness({ maxClients: 20 });
    const raws = Array.from({ length: 19 }, () => h.addRaw());
    h.addClient({ input: new NeutralInput() });
    expect(() => h.addClient({ input: new NeutralInput() })).toThrow(/20 clients/);
    // Closed raw endpoints free their slots once the match has polled their close.
    for (const r of raws) r.transport.close();
    h.run(100);
    expect(h.match.sessionCount).toBe(1);
    expect(h.addClient({ input: new NeutralInput() }).session?.clientId).toBe(0);
  });

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

  it("stops the frames of a client the match KICKed", () => {
    const h = new MultiHarness();
    const ok = h.addClient({ input: new NeutralInput() });
    const kicked = h.addClient({ input: new NeutralInput() });
    h.run(500);
    const s = kicked.session;
    expect(s).not.toBeNull();
    if (s !== null) h.match.kick(s, "test");
    h.run(200);
    expect(kicked.client.closed).toBe(true);
    expect(kicked.left).toBe(false);
    expect(h.active).toEqual([ok]);
    const frames = kicked.client.frames;
    h.run(500);
    expect(kicked.client.frames).toBe(frames);
    expect(ok.client.active).toBe(true);
  });

  it("times every match tick on request", () => {
    const h = new MultiHarness({ timeTicks: true });
    h.addClient({ input: new MixedInput() });
    h.run(1000);
    expect(h.tickTimes?.count).toBe(h.match.serverTick);
    expect(h.match.serverTick).toBeGreaterThanOrEqual(59);
    expect(new MultiHarness().tickTimes).toBeNull();
  });
});

// The M3 starting point (M3 design §6 increment 3, "v1 16-client baseline"): 16 clients on
// arena_greybox, all spawning at its first info_player_start (spawn rotation is increment 5), on
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

describe("16 clients on arena_greybox over full v2 snapshots (the M3 baseline)", () => {
  it("predict without rubber-banding at wan-150-loss2, 436 B full snapshots, no strikes", () => {
    const h = new MultiHarness({ map: "arena_greybox", seed: 1, timeTicks: true });
    const link = profile("wan-150-loss2");
    for (let i = 0; i < BASELINE_CLIENTS; i++) {
      h.addClient({
        input:
          i % 4 === 1
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
      expect(top[i], `client ${i}`).toBeGreaterThan(i % 4 === 1 ? 400 : 300);
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
