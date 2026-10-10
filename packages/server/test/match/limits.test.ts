import {
  BitWriter,
  BUTTON_ATTACK,
  BUTTON_SPRINT,
  buildCollisionWorld,
  type CloseHandler,
  createLoopbackPair,
  degreesToU16,
  encodeHello,
  HelloMsg,
  type MessageHandler,
  PMF_GROUNDED,
  PRINT_WARN,
  type Transport,
  TransportStats,
  UserCmd,
} from "@game/shared";
import { describe, expect, it } from "vitest";
import type { MatchEventValue } from "../../src/match/host";
import {
  RELIABLE_REFILL_UNITS,
  SessionLimits,
  STRIKE_DECAY_TICKS,
  STRIKE_KICK,
  STRIKE_MALFORMED,
  STRIKE_OK,
  STRIKE_RATE_LIMITED,
  STRIKE_UNEXPECTED,
  STRIKE_WARN,
  StrikeScore,
  TOKEN_UNIT,
  TokenBucket,
  UNRELIABLE_REFILL_UNITS,
} from "../../src/match/limits";
import { Match, type MatchOptions } from "../../src/match/match";
import { SESSION_ACTIVE } from "../../src/match/session";
import { loadMap, TEST_BUILD, TestClient } from "./fixtures";

// Session security (M3 design §2.13, §2.5 steps 1–5, D-041): the buckets and the strike score
// alone, then in the match: rate limits, strike weights, warn and kick, timeouts by ticks (off by
// default, as in the Worker), the neutral cmd after sv_starveNeutralTicks starved ticks, the
// input-loss count and the structured session events.

const cmap = loadMap("movement_lab");
const world = buildCollisionWorld(cmap);

function newMatch(options: Partial<MatchOptions> = {}): Match {
  return new Match({ cmap, world, buildHash: TEST_BUILD, primer: false, ...options });
}

function connect(match: Match): TestClient {
  const [clientEnd, serverEnd] = createLoopbackPair();
  const client = new TestClient(clientEnd);
  match.connect(serverEnd);
  return client;
}

function run(match: Match, client: TestClient | null, n: number): void {
  for (let i = 0; i < n; i++) {
    match.tick();
    client?.poll();
  }
}

function joined(match: Match): TestClient {
  const client = connect(match);
  client.hello();
  run(match, client, 1);
  client.ready();
  run(match, client, 1);
  return client;
}

/** A server-side transport fed by the test: messages of any length, on either channel. */
class FeedTransport implements Transport {
  readonly queued: [Uint8Array, boolean][] = [];
  private cb: MessageHandler = () => {};
  private open = true;
  private readonly counters = new TransportStats();
  sendUnreliable(): void {}
  sendReliable(): void {}
  onMessage(cb: MessageHandler): void {
    this.cb = cb;
  }
  onClose(_cb: CloseHandler): void {}
  poll(): void {
    for (const [d, reliable] of this.queued.splice(0))
      if (this.open) this.cb(d, d.length, reliable);
  }
  close(): void {
    this.open = false;
  }
  isOpen(): boolean {
    return this.open;
  }
  stats(): TransportStats {
    return this.counters;
  }
}

function cmdAt(tick: number, forward = 0, yaw = 0): UserCmd {
  const c = new UserCmd();
  c.tick = tick;
  c.forward = forward;
  c.yaw = yaw;
  return c;
}

describe("TokenBucket", () => {
  it("starts full, takes one token per packet and refills in fixed point", () => {
    const b = new TokenBucket();
    b.configure(20, RELIABLE_REFILL_UNITS);
    for (let i = 0; i < 20; i++) expect(b.take()).toBe(true);
    expect(b.take()).toBe(false);
    // 0.25 a tick: a token every 4 ticks, exactly.
    for (let i = 0; i < 3; i++) b.refill();
    expect(b.take()).toBe(false);
    b.refill();
    expect(b.take()).toBe(true);
    expect(b.level).toBe(0);
    for (let i = 0; i < 1000; i++) b.refill();
    expect(b.level).toBe(20 * TOKEN_UNIT);
  });

  it("refills the unreliable bucket by 2 a tick: a client at 1 packet a tick never runs dry", () => {
    const b = new TokenBucket();
    b.configure(64, UNRELIABLE_REFILL_UNITS);
    for (let t = 0; t < 10_000; t++) {
      b.refill();
      expect(b.take()).toBe(true);
    }
    expect(b.level).toBe(64 * TOKEN_UNIT - TOKEN_UNIT);
  });
});

