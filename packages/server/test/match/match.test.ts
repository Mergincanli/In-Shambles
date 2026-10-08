import {
  applyCvarBlock,
  BUTTON_ATTACK,
  BUTTON_JUMP,
  buildCollisionWorld,
  type CloseHandler,
  CvarBlock,
  CvarRegistry,
  copyPlayerState,
  createLoopbackPair,
  cvarHash16,
  degreesToU16,
  ENTITY_FLAG_MASK,
  ENTITY_WORLD,
  entityVelocity,
  frameDigest,
  type MessageHandler,
  MSG_CMD,
  MSG_HELLO,
  MSG_INPUT,
  MSG_PING,
  MSG_READY,
  MSG_SNAPSHOT,
  Mulberry32,
  PlayerState,
  PMF_GROUNDED,
  PmoveParams,
  PRINT_ERROR,
  PRINT_INFO,
  PRINT_WARN,
  PROTOCOL_VERSION,
  playerStateEquals,
  pmove,
  refreshPmoveParams,
  registerPmoveCvars,
  registryCvarHash,
  SNAP_FIT_MAX_PLAYERS,
  SNAP_FLAG_STARVED,
  sanitizeUserCmd,
  TICK_DT,
  TICK_RATE,
  TRACE_EPSILON,
  type Transport,
  TransportStats,
  UserCmd,
} from "@game/shared";
import { describe, expect, it } from "vitest";
import {
  effectiveMaxClients,
  MATCH_DEFAULT_MAX_CLIENTS,
  MATCH_MAX_CLIENTS,
  Match,
  SPAWN_STAMINA,
} from "../../src/match/match";
import { SESSION_ACTIVE, SESSION_CONNECTING, SESSION_WELCOMED } from "../../src/match/session";
import { loadMap, TEST_BUILD, TestClient } from "./fixtures";

const cmap = loadMap("movement_lab");
const world = buildCollisionWorld(cmap);
const spawnEntity = cmap.entities.find((e) => e.classname === "info_player_start");

function newMatch(cvars?: CvarRegistry): Match {
  return new Match({ cmap, world, buildHash: TEST_BUILD, ...(cvars ? { cvars } : {}) });
}

/**
 * A server-side transport fed by the test that, unlike the loopback, keeps delivering what is
 * queued after it was closed (a socket may still hold packets), so the match's own guard shows.
 */
