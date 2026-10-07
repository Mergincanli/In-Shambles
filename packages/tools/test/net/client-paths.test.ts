import {
  type ClientSim,
  type CmdSampler,
  MAX_LEAD_TICKS,
  MAX_TICKS_PER_FRAME,
  MixedInput,
  NeutralInput,
} from "@game/client/net";
import {
  BitReader,
  BitWriter,
  BUTTON_ATTACK,
  type CloseHandler,
  CmdMsg,
  decodeCmd,
  decodeSnapshot,
  encodeSnapshot,
  findNetProfile,
  MAX_QUEUED_UNRELIABLE,
  MAX_UNRELIABLE_BYTES,
  type MessageHandler,
  MSG_CMD,
  MSG_CVARS,
  MSG_SNAPSHOT,
  type NetProfile,
  type NetSimTransport,
  type PlayerState,
  SNAP_FLAG_TELEPORT,
  SnapshotMsg,
  type Transport,
  type TransportStats,
  type UserCmd,
} from "@game/shared";
import { describe, expect, it } from "vitest";
import { NetHarness } from "./harness";

// The ClientSim paths the NET acceptance runs rarely reach (M2 design §2): the render offset at a
// visible size and its snaps, the hard resync after a long stall, the CVARS re-request, the
// per-frame tick cap and the lead cap while no snapshot arrives.

/** Lets a test watch and rewrite what the client sends and receives. */
class TapTransport implements Transport {
  /** Returns the bytes to deliver (the same or rewritten), or null to drop the message. */
  receive: (d: Uint8Array, len: number, reliable: boolean) => Uint8Array | null = (d) => d;
  send: (d: Uint8Array, len: number, reliable: boolean) => void = () => {};
  constructor(private readonly inner: Transport) {}
  sendUnreliable(d: Uint8Array, len: number): void {
    this.send(d, len, false);
    this.inner.sendUnreliable(d, len);
  }
  sendReliable(d: Uint8Array, len: number): void {
    this.send(d, len, true);
    this.inner.sendReliable(d, len);
  }
  onMessage(cb: MessageHandler): void {
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

function tapped(input: CmdSampler): { h: NetHarness; tap: TapTransport } {
  let tap: TapTransport | null = null;
  const h = new NetHarness({
    input,
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

/** The first frame after `from` with a render offset, or −1. */
function firstOffsetFrame(h: NetHarness, from: number): number {
  for (let i = from; i < h.frames.offset.length; i++)
    if ((h.frames.offset[i] as number) > 0) return i;
  return -1;
}

describe("render offset", () => {
  it("carries a 20 u correction and glides it away over cl_correctionSmoothMs", () => {
    const h = new NetHarness({ input: new NeutralInput() });
    h.runTicks(120);
    const from = h.frames.offset.length;
    bump(h, 20);
    h.run(600);
    expect(h.totals().corrections).toBe(1);
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
    const h = new NetHarness({ input: new NeutralInput() });
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

  it("snaps on a snapshot's teleport flag, however short the move", () => {
    const { h, tap } = tapped(new NeutralInput());
    h.runTicks(120);
    const from = h.frames.offset.length;
    const tick = bump(h, 20);
    const r = new BitReader();
    const w = new BitWriter(MAX_UNRELIABLE_BYTES);
    const m = new SnapshotMsg();
    tap.receive = (d, len, reliable) => {
      if (reliable || d[0] !== MSG_SNAPSHOT) return d;
      r.reset(d, len);
      if (!decodeSnapshot(r, m) || m.serverTick !== tick) return d;
      m.flags |= SNAP_FLAG_TELEPORT;
      w.reset();
      encodeSnapshot(w, m);
      return w.bytes.slice(0, w.byteLength);
    };
    h.run(600);
    expect(h.totals().corrections).toBe(1);
    const f = h.frames;
    expect(Math.max(...f.offset.slice(from))).toBe(0);
    let jump = 0;
    for (let j = from + 1; j < f.time.length; j++) jump = Math.max(jump, step(f, j));
    expect(jump).toBeGreaterThan(15);
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
    const h = new NetHarness({ input: new NeutralInput(), profile: { ...wan50, jitterMs: 0 } });
    h.runTicks(120);
    const sim = h.sim as NetSimTransport;
    h.hitch(30_000);
    let maxInFlight = 0;
    for (let ms = 0; ms < 31_000; ms += 10) {
      h.run(10);
      maxInFlight = Math.max(maxInFlight, sim.inFlight());
    }
    // The loopback end under it drops the older ~1500 snapshots before they reach the simulator.
    expect(maxInFlight).toBeLessThanOrEqual(MAX_QUEUED_UNRELIABLE + 8);
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
    const h = new NetHarness({ input: new MixedInput() });
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
    // Holds of at most 30 ticks, each after 1 s above the band: about 8 s back from a 64-tick lead.
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

  it("a hard resync in the same poll as a step request drops the step (it measured the old anchor)", () => {
    const h = new NetHarness({ input: new NeutralInput() });
    h.runTicks(200);
    const c = h.client;
    const p = c.predictor;
    const match = h.match;
    // Stop the real server; the test sends the snapshots itself.
    match.tick = () => {};
    const server = match.session(0)?.transport as Transport;
    const w = new BitWriter(MAX_UNRELIABLE_BYTES);
    const m = new SnapshotMsg();
    const send = (tick: number, health: number) => {
      m.serverTick = tick;
      m.lastProcessedCmdTick = tick;
      m.inputBufferHealth = health;
      m.cvarHash = p.hashFor(tick);
      m.flags = 0;
      if (!p.stateAt(tick, m.state)) m.state.origin.set(p.state.origin);
      w.reset();
      encodeSnapshot(w, m);
      server.sendUnreliable(w.bytes, w.byteLength);
    };
    // Starved snapshots for 0.45 s pull the health EWMA below the band ...
    const start = h.now;
    while (h.now - start < 450) {
      send(p.snapshotTick + 1, -5);
      h.run(1000 / 60);
    }
    expect(c.clock.bufferHealth).toBeLessThan(c.settings.inputBuffer - 1.5);
    h.run(400);
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