describe("StrikeScore", () => {
  it("warns once at the warn level, kicks at the kick level and decays 1 a second", () => {
    const s = new StrikeScore();
    expect(s.add(10, 15, 30)).toBe(STRIKE_OK);
    expect(s.add(5, 15, 30)).toBe(STRIKE_WARN);
    expect(s.add(5, 15, 30)).toBe(STRIKE_OK);
    for (let i = 0; i < STRIKE_DECAY_TICKS - 1; i++) s.tick();
    expect(s.score).toBe(20);
    s.tick();
    expect(s.score).toBe(19);
    expect(s.add(11, 15, 30)).toBe(STRIKE_KICK);
  });

  it("warns again only after the score went back to 0", () => {
    const s = new StrikeScore();
    expect(s.add(16, 15, 30)).toBe(STRIKE_WARN);
    for (let i = 0; i < 2 * STRIKE_DECAY_TICKS; i++) s.tick();
    expect(s.add(2, 15, 30)).toBe(STRIKE_OK);
    for (let i = 0; i < 17 * STRIKE_DECAY_TICKS + 1; i++) s.tick();
    expect(s.score).toBe(0);
    expect(s.add(15, 15, 30)).toBe(STRIKE_WARN);
  });
});

describe("match rate limits and strikes (D-041)", () => {
  it("drops packets past the unreliable bucket and strikes each rate-limited tick once", () => {
    const limits = new SessionLimits();
    limits.inputBurst = 64;
    const match = newMatch({ limits });
    const client = joined(match);
    const s = match.session(0);
    // 70 PINGs in one tick: the bucket holds 64 (one refill of 2 on top is capped).
    for (let i = 0; i < 70; i++) client.ping(i);
    run(match, client, 1);
    expect(client.pongs).toHaveLength(64);
    expect(s?.stats.rateLimited).toBe(6);
    expect(s?.stats.rateLimitedTicks).toBe(1);
    expect(s?.stats.strikes).toBe(STRIKE_RATE_LIMITED);
    // Two a tick refill: 3 a tick is limited every tick once the bucket is empty.
    for (let t = 0; t < 10; t++) {
      for (let i = 0; i < 3; i++) client.ping(i);
      run(match, client, 1);
    }
    expect(s?.stats.rateLimitedTicks).toBe(11);
    expect(s?.stats.strikes).toBe(11 * STRIKE_RATE_LIMITED);
  });

  it("strikes an unreliable message over 1200 B as malformed, before the rate limit", () => {
    const limits = new SessionLimits();
    limits.inputBurst = 64;
    const match = newMatch({ limits });
    const t = new FeedTransport();
    match.connect(t);
    // The loopback refuses such a length; a socket's transport marks it (length 0) instead.
    const w = new BitWriter(64);
    const hello = new HelloMsg();
    hello.buildHash = TEST_BUILD;
    encodeHello(w, hello);
    t.queued.push([w.bytes.slice(0, w.byteLength), true]);
    // 64 PINGs empty the bucket; the big one is struck without a token, the 66th dropped.
    for (let i = 0; i < 64; i++) t.queued.push([new Uint8Array([6, 1, 0]), false]);
    t.queued.push([new Uint8Array(1201), false]);
    t.queued.push([new Uint8Array([6, 1, 0]), false]);
    run(match, null, 1);
    expect(match.metrics.strikes).toBe(STRIKE_MALFORMED + STRIKE_RATE_LIMITED);
    expect(match.metrics.rateLimited).toBe(1);
  });

  it("strikes the socket transport's empty marker as oversized, even with the bucket empty", () => {
    const limits = new SessionLimits();
    limits.inputBurst = 64;
    const match = newMatch({ limits });
    const t = new FeedTransport();
    match.connect(t);
    const w = new BitWriter(64);
    const hello = new HelloMsg();
    hello.buildHash = TEST_BUILD;
    encodeHello(w, hello);
    t.queued.push([w.bytes.slice(0, w.byteLength), true]);
    // WsTransport queues an unreliable frame past 1200 B with length 0: struck +5, no token.
    for (let i = 0; i < 64; i++) t.queued.push([new Uint8Array([6, 1, 0]), false]);
    t.queued.push([new Uint8Array(0), false]);
    t.queued.push([new Uint8Array([6, 1, 0]), false]);
    run(match, null, 1);
    expect(match.metrics.strikes).toBe(STRIKE_MALFORMED + STRIKE_RATE_LIMITED);
    expect(match.metrics.rateLimited).toBe(1);
  });

  it("strikes a PING before HELLO as unexpected and answers nothing", () => {
    const match = newMatch();
    const client = connect(match);
    client.ping(1);
    run(match, client, 1);
    expect(client.pongs).toHaveLength(0);
    expect(match.metrics.strikes).toBe(STRIKE_UNEXPECTED);
    client.hello();
    run(match, client, 1);
    client.ping(2);
    run(match, client, 1);
    expect(client.pongs).toHaveLength(1);
    expect(match.metrics.strikes).toBe(STRIKE_UNEXPECTED);
  });

  it("stops reading a garbage flood at the kick, whatever its sizes", () => {
    const limits = new SessionLimits();
    limits.inputBurst = 64;
    const match = newMatch({ limits });
    const t = new FeedTransport();
    match.connect(t);
    t.queued.push([new Uint8Array(1201), false]);
    for (let i = 0; i < 100; i++) t.queued.push([new Uint8Array([0xee]), false]);
    run(match, null, 1);
    // The oversized one (5) and five unknown ones (25) kick; the rest is never looked at.
    expect(match.metrics.strikes).toBe(6 * STRIKE_MALFORMED);
    expect(match.metrics.kicks).toBe(1);
  });

  it("warns once at sv_strikeWarn and kicks at sv_strikeKick, freeing the slot", () => {
    const match = newMatch();
    const client = joined(match);
    // Wrong channel: 2 points each. 8 → 16 points (warned), 15 → 30 (kicked).
    for (let i = 0; i < 8; i++) client.raw(new Uint8Array([6, 1, 0]), true);
    run(match, client, 1);
    expect(client.prints.filter((p) => p.level === PRINT_WARN)).toHaveLength(1);
    expect(match.session(0)?.state).toBe(SESSION_ACTIVE);
    for (let i = 0; i < 7; i++) client.raw(new Uint8Array([6, 1, 0]), true);
    run(match, client, 1);
    expect(client.kicks.map((k) => k.reason)).toEqual(["too many bad packets"]);
    expect(match.metrics.kicks).toBe(1);
    run(match, client, 1);
    expect(match.sessionCount).toBe(0);
  });

  it("kicks within 6 malformed packets, reading nothing after the kick", () => {
    const match = newMatch();
    const client = joined(match);
    for (let i = 0; i < 20; i++) client.raw(new Uint8Array([4, 1, 2, 3]), false);
    run(match, client, 1);
    expect(client.kicks.map((k) => k.reason)).toEqual(["too many bad packets"]);
    expect(match.metrics.strikes).toBe(6 * STRIKE_MALFORMED);
  });

  it("decays the score: one 2-point packet every 2 s for a minute is never kicked", () => {
    const match = newMatch();
    const client = joined(match);
    for (let t = 0; t < 3600; t++) {
      if (t % 120 === 0) client.raw(new Uint8Array([6, 1, 0]), true);
      run(match, null, 1);
    }
    client.poll();
    expect(client.kicks).toHaveLength(0);
    expect(match.session(0)?.strikeScore.score).toBeLessThanOrEqual(STRIKE_UNEXPECTED);
  });

  it("counts lost INPUTs from packetSeq gaps; reordered ones count nothing", () => {
    const match = newMatch();
    const client = joined(match);
    const t0 = client.lastSnapshot().serverTick;
    // Sequences 0, 1, (2 and 3 lost) 4, then a late 2.
    const seqs = [0, 1, 4, 2];
    for (let i = 0; i < seqs.length; i++) {
      (client as unknown as { packetSeq: number }).packetSeq = seqs[i] as number;
      client.input([cmdAt(t0 + 1 + i)]);
      run(match, client, 1);
    }
    const s = match.session(0);
    expect(s?.stats.inputPackets).toBe(4);
    expect(s?.stats.inputLost).toBe(2);
    expect(match.metrics.inputLost).toBe(2);
    expect(s?.stats.strikes).toBe(0);
  });
});

