import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { MixedInput, STAT_STRIKES } from "@game/client/net";
import {
  SESSION_ACTIVE,
  SESSION_CLOSED,
  SessionLimits,
  STRIKE_MALFORMED,
  STRIKE_UNEXPECTED,
  TOKEN_UNIT,
} from "@game/server";
import { startServer } from "@game/server/node";
import {
  BitReader,
  BitWriter,
  BUTTON_MASK,
  CmdMsg,
  decodeKick,
  encodeCmd,
  encodeHello,
  encodePing,
  encodeReady,
  findNetProfile,
  HelloMsg,
  KickMsg,
  MSG_KICK,
  Mulberry32,
  type NetProfile,
  PITCH_LIMIT_U16,
  PingMsg,
  playerStateEquals,
  writeTick,
} from "@game/shared";
import { describe, expect, it } from "vitest";
import { fromRoot } from "../../src/paths";
import {
  FRAMES_BROWSER_HITCHES,
  HARNESS_BUILD,
  MultiHarness,
  type RawClient,
  setHarnessPrimerDefault,
} from "./multiHarness";
import { closeAll, TEST_PEER_HEADER, upgrade, upgradeAtOnce } from "./wsProbe";

type HandleUpgrade = (
  req: IncomingMessage,
  socket: Duplex,
  head: Buffer,
  cb: (ws: unknown) => void,
) => void;

// NET-10 (a) (M3 design §5, §2.13, D-041): on a fake clock, one honest client plays while raw
// attackers abuse the match, each on its own schedule: every attacker is KICKed with its reason
// at the time the strike weights, the token buckets and the kick-time formula give, its slot is
// freed, and the honest client sees nothing (no strike, no correction, the same starved ticks and
// the same server state as a run without attackers). An honest client's 3 s stall, whose anchor
// fill sends dozens of INPUTs within a few polls, is not struck. The real-socket legs (b) are in
// `packages/tools/long/net-10-abuse.long.ts`, and a smoke of them is this file's
// "NET-10 (b) smoke" block (rcon lockout across reconnects joins them with rcon, increment 14).

setHarnessPrimerDefault(false);

const WAN50 = findNetProfile("wan-50") as NetProfile;
const BAD250 = findNetProfile("bad-250-loss5") as NetProfile;
const LIMITS = new SessionLimits();

/** Attack packets start at this server tick, once every attacker has joined. */
const ATTACK_TICK = 30;

function helloBytes(): Uint8Array {
  const w = new BitWriter(64);
  const m = new HelloMsg();
  m.buildHash = HARNESS_BUILD;
  encodeHello(w, m);
  return w.bytes.slice(0, w.byteLength);
}

function readyBytes(): Uint8Array {
  const w = new BitWriter(8);
  encodeReady(w);
  return w.bytes.slice(0, w.byteLength);
}

function pingBytes(id: number): Uint8Array {
  const w = new BitWriter(8);
  const m = new PingMsg();
  m.pingId = id;
  encodePing(w, m);
  return w.bytes.slice(0, w.byteLength);
}

function cmdBytes(text: string): Uint8Array {
  const w = new BitWriter(1100);
  const m = new CmdMsg();
  m.text = text;
  encodeCmd(w, m);
  return w.bytes.slice(0, w.byteLength);
}

interface InputFields {
  seq: number;
  ack: number;
  tick: number;
  buttons?: number;
  forward?: number;
  yaw?: number;
  pitch?: number;
}

/**
 * One INPUT with one cmd, written field by field (docs/05 §3.4) so a test can put any value in any
 * field: the encoder refuses what is out of range, the decoder must too.
 */
function inputBytes(f: InputFields): Uint8Array {
  const w = new BitWriter(64);
  w.writeBits(4, 8);
  w.writeBits(f.seq & 0xffff, 16);
  writeTick(w, f.ack);
  w.writeBits(1, 3);
  writeTick(w, f.tick);
  w.writeBits(f.buttons ?? 0, 16);
  w.writeSigned(f.forward ?? 0, 8);
  w.writeSigned(0, 8);
  w.writeSigned(0, 8);
  w.writeBits(f.yaw ?? 0, 16);
  w.writeBits(f.pitch ?? 0, 16);
  w.writeBits(0, 8);
  return w.bytes.slice(0, w.byteLength);
}