class BurstTransport implements Transport {
  readonly queued: [Uint8Array, boolean][] = [];
  readonly sent: Uint8Array[] = [];
  private messageCb: MessageHandler = () => {};
  private readonly counters = new TransportStats();
  private open = true;
  sendUnreliable(d: Uint8Array, len: number): void {
    this.sent.push(d.slice(0, len));
  }
  sendReliable(d: Uint8Array, len: number): void {
    this.sent.push(d.slice(0, len));
  }
  onMessage(cb: MessageHandler): void {
    this.messageCb = cb;
  }
  onClose(_cb: CloseHandler): void {}
  poll(): void {
    for (const [d, reliable] of this.queued.splice(0)) this.messageCb(d, d.length, reliable);
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

/** A client connected to `match` over a loopback pair; not yet past HELLO. */
function connect(match: Match, admin = false): TestClient {
  const [clientEnd, serverEnd] = createLoopbackPair();
  const client = new TestClient(clientEnd);
  match.connect(serverEnd, admin);
  return client;
}

/** Runs `n` match ticks, letting the client read what each sent. */
function run(match: Match, client: TestClient | null, n: number): void {
  for (let i = 0; i < n; i++) {
    match.tick();
    client?.poll();
  }
}

/** A client that has spawned: HELLO, READY, and the spawn tick's snapshot read. */
function joined(match: Match, admin = false): TestClient {
  const client = connect(match, admin);
  client.hello();
  run(match, client, 1);
  client.ready();
  run(match, client, 1);
  return client;
}

function cmdAt(tick: number, forward = 0, buttons = 0, yaw = 0): UserCmd {
  const c = new UserCmd();
  c.tick = tick;
  c.forward = forward;
  c.buttons = buttons;
  c.yaw = yaw;
  return c;
}

/** An INPUT packet's bytes and length, as a client encodes it. */
function encodedInput(cmds: readonly UserCmd[]): [Uint8Array, number] {
  const [a, b] = createLoopbackPair();
  let out: [Uint8Array, number] = [new Uint8Array(0), 0];
  b.onMessage((d, len) => {
    out = [d.slice(0, len), len];
  });
  new TestClient(a).input(cmds);
  b.poll();
  return out;
}

describe("match handshake", () => {
  it("answers HELLO with WELCOME: id, tick rate, server tick, map, map hash, cvar block", () => {
    const match = newMatch();
    run(match, null, 3);
    const client = connect(match);
    client.hello();
    run(match, client, 1);
    expect(client.welcomes).toHaveLength(1);
    const w = client.welcomes[0];
    expect(w?.protocolVersion).toBe(PROTOCOL_VERSION);
    expect(w?.clientId).toBe(0);
    expect(w?.tickRate).toBe(TICK_RATE);
    // HELLO was handled at the start of tick 4: the newest tick simulated was 3.
    expect(w?.serverTick).toBe(3);
    expect(w?.mapName).toBe("movement_lab");
    const hex = (w?.mapHashHi ?? 0).toString(16).padStart(8, "0");
    expect(hex + (w?.mapHashLo ?? 0).toString(16).padStart(8, "0")).toBe(cmap.contentHash);
    // The block is exactly the server's replicated cvars: a mirror takes it and hashes the same.
    const mirror = new CvarRegistry();
    registerPmoveCvars(mirror);
    mirror.set("pm_gravity", 123);
    expect(applyCvarBlock(mirror, w?.cvars ?? new CvarBlock())).toMatchObject({ ok: true });
    expect(registryCvarHash(mirror)).toBe(match.cvarHash);
    expect(match.session(0)?.state).toBe(SESSION_WELCOMED);
    expect(client.bad).toBe(0);
  });

  it("gives clients the lowest free id and keeps them in id order", () => {
    const match = newMatch();
    const a = connect(match);
    const b = connect(match);
    a.hello();
    b.hello();
    run(match, null, 1);
    a.poll();
    b.poll();
    expect(a.welcomes[0]?.clientId).toBe(0);
    expect(b.welcomes[0]?.clientId).toBe(1);
    a.transport.close("bye");
    run(match, null, 1);
    expect(match.sessionCount).toBe(1);
    const c = connect(match);
    c.hello();
    run(match, c, 1);
    expect(c.welcomes[0]?.clientId).toBe(0);
    // Sessions stay sorted by id, so the next free id is 2, not a second 0.
    const d = connect(match);
    d.hello();
    run(match, d, 1);
    expect(d.welcomes[0]?.clientId).toBe(2);
  });

  it("handles clients in id order within a tick", () => {
    const logs: string[] = [];
    const match = new Match({
      cmap,
      world,
      buildHash: TEST_BUILD,
      log: (_level, msg) => logs.push(msg),
    });
    const clients = [connect(match), connect(match), connect(match)];
    for (const c of clients) c.hello();
    run(match, null, 1);
    clients[1]?.transport.close("bye");
    run(match, null, 1);
    const again = connect(match);
    again.hello();
    run(match, null, 1);
    // Reverse send order; the poll order is the id order all the same.
    for (const c of [again, clients[2], clients[0]]) c?.ready();
    logs.length = 0;
    run(match, null, 1);
    expect(logs).toEqual([
      "client 0 spawned at tick 4",
      "client 1 spawned at tick 4",
      "client 2 spawned at tick 4",
    ]);
  });

  it("admits sv_maxClients (default 32) and kicks the 33rd with server full (D-034)", () => {
    const match = newMatch();
    expect(match.maxClients).toBe(MATCH_DEFAULT_MAX_CLIENTS);
    expect(MATCH_DEFAULT_MAX_CLIENTS).toBe(32);
    for (let i = 0; i < 32; i++) expect(connect(match)).toBeInstanceOf(TestClient);
    const [clientEnd, serverEnd] = createLoopbackPair();
    const late = new TestClient(clientEnd);
    expect(match.connect(serverEnd)).toBeNull();
    late.poll();
    expect(late.kicks[0]?.reason).toBe("server full");
    expect(late.closed).toBe("server full");
    expect(match.sessionCount).toBe(32);
    expect(match.session(31)).toBeDefined();
  });

  it("clamps sv_maxClients to 1–37 until the byte-budget scheduler (D-034)", () => {
    expect(MATCH_MAX_CLIENTS).toBe(64);
    expect(SNAP_FIT_MAX_PLAYERS).toBe(37);
    expect([0, 1, 16, 32, 37, 38, 64, 1000].map(effectiveMaxClients)).toEqual([
      1, 1, 16, 32, 37, 37, 37, 37,
    ]);
    // A non-finite request is the default, not a match that refuses everyone.
    expect([Number.NaN, Number.POSITIVE_INFINITY, -1.5, 37.9].map(effectiveMaxClients)).toEqual([
      MATCH_DEFAULT_MAX_CLIENTS,
      MATCH_DEFAULT_MAX_CLIENTS,
      1,
      37,
    ]);
    expect(
      new Match({ cmap, world, buildHash: TEST_BUILD, maxClients: Number.NaN }).maxClients,
    ).toBe(MATCH_DEFAULT_MAX_CLIENTS);
    const full = new Match({ cmap, world, buildHash: TEST_BUILD, maxClients: MATCH_MAX_CLIENTS });
    expect(full.maxClients).toBe(37);
    for (let i = 0; i < 37; i++) connect(full);
    const [, serverEnd] = createLoopbackPair();
    expect(full.connect(serverEnd)).toBeNull();
    const duel = new Match({ cmap, world, buildHash: TEST_BUILD, maxClients: 2 });
    const left = connect(duel);
    connect(duel);
    expect(duel.connect(createLoopbackPair()[1])).toBeNull();
    // Ids stay the lowest free below the cap: a freed id is reused.
    left.transport.close("bye");
    run(duel, null, 1);
    expect(duel.connect(createLoopbackPair()[1])?.clientId).toBe(0);
  });

  it("kicks a client with another protocol version, saying why, and drops it", () => {
    const match = newMatch();
    const client = connect(match);
    client.hello(TEST_BUILD, PROTOCOL_VERSION + 1);
    run(match, client, 1);
    expect(client.welcomes).toHaveLength(0);
    expect(client.kicks[0]?.reason).toBe(
      `protocol version ${PROTOCOL_VERSION + 1} is not supported; this server speaks ${PROTOCOL_VERSION}`,
    );
    expect(client.closed).not.toBeNull();
    expect(match.sessionCount).toBe(0);
    expect(match.metrics.kicks).toBe(1);
  });

  it("kicks a client built from another build, naming both builds", () => {
    const match = newMatch();
    expect(match.strictBuild).toBe(true);
    const client = connect(match);
    client.hello("other-build");
    run(match, client, 1);
    expect(client.kicks[0]?.reason).toBe(
      `build other-build does not match the server's ${TEST_BUILD}`,
    );
    expect(client.closed).not.toBeNull();
    expect(match.sessionCount).toBe(0);
  });

  it("lets another build in with a warning when strictBuild is off (sv_strictBuild 0, D-031)", () => {
    const match = new Match({ cmap, world, buildHash: TEST_BUILD, strictBuild: false });
    const client = connect(match);
    client.hello("other-build");
    run(match, client, 1);
    expect(client.kicks).toEqual([]);
    expect(client.welcomes).toHaveLength(1);
    expect(client.prints.map((p) => [p.level, p.text])).toEqual([
      [
        PRINT_WARN,
        `build other-build differs from the server's ${TEST_BUILD}; ` +
          "sv_strictBuild 0 lets it play, but the two may disagree",
      ],
    ]);
    // The same build gets no warning; another protocol version is refused either way.
    const same = connect(match);
    same.hello();
    const old = connect(match);
    old.hello(TEST_BUILD, PROTOCOL_VERSION + 1);
    run(match, same, 1);
    old.poll();
    expect(same.prints).toEqual([]);
    expect(old.kicks[0]?.reason).toMatch(/^protocol version/);
  });

  it("kicks a malformed HELLO with a strike", () => {
    const match = newMatch();
    const client = connect(match);
    client.raw(new Uint8Array([1, PROTOCOL_VERSION, 0, 0xff]), true);
    run(match, client, 1);
    expect(client.kicks[0]?.reason).toBe("malformed HELLO");
    expect(match.metrics.strikes).toBe(1);
  });

  it("answers PING with PONG after WELCOME, carrying the newest tick simulated", () => {
    const match = newMatch();
    const client = connect(match);
    client.ping(7);
    run(match, client, 1);
    expect(client.pongs).toHaveLength(0);
    client.hello();
    run(match, client, 4);
    client.ping(8);
    run(match, client, 1);
    expect(client.pongs.map((p) => [p.pingId, p.serverTick])).toEqual([[8, 5]]);
  });

  it("strikes packets that don't decode, arrive on the wrong channel or don't belong", () => {
    const match = newMatch();
    const client = joined(match);
    const s = match.session(0);
    client.raw(new Uint8Array([MSG_INPUT, 1, 2]), false);
    client.raw(new Uint8Array([0xee, 0, 0]), true);
    client.ping(1);
    client.hello(); // a second HELLO
    client.ready(); // a second READY
    run(match, client, 1);
    expect(s?.stats.strikes).toBe(4);
    // PING on the reliable channel.
    client.raw(new Uint8Array([6, 1, 0]), true);
    run(match, client, 1);
    expect(s?.stats.strikes).toBe(5);
    expect(match.metrics.strikes).toBe(5);
    expect(s?.state).toBe(SESSION_ACTIVE);
    // A valid INPUT on the reliable channel: a strike, nothing queued.
    const [d, len] = encodedInput([cmdAt(match.serverTick + 1)]);
    client.raw(d.slice(0, len), true);
    run(match, client, 1);
    expect(s?.stats.strikes).toBe(6);
    expect(s?.queue.accepted).toBe(0);
  });

  it("strikes READY and CMD before HELLO", () => {
    const match = newMatch();
    const client = connect(match, true);
    client.ready();
    client.cmd("set pm_gravity 100");
    run(match, client, 2);
    const s = match.session(0);
    expect(s?.stats.strikes).toBe(2);
    expect(s?.state).toBe(SESSION_CONNECTING);
    expect(client.snapshots).toHaveLength(0);
    expect(client.prints).toHaveLength(0);
    expect(match.cvars.get("pm_gravity")).toBe(800);
  });

  it("ignores what a session sends after it was kicked in the same poll", () => {
    const match = newMatch();
    const t = new BurstTransport();
    match.connect(t);
    t.queued.push([new Uint8Array([MSG_HELLO, PROTOCOL_VERSION, 0, 0xff]), true]);
    t.queued.push([new Uint8Array([0xee, 0, 0]), true]);
    t.queued.push([new Uint8Array([MSG_PING, 0, 0]), false]);
    run(match, null, 1);
    expect(match.metrics.kicks).toBe(1);
    // The malformed HELLO's strike only; the packets after the kick are not looked at.
    expect(match.metrics.strikes).toBe(1);
    expect(t.sent).toHaveLength(1);
    expect(match.sessionCount).toBe(0);
  });
});

describe("match spawn and simulation", () => {
  it("READY spawns at info_player_start, one ε above the floor, at rest and grounded", () => {
    const match = newMatch();
    run(match, null, 2);
    const client = joined(match);
    const snap = client.lastSnapshot();
    expect(snap.serverTick).toBe(4);
    // The spawn steps the slot's teleport counter (D-035); no flag is set.
    expect(snap.flags).toBe(0);
    expect(snap.teleportSeq).toBe(1);
    expect(snap.entities).toEqual([]);
    const o = spawnEntity?.origin ?? [0, 0, 0];
    const ps = snap.state;
    expect(Array.from(ps.origin)).toEqual([o[0], o[1], o[2] + TRACE_EPSILON]);
    expect(Array.from(ps.velocity)).toEqual([0, 0, 0]);
    expect(ps.viewYaw).toBe(degreesToU16(spawnEntity?.angles?.[1] ?? 0));
    expect(ps.viewPitch).toBe(0);
    expect(ps.flags).toBe(PMF_GROUNDED);
    expect(ps.groundEntity).toBe(ENTITY_WORLD);
    expect(ps.stamina).toBe(SPAWN_STAMINA);
    expect(match.session(0)?.spawnTick).toBe(4);
  });

  it("spawns and repeats the neutral cmd with the spawn point's yaw", () => {
    const tower = loadMap("fall_tower");
    const yaw = degreesToU16(90);
    expect(tower.entities.find((e) => e.classname === "info_player_start")?.angles?.[1]).toBe(90);
    const match = new Match({ cmap: tower, buildHash: TEST_BUILD });
    const client = joined(match);
    expect(client.lastSnapshot().state.viewYaw).toBe(yaw);
    run(match, client, 1);
    expect(client.lastSnapshot().flags).toBe(SNAP_FLAG_STARVED);
    expect(client.lastSnapshot().state.viewYaw).toBe(yaw);
    expect(match.session(0)?.lastCmd.yaw).toBe(yaw);
  });

  it("accepts the cmds of a player who joins a match that has run for a while", () => {
    const match = newMatch();
    run(match, null, 200);
    const client = joined(match);
    const t0 = client.lastSnapshot().serverTick;
    expect(t0).toBe(202);
    for (let i = 1; i <= 10; i++) {
      client.input([cmdAt(t0 + i + 1, 127), cmdAt(t0 + i, 127)]);
      run(match, client, 1);
    }
    const s = match.session(0);
    expect(s?.queue.early).toBe(0);
    expect(s?.queue.late).toBe(0);
    expect(s?.stats.cmds).toBe(10);
    expect(s?.stats.starved).toBe(0);
    expect(client.lastSnapshot().flags).toBe(0);
  });

  it("simulates the client's cmds exactly as a local pmove of the same cmds", () => {
    const match = newMatch();
    const client = joined(match);
    const spawnTick = client.lastSnapshot().serverTick;
    const local = new PlayerState();
    const params = new PmoveParams();
    const cmd = new UserCmd();
    // Prediction starts from the spawn snapshot's state.
    local.origin.set(client.lastSnapshot().state.origin);
    Object.assign(local, {
      viewYaw: client.lastSnapshot().state.viewYaw,
      flags: client.lastSnapshot().state.flags,
      groundEntity: client.lastSnapshot().state.groundEntity,
      stamina: client.lastSnapshot().state.stamina,
    });
    for (let i = 1; i <= 120; i++) {
      const t = spawnTick + i;
      const c = cmdAt(t, 127, i % 40 === 0 ? BUTTON_JUMP : 0, (i * 97) & 0xffff);
      client.input([c]);
      run(match, client, 1);
      Object.assign(cmd, c);
      sanitizeUserCmd(cmd);
      pmove(local, cmd, world, params, TICK_DT, null, null);
      const snap = client.lastSnapshot();
      expect(snap.serverTick).toBe(t);
      expect(snap.flags).toBe(0);
      expect(playerStateEquals(snap.state, local)).toBe(true);
    }
    expect(client.lastSnapshot().state.origin[0]).toBeGreaterThan(
      (spawnEntity?.origin?.[0] ?? 0) + 200,
    );
    expect(match.session(0)?.stats.cmds).toBe(120);
    expect(match.session(0)?.stats.starved).toBe(0);
  });

  it("repeats the last cmd with ATTACK cleared and tick = T when a cmd is missing", () => {
    const match = newMatch();
    const client = joined(match);
    const t0 = client.lastSnapshot().serverTick;
    // No cmd yet: the repeat is the neutral spawn cmd.
    run(match, client, 1);
    expect(client.lastSnapshot().flags).toBe(SNAP_FLAG_STARVED);
    const s = match.session(0);
    expect(s?.lastCmd).toMatchObject({ tick: t0 + 1, buttons: 0, forward: 0, yaw: 0 });
    client.input([cmdAt(t0 + 2, 100, BUTTON_ATTACK | BUTTON_JUMP, 1234)]);
    run(match, client, 1);
    expect(client.lastSnapshot().flags).toBe(0);
    run(match, client, 2);
    expect(client.lastSnapshot().flags).toBe(SNAP_FLAG_STARVED);
    expect(s?.lastCmd).toMatchObject({
      tick: t0 + 4,
      buttons: BUTTON_JUMP,
      forward: 100,
      yaw: 1234,
    });
    expect(s?.stats.starved).toBe(3);
    expect(match.metrics.starved).toBe(3);
    // A cmd for a tick already simulated with a repeat is dropped as late.
    client.input([cmdAt(t0 + 4, 50)]);
    run(match, client, 1);
    expect(s?.queue.late).toBe(1);
  });

  it("reports input buffer health and the cvar hash in full snapshots", () => {
    const match = newMatch();
    const client = joined(match);
    const t0 = client.lastSnapshot().serverTick;
    // Cmds three ticks ahead of the next tick, four per packet, newest first.
    client.input([cmdAt(t0 + 4), cmdAt(t0 + 3), cmdAt(t0 + 2), cmdAt(t0 + 1)]);
    run(match, client, 1);
    let snap = client.lastSnapshot();
    expect(snap.serverTick).toBe(t0 + 1);
    expect(snap.header.baseBack).toBe(0);
    expect(snap.inputBufferHealth).toBe(3);
    expect(snap.cvarHash).toBe(cvarHash16(registryCvarHash(match.cvars)));
    run(match, client, 5);
    snap = client.lastSnapshot();
    expect(snap.inputBufferHealth).toBe(t0 + 4 - (t0 + 6));
    // Clamped to i8 when the client has sent nothing for a long time.
    run(match, client, 200);
    expect(client.lastSnapshot().inputBufferHealth).toBe(-128);
    expect(client.bad).toBe(0);
  });

  it("reports input buffer health 0 on the spawn snapshot, then counts down until cmds arrive", () => {
    const match = newMatch();
    run(match, null, 1000);
    const client = joined(match);
    const health = () => client.snapshots.map((m) => [m.flags, m.inputBufferHealth, m.teleportSeq]);
    run(match, client, 3);
    expect(health()).toEqual([
      [0, 0, 1],
      [SNAP_FLAG_STARVED, -1, 1],
      [SNAP_FLAG_STARVED, -2, 1],
      [SNAP_FLAG_STARVED, -3, 1],
    ]);
  });

  it("reports the newest cmd received, even when every cmd arrives too late to use", () => {
    const match = newMatch();
    const client = joined(match);
    run(match, client, 2);
    // A client whose clock runs two ticks behind: each cmd is for T − 2, already simulated.
    for (let i = 0; i < 100; i++) {
      const t = match.serverTick + 1;
      client.input([cmdAt(t - 2)]);
      run(match, client, 1);
      expect(client.lastSnapshot().inputBufferHealth).toBe(-2);
    }
    expect(match.session(0)?.queue.late).toBe(100);
  });

  it("counts duplicate and far-ahead cmds", () => {
    const match = newMatch();
    const client = joined(match);
    const t0 = client.lastSnapshot().serverTick;
    client.input([cmdAt(t0 + 2), cmdAt(t0 + 1)]);
    client.input([cmdAt(t0 + 3), cmdAt(t0 + 2), cmdAt(t0 + 1)]);
    client.input([cmdAt(t0 + 1 + 64)]);
    run(match, client, 1);
    const q = match.session(0)?.queue;
    expect(q?.accepted).toBe(3);
    expect(q?.duplicates).toBe(2);
    expect(q?.early).toBe(1);
  });

  it("ignores INPUT before READY", () => {
    const match = newMatch();
    const client = connect(match);
    client.hello();
    run(match, client, 1);
    client.input([cmdAt(2)]);
    run(match, client, 1);
    expect(client.snapshots).toHaveLength(0);
    expect(match.session(0)?.stats.strikes).toBe(0);
  });
});

describe("match snapshots (protocol v2, D-033–D-035)", () => {
  it("lists every other active player as an entity, exactly as the world frame holds it", () => {
    const match = newMatch();
    const a = joined(match);
    const b = joined(match);
    // A third client past WELCOME but not READY is no entity yet.
    const c = connect(match);
    c.hello();
    for (let i = 1; i <= 30; i++) {
      const t = match.serverTick + 1;
      a.input([cmdAt(t, 127, 0, 1000)]);
      b.input([cmdAt(t, -127, BUTTON_JUMP, 40000)]);
      run(match, null, 1);
      a.poll();
      b.poll();
      c.poll();
      const sa = a.lastSnapshot();
      const sb = b.lastSnapshot();
      expect([sa.serverTick, sb.serverTick]).toEqual([t, t]);
      expect(sa.entities).toEqual([1]);
      expect(sb.entities).toEqual([0]);
      // Each receiver holds the frame the server encoded, as that receiver sees it.
      expect(frameDigest(sa.frame, 0)).toBe(frameDigest(match.worldFrame, 0));
      expect(frameDigest(sb.frame, 1)).toBe(frameDigest(match.worldFrame, 1));
      expect(playerStateEquals(sa.state, match.session(0)?.player ?? new PlayerState())).toBe(true);
      // b's entity in a's snapshot: its origin at 1/32 u and its velocity at 1 u/s.
      const p1 = match.session(1)?.player ?? new PlayerState();
      expect(sa.frame.originX[1]).toBe(p1.origin[0] * 32);
      expect(sa.frame.entVelY[1]).toBe(entityVelocity(p1.velocity[1] * 16));
      expect(sa.frame.flags[1]).toBe(p1.flags & ENTITY_FLAG_MASK);
      expect([sa.frame.teleportSeq[1], sa.frame.team[1], sa.frame.stamp[1]]).toEqual([1, 0, t]);
    }
    expect(c.snapshots).toHaveLength(0);
    expect(match.worldFrame.presentCount).toBe(2);
    expect([a.bad, b.bad, c.bad]).toEqual([0, 0, 0]);
  });

  it("steps a slot's teleport counter on every spawn, across the players who take the slot", () => {
    const match = newMatch();
    const first = joined(match);
    const other = joined(match);
    expect(first.lastSnapshot().teleportSeq).toBe(1);
    expect(match.session(0)?.serial).toBe(1);
    first.transport.close("bye");
    run(match, other, 2);
    expect(other.lastSnapshot().entities).toEqual([]);
    const second = joined(match);
    expect(match.session(0)?.serial).toBe(2);
    expect(second.lastSnapshot().teleportSeq).toBe(2);
    run(match, other, 1);
    expect(other.lastSnapshot().frame.teleportSeq[0]).toBe(2);
    expect(match.worldFrame.serial[0]).toBe(2);
    expect(match.worldFrame.serial[1]).toBe(1);
  });

  it("fits the full snapshot of a 37-player match in 1100 B", () => {
    const match = new Match({ cmap, world, buildHash: TEST_BUILD, maxClients: 37 });
    const clients: TestClient[] = [];
    for (let i = 0; i < 37; i++) {
      const cl = connect(match);
      cl.hello();
      clients.push(cl);
    }
    run(match, null, 1);
    for (const cl of clients) cl.ready();
    run(match, null, 2);
    const sizes = new Set<number>();
    for (const cl of clients) {
      cl.poll();
      expect(cl.lastSnapshot().entities).toHaveLength(36);
      expect(cl.bad).toBe(0);
    }
    const t = (clients[0] as TestClient).transport;
    t.onMessage((d, len) => {
      if (d[0] === MSG_SNAPSHOT) sizes.add(len);
    });
    run(match, clients[0] as TestClient, 1);
    // 86 + 199 + 7 + 36 × 213 bits.
    expect([...sizes]).toEqual([995]);
  });
});

describe("match console commands and replicated cvars", () => {
  it("an admin's set pm_gravity changes the value, broadcasts CVARS at the tick and the hash", () => {
    const match = newMatch();
    const admin = joined(match, true);
    const other = joined(match);
    admin.poll();
    const before = match.cvarHash;
    admin.cmd("set pm_gravity 400");
    run(match, null, 1);
    admin.poll();
    other.poll();
    const t = match.serverTick;
    expect(admin.prints.map((p) => [p.level, p.text])).toEqual([[PRINT_INFO, "pm_gravity = 400"]]);
    expect(other.prints).toHaveLength(0);
    expect(match.cvars.get("pm_gravity")).toBe(400);
    expect(match.params.gravity).toBe(400);
    expect(match.cvarHash).not.toBe(before);
    expect(match.cvarsEffectiveTick).toBe(t);
    for (const c of [admin, other]) {
      expect(c.cvars).toHaveLength(1);
      expect(c.cvars[0]?.effectiveTick).toBe(t);
      expect(c.cvars[0]?.blockHash).toBe(match.cvarHash);
      // The snapshot of the effective tick already carries the new hash.
      expect(c.lastSnapshot().serverTick).toBe(t);
      expect(c.lastSnapshot().cvarHash).toBe(cvarHash16(match.cvarHash));
    }
    // A mirror that applies the block simulates with the same parameters.
    const mirror = new CvarRegistry();
    registerPmoveCvars(mirror);
    expect(applyCvarBlock(mirror, admin.cvars[0]?.block ?? new CvarBlock())).toMatchObject({
      ok: true,
    });
    const params = new PmoveParams();
    refreshPmoveParams(mirror, params);
    expect(params).toEqual({ ...match.params, registry: mirror, version: mirror.version });
  });

  it("simulates the effective tick itself with the new values", () => {
    const match = newMatch();
    const client = joined(match, true);
    const local = new PlayerState();
    copyPlayerState(local, client.lastSnapshot().state);
    const oldParams = new PmoveParams();
    const mirror = new CvarRegistry();
    registerPmoveCvars(mirror);
    mirror.set("pm_gravity", 400);
    const newParams = new PmoveParams();
    refreshPmoveParams(mirror, newParams);
    // The same run with the switch one tick late, to show the test can tell the two apart.
    const lagging = new PlayerState();
    copyPlayerState(lagging, local);
    const cmd = new UserCmd();
    const t0 = client.lastSnapshot().serverTick;
    let effective = -1;
    for (let i = 1; i <= 12; i++) {
      const t = t0 + i;
      // Jump at once, so the player is in the air when gravity changes on the fourth tick.
      client.input([cmdAt(t, 0, i === 1 ? BUTTON_JUMP : 0)]);
      if (i === 4) client.cmd("set pm_gravity 400");
      run(match, client, 1);
      if (client.cvars.length > 0) effective = client.cvars[0]?.effectiveTick ?? -1;
      Object.assign(cmd, cmdAt(t, 0, i === 1 ? BUTTON_JUMP : 0));
      sanitizeUserCmd(cmd);
      const params = effective >= 0 && t >= effective ? newParams : oldParams;
      pmove(local, cmd, world, params, TICK_DT, null, null);
      const laggingParams = effective >= 0 && t > effective ? newParams : oldParams;
      pmove(lagging, cmd, world, laggingParams, TICK_DT, null, null);
      const snap = client.lastSnapshot();
      expect(snap.serverTick).toBe(t);
      expect(snap.state.flags & PMF_GROUNDED).toBe(0);
      expect(playerStateEquals(snap.state, local)).toBe(true);
      if (t === effective) expect(playerStateEquals(snap.state, lagging)).toBe(false);
    }
    expect(effective).toBe(t0 + 4);
  });

  it("sends CVARS only to clients past HELLO", () => {
    const match = newMatch();
    const admin = joined(match, true);
    const welcomed = connect(match);
    welcomed.hello();
    const connecting = connect(match);
    run(match, null, 1);
    admin.cmd("set pm_gravity 300");
    run(match, null, 1);
    for (const c of [admin, welcomed, connecting]) c.poll();
    expect(admin.cvars).toHaveLength(1);
    expect(welcomed.cvars).toHaveLength(1);
    expect(connecting.cvars).toHaveLength(0);
  });

  it("refuses a non-admin's set: PRINT error, no change, no CVARS", () => {
    const match = newMatch();
    const client = joined(match);
    const before = match.cvarHash;
    client.cmd("set pm_gravity 400");
    run(match, client, 2);
    expect(client.prints[0]?.level).toBe(PRINT_ERROR);
    expect(match.cvars.get("pm_gravity")).toBe(800);
    expect(match.cvarHash).toBe(before);
    expect(client.cvars).toHaveLength(0);
  });

  it("does not broadcast when only a non-replicated cvar or an equal value changed", () => {
    const reg = new CvarRegistry();
    registerPmoveCvars(reg);
    reg.register({ name: "sv_local", type: "int", default: 1, description: "test" });
    const match = newMatch(reg);
    const client = joined(match, true);
    reg.set("sv_local", 2);
    client.cmd("set pm_gravity 800");
    run(match, client, 2);
    expect(client.cvars).toHaveLength(0);
    expect(match.metrics.cvarsSent).toBe(0);
  });

  it("broadcasts a change made on the server's registry directly, at the next tick", () => {
    const match = newMatch();
    const client = joined(match);
    match.cvars.set("pm_runSpeed", 300);
    run(match, client, 1);
    expect(client.cvars[0]?.effectiveTick).toBe(match.serverTick);
    expect(match.params.runSpeed).toBe(300);
  });

  it("resends the block on `cvars` with the tick the values took effect", () => {
    const match = newMatch();
    const client = joined(match);
    match.cvars.set("pm_gravity", 500);
    run(match, client, 1);
    const effective = match.serverTick;
    run(match, client, 10);
    client.cmd("cvars");
    run(match, client, 1);
    expect(client.cvars.map((c) => c.effectiveTick)).toEqual([effective, effective]);
    expect(client.prints).toHaveLength(0);
  });

  it("answers CMD before READY too (a console during connect)", () => {
    const match = newMatch();
    const client = connect(match, true);
    client.hello();
    run(match, client, 1);
    client.cmd("set pm_gravity 600");
    run(match, client, 1);
    expect(client.prints[0]?.text).toBe("pm_gravity = 600");
    expect(client.cvars).toHaveLength(1);
  });
});

describe("match under hostile traffic", () => {
  it("never throws on seeded random packets in every session state, and only strikes", () => {
    const rng = new Mulberry32(0x5eed09);
    const match = newMatch();
    const active = joined(match);
    const welcomed = connect(match);
    welcomed.hello();
    run(match, null, 1);
    const connecting = connect(match);
    const hash = match.cvarHash;
    const types = [MSG_HELLO, MSG_READY, MSG_INPUT, MSG_PING, MSG_CMD];
    const targets = [active, welcomed, connecting];
    let sent = 0;
    for (let tick = 0; tick < 2000; tick++) {
      for (let k = 0; k < 3; k++) {
        const target = targets[(rng.nextU32() % targets.length) | 0] as TestClient;
        const len = 1 + (rng.nextU32() % 48);
        const bytes = new Uint8Array(len);
        for (let i = 0; i < len; i++) bytes[i] = rng.nextU32() & 0xff;
        // Mostly real type bytes, and a HELLO usually with the right version prefix.
        if (rng.nextFloat() < 0.7) bytes[0] = types[(rng.nextU32() % types.length) | 0] as number;
        if (bytes[0] === MSG_HELLO && len > 1 && rng.nextFloat() < 0.5) bytes[1] = PROTOCOL_VERSION;
        target.raw(bytes, rng.nextFloat() < 0.5);
        sent++;
      }
      expect(() => run(match, null, 1)).not.toThrow();
    }
    for (const c of targets) c.poll();
    // Most packets are struck; some decode (an INPUT or PING on the right channel), and once the
    // connecting session is kicked for a bad HELLO its packets go nowhere.
    expect(match.metrics.strikes).toBeGreaterThan(sent / 2);
    expect(match.session(0)?.state).toBe(SESSION_ACTIVE);
    expect(match.cvarHash).toBe(hash);
    expect(match.cvars.get("pm_gravity")).toBe(800);
    for (const c of targets) expect(c.bad).toBe(0);
  });
});