describe("match timeouts (D-041)", () => {
  function timed(): Match {
    return newMatch({ timeouts: true });
  }

  it("kicks a connection without HELLO at exactly sv_helloTimeout ticks", () => {
    const match = timed();
    run(match, null, 5);
    const client = connect(match);
    run(match, client, 119);
    expect(client.kicks).toHaveLength(0);
    run(match, client, 1);
    expect(client.kicks.map((k) => k.reason)).toEqual(["handshake timed out"]);
  });

  it("kicks a session that never sends READY at exactly sv_handshakeTimeout ticks", () => {
    const match = timed();
    const client = connect(match);
    client.hello();
    // PINGs keep it from the idle timeout; the handshake still has to finish.
    for (let t = 1; t < 600; t++) {
      if (t % 60 === 0) client.ping(t);
      run(match, null, 1);
    }
    client.poll();
    expect(client.kicks).toHaveLength(0);
    run(match, client, 1);
    expect(client.kicks.map((k) => k.reason)).toEqual(["handshake timed out"]);
  });

  it("kicks a welcomed session silent for exactly sv_timeout ticks, before the handshake limit", () => {
    const match = timed();
    run(match, null, 7);
    const client = connect(match);
    client.hello();
    // HELLO arrives in the poll of tick 8; nothing after it.
    run(match, client, 1);
    run(match, null, 299);
    client.poll();
    expect(client.kicks).toHaveLength(0);
    run(match, client, 1);
    expect(client.kicks.map((k) => k.reason)).toEqual(["timed out"]);
    expect(match.serverTick).toBe(8 + 300);
  });

  it("kicks an active session silent for exactly sv_timeout ticks", () => {
    const match = timed();
    const client = joined(match);
    // READY arrived in the poll of tick 2: silent from then on.
    run(match, null, 299);
    client.poll();
    expect(client.kicks).toHaveLength(0);
    run(match, client, 1);
    expect(client.kicks.map((k) => k.reason)).toEqual(["timed out"]);
    expect(match.serverTick).toBe(2 + 300);
  });

  it("keeps a session that sends one packet a second, and times nobody out by default", () => {
    const match = timed();
    const client = joined(match);
    const quiet = newMatch();
    const idle = joined(quiet);
    for (let t = 0; t < 900; t++) {
      if (t % 60 === 0) client.ping(t);
      run(match, null, 1);
      run(quiet, null, 1);
    }
    client.poll();
    idle.poll();
    expect(client.kicks).toHaveLength(0);
    expect(idle.kicks).toHaveLength(0);
    expect(quiet.session(0)?.state).toBe(SESSION_ACTIVE);
  });

  it("reads lowered limits", () => {
    const limits = new SessionLimits();
    limits.helloTimeout = 10;
    const match = newMatch({ timeouts: true, limits });
    const client = connect(match);
    run(match, client, 10);
    expect(client.kicks.map((k) => k.reason)).toEqual(["handshake timed out"]);
  });
});