/** What one attacker does, and what became of it. */
interface Attacker {
  readonly name: string;
  readonly raw: RawClient;
  /** Joins (HELLO, then READY) before the attack; false: the attack is the whole session. */
  readonly join: boolean;
  /** Sends this tick's packets (called before every server tick from ATTACK_TICK on). */
  readonly step: (a: Attacker, tick: number) => void;
  /** Packets sent in the attack. */
  sent: number;
  /** The server tick whose processing closed the session, −1 while open. */
  kickedAt: number;
  /** Packets sent when it was kicked. */
  sentAtKick: number;
}

function kickReason(a: Attacker): string | null {
  const kick = a.raw.ofType(MSG_KICK)[0];
  if (kick === undefined) return null;
  const r = new BitReader();
  r.reset(kick.bytes, kick.bytes.length);
  const m = new KickMsg();
  return decodeKick(r, m) ? m.reason : "<bad KICK>";
}

/** `n` packets from `bytes(i)` on `reliable`, counted. */
function send(a: Attacker, n: number, reliable: boolean, bytes: (i: number) => Uint8Array): void {
  for (let i = 0; i < n; i++) {
    a.raw.send(bytes(a.sent), reliable);
    a.sent++;
  }
}

/** A valid cmd for the coming tick. */
function validInput(a: Attacker, tick: number, extra: Partial<InputFields> = {}): Uint8Array {
  return inputBytes({ seq: a.sent, ack: 0, tick: tick + 1, ...extra });
}

/**
 * The ticks the D-041 kick-time formula (docs/05 §12) gives a flood of `r` packets a tick against
 * a bucket of capacity `c` refilled by `f` a tick: empty after c / (r − f) ticks; then a share
 * min(1, r − f) of the ticks drop packets, each worth a strike point, until sv_strikeKick.
 */
function floodKickTicks(r: number, c: number, f: number): number {
  return c / (r - f) + LIMITS.strikeKick / Math.min(1, r - f);
}

interface Run {
  readonly h: MultiHarness;
  readonly attackers: Attacker[];
}

/**
 * A match with timeouts on, an honest client and (when `attack`) every raw attacker, run 10.5 s:
 * past the handshake timeout's 600 ticks.
 */
