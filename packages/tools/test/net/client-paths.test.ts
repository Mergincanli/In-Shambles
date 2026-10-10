import {
  type ClientSim,
  type CmdSampler,
  MAX_LEAD_TICKS,
  MAX_TICKS_PER_FRAME,
  MixedInput,
  NeutralInput,
  SNAPSHOT_STALE,
  SNAPSHOT_TELEPORT,
  StrafeCircuit,
} from "@game/client/net";
import { SESSION_ACTIVE, type Session } from "@game/server";
import {
  BitReader,
  BitWriter,
  BUTTON_ATTACK,
  type CloseHandler,
  CmdMsg,
  decodeCmd,
  findNetProfile,
  MAX_QUEUED_UNRELIABLE,
  MAX_UNRELIABLE_BYTES,
  type MessageHandler,
  MSG_CMD,
  MSG_CVARS,
  MSG_INPUT,
  MSG_SNAPSHOT,
  type NetProfile,
  type NetSimTransport,
  PlayerState,
  type Transport,
  type TransportStats,
  type UserCmd,
} from "@game/shared";
import { describe, expect, it } from "vitest";
import { NetHarness } from "./harness";
import { HandSnapshot } from "./snapshots";

// The ClientSim paths the NET acceptance runs rarely reach (M2 design §2): the render offset at a
// visible size and its snaps, the hard resync after a long stall, the CVARS re-request, the
// per-frame tick cap and the lead cap while no snapshot arrives.

/**
 * Lets a test watch and rewrite what the client sends and receives. Its INPUTs ack tick 0, so the
 * server keeps sending full snapshots (D-038), which a test can rewrite by hand without the
 * client's stored baselines drifting from the server's.
 */
class TapTransport implements Transport {
  /** Returns the bytes to deliver (the same or rewritten), or null to drop the message. */
  receive: (d: Uint8Array, len: number, reliable: boolean) => Uint8Array | null = (d) => d;
  send: (d: Uint8Array, len: number, reliable: boolean) => void = () => {};
  /** False drops what the client sends (after `send` saw it). */
  uplink: (d: Uint8Array, len: number, reliable: boolean) => boolean = () => true;
  /** Hands an unreliable message to the client now, as if it had just arrived (a reorder). */
  inject: (d: Uint8Array) => void = () => {};
  constructor(private readonly inner: Transport) {}
  sendUnreliable(d: Uint8Array, len: number): void {
    // INPUT: type u8, packetSeq u16, then lastSnapshotTick u32 in bytes 3–6 (docs/05 §3.6).
    if (len >= 7 && d[0] === MSG_INPUT) d.fill(0, 3, 7);
    this.send(d, len, false);
    if (this.uplink(d, len, false)) this.inner.sendUnreliable(d, len);
  }
  sendReliable(d: Uint8Array, len: number): void {
    this.send(d, len, true);
    if (this.uplink(d, len, true)) this.inner.sendReliable(d, len);
  }
  onMessage(cb: MessageHandler): void {
    this.inject = (d) => cb(d, d.length, false);
    this.inner.onMessage((d, len, reliable) => {
      const out = this.receive(d, len, reliable);
      if (out !== null) cb(out, out === d ? len : out.length, reliable);
    });
  }
  onClose(cb: CloseHandler): void {
    this.inner.onClose(cb);
  }
  poll(): void {
    this.inner.poll();
  }
  close(reason?: string): void {
    this.inner.close(reason);
  }
  isOpen(): boolean {
    return this.inner.isOpen();
  }
  stats(): TransportStats {
    return this.inner.stats();
  }
}

function tapped(input: CmdSampler, map?: string): { h: NetHarness; tap: TapTransport } {
  let tap: TapTransport | null = null;
  const h = new NetHarness({
    primer: false,
    input,
    map,
    wrap: (t) => {
      tap = new TapTransport(t);
      return tap;
    },
  });
  return { h, tap: tap as unknown as TapTransport };
}

function step(f: NetHarness["frames"], i: number): number {
  return Math.hypot(
    (f.x[i] as number) - (f.x[i - 1] as number),
    (f.y[i] as number) - (f.y[i - 1] as number),
    (f.z[i] as number) - (f.z[i - 1] as number),
  );
}

