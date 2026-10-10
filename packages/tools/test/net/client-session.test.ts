import {
  ClientSim,
  CONN_ACTIVE,
  CONN_CLOSED,
  CONN_CONNECTING,
  CONN_SPAWNING,
  CONN_SYNCING,
  createScriptedInput,
  HANDSHAKE_PINGS,
  MixedInput,
  NeutralInput,
  SCRIPTED_INPUTS,
  STAT_CORRECTIONS,
  STAT_HARD_RESYNCS,
  STAT_STARVED,
  STAT_STARVED_CORRECTIONS,
  STAT_STRIKES,
  StrafeCircuit,
  welcomeMapHash,
} from "@game/client/net";
import { Match, SESSION_WELCOMED } from "@game/server";
import {
  BitWriter,
  createLoopbackPair,
  encodePong,
  encodeSnapshot,
  findNetProfile,
  MATCH_MAX_CLIENTS,
  MAX_RELIABLE_BYTES,
  MSG_PING,
  MSG_WELCOME,
  PlayerState,
  PMEV_JUMP,
  PMEV_LAND,
  PMF_GROUNDED,
  PongMsg,
  pmovePrimed,
  SNAP_FLAG_SPECTATOR,
  SnapshotHeader,
  slotToPlayerState,
  type Transport,
  UserCmd,
  WelcomeMsg,
  type WorldFrame,
} from "@game/shared";
import { describe, expect, it } from "vitest";
import { loadCourse } from "../../src/scenarios/course";
import { HARNESS_BUILD, NetHarness } from "./harness";
import { HandSnapshot } from "./snapshots";

// The client's session outside the NET acceptance runs: the handshake states, refusals, kicks and
// malformed packets (M2 design §1 connection.ts), and the scripted inputs (scriptedInput.ts).

const course = loadCourse("movement_lab");

/** A client on movement_lab over a bare loopback pair, its clock under the test's control. */
function bareClient(buildHash = HARNESS_BUILD) {
  const [clientEnd, serverEnd] = createLoopbackPair();
  const now = { t: 0 };
  const client = new ClientSim({
    primer: false,
    transport: clientEnd,
    cmap: course.cmap,
    world: course.world,
    buildHash,
    clock: () => now.t,
  });
  return { client, serverEnd, now };
}