function run(attack: boolean): Run {
  const h = new MultiHarness({ timeouts: true });
  const honest = h.addClient({ input: new MixedInput(), profile: WAN50 });
  const rng = new Mulberry32(0x10ab05e);
  const attackers: Attacker[] = [];
  const add = (name: string, join: boolean, step: Attacker["step"]) => {
    const raw = h.addRaw();
    attackers.push({ name, raw, join, step, sent: 0, kickedAt: -1, sentAtKick: 0 });
  };
  if (attack) {
    // Malformed: an INPUT type byte on garbage of 8–64 bytes.
    add("garbage", true, (a) =>
      send(a, 1, false, () => {
        const b = new Uint8Array(8 + (rng.nextU32() % 57));
        for (let i = 1; i < b.length; i++) b[i] = rng.nextU32() & 0xff;
        b[0] = 4;
        return b;
      }),
    );
    // Anything at all, on either channel.
    add("random bytes", true, (a) =>
      send(a, 1, rng.nextFloat() < 0.5, () => {
        const b = new Uint8Array(8 + (rng.nextU32() % 57));
        for (let i = 0; i < b.length; i++) b[i] = rng.nextU32() & 0xff;
        return b;
      }),
    );
    add("wrong channel", true, (a, t) => send(a, 1, true, () => validInput(a, t)));
    add("out of state", true, (a) => send(a, 1, true, readyBytes));
    add("hostile acks", true, (a, t) =>
      send(a, 1, false, () => validInput(a, t, { ack: t + 100 })),
    );
    add("bad pitch", true, (a, t) =>
      send(a, 1, false, () => validInput(a, t, { pitch: PITCH_LIMIT_U16 + 1 })),
    );
    add("bad axes", true, (a, t) => send(a, 1, false, () => validInput(a, t, { forward: -128 })));
    add("spare bits", true, (a, t) =>
      send(a, 1, false, () => validInput(a, t, { buttons: (BUTTON_MASK + 1) & 0xffff })),
    );
    add("INPUT flood 3x", true, (a, t) => send(a, 3, false, () => validInput(a, t)));
    add("INPUT flood 10x", true, (a, t) => send(a, 10, false, () => validInput(a, t)));
    add("reliable flood", true, (a) => send(a, 1, true, () => cmdBytes("help")));
    add("HELLO flood", true, (a) => send(a, 1, true, helloBytes));
    add("CMD spam", true, (a) => send(a, 5, true, () => cmdBytes("set pm_gravity 100")));
    // Not kicked: in-range yaw spam is legal, and cmds past the queue's horizon are only dropped.
    add("yaw spam", true, (a, t) =>
      send(a, 1, false, () => validInput(a, t, { yaw: rng.nextU32() & 0xffff, forward: 127 })),
    );
    add("hostile ticks", true, (a, t) =>
      send(a, 1, false, () => inputBytes({ seq: a.sent, ack: 0, tick: t + 1000 })),
    );
    // Timeouts (exact, by ticks).
    add("silent", true, () => {});
    add("no HELLO", false, () => {});
    add("no READY", false, (a, t) => {
      if (t === ATTACK_TICK) a.raw.send(helloBytes(), true);
      else if ((t - ATTACK_TICK) % 60 === 0) send(a, 1, false, pingBytes);
    });
  }
  h.beforeServerTick = () => {
    const t = h.match.serverTick;
    for (const a of attackers) {
      if (a.join && t === 2) a.raw.send(helloBytes(), true);
      if (a.join && t === 3) a.raw.send(readyBytes(), true);
      if (t >= ATTACK_TICK && a.kickedAt < 0) a.step(a, t);
    }
  };
  h.afterServerTick = () => {
    for (const a of attackers) {
      if (a.kickedAt < 0 && a.raw.session?.state === SESSION_CLOSED) {
        a.kickedAt = h.match.serverTick;
        a.sentAtKick = a.sent;
      }
    }
  };
  h.run(10_500);
  expect(honest.client.active).toBe(true);
  return { h, attackers };
}

