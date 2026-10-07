import { describe, expect, it } from "vitest";
import { DevAssertError, setDevAsserts } from "../../src/debug/assert";
import { NetSimTransport } from "../../src/net/netsim";
import {
  findNetProfile,
  NET_PROFILE_LAN,
  NET_PROFILES,
  type NetProfile,
} from "../../src/net/profiles";
import {
  createLoopbackPair,
  type LoopbackEndpoint,
  MAX_QUEUED_UNRELIABLE,
} from "../../src/net/transport";

const TICK_MS = 1000 / 60;

function named(name: string): NetProfile {
  const p = findNetProfile(name);
  if (!p) throw new Error(`no profile ${name}`);
  return p;
}

function custom(over: Partial<NetProfile>): NetProfile {
  return { ...NET_PROFILE_LAN, name: "custom", ...over };
}

interface Arrival {
  at: number;
  id: number;
  reliable: boolean;
}

/**
 * A NetSim-wrapped client end and the raw server end, on a fake millisecond clock. `step` advances
 * the clock and runs one pump of the simulator and one poll on each side; packets carry a u16 id.
 */
class Harness {
  now = 0;
  readonly sim: NetSimTransport;
  readonly server: LoopbackEndpoint;
  /** Packets the server received (sent by the client, through the simulator). */
  readonly up: Arrival[] = [];
  /** Packets the client received. */
  readonly down: Arrival[] = [];
  readonly wakes: number[] = [];
  private readonly buf = new Uint8Array(2);

  constructor(profile: NetProfile, seed: number, withWake = false) {
    const [client, server] = createLoopbackPair();
    this.server = server;
    this.sim = new NetSimTransport(
      client,
      profile,
      () => this.now,
      seed,
      withWake ? (at) => this.wakes.push(at) : undefined,
    );
    server.onMessage((d, _len, reliable) => this.up.push(this.arrival(d, reliable)));
    this.sim.onMessage((d, _len, reliable) => this.down.push(this.arrival(d, reliable)));
  }

  private arrival(d: Uint8Array, reliable: boolean): Arrival {
    return { at: this.now, id: (d[0] as number) | ((d[1] as number) << 8), reliable };
  }

  private packet(id: number): Uint8Array {
    this.buf[0] = id & 255;
    this.buf[1] = id >> 8;
    return this.buf;
  }

  sendUp(id: number, reliable = false): void {
    if (reliable) this.sim.sendReliable(this.packet(id), 2);
    else this.sim.sendUnreliable(this.packet(id), 2);
  }

  sendDown(id: number, reliable = false): void {
    if (reliable) this.server.sendReliable(this.packet(id), 2);
    else this.server.sendUnreliable(this.packet(id), 2);
  }

  /** Advances to `to` in steps of `dt` ms, polling both sides at each step. */
  runTo(to: number, dt = 0.25): void {
    while (this.now < to) {
      this.now = Math.min(to, this.now + dt);
      this.sim.poll();
      this.server.poll();
    }
  }
}

/** Arrivals whose id is below one seen earlier: they were overtaken. */
function lateArrivals(list: Arrival[]): number {
  let max = -1;
  let late = 0;
  for (const a of list) {
    if (a.id < max) late++;
    max = Math.max(max, a.id);
  }
  return late;
}

/** |count − n·p| within `sigmas` standard deviations of a binomial(n, p). */
function expectBinomial(count: number, n: number, p: number, sigmas = 5): void {
  const sd = Math.sqrt(n * p * (1 - p));
  expect(Math.abs(count - n * p)).toBeLessThanOrEqual(sigmas * sd);
}

describe("NET_PROFILES", () => {
  it("names the docs/10 §3 profiles, found by name", () => {
    expect(NET_PROFILES.map((p) => p.name)).toEqual([
      "lan",
      "wan-50",
      "wan-100-loss1",
      "wan-150-loss2",
      "bad-250-loss5",
    ]);
    for (const p of NET_PROFILES) expect(findNetProfile(p.name)).toBe(p);
    expect(findNetProfile("wan-999")).toBeUndefined();
    expect(Object.isFrozen(NET_PROFILES)).toBe(true);
    expect(Object.isFrozen(named("wan-50"))).toBe(true);
  });
});