/** Moves the server's player up by `dz` before the next server tick; returns that tick. */
function bump(h: NetHarness, dz: number): number {
  const tick = h.match.serverTick + 1;
  h.beforeServerTick = () => {
    const p = h.match.session(0)?.player as PlayerState;
    p.origin[2] = (p.origin[2] as number) + dz;
    h.beforeServerTick = null;
  };
  return tick;
}

/** Records every (tick, SNAPSHOT_* result) the client's predictor returns from now on. */
function watchResults(h: NetHarness): [number, number][] {
  const seen: [number, number][] = [];
  const p = h.client.predictor;
  const inner = p.onSnapshot.bind(p);
  p.onSnapshot = (tick, s, hash16, teleportSeq) => {
    const result = inner(tick, s, hash16, teleportSeq);
    seen.push([tick, result]);
    return result;
  };
  return seen;
}

/** The ticks whose snapshot the predictor took as a teleport (SNAPSHOT_TELEPORT). */
function teleportTicks(seen: readonly [number, number][]): number[] {
  return seen.filter(([, r]) => r === SNAPSHOT_TELEPORT).map(([t]) => t);
}

/** From frame `from` on, no render offset was left and the drawn position jumped over `min` u. */
function expectSnappedFrom(h: NetHarness, from: number, min: number): void {
  const f = h.frames;
  expect(Math.max(...f.offset.slice(from))).toBe(0);
  let jump = 0;
  for (let j = from + 1; j < f.time.length; j++) jump = Math.max(jump, step(f, j));
  expect(jump).toBeGreaterThan(min);
}

/** The first frame after `from` with a render offset, or −1. */
function firstOffsetFrame(h: NetHarness, from: number): number {
  for (let i = from; i < h.frames.offset.length; i++)
    if ((h.frames.offset[i] as number) > 0) return i;
  return -1;
}

