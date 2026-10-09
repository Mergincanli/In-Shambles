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
// raw endpoints, per-session byte counts and the frame digests against the server's. A full
// 37-player match and the 16-client baseline that later increments measure against (16 clients on
// arena_greybox at wan-150-loss2, over full v2 snapshots that list every player) are the long
// tier's (D-032, `packages/tools/long/multi-harness.long.ts`).

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