describe("NetSimTransport", () => {
  it("lan passes packets through in the same step, both ways", () => {
    const h = new Harness(NET_PROFILE_LAN, 1);
    h.sendUp(1);
    h.sendUp(2, true);
    // The send forwards a due packet at once: the server has it before any simulator poll.
    h.server.poll();
    expect(h.up.map((a) => a.id)).toEqual([1, 2]);
    h.sendDown(3);
    h.sim.poll();
    expect(h.down).toEqual([{ at: 0, id: 3, reliable: false }]);
  });

  it("delays each direction by the one-way delay, within ±jitter", () => {
    for (const name of ["wan-50", "wan-100-loss1", "wan-150-loss2"]) {
      const p = { ...named(name), loss: 0, reorder: 0 };
      const h = new Harness(p, 7);
      const sentAt: number[] = [];
      for (let i = 0; i < 1500; i++) {
        h.runTo(i * TICK_MS);
        sentAt.push(h.now);
        h.sendUp(i);
        h.sendDown(i);
      }
      h.runTo(1500 * TICK_MS + 500);
      for (const list of [h.up, h.down]) {
        expect(list).toHaveLength(1500);
        let lo = Number.POSITIVE_INFINITY;
        let hi = Number.NEGATIVE_INFINITY;
        for (const a of list) {
          const delay = a.at - (sentAt[a.id] as number);
          lo = Math.min(lo, delay);
          hi = Math.max(hi, delay);
        }
        // Delivery happens at the first step at or after the due time (0.25 ms steps); a packet
        // the server sends reaches the simulator at its next poll, one step later.
        expect(lo).toBeGreaterThanOrEqual(p.delayMs - p.jitterMs);
        expect(hi).toBeLessThanOrEqual(p.delayMs + p.jitterMs + 0.5);
        // And the jitter is really used across its range.
        expect(lo).toBeLessThan(p.delayMs - 0.8 * p.jitterMs);
        expect(hi).toBeGreaterThan(p.delayMs + 0.8 * p.jitterMs);
      }
    }
  });

  it("keeps unreliable packets in order through jitter when the profile does not reorder", () => {
    // ±40 ms of jitter on a packet every millisecond: only the FIFO rule keeps them in order.
    const h = new Harness(custom({ delayMs: 125, jitterMs: 40, loss: 0.05, duplicate: 0.01 }), 3);
    for (let i = 0; i < 5000; i++) {
      h.runTo(i);
      h.sendUp(i);
      h.sendDown(i);
    }
    h.runTo(5400);
    for (const list of [h.up, h.down]) {
      expect(list.length).toBeGreaterThan(4000);
      expect(lateArrivals(list)).toBe(0);
    }
    expect(h.sim.stats().reordered).toBe(0);
  });

  it("loses, duplicates and reorders at the profile's rates (bad-250-loss5)", () => {
    const p = named("bad-250-loss5");
    const h = new Harness(p, 0xbad);
    const n = 20_000;
    for (let i = 0; i < n; i++) {
      h.runTo(i * TICK_MS, 1);
      h.sendUp(i & 0xffff);
    }
    h.runTo(n * TICK_MS + 1000, 1);
    const s = h.sim.stats();
    expect(s.sent).toBe(n);
    expectBinomial(s.lost, n, p.loss);
    // Duplication and reordering are drawn for the packets that survive.
    expectBinomial(s.duplicated, n - s.lost, p.duplicate);
    expectBinomial(s.reordered, n - s.lost, p.reorder);
    expect(h.up).toHaveLength(n - s.lost + s.duplicated);
    // Each id arrives once, or twice when duplicated.
    const copies = new Map<number, number>();
    for (const a of h.up) copies.set(a.id, (copies.get(a.id) ?? 0) + 1);
    let twice = 0;
    for (const c of copies.values()) if (c === 2) twice++;
    expect(copies.size).toBe(n - s.lost);
    expect(twice).toBe(s.duplicated);
    // A duplicate draws its own jitter, so the copies of a packet often arrive apart.
    const firstAt = new Map<number, number>();
    let apart = 0;
    for (const a of h.up) {
      const at = firstAt.get(a.id);
      if (at === undefined) firstAt.set(a.id, a.at);
      else if (a.at !== at) apart++;
    }
    expect(apart).toBeGreaterThan(0.25 * s.duplicated);
    // A held packet is overtaken by the next one unless that one is lost or held too.
    const late = lateArrivals(h.up);
    expect(late).toBeLessThanOrEqual(s.reordered);
    expect(late).toBeGreaterThanOrEqual(0.9 * s.reordered);
  });

  it("holds a reordered packet 2 × jitter + one tick past its FIFO due time", () => {
    // jitter 0: every packet's FIFO due is send + 30 ms; reorder everything.
    const h = new Harness(custom({ delayMs: 30, jitterMs: 0, reorder: 1 }), 5);
    h.sendUp(1);
    h.runTo(200, 0.125);
    expect(h.up).toHaveLength(1);
    expect((h.up[0] as Arrival).at).toBeCloseTo(30 + TICK_MS, 0);
    const j = custom({ delayMs: 30, jitterMs: 10, reorder: 1 });
    const h2 = new Harness(j, 5);
    h2.sendUp(1);
    h2.runTo(200, 0.125);
    const at = (h2.up[0] as Arrival).at;
    expect(at).toBeGreaterThanOrEqual(30 - 10 + 20 + TICK_MS);
    expect(at).toBeLessThanOrEqual(30 + 10 + 20 + TICK_MS + 0.125);
    // Jitter past the delay is clamped to no delay, so the hold is never cut short.
    const h3 = new Harness(custom({ delayMs: 0, jitterMs: 10, reorder: 1 }), 5);
    for (let i = 0; i < 20; i++) h3.sendUp(i);
    h3.runTo(200, 0.125);
    expect(h3.up).toHaveLength(20);
    for (const a of h3.up) expect(a.at).toBeGreaterThanOrEqual(2 * 10 + TICK_MS);
  });

  it("never drops or reorders reliable packets, in either direction", () => {
    const h = new Harness(named("bad-250-loss5"), 11);
    let reliableId = 0;
    for (let i = 0; i < 6000; i++) {
      h.runTo(i * 2);
      h.sendUp(i);
      h.sendDown(i);
      if (i % 3 === 0) {
        h.sendUp(reliableId, true);
        h.sendDown(reliableId, true);
        reliableId++;
      }
    }
    h.runTo(13_000);
    for (const list of [h.up, h.down]) {
      const reliable = list.filter((a) => a.reliable).map((a) => a.id);
      expect(reliable).toEqual(Array.from({ length: reliableId }, (_, k) => k));
    }
    const s = h.sim.stats();
    expect(s.lost).toBeGreaterThan(0);
    // The user's counters: what it sent, and what reached its callback (2-byte packets).
    expect(s.sent).toBe(6000 + reliableId);
    expect(s.sentBytes).toBe(2 * s.sent);
    expect(s.delivered).toBe(h.down.length);
    expect(s.deliveredBytes).toBe(2 * s.delivered);
  });

  it("gives the same delivery schedule for the same seed, another for another seed", () => {
    const run = (seed: number) => {
      const h = new Harness(named("bad-250-loss5"), seed);
      for (let i = 0; i < 2000; i++) {
        h.runTo(i * 5);
        h.sendUp(i);
        h.sendDown(i, i % 7 === 0);
      }
      h.runTo(12_000);
      return { up: h.up, down: h.down, stats: { ...h.sim.stats() } };
    };
    const a = run(42);
    expect(run(42)).toEqual(a);
    expect(run(43).up).not.toEqual(a.up);
  });

  it("setProfile applies to later packets; packets in flight keep their due times", () => {
    // 10 ms steps: a packet the server sends reaches the simulator at its next poll, 10 ms later.
    const h = new Harness(NET_PROFILE_LAN, 9);
    h.sendUp(0);
    h.runTo(10, 10);
    expect(h.up.map((a) => a.at)).toEqual([10]);

    h.sim.setProfile(custom({ delayMs: 100 }));
    expect(h.sim.profile().delayMs).toBe(100);
    h.sendUp(1);
    h.sendDown(1);
    h.runTo(50, 10);
    // Back to lan with packet 1 in flight: packet 2 queues behind it in each direction.
    h.sim.setProfile(NET_PROFILE_LAN);
    h.sendUp(2);
    h.sendDown(2);
    h.runTo(300, 10);
    expect(h.up.map((a) => [a.id, a.at])).toEqual([
      [0, 10],
      [1, 110],
      [2, 110],
    ]);
    expect(h.down.map((a) => [a.id, a.at])).toEqual([
      [1, 120],
      [2, 120],
    ]);
  });

  it("refuses a profile with values out of range and keeps the current one", () => {
    const h = new Harness(named("wan-50"), 1);
    expect(() => h.sim.setProfile(custom({ loss: 1.5 }))).toThrow(DevAssertError);
    expect(() => h.sim.setProfile(custom({ delayMs: -1 }))).toThrow(DevAssertError);
    expect(() => h.sim.setProfile(custom({ jitterMs: Number.NaN }))).toThrow(DevAssertError);
    expect(() => h.sim.setProfile(custom({ delayMs: Number.POSITIVE_INFINITY }))).toThrow(
      DevAssertError,
    );
    expect(() => h.sim.setProfile(custom({ reorder: -0.1 }))).toThrow(DevAssertError);
    expect(() => h.sim.setProfile(custom({ duplicate: 2 }))).toThrow(DevAssertError);
    expect(h.sim.profile().name).toBe("wan-50");
  });

  it("without dev asserts, a refused first profile leaves it on lan and says so", () => {
    setDevAsserts(false);
    try {
      const h = new Harness(custom({ name: "bad", delayMs: -5 }), 3);
      expect(h.sim.profile()).toBe(NET_PROFILE_LAN);
      h.sendUp(1);
      h.server.poll();
      expect(h.up.map((a) => a.id)).toEqual([1]);
    } finally {
      setDevAsserts(true);
    }
  });

  it("asks the host to pump at each new due time, so packets leave on time between polls", () => {
    const p = { ...named("wan-100-loss1"), loss: 0 };
    const h = new Harness(p, 21, true);
    const sentAt: number[] = [];
    let wakeIndex = 0;
    for (let i = 0; i < 200; i++) {
      sentAt.push(h.now);
      h.sendUp(i);
      // The host never polls the simulator: it pumps only when a wake falls due.
      const until = (i + 1) * TICK_MS;
      while (wakeIndex < h.wakes.length && (h.wakes[wakeIndex] as number) <= until) {
        h.now = Math.max(h.now, h.wakes[wakeIndex] as number);
        wakeIndex++;
        h.sim.pump();
        h.server.poll();
      }
      h.now = until;
    }
    expect(h.wakes.length).toBeGreaterThan(0);
    expect(h.up.length).toBeGreaterThan(180);
    for (const a of h.up) {
      const delay = a.at - (sentAt[a.id] as number);
      expect(delay).toBeGreaterThanOrEqual(p.delayMs - p.jitterMs);
      expect(delay).toBeLessThanOrEqual(p.delayMs + p.jitterMs);
    }
  });

  it("reports each new front due time once; sends and polls that keep the front report nothing", () => {
    // No jitter: every later packet is due after the first, which stays at the front.
    const h = new Harness(custom({ delayMs: 50 }), 1, true);
    h.now = 1;
    h.sendUp(1);
    h.now = 2;
    h.sendUp(2, true);
    h.sim.poll();
    h.sendUp(3);
    h.sim.poll();
    expect(h.wakes).toEqual([51]);
    h.now = 51;
    h.sim.poll();
    expect(h.wakes).toEqual([51, 52]);
    h.sim.poll();
    h.now = 52;
    h.sim.poll();
    expect(h.wakes).toEqual([51, 52]);
    h.server.poll();
    expect(h.up.map((a) => a.id)).toEqual([1, 2, 3]);
  });

  it("an early pump asks again for the same time, so the packet still leaves on time", () => {
    const h = new Harness(named("wan-100-loss1"), 21, true);
    h.now = 0.3;
    h.sendUp(1);
    expect(h.wakes).toHaveLength(1);
    const at = h.wakes[0] as number;
    // A browser timer truncates its delay, so it may fire up to 1 ms before `at`.
    h.now = Math.floor(at);
    h.sim.pump();
    h.server.poll();
    expect(h.up).toEqual([]);
    expect(h.wakes).toEqual([at, at]);
    h.now = at;
    h.sim.pump();
    h.server.poll();
    expect(h.up.map((a) => [a.id, a.at])).toEqual([[1, at]]);
  });

  it("holds at most MAX_QUEUED_UNRELIABLE unreliable arrivals, dropping the oldest as lost", () => {
    // A link far longer than any profile: arrivals pile up here faster than they come due (F01).
    const h = new Harness(custom({ delayMs: 5000 }), 8);
    const n = 2000;
    for (let i = 0; i < n; i++) {
      h.runTo(i, 1);
      h.sendDown(i);
      if (i % 400 === 0) h.sendDown(i, true);
    }
    h.runTo(n, 1);
    expect(h.sim.inFlight()).toBe(MAX_QUEUED_UNRELIABLE + 5);
    h.runTo(n + 6000, 1);
    expect(h.down.filter((a) => a.reliable).map((a) => a.id)).toEqual([0, 400, 800, 1200, 1600]);
    expect(h.down.filter((a) => !a.reliable).map((a) => a.id)).toEqual(
      Array.from({ length: MAX_QUEUED_UNRELIABLE }, (_, k) => n - MAX_QUEUED_UNRELIABLE + k),
    );
    expect(h.sim.stats().lost).toBe(n - MAX_QUEUED_UNRELIABLE);
  });

  describe("close", () => {
    it("a close in either direction queues behind the unreliable packets sent before it", () => {
      // Jitter without reordering: only the close's ordering keeps it behind them (D-028).
      const p = { ...named("wan-150-loss2"), loss: 0, reorder: 0 };
      for (let seed = 1; seed < 50; seed++) {
        const up = new Harness(p, seed);
        const upCloses: number[] = [];
        up.server.onClose(() => upCloses.push(up.now));
        for (let i = 0; i < 5; i++) up.sendUp(i);
        up.sim.close("quit");
        up.runTo(400);
        expect(up.up.map((a) => a.id)).toEqual([0, 1, 2, 3, 4]);
        expect(upCloses).toHaveLength(1);
        for (const a of up.up) expect(upCloses[0]).toBeGreaterThanOrEqual(a.at);

        const down = new Harness(p, seed);
        const downCloses: number[] = [];
        down.sim.onClose(() => downCloses.push(down.now));
        for (let i = 0; i < 5; i++) down.sendDown(i);
        down.server.close("kicked");
        down.runTo(400);
        expect(down.down.map((a) => a.id)).toEqual([0, 1, 2, 3, 4]);
        expect(downCloses).toHaveLength(1);
        for (const a of down.down) expect(downCloses[0]).toBeGreaterThanOrEqual(a.at);
      }
    });

    it("closing the simulator still sends what it holds, then closes the inner transport", () => {
      for (const p of [NET_PROFILE_LAN, named("wan-50"), named("bad-250-loss5")]) {
        const h = new Harness(p, 2);
        const closes: number[] = [];
        h.server.onClose(() => closes.push(h.now));
        h.sendUp(1, true);
        h.sendUp(2);
        h.sendDown(3);
        h.runTo(1);
        h.sendUp(4, true);
        h.sim.close("quit");
        expect(h.sim.isOpen()).toBe(false);
        h.sendUp(5);
        h.runTo(400);
        // Reliable messages are never lost, even at the close; arrivals held here are dropped.
        expect(h.up.filter((a) => a.reliable).map((a) => a.id)).toEqual([1, 4]);
        expect(h.up.some((a) => a.id === 5)).toBe(false);
        // The packet sent down at 0 was still held here at the close, except on lan.
        expect(h.down.map((a) => a.id)).toEqual(p.delayMs > 0 ? [] : [3]);
        expect(closes).toHaveLength(1);
        for (const a of h.up) expect(closes[0]).toBeGreaterThanOrEqual(a.at);
        expect(closes[0]).toBeGreaterThanOrEqual(1 + p.delayMs - p.jitterMs);
        expect(h.sim.inFlight()).toBe(0);
      }
    });

    it("after close, wakes and pumps alone drain it and deliver the close", () => {
      const h = new Harness(named("wan-100-loss1"), 6, true);
      let closed = "";
      h.server.onClose((reason) => {
        closed = reason;
      });
      h.sendUp(1, true);
      h.sim.close("bye");
      let wakeIndex = 0;
      while (wakeIndex < h.wakes.length) {
        h.now = Math.max(h.now, h.wakes[wakeIndex] as number);
        wakeIndex++;
        h.sim.pump();
        h.server.poll();
      }
      expect(h.up.map((a) => a.id)).toEqual([1]);
      expect(closed).toBe("bye");
      expect(h.now).toBeGreaterThanOrEqual(50 - 8);
    });

    it("the peer's close arrives delayed, behind the reliable messages sent before it", () => {
      const h = new Harness(named("wan-100-loss1"), 4);
      const closes: number[] = [];
      let reason = "";
      h.sim.onClose((r) => {
        closes.push(h.now);
        reason = r;
      });
      h.sendDown(7, true);
      h.server.close("kicked");
      h.runTo(41);
      expect(h.down).toEqual([]);
      expect(h.sim.isOpen()).toBe(true);
      h.runTo(200);
      expect(h.down.map((a) => a.id)).toEqual([7]);
      expect(closes).toHaveLength(1);
      expect(closes[0]).toBeGreaterThanOrEqual((h.down[0] as Arrival).at);
      expect(reason).toBe("kicked");
      expect(h.sim.isOpen()).toBe(false);
    });
  });
});