describe("render offset", () => {
  it("carries a 20 u correction and glides it away over cl_correctionSmoothMs", () => {
    const h = new NetHarness({ input: new NeutralInput(), primer: false });
    h.runTicks(120);
    const from = h.frames.offset.length;
    bump(h, 20);
    h.run(600);
    expect(h.totals().corrections).toBe(1);
    // The spawn snapshot seeded the teleport counter, and nothing changed it since (D-035).
    expect(h.totals().teleports).toBe(0);
    const i = firstOffsetFrame(h, from);
    expect(i).toBeGreaterThan(from);
    const f = h.frames;
    // The offset is old − new: the server's player is 20 u higher (less the few ticks it fell).
    expect(f.offset[i]).toBeGreaterThan(15);
    expect(f.offset[i]).toBeLessThan(20.5);
    expect((f.z[i] as number) - (f.z[i - 1] as number)).toBeLessThan(1);
    // The drawn position never jumps: it eases up, each frame well under the correction.
    for (let j = i; j < f.time.length; j++) expect(step(f, j), `frame ${j}`).toBeLessThan(5);
    // Gone after the smoothing time.
    const smooth = h.client.settings.correctionSmoothMs;
    for (let j = i; j < f.time.length; j++) {
      if ((f.time[j] as number) > (f.time[i] as number) + smooth) {
        expect(f.offset[j]).toBe(0);
      }
    }
  });

  it("snaps a correction longer than cl_teleportDist", () => {
    const h = new NetHarness({ input: new NeutralInput(), primer: false });
    h.runTicks(120);
    const from = h.frames.offset.length;
    bump(h, h.client.settings.teleportDist + 36);
    h.run(600);
    expect(h.totals().corrections).toBe(1);
    const f = h.frames;
    expect(Math.max(...f.offset.slice(from))).toBe(0);
    let jump = 0;
    for (let j = from + 1; j < f.time.length; j++) jump = Math.max(jump, step(f, j));
    expect(jump).toBeGreaterThan(h.client.settings.teleportDist);
  });

  /**
   * Bumps the server's player 20 u and, from the bumped tick on, rewrites every snapshot to carry
   * the next teleport counter (D-035). `edit` sees each snapshot's tick and its (rewritten) bytes
   * and returns what to deliver, null to drop it.
   */
  function counterStep(
    edit: (tick: number, bump: number, d: Uint8Array) => Uint8Array | null = (_, __, d) => d,
  ) {
    const { h, tap } = tapped(new NeutralInput());
    h.runTicks(120);
    const from = h.frames.offset.length;
    const results = watchResults(h);
    const tick = bump(h, 20);
    const r = new BitReader();
    const w = new BitWriter(MAX_UNRELIABLE_BYTES);
    const m = new HandSnapshot(0);
    tap.receive = (d, len, reliable) => {
      if (reliable || d[0] !== MSG_SNAPSHOT) return d;
      r.reset(d, len);
      if (!m.decode(r)) return d;
      const t = m.header.serverTick;
      if (t < tick) return edit(t, tick, d.slice(0, len));
      m.frame.teleportSeq[0] = (m.header.teleportSeq + 1) & 0xff;
      m.encode(w);
      return edit(t, tick, w.bytes.slice(0, w.byteLength));
    };
    return { h, tap, from, tick, results };
  }

  function expectSnapped(h: NetHarness, from: number): void {
    expectSnappedFrom(h, from, 15);
  }

  it("snaps on a change of the snapshot's teleport counter, however short the move", () => {
    // The bump's own snapshot snaps, as a teleport and not a correction; the later ones carry the
    // same counter and don't.
    const { h, from, tick, results } = counterStep();
    h.run(600);
    expect(teleportTicks(results)).toEqual([tick]);
    expect(h.totals().corrections).toBe(0);
    expect(h.totals().teleports).toBe(1);
    expectSnapped(h, from);
  });

  it("still snaps when the snapshot of the jump is lost (D-035)", () => {
    // The next snapshot carries the new counter: the predictor takes it as the teleport.
    const { h, from, tick, results } = counterStep((t, tick, d) => (t === tick ? null : d));
    h.run(600);
    expect(results.some(([t]) => t === tick)).toBe(false);
    expect(teleportTicks(results)).toEqual([tick + 1]);
    expect(h.totals().corrections).toBe(0);
    expect(h.totals().teleports).toBe(1);
    expectSnapped(h, from);
  });

  it("ignores the previous counter on a reordered older snapshot (D-035)", () => {
    // The snapshot before the jump arrives right after the jump's: stored (its ring slot is free),
    // stale to prediction, so the watched counter must not step back (and snap twice).
    let held: Uint8Array | null = null;
    let heldStored = false;
    const { h, tap, from, tick, results } = counterStep((t, tick, d) => {
      if (t === tick - 1) {
        held = d;
        return null;
      }
      if (t === tick && held !== null) {
        tap.inject(d);
        const stored = h.client.store.stored;
        tap.inject(held);
        heldStored = h.client.store.stored === stored + 1;
        return null;
      }
      return d;
    });
    h.run(600);
    expect(heldStored).toBe(true);
    // The jump's snapshot is the teleport; the older one, right after it, is stale to prediction.
    expect(teleportTicks(results)).toEqual([tick]);
    const at = results.findIndex(([t]) => t === tick);
    expect(results[at + 1]).toEqual([tick - 1, SNAPSHOT_STALE]);
    expect(h.totals().teleports).toBe(1);
    expectSnapped(h, from);
    // A later small correction eases as usual: the counter in hand is still the new one.
    const later = h.frames.offset.length;
    bump(h, 20);
    h.run(600);
    expect(h.totals().teleports).toBe(1);
    expect(h.totals().corrections).toBe(1);
    expect(teleportTicks(results)).toEqual([tick]);
    expect(firstOffsetFrame(h, later)).toBeGreaterThan(later);
  });
});