describe("NET-10: abuse (D-041): attackers kicked on schedule, honest clients untouched", () => {
  it("(a) kicks every attacker with its reason, on the computed schedule, and frees its slot", () => {
    const { h, attackers } = run(true);
    const control = run(false).h;
    const byName = new Map(attackers.map((a) => [a.name, a]));
    const of = (name: string) => byName.get(name) as Attacker;
    const ticks = (name: string) => of(name).kickedAt - ATTACK_TICK + 1;
    const report = attackers.map((a) => `${a.name}: ${kickReason(a)} after ${a.sentAtKick}`);
    console.log(`NET-10 (a): ${report.join("; ")}`);

    // Malformed: kicked within 6 packets; 2-point ones within 15.
    for (const name of ["garbage", "bad pitch", "bad axes", "spare bits"]) {
      expect(kickReason(of(name)), name).toBe("too many bad packets");
      expect(of(name).sentAtKick, name).toBe(LIMITS.strikeKick / STRIKE_MALFORMED);
    }
    for (const name of ["wrong channel", "out of state", "hostile acks", "HELLO flood"]) {
      expect(kickReason(of(name)), name).toBe("too many bad packets");
      expect(of(name).sentAtKick, name).toBe(LIMITS.strikeKick / STRIKE_UNEXPECTED);
    }
    expect(kickReason(of("random bytes"))).toMatch(/^(too many bad packets|malformed HELLO)$/);
    expect(of("random bytes").sentAtKick).toBeLessThanOrEqual(LIMITS.strikeKick / 2);

    // Floods by the kick-time formula (docs/05 §12): C / (r − f) ticks, then sv_strikeKick more.
    expect(kickReason(of("INPUT flood 3x"))).toBe("too many bad packets");
    expect(Math.abs(ticks("INPUT flood 3x") - floodKickTicks(3, 240, 2))).toBeLessThanOrEqual(3);
    expect(ticks("INPUT flood 3x")).toBeLessThanOrEqual(300);
    expect(Math.abs(ticks("INPUT flood 10x") - floodKickTicks(10, 240, 2))).toBeLessThanOrEqual(3);
    expect(ticks("INPUT flood 10x")).toBeLessThanOrEqual(72);
    expect(kickReason(of("reliable flood"))).toBe("too many bad packets");
    expect(Math.abs(ticks("reliable flood") - floodKickTicks(1, 20, 0.25))).toBeLessThanOrEqual(3);
    expect(ticks("reliable flood")).toBeLessThanOrEqual(72);
    expect(kickReason(of("CMD spam"))).toBe("too many bad packets");
    expect(ticks("CMD spam")).toBeLessThanOrEqual(72);
    // Bounded work: what a flooder got read never exceeds its bucket's capacity plus the refills;
    // the rest was dropped unread.
    const bounds: [string, number, number][] = [
      ["INPUT flood 3x", LIMITS.inputBurst, 2],
      ["INPUT flood 10x", LIMITS.inputBurst, 2],
      ["reliable flood", LIMITS.reliableBurst, 0.25],
      ["CMD spam", LIMITS.reliableBurst, 0.25],
    ];
    for (const [name, capacity, refill] of bounds) {
      const dropped = of(name).raw.session?.stats.rateLimited ?? 0;
      expect(dropped, name).toBeGreaterThan(0);
      expect(of(name).sentAtKick - dropped, name).toBeLessThanOrEqual(
        capacity + refill * ticks(name),
      );
    }
    // Bounded queues: a flood's cmds all name the coming tick, so its input queue took at most one
    // a tick and counted the rest as duplicates; the far-ahead ones were refused, not queued.
    for (const name of ["INPUT flood 3x", "INPUT flood 10x"]) {
      const queue = of(name).raw.session?.queue;
      expect(queue?.accepted ?? 0, name).toBeLessThanOrEqual(ticks(name));
      expect(queue?.duplicates ?? 0, name).toBeGreaterThan(0);
    }

    // Timeouts, exactly: the silent session's last packet was READY (tick 4's poll).
    expect(kickReason(of("silent"))).toBe("timed out");
    expect(of("silent").kickedAt).toBe(4 + LIMITS.timeout);
    expect(kickReason(of("no HELLO"))).toBe("handshake timed out");
    expect(of("no HELLO").kickedAt).toBe(LIMITS.helloTimeout);
    expect(kickReason(of("no READY"))).toBe("handshake timed out");
    expect(of("no READY").kickedAt).toBe(LIMITS.handshakeTimeout);

    // Legal or merely useless: not kicked, never struck.
    const yaw = of("yaw spam").raw.session;
    expect(yaw?.state).toBe(SESSION_ACTIVE);
    expect(yaw?.stats.strikes).toBe(0);
    const ahead = of("hostile ticks").raw.session;
    expect(ahead?.state).toBe(SESSION_ACTIVE);
    expect(ahead?.stats.strikes).toBe(0);
    expect(ahead?.queue.early).toBeGreaterThan(500);
    expect(ahead?.queue.accepted).toBe(0);

    // Every kicked slot is free; the server kept serving the honest client and the two legal ones.
    expect(h.match.sessionCount).toBe(3);
    for (const a of attackers) {
      if (a.name !== "yaw spam" && a.name !== "hostile ticks") {
        expect(a.kickedAt, a.name).toBeGreaterThan(0);
      }
    }
    expect(h.match.metrics.kicks).toBe(attackers.length - 2);

    // The honest client saw nothing: as in the run without attackers.
    const honest = h.clients[0];
    const alone = control.clients[0];
    expect(honest?.session?.stats.strikes).toBe(0);
    expect(honest?.session?.stats.rateLimited).toBe(0);
    expect(honest?.client.stats.totals[STAT_STRIKES]).toBe(0);
    expect(honest?.totals().corrections).toBe(0);
    expect(honest?.totals().starved).toBe(alone?.totals().starved);
    expect(honest?.session?.stats.starved).toBe(alone?.session?.stats.starved);
    expect(h.match.serverTick).toBe(control.match.serverTick);
    const a = honest?.session?.player;
    const b = alone?.session?.player;
    expect(a !== undefined && b !== undefined && playerStateEquals(a, b)).toBe(true);
  });

  it("(a) an honest client after a 3 s stall: its anchor fill is not rate limited or struck", () => {
    // The burstiest honest model: the worst NET profile, browser hitches bunching cmds into 3–5
    // tick frames, and a 3 s stall whose catch-up and fill land on the server within a few polls.
    const h = new MultiHarness({ timeouts: true });
    const c = h.addClient({
      input: new MixedInput(),
      profile: BAD250,
      frameIntervalMs: FRAMES_BROWSER_HITCHES,
    });
    let lowest = Number.POSITIVE_INFINITY;
    let watching = false;
    h.afterServerTick = () => {
      const level = c.session?.unreliableTokens.level ?? 0;
      if (watching && level < lowest) lowest = level;
    };
    h.run(3000);
    watching = true;
    c.hitch(3000);
    h.run(6000);
    const s = c.session;
    const drained = LIMITS.inputBurst - lowest / TOKEN_UNIT;
    console.log(`NET-10 (a) stall: ${drained} of ${LIMITS.inputBurst} unreliable tokens used`);
    expect(c.client.active).toBe(true);
    expect(c.totals().hardResyncs).toBeGreaterThanOrEqual(1);
    // The fill really bursts: far past a tick's two tokens and half the anchor fill's 64.
    expect(drained).toBeGreaterThanOrEqual(32);
    expect(s?.stats.strikes).toBe(0);
    expect(s?.stats.rateLimited).toBe(0);
    expect(h.match.metrics.strikes).toBe(0);
    expect(h.match.metrics.kicks).toBe(0);
  });
});