describe("starved-cmd neutralisation (M3 design §2.5 step 5)", () => {
  it("repeats the last cmd for sv_starveNeutralTicks starved ticks, then stands still", () => {
    const match = newMatch();
    const client = joined(match);
    const s = match.session(0);
    const t0 = client.lastSnapshot().serverTick;
    const yaw = degreesToU16(90);
    // Sprinting forward and strafing (the swim axis held too) for 60 ticks, then nothing (a
    // hidden tab, a dead client).
    for (let i = 1; i <= 60; i++) {
      const c = cmdAt(t0 + i, 127, yaw);
      c.right = 40;
      c.up = 30;
      c.buttons = BUTTON_SPRINT | BUTTON_ATTACK;
      client.input([c]);
      run(match, client, 1);
    }
    expect(s?.stats.starved).toBe(0);
    const speed = () => Math.hypot(s?.player.velocity[0] ?? 0, s?.player.velocity[1] ?? 0);
    expect(speed()).toBeGreaterThan(200);
    run(match, client, 30);
    expect(s?.stats.starved).toBe(30);
    expect(match.metrics.neutralTicks).toBe(0);
    expect(s?.lastCmd.forward).toBe(127);
    expect(s?.lastCmd.right).toBe(40);
    expect(s?.lastCmd.buttons).toBe(BUTTON_SPRINT);
    expect(speed()).toBeGreaterThan(200);
    run(match, client, 30);
    expect(match.metrics.neutralTicks).toBe(30);
    expect(s?.lastCmd.forward).toBe(0);
    expect(s?.lastCmd.right).toBe(0);
    expect(s?.lastCmd.up).toBe(0);
    expect(s?.lastCmd.buttons).toBe(0);
    expect(s?.lastCmd.yaw).toBe(yaw);
    // Ground friction stops it within the 30 neutral ticks.
    expect(speed()).toBe(0);
    expect((s?.player.flags ?? 0) & PMF_GROUNDED).not.toBe(0);
    // A cmd that arrives in time ends the run.
    const t1 = match.serverTick;
    client.input([cmdAt(t1 + 1, 127, yaw)]);
    run(match, client, 1);
    expect(s?.starvedRun).toBe(0);
    run(match, client, 1);
    expect(s?.lastCmd.forward).toBe(127);
  });
  it("restarts the count at a spawn: a respawn mid-run gets sv_starveNeutralTicks repeats again", () => {
    const match = newMatch();
    const client = joined(match);
    const s = match.session(0) as NonNullable<ReturnType<Match["session"]>>;
    const t0 = client.lastSnapshot().serverTick;
    for (let i = 1; i <= 10; i++) {
      client.input([cmdAt(t0 + i, 127)]);
      run(match, client, 1);
    }
    run(match, client, 20);
    expect(s.starvedRun).toBe(20);
    expect(match.respawn(s)).toBe(true);
    expect(s.starvedRun).toBe(0);
    // The spawn tick is not simulated; then 30 repeats before the first neutral cmd.
    run(match, client, 1 + 30);
    expect(match.metrics.neutralTicks).toBe(0);
    run(match, client, 1);
    expect(match.metrics.neutralTicks).toBe(1);
  });
});

describe("structured session events", () => {
  it("reports welcome, ready, kick (reason, strike score) and leave as fields", () => {
    const events: [string, Readonly<Record<string, MatchEventValue>>][] = [];
    const match = newMatch({ events: (_level, ev, fields) => events.push([ev, fields]) });
    const client = joined(match);
    for (let i = 0; i < 15; i++) client.raw(new Uint8Array([6, 1, 0]), true);
    run(match, client, 1);
    const other = connect(match);
    other.hello();
    run(match, other, 1);
    other.transport.close("bye");
    run(match, other, 1);
    expect(events).toEqual([
      ["welcome", { client: 0, build: TEST_BUILD }],
      ["ready", { client: 0, tick: 2, team: 1 }],
      ["kick", { client: 0, reason: "too many bad packets", strikes: 30 }],
      ["welcome", { client: 0, build: TEST_BUILD }],
      ["leave", { client: 0, reason: "bye" }],
    ]);
  });
});