describe("respawns (D-035)", () => {
  /** Respawns the client's player before the next server tick; returns that tick. */
  function respawnNext(h: NetHarness, then?: () => void): number {
    const tick = h.match.serverTick + 1;
    h.beforeServerTick = () => {
      expect(h.match.respawn(h.match.session(0) as Session)).toBe(true);
      h.beforeServerTick = null;
      then?.();
    };
    return tick;
  }

  it("a Match.respawn is a teleport, not a correction, even when the spawn's snapshot is lost", () => {
    // arena_greybox: the player spawned at the first info_player_start; the respawn takes the
    // second, far away.
    const { h, tap } = tapped(new StrafeCircuit(), "arena_greybox");
    h.runTicks(240);
    const from = h.frames.offset.length;
    const before = h.totals();
    const results = watchResults(h);
    const tick = respawnNext(h);
    const r = new BitReader();
    const m = new HandSnapshot(0);
    tap.receive = (d, len, reliable) => {
      if (reliable || d[0] !== MSG_SNAPSHOT) return d;
      r.reset(d, len);
      return m.decode(r) && m.header.serverTick === tick ? null : d;
    };
    h.run(600);
    expect(results.some(([t]) => t === tick)).toBe(false);
    expect(teleportTicks(results)).toEqual([tick + 1]);
    const after = h.totals();
    expect(after.teleports).toBe(1);
    expect(after.corrections).toBe(before.corrections);
    expect(after.starved).toBe(before.starved);
    expect(after.hardResyncs).toBe(before.hardResyncs);
    expectSnappedFrom(h, from, 64);
  });

  it("keeps the cmds queued before a respawn, so INPUTs lost right after it starve nothing", () => {
    // With cl_inputBuffer 6 the server holds the cmds of the next 6 ticks or so when the respawn
    // comes. The two INPUTs sent after it are lost; the third re-sends their cmds (4 per INPUT)
    // in time. The cmds held were sent earlier and nothing re-sends them all: a respawn that
    // cleared the queue would starve them (D-035).
    const { h, tap } = tapped(new StrafeCircuit(), "arena_greybox");
    expect(h.client.cvars.set("cl_inputBuffer", 6).ok).toBe(true);
    h.runTicks(240);
    const before = h.totals();
    const results = watchResults(h);
    let drop = 0;
    tap.uplink = (d, _len, reliable) => {
      if (reliable || d[0] !== MSG_INPUT || drop === 0) return true;
      drop--;
      return false;
    };
    const tick = respawnNext(h, () => {
      drop = 2;
    });
    h.run(600);
    expect(drop).toBe(0);
    expect(teleportTicks(results)).toEqual([tick]);
    const after = h.totals();
    expect(after.starved).toBe(before.starved);
    expect(after.corrections).toBe(before.corrections);
    expect(after.hardResyncs).toBe(before.hardResyncs);
  });

  it("takes a respawn on the first snapshot after the spawn as a teleport (the counter seeded)", () => {
    // The spawn snapshot seeds the predictor's counter; the next one already carries the
    // respawn's, so it must show as a teleport, not as a correction.
    const { h } = tapped(new StrafeCircuit(), "arena_greybox");
    const results = watchResults(h);
    let tick = -1;
    h.beforeServerTick = () => {
      const s = h.match.session(0);
      if (s?.state !== SESSION_ACTIVE || h.match.serverTick !== s.spawnTick) return;
      tick = h.match.serverTick + 1;
      expect(h.match.respawn(s)).toBe(true);
      h.beforeServerTick = null;
    };
    h.run(1000);
    expect(tick).toBeGreaterThan(0);
    expect(results[0]?.[0]).toBe(tick);
    expect(teleportTicks(results)).toEqual([tick]);
    expect(h.totals().teleports).toBe(1);
    expect(h.totals().corrections).toBe(0);
  });

  it("a teleport drops a render offset that is still easing", () => {
    // A 20 u correction leaves an offset to ease over cl_correctionSmoothMs (100 ms); a respawn
    // three ticks later must drop what is left on the frame that sees it.
    const { h } = tapped(new NeutralInput());
    h.runTicks(120);
    const p = h.client.predictor;
    const inner = p.onSnapshot.bind(p);
    let frame = -1;
    p.onSnapshot = (tick, s, hash16, teleportSeq) => {
      const result = inner(tick, s, hash16, teleportSeq);
      if (result === SNAPSHOT_TELEPORT && frame < 0) frame = h.frames.offset.length;
      return result;
    };
    const tick = h.match.serverTick + 1;
    h.beforeServerTick = () => {
      const t = h.match.serverTick + 1;
      const s = h.match.session(0) as Session;
      if (t === tick) s.player.origin[2] = (s.player.origin[2] as number) + 20;
      if (t === tick + 3) {
        expect(h.match.respawn(s)).toBe(true);
        h.beforeServerTick = null;
      }
    };
    h.run(600);
    expect([h.totals().corrections, h.totals().teleports]).toEqual([1, 1]);
    expect(frame).toBeGreaterThan(0);
    expect(h.frames.offset[frame - 1]).toBeGreaterThan(5);
    expect(h.frames.offset[frame]).toBe(0);
  });
});