describe("client session", () => {
  it("runs the pmove primer at construction, once per module instance, unless told not to (D-040)", () => {
    // Every other client and match in this file passes primer: false, and Vitest gives the file
    // its own module instances, so nothing has primed pmove yet.
    expect(bareClient().client.primerMs).toBe(0);
    expect(pmovePrimed()).toBe(false);
    const lines: string[] = [];
    const now = { t: 0 };
    const make = () =>
      new ClientSim({
        transport: createLoopbackPair()[0],
        cmap: course.cmap,
        world: course.world,
        buildHash: HARNESS_BUILD,
        // The primer's time on the client's clock: 5 ms a call, so its two reads differ.
        clock: () => (now.t += 5),
        log: (_level, msg) => lines.push(msg),
      });
    const first = make();
    expect(pmovePrimed()).toBe(true);
    expect(first.primerMs).toBe(5);
    expect(lines).toContain("pmove primer: 5 ms");
    // A second client in the same module instance finds it done.
    const count = lines.length;
    expect(make().primerMs).toBe(0);
    expect(lines.slice(count).some((l) => l.startsWith("pmove primer"))).toBe(false);
  });

  it("walks HELLO → WELCOME → five pings → READY → spawn, then predicts", () => {
    const { client, serverEnd, now } = bareClient();
    const match = new Match({
      cmap: course.cmap,
      world: course.world,
      buildHash: HARNESS_BUILD,
      primer: false,
    });
    match.connect(serverEnd, true);
    expect(client.sendCommand("cvars")).toBe(false);
    client.connect();
    expect(client.state).toBe(CONN_CONNECTING);
    const seen = new Set<number>([client.state]);
    for (let i = 0; i < 400 && client.state !== CONN_ACTIVE; i++) {
      now.t += 1000 / 144;
      if (i % 2 === 0) match.tick();
      client.frame();
      seen.add(client.state);
    }
    expect([...seen]).toEqual([CONN_CONNECTING, CONN_SYNCING, CONN_SPAWNING, CONN_ACTIVE]);
    expect(client.clock.sampleCount).toBeGreaterThanOrEqual(HANDSHAKE_PINGS);
    expect(client.connection.clientId).toBe(0);
    const spawn = match.session(0)?.spawnTick ?? -1;
    expect(client.startTick).toBe(spawn + client.clock.leadTicks(client.settings.inputBuffer));
    expect(client.predictor.latestTick).toBeGreaterThanOrEqual(client.startTick);
  });

  it("refuses a WELCOME for another map", () => {
    const { client, serverEnd, now } = bareClient();
    const other = loadCourse("jump_lab");
    const match = new Match({
      cmap: other.cmap,
      world: other.world,
      buildHash: HARNESS_BUILD,
      primer: false,
    });
    match.connect(serverEnd, true);
    client.connect();
    for (let i = 0; i < 10; i++) {
      now.t += 10;
      match.tick();
      client.frame();
    }
    expect(client.state).toBe(CONN_CLOSED);
    expect(client.connection.closeReason).toMatch(/^server runs map jump_lab/);
  });

  it("loads the map WELCOME names before READY, and refuses another version (D-031)", () => {
    const [clientEnd, serverEnd] = createLoopbackPair();
    const now = { t: 0 };
    const asked: [string, string][] = [];
    const client = new ClientSim({
      primer: false,
      transport: clientEnd,
      buildHash: HARNESS_BUILD,
      clock: () => now.t,
      onMapRequest: (name, hash) => asked.push([name, hash]),
    });
    expect(client.map).toBeNull();
    const match = new Match({
      cmap: course.cmap,
      world: course.world,
      buildHash: HARNESS_BUILD,
      primer: false,
    });
    match.connect(serverEnd, true);
    client.connect();
    const step = (frames: number) => {
      for (let i = 0; i < frames; i++) {
        now.t += 1000 / 60;
        match.tick();
        client.frame();
      }
    };
    step(60);
    // The pings are done, but READY waits for the map: the server has not spawned anyone.
    expect(asked).toEqual([["movement_lab", course.cmap.contentHash]]);
    expect(client.mapRequest).toEqual({
      name: "movement_lab",
      contentHash: course.cmap.contentHash,
    });
    expect(client.clock.handshakeDone).toBe(true);
    expect(client.state).toBe(CONN_SYNCING);
    expect(match.session(0)?.state).toBe(SESSION_WELCOMED);
    expect(client.provideMap(course.cmap, course.world)).toBeNull();
    expect(client.world).toBe(course.world);
    expect(client.provideMap(course.cmap)).toBe("a map is already loaded (movement_lab)");
    step(30);
    expect(client.state).toBe(CONN_ACTIVE);
    expect(client.stats.totals[STAT_CORRECTIONS]).toBe(0);

    // A file of the same name but another hash ends the session with both versions.
    const [otherEnd, otherServerEnd] = createLoopbackPair();
    const stale = new ClientSim({
      primer: false,
      transport: otherEnd,
      buildHash: HARNESS_BUILD,
      clock: () => now.t,
    });
    match.connect(otherServerEnd, false);
    stale.connect();
    for (let i = 0; i < 10; i++) {
      now.t += 10;
      match.tick();
      stale.frame();
    }
    expect(stale.mapRequest?.name).toBe("movement_lab");
    const jump = loadCourse("jump_lab").cmap;
    const why = stale.provideMap({ ...jump, name: "movement_lab" });
    expect(why).toBe(
      `server runs map movement_lab (${course.cmap.contentHash}), ` +
        `the client loaded movement_lab (${jump.contentHash})`,
    );
    expect(stale.closed).toBe(true);
    expect(stale.connection.closeReason).toBe(why);
  });

  it("writes WELCOME's map hash as the cmap does: 16 hex digits, zero-padded (D-031)", () => {
    const m = new WelcomeMsg();
    m.mapHashHi = 0x0000abcd;
    m.mapHashLo = 0x00000001;
    expect(welcomeMapHash(m)).toBe("0000abcd00000001");
    // A decoded u32 may come back signed.
    m.mapHashHi = 0xffffffff | 0;
    m.mapHashLo = 0x80000000 | 0;
    expect(welcomeMapHash(m)).toBe("ffffffff80000000");
    // End to end: a map whose hash has leading zeros is the client's own, not "another version".
    const padded = { ...course.cmap, contentHash: "0000abcd00000001" };
    const match = new Match({
      cmap: padded,
      world: course.world,
      buildHash: HARNESS_BUILD,
      primer: false,
    });
    const [clientEnd, serverEnd] = createLoopbackPair();
    const now = { t: 0 };
    const client = new ClientSim({
      primer: false,
      transport: clientEnd,
      buildHash: HARNESS_BUILD,
      clock: () => now.t,
      onMapRequest: () => client.provideMap(padded, course.world),
    });
    match.connect(serverEnd, true);
    client.connect();
    for (let i = 0; i < 60 && !client.active; i++) {
      now.t += 1000 / 60;
      match.tick();
      client.frame();
    }
    expect(client.mapRequest).toEqual({ name: "movement_lab", contentHash: "0000abcd00000001" });
    expect(client.state).toBe(CONN_ACTIVE);
  });

  it("takes the map from inside onMapRequest, and stays closed when it refuses or throws", () => {
    const match = new Match({
      cmap: course.cmap,
      world: course.world,
      buildHash: HARNESS_BUILD,
      primer: false,
    });
    const now = { t: 0 };
    const jump = loadCourse("jump_lab").cmap;
    /** A client whose loader runs synchronously in WELCOME's poll, as a Node host's would. */
    const syncClient = (load: (c: ClientSim) => void) => {
      const [clientEnd, serverEnd] = createLoopbackPair();
      const box: { c: ClientSim | null } = { c: null };
      const c = new ClientSim({
        primer: false,
        transport: clientEnd,
        buildHash: HARNESS_BUILD,
        clock: () => now.t,
        onMapRequest: () => {
          if (box.c !== null) load(box.c);
        },
      });
      box.c = c;
      match.connect(serverEnd, false);
      c.connect();
      return c;
    };
    const good = syncClient((c) => c.provideMap(course.cmap, course.world));
    const stale = syncClient((c) => c.provideMap({ ...jump, name: "movement_lab" }));
    const throws = syncClient(() => {
      throw new Error("no such file");
    });
    const closes: string[] = [];
    const quits = syncClient((c) => {
      c.disconnect("changed my mind");
      closes.push(c.connection.closeReason);
    });
    let threw = 0;
    for (let i = 0; i < 90; i++) {
      now.t += 1000 / 60;
      match.tick();
      for (const c of [good, stale, throws, quits]) {
        try {
          c.frame();
        } catch {
          threw++;
        }
      }
    }
    expect(threw).toBe(0);
    expect(good.state).toBe(CONN_ACTIVE);
    // A refusal or disconnect inside the callback must not be undone by WELCOME's own handling.
    expect(stale.state).toBe(CONN_CLOSED);
    expect(stale.connection.closeReason).toMatch(/^server runs map movement_lab \(/);
    expect(quits.state).toBe(CONN_CLOSED);
    expect(closes).toEqual(["changed my mind"]);
    expect(throws.state).toBe(CONN_CLOSED);
    expect(throws.connection.closeReason).toBe("could not load map movement_lab: no such file");
  });

  it("refuses a WELCOME whose client id is past the 64 slots (D-034)", () => {
    const { client, serverEnd, now } = bareClient();
    const match = new Match({
      cmap: course.cmap,
      world: course.world,
      buildHash: HARNESS_BUILD,
      primer: false,
    });
    // The match's WELCOME with its client id byte (after type and version) set to 64.
    const send = serverEnd.sendReliable.bind(serverEnd);
    serverEnd.sendReliable = (d, len) => {
      if (d[0] === MSG_WELCOME) d[3] = MATCH_MAX_CLIENTS;
      send(d, len);
    };
    match.connect(serverEnd, true);
    client.connect();
    for (let i = 0; i < 10; i++) {
      now.t += 10;
      match.tick();
      client.frame();
    }
    expect(client.state).toBe(CONN_CLOSED);
    expect(client.connection.closeReason).toBe("server gave client id 64 (max 63)");
    expect(client.mapRequest).toBeNull();
  });

  it("reports the server's kick", () => {
    const { client, serverEnd, now } = bareClient("other-build");
    const match = new Match({
      cmap: course.cmap,
      world: course.world,
      buildHash: HARNESS_BUILD,
      primer: false,
    });
    match.connect(serverEnd, true);
    client.connect();
    for (let i = 0; i < 10; i++) {
      now.t += 10;
      match.tick();
      client.frame();
    }
    expect(client.closed).toBe(true);
    expect(client.connection.closeReason).toMatch(/^kicked: build other-build/);
  });

  it("drops malformed packets, wrong channels and messages out of state with a strike", () => {
    const { client, serverEnd, now } = bareClient();
    client.connect();
    const w = new BitWriter(MAX_RELIABLE_BYTES);
    // A snapshot before WELCOME is out of state; on the reliable channel it is on the wrong one.
    const ps = new PlayerState();
    ps.stamina = 100;
    new HandSnapshot(0).local(1, ps).encode(w);
    serverEnd.sendUnreliable(w.bytes, w.byteLength);
    serverEnd.sendReliable(w.bytes, w.byteLength);
    w.reset();
    encodePong(w, new PongMsg());
    serverEnd.sendReliable(w.bytes, w.byteLength);
    serverEnd.sendUnreliable(new Uint8Array([99, 1, 2]), 3);
    serverEnd.sendReliable(new Uint8Array([2, 1]), 2);
    now.t += 10;
    client.frame();
    // The out-of-state snapshot decodes, so it is ignored without a strike.
    expect(client.stats.totals[STAT_STRIKES]).toBe(4);
    expect(client.state).toBe(CONN_CONNECTING);
    expect(client.predictor.latestTick).toBe(-1);
  });

  it("strikes and drops a spectator snapshot on a live connection (demo files only, D-033)", () => {
    const h = new NetHarness({ input: new NeutralInput(), primer: false });
    h.runTicks(60);
    const c = h.client;
    const strikes = c.stats.totals[STAT_STRIKES] as number;
    // Every player of the next tick, no local block: valid bytes, refused by a live connection.
    const m = new HandSnapshot(-1);
    const tick = h.match.serverTick + 1;
    m.header.serverTick = tick;
    m.header.flags = SNAP_FLAG_SPECTATOR;
    m.frame.clear();
    m.frame.setPresent(0, tick);
    const w = new BitWriter(MAX_RELIABLE_BYTES);
    expect(m.encode(w)).toBe(true);
    h.match.tick = () => {};
    const server = h.match.session(0)?.transport as Transport;
    server.sendUnreliable(w.bytes, w.byteLength);
    h.run(50);
    expect(c.stats.totals[STAT_STRIKES]).toBe(strikes + 1);
    expect(c.store.spectatorDropped).toBe(1);
    expect(c.store.ring.has(tick)).toBe(false);
    expect(c.predictor.snapshotTick).toBeLessThan(tick);
    expect(c.active).toBe(true);
  });

  it("drops a duplicate or older snapshot without a strike (D-033)", () => {
    const h = new NetHarness({ input: new NeutralInput(), primer: false });
    h.runTicks(120);
    h.match.tick = () => {};
    h.run(50);
    const c = h.client;
    const strikes = c.stats.totals[STAT_STRIKES] as number;
    const [stale, stored, snapTick] = [c.store.stale, c.store.stored, c.predictor.snapshotTick];
    const newest = c.store.newestTick;
    expect(newest).toBe(snapTick);
    const server = h.match.session(0)?.transport as Transport;
    const w = new BitWriter(MAX_RELIABLE_BYTES);
    // The newest snapshot again, as the client holds it (re-encoded full: its baseline is moot).
    const again = Object.assign(new SnapshotHeader(), c.store.header, { baseBack: 0 });
    expect(encodeSnapshot(w, again, c.store.newest as WorldFrame, null, 0)).toBe(true);
    server.sendUnreliable(w.bytes, w.byteLength);
    // A snapshot 64 ticks older: its ring slot holds the newer tick.
    const ps = new PlayerState();
    slotToPlayerState(c.store.newest as WorldFrame, 0, ps);
    const old = new HandSnapshot(0).local(newest - 64, ps, {
      teleportSeq: c.store.header.teleportSeq,
    });
    expect(old.encode(w)).toBe(true);
    server.sendUnreliable(w.bytes, w.byteLength);
    h.run(50);
    expect(c.stats.totals[STAT_STRIKES]).toBe(strikes);
    expect([c.store.stale, c.store.stored]).toEqual([stale + 2, stored]);
    expect(c.predictor.snapshotTick).toBe(snapTick);
    expect(c.active).toBe(true);
  });

  it("closes when the server's transport closes", () => {
    const { client, serverEnd, now } = bareClient();
    client.connect();
    serverEnd.close("server shutting down");
    now.t += 10;
    client.frame();
    expect(client.closed).toBe(true);
    expect(client.connection.closeReason).toBe("server shutting down");
  });

  it("smooths a correction into the render offset instead of jumping", () => {
    // Drop the client's inputs for a stretch: the server starves, the prediction is corrected.
    const h = new NetHarness({ input: new StrafeCircuit(), primer: false });
    h.runTicks(400);
    const session = h.match.session(0);
    expect(session).toBeDefined();
    const queue = session?.queue;
    for (let i = 0; i < 12; i++) {
      queue?.reset((h.match.serverTick as number) + 2);
      h.run(1000 / 60);
    }
    h.run(1000);
    const t = h.totals();
    expect(t.corrections).toBeGreaterThan(0);
    expect(Math.max(...h.frames.offset)).toBeGreaterThan(0);
    // It decays: the last frame's offset is gone.
    expect(h.frames.offset.at(-1)).toBe(0);
  });

  it("counts a correction on a starved snapshot apart: a late cmd, not a misprediction", () => {
    // wan-50: a 70 ms stall sends cmds past the input buffer, so the server repeats one it had
    // not received; the client already predicted that tick with the real cmd and is corrected.
    const h = new NetHarness({
      input: new StrafeCircuit(),
      profile: findNetProfile("wan-50"),
      primer: false,
    });
    h.run(3000);
    const t = h.client.stats.totals;
    expect([t[STAT_STARVED], t[STAT_CORRECTIONS], t[STAT_STARVED_CORRECTIONS]]).toEqual([0, 0, 0]);
    h.hitch(70);
    h.run(1000);
    expect(t[STAT_STARVED]).toBeGreaterThan(0);
    expect(t[STAT_CORRECTIONS]).toBeGreaterThan(0);
    expect(t[STAT_STARVED_CORRECTIONS]).toBe(t[STAT_CORRECTIONS]);
    // A server-side push the client could not predict is a correction on an on-time snapshot.
    const corrections = t[STAT_CORRECTIONS] as number;
    let push = true;
    h.beforeServerTick = () => {
      const player = h.match.session(0)?.player;
      if (push && player !== undefined) player.velocity[2] += 300;
      push = false;
    };
    h.run(1000);
    expect(t[STAT_CORRECTIONS]).toBeGreaterThan(corrections);
    expect(t[STAT_STARVED_CORRECTIONS]).toBe(corrections);
  });

  it("files each first prediction's movement events under its tick, once", () => {
    const h = new NetHarness({ input: new StrafeCircuit(), primer: false });
    h.runTicks(600);
    const jumps = h.events.filter((e) => e.type === PMEV_JUMP);
    const lands = h.events.filter((e) => e.type === PMEV_LAND);
    expect(jumps.length).toBeGreaterThan(3);
    expect(lands.length).toBeGreaterThan(3);
    const grounded = (tick: number) => {
      const s = h.firstPredicted.get(tick);
      expect(s, `tick ${tick}`).toBeDefined();
      return ((s?.flags ?? 0) & PMF_GROUNDED) !== 0;
    };
    for (const e of jumps) {
      expect(grounded(e.tick), `jump at ${e.tick}`).toBe(false);
      expect(h.firstPredicted.get(e.tick)?.velocity[2]).toBeGreaterThan(200);
    }
    for (const e of lands) {
      expect([grounded(e.tick - 1), grounded(e.tick)], `land at ${e.tick}`).toEqual([false, true]);
      expect(e.value).toBeGreaterThan(0);
    }
    const keys = h.events.map((e) => `${e.type}@${e.tick}`);
    expect(new Set(keys).size).toBe(keys.length);
    // Only the startup fill (the spawn's re-anchor) predicts under a path jump.
    const jumped = h.events.filter((e) => e.jumped);
    expect(jumped.every((e) => e.tick <= h.client.startTick)).toBe(true);
    expect(h.events.filter((e) => !e.jumped).length).toBeGreaterThan(6);
    const ticks = h.events.map((e) => e.tick);
    expect(ticks).toEqual([...ticks].sort((a, b) => a - b));
  });
});

/** A server end that flips the top bit of every PING id it delivers: its PONGs match no ping. */
class PingIdFlip implements Transport {
  constructor(private readonly inner: Transport) {}
  sendUnreliable(d: Uint8Array, len: number): void {
    this.inner.sendUnreliable(d, len);
  }
  sendReliable(d: Uint8Array, len: number): void {
    this.inner.sendReliable(d, len);
  }
  onMessage(cb: Parameters<Transport["onMessage"]>[0]): void {
    this.inner.onMessage((d, len, reliable) => {
      if (!reliable && len >= 3 && d[0] === MSG_PING) d[2] = (d[2] as number) ^ 0x80;
      cb(d, len, reliable);
    });
  }
  onClose(cb: Parameters<Transport["onClose"]>[0]): void {
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
  stats(): ReturnType<Transport["stats"]> {
    return this.inner.stats();
  }
}

describe("client timeouts and keepalive (D-041)", () => {
  /** A client and the match it plays on, `ms` of frames at 144 Hz with a tick every other frame. */
  function playing() {
    const { client, serverEnd, now } = bareClient();
    const match = new Match({
      cmap: course.cmap,
      world: course.world,
      buildHash: HARNESS_BUILD,
      primer: false,
    });
    match.connect(serverEnd);
    client.connect();
    let frames = 0;
    const run = (ms: number, server = true) => {
      for (const end = now.t + ms; now.t < end; ) {
        now.t += 1000 / 144;
        if (server && frames++ % 2 === 0) match.tick();
        client.frame();
      }
    };
    run(1000);
    expect(client.state).toBe(CONN_ACTIVE);
    return { client, match, now, run };
  }

  it("times out after 5 s of a silent server, not before", () => {
    const { client, run } = playing();
    run(4900, false);
    expect(client.closed).toBe(false);
    run(200, false);
    expect(client.connection.closeReason).toBe("timed out");
  });

  it("times out a handshake that gets no WELCOME within 10 s", () => {
    const { client, now } = bareClient();
    client.connect();
    for (; now.t < 9990; now.t += 10) client.frame();
    expect(client.state).toBe(CONN_CONNECTING);
    now.t += 20;
    client.frame();
    expect(client.connection.closeReason).toBe("handshake timed out");
  });

  it("counts a long frame as at most 1 s of silence: back from a stall, it waits out the rest", () => {
    const { client, now, run } = playing();
    // 20 s without a frame and nothing queued (the server stalled too): the first frame back
    // counts 1 s of it; the client then waits 4 s more for the server before it gives up.
    now.t += 20_000;
    client.frame();
    expect(client.closed).toBe(false);
    run(3500, false);
    expect(client.closed).toBe(false);
    run(1000, false);
    expect(client.connection.closeReason).toBe("timed out");
  });

  it("times out from keepalives alone: a hidden page whose server went silent", () => {
    const { client, now } = playing();
    let beats = 0;
    while (!client.closed && beats < 10) {
      now.t += 1000;
      client.keepalive();
      beats++;
    }
    expect(client.connection.closeReason).toBe("timed out");
    expect(beats).toBe(5);
  });

  it("times out a clock handshake whose pongs never match, though the server keeps answering", () => {
    const [clientEnd, serverEnd] = createLoopbackPair();
    const now = { t: 0 };
    const client = new ClientSim({
      primer: false,
      transport: clientEnd,
      cmap: course.cmap,
      world: course.world,
      buildHash: HARNESS_BUILD,
      clock: () => now.t,
    });
    const match = new Match({
      cmap: course.cmap,
      world: course.world,
      buildHash: HARNESS_BUILD,
      primer: false,
    });
    // The server end flips every PING's id, so each PONG answers a ping the client never sent.
    match.connect(new PingIdFlip(serverEnd));
    client.connect();
    let frames = 0;
    for (; now.t < 9990; now.t += 1000 / 144) {
      if (frames++ % 2 === 0) match.tick();
      client.frame();
    }
    expect(client.state).toBe(CONN_SYNCING);
    for (; now.t < 10_020; now.t += 1000 / 144) client.frame();
    expect(client.connection.closeReason).toBe("handshake timed out");
  });

  it("keeps a session whose stall's backlog lands on the first frame back", () => {
    const { client, match, now, run } = playing();
    // 20 s without a frame (the server ticking on), then one frame: its poll finds the backlog.
    for (let i = 0; i < 1200; i++) match.tick();
    now.t += 20_000;
    client.frame();
    expect(client.closed).toBe(false);
    run(1000);
    expect(client.active).toBe(true);
  });

  it("keepalive: pings once a call, drops snapshots unread, takes no round trip, then resyncs", () => {
    const { client, match, now, run } = playing();
    const stored = client.store.newestTick;
    const rtt = client.clock.rttMs;
    const samples = client.clock.sampleCount;
    const s = match.session(0);
    expect(client.keepalive()).toBe(false); // a frame ran within 500 ms
    for (let k = 0; k < 20; k++) {
      for (let i = 0; i < 60; i++) {
        now.t += 1000 / 60;
        match.tick();
      }
      expect(client.keepalive()).toBe(true);
    }
    // The server heard from it every second; nothing it sent changed the client's state.
    expect(s?.lastPacketTick).toBeGreaterThan(match.serverTick - 61);
    expect(client.store.newestTick).toBe(stored);
    expect(client.clock.rttMs).toBe(rtt);
    expect(client.clock.sampleCount).toBe(samples);
    expect(client.closed).toBe(false);
    run(1000);
    expect(client.active).toBe(true);
    expect(client.store.newestTick).toBeGreaterThan(stored + 1200);
    expect(client.stats.totals[STAT_STRIKES]).toBe(0);
  });
});

describe("scripted input", () => {
  it("knows its names", () => {
    for (const name of SCRIPTED_INPUTS) expect(createScriptedInput(name)).not.toBeNull();
    expect(createScriptedInput("nope")).toBeNull();
    expect(createScriptedInput("idle")).toBeInstanceOf(NeutralInput);
  });

  it("is a pure function of its sample count and the states it sees", () => {
    for (const make of [() => new StrafeCircuit(), () => new MixedInput()]) {
      const a = make();
      const b = make();
      const ps = new PlayerState();
      ps.viewYaw = 1234;
      const ca = new UserCmd();
      const cb = new UserCmd();
      for (let i = 0; i < 2000; i++) {
        ps.flags = i % 37 < 3 ? 1 : 0;
        ps.velocity[0] = (i % 50) * 10;
        ps.velocity[1] = 120;
        ps.origin[0] = i;
        a.sample(ca, ps);
        b.sample(cb, ps);
        expect(cb).toEqual(ca);
      }
    }
  });

  it("the circuit stands still first, then strafe-jumps", () => {
    const s = new StrafeCircuit({ idleTicks: 3 });
    const ps = new PlayerState();
    ps.flags = 1;
    ps.viewYaw = 500;
    const c = new UserCmd();
    for (let i = 0; i < 3; i++) {
      s.sample(c, ps);
      expect([c.forward, c.right, c.buttons, c.yaw]).toEqual([0, 0, 0, 500]);
    }
    s.sample(c, ps);
    expect(c.forward).toBe(127);
    expect(c.buttons).not.toBe(0);
  });
});

// In the NET gate (`pnpm test:net`): the match loop's yield on a late wake (D-027). The real Node
// server is held to the same in `pnpm test:long` (packages/tools/long/server-stall.long.ts),
// since this harness encodes Node's order of a stall's timer and reads as an assumption.
describe("NET-04: a server stall's catch-up ticks", () => {
  it("get the cmds sent during it: none starves, on a 60 fps lan client (D-027)", () => {
    // 60 fps on lan, the e2e's rhythm: a lead of 3 ticks covers the round trip and the 2-tick
    // input buffer. The server's host stalls 50–100 ms (a GC, a long callback) while the
    // client's frames stay on time; the input that arrives meanwhile is read after the wake due
    // at the stall's end, as on Node. The loop yields on that late wake, so its 3–5 catch-up
    // ticks find the cmds that were sent on time. Without the yield, the ticks past the input
    // buffer repeated a cmd: 13 starved ticks here, each a correction, with no client frame over
    // 18 ms (the e2e's "starved cmds, no long frame").
    const h = new NetHarness({ input: new StrafeCircuit(), frameHz: 60, seed: 7, primer: false });
    h.run(4000);
    const t = h.client.stats.totals;
    const before = [t[STAT_STARVED], t[STAT_CORRECTIONS], t[STAT_HARD_RESYNCS]];
    const starvedBefore = h.serverStarved.length;
    const frames = h.frames.time.length;
    const stats = h.multi.loop.stats;
    for (const ms of [50, 70, 85, 100]) {
      h.multi.stallServer(ms);
      h.run(1000);
    }
    // The client's frames stayed on time (60 fps ± 1 ms), so nothing was sent late.
    const times = h.frames.time.slice(frames - 1);
    let longest = 0;
    for (let i = 1; i < times.length; i++) {
      longest = Math.max(longest, (times[i] as number) - (times[i - 1] as number));
    }
    expect(longest).toBeLessThan(20);
    expect(h.serverStarved.slice(starvedBefore)).toEqual([]);
    expect([t[STAT_STARVED], t[STAT_CORRECTIONS], t[STAT_HARD_RESYNCS]]).toEqual(before);
    // Each stall made one late wake, and it yielded.
    expect(stats.yields).toBe(4);
  });
});