describe("NET-10 (b) smoke: the listener's limits on real sockets (D-041)", () => {
  it("admits sv_maxPerIp of simultaneous upgrades from one address; the hello timeout frees them", async () => {
    const server = await startServer({
      args: ["--port", "0", "--set", "sv_maxPerIp=3", "--set", "sv_helloTimeout=12"],
      cwd: fromRoot("packages", "server"),
      primer: false,
      peerAddress: (req) => String(req.headers[TEST_PEER_HEADER] ?? req.socket.remoteAddress),
    });
    try {
      const peer = { [TEST_PEER_HEADER]: "198.51.100.9" };
      const ups = await upgradeAtOnce(8, server.listener.port, peer);
      expect(ups.map((u) => u.status).sort()).toEqual([101, 101, 101, 429, 429, 429, 429, 429]);
      // None says HELLO: KICKed after 12 ticks, their slots freed. (The address keeps counting a
      // kicked socket until its closing handshake ends: these never answer it.)
      const match = server.matches.main?.match;
      const start = performance.now();
      while ((match?.metrics.kicks ?? 0) < 3 && performance.now() - start < 3000) {
        await new Promise((r) => setTimeout(r, 10));
      }
      expect(match?.metrics.kicks).toBe(3);
      await new Promise((r) => setTimeout(r, 50));
      expect(match?.sessionCount).toBe(0);
      closeAll(ups);
      while (
        server.listener.connectionsFrom("198.51.100.9") > 0 &&
        performance.now() - start < 3000
      ) {
        await new Promise((r) => setTimeout(r, 10));
      }
      expect(server.listener.connectionsFrom("198.51.100.9")).toBe(0);
    } finally {
      await server.stop();
    }
  });

  it("counts an upgrade still in its handshake: a second one from the address is refused", async () => {
    const server = await startServer({
      args: ["--port", "0", "--set", "sv_maxPerIp=1"],
      cwd: fromRoot("packages", "server"),
      primer: false,
      peerAddress: (req) => String(req.headers[TEST_PEER_HEADER] ?? req.socket.remoteAddress),
    });
    // Hold every handshake until the test lets it go, as a slow client's would be.
    const wss = (server.listener as unknown as { wss: { handleUpgrade: HandleUpgrade } }).wss;
    const real = wss.handleUpgrade.bind(wss);
    const held: (() => void)[] = [];
    wss.handleUpgrade = (...args) => {
      held.push(() => real(...args));
    };
    try {
      const peer = { [TEST_PEER_HEADER]: "198.51.100.10" };
      const first = upgrade(server.listener.port, peer);
      while (held.length === 0) await new Promise((r) => setTimeout(r, 5));
      expect(server.listener.connectionsFrom("198.51.100.10")).toBe(1);
      const second = await upgrade(server.listener.port, peer);
      expect(second.status).toBe(429);
      for (const go of held.splice(0)) go();
      const opened = await first;
      expect(opened.status).toBe(101);
      closeAll([opened]);
    } finally {
      await server.stop();
    }
  });
});