/** Neutral input with attack held, so the hard resync's fill shows it clears attack. */
class Firing implements CmdSampler {
  private readonly inner = new MixedInput();
  sample(cmd: UserCmd, ps: Readonly<PlayerState>): void {
    this.inner.sample(cmd, ps);
    cmd.buttons |= BUTTON_ATTACK;
  }
}

describe("ClientSim recovery paths", () => {
  it("re-anchors once after a 3 s stall: one hard resync, the fill without attack, no burst", () => {
    const { h, tap } = tapped(new Firing());
    h.runTicks(300);
    let sentThisFrame = 0;
    tap.send = () => {
      sentThisFrame++;
    };
    h.hitch(3000);
    const c: ClientSim = h.client;
    const resumeAt = h.now + 3000;
    h.run(3000 - 1);
    expect(c.stats.totals).toBeDefined();
    const hardBefore = h.totals().hardResyncs;
    sentThisFrame = 0;
    // The resuming frame: the poll delivers ~180 snapshots, all ahead of the prediction.
    while (h.now < resumeAt + 10 && h.totals().hardResyncs === hardBefore) h.run(1);
    expect(h.totals().hardResyncs).toBe(1);
    const p = c.predictor;
    const lead = c.clock.leadTicks(c.settings.inputBuffer);
    expect(c.startTick).toBe(p.snapshotTick + lead);
    expect(p.latestTick).toBe(c.startTick);
    for (let tick = p.snapshotTick + 1; tick <= c.startTick; tick++) {
      expect((p.cmds.get(tick)?.buttons ?? BUTTON_ATTACK) & BUTTON_ATTACK, `tick ${tick}`).toBe(0);
    }
    // One INPUT per fill tick (and a ping at most), not one per backlogged snapshot.
    expect(sentThisFrame).toBeLessThanOrEqual(lead + 2);
    const before = h.totals();
    h.run(2000);
    const after = h.totals();
    expect(after.hardResyncs).toBe(1);
    expect(after.corrections - before.corrections).toBe(0);
    expect(h.unreconciled()).toEqual([]);
  });

  it("a 30 s hidden tab keeps bounded receive queues and recovers with one hard resync", () => {
    // The Worker keeps sending a snapshot every tick while the page does not poll (F01). No
    // jitter, so the backlog comes due in one poll: one hard resync (one per poll, docs/05 §8).
    const wan50 = findNetProfile("wan-50") as NetProfile;
    const h = new NetHarness({
      input: new NeutralInput(),
      profile: { ...wan50, jitterMs: 0 },
      primer: false,
    });
    h.runTicks(120);
    const sim = h.sim as NetSimTransport;
    h.hitch(30_000);
    let maxInFlight = 0;
    for (let ms = 0; ms < 31_000; ms += 10) {
      h.run(10);
      maxInFlight = Math.max(maxInFlight, sim.inFlight());
    }
    // The loopback end under it drops the older ~1500 snapshots before they reach the simulator;
    // on top of those, the client's INPUTs on the way out (since MAX_TICKS_PER_FRAME 8, D-039, up
    // to 10 around the frame that ends the stall).
    expect(maxInFlight).toBeLessThanOrEqual(MAX_QUEUED_UNRELIABLE + MAX_TICKS_PER_FRAME + 8);
    expect(h.totals().hardResyncs).toBe(1);
    const before = h.totals();
    h.run(2000);
    expect(h.totals().corrections - before.corrections).toBe(0);
    expect(h.unreconciled()).toEqual([]);
  });

  it("asks for the cvar block again when its CVARS is lost: parameter resyncs, no corrections", () => {
    const { h, tap } = tapped(new MixedInput());
    h.runTicks(300);
    const arrivals: number[] = [];
    tap.receive = (d, _len, reliable) => {
      if (!reliable || d[0] !== MSG_CVARS) return d;
      arrivals.push(h.now);
      return arrivals.length === 1 ? null : d;
    };
    const cmds: string[] = [];
    const r = new BitReader();
    const cmd = new CmdMsg();
    tap.send = (d, len, reliable) => {
      if (!reliable || d[0] !== MSG_CMD) return;
      r.reset(d, len);
      if (decodeCmd(r, cmd)) cmds.push(cmd.text);
    };
    expect(h.client.sendCommand("set pm_gravity 400")).toBe(true);
    h.run(3000);
    expect(cmds).toEqual(["set pm_gravity 400", "cvars"]);
    expect(arrivals.length).toBe(2);
    expect((arrivals[1] as number) - (arrivals[0] as number)).toBeGreaterThanOrEqual(1000);
    expect((arrivals[1] as number) - (arrivals[0] as number)).toBeLessThan(1200);
    const t = h.totals();
    expect(t.paramResyncs).toBeGreaterThan(30);
    expect(t.corrections).toBe(0);
    expect(h.client.cvars.getNumber("pm_gravity", 0)).toBe(400);
    expect(h.client.predictor.pendingParams).toBe(false);
    // Back in sync: the last second matched with no resyncs.
    const resyncs = t.paramResyncs;
    h.run(1000);
    expect(h.totals().paramResyncs).toBe(resyncs);
    expect(h.totals().corrections).toBe(0);
    expect(h.unreconciled()).toEqual([]);
  });

  it("runs at most MAX_TICKS_PER_FRAME ticks a frame and stops MAX_LEAD_TICKS past the newest snapshot", () => {
    const h = new NetHarness({ input: new MixedInput(), primer: false });
    h.runTicks(300);
    const c = h.client;
    const p = c.predictor;
    // The server stalls (its ticks stop); the client's frames go on.
    const match = h.match;
    const realTick = match.tick.bind(match);
    let serverStalled = true;
    match.tick = () => {
      if (!serverStalled) realTick();
    };
    const queue = match.session(0)?.queue;
    expect(queue).toBeDefined();
    const early = queue?.early ?? -1;
    let latest = p.latestTick;
    let maxPerFrame = 0;
    for (let i = 0; i < 300; i++) {
      h.run(1000 / 144);
      maxPerFrame = Math.max(maxPerFrame, p.latestTick - latest);
      latest = p.latestTick;
    }
    expect(maxPerFrame).toBeLessThanOrEqual(MAX_TICKS_PER_FRAME);
    // Exactly the server's input horizon: the newest cmd is the last one its queue accepts.
    expect(p.latestTick - p.snapshotTick).toBe(MAX_LEAD_TICKS);
    expect(c.alpha).toBe(1);
    // The server resumes: the cmds it queued are the ones the client predicted, so the client
    // reconciles without a hard resync or a correction, and holds its clock back to the normal
    // lead.
    serverStalled = false;
    const before = h.totals();
    // Holds of at most 30 ticks, each once a full window sits target + 6 or more above (D-039),
    // then −3% for the last two ticks: well within 8 s back from a 64-tick lead.
    h.run(8000);
    const after = h.totals();
    expect(after.hardResyncs).toBe(0);
    expect(after.corrections - before.corrections).toBe(0);
    expect(queue?.early).toBe(early);
    expect(c.clock.holds).toBeGreaterThanOrEqual(2);
    expect(c.clock.fastForwards).toBe(0);
    expect(h.lead()).toBeLessThanOrEqual(c.settings.inputBuffer + 3);
    expect(h.unreconciled()).toEqual([]);
  });

  it("a lone long frame on lan resyncs without growing the lead; a second within 1.5 s grows it", () => {
    // On lan the lead is all buffer (3 ticks, 50 ms): a 60–70 ms gap overtakes the prediction.
    const h = new NetHarness({ input: new NeutralInput(), primer: false });
    h.runTicks(600);
    const c = h.client;
    h.hitch(70);
    h.run(500);
    expect(h.totals().hardResyncs).toBe(1);
    // A lone gap is not a frame rhythm (like a lone dip): the lead stays, and nothing to hold.
    expect(c.clock.adaptiveTicks).toBe(0);
    expect(h.lead()).toBeLessThanOrEqual(c.settings.inputBuffer + 2);
    h.run(5000);
    expect(c.clock.holds).toBe(0);
    // A second gap within the window is a pattern: its resync grows the adaptive lead.
    h.hitch(70);
    h.run(200);
    h.hitch(70);
    h.run(500);
    expect(h.totals().hardResyncs).toBeGreaterThanOrEqual(2);
    expect(c.clock.adaptiveTicks).toBeGreaterThan(0);
  });

  it("a hard resync after a short frame (a downlink outage) is not a frame rhythm, even after a long one", () => {
    const { h, tap } = tapped(new NeutralInput());
    h.runTicks(600);
    const c = h.client;
    const lead = h.lead();
    // A long frame resyncs (left alone: a lone one) ...
    h.hitch(70);
    h.run(100);
    expect(h.totals().hardResyncs).toBe(1);
    // ... then snapshots are lost for 1.1 s while the frames stay short: the prediction stops at
    // the lead cap, the server starves past it, and the first snapshot back is ahead of the
    // prediction, within 1.5 s of the first resync. Counted as a dip it would grow the lead.
    const until = h.now + 1100;
    tap.receive = (d, _len, reliable) => (reliable || h.now >= until ? d : null);
    h.run(1100);
    h.run(500);
    expect(h.totals().hardResyncs).toBe(2);
    expect(c.clock.adaptiveTicks).toBe(0);
    expect(h.lead()).toBeLessThanOrEqual(lead + 1);
  });

  it("a hard resync in the same poll as a step request drops the step (it measured the old anchor)", () => {
    const h = new NetHarness({ input: new NeutralInput(), primer: false });
    h.runTicks(200);
    const c = h.client;
    const p = c.predictor;
    const match = h.match;
    // Stop the real server; the test sends the snapshots itself.
    match.tick = () => {};
    const server = match.session(0)?.transport as Transport;
    const w = new BitWriter(MAX_UNRELIABLE_BYTES);
    const m = new HandSnapshot(0);
    const ps = new PlayerState();
    const teleportSeq = c.store.header.teleportSeq;
    const send = (tick: number, health: number) => {
      if (!p.stateAt(tick, ps)) ps.origin.set(p.state.origin);
      m.local(tick, ps, { health, cvarHash: p.hashFor(tick), teleportSeq });
      m.encode(w);
      server.sendUnreliable(w.bytes, w.byteLength);
    };
    // The real server's last snapshots land first.
    h.run(50);
    // Five starved snapshots, one frame each: a dip one snapshot short of a sustained one, so the
    // clock does not step yet ...
    for (let i = 0; i < 5; i++) {
      send(p.snapshotTick + 1, -5);
      h.run(1000 / 60);
    }
    expect(c.clock.bufferLow).toBe(-5);
    expect(c.clock.fastForwards).toBe(0);
    // ... then one poll brings one more (asking for a fast-forward) and one past the prediction.
    send(p.snapshotTick + 1, -5);
    const ahead = p.latestTick + 10;
    send(ahead, 0);
    // One frame (frames come every 1000 / 144 ms ± 1 ms).
    const frames = c.frames;
    while (c.frames === frames) h.run(0.5);
    expect(c.clock.fastForwards).toBe(1);
    expect(h.totals().hardResyncs).toBe(1);
    expect(h.totals().clockAdjustments).toBe(0);
    expect(p.snapshotTick).toBe(ahead);
    expect(p.latestTick - ahead).toBe(c.clock.leadTicks(c.settings.inputBuffer));
  });
});