describe("hidden tab (D-041, M3 design §2.13): keepalive and the neutral cmd", () => {
  it("Node path: the session survives 20 s hidden, the player stops within 30 ticks", () => {
    const h = new MultiHarness({ timeouts: true });
    const c = h.addClient({ input: new MixedInput(), profile: WAN50 });
    h.run(3000);
    const s = c.session;
    const starvedBefore = s?.stats.starved ?? 0;
    // From the first starved tick: sv_starveNeutralTicks repeats of the last cmd, then neutral
    // ones; friction stops the player on the ground within 30 more (it may be mid-jump).
    let firstStarved = -1;
    let firstNeutral = -1;
    let stopped = -1;
    h.afterServerTick = () => {
      if (s === null) return;
      const t = h.match.serverTick;
      if (firstStarved < 0 && s.stats.starved > starvedBefore) firstStarved = t;
      if (firstNeutral < 0 && h.match.metrics.neutralTicks > 0) firstNeutral = t;
      const moving = Math.hypot(s.player.velocity[0], s.player.velocity[1]) > 0;
      if (firstNeutral >= 0 && stopped < 0 && !moving) stopped = t;
    };
    const beats = c.hide(20_000);
    h.run(2000);
    expect(firstStarved).toBeGreaterThan(0);
    expect(firstNeutral - firstStarved).toBe(LIMITS.starveNeutralTicks);
    expect(stopped - firstStarved).toBeLessThanOrEqual(LIMITS.starveNeutralTicks + 30);
    const v = s?.player.velocity;
    expect(Math.hypot(v?.[0] ?? 1, v?.[1] ?? 1)).toBe(0);
    h.afterServerTick = null;
    h.run(18_500);
    expect(beats.keepalives).toBeGreaterThanOrEqual(19);
    expect(s?.state).toBe(SESSION_ACTIVE);
    expect(h.match.metrics.kicks).toBe(0);
    expect((s?.stats.starved ?? 0) - starvedBefore).toBeGreaterThan(20 * 60 - 60);
    expect(h.match.metrics.neutralTicks).toBeGreaterThan(20 * 60 - 120);
    // Back: a full snapshot and a hard resync (one per poll the backlog spans; the link's delay
    // spreads it over two), no strike, and then no correction.
    h.run(1000);
    expect(c.client.active).toBe(true);
    expect(c.totals().hardResyncs).toBeGreaterThanOrEqual(1);
    expect(c.totals().hardResyncs).toBeLessThanOrEqual(2);
    const corrections = c.totals().corrections;
    h.run(2000);
    expect(c.totals().corrections).toBe(corrections);
    expect(s?.stats.strikes).toBe(0);
    expect(c.client.stats.totals[STAT_STRIKES]).toBe(0);
  });

  it("Node path without the keepalive: the server times the session out after 5 s", () => {
    const h = new MultiHarness({ timeouts: true });
    const c = h.addClient({ input: new MixedInput(), profile: WAN50 });
    h.run(2000);
    c.hitch(8000);
    h.run(6000);
    expect(c.session?.state).toBe(SESSION_CLOSED);
    expect(h.match.sessionCount).toBe(0);
    h.run(3000);
    expect(c.client.closed).toBe(true);
    expect(c.client.connection.closeReason).toBe("kicked: timed out");
  });

  it("Worker path: no timeouts, the session survives hidden with or without keepalives", () => {
    const h = new MultiHarness();
    const kept = h.addClient({ input: new MixedInput(), profile: WAN50 });
    const bare = h.addClient({ input: new MixedInput(), profile: WAN50 });
    h.run(2000);
    kept.hide(15_000);
    bare.hitch(15_000);
    h.run(18_000);
    for (const c of [kept, bare]) {
      expect(c.client.active).toBe(true);
      expect(c.session?.state).toBe(SESSION_ACTIVE);
      expect(c.totals().hardResyncs).toBeGreaterThanOrEqual(1);
      expect(c.totals().hardResyncs).toBeLessThanOrEqual(2);
      expect(c.session?.stats.strikes).toBe(0);
    }
  });
});
